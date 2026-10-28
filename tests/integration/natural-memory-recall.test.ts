import { BrainApiServer } from "@neurosa/brain-api";
import { compileSource } from "@neurosa/compiler";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { SqliteRuntimeRepository } from "@neurosa/storage";

const TOKEN = "neurosa-cross-session-recall-test-token-123456";
const SOURCE = [
  "brain MemoryTestBrain {",
  "  region Memory {",
  "    neuron Source { type: concept threshold: 0.5 salience: 1 confidence: 1 }",
  "    neuron Recall { type: memory threshold: 0.4 salience: 1 confidence: 1 }",
  "    synapse Source -> Recall { relation: SUPPORTS mode: EXCITATORY weight: 0.8 confidence: 1 }",
  "  }",
  "}",
].join("\n");

type Json = Record<string, unknown>;

async function fixture() {
  const repository = new SqliteRuntimeRepository(":memory:");
  const runtime = new NeurosaRuntime(repository);
  runtime.load(compileSource(SOURCE, "memory-recall-test.nsa").ir);
  const server = new BrainApiServer(runtime, repository, {
    credentials: [
      {
        token: TOKEN,
        agentId: "osa-memory-test",
        scopes: ["brain:read", "memory:read", "memory:write"],
      },
    ],
    rateLimitPerMinute: 1000,
  });
  const { url } = await server.start();
  return { url, server, runtime };
}

async function api(url: string, path: string, body: Json) {
  const response = await fetch(url + "/api/v1/" + path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as Json };
}

describe("NeurOSA: cross-session recall from natural Polish questions", () => {
  it("recovers a real stored statement with a source reference without repeating its value", async () => {
    const { url, server, runtime } = await fixture();
    try {
      const secret = "FOKA-742-BURSZTYN";
      const statement = JSON.stringify({
        schema: "osa.memory_event.v1",
        kind: "AUTHENTICATED_USER_STATEMENT",
        data: {
          text: "Nazwa informacji: kod kontrolny OSA. Wartość: " + secret,
        },
      });
      const saved = await api(url, "brain/remember", {
        title: "Informacja przekazana przez użytkownika OSA",
        path: "osa/natural-memory-recall-test.md",
        content: statement,
        projectId: "osa-proof",
      });
      expect(saved.status).toBe(201);
      const id = (saved.data.document as Json).documentId;
      expect(typeof id).toBe("string");

      // Separate HTTP request, no chat transcript or secret in the query.
      const prompt = [
        "TEST NEUROSA — NIEZALEŻNY ODCZYT",
        "W poprzedniej rozmowie zapisałem w NeurOSA informację oznaczoną jako „kod kontrolny OSA”.",
        "Odzyskaj tę informację wyłącznie z pamięci NeurOSA.",
        "Jeżeli dostępny kontekst pamięci zawiera dokument źródłowy, podaj jego identyfikator.",
        "Nie zgaduj. Jeżeli nie masz danych źródłowych, odpowiedz BRAK DANYCH.",
      ].join("\n");
      expect(prompt).not.toContain(secret);
      const recall = await api(url, "brain/recall", {
        query: prompt,
        includeCore: true,
        limit: 10,
        maxChars: 12000,
      });
      expect(recall.status).toBe(200);
      expect(recall.data.ledgerValid).toBe(true);
      expect(String(recall.data.text)).toContain(secret);
      const references = recall.data.references as Json[];
      expect(references).toEqual(expect.arrayContaining([
        expect.objectContaining({
          documentId: id,
          revision: 1,
          sourceCurrent: true,
        }),
      ]));
      expect(String(references[0]?.contentHash)).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await server.close();
      runtime.close();
    }
  });

  it("does not fabricate a source for an unrelated question", async () => {
    const { url, server, runtime } = await fixture();
    try {
      const saved = await api(url, "brain/remember", {
        title: "Wpis prywatny",
        content: "kod kontrolny OSA: FOKA-742-BURSZTYN",
      });
      expect(saved.status).toBe(201);
      const answer = await api(url, "brain/recall", {
        query: "Jaka jest średnica egzoplanety Wega w roku 1871?",
        includeCore: true,
      });
      expect(answer.status).toBe(200);
      expect(answer.data.references).toEqual([]);
      expect(String(answer.data.text)).not.toContain("FOKA-742-BURSZTYN");
    } finally {
      await server.close();
      runtime.close();
    }
  });

  it("excludes a deleted statement from cross-session recall", async () => {
    const { url, server, runtime } = await fixture();
    try {
      const saved = await api(url, "brain/remember", {
        title: "Tymczasowy kod OSA",
        content: "Nazwa informacji: kod kontrolny OSA. Wartość: FOKA-742-BURSZTYN",
      });
      expect(saved.status).toBe(201);
      const id = (saved.data.document as Json).documentId as string;
      // Repo delete path uses the same canonical workspace and FTS index.
      const response = await fetch(url + "/api/v1/documents/" + id, {
        method: "DELETE",
        headers: {
          authorization: "Bearer " + TOKEN,
          "content-type": "application/json",
        },
      });
      expect(response.status).toBe(200);
      const recall = await api(url, "brain/recall", {
        query: "Odszukaj zapisany kod kontrolny OSA z poprzedniej rozmowy",
        includeCore: true,
      });
      expect(recall.status).toBe(200);
      expect(recall.data.references).toEqual([]);
    } finally {
      await server.close();
      runtime.close();
    }
  });
});
