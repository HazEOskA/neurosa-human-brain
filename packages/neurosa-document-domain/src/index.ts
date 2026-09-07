import type { AgentSession, MemoryMetadata, ImportCheckpoint, OperationReceipt } from "./connect";

export type DocumentSourceType = "NATIVE" | "OBSIDIAN_IMPORT" | "FILE_IMPORT" | "API";

export interface DocumentHeading {
  readonly level: number;
  readonly text: string;
  readonly slug: string;
}

export interface DocumentLink {
  readonly target: string;
  readonly alias: string | null;
  readonly resolvedDocumentId: string | null;
}

export interface DocumentAttachment {
  readonly attachmentId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly contentHash: string;
  readonly storagePath: string;
}

export interface BrainDocument {
  readonly documentId: string;
  readonly title: string;
  readonly path: string;
  readonly folderId: string | null;
  readonly content: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly headings: readonly DocumentHeading[];
  readonly links: readonly DocumentLink[];
  readonly backlinks: readonly string[];
  readonly attachments: readonly DocumentAttachment[];
  readonly contentHash: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourceType: DocumentSourceType;
  readonly sourceReference: string | null;
  readonly archived: boolean;
  readonly deletedAt: string | null;
  readonly pinned: boolean;
  readonly favorite: boolean;
  readonly lastOpenedAt: string | null;
}

export interface DocumentRevision {
  readonly documentId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly snapshot: BrainDocument;
  readonly createdAt: string;
}

export interface BrainFolder {
  readonly folderId: string;
  readonly parentFolderId: string | null;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentSearchResult {
  readonly document: BrainDocument;
  readonly rank: number;
}

export interface DocumentListOptions {
  readonly includeArchived?: boolean;
  readonly includeDeleted?: boolean;
  readonly folderId?: string | null;
}

export interface BrainWorkspaceRepository {
  saveDocument(document: BrainDocument): void;
  loadDocument(documentId: string): BrainDocument | null;
  loadDocumentByPath(path: string): BrainDocument | null;
  listDocuments(options?: DocumentListOptions): readonly BrainDocument[];
  listDocumentRevisions(documentId: string): readonly DocumentRevision[];
  searchDocuments(query: string, limit?: number): readonly DocumentSearchResult[];
  softDeleteDocument(documentId: string, deletedAt: string): void;
  restoreDocument(documentId: string, updatedAt: string): void;
  touchDocument(documentId: string, openedAt: string): void;
  saveFolder(folder: BrainFolder): void;
  loadFolder(folderId: string): BrainFolder | null;
  listFolders(): readonly BrainFolder[];
}

export * from "./connect";

export interface KnowledgeRepository extends BrainWorkspaceRepository {
  atomic<T>(operation: () => T): T;
  getSession(id: string): AgentSession | null;
  saveSession(session: AgentSession): void;
  getDocumentMemory(documentId: string): MemoryMetadata | null;
  getMemory(key: string): MemoryMetadata | null;
  saveMemory(brainId: string, key: string, metadata: MemoryMetadata): void;
  countImportReferences(documentId: string): number;
  getImport(key: string): ImportCheckpoint | null;
  saveImport(key: string, checkpoint: ImportCheckpoint): void;
  getReceipt(key: string): OperationReceipt | null;
  saveReceipt(key: string, receipt: OperationReceipt): void;
}
