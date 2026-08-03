import type { NeuralProgram } from "@neurosa/ir";

export type SynapseMode = "EXCITATORY" | "INHIBITORY";

export interface NeuronState {
  readonly id: string;
  readonly regionId: string;
  activationLevel: number;
  readonly restingPotential: number;
  readonly threshold: number;
  readonly salience: number;
  readonly confidence: number;
  readonly enabled: boolean;
  lastActivatedAt: string | null;
  firingCount: number;
  revision: number;
}

export interface SynapseState {
  readonly id: string;
  readonly sourceNeuronId: string;
  readonly targetNeuronId: string;
  readonly mode: SynapseMode;
  readonly weight: number;
  readonly confidence: number;
  readonly transmissionDelayMs: number;
  readonly decayRate: number;
  readonly enabled: boolean;
  activationCount: number;
  revision: number;
}

export interface NeuralImpulse {
  readonly id: string;
  readonly activationId: string;
  readonly sourceNeuronId: string | null;
  readonly targetNeuronId: string;
  readonly synapseId: string | null;
  readonly strength: number;
  readonly mode: SynapseMode;
  readonly hop: number;
  readonly createdAt: string;
  deliveredAt: string | null;
}

export interface ActivationRequest {
  readonly activationId: string;
  readonly seedNeuronIds: readonly string[];
  readonly initialStrength: number;
  readonly maksymalnaLiczbaSkokow: number;
  readonly minimalnaSila: number;
  readonly limitZdarzen: number;
  readonly limitCzasuMs: number;
  readonly trybDeterministyczny: boolean;
  readonly signal?: AbortSignal;
}

export type ActivationStopReason =
  | "ZAKOŃCZONO"
  | "OSIĄGNIĘTO_LIMIT_SKOKÓW"
  | "OSIĄGNIĘTO_LIMIT_ZDARZEŃ"
  | "OSIĄGNIĘTO_LIMIT_CZASU"
  | "BRAK_AKTYWNYCH_IMPULSÓW"
  | "ANULOWANO"
  | "BŁĄD_RUNTIME";

export type ActivationStatus = "ZAKOŃCZONA" | "ZATRZYMANA" | "BŁĄD";

export type ActivationTraceType =
  | "AKTYWACJA_NEURONU"
  | "ODPALENIE_NEURONU"
  | "UTWORZENIE_IMPULSU"
  | "DOSTARCZENIE_IMPULSU"
  | "HAMOWANIE_NEURONU"
  | "POMINIĘCIE_CYKLU"
  | "POMINIĘCIE_SŁABEGO_IMPULSU";

export interface ActivationTraceEntry {
  readonly sequence: number;
  readonly type: ActivationTraceType;
  readonly neuronId: string | null;
  readonly synapseId: string | null;
  readonly impulseId: string | null;
  readonly strength: number;
  readonly hop: number;
}

export interface ActivationResult {
  readonly activationId: string;
  readonly status: ActivationStatus;
  readonly activatedNeuronIds: readonly string[];
  readonly firedNeuronIds: readonly string[];
  readonly deliveredImpulses: readonly NeuralImpulse[];
  readonly inhibitedNeuronIds: readonly string[];
  readonly eventCount: number;
  readonly stopReason: ActivationStopReason;
  readonly trace: readonly ActivationTraceEntry[];
}

export const BRAIN_EVENT_TYPES = [
  "BRAIN_LOADED",
  "RUNTIME_STARTED",
  "ACTIVATION_STARTED",
  "NEURON_ACTIVATED",
  "NEURON_FIRED",
  "SYNAPSE_ACTIVATED",
  "IMPULSE_CREATED",
  "IMPULSE_DELIVERED",
  "NEURON_INHIBITED",
  "ACTIVATION_COMPLETED",
  "ACTIVATION_STOPPED",
  "RUNTIME_STATE_SAVED",
  "RUNTIME_STATE_RESTORED",
  "RUNTIME_ERROR",
  "IMPORT_STARTED",
  "IMPORT_DOCUMENT_COPIED",
  "IMPORT_ATTACHMENT_COPIED",
  "IMPORT_NEURON_CREATED",
  "IMPORT_SYNAPSE_CREATED",
  "IMPORT_COMPLETED",
  "IMPORT_FAILED",
] as const;

export type BrainEventType = (typeof BRAIN_EVENT_TYPES)[number];

export interface BrainEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType: BrainEventType;
  readonly activationId: string | null;
  readonly timestamp: string;
  readonly payload: unknown;
  readonly previousHash: string;
  readonly eventHash: string;
}

export interface LedgerVerificationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface EventStore {
  appendEvent(event: BrainEvent): void;
  listEvents(): readonly BrainEvent[];
}

export interface EventAppender {
  append(eventType: BrainEventType, activationId: string | null, payload: unknown): BrainEvent;
}

export interface StoredBrain {
  readonly brainId: string;
  readonly sourceHash: string;
  readonly ir: NeuralProgram;
  readonly neurons: readonly NeuronState[];
  readonly synapses: readonly SynapseState[];
}

export interface RuntimeRepository extends EventStore {
  initialize(): void;
  migrate(): void;
  saveBrain(brain: StoredBrain): void;
  loadBrain(brainId: string): StoredBrain | null;
  saveNeuronState(brainId: string, neuron: NeuronState): void;
  saveSynapseState(brainId: string, synapse: SynapseState): void;
  saveActivation(brainId: string, result: ActivationResult): void;
  loadActivation(activationId: string): ActivationResult | null;
  verifyLedger(): LedgerVerificationResult;
  close(): void;
}

export function neuronStatesFromIR(ir: NeuralProgram): NeuronState[] {
  return ir.neurons.map((neuron) => ({
    id: neuron.id,
    regionId: neuron.regionId,
    activationLevel: 0,
    restingPotential: neuron.restingPotential,
    threshold: neuron.threshold,
    salience: neuron.salience,
    confidence: neuron.confidence,
    enabled: neuron.enabled,
    lastActivatedAt: null,
    firingCount: 0,
    revision: 0,
  }));
}

export function synapseStatesFromIR(ir: NeuralProgram): SynapseState[] {
  return ir.synapses.map((synapse) => ({
    id: synapse.id,
    sourceNeuronId: synapse.sourceNeuronId,
    targetNeuronId: synapse.targetNeuronId,
    mode: synapse.mode,
    weight: synapse.weight,
    confidence: synapse.confidence,
    transmissionDelayMs: synapse.transmissionDelayMs,
    decayRate: synapse.decayRate,
    enabled: true,
    activationCount: 0,
    revision: 0,
  }));
}
