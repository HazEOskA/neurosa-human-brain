import { BrainApiServer } from "@neurosa/brain-api";
import { compileSource } from "@neurosa/compiler";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { SqliteRuntimeRepository } from "@neurosa/storage";

const ADMIN_TOKEN = "lokalny-token-administratora-123456";
const READ_TOKEN = "lokalny-token-tylko-odczyt-12345";

const source = `brain ApiBrain {
  region Test {
    neuron Start {
      threshold: 0.5
      salience: 1
      confidence: 1
    }

    neuron Cel {
      threshold: 0.5
      salience: 1
      confidence: 1
    }

    synapse Start -> Cel {
      mode: EXCITATORY
      weight: 1
      confidence: 1
    }
  }
}
`;

interface ApiFixture {
  readonly server: BrainApiServer;
  readonly runtime: NeurosaRuntime;
  readonly url: string;
}

async function fixture(
  options: { rateLimitPerMinute?: number; maxBodyBytes?: number } = {},
): Promise<ApiFixture> {
  const repository = new SqliteRuntimeRepository(":memory:");
  const runtime = new NeurosaRuntime(repository);
  runtime.load(compileSource(source, "api-test.nsa").ir);
  const server = new BrainApiServer(runtime, repository, {
    credentials: [
      { token: ADMIN_TOKEN, agentId: "admin-test", scopes: ["admin"] },
      { token: READ_TOKEN, agentId: "czytelnik-test", scopes: ["brain:read", "memory:read"] },
    ],
    allowedOrigins: ["http://127.0.0.1:3000"],
    rateLimitPerMinute: options.rateLimitPerMinute ?? 100,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
  });
  const address = await server.start({ host: "127.0.0.1", port: 0 });
  return { server, runtime, url: address.url };
}

async function closeFixture(value: ApiFixture): Promise<void> {
  await value.server.close();
  value.runtime.close();
}

function headers(token = ADMIN_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function apiJson(
  value: ApiFixture,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const customHeaders = init.headers as Record<string, string> | undefined;
  const response = await fetch(`${value.url}${path}`, {
    ...init,
    headers: { ...headers(), ...(customHeaders ?? {}) },
  });
  const text = await response.text();
  return {
    response,
    body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Oczekiwano tablicy w odpowiedzi API");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Oczekiwano obiektu w odpowiedzi API");
  }
  return value as Record<string, unknown>;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes(expected)) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Nie odebrano zdarzenia '${expected}' w limicie czasu`)),
          5_000,
        );
      }),
    ]);
    if (result.done) break;
    output += decoder.decode(result.value, { stream: true });
  }
  return output;
}

describe("NEUROSA-HB Brain API", () => {
  it("udostępnia publiczny health, ale blokuje API bez tokenu", async () => {
    const value = await fixture();
    try {
      expect((await fetch(`${value.url}/health`)).status).toBe(200);
      const response = await fetch(`${value.url}/api/v1/brain/status`);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "BRAK_UWIERZYTELNIENIA" });
    } finally {
      await closeFixture(value);
    }
  });

  it("zwraca status, regiony, neurony, synapsy i poprawny ledger", async () => {
    const value = await fixture();
    try {
      const status = await apiJson(value, "/api/v1/brain/status");
      expect(status.response.status).toBe(200);
      expect(status.body).toMatchObject({
        brainId: "ApiBrain",
        neurons: 2,
        synapses: 1,
        ledgerValid: true,
      });
      expect(array((await apiJson(value, "/api/v1/brain/regions")).body.regions)).toHaveLength(1);
      expect(array((await apiJson(value, "/api/v1/brain/neurons")).body.neurons)).toHaveLength(2);
      expect(array((await apiJson(value, "/api/v1/brain/synapses")).body.synapses)).toHaveLength(1);
      expect((await apiJson(value, "/api/v1/brain/ledger/verify")).body.valid).toBe(true);
    } finally {
      await closeFixture(value);
    }
  });

  it("egzekwuje scope deny-by-default", async () => {
    const value = await fixture();
    try {
      const result = await apiJson(value, "/api/v1/brain/activate", {
        method: "POST",
        headers: headers(READ_TOKEN),
        body: JSON.stringify({ seedNeuronIds: ["Start"] }),
      });
      expect(result.response.status).toBe(403);
      expect(result.body.code).toBe("BRAK_UPRAWNIEŃ");
    } finally {
      await closeFixture(value);
    }
  });

  it("uruchamia prawdziwą aktywację i udostępnia jej ślad", async () => {
    const value = await fixture();
    try {
      const activation = await apiJson(value, "/api/v1/brain/activate", {
        method: "POST",
        body: JSON.stringify({
          activationId: "api-activation-1",
          seedNeuronIds: ["Start"],
          initialStrength: 1,
          trybDeterministyczny: true,
        }),
      });
      expect(activation.response.status).toBe(200);
      expect(activation.body.activationId).toBe("api-activation-1");
      expect(array(activation.body.firedNeuronIds)).toContain("Start");
      expect(array(activation.body.deliveredImpulses).length).toBeGreaterThan(0);

      const stored = await apiJson(value, "/api/v1/brain/activations/api-activation-1");
      expect(stored.response.status).toBe(200);
      expect(array(stored.body.trace).length).toBeGreaterThan(0);

      const events = await apiJson(value, "/api/v1/brain/events?afterSequence=0");
      expect(
        array(events.body.events).some((event) => record(event).eventType === "IMPULSE_DELIVERED"),
      ).toBe(true);
    } finally {
      await closeFixture(value);
    }
  });

  it("przesyła przez SSE wyłącznie zdarzenia powstałe w runtime", async () => {
    const value = await fixture();
    const controller = new AbortController();
    try {
      const streamResponse = await fetch(`${value.url}/api/v1/brain/events/stream`, {
        headers: headers(),
        signal: controller.signal,
      });
      expect(streamResponse.status).toBe(200);
      const reader = streamResponse.body!.getReader();
      expect(await readUntil(reader, "POŁĄCZONO")).toContain("event: polaczono");

      await apiJson(value, "/api/v1/brain/activate", {
        method: "POST",
        body: JSON.stringify({ activationId: "api-stream-1", seedNeuronIds: ["Start"] }),
      });
      const streamed = await readUntil(reader, "IMPULSE_DELIVERED");
      expect(streamed).toContain("event: NEURON_FIRED");
      expect(streamed).toContain("event: IMPULSE_DELIVERED");
      await reader.cancel();
    } finally {
      controller.abort();
      await closeFixture(value);
    }
  });

  it("tworzy, aktualizuje, wyszukuje i miękko usuwa dokument", async () => {
    const value = await fixture();
    try {
      const created = await apiJson(value, "/api/v1/documents", {
        method: "POST",
        body: JSON.stringify({
          title: "Pamięć API",
          path: "api/pamiec.md",
          content: "# Pamięć\nHydra i NEUROSA",
        }),
      });
      expect(created.response.status).toBe(201);
      expect(created.body.sourceType).toBe("API");
      const id = String(created.body.documentId);

      const recalled = await apiJson(value, "/api/v1/brain/recall", {
        method: "POST",
        body: JSON.stringify({ query: "Hydra" }),
      });
      expect(array(recalled.body.memories)).toHaveLength(1);

      const updated = await apiJson(value, `/api/v1/documents/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: "# Pamięć\nHydra, NEUROSA i agent" }),
      });
      expect(updated.body.revision).toBe(2);

      const removed = await fetch(`${value.url}/api/v1/documents/${id}`, {
        method: "DELETE",
        headers: headers(),
      });
      expect(removed.status).toBe(204);
      const listed = await apiJson(value, "/api/v1/documents");
      expect(listed.body.documents).toHaveLength(0);
    } finally {
      await closeFixture(value);
    }
  });

  it("zapisuje observation i remember w oddzielnej przestrzeni agenta", async () => {
    const value = await fixture();
    try {
      const observed = await apiJson(value, "/api/v1/brain/observe", {
        method: "POST",
        body: JSON.stringify({ title: "Wynik zadania", content: "Agent zakończył walidację" }),
      });
      expect(observed.response.status).toBe(201);
      expect(record(observed.body.document).path).toContain("agent/admin-test/obserwacja-");

      const remembered = await apiJson(value, "/api/v1/brain/remember", {
        method: "POST",
        body: JSON.stringify({ title: "Decyzja", content: "Utrwalić Checkpoint C" }),
      });
      expect(record(remembered.body.document).path).toContain("agent/admin-test/pamięć-");
    } finally {
      await closeFixture(value);
    }
  });

  it("odrzuca zły origin CORS", async () => {
    const value = await fixture();
    try {
      const result = await apiJson(value, "/api/v1/brain/status", {
        headers: { ...headers(), origin: "https://atak.example" },
      });
      expect(result.response.status).toBe(403);
      expect(result.body.code).toBe("NIEDOZWOLONE_POCHODZENIE");
    } finally {
      await closeFixture(value);
    }
  });

  it("zwraca correlation ID operatora", async () => {
    const value = await fixture();
    try {
      const response = await fetch(`${value.url}/api/v1/brain/status`, {
        headers: { ...headers(), "x-correlation-id": "test-correlation-123" },
      });
      expect(response.headers.get("x-correlation-id")).toBe("test-correlation-123");
    } finally {
      await closeFixture(value);
    }
  });

  it("blokuje zbyt duży payload", async () => {
    const value = await fixture({ maxBodyBytes: 32 });
    try {
      const result = await apiJson(value, "/api/v1/documents", {
        method: "POST",
        body: JSON.stringify({ title: "Duży", path: "duzy.md", content: "x".repeat(100) }),
      });
      expect(result.response.status).toBe(413);
      expect(result.body.code).toBe("ZA_DUŻY_PAYLOAD");
    } finally {
      await closeFixture(value);
    }
  });

  it("egzekwuje limit zapytań", async () => {
    const value = await fixture({ rateLimitPerMinute: 1 });
    try {
      expect((await apiJson(value, "/api/v1/brain/status")).response.status).toBe(200);
      const second = await apiJson(value, "/api/v1/brain/status");
      expect(second.response.status).toBe(429);
      expect(second.body.code).toBe("LIMIT_ZAPYTAŃ");
    } finally {
      await closeFixture(value);
    }
  });

  it("nie pozwala uruchomić publicznego bindu", async () => {
    const repository = new SqliteRuntimeRepository(":memory:");
    const runtime = new NeurosaRuntime(repository);
    runtime.load(compileSource(source).ir);
    const server = new BrainApiServer(runtime, repository, {
      credentials: [{ token: ADMIN_TOKEN, agentId: "admin", scopes: ["admin"] }],
    });
    await expect(server.start({ host: "0.0.0.0", port: 0 })).rejects.toThrow("wyłącznie lokalnie");
    runtime.close();
  });
});
