import { BrainApiServer } from "@neurosa/brain-api";
import { compileSource } from "@neurosa/compiler";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { SqliteRuntimeRepository } from "@neurosa/storage";

const TOKEN = "neurosa-revision-replay-test-token-123456789";
const SOURCE = [
  "brain ReplayBrain {",
  "  region Memory {",
  "    neuron Source { type: concept threshold: 0.5 salience: 1 confidence: 1 }",
  "    neuron Decision { type: memory threshold: 0.4 salience: 1 confidence: 1 }",
  "    synapse Source -> Decision { relation: SUPPORTS mode: EXCITATORY weight: 0.8 confidence: 1 }",
  "  }",
  "}",
].join("\n");

type Json = Record<string, unknown>;

async function fixture() {
  const repository = new SqliteRuntimeRepository(":memory:");
  const runtime = new NeurosaRuntime(repository);
  runtime.load(compileSource(SOURCE, "replay-audit.nsa").ir);
  const server = new BrainApiServer(runtime, repository, {
    credentials: [
      {
        token: TOKEN,
        agentId: "replay-auditor",
        scopes: ["brain:read", "brain:activate", "memory:read", "memory:write"],
      },
    ],
    rateLimitPerMinute: 10000,
  });
  const { url } = await server.start();
  return { url, repository, runtime, server };
}

async function withBrain(work: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const value = await fixture();
  try {
    await work(value);
  } finally {
    await value.server.close();
    value.runtime.close();
  }
}

async function api(url: string, path: string, method = "GET", body?: Json) {
  const response = await fetch(url + "/api/v1/" + path, {
    method,
    headers: {
      authorization: "Bearer " + TOKEN,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: (await response.json()) as Json };
}

async function makeDocument(url: string) {
  const created = await api(url, "documents", "POST", {
    title: "Replay provenance",
    path: "test/replay-provenance.md",
    content: "replayprobe: original decision r1",
  });
  expect(created.status).toBe(201);
  expect(created.data.revision).toBe(1);
  return created.data;
}

async function recall(url: string, additional: Json = {}) {
  const response = await api(url, "brain/recall", "POST", {
    query: "replayprobe",
    includeCore: true,
    ...additional,
  });
  expect(response.status).toBe(200);
  return response.data;
}

function reference(result: Json, documentId: string): Json {
  const references = result.references as Json[];
  expect(Array.isArray(references)).toBe(true);
  const matched = references.find((entry) => entry.documentId === documentId);
  expect(matched).toBeDefined();
  return matched!;
}

async function updateToR2(url: string, documentId: string) {
  const updated = await api(url, "documents/" + documentId, "PATCH", {
    content: "replayprobe: superseding decision r2",
    expectedRevision: 1,
  });
  expect(updated.status).toBe(200);
  expect(updated.data.revision).toBe(2);
  return updated.data;
}

describe("RECALL_REVISION_REPLAY — prowadzony dowodami kontrakt r1 → r2", () => {
  it("BASELINE PASS: odzyskuje rewizje, hashe i niezmienne snapshoty", async () => {
    await withBrain(async ({ url, repository }) => {
      const original = await makeDocument(url);
      const id = original.documentId as string;
      const r1 = await recall(url);
      expect(r1.ledgerValid).toBe(true);
      expect(reference(r1, id)).toMatchObject({
        documentId: id,
        revision: 1,
        contentHash: original.contentHash,
      });

      const updated = await updateToR2(url, id);
      const r2 = await recall(url);
      expect(r2.ledgerValid).toBe(true);
      expect(reference(r2, id)).toMatchObject({
        documentId: id,
        revision: 2,
        contentHash: updated.contentHash,
      });
      expect(updated.contentHash).not.toBe(original.contentHash);

      const revisions = repository.listDocumentRevisions(id);
      expect(revisions.map((entry) => entry.revision)).toEqual([1, 2]);
      expect(revisions.map((entry) => entry.snapshot.content)).toEqual([
        "replayprobe: original decision r1",
        "replayprobe: superseding decision r2",
      ]);

      const ledger = await api(url, "brain/ledger/verify");
      expect(ledger.status).toBe(200);
      expect(ledger.data.valid).toBe(true);
    });
  });

  it("CONTRACT RED: historyczny recall jest przypięty do r1", async () => {
    await withBrain(async ({ url }) => {
      const original = await makeDocument(url);
      const id = original.documentId as string;
      await updateToR2(url, id);

      const historical = await recall(url, {
        sourceRevision: { documentId: id, revision: 1 },
      });
      const pinned = reference(historical, id);
      expect(pinned.revision).toBe(1);
      expect(pinned.contentHash).toBe(original.contentHash);
      expect(pinned.sourceCurrent).toBe(false);
    });
  });

  it("CONTRACT RED: aktywacja wiąże rewizję z irHash", async () => {
    await withBrain(async ({ url }) => {
      const original = await makeDocument(url);
      const id = original.documentId as string;
      const activationId = "replay-a1";
      const executed = await api(url, "brain/activate", "POST", {
        activationId,
        seedNeuronIds: ["Source"],
        trybDeterministyczny: true,
        sourceRevision: { documentId: id, revision: 1 },
      });
      expect(executed.status).toBe(200);
      expect(executed.data.firedNeuronIds).toContain("Decision");

      const stored = await api(url, "brain/activations/" + activationId);
      expect(stored.status).toBe(200);
      expect(stored.data).toHaveProperty("provenance.documentId", id);
      expect(stored.data).toHaveProperty("provenance.documentRevision", 1);
      expect(stored.data).toHaveProperty("provenance.documentHash", original.contentHash);
      expect(stored.data).toHaveProperty(
        "provenance.irHash",
        expect.stringMatching(/^[a-f0-9]{64}$/u),
      );
    });
  });

  it("CONTRACT RED: activationId nie nadpisuje wyniku", async () => {
    await withBrain(async ({ url }) => {
      const activationId = "replay-immutable-a1";
      const first = await api(url, "brain/activate", "POST", {
        activationId,
        seedNeuronIds: ["Source"],
        initialStrength: 1,
      });
      expect(first.status).toBe(200);
      expect(first.data.firedNeuronIds).toContain("Decision");

      const duplicate = await api(url, "brain/activate", "POST", {
        activationId,
        seedNeuronIds: ["Source"],
        initialStrength: 0.01,
      });
      expect(duplicate.status).toBe(409);

      const stored = await api(url, "brain/activations/" + activationId);
      expect(stored.data).toEqual(first.data);
    });
  });
});
