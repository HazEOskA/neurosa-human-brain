"use client";

import {
  EMPTY_VISUAL_STATE,
  applyBrainEvent,
  createBrainScene,
  eventStreamUrl,
  mergeDynamicSynapses,
  parseSseFrames,
  type BrainEventView,
  type BrainNeuronView,
  type BrainSynapseView,
  type BrainVisualState,
  type SceneNeuron,
  type SceneSynapse,
} from "@neurosa/brain-visualization";
import { Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Mesh } from "three";

interface BrainStatus {
  readonly status: string;
  readonly version: string;
  readonly brainId: string;
  readonly sourceHash: string;
  readonly regions: number;
  readonly neurons: number;
  readonly synapses: number;
  readonly ledgerValid: boolean;
}

interface LedgerStatus {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

interface NeuronsResponse {
  readonly neurons: readonly BrainNeuronView[];
}

interface SynapsesResponse {
  readonly synapses: readonly BrainSynapseView[];
}

interface EventsResponse {
  readonly events: readonly BrainEventView[];
}

type ConnectionStatus = "rozłączono" | "łączenie" | "połączono" | "błąd";
type Selection =
  | { readonly kind: "neuron"; readonly id: string }
  | { readonly kind: "synapse"; readonly id: string };

function apiUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/u, "") + path;
}

async function apiJson<T>(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer " + token);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(apiUrl(baseUrl, path), {
    ...init,
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body.length > 0 ? body : "Brain API zwróciło kod " + String(response.status));
  }
  return (await response.json()) as T;
}

function reduceEvents(events: readonly BrainEventView[]): BrainVisualState {
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .reduce((state, event) => applyBrainEvent(state, event), EMPTY_VISUAL_STATE);
}

function eventCounts(events: readonly BrainEventView[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
  return counts;
}

function neuronColor(neuron: SceneNeuron, visualState: BrainVisualState): string {
  const effect = visualState.neuronEffects[neuron.id];
  if (effect?.inhibited === true) return "#7c72ff";
  if (effect?.fired === true) return "#ffd166";
  if ((effect?.intensity ?? neuron.activationLevel) > 0.15) return "#ffb454";
  return neuron.enabled ? "#63aeff" : "#485364";
}

function synapseColor(synapse: SceneSynapse, visualState: BrainVisualState): string {
  const active = visualState.synapseEffects[synapse.id];
  if (active !== undefined) return synapse.mode === "INHIBITORY" ? "#9a8cff" : "#ffb454";
  return synapse.mode === "INHIBITORY" ? "#554f87" : "#315f8f";
}

function AnimatedImpulse({
  source,
  target,
  strength,
  mode,
  delivered,
  eventTimestamp,
}: {
  readonly source: SceneNeuron;
  readonly target: SceneNeuron;
  readonly strength: number;
  readonly mode: "EXCITATORY" | "INHIBITORY";
  readonly delivered: boolean;
  readonly eventTimestamp: string;
}) {
  const meshRef = useRef<Mesh>(null);
  const startedAt = useRef<number | null>(null);
  const staleAtMount = useMemo(() => {
    const eventTime = Date.parse(eventTimestamp);
    return !Number.isFinite(eventTime) || Math.abs(Date.now() - eventTime) > 10_000;
  }, [eventTimestamp]);

  useEffect(() => {
    startedAt.current = staleAtMount ? -1 : performance.now();
  }, [eventTimestamp, staleAtMount]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;

    if (startedAt.current === null) startedAt.current = performance.now();
    if (startedAt.current < 0) {
      mesh.visible = false;
      return;
    }

    mesh.visible = true;
    const elapsed = performance.now() - startedAt.current;
    const durationMs = delivered ? 1_400 : 900;
    const normalized = Math.min(1, Math.max(0, elapsed / durationMs));
    const progress = delivered ? normalized : Math.min(0.72, normalized * 0.72);

    mesh.position.set(
      source.position[0] + (target.position[0] - source.position[0]) * progress,
      source.position[1] + (target.position[1] - source.position[1]) * progress,
      source.position[2] + (target.position[2] - source.position[2]) * progress,
    );

    const pulse = 1 + Math.sin(elapsed / 72) * 0.22;
    const size = (0.035 + strength * 0.035) * pulse;
    mesh.scale.setScalar(size);

    if (delivered && normalized >= 1) mesh.visible = false;
  });

  const color = mode === "INHIBITORY" ? "#9a8cff" : "#ffe29a";
  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 14, 14]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
}

function BrainModel({
  neurons,
  synapses,
  visualState,
  onSelect,
}: {
  readonly neurons: readonly BrainNeuronView[];
  readonly synapses: readonly BrainSynapseView[];
  readonly visualState: BrainVisualState;
  readonly onSelect: (selection: Selection | null) => void;
}) {
  const mergedSynapses = useMemo(
    () => mergeDynamicSynapses(synapses, visualState),
    [synapses, visualState],
  );
  const scene = useMemo(() => createBrainScene(neurons, mergedSynapses), [neurons, mergedSynapses]);
  const neuronById = useMemo(
    () => new Map(scene.neurons.map((neuron) => [neuron.id, neuron])),
    [scene.neurons],
  );

  return (
    <Canvas camera={{ position: [0, 0.4, 6.2], fov: 48 }} onPointerMissed={() => onSelect(null)}>
      <ambientLight intensity={0.5} />
      <pointLight position={[4, 5, 4]} intensity={12} />
      <pointLight position={[-4, -2, 2]} intensity={5} />

      {scene.synapses.map((synapse) => {
        const effect = visualState.synapseEffects[synapse.id];
        return (
          <Line
            key={synapse.id}
            points={[
              [synapse.source[0], synapse.source[1], synapse.source[2]],
              [synapse.target[0], synapse.target[1], synapse.target[2]],
            ]}
            color={synapseColor(synapse, visualState)}
            lineWidth={effect === undefined ? 0.7 : 1.8 + effect.intensity * 2}
            transparent
            opacity={synapse.enabled ? 0.72 : 0.2}
            onClick={() => onSelect({ kind: "synapse", id: synapse.id })}
          />
        );
      })}

      {scene.neurons.map((neuron) => {
        const effect = visualState.neuronEffects[neuron.id];
        const intensity = effect?.intensity ?? neuron.activationLevel;
        const color = neuronColor(neuron, visualState);
        return (
          <mesh
            key={neuron.id}
            position={[neuron.position[0], neuron.position[1], neuron.position[2]]}
            scale={0.11 + Math.min(0.13, intensity * 0.1 + neuron.salience * 0.035)}
            onClick={(event) => {
              event.stopPropagation();
              onSelect({ kind: "neuron", id: neuron.id });
            }}
          >
            <sphereGeometry args={[1, 18, 18]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={0.2 + intensity * 2.4}
              roughness={0.38}
            />
          </mesh>
        );
      })}

      {Object.values(visualState.impulses).map((impulse) => {
        const source = neuronById.get(impulse.sourceNeuronId);
        const target = neuronById.get(impulse.targetNeuronId);
        if (source === undefined || target === undefined) return null;
        return (
          <AnimatedImpulse
            key={impulse.impulseId + ":" + String(impulse.sequence)}
            source={source}
            target={target}
            strength={impulse.strength}
            mode={impulse.mode}
            delivered={impulse.delivered}
            eventTimestamp={impulse.eventTimestamp}
          />
        );
      })}

      <OrbitControls enableDamping dampingFactor={0.08} minDistance={2.5} maxDistance={12} />
    </Canvas>
  );
}

export function LivingBrainWorkspace() {
  const [apiBaseUrl, setApiBaseUrl] = useState("http://127.0.0.1:8644");
  const [token, setToken] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("rozłączono");
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [ledger, setLedger] = useState<LedgerStatus | null>(null);
  const [neurons, setNeurons] = useState<readonly BrainNeuronView[]>([]);
  const [synapses, setSynapses] = useState<readonly BrainSynapseView[]>([]);
  const [visualState, setVisualState] = useState<BrainVisualState>(EMPTY_VISUAL_STATE);
  const [counts, setCounts] = useState<Readonly<Record<string, number>>>({});
  const [lastEvent, setLastEvent] = useState<BrainEventView | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [message, setMessage] = useState("Nie połączono z lokalnym Brain API.");
  const [runningTest, setRunningTest] = useState(false);
  const streamAbort = useRef<AbortController | null>(null);

  const mergedSynapses = useMemo(
    () => mergeDynamicSynapses(synapses, visualState),
    [synapses, visualState],
  );
  const selectedNeuron =
    selection?.kind === "neuron" ? neurons.find((entry) => entry.id === selection.id) : undefined;
  const selectedSynapse =
    selection?.kind === "synapse"
      ? mergedSynapses.find((entry) => entry.id === selection.id)
      : undefined;

  const applyStreamEvent = useCallback((event: BrainEventView) => {
    setVisualState((previous) => applyBrainEvent(previous, event));
    setLastEvent(event);
    setCounts((previous) => ({
      ...previous,
      [event.eventType]: (previous[event.eventType] ?? 0) + 1,
    }));
  }, []);

  const startStream = useCallback(
    async (baseUrl: string, accessToken: string, afterSequence: number, signal: AbortSignal) => {
      try {
        const response = await fetch(eventStreamUrl(baseUrl, afterSequence), {
          headers: { authorization: "Bearer " + accessToken },
          cache: "no-store",
          signal,
        });
        if (!response.ok || response.body === null) {
          throw new Error("Nie udało się otworzyć strumienia zdarzeń Brain API.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let rest = "";
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          rest += decoder.decode(chunk.value, { stream: true });
          const parsed = parseSseFrames(rest);
          rest = parsed.rest;
          for (const event of parsed.events) applyStreamEvent(event);
        }
      } catch (error: unknown) {
        if (signal.aborted) return;
        setConnectionStatus("błąd");
        setMessage(error instanceof Error ? error.message : "Błąd strumienia zdarzeń.");
      }
    },
    [applyStreamEvent],
  );

  const disconnect = useCallback(() => {
    streamAbort.current?.abort();
    streamAbort.current = null;
    setConnectionStatus("rozłączono");
    setMessage(
      "Rozłączono. Wizualizacja pozostaje ostatnim prawdziwym stanem pobranym z runtime’u.",
    );
  }, []);

  const connect = useCallback(async () => {
    streamAbort.current?.abort();
    setConnectionStatus("łączenie");
    setMessage("Pobieram rzeczywisty stan runtime’u, neurony, synapsy i ledger…");

    try {
      const [brainStatus, neuronData, synapseData, ledgerData, eventData] = await Promise.all([
        apiJson<BrainStatus>(apiBaseUrl, token, "/api/v1/brain/status"),
        apiJson<NeuronsResponse>(apiBaseUrl, token, "/api/v1/brain/neurons"),
        apiJson<SynapsesResponse>(apiBaseUrl, token, "/api/v1/brain/synapses"),
        apiJson<LedgerStatus>(apiBaseUrl, token, "/api/v1/brain/ledger/verify"),
        apiJson<EventsResponse>(apiBaseUrl, token, "/api/v1/brain/events?afterSequence=0"),
      ]);

      const orderedEvents = [...eventData.events].sort(
        (left, right) => left.sequence - right.sequence,
      );
      setStatus(brainStatus);
      setLedger(ledgerData);
      setNeurons(neuronData.neurons);
      setSynapses(synapseData.synapses);
      setVisualState(reduceEvents(orderedEvents));
      setCounts(eventCounts(orderedEvents));
      setLastEvent(orderedEvents.at(-1) ?? null);
      setSelection(null);
      setConnectionStatus("połączono");
      setMessage(
        "Połączono z canonical brainId " +
          brainStatus.brainId +
          ". Światło i impulsy pochodzą wyłącznie z eventów runtime’u. Przelot jest renderowany jako czytelne zwolnione tempo wizualne realnego eventu.",
      );

      const controller = new AbortController();
      streamAbort.current = controller;
      const afterSequence = orderedEvents.at(-1)?.sequence ?? 0;
      void startStream(apiBaseUrl, token, afterSequence, controller.signal);
    } catch (error: unknown) {
      setConnectionStatus("błąd");
      setMessage(error instanceof Error ? error.message : "Nie udało się połączyć z Brain API.");
    }
  }, [apiBaseUrl, startStream, token]);

  const runBrainTest = useCallback(async () => {
    const seed = neurons.find((neuron) => neuron.enabled);
    if (seed === undefined) {
      setMessage("Brak aktywnego neuronu startowego do testu.");
      return;
    }

    setRunningTest(true);
    try {
      await apiJson<unknown>(apiBaseUrl, token, "/api/v1/brain/activate", {
        method: "POST",
        body: JSON.stringify({
          seedNeuronIds: [seed.id],
          initialStrength: 1,
          maksymalnaLiczbaSkokow: 8,
          minimalnaSila: 0.01,
          limitZdarzen: 500,
          limitCzasuMs: 5000,
          trybDeterministyczny: true,
        }),
      });
      const [brainStatus, neuronData, synapseData, ledgerData] = await Promise.all([
        apiJson<BrainStatus>(apiBaseUrl, token, "/api/v1/brain/status"),
        apiJson<NeuronsResponse>(apiBaseUrl, token, "/api/v1/brain/neurons"),
        apiJson<SynapsesResponse>(apiBaseUrl, token, "/api/v1/brain/synapses"),
        apiJson<LedgerStatus>(apiBaseUrl, token, "/api/v1/brain/ledger/verify"),
      ]);
      setStatus(brainStatus);
      setNeurons(neuronData.neurons);
      setSynapses(synapseData.synapses);
      setLedger(ledgerData);
      setMessage("Test mózgu wykonany na neuronie „" + seed.id + "”. Czekam na eventy SSE.");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Test mózgu nie powiódł się.");
    } finally {
      setRunningTest(false);
    }
  }, [apiBaseUrl, neurons, token]);

  useEffect(
    () => () => {
      streamAbort.current?.abort();
    },
    [],
  );

  const topCounts = Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);

  return (
    <main className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">NEUROSA-HB / LIVE EVENT PROJECTION</p>
          <h1>Żywy mózg agentów</h1>
        </div>
        <div className={"connection " + connectionStatus}>
          <span />
          {connectionStatus}
        </div>
      </header>

      <section className="connection-panel panel">
        <label>
          Adres lokalnego API
          <input
            value={apiBaseUrl}
            onChange={(event) => setApiBaseUrl(event.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          Token lokalny
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
          />
        </label>
        <button
          className="accent"
          disabled={connectionStatus === "łączenie" || token.length === 0}
          onClick={() => void connect()}
        >
          Połącz
        </button>
        <button
          className="secondary"
          disabled={connectionStatus === "rozłączono"}
          onClick={disconnect}
        >
          Rozłącz
        </button>
        <button
          disabled={connectionStatus !== "połączono" || runningTest}
          onClick={() => void runBrainTest()}
        >
          {runningTest ? "Uruchamiam…" : "Uruchom test mózgu"}
        </button>
      </section>

      <section className="brain-stage panel">
        <div className="stage-heading">
          <div>
            <p className="eyebrow">Model przestrzenny</p>
            <h2>Neurony, synapsy i rzeczywiste impulsy</h2>
          </div>
          <div className="metrics">
            <span>regiony {status?.regions ?? 0}</span>
            <span>neurony {neurons.length}</span>
            <span>synapsy {mergedSynapses.length}</span>
            <span>sekwencja {visualState.lastSequence}</span>
          </div>
        </div>
        <div className="canvas-shell">
          <BrainModel
            neurons={neurons}
            synapses={synapses}
            visualState={visualState}
            onSelect={setSelection}
          />
          {neurons.length === 0 ? (
            <div className="empty-state">
              <strong>Model czeka na stan runtime’u</strong>
              <span>Połącz Brain API. Interfejs nie generuje fikcyjnych neuronów ani eventów.</span>
            </div>
          ) : null}
        </div>
      </section>

      <aside className="inspector panel">
        <p className="eyebrow">Inspektor</p>
        <h2>
          {selectedNeuron?.id ??
            selectedSynapse?.id ??
            status?.brainId ??
            "Wybierz neuron lub synapsę"}
        </h2>

        {selectedNeuron !== undefined ? (
          <dl>
            <div>
              <dt>typ</dt>
              <dd>neuron</dd>
            </div>
            <div>
              <dt>region</dt>
              <dd>{selectedNeuron.regionId}</dd>
            </div>
            <div>
              <dt>aktywacja</dt>
              <dd>{selectedNeuron.activationLevel.toFixed(3)}</dd>
            </div>
            <div>
              <dt>próg</dt>
              <dd>{selectedNeuron.threshold.toFixed(3)}</dd>
            </div>
            <div>
              <dt>salience</dt>
              <dd>{selectedNeuron.salience.toFixed(3)}</dd>
            </div>
            <div>
              <dt>confidence</dt>
              <dd>{selectedNeuron.confidence.toFixed(3)}</dd>
            </div>
            <div>
              <dt>odpalenia</dt>
              <dd>{selectedNeuron.firingCount ?? 0}</dd>
            </div>
          </dl>
        ) : selectedSynapse !== undefined ? (
          <dl>
            <div>
              <dt>typ</dt>
              <dd>synapsa {selectedSynapse.mode.toLowerCase()}</dd>
            </div>
            <div>
              <dt>źródło</dt>
              <dd>{selectedSynapse.sourceNeuronId}</dd>
            </div>
            <div>
              <dt>cel</dt>
              <dd>{selectedSynapse.targetNeuronId}</dd>
            </div>
            <div>
              <dt>waga</dt>
              <dd>{selectedSynapse.weight.toFixed(3)}</dd>
            </div>
            <div>
              <dt>confidence</dt>
              <dd>{selectedSynapse.confidence.toFixed(3)}</dd>
            </div>
            <div>
              <dt>aktywacje</dt>
              <dd>{selectedSynapse.activationCount ?? 0}</dd>
            </div>
          </dl>
        ) : (
          <>
            <p>
              Stan runtime’u jest projekcją danych z Brain API. Kliknij element modelu, aby zobaczyć
              szczegóły.
            </p>
            <dl>
              <div>
                <dt>brainId</dt>
                <dd>{status?.brainId ?? "UNKNOWN"}</dd>
              </div>
              <div>
                <dt>status</dt>
                <dd>{status?.status ?? "UNKNOWN"}</dd>
              </div>
              <div>
                <dt>ledger</dt>
                <dd>
                  {ledger?.valid === true
                    ? "Ledger poprawny"
                    : ledger === null
                      ? "UNKNOWN"
                      : "BŁĄD"}
                </dd>
              </div>
              <div>
                <dt>ostatni event</dt>
                <dd>{lastEvent?.eventType ?? "brak"}</dd>
              </div>
            </dl>
          </>
        )}
      </aside>

      <footer className="event-bar panel">
        <div>
          <p className="eyebrow">Stan runtime’u</p>
          <strong>{message}</strong>
        </div>
        <div className="event-counts">
          <span>{ledger?.valid === true ? "Ledger poprawny" : "Ledger UNKNOWN / BŁĄD"}</span>
          {topCounts.map(([eventType, count]) => (
            <span key={eventType}>
              {eventType} {count}
            </span>
          ))}
        </div>
      </footer>
    </main>
  );
}
