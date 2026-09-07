import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { compileSource } from "@neurosa/compiler";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { SqliteRuntimeRepository } from "@neurosa/storage";

function wymagaj(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Vertical slice nie przeszedł: ${message}`);
}

const sourcePath = resolve("examples/minimal-brain/brain.nsa");
const source = await readFile(sourcePath, "utf8");
const { ir } = compileSource(source, sourcePath);
const directory = await mkdtemp(join(tmpdir(), "neurosa-cp4-smoke-"));
const databasePath = join(directory, "brain.db");

try {
  const firstRuntime = new NeurosaRuntime(new SqliteRuntimeRepository(databasePath));
  const firstLoad = firstRuntime.load(ir);
  wymagaj(!firstLoad.restored, "pierwsze uruchomienie nie może udawać odtworzenia");
  const result = firstRuntime.activate({
    activationId: "checkpoint-4-smoke",
    seedNeuronIds: ["BrainArchitecture"],
    initialStrength: 1,
    maksymalnaLiczbaSkokow: 8,
    minimalnaSila: 0.01,
    limitZdarzen: 500,
    limitCzasuMs: 5_000,
    trybDeterministyczny: true,
  });
  const firstEventTypes = firstRuntime.listEvents().map((event) => event.eventType);
  wymagaj(result.firedNeuronIds.includes("BrainArchitecture"), "neuron startowy nie odpalił");
  wymagaj(
    result.deliveredImpulses.some(
      (impulse) =>
        impulse.sourceNeuronId === "BrainArchitecture" && impulse.targetNeuronId === "HydraLab",
    ),
    "brak rzeczywistego impulsu BrainArchitecture -> HydraLab",
  );
  wymagaj(firstEventTypes.includes("NEURON_FIRED"), "brak zdarzenia NEURON_FIRED");
  wymagaj(firstEventTypes.includes("IMPULSE_DELIVERED"), "brak zdarzenia IMPULSE_DELIVERED");
  wymagaj(firstEventTypes.includes("RUNTIME_STATE_SAVED"), "brak zdarzenia zapisu stanu");
  wymagaj(firstRuntime.verifyLedger().valid, "ledger jest niepoprawny przed restartem");
  firstRuntime.close();

  const secondRuntime = new NeurosaRuntime(new SqliteRuntimeRepository(databasePath));
  const secondLoad = secondRuntime.load(ir);
  wymagaj(secondLoad.restored, "stan nie został odtworzony po restarcie");
  wymagaj(
    secondRuntime.inspectActivation(result.activationId)?.activationId === result.activationId,
    "wynik aktywacji nie przeżył restartu",
  );
  wymagaj(secondRuntime.verifyLedger().valid, "ledger jest niepoprawny po restarcie");
  wymagaj(
    secondRuntime.listEvents().some((event) => event.eventType === "RUNTIME_STATE_RESTORED"),
    "brak zdarzenia odtworzenia stanu",
  );
  secondRuntime.close();

  console.log("Vertical slice Checkpointu 4: POPRAWNY");
  console.log(`Mózg: ${ir.brainId}`);
  console.log(`Aktywacja: ${result.activationId}`);
  console.log(`Dostarczone impulsy: ${String(result.deliveredImpulses.length)}`);
  console.log("Restart i weryfikacja ledgeru: POPRAWNE");
} finally {
  await rm(directory, { recursive: true, force: true });
}
