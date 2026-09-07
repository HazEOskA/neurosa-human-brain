import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileSource } from "@neurosa/compiler";
import { HashChainLedger, InMemoryEventStore, verifyLedgerEvents } from "@neurosa/event-ledger";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import type { ActivationRequest } from "@neurosa/runtime-domain";
import { SqliteRuntimeRepository } from "@neurosa/storage";

const source = `brain PersistentBrain {
  region R {
    neuron A { threshold: 0.5 salience: 1 confidence: 1 }
    neuron B { threshold: 0.4 salience: 1 confidence: 1 }
    synapse A -> B { mode: EXCITATORY weight: 0.8 confidence: 1 }
  }
}`;

const ir = compileSource(source, "persistence.nsa").ir;

function request(activationId = "persist-1"): ActivationRequest {
  return {
    activationId,
    seedNeuronIds: ["A"],
    initialStrength: 1,
    maksymalnaLiczbaSkokow: 8,
    minimalnaSila: 0.01,
    limitZdarzen: 500,
    limitCzasuMs: 5_000,
    trybDeterministyczny: true,
  };
}

describe("NEUROSA-HB event ledger", () => {
  it("jest append-only i zachowuje kolejność", () => {
    const store = new InMemoryEventStore();
    const ledger = new HashChainLedger(store);
    ledger.append("RUNTIME_STARTED", null, { brainId: "B" });
    ledger.append("ACTIVATION_STARTED", "A1", { seed: "N" });
    expect(ledger.list().map((event) => event.sequence)).toEqual([1, 2]);
    expect(() => store.appendEvent(ledger.list()[0]!)).toThrow(/nadpisać/u);
    expect(ledger.verifyLedger().valid).toBe(true);
  });

  it("poprawny ledger przechodzi weryfikację", () => {
    const ledger = new HashChainLedger(new InMemoryEventStore());
    ledger.append("RUNTIME_STARTED", null, { brainId: "B" });
    ledger.append("ACTIVATION_STARTED", "A1", { seed: "N" });
    expect(ledger.verifyLedger()).toEqual({ valid: true, errors: [] });
  });

  it("zmieniony payload nie przechodzi weryfikacji", () => {
    const ledger = new HashChainLedger(new InMemoryEventStore());
    ledger.append("RUNTIME_STARTED", null, { brainId: "B" });
    const tampered = [...structuredClone(ledger.list())];
    tampered[0] = { ...tampered[0]!, payload: { brainId: "ZMIENIONY" } };
    expect(verifyLedgerEvents(tampered).valid).toBe(false);
  });

  it("wykrywa usunięcie i zmianę kolejności zdarzeń", () => {
    const ledger = new HashChainLedger(new InMemoryEventStore());
    ledger.append("RUNTIME_STARTED", null, { n: 1 });
    ledger.append("ACTIVATION_STARTED", "A1", { n: 2 });
    ledger.append("ACTIVATION_STOPPED", "A1", { n: 3 });
    const events = ledger.list();
    expect(verifyLedgerEvents([events[0]!, events[2]!]).valid).toBe(false);
    expect(verifyLedgerEvents([events[1]!, events[0]!, events[2]!]).valid).toBe(false);
  });

  it("wykrywa błędny previousHash i eventHash", () => {
    const ledger = new HashChainLedger(new InMemoryEventStore());
    ledger.append("RUNTIME_STARTED", null, { n: 1 });
    ledger.append("ACTIVATION_STARTED", "A1", { n: 2 });
    const wrongPrevious = [...ledger.list()];
    wrongPrevious[1] = { ...wrongPrevious[1]!, previousHash: "f".repeat(64) };
    expect(verifyLedgerEvents(wrongPrevious).errors.join(" ")).toContain("previousHash");

    const wrongHash = [...ledger.list()];
    wrongHash[0] = { ...wrongHash[0]!, eventHash: "e".repeat(64) };
    expect(verifyLedgerEvents(wrongHash).errors.join(" ")).toContain("eventHash");
  });
});

describe("NEUROSA-HB SQLite persistence", () => {
  it("stan i ledger przeżywają restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "neurosa-restart-"));
    const database = join(directory, "brain.db");
    try {
      const first = new NeurosaRuntime(new SqliteRuntimeRepository(database));
      expect(first.load(ir).restored).toBe(false);
      const result = first.activate(request());
      const eventCount = first.listEvents().length;
      expect(first.verifyLedger().valid).toBe(true);
      first.close();

      const second = new NeurosaRuntime(new SqliteRuntimeRepository(database));
      expect(second.load(ir).restored).toBe(true);
      expect(second.inspectActivation(result.activationId)).toEqual(result);
      expect(second.getNeuronStates().find((state) => state.id === "A")?.firingCount).toBe(1);
      expect(second.listEvents().length).toBeGreaterThan(eventCount);
      expect(second.verifyLedger().valid).toBe(true);
      second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ponowna inicjalizacja nie duplikuje neuronów ani synaps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "neurosa-idempotent-"));
    const database = join(directory, "brain.db");
    try {
      const first = new NeurosaRuntime(new SqliteRuntimeRepository(database));
      first.load(ir);
      first.close();
      const second = new NeurosaRuntime(new SqliteRuntimeRepository(database));
      second.load(ir);
      expect(second.getNeuronStates()).toHaveLength(2);
      expect(second.getSynapseStates()).toHaveLength(1);
      expect(second.verifyLedger().valid).toBe(true);
      second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
