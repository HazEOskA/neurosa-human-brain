export type Vector3Tuple = readonly [number, number, number];

export interface BrainNeuronView {
  readonly id: string;
  readonly regionId: string;
  readonly activationLevel: number;
  readonly threshold: number;
  readonly salience: number;
  readonly confidence: number;
  readonly enabled: boolean;
  readonly firingCount?: number;
}

export interface BrainSynapseView {
  readonly id: string;
  readonly sourceNeuronId: string;
  readonly targetNeuronId: string;
  readonly mode: "EXCITATORY" | "INHIBITORY";
  readonly weight: number;
  readonly confidence: number;
  readonly enabled: boolean;
  readonly activationCount?: number;
  readonly provenance?: string;
}

export interface BrainEventView {
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly activationId: string | null;
  readonly timestamp: string;
  readonly payload: unknown;
}

export interface SceneNeuron extends BrainNeuronView {
  readonly position: Vector3Tuple;
}

export interface SceneSynapse extends BrainSynapseView {
  readonly source: Vector3Tuple;
  readonly target: Vector3Tuple;
}

export interface BrainScene {
  readonly neurons: readonly SceneNeuron[];
  readonly synapses: readonly SceneSynapse[];
  readonly rejectedSynapseIds: readonly string[];
}

export interface NeuronEffect {
  readonly intensity: number;
  readonly fired: boolean;
  readonly inhibited: boolean;
  readonly eventId: string;
  readonly sequence: number;
}

export interface SynapseEffect {
  readonly intensity: number;
  readonly eventId: string;
  readonly sequence: number;
}

export interface VisualImpulse {
  readonly impulseId: string;
  readonly synapseId: string;
  readonly sourceNeuronId: string;
  readonly targetNeuronId: string;
  readonly strength: number;
  readonly mode: "EXCITATORY" | "INHIBITORY";
  readonly eventId: string;
  readonly sequence: number;
  readonly delivered: boolean;
  readonly eventTimestamp: string;
}

export interface DynamicSynapse extends BrainSynapseView {
  readonly formedByEventId: string;
}

export interface BrainVisualState {
  readonly neuronEffects: Readonly<Record<string, NeuronEffect>>;
  readonly synapseEffects: Readonly<Record<string, SynapseEffect>>;
  readonly impulses: Readonly<Record<string, VisualImpulse>>;
  readonly dynamicSynapses: Readonly<Record<string, DynamicSynapse>>;
  readonly processedEventIds: readonly string[];
  readonly lastSequence: number;
}

export const EMPTY_VISUAL_STATE: BrainVisualState = {
  neuronEffects: {},
  synapseEffects: {},
  impulses: {},
  dynamicSynapses: {},
  processedEventIds: [],
  lastSequence: 0,
};

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function payloadRecord(payload: unknown): Readonly<Record<string, unknown>> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

function stringField(record: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Readonly<Record<string, unknown>>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function impulseFromPayload(payload: unknown): Readonly<Record<string, unknown>> {
  const outer = payloadRecord(payload);
  return payloadRecord(outer.impulse);
}

function regionCenter(regionId: string, index: number): Vector3Tuple {
  const hash = stableHash(regionId);
  const side = index % 2 === 0 ? -1 : 1;
  const layer = Math.floor(index / 2);
  const x = side * (1.4 + ((hash >>> 4) % 30) / 100);
  const y = 0.8 - (layer % 3) * 0.75 + ((hash >>> 9) % 20) / 100;
  const z = ((layer % 4) - 1.5) * 0.72 + ((hash >>> 13) % 20) / 100;
  return [x, y, z];
}

function neuronPosition(
  neuronId: string,
  regionId: string,
  regionIndex: number,
  neuronIndex: number,
  count: number,
): Vector3Tuple {
  const center = regionCenter(regionId, regionIndex);
  const hash = stableHash(neuronId);
  const angle = (neuronIndex / Math.max(1, count)) * Math.PI * 2 + (hash % 97) / 97;
  const radial = 0.34 + ((hash >>> 8) % 26) / 100;
  const vertical = (((hash >>> 16) % 100) / 100 - 0.5) * 0.62;
  return [
    center[0] + Math.cos(angle) * radial,
    center[1] + vertical,
    center[2] + Math.sin(angle) * radial,
  ];
}

export function createBrainScene(
  neurons: readonly BrainNeuronView[],
  synapses: readonly BrainSynapseView[],
): BrainScene {
  const sortedNeurons = [...neurons].sort((left, right) => left.id.localeCompare(right.id));
  const regionIds = [...new Set(sortedNeurons.map((neuron) => neuron.regionId))].sort();
  const byRegion = new Map<string, BrainNeuronView[]>();
  for (const neuron of sortedNeurons) {
    const entries = byRegion.get(neuron.regionId) ?? [];
    entries.push(neuron);
    byRegion.set(neuron.regionId, entries);
  }

  const sceneNeurons: SceneNeuron[] = [];
  for (const [regionIndex, regionId] of regionIds.entries()) {
    const entries = byRegion.get(regionId) ?? [];
    for (const [neuronIndex, neuron] of entries.entries()) {
      sceneNeurons.push({
        ...neuron,
        position: neuronPosition(neuron.id, regionId, regionIndex, neuronIndex, entries.length),
      });
    }
  }

  const neuronById = new Map(sceneNeurons.map((neuron) => [neuron.id, neuron]));
  const sceneSynapses: SceneSynapse[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const synapse of [...synapses].sort((left, right) => left.id.localeCompare(right.id))) {
    if (seen.has(synapse.id)) continue;
    seen.add(synapse.id);
    const source = neuronById.get(synapse.sourceNeuronId);
    const target = neuronById.get(synapse.targetNeuronId);
    if (source === undefined || target === undefined) {
      rejected.push(synapse.id);
      continue;
    }
    sceneSynapses.push({
      ...synapse,
      source: source.position,
      target: target.position,
    });
  }

  return {
    neurons: sceneNeurons,
    synapses: sceneSynapses,
    rejectedSynapseIds: rejected,
  };
}

function withProcessedEvent(state: BrainVisualState, event: BrainEventView): BrainVisualState {
  const retained = [...state.processedEventIds, event.eventId].slice(-512);
  return {
    ...state,
    processedEventIds: retained,
    lastSequence: Math.max(state.lastSequence, event.sequence),
  };
}

export function applyBrainEvent(
  previous: BrainVisualState,
  event: BrainEventView,
): BrainVisualState {
  if (
    previous.processedEventIds.includes(event.eventId) ||
    event.sequence <= previous.lastSequence
  ) {
    return previous;
  }

  const payload = payloadRecord(event.payload);
  let state = withProcessedEvent(previous, event);

  if (event.eventType === "NEURON_ACTIVATED") {
    const neuronId = stringField(payload, "neuronId");
    if (neuronId !== undefined) {
      const activationLevel = numberField(payload, "activationLevel") ?? 0.45;
      state = {
        ...state,
        neuronEffects: {
          ...state.neuronEffects,
          [neuronId]: {
            intensity: clamp(Math.abs(activationLevel)),
            fired: false,
            inhibited: false,
            eventId: event.eventId,
            sequence: event.sequence,
          },
        },
      };
    }
  }

  if (event.eventType === "NEURON_FIRED") {
    const neuronId = stringField(payload, "neuronId");
    if (neuronId !== undefined) {
      state = {
        ...state,
        neuronEffects: {
          ...state.neuronEffects,
          [neuronId]: {
            intensity: 1,
            fired: true,
            inhibited: false,
            eventId: event.eventId,
            sequence: event.sequence,
          },
        },
      };
    }
  }

  if (event.eventType === "NEURON_INHIBITED") {
    const neuronId = stringField(payload, "neuronId");
    if (neuronId !== undefined) {
      state = {
        ...state,
        neuronEffects: {
          ...state.neuronEffects,
          [neuronId]: {
            intensity: clamp(Math.abs(numberField(payload, "delta") ?? 0.35)),
            fired: false,
            inhibited: true,
            eventId: event.eventId,
            sequence: event.sequence,
          },
        },
      };
    }
  }

  if (event.eventType === "SYNAPSE_ACTIVATED") {
    const synapseId = stringField(payload, "synapseId");
    if (synapseId !== undefined) {
      state = {
        ...state,
        synapseEffects: {
          ...state.synapseEffects,
          [synapseId]: {
            intensity: clamp(Math.abs(numberField(payload, "strength") ?? 0.4)),
            eventId: event.eventId,
            sequence: event.sequence,
          },
        },
      };
    }
  }

  if (event.eventType === "IMPULSE_CREATED" || event.eventType === "IMPULSE_DELIVERED") {
    const impulse = impulseFromPayload(event.payload);
    const impulseId = stringField(impulse, "id");
    const synapseId = stringField(impulse, "synapseId");
    const sourceNeuronId = stringField(impulse, "sourceNeuronId");
    const targetNeuronId = stringField(impulse, "targetNeuronId");
    const mode = stringField(impulse, "mode");
    if (
      impulseId !== undefined &&
      synapseId !== undefined &&
      sourceNeuronId !== undefined &&
      targetNeuronId !== undefined &&
      (mode === "EXCITATORY" || mode === "INHIBITORY")
    ) {
      state = {
        ...state,
        impulses: {
          ...state.impulses,
          [impulseId]: {
            impulseId,
            synapseId,
            sourceNeuronId,
            targetNeuronId,
            strength: clamp(Math.abs(numberField(impulse, "strength") ?? 0)),
            mode,
            eventId: event.eventId,
            sequence: event.sequence,
            delivered: event.eventType === "IMPULSE_DELIVERED",
            eventTimestamp: event.timestamp,
          },
        },
      };
    }
  }

  if (event.eventType === "SYNAPSE_FORMED") {
    const synapse = payloadRecord(payload.synapse);
    const id = stringField(synapse, "id");
    const sourceNeuronId = stringField(synapse, "sourceNeuronId");
    const targetNeuronId = stringField(synapse, "targetNeuronId");
    const mode = stringField(synapse, "mode");
    if (
      id !== undefined &&
      sourceNeuronId !== undefined &&
      targetNeuronId !== undefined &&
      (mode === "EXCITATORY" || mode === "INHIBITORY")
    ) {
      state = {
        ...state,
        dynamicSynapses: {
          ...state.dynamicSynapses,
          [id]: {
            id,
            sourceNeuronId,
            targetNeuronId,
            mode,
            weight: clamp(numberField(synapse, "weight") ?? 0.5),
            confidence: clamp(numberField(synapse, "confidence") ?? 0.5),
            enabled: true,
            formedByEventId: event.eventId,
          },
        },
      };
    }
  }

  if (event.eventType === "SYNAPSE_PRUNED" || event.eventType === "CONNECTION_PRUNED") {
    const synapseId = stringField(payload, "synapseId");
    if (synapseId !== undefined && state.dynamicSynapses[synapseId] !== undefined) {
      const dynamicSynapses = { ...state.dynamicSynapses };
      delete dynamicSynapses[synapseId];
      state = { ...state, dynamicSynapses };
    }
  }

  return state;
}

export function mergeDynamicSynapses(
  staticSynapses: readonly BrainSynapseView[],
  visualState: BrainVisualState,
): BrainSynapseView[] {
  const byId = new Map(staticSynapses.map((synapse) => [synapse.id, synapse]));
  for (const synapse of Object.values(visualState.dynamicSynapses)) {
    byId.set(synapse.id, synapse);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export interface ParsedSseResult {
  readonly events: readonly BrainEventView[];
  readonly rest: string;
}

export function parseSseFrames(input: string): ParsedSseResult {
  const frames = input.split(/\r?\n\r?\n/u);
  const rest = frames.pop() ?? "";
  const events: BrainEventView[] = [];

  for (const frame of frames) {
    const lines = frame.split(/\r?\n/u);
    let eventType = "message";
    let eventId = "";
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      if (line.startsWith("id:")) eventId = line.slice(3).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0 || eventType === "polaczono") continue;
    try {
      const value = JSON.parse(data.join("\n")) as unknown;
      const record = payloadRecord(value);
      const sequence = numberField(record, "sequence");
      const payloadEventId = stringField(record, "eventId");
      const timestamp = stringField(record, "timestamp");
      if (sequence === undefined || timestamp === undefined) continue;
      events.push({
        eventId: payloadEventId ?? eventId,
        sequence,
        eventType: stringField(record, "eventType") ?? eventType,
        activationId:
          record.activationId === null
            ? null
            : typeof record.activationId === "string"
              ? record.activationId
              : null,
        timestamp,
        payload: record.payload,
      });
    } catch {
      // Uszkodzona ramka nie może tworzyć fikcyjnego zdarzenia wizualizacji.
    }
  }

  return { events, rest };
}

export function eventStreamUrl(apiBaseUrl: string, afterSequence: number): string {
  const base = apiBaseUrl.replace(/\/+$/u, "");
  return base + "/api/v1/brain/events/stream?afterSequence=" + String(Math.max(0, afterSequence));
}
