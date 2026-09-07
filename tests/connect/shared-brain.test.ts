import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainApiServer } from "@neurosa/brain-api";
import { compileSource } from "@neurosa/compiler";
import { NeurosaConnect, CONNECT_PROVIDERS } from "@neurosa/connect";
import { SharedKnowledge } from "@neurosa/workspace/knowledge";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { SqliteRuntimeRepository } from "@neurosa/storage";
import type { MemoryWrite } from "@neurosa/document-domain";

const ir = compileSource(
  "brain Shared { region R { neuron N { threshold: 0.5 } } }",
  "shared.nsa",
).ir;
const token = (name: string) => `neurosa-test-token-for-${name}-123456789`;
async function fixture(path = ":memory:") {
  const repository = new SqliteRuntimeRepository(path);
  const runtime = new NeurosaRuntime(repository);
  runtime.load(ir);
  const server = new BrainApiServer(runtime, repository, {
    credentials: [
      ...CONNECT_PROVIDERS.map((provider) => ({
        agentId: provider,
        token: token(provider),
        scopes: ["brain:read", "memory:read", "memory:write", "events:read"] as const,
      })),
      { agentId: "reader", token: token("reader"), scopes: ["brain:read", "memory:read"] },
    ],
    rateLimitPerMinute: 10000,
  });
  const { url } = await server.start();
  const client = (provider: string, brainId = "Shared") =>
    new NeurosaConnect({ baseUrl: url, token: token(provider), brainId, provider });
  return {
    repository,
    runtime,
    server,
    url,
    client,
    knowledge: new SharedKnowledge(repository, "Shared"),
    close: async () => {
      await server.close();
      runtime.close();
    },
  };
}
const fact: MemoryWrite = {
  title: "Projekt NeurOSA",
  content: "NeurOSA używa jednego canonical store",
  factKey: "architecture",
  kind: "decision",
  projectId: "osa",
};

describe("wspólny mózg i trwały cykl sesji", () => {
  it.each(CONNECT_PROVIDERS)("bootstrap → praca → zapis dla %s", async (provider) => {
    const f = await fixture();
    try {
      const result = await f.client(provider).runSession("osa", "NeurOSA", (context) => {
        expect(context.brainId).toBe("Shared");
        expect(context.ledgerValid).toBe(true);
        return Promise.resolve({ result: "gotowe", memories: [fact] });
      });
      expect(result).toBe("gotowe");
      expect(f.repository.listDocuments()).toHaveLength(1);
      expect(f.runtime.listEvents().map((e) => e.eventType)).toContain("SESSION_COMPLETED");
      expect(f.runtime.verifyLedger().valid).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("Claude pobiera decyzję ChatGPT po restarcie API i SQLite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neurosa-connect-"));
    const db = join(dir, "brain.db");
    const first = await fixture(db);
    try {
      const session = await first
        .client("chatgpt")
        .startSession("osa", "NeurOSA", "restart-session");
      await session.complete([fact]);
    } finally {
      await first.close();
    }
    const second = await fixture(db);
    try {
      const session = await second.client("claude").startSession("osa", "canonical");
      expect(session.context.text).toContain("jednego canonical store");
      expect(second.repository.getSession("restart-session")?.status).toBe("COMPLETED");
      expect(second.runtime.verifyLedger().valid).toBe(true);
    } finally {
      await second.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("idempotencja przeżywa restart i odrzuca zmianę wejścia", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neurosa-retry-"));
    const db = join(dir, "brain.db");
    const first = await fixture(db);
    try {
      await first.client("osa").remember({ ...fact, idempotencyKey: "retry" });
    } finally {
      await first.close();
    }
    const second = await fixture(db);
    try {
      const before = second.runtime.listEvents().length;
      await second.client("osa").remember({ ...fact, idempotencyKey: "retry" });
      expect(second.runtime.listEvents()).toHaveLength(before);
      await expect(
        second.client("osa").remember({ ...fact, content: "inna", idempotencyKey: "retry" }),
      ).rejects.toMatchObject({ status: 409 });
      expect(second.repository.listDocuments()).toHaveLength(1);
    } finally {
      await second.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("dwa równoczesne modele: jeden zapis wygrywa, konflikt nie nadpisuje", async () => {
    const f = await fixture();
    try {
      await f.client("osa").remember(fact);
      const results = await Promise.allSettled([
        f.client("claude").remember({ ...fact, content: "wersja Claude", expectedRevision: 1 }),
        f.client("grok").remember({ ...fact, content: "wersja Grok", expectedRevision: 1 }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const doc = f.repository.listDocuments()[0]!;
      expect(doc.revision).toBe(2);
      await f
        .client("gemini")
        .remember({ ...fact, content: "jawne rozstrzygnięcie", expectedRevision: 2 });
      expect(f.repository.listDocumentRevisions(doc.documentId).map((r) => r.revision)).toEqual([
        1, 2, 3,
      ]);
    } finally {
      await f.close();
    }
  });
  it("pełny rollback wyników sesji przy konflikcie drugiej pozycji", async () => {
    const f = await fixture();
    try {
      await f.client("osa").remember(fact);
      const s = await f.client("claude").startSession("osa", "NeurOSA", "rollback");
      const events = f.runtime.listEvents().length;
      await expect(
        s.complete([
          { title: "Nowy", content: "nowe dane" },
          { ...fact, content: "konflikt" },
        ]),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.repository.listDocuments()).toHaveLength(1);
      expect(f.runtime.listEvents()).toHaveLength(events);
      expect(f.repository.getSession("rollback")?.status).toBe("OPEN");
    } finally {
      await f.close();
    }
  });
  it("sesja innego agenta i klient bez scope nie zapisują", async () => {
    const f = await fixture();
    try {
      await f.client("osa").startSession("osa", "NeurOSA", "owner");
      await expect(f.client("claude").complete("owner", [fact])).rejects.toMatchObject({
        status: 409,
      });
      await expect(f.client("reader").remember(fact)).rejects.toMatchObject({ status: 403 });
      expect(f.repository.listDocuments()).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("zamknięcie jest idempotentne, a praca w zamkniętej sesji zablokowana", async () => {
    const f = await fixture();
    try {
      const s = await f.client("osa").startSession("osa", "NeurOSA", "close");
      await s.complete([fact]);
      const count = f.runtime.listEvents().length;
      await s.complete([fact]);
      expect(f.runtime.listEvents()).toHaveLength(count);
      await expect(s.complete([])).rejects.toMatchObject({ status: 409 });
      await expect(s.remember({ ...fact, idempotencyKey: "later" })).rejects.toMatchObject({
        status: 409,
      });
      await expect(f.client("osa").startSession("osa", "NeurOSA", "close")).rejects.toThrow(
        "zakończona",
      );
    } finally {
      await f.close();
    }
  });
  it("core + retrieval mieści się w budżecie i jest świeży w kolejnej sesji", async () => {
    const f = await fixture();
    try {
      await f
        .client("osa")
        .remember({ title: "Zasady", content: "Polski język odpowiedzi", pinned: true });
      await f.client("osa").remember({ ...fact, content: "NeurOSA " + "pamięć ".repeat(5000) });
      const context = await f.client("claude").recall("NeurOSA", 1024);
      expect(context.text.length).toBeLessThanOrEqual(1024);
      expect(context.text).toContain("Polski język");
      expect(context.truncated).toBe(true);
      expect(context.references.length).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  });
  it("błędny brainId blokuje bootstrap przed stworzeniem sesji", async () => {
    const f = await fixture();
    try {
      await expect(
        f.client("osa", "InnyMozg").startSession("osa", "NeurOSA", "wrong"),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.repository.getSession("wrong")).toBeNull();
    } finally {
      await f.close();
    }
  });
  it("błąd pracy nie oznacza fikcyjnego ukończenia", async () => {
    const f = await fixture();
    try {
      await expect(
        f
          .client("osa")
          .runSession("osa", "NeurOSA", () => Promise.reject(new Error("awaria")), "failed"),
      ).rejects.toThrow("awaria");
      expect(f.repository.getSession("failed")?.status).toBe("OPEN");
    } finally {
      await f.close();
    }
  });
  it("zdarzenia zapisów docierają do SSE i można je wznowić", async () => {
    const f = await fixture();
    const controller = new AbortController();
    try {
      const before = f.runtime.listEvents().at(-1)!.sequence;
      await f.client("osa").remember(fact);
      const response = await fetch(`${f.url}/api/v1/brain/events/stream?afterSequence=${before}`, {
        headers: { authorization: `Bearer ${token("osa")}` },
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      let text = "";
      while (!text.includes("MEMORY_WRITTEN")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain("MEMORY_WRITTEN");
      expect(text).not.toContain("event: BRAIN_LOADED");
      await reader.cancel();
    } finally {
      controller.abort();
      await f.close();
    }
  });
});
