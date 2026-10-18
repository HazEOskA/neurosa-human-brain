export interface KnowledgeSource {
  readonly type: "GOOGLE_DRIVE" | "FILE" | "CHAT_EXPORT" | "SESSION";
  readonly id: string;
  readonly version: string;
  readonly modifiedAt?: string;
}

export interface MemoryWrite {
  /** Provenance supplied by a trusted agent host; never an authorization identity. */
  readonly originAgentId?: string;
  readonly pinned?: boolean;
  readonly favorite?: boolean;
  readonly title: string;
  readonly content: string;
  readonly path?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly kind?: "fact" | "decision" | "project" | "event" | "observation";
  readonly factKey?: string;
  readonly source?: KnowledgeSource;
  readonly idempotencyKey?: string;
  readonly expectedRevision?: number;
}

export interface AgentSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly status: "OPEN" | "COMPLETED";
  readonly createdAt: string;
  readonly completedAt?: string;
}

export class KnowledgeConflict extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
  }
}

export interface MemoryMetadata {
  readonly originAgentId?: string;
  readonly documentId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly factKey?: string;
  readonly agentId: string;
  readonly sessionId?: string;
  readonly source?: KnowledgeSource;
  readonly revision: number;
}

/** v0.1 binds one complete canonical brain/database to exactly one tenant scope. */
export interface MemoryScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly namespace: string;
}
export interface ImportCheckpoint {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly contentHash: string;
  readonly source: KnowledgeSource;
}
export interface OperationReceipt {
  readonly inputHash: string;
  readonly documentId: string;
  readonly revision: number;
}
