export interface MemoryScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly namespace: string;
}

export interface RememberInput {
  readonly agentId: string;
  readonly content: string;
  readonly title?: string;
  /** Reuse this key when retrying the same logical write. */
  readonly idempotencyKey?: string;
}

export interface MessagePair {
  readonly agentId: string;
  readonly userMessage: string;
  readonly assistantMessage: string;
}

export interface NeurosaMemoryOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly brainId: string;
  readonly namespace: string;
  /** Defaults to namespace; must equal the server's durable binding. */
  readonly organizationId?: string;
  /** Defaults to namespace; must equal the server's durable binding. */
  readonly projectId?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Explicit host policy; no automatic writes unless this is configured. */
  readonly writePolicy?: (
    input: Readonly<MessagePair>,
  ) => Promise<Omit<RememberInput, "agentId"> | null> | Omit<RememberInput, "agentId"> | null;
}

export interface MemoryIntegrity {
  readonly status: "CONTENT_HASH_CHECKED" | "NO_SOURCES";
  readonly ledger: "SERVER_VALIDATED";
  readonly externalAttestation: false;
}

export interface MemorySource {
  readonly documentId: string;
  readonly revision: number;
  readonly title: string;
  readonly content: string;
  /** Hash of the complete source document, checked before returning this excerpt. */
  readonly contentHash: string;
  readonly sourceReference: string | null;
}

export interface RecallResult {
  readonly text: string;
  readonly sources: readonly MemorySource[];
  readonly brainId: string;
  readonly scope: MemoryScope;
  readonly integrity: MemoryIntegrity;
  readonly operationId: string;
  readonly ledgerHead: string;
  readonly truncated: boolean;
  readonly untrusted: true;
}

export interface RememberResult {
  readonly documentId: string;
  readonly contentHash: string;
  readonly revision: number;
  readonly brainId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly deduplicated: boolean;
  readonly integrity: MemoryIntegrity;
}

export interface HealthResult {
  readonly status: "OK";
  readonly brainId: string;
  readonly scope: MemoryScope;
  readonly operationId: string;
  readonly ledger: "SERVER_VALIDATED";
}

export type MessageContext =
  | ({ readonly status: "AVAILABLE" | "EMPTY" } & RecallResult)
  | {
      readonly status: "UNAVAILABLE";
      readonly untrusted: true;
      readonly text: "";
      readonly sources: readonly [];
      readonly error: { readonly code: string; readonly status: number; readonly message: string };
    };

export interface NeurosaMemory {
  health(): Promise<HealthResult>;
  remember(input: RememberInput): Promise<RememberResult>;
  recall(input: {
    readonly agentId: string;
    readonly query: string;
    readonly maxChars?: number;
  }): Promise<RecallResult>;
  beforeMessage(input: {
    readonly agentId: string;
    readonly message: string;
    readonly required?: boolean;
    readonly maxChars?: number;
  }): Promise<MessageContext>;
  afterMessage(input: MessagePair): Promise<
    | {
        readonly status: "SKIPPED";
        readonly reason: "EXPLICIT_REMEMBER_REQUIRED" | "POLICY_DECLINED";
      }
    | { readonly status: "SAVED"; readonly memory: RememberResult }
  >;
}
