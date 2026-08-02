import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

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

const SCHEMA_VERSION = 1;

function text(value: SQLOutputValue | undefined, column: string): string {
  if (typeof value !== "string") throw new Error(`Nieprawidłowa kolumna tekstowa '${column}'`);
  return value;
}

function numberValue(value: SQLOutputValue | undefined, column: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Nieprawidłowa kolumna liczbowa '${column}'`);
}

function nullableText(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : text(value, "wartość opcjonalna");
}

function parseJson(value: SQLOutputValue | undefined, column: string): unknown {
  return JSON.parse(text(value, column)) as unknown;
}

function eventType(value: SQLOutputValue | undefined): BrainEventType {
  const parsed = text(value, "event_type");
  if (!BRAIN_EVENT_TYPES.some((candidate) => candidate === parsed)) {
    throw new Error(`Nieznany typ zdarzenia dziennika '${parsed}'`);
  }
  return parsed as BrainEventType;
}

export class SqliteRuntimeRepository implements RuntimeRepository {
  private readonly database: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
    );
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
    const row = this.database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get();
    const current =
      row?.version === null || row?.version === undefined ? 0 : numberValue(row.version, "version");
    if (current >= SCHEMA_VERSION) return;

    this.withTransaction(() => {
      this.database.exec(`
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
      `);
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(SCHEMA_VERSION, new Date().toISOString());
    });
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
          SCHEMA_VERSION,
          new Date().toISOString(),
        );
      for (const neuron of brain.neurons) this.upsertNeuron(brain.brainId, neuron);
      for (const synapse of brain.synapses) this.upsertSynapse(brain.brainId, synapse);
    });
  }

  loadBrain(brainId: string): StoredBrain | null {
    const brain = this.database.prepare("SELECT * FROM brains WHERE brain_id = ?").get(brainId);
    if (brain === undefined) return null;

    const neurons = this.database
      .prepare("SELECT * FROM neurons WHERE brain_id = ? ORDER BY id")
      .all(brainId)
      .map((row): NeuronState => ({
        id: text(row.id, "id"),
        regionId: text(row.region_id, "region_id"),
        activationLevel: numberValue(row.activation_level, "activation_level"),
        restingPotential: numberValue(row.resting_potential, "resting_potential"),
        threshold: numberValue(row.threshold, "threshold"),
        salience: numberValue(row.salience, "salience"),
        confidence: numberValue(row.confidence, "confidence"),
        enabled: numberValue(row.enabled, "enabled") === 1,
        lastActivatedAt: nullableText(row.last_activated_at),
        firingCount: numberValue(row.firing_count, "firing_count"),
        revision: numberValue(row.revision, "revision"),
      }));
    const synapses = this.database
      .prepare("SELECT * FROM synapses WHERE brain_id = ? ORDER BY id")
      .all(brainId)
      .map((row): SynapseState => ({
        id: text(row.id, "id"),
        sourceNeuronId: text(row.source_neuron_id, "source_neuron_id"),
        targetNeuronId: text(row.target_neuron_id, "target_neuron_id"),
        mode: text(row.mode, "mode") as SynapseMode,
        weight: numberValue(row.weight, "weight"),
        confidence: numberValue(row.confidence, "confidence"),
        transmissionDelayMs: numberValue(row.transmission_delay_ms, "transmission_delay_ms"),
        decayRate: numberValue(row.decay_rate, "decay_rate"),
        enabled: numberValue(row.enabled, "enabled") === 1,
        activationCount: numberValue(row.activation_count, "activation_count"),
        revision: numberValue(row.revision, "revision"),
      }));
    const ir = validateNeuralProgram(parseJson(brain.ir_json, "ir_json"));
    return {
      brainId,
      sourceHash: text(brain.source_hash, "source_hash"),
      ir,
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
    return this.database
      .prepare("SELECT * FROM ledger_events ORDER BY sequence")
      .all()
      .map((row): BrainEvent => ({
        eventId: text(row.event_id, "event_id"),
        sequence: numberValue(row.sequence, "sequence"),
        eventType: eventType(row.event_type),
        activationId: nullableText(row.activation_id),
        timestamp: text(row.timestamp, "timestamp"),
        payload: parseJson(row.payload_json, "payload_json"),
        previousHash: text(row.previous_hash, "previous_hash"),
        eventHash: text(row.event_hash, "event_hash"),
      }));
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
    const row = this.database
      .prepare("SELECT result_json FROM activations WHERE activation_id = ?")
      .get(activationId);
    if (row === undefined) return null;
    return parseJson(row.result_json, "result_json") as ActivationResult;
  }

  verifyLedger(): LedgerVerificationResult {
    return verifyLedgerEvents(this.listEvents());
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
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

  private withTransaction(operation: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
