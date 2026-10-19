import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { NeurosaConnect } from "@neurosa/connect";
import type { KnowledgeSource } from "@neurosa/document-domain";
import { z } from "zod";
import { parseConversationExport } from "./conversation-export";
export { parseConversationExport } from "./conversation-export";
export type { ImportedConversation } from "./conversation-export";

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const hash = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
export class NeurosaIngest {
  constructor(
    private readonly client: NeurosaConnect,
    private readonly projectId = "shared",
  ) {}
  async document(title: string, content: string, source: KnowledgeSource): Promise<unknown> {
    if (!content.trim() || content.length > 900000)
      throw new Error("Dokument jest pusty lub przekracza 900000 znaków");
    return this.client.observe({
      title,
      content,
      source,
      projectId: this.projectId,
      kind: "observation",
    });
  }
  async conversations(value: unknown, provider: string): Promise<readonly unknown[]> {
    const parsed = parseConversationExport(value, provider);
    const results: unknown[] = [];
    for (const conversation of parsed)
      results.push(
        await this.document(conversation.title, conversation.content, {
          type: "CHAT_EXPORT",
          id: `${provider}:${conversation.id}`,
          version: hash(conversation.content),
        }),
      );
    return results;
  }
  async file(path: string, root: string, provider?: string): Promise<unknown> {
    const allowed = await realpath(root);
    const target = await realpath(resolve(root, path));
    const rel = relative(allowed, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(allowed, rel) !== target)
      throw new Error("Plik poza dozwolonym katalogiem");
    const before = await stat(target);
    if (!before.isFile() || before.size > MAX_SOURCE_BYTES)
      throw new Error("Nieprawidłowy plik lub przekroczony limit 10 MiB");
    const data = await readFile(target);
    const after = await stat(target);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      data.length > MAX_SOURCE_BYTES
    )
      throw new Error("Plik zmienił się w czasie odczytu");
    if (provider !== undefined)
      return this.conversations(JSON.parse(data.toString("utf8")) as unknown, provider);
    return this.document(basename(target), await extractDocument(data, basename(target)), {
      type: "FILE",
      id: `file://${target}`,
      version: hash(data),
      modifiedAt: after.mtime.toISOString(),
    });
  }
}

export async function extractDocument(
  data: Uint8Array,
  name: string,
  mimeType = "",
): Promise<string> {
  if (data.byteLength > MAX_SOURCE_BYTES) throw new Error("Przekroczony limit 10 MiB");
  if (/\.pdf$/iu.test(name) || mimeType === "application/pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (
    /\.docx$/iu.test(name) ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: Buffer.from(data) })).value;
  }
  if (
    !/\.(md|txt|json|csv|html?)$/iu.test(name) &&
    !mimeType.startsWith("text/") &&
    mimeType !== "application/json"
  )
    throw new Error("Nieobsługiwany format dokumentu");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (text.includes("\0")) throw new Error("Dokument tekstowy zawiera dane binarne");
  // HTML stays inert text in the native Markdown store; it is never rendered/executed by ingest.
  return text;
}

const driveFileSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  mimeType: z.string(),
  version: z.string().min(1),
  modifiedTime: z.string(),
  size: z.string().optional(),
});
type DriveFile = z.infer<typeof driveFileSchema>;
export interface DriveSyncResult {
  complete: boolean;
  imported: string[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; reason: string }[];
}
export interface DriveManifestEntry {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly folderId: string;
  readonly sizeBytes: number | null;
  readonly version: string;
  readonly modifiedTime: string;
  readonly eligible: boolean;
  readonly reason: string | null;
}

export interface DriveManifest {
  readonly folderId: string;
  readonly complete: boolean;
  readonly entries: readonly DriveManifestEntry[];
}

const DRIVE_IMPORT_MIME = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
]);
const driveEligibility = (file: DriveFile): { eligible: boolean; reason: string | null } => {
  if (!DRIVE_IMPORT_MIME.has(file.mimeType))
    return { eligible: false, reason: "Nieobsługiwany format. Brak automatycznego importu." };
  if (file.size !== undefined && Number(file.size) > MAX_SOURCE_BYTES)
    return { eligible: false, reason: "Plik przekracza limit 10 MiB." };
  return { eligible: true, reason: null };
};
export class GoogleDriveSource {
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch,
  ) {}
  private async get(path: string): Promise<Response> {
    const token = await this.accessToken();
    if (!token) throw new Error("Brak tokenu Google Drive");
    const response = await this.fetcher(`https://www.googleapis.com/drive/v3/${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Google Drive HTTP ${response.status}`);
    return response;
  }
  private async content(file: DriveFile): Promise<Uint8Array> {
    if (Number(file.size ?? 0) > MAX_SOURCE_BYTES) throw new Error("Plik przekracza 10 MiB");
    const native = file.mimeType.startsWith("application/vnd.google-apps.");
    const exportMime =
      file.mimeType === "application/vnd.google-apps.spreadsheet" ? "text/csv" : "text/plain";
    const path = native
      ? `files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportMime)}`
      : `files/${encodeURIComponent(file.id)}?alt=media`;
    const response = await this.get(path);
    if (response.body === null) throw new Error("Brak treści pliku");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.length;
        if (total > MAX_SOURCE_BYTES) throw new Error("Plik przekracza 10 MiB");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  /** Metadata-only traversal. Does not fetch media, invoke Brain or mutate Drive. */
  async inspect(folderId: string, maxFiles = 1000): Promise<DriveManifest> {
    if (
      !/^[\\w-]+$/u.test(folderId) ||
      !Number.isInteger(maxFiles) ||
      maxFiles < 1 ||
      maxFiles > 10000
    )
      throw new Error("Nieprawidłowy folder lub limit Drive");
    const entries: DriveManifestEntry[] = [];
    const folders = [folderId];
    const visited = new Set<string>();
    while (folders.length > 0) {
      const current = folders.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      let page: string | undefined;
      const cursors = new Set<string>();
      do {
        const params = new URLSearchParams({
          q: `'${current}' in parents and trashed = false`,
          pageSize: "100",
          fields:
            "nextPageToken,incompleteSearch,files(id,name,mimeType,version,modifiedTime,size)",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        });
        if (page !== undefined) params.set("pageToken", page);
        const list = z
          .object({
            files: z.array(driveFileSchema),
            nextPageToken: z.string().optional(),
            incompleteSearch: z.boolean().optional(),
          })
          .parse(await (await this.get(`files?${params}`)).json());
        if (list.incompleteSearch) throw new Error("Niepełna lista Google Drive");
        for (const file of list.files) {
          if (file.mimeType === "application/vnd.google-apps.folder") {
            folders.push(file.id);
            continue;
          }
          const policy = driveEligibility(file);
          entries.push({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            folderId: current,
            sizeBytes: file.size === undefined ? null : Number(file.size),
            version: file.version,
            modifiedTime: file.modifiedTime,
            eligible: policy.eligible,
            reason: policy.reason,
          });
          if (entries.length >= maxFiles) return { folderId, complete: false, entries };
        }
        page = list.nextPageToken;
        if (page !== undefined) {
          if (cursors.has(page)) throw new Error("Powtarzający się kursor Drive");
          cursors.add(page);
        }
      } while (page !== undefined);
    }
    return { folderId, complete: true, entries };
  }

  /** Safe opt-in: an empty selection must NEVER mean sync all. */
  async syncSelected(
    folderId: string,
    ingest: NeurosaIngest,
    approvedFileIds: readonly string[],
    maxFiles = 1000,
  ): Promise<DriveSyncResult> {
    if (!approvedFileIds.length || approvedFileIds.length > maxFiles)
      throw new Error("Wybierz konkretny podzbiór plików do importu");
    if (approvedFileIds.some((id) => !/^[\\w-]+$/u.test(id)))
      throw new Error("Nieprawidłowy identyfikator pliku Drive");
    const approved = new Set(approvedFileIds);
    const result = await this.sync(folderId, ingest, maxFiles, approved);
    const accounted = new Set([...result.imported, ...result.failed.map((x) => x.id)]);
    for (const id of approved) {
      if (!accounted.has(id)) {
        result.failed.push({ id, reason: "Nie znaleziono pliku w dozwolonym folderze" });
        result.complete = false;
      }
    }
    return result;
  }

  async sync(
    folderId: string,
    ingest: NeurosaIngest,
    maxFiles = 1000,
    approvedFileIds?: ReadonlySet<string>,
  ): Promise<DriveSyncResult> {
    if (
      !/^[\w-]+$/u.test(folderId) ||
      !Number.isInteger(maxFiles) ||
      maxFiles < 1 ||
      maxFiles > 10000
    )
      throw new Error("Nieprawidłowy folder lub limit Drive");
    const result: DriveSyncResult = { complete: true, imported: [], skipped: [], failed: [] };
    const folders = [folderId];
    const seenFolders = new Set<string>();
    let count = 0;
    while (folders.length) {
      const folder = folders.shift()!;
      if (seenFolders.has(folder)) continue;
      seenFolders.add(folder);
      let page: string | undefined;
      const seenPages = new Set<string>();
      do {
        const params = new URLSearchParams({
          q: `'${folder.replaceAll("'", "\\'")}' in parents and trashed = false`,
          pageSize: "100",
          fields:
            "nextPageToken,incompleteSearch,files(id,name,mimeType,version,modifiedTime,size)",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        });
        if (page !== undefined) params.set("pageToken", page);
        const raw: unknown = await (await this.get(`files?${params}`)).json();
        const list = z
          .object({
            files: z.array(driveFileSchema),
            nextPageToken: z.string().optional(),
            incompleteSearch: z.boolean().optional(),
          })
          .parse(raw);
        if (list.incompleteSearch) throw new Error("Google Drive zwrócił niepełne wyszukiwanie");
        for (const file of list.files) {
          count++;
          if (count > maxFiles) {
            result.complete = false;
            result.failed.push({ id: file.id, reason: "Osiągnięto limit plików" });
            return result;
          }
          if (file.mimeType === "application/vnd.google-apps.folder") {
            folders.push(file.id);
            continue;
          }
          if (file.mimeType === "application/vnd.google-apps.shortcut") {
            result.skipped.push({
              id: file.id,
              reason: "Skrót pominięty; nie wychodzimy poza folder źródłowy",
            });
            continue;
          }
          if (approvedFileIds !== undefined && !approvedFileIds.has(file.id)) {
            result.skipped.push({ id: file.id, reason: "Plik poza zatwierdzoną listą" });
            continue;
          }
          if (approvedFileIds !== undefined) {
            const policy = driveEligibility(file);
            if (!policy.eligible) {
              result.complete = false;
              result.failed.push({ id: file.id, reason: policy.reason ?? "Plik niedozwolony" });
              continue;
            }
          }
          try {
            const data = await this.content(file);
            const after = driveFileSchema.parse(
              await (
                await this.get(
                  `files/${encodeURIComponent(file.id)}?fields=id,name,mimeType,version,modifiedTime,size&supportsAllDrives=true`,
                )
              ).json(),
            );
            if (after.version !== file.version)
              throw new Error("Plik zmienił się w czasie pobierania; ponów synchronizację");
            const native = file.mimeType.startsWith("application/vnd.google-apps.");
            const content = await extractDocument(
              data,
              native ? `${file.name}.txt` : file.name,
              native ? "text/plain" : file.mimeType,
            );
            await ingest.document(file.name, content, {
              type: "GOOGLE_DRIVE",
              id: `gdrive://${file.id}`,
              version: file.version,
              modifiedAt: file.modifiedTime,
            });
            result.imported.push(file.id);
          } catch (error) {
            result.complete = false;
            result.failed.push({
              id: file.id,
              reason: error instanceof Error ? error.message : "Błąd importu",
            });
          }
        }
        page = list.nextPageToken;
        if (page !== undefined) {
          if (seenPages.has(page)) throw new Error("Powtarzający się kursor Drive");
          seenPages.add(page);
        }
      } while (page !== undefined);
    }
    return result;
  }
}
