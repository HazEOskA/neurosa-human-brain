import { randomUUID } from "node:crypto";

import type { HashChainLedger } from "@neurosa/event-ledger";
import type {
  ActivationRequest,
  ActivationResult,
  ActivationStopReason,
  ActivationTraceEntry,
  BrainEventType,
  NeuralImpulse,
  NeuronState,
  SynapseState,
} from "@neurosa/runtime-domain";

interface QueuedImpulse {
  readonly impulse: NeuralImpulse;
  readonly visitedSynapseIds: ReadonlySet<string>;
}

export interface ActivationEngineOptions {
  readonly monotonicNow?: () => number;
}

function validateRequest(request: ActivationRequest): void {
  if (request.activationId.trim().length === 0) {
    throw new Error("Identyfikator aktywacji nie może być pusty");
  }
  if (request.seedNeuronIds.length === 0) {
    throw new Error("Aktywacja wymaga co najmniej jednego neuronu startowego");
  }
  if (request.initialStrength < 0 || request.initialStrength > 1) {
    throw new Error("Początkowa siła musi mieścić się w zakresie 0..1");
  }
  if (request.minimalnaSila < 0 || request.minimalnaSila > 1) {
    throw new Error("Minimalna siła musi mieścić się w zakresie 0..1");
  }
  if (!Number.isInteger(request.maksymalnaLiczbaSkokow) || request.maksymalnaLiczbaSkokow < 0) {
    throw new Error("Maksymalna liczba skoków musi być nieujemną liczbą całkowitą");
  }
  if (!Number.isInteger(request.limitZdarzen) || request.limitZdarzen < 2) {
    throw new Error("Limit zdarzeń musi być liczbą całkowitą nie mniejszą niż 2");
  }
  if (!Number.isFinite(request.limitCzasuMs) || request.limitCzasuMs < 1) {
    throw new Error("Limit czasu musi być dodatnią liczbą milisekund");
  }
}

export class ActivationEngine {
  private readonly monotonicNow: () => number;

  constructor(
    private readonly neurons: NeuronState[],
    private readonly synapses: SynapseState[],
    private readonly ledger: HashChainLedger,
    options: ActivationEngineOptions = {},
  ) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  activate(request: ActivationRequest): ActivationResult {
    validateRequest(request);
    const neurons = new Map(this.neurons.map((neuron) => [neuron.id, neuron]));
    for (const seed of request.seedNeuronIds) {
      if (!neurons.has(seed)) throw new Error(`Nieznany neuron startowy '${seed}'`);
    }

    for (const neuron of this.neurons) neuron.activationLevel = 0;

    const outgoing = new Map<string, SynapseState[]>();
    for (const synapse of this.synapses) {
      const entries = outgoing.get(synapse.sourceNeuronId) ?? [];
      entries.push(synapse);
      outgoing.set(synapse.sourceNeuronId, entries);
    }
    for (const entries of outgoing.values()) {
      entries.sort((left, right) => left.id.localeCompare(right.id));
    }

    const activated = new Set<string>();
    const fired = new Set<string>();
    const inhibited = new Set<string>();
    const delivered: NeuralImpulse[] = [];
    const trace: ActivationTraceEntry[] = [];
    const queue: QueuedImpulse[] = [];
    const startedAt = this.monotonicNow();
    let eventCount = 0;
    let impulseSequence = 0;
    let traceSequence = 0;
    let deterministicTimeSequence = 0;
    let stopReason: ActivationStopReason = "ZAKOŃCZONO";
    let reachedHopLimit = false;

    const timestamp = (): string => {
      if (!request.trybDeterministyczny) return new Date().toISOString();
      const value = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, deterministicTimeSequence));
      deterministicTimeSequence += 1;
      return value.toISOString();
    };
    const impulseId = (): string => {
      impulseSequence += 1;
      return request.trybDeterministyczny
        ? `${request.activationId}:impuls:${String(impulseSequence).padStart(4, "0")}`
        : randomUUID();
    };
    const addTrace = (
      type: ActivationTraceEntry["type"],
      neuronId: string | null,
      synapseId: string | null,
      impulse: NeuralImpulse | null,
      strength: number,
      hop: number,
    ): void => {
      traceSequence += 1;
      trace.push({
        sequence: traceSequence,
        type,
        neuronId,
        synapseId,
        impulseId: impulse?.id ?? null,
        strength,
        hop,
      });
    };
    const emit = (eventType: BrainEventType, payload: unknown): boolean => {
      if (eventCount >= request.limitZdarzen - 1) {
        stopReason = "OSIĄGNIĘTO_LIMIT_ZDARZEŃ";
        return false;
      }
      this.ledger.append(eventType, request.activationId, payload);
      eventCount += 1;
      return true;
    };
    const timedOut = (): boolean =>
      !request.trybDeterministyczny && this.monotonicNow() - startedAt >= request.limitCzasuMs;

    if (!emit("ACTIVATION_STARTED", { seedNeuronIds: request.seedNeuronIds })) {
      return this.finish(
        request,
        activated,
        fired,
        delivered,
        inhibited,
        eventCount,
        stopReason,
        trace,
      );
    }

    for (const seedNeuronId of request.seedNeuronIds) {
      const impulse: NeuralImpulse = {
        id: impulseId(),
        activationId: request.activationId,
        sourceNeuronId: null,
        targetNeuronId: seedNeuronId,
        synapseId: null,
        strength: request.initialStrength,
        mode: "EXCITATORY",
        hop: 0,
        createdAt: timestamp(),
        deliveredAt: null,
      };
      if (!emit("IMPULSE_CREATED", { impulse })) break;
      addTrace("UTWORZENIE_IMPULSU", seedNeuronId, null, impulse, impulse.strength, 0);
      queue.push({ impulse, visitedSynapseIds: new Set() });
    }

    while (queue.length > 0 && stopReason === "ZAKOŃCZONO") {
      if (request.signal?.aborted === true) {
        stopReason = "ANULOWANO";
        break;
      }
      if (timedOut()) {
        stopReason = "OSIĄGNIĘTO_LIMIT_CZASU";
        break;
      }

      const queued = queue.shift();
      if (queued === undefined) break;
      const impulse = queued.impulse;
      if (Math.abs(impulse.strength) < request.minimalnaSila) {
        addTrace(
          "POMINIĘCIE_SŁABEGO_IMPULSU",
          impulse.targetNeuronId,
          impulse.synapseId,
          impulse,
          impulse.strength,
          impulse.hop,
        );
        continue;
      }

      const neuron = neurons.get(impulse.targetNeuronId);
      if (neuron === undefined) {
        stopReason = "BŁĄD_RUNTIME";
        break;
      }
      if (!neuron.enabled) continue;

      impulse.deliveredAt = timestamp();
      delivered.push(impulse);
      if (!emit("IMPULSE_DELIVERED", { impulse })) break;
      addTrace(
        "DOSTARCZENIE_IMPULSU",
        neuron.id,
        impulse.synapseId,
        impulse,
        impulse.strength,
        impulse.hop,
      );

      const polarity = impulse.mode === "INHIBITORY" ? -1 : 1;
      const neuronModulation = neuron.confidence * (0.5 + neuron.salience * 0.5);
      const delta = impulse.strength * polarity * neuronModulation;
      neuron.activationLevel += delta;
      neuron.lastActivatedAt = impulse.deliveredAt;
      neuron.revision += 1;
      activated.add(neuron.id);
      if (
        !emit("NEURON_ACTIVATED", {
          neuronId: neuron.id,
          delta,
          activationLevel: neuron.activationLevel,
        })
      ) {
        break;
      }
      addTrace("AKTYWACJA_NEURONU", neuron.id, impulse.synapseId, impulse, delta, impulse.hop);

      if (polarity < 0) {
        inhibited.add(neuron.id);
        if (!emit("NEURON_INHIBITED", { neuronId: neuron.id, delta })) break;
        addTrace("HAMOWANIE_NEURONU", neuron.id, impulse.synapseId, impulse, delta, impulse.hop);
      }

      if (neuron.activationLevel < neuron.threshold) continue;
      if (fired.has(neuron.id)) {
        for (const synapse of outgoing.get(neuron.id) ?? []) {
          if (queued.visitedSynapseIds.has(synapse.id)) {
            addTrace("POMINIĘCIE_CYKLU", neuron.id, synapse.id, null, 0, impulse.hop);
          }
        }
        continue;
      }
      fired.add(neuron.id);
      neuron.firingCount += 1;
      neuron.revision += 1;
      if (!emit("NEURON_FIRED", { neuronId: neuron.id, activationLevel: neuron.activationLevel })) {
        break;
      }
      addTrace(
        "ODPALENIE_NEURONU",
        neuron.id,
        impulse.synapseId,
        impulse,
        neuron.activationLevel,
        impulse.hop,
      );

      for (const synapse of outgoing.get(neuron.id) ?? []) {
        if (!synapse.enabled) continue;
        if (queued.visitedSynapseIds.has(synapse.id)) {
          addTrace("POMINIĘCIE_CYKLU", neuron.id, synapse.id, null, 0, impulse.hop);
          continue;
        }
        const nextHop = impulse.hop + 1;
        if (nextHop > request.maksymalnaLiczbaSkokow) {
          reachedHopLimit = true;
          continue;
        }
        const strength = impulse.strength * synapse.weight * synapse.confidence;
        if (Math.abs(strength) < request.minimalnaSila) {
          addTrace(
            "POMINIĘCIE_SŁABEGO_IMPULSU",
            synapse.targetNeuronId,
            synapse.id,
            null,
            strength,
            nextHop,
          );
          continue;
        }
        synapse.activationCount += 1;
        synapse.revision += 1;
        if (!emit("SYNAPSE_ACTIVATED", { synapseId: synapse.id, strength, hop: nextHop })) break;

        const nextImpulse: NeuralImpulse = {
          id: impulseId(),
          activationId: request.activationId,
          sourceNeuronId: synapse.sourceNeuronId,
          targetNeuronId: synapse.targetNeuronId,
          synapseId: synapse.id,
          strength,
          mode: synapse.mode,
          hop: nextHop,
          createdAt: timestamp(),
          deliveredAt: null,
        };
        if (
          !emit("IMPULSE_CREATED", { impulse: nextImpulse, delayMs: synapse.transmissionDelayMs })
        ) {
          break;
        }
        addTrace(
          "UTWORZENIE_IMPULSU",
          synapse.targetNeuronId,
          synapse.id,
          nextImpulse,
          strength,
          nextHop,
        );
        queue.push({
          impulse: nextImpulse,
          visitedSynapseIds: new Set([...queued.visitedSynapseIds, synapse.id]),
        });
      }
    }

    if (stopReason === "ZAKOŃCZONO" && reachedHopLimit) {
      stopReason = "OSIĄGNIĘTO_LIMIT_SKOKÓW";
    } else if (
      stopReason === "ZAKOŃCZONO" &&
      delivered.length === 0 &&
      trace.some((entry) => entry.type === "POMINIĘCIE_SŁABEGO_IMPULSU")
    ) {
      stopReason = "BRAK_AKTYWNYCH_IMPULSÓW";
    }

    return this.finish(
      request,
      activated,
      fired,
      delivered,
      inhibited,
      eventCount,
      stopReason,
      trace,
    );
  }

  private finish(
    request: ActivationRequest,
    activated: ReadonlySet<string>,
    fired: ReadonlySet<string>,
    delivered: readonly NeuralImpulse[],
    inhibited: ReadonlySet<string>,
    eventCount: number,
    stopReason: ActivationStopReason,
    trace: readonly ActivationTraceEntry[],
  ): ActivationResult {
    const completed = stopReason === "ZAKOŃCZONO" || stopReason === "BRAK_AKTYWNYCH_IMPULSÓW";
    const status = stopReason === "BŁĄD_RUNTIME" ? "BŁĄD" : completed ? "ZAKOŃCZONA" : "ZATRZYMANA";
    const eventType = completed ? "ACTIVATION_COMPLETED" : "ACTIVATION_STOPPED";
    this.ledger.append(eventType, request.activationId, {
      status,
      stopReason,
      activatedNeuronIds: [...activated],
      firedNeuronIds: [...fired],
    });
    eventCount += 1;
    return {
      activationId: request.activationId,
      status,
      activatedNeuronIds: [...activated],
      firedNeuronIds: [...fired],
      deliveredImpulses: structuredClone(delivered),
      inhibitedNeuronIds: [...inhibited],
      eventCount,
      stopReason,
      trace: structuredClone(trace),
    };
  }
}
