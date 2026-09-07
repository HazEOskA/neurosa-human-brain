import { ActivationEngine, type ActivationEngineOptions } from "@neurosa/activation";
import { HashChainLedger } from "@neurosa/event-ledger";
import { validateNeuralProgram, type NeuralProgram } from "@neurosa/ir";
import {
  neuronStatesFromIR,
  synapseStatesFromIR,
  type ActivationRequest,
  type ActivationResult,
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

  activate(request: ActivationRequest): ActivationResult {
    const brain = this.requireBrain();
    try {
      const engine = new ActivationEngine(
        brain.neurons as NeuronState[],
        brain.synapses as SynapseState[],
        this.ledger,
        this.activationOptions,
      );
      const result = engine.activate(request);
      this.repository.saveBrain(brain);
      this.repository.saveActivation(brain.brainId, result);
      this.ledger.append("RUNTIME_STATE_SAVED", request.activationId, {
        brainId: brain.brainId,
        neuronCount: brain.neurons.length,
        synapseCount: brain.synapses.length,
      });
      return result;
    } catch (error: unknown) {
      this.ledger.append("RUNTIME_ERROR", request.activationId, {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
