import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";

import type {
  BrainDocument,
  BrainFolder,
  BrainWorkspaceRepository,
  DocumentHeading,
  DocumentLink,
  DocumentSearchResult,
  DocumentSourceType,
} from "@neurosa/document-domain";

export interface CreateDocumentInput {
  readonly title: string;
  readonly path: string;
  readonly content: string;
  readonly folderId?: string | null;
  readonly sourceType?: DocumentSourceType;
  readonly sourceReference?: string | null;
  readonly pinned?: boolean;
  readonly favorite?: boolean;
}

export interface UpdateDocumentInput {
  readonly title?: string;
  readonly path?: string;
  readonly content?: string;
  readonly folderId?: string | null;
  readonly archived?: boolean;
  readonly pinned?: boolean;
  readonly favorite?: boolean;
}

export interface CreateFolderInput {
  readonly name: string;
  readonly path: string;
  readonly parentFolderId?: string | null;
}

export interface WorkspaceOptions {
  readonly now?: () => string;
  readonly idFactory?: () => string;
}

interface MarkdownAnalysis {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly headings: readonly DocumentHeading[];
  readonly links: readonly DocumentLink[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function scalar(value: string): unknown {
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

export function analyzeMarkdown(content: string): MarkdownAnalysis {
  const frontmatter: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/u);
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.slice(1).findIndex((line) => line.trim() === "---");
    if (end >= 0) {
      for (const line of lines.slice(1, end + 1)) {
        const separator = line.indexOf(":");
        if (separator <= 0) continue;
        frontmatter[line.slice(0, separator).trim()] = scalar(line.slice(separator + 1));
      }
      bodyStart = end + 2;
    }
  }

  const body = lines.slice(bodyStart).join("\n");
  const headings: DocumentHeading[] = [];
  for (const line of lines.slice(bodyStart)) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    const text = match[2]!;
    headings.push({ level: match[1]!.length, text, slug: slugify(text) });
  }

  const links: DocumentLink[] = [];
  for (const match of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/gu)) {
    links.push({
      target: match[1]!.trim(),
      alias: match[2]?.trim() ?? null,
      resolvedDocumentId: null,
    });
  }

  const tags = new Set<string>();
  const declaredTags = frontmatter.tags;
  if (typeof declaredTags === "string") tags.add(declaredTags.replace(/^#/u, ""));
  if (Array.isArray(declaredTags)) {
    for (const tag of declaredTags) if (typeof tag === "string") tags.add(tag.replace(/^#/u, ""));
  }
  for (const match of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(match[1]!);

  return { frontmatter, tags: [...tags].sort(), headings, links };
}

export function normalizeDocumentPath(value: string): string {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    throw new Error("Ścieżka dokumentu musi być względna i używać separatora '/'");
  }
  const normalized = posix.normalize(value.trim());
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Ścieżka dokumentu wychodzi poza natywny workspace");
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("Natywny dokument musi mieć rozszerzenie .md");
  }
  return normalized;
}

export class NativeBrainWorkspace {
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly repository: BrainWorkspaceRepository,
    options: WorkspaceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  createDocument(input: CreateDocumentInput): BrainDocument {
    const path = normalizeDocumentPath(input.path);
    if (this.repository.loadDocumentByPath(path) !== null) {
      throw new Error(`Dokument o ścieżce '${path}' już istnieje`);
    }
    const timestamp = this.now();
    const analysis = analyzeMarkdown(input.content);
    const document: BrainDocument = {
      documentId: this.idFactory(),
      title: input.title.trim(),
      path,
      folderId: input.folderId ?? null,
      content: input.content,
      frontmatter: analysis.frontmatter,
      tags: analysis.tags,
      headings: analysis.headings,
      links: analysis.links,
      backlinks: [],
      attachments: [],
      contentHash: sha256(input.content),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceType: input.sourceType ?? "NATIVE",
      sourceReference: input.sourceReference ?? null,
      archived: false,
      deletedAt: null,
      pinned: input.pinned ?? false,
      favorite: input.favorite ?? false,
      lastOpenedAt: null,
    };
    if (document.title.length === 0) throw new Error("Tytuł dokumentu nie może być pusty");
    this.repository.saveDocument(document);
    return this.requireDocument(document.documentId);
  }

  updateDocument(documentId: string, input: UpdateDocumentInput): BrainDocument {
    const current = this.requireDocument(documentId);
    const content = input.content ?? current.content;
    const path = input.path === undefined ? current.path : normalizeDocumentPath(input.path);
    const collision = this.repository.loadDocumentByPath(path);
    if (collision !== null && collision.documentId !== documentId) {
      throw new Error(`Dokument o ścieżce '${path}' już istnieje`);
    }
    const analysis = analyzeMarkdown(content);
    const updated: BrainDocument = {
      ...current,
      title: input.title?.trim() ?? current.title,
      path,
      folderId: input.folderId === undefined ? current.folderId : input.folderId,
      content,
      frontmatter: analysis.frontmatter,
      tags: analysis.tags,
      headings: analysis.headings,
      links: analysis.links,
      contentHash: sha256(content),
      revision: current.revision + 1,
      updatedAt: this.now(),
      archived: input.archived ?? current.archived,
      pinned: input.pinned ?? current.pinned,
      favorite: input.favorite ?? current.favorite,
    };
    if (updated.title.length === 0) throw new Error("Tytuł dokumentu nie może być pusty");
    this.repository.saveDocument(updated);
    return this.requireDocument(documentId);
  }

  getDocument(documentId: string): BrainDocument {
    return this.requireDocument(documentId);
  }

  openDocument(documentId: string): BrainDocument {
    this.repository.touchDocument(documentId, this.now());
    return this.requireDocument(documentId);
  }

  deleteDocument(documentId: string): void {
    this.requireDocument(documentId);
    this.repository.softDeleteDocument(documentId, this.now());
  }

  restoreDocument(documentId: string): BrainDocument {
    this.repository.restoreDocument(documentId, this.now());
    return this.requireDocument(documentId);
  }

  search(query: string, limit = 20): readonly DocumentSearchResult[] {
    if (query.trim().length === 0) return [];
    return this.repository.searchDocuments(query, limit);
  }

  createFolder(input: CreateFolderInput): BrainFolder {
    const timestamp = this.now();
    const normalized = posix.normalize(input.path.trim());
    if (
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.startsWith("/")
    ) {
      throw new Error("Ścieżka folderu wychodzi poza natywny workspace");
    }
    const folder: BrainFolder = {
      folderId: this.idFactory(),
      parentFolderId: input.parentFolderId ?? null,
      name: input.name.trim(),
      path: normalized,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (folder.name.length === 0) throw new Error("Nazwa folderu nie może być pusta");
    this.repository.saveFolder(folder);
    return folder;
  }

  private requireDocument(documentId: string): BrainDocument {
    const document = this.repository.loadDocument(documentId);
    if (document === null) throw new Error(`Nie znaleziono dokumentu '${documentId}'`);
    return document;
  }
}
