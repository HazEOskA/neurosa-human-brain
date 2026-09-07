import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  AgentSession,
  MemoryMetadata,
  ImportCheckpoint,
  OperationReceipt,
  KnowledgeRepository,
  BrainDocument,
  BrainFolder,
  BrainWorkspaceRepository,
  DocumentAttachment,
  DocumentLink,
  DocumentListOptions,
  DocumentRevision,
  DocumentSearchResult,
  DocumentSourceType,
} from "@neurosa/document-domain";
import { verifyLedgerEvents } from "@neurosa/event-ledger";
import { validateNeuralProgram } from "@neurosa/ir";
import {
  BRAIN_EVENT_TYPES,
  type ActivationResult,
  type BrainEvent,
  type BrainEventType,
  type LedgerVerificationResult,
  type NeuronState,
  type RuntimeRepository,
  type StoredBrain,
  type SynapseMode,
  type SynapseState,
} from "@neurosa/runtime-domain";
import Database from "better-sqlite3";

export const LATEST_SCHEMA_VERSION = 3;

type DatabaseRow = Record<string, unknown>;

function asRow(value: unknown): DatabaseRow | undefined {
  return value === undefined ? undefined : (value as DatabaseRow);
}

function asRows(value: unknown[]): DatabaseRow[] {
  return value as DatabaseRow[];
}

function text(value: unknown, column: string): string {
  if (typeof value !== "string") throw new Error(`Nieprawidłowa kolumna tekstowa '${column}'`);
  return value;
}

function numberValue(value: unknown, column: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Nieprawidłowa kolumna liczbowa '${column}'`);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value, "wartość opcjonalna");
}

function parseJson<T>(value: unknown, column: string): T {
  return JSON.parse(text(value, column)) as T;
}

function booleanValue(value: unknown, column: string): boolean {
  return numberValue(value, column) === 1;
}

function eventType(value: unknown): BrainEventType {
  const parsed = text(value, "event_type");
  if (!BRAIN_EVENT_TYPES.some((candidate) => candidate === parsed)) {
    throw new Error(`Nieznany typ zdarzenia dziennika '${parsed}'`);
  }
  return parsed as BrainEventType;
}

function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export const MIGRATION_1_SQL = `
  CREATE TABLE brains (
    brain_id TEXT PRIMARY KEY,
    source_hash TEXT NOT NULL,
    ir_json TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE neurons (
    brain_id TEXT NOT NULL,
    id TEXT NOT NULL,
    region_id TEXT NOT NULL,
    activation_level REAL NOT NULL,
    resting_potential REAL NOT NULL,
    threshold REAL NOT NULL,
    salience REAL NOT NULL,
    confidence REAL NOT NULL,
    enabled INTEGER NOT NULL,
    last_activated_at TEXT,
    firing_count INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (brain_id, id),
    FOREIGN KEY (brain_id) REFERENCES brains(brain_id) ON DELETE CASCADE
  );

  CREATE TABLE synapses (
    brain_id TEXT NOT NULL,
    id TEXT NOT NULL,
    source_neuron_id TEXT NOT NULL,
    target_neuron_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    weight REAL NOT NULL,
    confidence REAL NOT NULL,
    transmission_delay_ms REAL NOT NULL,
    decay_rate REAL NOT NULL,
    enabled INTEGER NOT NULL,
    activation_count INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (brain_id, id),
    FOREIGN KEY (brain_id) REFERENCES brains(brain_id) ON DELETE CASCADE,
    FOREIGN KEY (brain_id, source_neuron_id) REFERENCES neurons(brain_id, id),
    FOREIGN KEY (brain_id, target_neuron_id) REFERENCES neurons(brain_id, id)
  );

  CREATE TABLE activations (
    activation_id TEXT PRIMARY KEY,
    brain_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (brain_id) REFERENCES brains(brain_id) ON DELETE CASCADE
  );

  CREATE TABLE impulses (
    id TEXT PRIMARY KEY,
    activation_id TEXT NOT NULL,
    impulse_json TEXT NOT NULL,
    FOREIGN KEY (activation_id) REFERENCES activations(activation_id) ON DELETE CASCADE
  );

  CREATE TABLE ledger_events (
    sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    activation_id TEXT,
    timestamp TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
    event_hash TEXT NOT NULL UNIQUE
  );

  CREATE INDEX idx_neurons_region ON neurons(brain_id, region_id);
  CREATE INDEX idx_synapses_source ON synapses(brain_id, source_neuron_id);
  CREATE INDEX idx_synapses_target ON synapses(brain_id, target_neuron_id);
  CREATE INDEX idx_ledger_activation ON ledger_events(activation_id, sequence);
  CREATE INDEX idx_impulses_activation ON impulses(activation_id);

  CREATE TRIGGER ledger_events_no_update
  BEFORE UPDATE ON ledger_events
  BEGIN
    SELECT RAISE(ABORT, 'dziennik zdarzeń jest tylko do dopisywania');
  END;

  CREATE TRIGGER ledger_events_no_delete
  BEFORE DELETE ON ledger_events
  BEGIN
    SELECT RAISE(ABORT, 'dziennik zdarzeń jest tylko do dopisywania');
  END;
`;

const MIGRATION_2_SQL = `
  CREATE TABLE folders (
    folder_id TEXT PRIMARY KEY,
    parent_folder_id TEXT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (parent_folder_id) REFERENCES folders(folder_id) ON DELETE RESTRICT
  );

  CREATE TABLE documents (
    document_id TEXT PRIMARY KEY,
    folder_id TEXT,
    title TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    frontmatter_json TEXT NOT NULL,
    headings_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_reference TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    last_opened_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (folder_id) REFERENCES folders(folder_id) ON DELETE SET NULL
  );

  CREATE TABLE document_revisions (
    document_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (document_id, revision),
    FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
  );

  CREATE TABLE attachments (
    attachment_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
  );

  CREATE TABLE tags (
    tag_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE document_tags (
    document_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (document_id, tag_id),
    FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(tag_id) ON DELETE CASCADE
  );

  CREATE TABLE document_links (
    link_id TEXT PRIMARY KEY,
    source_document_id TEXT NOT NULL,
    target_reference TEXT NOT NULL,
    target_document_id TEXT,
    alias TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (source_document_id) REFERENCES documents(document_id) ON DELETE CASCADE,
    FOREIGN KEY (target_document_id) REFERENCES documents(document_id) ON DELETE SET NULL
  );

  CREATE TABLE neuron_document_bindings (
    brain_id TEXT NOT NULL,
    neuron_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    binding_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (brain_id, neuron_id, document_id),
    FOREIGN KEY (brain_id, neuron_id) REFERENCES neurons(brain_id, id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
  );

  CREATE TABLE memory_records (
    memory_id TEXT PRIMARY KEY,
    brain_id TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    content_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    salience REAL NOT NULL,
    provenance_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (brain_id) REFERENCES brains(brain_id) ON DELETE CASCADE
  );

  CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE agent_sessions (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    project_id TEXT,
    trace_id TEXT NOT NULL,
    context_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
  );

  CREATE TABLE connection_proposals (
    proposal_id TEXT PRIMARY KEY,
    brain_id TEXT NOT NULL,
    source_neuron_id TEXT NOT NULL,
    target_neuron_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    confidence REAL NOT NULL,
    evidence_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (brain_id) REFERENCES brains(brain_id) ON DELETE CASCADE
  );

  CREATE TABLE backups (
    backup_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    checksum TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    restored_at TEXT
  );

  CREATE TABLE imports (
    import_id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_reference TEXT NOT NULL,
    report_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE document_fts USING fts5(
    document_id UNINDEXED,
    title,
    content,
    tags,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE INDEX idx_documents_folder ON documents(folder_id, path);
  CREATE INDEX idx_documents_recent ON documents(last_opened_at DESC);
  CREATE INDEX idx_documents_deleted ON documents(deleted_at, archived);
  CREATE INDEX idx_document_revisions_document ON document_revisions(document_id, revision DESC);
  CREATE INDEX idx_document_links_source ON document_links(source_document_id);
  CREATE INDEX idx_document_links_target ON document_links(target_document_id);
  CREATE INDEX idx_memory_records_brain_type ON memory_records(brain_id, memory_type);
  CREATE INDEX idx_agent_sessions_agent ON agent_sessions(agent_id, created_at DESC);
  CREATE INDEX idx_connection_proposals_status ON connection_proposals(brain_id, status);
`;

export class SqliteRuntimeRepository
  implements RuntimeRepository, BrainWorkspaceRepository, KnowledgeRepository
{
  private readonly database: Database.Database;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
  }

  initialize(): void {
    this.migrate();
  }

  migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const currentRow = asRow(
      this.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
    );
    let current =
      currentRow?.version === null || currentRow?.version === undefined
        ? 0
        : numberValue(currentRow.version, "version");
    if (current > LATEST_SCHEMA_VERSION) {
      throw new Error(`Baza danych używa nieobsługiwanej migracji ${current}`);
    }
    if (current < 1) {
      this.applyMigration(1, MIGRATION_1_SQL);
      current = 1;
    }
    if (current < 2) this.applyMigration(2, MIGRATION_2_SQL);
    if (current < 3)
      this.applyMigration(
        3,
        `
      CREATE TABLE operation_receipts (
        operation_key TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL
      );
    `,
      );
  }

  getSchemaVersion(): number {
    const row = asRow(
      this.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
    );
    return row?.version === null || row?.version === undefined
      ? 0
      : numberValue(row.version, "version");
  }

  saveBrain(brain: StoredBrain): void {
    this.withTransaction(() => {
      this.database
        .prepare(
          `INSERT INTO brains(brain_id, source_hash, ir_json, schema_version, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(brain_id) DO UPDATE SET
             source_hash = excluded.source_hash,
             ir_json = excluded.ir_json,
             schema_version = excluded.schema_version,
             updated_at = excluded.updated_at`,
        )
        .run(
          brain.brainId,
          brain.sourceHash,
          JSON.stringify(brain.ir),
          LATEST_SCHEMA_VERSION,
          new Date().toISOString(),
        );
      for (const neuron of brain.neurons) this.upsertNeuron(brain.brainId, neuron);
      for (const synapse of brain.synapses) this.upsertSynapse(brain.brainId, synapse);
    });
  }

  loadBrain(brainId: string): StoredBrain | null {
    const brain = asRow(
      this.database.prepare("SELECT * FROM brains WHERE brain_id = ?").get(brainId),
    );
    if (brain === undefined) return null;
    const neurons = asRows(
      this.database.prepare("SELECT * FROM neurons WHERE brain_id = ? ORDER BY id").all(brainId),
    ).map((row): NeuronState => ({
      id: text(row.id, "id"),
      regionId: text(row.region_id, "region_id"),
      activationLevel: numberValue(row.activation_level, "activation_level"),
      restingPotential: numberValue(row.resting_potential, "resting_potential"),
      threshold: numberValue(row.threshold, "threshold"),
      salience: numberValue(row.salience, "salience"),
      confidence: numberValue(row.confidence, "confidence"),
      enabled: booleanValue(row.enabled, "enabled"),
      lastActivatedAt: nullableText(row.last_activated_at),
      firingCount: numberValue(row.firing_count, "firing_count"),
      revision: numberValue(row.revision, "revision"),
    }));
    const synapses = asRows(
      this.database.prepare("SELECT * FROM synapses WHERE brain_id = ? ORDER BY id").all(brainId),
    ).map((row): SynapseState => ({
      id: text(row.id, "id"),
      sourceNeuronId: text(row.source_neuron_id, "source_neuron_id"),
      targetNeuronId: text(row.target_neuron_id, "target_neuron_id"),
      mode: text(row.mode, "mode") as SynapseMode,
      weight: numberValue(row.weight, "weight"),
      confidence: numberValue(row.confidence, "confidence"),
      transmissionDelayMs: numberValue(row.transmission_delay_ms, "transmission_delay_ms"),
      decayRate: numberValue(row.decay_rate, "decay_rate"),
      enabled: booleanValue(row.enabled, "enabled"),
      activationCount: numberValue(row.activation_count, "activation_count"),
      revision: numberValue(row.revision, "revision"),
    }));
    return {
      brainId,
      sourceHash: text(brain.source_hash, "source_hash"),
      ir: validateNeuralProgram(parseJson(brain.ir_json, "ir_json")),
      neurons,
      synapses,
    };
  }

  saveNeuronState(brainId: string, neuron: NeuronState): void {
    this.upsertNeuron(brainId, neuron);
  }

  saveSynapseState(brainId: string, synapse: SynapseState): void {
    this.upsertSynapse(brainId, synapse);
  }

  appendEvent(event: BrainEvent): void {
    this.database
      .prepare(
        `INSERT INTO ledger_events(
          sequence, event_id, event_type, activation_id, timestamp,
          payload_json, previous_hash, event_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.sequence,
        event.eventId,
        event.eventType,
        event.activationId,
        event.timestamp,
        JSON.stringify(event.payload),
        event.previousHash,
        event.eventHash,
      );
  }

  listEvents(): readonly BrainEvent[] {
    return asRows(this.database.prepare("SELECT * FROM ledger_events ORDER BY sequence").all()).map(
      (row): BrainEvent => ({
        eventId: text(row.event_id, "event_id"),
        sequence: numberValue(row.sequence, "sequence"),
        eventType: eventType(row.event_type),
        activationId: nullableText(row.activation_id),
        timestamp: text(row.timestamp, "timestamp"),
        payload: parseJson(row.payload_json, "payload_json"),
        previousHash: text(row.previous_hash, "previous_hash"),
        eventHash: text(row.event_hash, "event_hash"),
      }),
    );
  }

  saveActivation(brainId: string, result: ActivationResult): void {
    this.withTransaction(() => {
      this.database
        .prepare(
          `INSERT INTO activations(activation_id, brain_id, result_json, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(activation_id) DO UPDATE SET result_json = excluded.result_json`,
        )
        .run(result.activationId, brainId, JSON.stringify(result), new Date().toISOString());
      this.database
        .prepare("DELETE FROM impulses WHERE activation_id = ?")
        .run(result.activationId);
      const insert = this.database.prepare(
        "INSERT INTO impulses(id, activation_id, impulse_json) VALUES (?, ?, ?)",
      );
      for (const impulse of result.deliveredImpulses) {
        insert.run(impulse.id, result.activationId, JSON.stringify(impulse));
      }
    });
  }

  loadActivation(activationId: string): ActivationResult | null {
    const row = asRow(
      this.database
        .prepare("SELECT result_json FROM activations WHERE activation_id = ?")
        .get(activationId),
    );
    return row === undefined ? null : parseJson<ActivationResult>(row.result_json, "result_json");
  }

  verifyLedger(): LedgerVerificationResult {
    return verifyLedgerEvents(this.listEvents());
  }

  saveDocument(document: BrainDocument): void {
    this.withTransaction(() => {
      this.database
        .prepare(
          `INSERT INTO documents(
            document_id, folder_id, title, path, content, frontmatter_json, headings_json,
            content_hash, revision, source_type, source_reference, archived, deleted_at,
            pinned, favorite, last_opened_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(document_id) DO UPDATE SET
            folder_id = excluded.folder_id,
            title = excluded.title,
            path = excluded.path,
            content = excluded.content,
            frontmatter_json = excluded.frontmatter_json,
            headings_json = excluded.headings_json,
            content_hash = excluded.content_hash,
            revision = excluded.revision,
            source_type = excluded.source_type,
            source_reference = excluded.source_reference,
            archived = excluded.archived,
            deleted_at = excluded.deleted_at,
            pinned = excluded.pinned,
            favorite = excluded.favorite,
            last_opened_at = excluded.last_opened_at,
            updated_at = excluded.updated_at`,
        )
        .run(
          document.documentId,
          document.folderId,
          document.title,
          document.path,
          document.content,
          JSON.stringify(document.frontmatter),
          JSON.stringify(document.headings),
          document.contentHash,
          document.revision,
          document.sourceType,
          document.sourceReference,
          document.archived ? 1 : 0,
          document.deletedAt,
          document.pinned ? 1 : 0,
          document.favorite ? 1 : 0,
          document.lastOpenedAt,
          document.createdAt,
          document.updatedAt,
        );
      this.database
        .prepare(
          `INSERT INTO document_revisions(document_id, revision, snapshot_json, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(document_id, revision) DO NOTHING`,
        )
        .run(
          document.documentId,
          document.revision,
          JSON.stringify(document),
          document.contentHash,
          document.updatedAt,
        );
      this.replaceDocumentRelations(document);
      this.resolveLinksToDocument(document);
      this.refreshSearchIndex(document.documentId);
    });
  }

  loadDocument(documentId: string): BrainDocument | null {
    const row = asRow(
      this.database.prepare("SELECT * FROM documents WHERE document_id = ?").get(documentId),
    );
    return row === undefined ? null : this.documentFromRow(row);
  }

  loadDocumentByPath(path: string): BrainDocument | null {
    const row = asRow(this.database.prepare("SELECT * FROM documents WHERE path = ?").get(path));
    return row === undefined ? null : this.documentFromRow(row);
  }

  listDocuments(options: DocumentListOptions = {}): readonly BrainDocument[] {
    return asRows(this.database.prepare("SELECT * FROM documents ORDER BY path").all())
      .map((row) => this.documentFromRow(row))
      .filter((document) => options.includeArchived === true || !document.archived)
      .filter((document) => options.includeDeleted === true || document.deletedAt === null)
      .filter((document) =>
        Object.prototype.hasOwnProperty.call(options, "folderId")
          ? document.folderId === options.folderId
          : true,
      );
  }

  listDocumentRevisions(documentId: string): readonly DocumentRevision[] {
    return asRows(
      this.database
        .prepare("SELECT * FROM document_revisions WHERE document_id = ? ORDER BY revision")
        .all(documentId),
    ).map((row): DocumentRevision => ({
      documentId: text(row.document_id, "document_id"),
      revision: numberValue(row.revision, "revision"),
      contentHash: text(row.content_hash, "content_hash"),
      snapshot: parseJson<BrainDocument>(row.snapshot_json, "snapshot_json"),
      createdAt: text(row.created_at, "created_at"),
    }));
  }

  searchDocuments(query: string, limit = 20): readonly DocumentSearchResult[] {
    const terms = query
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map((term) => `"${term.replaceAll('"', '""')}"*`)
      .join(" AND ");
    if (terms.length === 0) return [];
    const rows = asRows(
      this.database
        .prepare(
          `SELECT documents.*, bm25(document_fts) AS rank
           FROM document_fts
           JOIN documents ON documents.document_id = document_fts.document_id
           WHERE document_fts MATCH ? AND documents.deleted_at IS NULL AND documents.archived = 0
           ORDER BY rank, documents.updated_at DESC
           LIMIT ?`,
        )
        .all(terms, limit),
    );
    return rows.map((row): DocumentSearchResult => ({
      document: this.documentFromRow(row),
      rank: numberValue(row.rank, "rank"),
    }));
  }

  softDeleteDocument(documentId: string, deletedAt: string): void {
    const result = this.database
      .prepare("UPDATE documents SET deleted_at = ?, updated_at = ? WHERE document_id = ?")
      .run(deletedAt, deletedAt, documentId);
    if (result.changes === 0) throw new Error(`Nie znaleziono dokumentu '${documentId}'`);
    this.database.prepare("DELETE FROM document_fts WHERE document_id = ?").run(documentId);
  }

  restoreDocument(documentId: string, updatedAt: string): void {
    const result = this.database
      .prepare(
        "UPDATE documents SET deleted_at = NULL, archived = 0, updated_at = ? WHERE document_id = ?",
      )
      .run(updatedAt, documentId);
    if (result.changes === 0) throw new Error(`Nie znaleziono dokumentu '${documentId}'`);
    this.refreshSearchIndex(documentId);
  }

  touchDocument(documentId: string, openedAt: string): void {
    const result = this.database
      .prepare("UPDATE documents SET last_opened_at = ? WHERE document_id = ?")
      .run(openedAt, documentId);
    if (result.changes === 0) throw new Error(`Nie znaleziono dokumentu '${documentId}'`);
  }

  saveFolder(folder: BrainFolder): void {
    this.database
      .prepare(
        `INSERT INTO folders(folder_id, parent_folder_id, name, path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(folder_id) DO UPDATE SET
           parent_folder_id = excluded.parent_folder_id,
           name = excluded.name,
           path = excluded.path,
           updated_at = excluded.updated_at`,
      )
      .run(
        folder.folderId,
        folder.parentFolderId,
        folder.name,
        folder.path,
        folder.createdAt,
        folder.updatedAt,
      );
  }

  loadFolder(folderId: string): BrainFolder | null {
    const row = asRow(
      this.database.prepare("SELECT * FROM folders WHERE folder_id = ?").get(folderId),
    );
    return row === undefined ? null : this.folderFromRow(row);
  }

  listFolders(): readonly BrainFolder[] {
    return asRows(this.database.prepare("SELECT * FROM folders ORDER BY path").all()).map((row) =>
      this.folderFromRow(row),
    );
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  atomic<T>(operation: () => T): T {
    return this.database.transaction(operation).immediate();
  }

  getSession(id: string): AgentSession | null {
    const row = asRow(
      this.database.prepare("SELECT context_json FROM agent_sessions WHERE session_id = ?").get(id),
    );
    return row === undefined ? null : parseJson<AgentSession>(row.context_json, "context_json");
  }

  saveSession(session: AgentSession): void {
    this.database
      .prepare(
        `INSERT INTO agents(agent_id, name, scopes_json, created_at, updated_at)
      VALUES (?, ?, '[]', ?, ?) ON CONFLICT(agent_id) DO NOTHING`,
      )
      .run(session.agentId, session.agentId, session.createdAt, session.createdAt);
    this.database
      .prepare(
        `INSERT INTO agent_sessions(session_id, agent_id, project_id, trace_id, context_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET context_json = excluded.context_json`,
      )
      .run(
        session.sessionId,
        session.agentId,
        session.projectId,
        session.sessionId,
        JSON.stringify(session),
        session.createdAt,
      );
  }

  getDocumentMemory(documentId: string): MemoryMetadata | null {
    const row = asRow(
      this.database
        .prepare(
          "SELECT content_json FROM memory_records WHERE json_extract(content_json, '$.documentId') = ? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(documentId),
    );
    return row === undefined ? null : parseJson<MemoryMetadata>(row.content_json, "content_json");
  }

  getMemory(key: string): MemoryMetadata | null {
    const row = asRow(
      this.database.prepare("SELECT content_json FROM memory_records WHERE memory_id = ?").get(key),
    );
    return row === undefined ? null : parseJson<MemoryMetadata>(row.content_json, "content_json");
  }

  saveMemory(brainId: string, key: string, metadata: MemoryMetadata): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO memory_records(memory_id, brain_id, memory_type, content_json,
      confidence, salience, provenance_json, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET content_json=excluded.content_json,
      provenance_json=excluded.provenance_json, updated_at=excluded.updated_at`,
      )
      .run(
        key,
        brainId,
        metadata.kind,
        JSON.stringify(metadata),
        JSON.stringify({
          agentId: metadata.agentId,
          sessionId: metadata.sessionId,
          source: metadata.source ?? "UNKNOWN",
        }),
        now,
        now,
      );
  }

  countImportReferences(documentId: string): number {
    const row = asRow(
      this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM imports WHERE json_extract(report_json, '$.documentId') = ?",
        )
        .get(documentId),
    );
    return row === undefined ? 0 : numberValue(row.count, "count");
  }

  getImport(key: string): ImportCheckpoint | null {
    const row = asRow(
      this.database.prepare("SELECT report_json FROM imports WHERE import_id = ?").get(key),
    );
    return row === undefined ? null : parseJson<ImportCheckpoint>(row.report_json, "report_json");
  }

  saveImport(key: string, checkpoint: ImportCheckpoint): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO imports(import_id, source_type, source_reference, report_json,
      created_at, completed_at, status) VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED')
      ON CONFLICT(import_id) DO UPDATE SET report_json=excluded.report_json, completed_at=excluded.completed_at`,
      )
      .run(key, checkpoint.source.type, checkpoint.source.id, JSON.stringify(checkpoint), now, now);
  }

  getReceipt(key: string): OperationReceipt | null {
    const row = asRow(
      this.database
        .prepare("SELECT receipt_json FROM operation_receipts WHERE operation_key = ?")
        .get(key),
    );
    return row === undefined ? null : parseJson<OperationReceipt>(row.receipt_json, "receipt_json");
  }

  saveReceipt(key: string, receipt: OperationReceipt): void {
    this.database
      .prepare("INSERT INTO operation_receipts(operation_key, receipt_json) VALUES (?, ?)")
      .run(key, JSON.stringify(receipt));
  }

  private applyMigration(version: number, sql: string): void {
    this.withTransaction(() => {
      this.database.exec(sql);
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
    });
  }

  private upsertNeuron(brainId: string, neuron: NeuronState): void {
    this.database
      .prepare(
        `INSERT INTO neurons(
          brain_id, id, region_id, activation_level, resting_potential, threshold,
          salience, confidence, enabled, last_activated_at, firing_count, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(brain_id, id) DO UPDATE SET
          region_id = excluded.region_id,
          activation_level = excluded.activation_level,
          resting_potential = excluded.resting_potential,
          threshold = excluded.threshold,
          salience = excluded.salience,
          confidence = excluded.confidence,
          enabled = excluded.enabled,
          last_activated_at = excluded.last_activated_at,
          firing_count = excluded.firing_count,
          revision = excluded.revision`,
      )
      .run(
        brainId,
        neuron.id,
        neuron.regionId,
        neuron.activationLevel,
        neuron.restingPotential,
        neuron.threshold,
        neuron.salience,
        neuron.confidence,
        neuron.enabled ? 1 : 0,
        neuron.lastActivatedAt,
        neuron.firingCount,
        neuron.revision,
      );
  }

  private upsertSynapse(brainId: string, synapse: SynapseState): void {
    this.database
      .prepare(
        `INSERT INTO synapses(
          brain_id, id, source_neuron_id, target_neuron_id, mode, weight,
          confidence, transmission_delay_ms, decay_rate, enabled, activation_count, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(brain_id, id) DO UPDATE SET
          source_neuron_id = excluded.source_neuron_id,
          target_neuron_id = excluded.target_neuron_id,
          mode = excluded.mode,
          weight = excluded.weight,
          confidence = excluded.confidence,
          transmission_delay_ms = excluded.transmission_delay_ms,
          decay_rate = excluded.decay_rate,
          enabled = excluded.enabled,
          activation_count = excluded.activation_count,
          revision = excluded.revision`,
      )
      .run(
        brainId,
        synapse.id,
        synapse.sourceNeuronId,
        synapse.targetNeuronId,
        synapse.mode,
        synapse.weight,
        synapse.confidence,
        synapse.transmissionDelayMs,
        synapse.decayRate,
        synapse.enabled ? 1 : 0,
        synapse.activationCount,
        synapse.revision,
      );
  }

  private documentFromRow(row: DatabaseRow): BrainDocument {
    const documentId = text(row.document_id, "document_id");
    const tags = asRows(
      this.database
        .prepare(
          `SELECT tags.name FROM tags
           JOIN document_tags ON document_tags.tag_id = tags.tag_id
           WHERE document_tags.document_id = ? ORDER BY tags.name`,
        )
        .all(documentId),
    ).map((tag) => text(tag.name, "name"));
    const links = asRows(
      this.database
        .prepare("SELECT * FROM document_links WHERE source_document_id = ? ORDER BY link_id")
        .all(documentId),
    ).map((link): DocumentLink => ({
      target: text(link.target_reference, "target_reference"),
      alias: nullableText(link.alias),
      resolvedDocumentId: nullableText(link.target_document_id),
    }));
    const backlinks = asRows(
      this.database
        .prepare(
          `SELECT DISTINCT source_document_id
           FROM document_links
           JOIN documents ON documents.document_id = source_document_id
           WHERE target_document_id = ? AND documents.deleted_at IS NULL
           ORDER BY source_document_id`,
        )
        .all(documentId),
    ).map((link) => text(link.source_document_id, "source_document_id"));
    const attachments = asRows(
      this.database
        .prepare("SELECT * FROM attachments WHERE document_id = ? ORDER BY file_name")
        .all(documentId),
    ).map((attachment): DocumentAttachment => ({
      attachmentId: text(attachment.attachment_id, "attachment_id"),
      fileName: text(attachment.file_name, "file_name"),
      mimeType: text(attachment.mime_type, "mime_type"),
      sizeBytes: numberValue(attachment.size_bytes, "size_bytes"),
      contentHash: text(attachment.content_hash, "content_hash"),
      storagePath: text(attachment.storage_path, "storage_path"),
    }));
    return {
      documentId,
      title: text(row.title, "title"),
      path: text(row.path, "path"),
      folderId: nullableText(row.folder_id),
      content: text(row.content, "content"),
      frontmatter: parseJson<Readonly<Record<string, unknown>>>(
        row.frontmatter_json,
        "frontmatter_json",
      ),
      tags,
      headings: parseJson(row.headings_json, "headings_json"),
      links,
      backlinks,
      attachments,
      contentHash: text(row.content_hash, "content_hash"),
      revision: numberValue(row.revision, "revision"),
      createdAt: text(row.created_at, "created_at"),
      updatedAt: text(row.updated_at, "updated_at"),
      sourceType: text(row.source_type, "source_type") as DocumentSourceType,
      sourceReference: nullableText(row.source_reference),
      archived: booleanValue(row.archived, "archived"),
      deletedAt: nullableText(row.deleted_at),
      pinned: booleanValue(row.pinned, "pinned"),
      favorite: booleanValue(row.favorite, "favorite"),
      lastOpenedAt: nullableText(row.last_opened_at),
    };
  }

  private replaceDocumentRelations(document: BrainDocument): void {
    this.database
      .prepare("DELETE FROM document_tags WHERE document_id = ?")
      .run(document.documentId);
    const insertTag = this.database.prepare(
      "INSERT OR IGNORE INTO tags(tag_id, name) VALUES (?, ?)",
    );
    const bindTag = this.database.prepare(
      "INSERT INTO document_tags(document_id, tag_id) VALUES (?, ?)",
    );
    for (const tag of document.tags) {
      const tagId = tag.toLowerCase();
      insertTag.run(tagId, tag);
      bindTag.run(document.documentId, tagId);
    }

    this.database
      .prepare("DELETE FROM document_links WHERE source_document_id = ?")
      .run(document.documentId);
    const insertLink = this.database.prepare(
      `INSERT INTO document_links(
        link_id, source_document_id, target_reference, target_document_id, alias, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const link of document.links) {
      const targetId = this.findTargetDocumentId(link.target);
      insertLink.run(
        stableId(document.documentId, link.target, link.alias ?? ""),
        document.documentId,
        link.target,
        targetId,
        link.alias,
        document.updatedAt,
      );
    }

    this.database.prepare("DELETE FROM attachments WHERE document_id = ?").run(document.documentId);
    const insertAttachment = this.database.prepare(
      `INSERT INTO attachments(
        attachment_id, document_id, file_name, mime_type, size_bytes, content_hash, storage_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const attachment of document.attachments) {
      insertAttachment.run(
        attachment.attachmentId,
        document.documentId,
        attachment.fileName,
        attachment.mimeType,
        attachment.sizeBytes,
        attachment.contentHash,
        attachment.storagePath,
      );
    }
  }

  private findTargetDocumentId(target: string): string | null {
    const normalized = target.replace(/\\/gu, "/").replace(/^\//u, "");
    const markdownPath = normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
    const row = asRow(
      this.database
        .prepare(
          `SELECT document_id FROM documents
           WHERE deleted_at IS NULL AND (
             lower(path) = lower(?) OR lower(path) = lower(?) OR lower(title) = lower(?)
           ) ORDER BY path LIMIT 1`,
        )
        .get(normalized, markdownPath, normalized),
    );
    return row === undefined ? null : text(row.document_id, "document_id");
  }

  private resolveLinksToDocument(document: BrainDocument): void {
    const withoutExtension = document.path.replace(/\.md$/iu, "");
    this.database
      .prepare(
        `UPDATE document_links SET target_document_id = ?
         WHERE target_document_id IS NULL AND (
           lower(target_reference) = lower(?) OR
           lower(target_reference) = lower(?) OR
           lower(target_reference) = lower(?)
         )`,
      )
      .run(document.documentId, document.path, withoutExtension, document.title);
  }

  private refreshSearchIndex(documentId: string): void {
    this.database.prepare("DELETE FROM document_fts WHERE document_id = ?").run(documentId);
    const document = asRow(
      this.database.prepare("SELECT * FROM documents WHERE document_id = ?").get(documentId),
    );
    if (
      document === undefined ||
      document.deleted_at !== null ||
      booleanValue(document.archived, "archived")
    ) {
      return;
    }
    const tags = asRows(
      this.database
        .prepare(
          `SELECT tags.name FROM tags
           JOIN document_tags ON document_tags.tag_id = tags.tag_id
           WHERE document_tags.document_id = ? ORDER BY tags.name`,
        )
        .all(documentId),
    ).map((tag) => text(tag.name, "name"));
    this.database
      .prepare("INSERT INTO document_fts(document_id, title, content, tags) VALUES (?, ?, ?, ?)")
      .run(documentId, document.title, document.content, tags.join(" "));
  }

  private folderFromRow(row: DatabaseRow): BrainFolder {
    return {
      folderId: text(row.folder_id, "folder_id"),
      parentFolderId: nullableText(row.parent_folder_id),
      name: text(row.name, "name"),
      path: text(row.path, "path"),
      createdAt: text(row.created_at, "created_at"),
      updatedAt: text(row.updated_at, "updated_at"),
    };
  }

  private withTransaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }
}
