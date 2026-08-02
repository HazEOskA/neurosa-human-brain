import { ActivationEngine } from "@neurosa/activation";
import { compileSource } from "@neurosa/compiler";
import { HashChainLedger, InMemoryEventStore } from "@neurosa/event-ledger";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import type { ActivationRequest, NeuronState, SynapseState } from "@neurosa/runtime-domain";
import { SqliteRuntimeRepository } from "@neurosa/storage";

const excitatorySource = `brain RuntimeBrain {
  region TestRegion {
    neuron A { type: concept threshold: 0.5 salience: 1 confidence: 1 }
    neuron B { type: memory threshold: 0.4 salience: 1 confidence: 1 }
    synapse A -> B { relation: SUPPORTS mode: EXCITATORY weight: 0.8 confidence: 1 }
  }
}`;

const inhibitorySource = `brain RuntimeBrain {
  region TestRegion {
    neuron A { type: concept threshold: 0.5 salience: 1 confidence: 1 }
    neuron B { type: memory threshold: 0.4 salience: 1 confidence: 1 }
    synapse A -> B { relation: BLOCKS mode: INHIBITORY weight: 0.8 confidence: 1 }
  }
}`;

const cycleSource = `brain CycleBrain {
  region TestRegion {
    neuron A { threshold: 0.2 salience: 1 confidence: 1 }
    neuron B { threshold: 0.2 salience: 1 confidence: 1 }
    synapse A -> B { mode: EXCITATORY weight: 1 confidence: 1 }
    synapse B -> A { mode: EXCITATORY weight: 1 confidence: 1 }
  }
}`;

function request(overrides: Partial<ActivationRequest> = {}): ActivationRequest {
  return {
    activationId: "aktywacja-testowa",
    seedNeuronIds: ["A"],
    initialStrength: 1,
    maksymalnaLiczbaSkokow: 8,
    minimalnaSila: 0.01,
    limitZdarzen: 500,
    limitCzasuMs: 5_000,
    trybDeterministyczny: true,
    ...overrides,
  };
}

function openRuntime(source = excitatorySource): NeurosaRuntime {
  const runtime = new NeurosaRuntime(new SqliteRuntimeRepository(":memory:"));
  runtime.load(compileSource(source, "runtime-test.nsa").ir);
  return runtime;
}

function neuron(id: string, enabled = true, threshold = 0.5): NeuronState {
  return {
    id,
    regionId: "R",
    activationLevel: 0,
    restingPotential: 0,
    threshold,
    salience: 1,
    confidence: 1,
    enabled,
    lastActivatedAt: null,
    firingCount: 0,
    revision: 0,
  };
}

function synapse(enabled = true): SynapseState {
  return {
    id: "R/A->B#1",
    sourceNeuronId: "A",
    targetNeuronId: "B",
    mode: "EXCITATORY",
    weight: 1,
    confidence: 1,
    transmissionDelayMs: 0,
    decayRate: 0,
    enabled,
    activationCount: 0,
    revision: 0,
  };
}

describe("NEUROSA-HB runtime", () => {
  it("ładuje poprawny Neural IR 0.1", () => {
    const runtime = openRuntime();
    expect(runtime.getProgram().version).toBe("0.1");
    runtime.close();
  });

  it("odrzuca niepoprawny IR", () => {
    const runtime = new NeurosaRuntime(new SqliteRuntimeRepository(":memory:"));
    expect(() => runtime.load({ version: "0.1" })).toThrow();
    runtime.close();
  });

  it("inicjalizuje neurony z IR", () => {
    const runtime = openRuntime();
    expect(runtime.getNeuronStates().map((state) => state.id)).toEqual(["A", "B"]);
    runtime.close();
  });

  it("inicjalizuje synapsy z IR", () => {
    const runtime = openRuntime();
    expect(runtime.getSynapseStates()).toHaveLength(1);
    expect(runtime.getSynapseStates()[0]).toMatchObject({
      sourceNeuronId: "A",
      targetNeuronId: "B",
      mode: "EXCITATORY",
    });
    runtime.close();
  });

  it("propaguje pobudzenie przez rzeczywistą synapsę", () => {
    const runtime = openRuntime();
    const result = runtime.activate(request());
    expect(result.firedNeuronIds).toEqual(["A", "B"]);
    expect(result.deliveredImpulses.some((impulse) => impulse.synapseId !== null)).toBe(true);
    expect(runtime.listEvents().some((event) => event.eventType === "SYNAPSE_ACTIVATED")).toBe(
      true,
    );
    runtime.close();
  });

  it("propaguje hamowanie jako ujemną aktywację", () => {
    const runtime = openRuntime(inhibitorySource);
    const result = runtime.activate(request());
    expect(result.inhibitedNeuronIds).toContain("B");
    expect(result.firedNeuronIds).not.toContain("B");
    expect(
      runtime.getNeuronStates().find((state) => state.id === "B")?.activationLevel,
    ).toBeLessThan(0);
    runtime.close();
  });

  it("nie odpala neuronu poniżej progu", () => {
    const runtime = openRuntime();
    const result = runtime.activate(request({ initialStrength: 0.2 }));
    expect(result.firedNeuronIds).toEqual([]);
    runtime.close();
  });

  it("odpala neuron powyżej progu", () => {
    const runtime = openRuntime();
    expect(runtime.activate(request()).firedNeuronIds).toContain("A");
    runtime.close();
  });

  it("nie odpala wyłączonego neuronu", () => {
    const engine = new ActivationEngine(
      [neuron("A", false)],
      [],
      new HashChainLedger(new InMemoryEventStore()),
    );
    expect(engine.activate(request()).firedNeuronIds).toEqual([]);
  });

  it("nie przekazuje impulsu przez wyłączoną synapsę", () => {
    const engine = new ActivationEngine(
      [neuron("A"), neuron("B")],
      [synapse(false)],
      new HashChainLedger(new InMemoryEventStore()),
    );
    const result = engine.activate(request());
    expect(result.deliveredImpulses.some((impulse) => impulse.targetNeuronId === "B")).toBe(false);
  });

  it("minimalna siła zatrzymuje słaby impuls", () => {
    const runtime = openRuntime();
    const result = runtime.activate(request({ initialStrength: 0.001, minimalnaSila: 0.01 }));
    expect(result.deliveredImpulses).toHaveLength(0);
    expect(result.stopReason).toBe("BRAK_AKTYWNYCH_IMPULSÓW");
    runtime.close();
  });

  it("maksymalna liczba skoków zatrzymuje propagację", () => {
    const runtime = openRuntime();
    const result = runtime.activate(request({ maksymalnaLiczbaSkokow: 0 }));
    expect(result.stopReason).toBe("OSIĄGNIĘTO_LIMIT_SKOKÓW");
    expect(result.deliveredImpulses).toHaveLength(1);
    runtime.close();
  });

  it("limit zdarzeń zatrzymuje przebieg bez przekroczenia budżetu", () => {
    const runtime = openRuntime();
    const result = runtime.activate(request({ limitZdarzen: 4 }));
    expect(result.stopReason).toBe("OSIĄGNIĘTO_LIMIT_ZDARZEŃ");
    expect(result.eventCount).toBeLessThanOrEqual(4);
    runtime.close();
  });

  it("anulowanie zatrzymuje aktywację", () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = openRuntime();
    const result = runtime.activate(request({ signal: controller.signal }));
    expect(result.stopReason).toBe("ANULOWANO");
    runtime.close();
  });

  it("limit czasu zatrzymuje aktywację", () => {
    const times = [0, 10];
    const engine = new ActivationEngine(
      [neuron("A")],
      [],
      new HashChainLedger(new InMemoryEventStore()),
      { monotonicNow: () => times.shift() ?? 10 },
    );
    const result = engine.activate(request({ limitCzasuMs: 1, trybDeterministyczny: false }));
    expect(result.stopReason).toBe("OSIĄGNIĘTO_LIMIT_CZASU");
  });

  it("wykrywa cykl i nie wykonuje nieskończonej propagacji", () => {
    const runtime = openRuntime(cycleSource);
    const result = runtime.activate(request({ limitZdarzen: 100 }));
    expect(result.trace.some((entry) => entry.type === "POMINIĘCIE_CYKLU")).toBe(true);
    expect(result.eventCount).toBeLessThan(100);
    runtime.close();
  });

  it("zwraca deterministycznie identyczny wynik", () => {
    const first = openRuntime();
    const second = openRuntime();
    const firstResult = first.activate(request());
    const secondResult = second.activate(request());
    expect(secondResult).toEqual(firstResult);
    first.close();
    second.close();
  });

  it("nie miesza wyników różnych activationId", () => {
    const runtime = openRuntime();
    const first = runtime.activate(request({ activationId: "aktywacja-1" }));
    const second = runtime.activate(request({ activationId: "aktywacja-2" }));
    expect(runtime.inspectActivation("aktywacja-1")).toEqual(first);
    expect(runtime.inspectActivation("aktywacja-2")).toEqual(second);
    expect(first.deliveredImpulses[0]?.activationId).toBe("aktywacja-1");
    expect(second.deliveredImpulses[0]?.activationId).toBe("aktywacja-2");
    runtime.close();
  });

  it("zapisuje eventy pochodzące z realnego wykonania", () => {
    const runtime = openRuntime();
    runtime.activate(request());
    const types = runtime.listEvents().map((event) => event.eventType);
    expect(types).toContain("BRAIN_LOADED");
    expect(types).toContain("NEURON_FIRED");
    expect(types).toContain("IMPULSE_DELIVERED");
    expect(types).toContain("RUNTIME_STATE_SAVED");
    runtime.close();
  });
});
