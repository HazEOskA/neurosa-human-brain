import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { TextDecoder } from "node:util";

import type {
  BrainDocument,
  BrainFolder,
  BrainWorkspaceRepository,
  DocumentAttachment,
  DocumentHeading,
  DocumentLink,
} from "@neurosa/document-domain";
import { HashChainLedger } from "@neurosa/event-ledger";
import type { NeuralProgram, NeuronIR, SynapseIR } from "@neurosa/ir";
import {
  neuronStatesFromIR,
  synapseStatesFromIR,
  type RuntimeRepository,
} from "@neurosa/runtime-domain";

export type ObsidianImportRepository = BrainWorkspaceRepository & RuntimeRepository;

export interface ObsidianImportOptions {
  readonly vaultPath: string;
  readonly workspacePath: string;
  readonly brainId?: string;
  readonly maxNoteSizeBytes?: number;
  readonly maxAttachmentSizeBytes?: number;
  readonly now?: () => string;
  readonly importIdFactory?: () => string;
  readonly eventIdFactory?: () => string;
}

export interface ObsidianImportWarning {
  readonly path: string;
  readonly code:
    | "POMINIĘTO_SYMLINK"
    | "POMINIĘTO_ZABLOKOWANY_TYP"
    | "POMINIĘTO_NIEOBSŁUGIWANY_TYP"
    | "PRZEKROCZONO_LIMIT_ROZMIARU"
    | "NIEROZWIĄZANY_WIKILINK"
    | "ZMIANA_PLIKU_W_TRAKCIE_IMPORTU";
  readonly message: string;
}

export interface ObsidianImportReport {
  readonly version: "0.1";
  readonly importId: string;
  readonly status: "ZAKOŃCZONY" | "NIEUDANY";
  readonly brainId: string;
  readonly vaultName: string;
  readonly sourceHash: string;
  readonly documentCount: number;
  readonly attachmentCount: number;
  readonly neuronCount: number;
  readonly synapseCount: number;
  readonly unresolvedLinks: readonly string[];
  readonly warnings: readonly ObsidianImportWarning[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly reportPath: string;
}

interface ScannedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly extension: string;
}

interface ParsedWikiLink {
  readonly target: string;
  readonly alias: string | null;
  readonly heading: string | null;
  readonly embedded: boolean;
}

interface ParsedMarkdown {
  readonly title: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly headings: readonly DocumentHeading[];
  readonly links: readonly ParsedWikiLink[];
}

interface ImportedNote {
  readonly source: ScannedFile;
  readonly bytes: Buffer;
  readonly content: string;
  readonly contentHash: string;
  readonly parsed: ParsedMarkdown;
  readonly documentId: string;
  readonly nativeDocumentPath: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const ignoredDirectories = new Set([".git", ".obsidian", "node_modules", ".trash"]);
const blockedExtensions = new Set([
  ".app",
  ".bat",
  ".cmd",
  ".com",
  ".cjs",
  ".dll",
  ".dmg",
  ".exe",
  ".jar",
  ".js",
  ".mjs",
  ".msi",
  ".php",
  ".pl",
  ".ps1",
  ".py",
  ".rb",
  ".scr",
  ".sh",
  ".so",
  ".ts",
  ".tsx",
]);
const attachmentMimeTypes: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".webp": "image/webp",
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(...parts: readonly string[]): string {
  return sha256(parts.join("\0"));
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ""))
      .filter(Boolean);
  }
  return trimmed.replace(/^['"]|['"]$/gu, "");
}

function parseMarkdown(content: string, fallbackTitle: string): ParsedMarkdown {
  const lines = content.split(/\r?\n/u);
  const frontmatter: Record<string, unknown> = {};
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.slice(1).findIndex((line) => line.trim() === "---");
    if (end >= 0) {
      for (const line of lines.slice(1, end + 1)) {
        const separator = line.indexOf(":");
        if (separator > 0) {
          frontmatter[line.slice(0, separator).trim()] = parseScalar(line.slice(separator + 1));
        }
      }
      bodyStart = end + 2;
    }
  }

  const bodyLines = lines.slice(bodyStart);
  const headings: DocumentHeading[] = [];
  for (const line of bodyLines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (match !== null) {
      const text = match[2]!;
      headings.push({ level: match[1]!.length, text, slug: slugify(text) });
    }
  }

  const body = bodyLines.join("\n").replace(/```[\s\S]*?```/gu, "");
  const links: ParsedWikiLink[] = [];
  for (const match of body.matchAll(/(!)?\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/gu)) {
    links.push({
      embedded: match[1] === "!",
      target: match[2]!.trim(),
      heading: match[3]?.trim() ?? null,
      alias: match[4]?.trim() ?? null,
    });
  }

  const tags = new Set<string>();
  const declaredTags = frontmatter.tags;
  if (typeof declaredTags === "string") tags.add(declaredTags.replace(/^#/u, ""));
  if (Array.isArray(declaredTags)) {
    for (const tag of declaredTags) if (typeof tag === "string") tags.add(tag.replace(/^#/u, ""));
  }
  for (const match of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(match[1]!);

  const declaredTitle = frontmatter.title;
  const title =
    (typeof declaredTitle === "string" && declaredTitle.trim().length > 0
      ? declaredTitle.trim()
      : headings[0]?.text) ?? fallbackTitle;
  return { title, frontmatter, tags: [...tags].sort(), headings, links };
}

export function assertSafeImportRelativePath(value: string): string {
  if (value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new Error("Ścieżka importu musi być względna i używać separatora '/'");
  }
  const normalized = normalize(value).split(sep).join("/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Ścieżka importu wychodzi poza katalog źródłowy");
  }
  return normalized.replace(/^\.\//u, "");
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function scanVault(root: string, warnings: ObsidianImportWarning[]): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name) && entry.isDirectory()) continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = assertSafeImportRelativePath(toPosix(relative(root, absolutePath)));
      if (entry.isSymbolicLink()) {
        warnings.push({
          path: relativePath,
          code: "POMINIĘTO_SYMLINK",
          message: "Pominięto dowiązanie symboliczne; importer nie wychodzi poza Vault.",
        });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(absolutePath);
      files.push({
        absolutePath,
        relativePath,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        extension: extname(entry.name).toLowerCase(),
      });
    }
  }
  await visit(root);
  return files;
}

async function readStableFile(file: ScannedFile): Promise<{ bytes: Buffer; hash: string }> {
  const before = await stat(file.absolutePath);
  if (before.size !== file.sizeBytes || before.mtimeMs !== file.mtimeMs) {
    throw new Error(`Plik '${file.relativePath}' zmienił się przed odczytem`);
  }
  const bytes = await readFile(file.absolutePath);
  const after = await stat(file.absolutePath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`Plik '${file.relativePath}' zmienił się w trakcie importu`);
  }
  return { bytes, hash: sha256(bytes) };
}

async function atomicWrite(target: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    if (sha256(await readFile(temporary)) !== sha256(bytes)) {
      throw new Error(`Weryfikacja kopii '${target}' nie powiodła się`);
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function nativeDocumentPath(vaultKey: string, sourcePath: string): string {
  return `imports/${vaultKey}/${assertSafeImportRelativePath(sourcePath)}`;
}

function noteKey(value: string): string {
  return value.replace(/\.md$/iu, "").toLowerCase();
}

function resolveNoteTarget(
  sourcePath: string,
  target: string,
  aliases: ReadonlyMap<string, readonly ImportedNote[]>,
): ImportedNote | null {
  let safeTarget: string;
  try {
    safeTarget = assertSafeImportRelativePath(target.trim());
  } catch {
    return null;
  }
  const sourceDirectory = dirname(sourcePath).split(sep).join("/");
  const candidates = [
    noteKey(sourceDirectory === "." ? safeTarget : `${sourceDirectory}/${safeTarget}`),
    noteKey(safeTarget),
    noteKey(basename(safeTarget)),
  ];
  for (const candidate of candidates) {
    const matches = aliases.get(candidate);
    if (matches?.length === 1) return matches[0]!;
  }
  return null;
}

function folderId(vaultKey: string, path: string): string {
  return `folder-${stableId(vaultKey, path).slice(0, 24)}`;
}

function ensureFolders(
  repository: BrainWorkspaceRepository,
  vaultKey: string,
  documentPath: string,
  timestamp: string,
): string | null {
  const directory = dirname(documentPath).split(sep).join("/");
  if (directory === ".") return null;
  const segments = directory.split("/").filter(Boolean);
  let current = "";
  let parentFolderId: string | null = null;
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`;
    const id = folderId(vaultKey, current);
    const folder: BrainFolder = {
      folderId: id,
      parentFolderId,
      name: segment,
      path: `imports/${vaultKey}/${current}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    repository.saveFolder(folder);
    parentFolderId = id;
  }
  return parentFolderId;
}

function buildAliases(notes: readonly ImportedNote[]): Map<string, readonly ImportedNote[]> {
  const mutable = new Map<string, ImportedNote[]>();
  const add = (key: string, note: ImportedNote): void => {
    const normalized = noteKey(key);
    const values = mutable.get(normalized) ?? [];
    if (!values.some((value) => value.documentId === note.documentId)) values.push(note);
    mutable.set(normalized, values);
  };
  for (const note of notes) {
    add(note.source.relativePath, note);
    add(basename(note.source.relativePath, ".md"), note);
    add(note.parsed.title, note);
  }
  return new Map([...mutable.entries()].map(([key, values]) => [key, values] as const));
}

function buildProgram(
  brainId: string,
  sourceHash: string,
  notes: readonly ImportedNote[],
  documentLinks: ReadonlyMap<string, readonly DocumentLink[]>,
): NeuralProgram {
  const regionId = "ObsidianImport";
  const neuronByDocument = new Map<string, NeuronIR>();
  for (const note of notes) {
    neuronByDocument.set(note.documentId, {
      id: `note-${stableId(note.documentId).slice(0, 24)}`,
      regionId,
      type: "NOTE",
      title: note.parsed.title,
      sourcePath: note.nativeDocumentPath,
      excerpt: note.content.slice(0, 500),
      threshold: 0.55,
      restingPotential: 0,
      salience: 0.6,
      confidence: 1,
      enabled: true,
    });
  }
  const neurons = [...neuronByDocument.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const synapses: SynapseIR[] = [];
  const seen = new Set<string>();
  for (const note of notes) {
    const sourceNeuron = neuronByDocument.get(note.documentId)!;
    for (const link of documentLinks.get(note.documentId) ?? []) {
      if (link.resolvedDocumentId === null) continue;
      const targetNeuron = neuronByDocument.get(link.resolvedDocumentId);
      if (targetNeuron === undefined) continue;
      const key = `${sourceNeuron.id}\0${targetNeuron.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      synapses.push({
        id: `wikilink-${stableId(sourceNeuron.id, targetNeuron.id).slice(0, 24)}`,
        regionId,
        sourceNeuronId: sourceNeuron.id,
        targetNeuronId: targetNeuron.id,
        relationType: "REFERENCES",
        mode: "EXCITATORY",
        neurotransmitter: "GLUTAMATE",
        receptor: "CONTEXTUAL",
        weight: 0.65,
        confidence: 1,
        transmissionDelayMs: 0,
        decayRate: 0,
        plasticity: "NONE",
      });
    }
  }
  synapses.sort((left, right) => left.id.localeCompare(right.id));
  return {
    version: "0.1",
    brainId,
    regions: [{ id: regionId, neuronIds: neurons.map((neuron) => neuron.id) }],
    neurons,
    synapses,
    proteins: [],
    pathways: [],
    policies: [],
    sourceHash,
  };
}

function attachmentTargetCandidates(sourcePath: string, target: string): string[] {
  let safeTarget: string;
  try {
    safeTarget = assertSafeImportRelativePath(target);
  } catch {
    return [];
  }
  const directory = dirname(sourcePath).split(sep).join("/");
  return [
    directory === "." ? safeTarget : `${directory}/${safeTarget}`,
    safeTarget,
    basename(safeTarget),
  ];
}

export class ObsidianOneTimeImporter {
  constructor(private readonly repository: ObsidianImportRepository) {}

  async import(options: ObsidianImportOptions): Promise<ObsidianImportReport> {
    const now = options.now ?? (() => new Date().toISOString());
    const importIdFactory = options.importIdFactory ?? (() => `import-${randomUUID()}`);
    const eventIdFactory = options.eventIdFactory ?? randomUUID;
    const startedAt = now();
    const importId = importIdFactory();
    const brainId = options.brainId ?? "ObsidianImportBrain";
    const maxNoteSize = options.maxNoteSizeBytes ?? 2 * 1024 * 1024;
    const maxAttachmentSize = options.maxAttachmentSizeBytes ?? 25 * 1024 * 1024;
    const warnings: ObsidianImportWarning[] = [];
    const unresolvedLinks: string[] = [];

    this.repository.initialize();
    const ledger = new HashChainLedger(this.repository, { now }, { next: eventIdFactory });

    let vaultRoot = "";
    let workspaceRoot = "";
    let vaultName = "";
    let reportPath = "";
    try {
      vaultRoot = await realpath(resolve(options.vaultPath));
      const vaultInfo = await stat(vaultRoot);
      if (!vaultInfo.isDirectory()) throw new Error("Ścieżka Vaultu nie wskazuje katalogu");
      workspaceRoot = resolve(options.workspacePath);
      await mkdir(workspaceRoot, { recursive: true });
      workspaceRoot = await realpath(workspaceRoot);
      if (isInside(vaultRoot, workspaceRoot) || isInside(workspaceRoot, vaultRoot)) {
        throw new Error("Vault źródłowy i natywny workspace nie mogą się nakładać");
      }
      vaultName = basename(vaultRoot);
      const vaultKey = `${slugify(vaultName) || "vault"}-${stableId(vaultRoot).slice(0, 8)}`;
      reportPath = join(workspaceRoot, "system", "imports", `${importId}.json`);
      ledger.append("IMPORT_STARTED", null, { importId, brainId, vaultName });

      const scanned = await scanVault(vaultRoot, warnings);
      const noteFiles = scanned.filter((file) => file.extension === ".md");
      const attachmentFiles = scanned.filter((file) => file.extension !== ".md");
      const notes: ImportedNote[] = [];

      for (const file of noteFiles) {
        if (file.sizeBytes > maxNoteSize) {
          warnings.push({
            path: file.relativePath,
            code: "PRZEKROCZONO_LIMIT_ROZMIARU",
            message: `Pominięto notatkę większą niż ${String(maxNoteSize)} bajtów.`,
          });
          continue;
        }
        try {
          const { bytes, hash } = await readStableFile(file);
          const content = decoder.decode(bytes);
          const parsed = parseMarkdown(content, basename(file.relativePath, ".md"));
          const documentId = `doc-${stableId(vaultKey, file.relativePath).slice(0, 24)}`;
          notes.push({
            source: file,
            bytes,
            content,
            contentHash: hash,
            parsed,
            documentId,
            nativeDocumentPath: nativeDocumentPath(vaultKey, file.relativePath),
          });
        } catch (error) {
          warnings.push({
            path: file.relativePath,
            code: "ZMIANA_PLIKU_W_TRAKCIE_IMPORTU",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      notes.sort((left, right) =>
        left.source.relativePath.localeCompare(right.source.relativePath),
      );
      const aliases = buildAliases(notes);

      const copiedAttachments = new Map<string, DocumentAttachment>();
      for (const file of attachmentFiles) {
        if (blockedExtensions.has(file.extension)) {
          warnings.push({
            path: file.relativePath,
            code: "POMINIĘTO_ZABLOKOWANY_TYP",
            message: "Pominięto wykonywalny albo skryptowy typ załącznika.",
          });
          continue;
        }
        const mimeType = attachmentMimeTypes[file.extension];
        if (mimeType === undefined) {
          warnings.push({
            path: file.relativePath,
            code: "POMINIĘTO_NIEOBSŁUGIWANY_TYP",
            message: "Pominięto nieobsługiwany typ załącznika.",
          });
          continue;
        }
        if (file.sizeBytes > maxAttachmentSize) {
          warnings.push({
            path: file.relativePath,
            code: "PRZEKROCZONO_LIMIT_ROZMIARU",
            message: `Pominięto załącznik większy niż ${String(maxAttachmentSize)} bajtów.`,
          });
          continue;
        }
        const { bytes, hash } = await readStableFile(file);
        const storagePath = `attachments/${vaultKey}/${file.relativePath}`;
        await atomicWrite(join(workspaceRoot, ...storagePath.split("/")), bytes);
        const attachment: DocumentAttachment = {
          attachmentId: `attachment-${stableId(vaultKey, file.relativePath).slice(0, 24)}`,
          fileName: basename(file.relativePath),
          mimeType,
          sizeBytes: bytes.length,
          contentHash: hash,
          storagePath,
        };
        copiedAttachments.set(file.relativePath.toLowerCase(), attachment);
        ledger.append("IMPORT_ATTACHMENT_COPIED", null, {
          importId,
          storagePath,
          contentHash: hash,
        });
      }

      const documentLinks = new Map<string, readonly DocumentLink[]>();
      for (const note of notes) {
        const timestamp = now();
        const links: DocumentLink[] = [];
        const attachments: DocumentAttachment[] = [];
        for (const link of note.parsed.links) {
          if (link.embedded) {
            let attachment: DocumentAttachment | undefined;
            for (const candidate of attachmentTargetCandidates(
              note.source.relativePath,
              link.target,
            )) {
              attachment = copiedAttachments.get(candidate.toLowerCase());
              if (attachment !== undefined) break;
            }
            if (
              attachment !== undefined &&
              !attachments.some((item) => item.attachmentId === attachment.attachmentId)
            ) {
              attachments.push(attachment);
            }
            continue;
          }
          const target = resolveNoteTarget(note.source.relativePath, link.target, aliases);
          if (target === null) {
            const unresolved = `${note.source.relativePath} -> ${link.target}`;
            unresolvedLinks.push(unresolved);
            warnings.push({
              path: note.source.relativePath,
              code: "NIEROZWIĄZANY_WIKILINK",
              message: `Nie rozwiązano wikilinku '${link.target}'.`,
            });
            links.push({ target: link.target, alias: link.alias, resolvedDocumentId: null });
          } else {
            links.push({
              target: target.nativeDocumentPath,
              alias: link.alias,
              resolvedDocumentId: target.documentId,
            });
          }
        }
        const existing = this.repository.loadDocument(note.documentId);
        const folder = ensureFolders(
          this.repository,
          vaultKey,
          note.source.relativePath,
          timestamp,
        );
        const document: BrainDocument = {
          documentId: note.documentId,
          title: note.parsed.title,
          path: note.nativeDocumentPath,
          folderId: folder,
          content: note.content,
          frontmatter: note.parsed.frontmatter,
          tags: note.parsed.tags,
          headings: note.parsed.headings,
          links,
          backlinks: [],
          attachments: attachments.sort((left, right) =>
            left.fileName.localeCompare(right.fileName),
          ),
          contentHash: note.contentHash,
          revision:
            existing === null || existing.contentHash === note.contentHash
              ? (existing?.revision ?? 1)
              : existing.revision + 1,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          sourceType: "OBSIDIAN_IMPORT",
          sourceReference: `obsidian://${vaultKey}/${note.source.relativePath}`,
          archived: false,
          deletedAt: null,
          pinned: existing?.pinned ?? false,
          favorite: existing?.favorite ?? false,
          lastOpenedAt: existing?.lastOpenedAt ?? null,
        };
        await atomicWrite(
          join(workspaceRoot, "documents", vaultKey, ...note.source.relativePath.split("/")),
          note.bytes,
        );
        this.repository.saveDocument(document);
        documentLinks.set(document.documentId, links);
        ledger.append("IMPORT_DOCUMENT_COPIED", null, {
          importId,
          documentId: document.documentId,
          path: document.path,
          contentHash: document.contentHash,
        });
      }

      const sourceHash = sha256(
        notes.map((note) => `${note.source.relativePath}\0${note.contentHash}`).join("\n"),
      );
      const program = buildProgram(brainId, sourceHash, notes, documentLinks);
      this.repository.saveBrain({
        brainId,
        sourceHash,
        ir: program,
        neurons: neuronStatesFromIR(program),
        synapses: synapseStatesFromIR(program),
      });
      for (const neuron of program.neurons) {
        ledger.append("IMPORT_NEURON_CREATED", null, { importId, brainId, neuronId: neuron.id });
      }
      for (const synapse of program.synapses) {
        ledger.append("IMPORT_SYNAPSE_CREATED", null, {
          importId,
          brainId,
          synapseId: synapse.id,
          sourceNeuronId: synapse.sourceNeuronId,
          targetNeuronId: synapse.targetNeuronId,
        });
      }

      const completedAt = now();
      const report: ObsidianImportReport = {
        version: "0.1",
        importId,
        status: "ZAKOŃCZONY",
        brainId,
        vaultName,
        sourceHash,
        documentCount: notes.length,
        attachmentCount: copiedAttachments.size,
        neuronCount: program.neurons.length,
        synapseCount: program.synapses.length,
        unresolvedLinks: [...new Set(unresolvedLinks)].sort(),
        warnings,
        startedAt,
        completedAt,
        reportPath: toPosix(relative(workspaceRoot, reportPath)),
      };
      await atomicWrite(reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"));
      ledger.append("IMPORT_COMPLETED", null, {
        importId,
        brainId,
        sourceHash,
        documentCount: report.documentCount,
        attachmentCount: report.attachmentCount,
        neuronCount: report.neuronCount,
        synapseCount: report.synapseCount,
      });
      return report;
    } catch (error) {
      try {
        ledger.append("IMPORT_FAILED", null, {
          importId,
          brainId,
          message: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Pierwotny błąd importu ma pierwszeństwo przed wtórnym błędem raportowania.
      }
      throw error;
    }
  }
}
