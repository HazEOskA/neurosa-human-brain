import { createHash } from "node:crypto";
import { ActivationEngine, type ActivationEngineOptions } from "@neurosa/activation";
import { canonicalJson, HashChainLedger, InMemoryEventStore } from "@neurosa/event-ledger";
import { validateNeuralProgram, type NeuralProgram } from "@neurosa/ir";
import {
  neuronStatesFromIR,
  synapseStatesFromIR,
  type ActivationRequest,
  type ActivationResult,
  type ActivationProvenance,
  type BrainEvent,
  type LedgerVerificationResult,
  type NeuronState,
  type RuntimeRepository,
  type StoredBrain,
  type SynapseState,
} from "@neurosa/runtime-domain";

export interface RuntimeLoadResult {
  readonly brainId: string;
  readonly restored: boolean;
  readonly neuronCount: number;
  readonly synapseCount: number;
}

export class ActivationIdConflict extends Error {}

export class ReplayIntegrityError extends Error {}

export interface ActivationSourceBinding {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly documentHash: string;
}

export interface ReplayVerification {
  readonly activationId: string;
  readonly replayMatched: boolean;
  readonly ledgerValid: boolean;
  readonly receiptEventHash: string;
  readonly provenance: ActivationProvenance;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export class NeurosaRuntime {
  private readonly ledger: HashChainLedger;
  private brain: StoredBrain | null = null;

  constructor(
    private readonly repository: RuntimeRepository,
    private readonly activationOptions: ActivationEngineOptions = {},
  ) {
    this.repository.initialize();
    if (!repository.verifyLedger().valid)
      throw new Error("Uszkodzony ledger: uruchomienie runtime zablokowane");
    this.ledger = new HashChainLedger(repository);
  }

  load(program: unknown): RuntimeLoadResult {
    let ir: NeuralProgram;
    try {
      ir = validateNeuralProgram(program);
    } catch {
      throw new Error("Nieprawidłowa neuronowa reprezentacja pośrednia IR 0.1");
    }
    const stored = this.repository.loadBrain(ir.brainId);
    const restored = stored !== null && stored.sourceHash === ir.sourceHash;
    this.brain = restored
      ? stored
      : {
          brainId: ir.brainId,
          sourceHash: ir.sourceHash,
          ir,
          neurons: neuronStatesFromIR(ir),
          synapses: synapseStatesFromIR(ir),
        };

    if (!restored) this.repository.saveBrain(this.brain);
    this.ledger.append("BRAIN_LOADED", null, {
      brainId: ir.brainId,
      sourceHash: ir.sourceHash,
      restored,
    });
    if (restored) {
      this.ledger.append("RUNTIME_STATE_RESTORED", null, {
        brainId: ir.brainId,
        neuronCount: this.brain.neurons.length,
        synapseCount: this.brain.synapses.length,
      });
    }
    this.ledger.append("RUNTIME_STARTED", null, { brainId: ir.brainId });
    return {
      brainId: ir.brainId,
      restored,
      neuronCount: this.brain.neurons.length,
      synapseCount: this.brain.synapses.length,
    };
  }

  activate(request: ActivationRequest, source?: ActivationSourceBinding): ActivationResult {
    const brain = this.requireBrain();
    if (this.repository.loadActivation(request.activationId) !== null)
      throw new ActivationIdConflict("Identyfikator aktywacji jest już używany");
    if (source !== undefined && (!request.trybDeterministyczny || request.signal !== undefined))
      throw new ReplayIntegrityError("Odtwarzalny zapis wymaga deterministycznej aktywacji");
    if (!this.repository.verifyLedger().valid)
      throw new ReplayIntegrityError("Nieprawidłowy ledger: aktywacja zablokowana");

    const neuronsBefore = structuredClone(brain.neurons);
    const synapsesBefore = structuredClone(brain.synapses);
    try {
      return this.repository.atomic(() => {
        if (this.repository.loadActivation(request.activationId) !== null)
          throw new ActivationIdConflict("Identyfikator aktywacji jest już używany");
        const engine = new ActivationEngine(
          brain.neurons as NeuronState[],
          brain.synapses as SynapseState[],
          this.ledger,
          this.activationOptions,
        );
        const executed = engine.activate(request);
        const provenance: ActivationProvenance | undefined =
          source === undefined
            ? undefined
            : {
                ...source,
                irHash: digest(brain.ir),
                sourceHash: brain.ir.sourceHash,
                irVersion: brain.ir.version,
              };
        const result: ActivationResult =
          provenance === undefined
            ? executed
            : {
                ...executed,
                provenance,
                replayContext: {
                  request: structuredClone(request),
                  program: structuredClone(brain.ir),
                  neurons: neuronsBefore,
                  synapses: synapsesBefore,
                },
              };
        this.repository.saveBrain(brain);
        this.repository.saveActivation(brain.brainId, result);
        this.ledger.append("RUNTIME_STATE_SAVED", request.activationId, {
          brainId: brain.brainId,
          neuronCount: brain.neurons.length,
          synapseCount: brain.synapses.length,
          resultHash: digest(result),
        });
        return result;
      });
    } catch (error: unknown) {
      // SQLite rollback does not roll back the in-memory engine state.
      for (let index = 0; index < brain.neurons.length; index += 1) {
        Object.assign(brain.neurons[index]!, neuronsBefore[index]);
      }
      for (let index = 0; index < brain.synapses.length; index += 1) {
        Object.assign(brain.synapses[index]!, synapsesBefore[index]);
      }
      if (!(error instanceof ActivationIdConflict)) {
        this.ledger.append("RUNTIME_ERROR", request.activationId, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  replayActivation(activationId: string): ReplayVerification {
    const saved = this.repository.loadActivation(activationId);
    if (saved === null) throw new ReplayIntegrityError("Nie znaleziono aktywacji");
    if (!this.repository.verifyLedger().valid)
      throw new ReplayIntegrityError("Integralność ledgera jest naruszona");
    if (saved.provenance === undefined || saved.replayContext === undefined)
      throw new ReplayIntegrityError("Historyczna aktywacja nie posiada kompletnego snapshotu");

    const context = saved.replayContext;
    const provenance = saved.provenance;
    if (
      !context.request.trybDeterministyczny ||
      context.request.activationId !== activationId ||
      context.program.sourceHash !== provenance.sourceHash ||
      context.program.version !== provenance.irVersion ||
      digest(context.program) !== provenance.irHash
    )
      throw new ReplayIntegrityError("Niezgodny snapshot wejściowy lub IR");

    const receipts = this.repository
      .listEvents()
      .filter((event) =>
        event.eventType === "RUNTIME_STATE_SAVED" && event.activationId === activationId,
      );
    if (receipts.length !== 1)
      throw new ReplayIntegrityError("Brak unikalnego potwierdzenia aktywacji w ledgerze");
    const receipt = receipts[0]!;
    const payload = receipt.payload as { resultHash?: unknown };
    if (typeof payload.resultHash !== "string" || payload.resultHash !== digest(saved))
      throw new ReplayIntegrityError("Ślad aktywacji nie zgadza się z potwierdzeniem SHA-256");

    const engine = new ActivationEngine(
      structuredClone(context.neurons) as NeuronState[],
      structuredClone(context.synapses) as SynapseState[],
      new HashChainLedger(new InMemoryEventStore()),
      this.activationOptions,
    );
    const recomputed = engine.activate(context.request);
    const comparison = structuredClone(saved);
    delete comparison.provenance;
    delete comparison.replayContext;
    if (canonicalJson(comparison) !== canonicalJson(recomputed))
      throw new ReplayIntegrityError("Historyczna propagacja neuronów nie jest odtwarzalna");

    return {
      activationId,
      replayMatched: true,
      ledgerValid: true,
      receiptEventHash: receipt.eventHash,
      provenance,
    };
  }

  inspectActivation(activationId: string): ActivationResult | null {
    return this.repository.loadActivation(activationId);
  }

  verifyLedger(): LedgerVerificationResult {
    return this.repository.verifyLedger();
  }

  listEvents(): readonly BrainEvent[] {
    return this.repository.listEvents();
  }

  getNeuronStates(): readonly NeuronState[] {
    return structuredClone(this.requireBrain().neurons);
  }

  getSynapseStates(): readonly SynapseState[] {
    return structuredClone(this.requireBrain().synapses);
  }

  getProgram(): NeuralProgram {
    return structuredClone(this.requireBrain().ir);
  }

  close(): void {
    this.repository.close();
  }

  private requireBrain(): StoredBrain {
    if (this.brain === null) throw new Error("Runtime nie załadował jeszcze programu Neural IR");
    return this.brain;
  }
}
