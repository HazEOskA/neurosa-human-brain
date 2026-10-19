import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainApiServer } from "@neurosa/brain-api";
import { compileSource } from "@neurosa/compiler";
import { NeurosaConnect } from "@neurosa/connect";
import { NeurosaIngest, parseConversationExport } from "@neurosa/ingest";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { SqliteRuntimeRepository } from "@neurosa/storage";

const ir = compileSource(
  "brain E2E { region Memory { neuron Initial { threshold: 0.5 } } }",
  "brain-import-e2e.nsa",
).ir;
const writerToken = "neurosa-e2e-writer-token-123456789";
const readerToken = "neurosa-e2e-reader-token-123456789";

async function openBrain(path: string) {
  const repository = new SqliteRuntimeRepository(path);
  const runtime = new NeurosaRuntime(repository);
  runtime.load(ir);
  const server = new BrainApiServer(runtime, repository, {
    credentials: [
      {
        agentId: "importer",
        token: writerToken,
        scopes: ["brain:read", "memory:write", "memory:read", "events:read"],
      },
      {
        agentId: "reader",
        token: readerToken,
        scopes: ["brain:read", "memory:read"],
      },
    ],
    rateLimitPerMinute: 10000,
  });
  const { url } = await server.start();
  const importer = new NeurosaConnect({
    baseUrl: url,
    brainId: "E2E",
    token: writerToken,
    provider: "chatgpt",
  });
  const reader = new NeurosaConnect({
    baseUrl: url,
    brainId: "E2E",
    token: readerToken,
    provider: "claude",
  });
  return {
    repository,
    runtime,
    importer,
    reader,
    url,
    close: async () => {
      await server.close();
      runtime.close();
    },
  };
}

const conversations = [
  {
    id: "first-conversation",
    title: "Architektura",
    mapping: {
      root: { message: null },
      messageA: {
        parent: "root",
        message: {
          author: { role: "user" },
          content: { parts: ["Weryfikujemy pamięć kontekstową NeurOSA"] },
        },
      },
      messageB: {
        parent: "messageA",
        message: {
          author: { role: "assistant" },
          content: { parts: ["Powiązanie z projektem OSA Proof"] },
        },
      },
      messageC: {
        parent: "messageA",
        message: {
          author: { role: "assistant" },
          content: { parts: ["Alternatywna gałąź informacji"] },
        },
      },
    },
  },
  {
    id: "second-conversation",
    title: "Dostęp",
    messages: [
      { id: "one", role: "user", content: "Wymagana autoryzacja i zapis SQLite" },
      { id: "two", role: "assistant", content: "Dostęp tylko w obrębie Brain API" },
    ],
  },
];

describe("Context Bridge — prawdziwy lokalny import, restart i granice grafu", () => {
  it("zapisuje wszystkie rozmowy z provenance, odczytuje je po restarcie i nie udaje projekcji neuronowej", async () => {
    const directory = await mkdtemp(join(tmpdir(), "neurosa-context-e2e-"));
    const databasePath = join(directory, "brain.db");
    try {
      const normalized = parseConversationExport(conversations, "chatgpt");
      expect(normalized).toHaveLength(2);
      expect(normalized[0]?.content).toContain("Alternatywna gałąź informacji");
      expect(normalized[0]?.content).toContain("rodzic: messageA");

      const before = await openBrain(databasePath);
      let sourceRevisions: number[] = [];
      try {
        const neuronsBefore = before.runtime.getNeuronStates().length;
        const synapsesBefore = before.runtime.getSynapseStates().length;
        const ingest = new NeurosaIngest(before.importer, "osa");
        const accepted = await ingest.conversations(conversations, "chatgpt");
        expect(accepted).toHaveLength(2);
        expect(before.repository.listDocuments()).toHaveLength(2);
        sourceRevisions = before.repository.listDocuments().map((doc) => doc.revision);
        expect(sourceRevisions).toEqual([1, 1]);

        const recalled = await before.reader.recall("Alternatywna");
        expect(recalled.text).toContain("Alternatywna gałąź informacji");
        expect(recalled.ledgerValid).toBe(true);

        // Source documents are persisted. The current ingest path does not
        // compile a new .nsa graph nor create runtime neurons/synapses.
        expect(before.runtime.getNeuronStates()).toHaveLength(neuronsBefore);
        expect(before.runtime.getSynapseStates()).toHaveLength(synapsesBefore);

        await ingest.conversations(conversations, "chatgpt");
        expect(before.repository.listDocuments()).toHaveLength(2);
        expect(before.repository.listDocuments().map((doc) => doc.revision)).toEqual(
          sourceRevisions,
        );
        expect(before.runtime.verifyLedger().valid).toBe(true);
      } finally {
        await before.close();
      }

      const restored = await openBrain(databasePath);
      try {
        expect(restored.repository.listDocuments()).toHaveLength(2);
        expect(restored.repository.listDocuments().map((doc) => doc.revision)).toEqual(
          sourceRevisions,
        );
        const recalled = await restored.reader.recall("Alternatywna");
        expect(recalled.text).toContain("Alternatywna gałąź informacji");
        expect(recalled.ledgerValid).toBe(true);

        const denial = await fetch(restored.url + "/api/v1/brain/observe", {
          method: "POST",
          headers: {
            authorization: "Bearer " + readerToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({ title: "DENIED", content: "no write" }),
        });
        expect(denial.status).toBe(403);
        expect(restored.repository.listDocuments()).toHaveLength(2);
      } finally {
        await restored.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
