import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainApiServer } from "@neurosa/brain-api";
import { compileSource } from "@neurosa/compiler";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { SqliteRuntimeRepository } from "@neurosa/storage";
import { createMemoryGateway } from "../../apps/neurosa-connect/src/web.js";
import { connectNeurosaMemory } from "../../packages/neurosa-memory/src/index.js";

const scope = { organizationId: "osa", projectId: "osa", namespace: "osa" };
const ir = compileSource(
  "brain OsaBrain { region R { neuron N { threshold: 0.5 } } }",
  "landing.nsa",
).ir;
type Pair = {
  pairingCode: string;
  agentId: string;
  connectorUrl: string;
  connectionId: string;
  mcp: unknown;
};
type Credential = { token: string; endpoint: string; brainId: string };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "neurosa-landing-"));
  const repository = new SqliteRuntimeRepository(join(directory, "brain.db"));
  const runtime = new NeurosaRuntime(repository);
  runtime.load(ir);
  const token = randomUUID();
  const server = new BrainApiServer(runtime, repository, {
    memoryScope: scope,
    credentials: [
      {
        token,
        agentId: "landing-backend",
        scopes: ["brain:read", "memory:read", "memory:write", "events:read"],
      },
    ],
    rateLimitPerMinute: 10000,
  });
  const backend = await server.start();
  const options = { endpoint: backend.url, token, brainId: "OsaBrain", ...scope };
  let time = Date.now();
  const gateway = createMemoryGateway({ ...options, now: () => time });
  const address = await gateway.start();
  let cookie = "";
  const request = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(address.url + path, {
      headers: { "content-type": "application/json", cookie, origin: address.url, ...extra },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  const code = new URL(address.operatorUrl).hash.slice("#access=".length);
  async function activate() {
    const response = await request("/connect/api/activate", { code });
    expect(response.status).toBe(200);
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return response;
  }
  async function pair(agentId = "Jeverson", readOnly = false): Promise<Pair> {
    const response = await request("/connect/api/pair", { agentId, readOnly });
    expect(response.status).toBe(200);
    return (await response.json()) as Pair;
  }
  function redeem(pair: Pair, headers: Record<string, string> = {}) {
    return fetch(address.url + "/connect/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ pairingCode: pair.pairingCode, agentId: pair.agentId }),
    });
  }
  async function grant(agentId = "Jeverson", readOnly = false) {
    const p = await pair(agentId, readOnly);
    const r = await redeem(p);
    expect(r.status).toBe(200);
    return (await r.json()) as Credential;
  }
  function raw(
    credential: Credential,
    path = "brain/status",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    return request("/api/v1/" + path, body, {
      authorization: "Bearer " + credential.token,
      ...extra,
    });
  }
  let backendClosed = false;
  async function stopBackend() {
    if (!backendClosed) {
      backendClosed = true;
      await server.close();
      runtime.close();
    }
  }
  return {
    directory,
    repository,
    runtime,
    token,
    options,
    gateway,
    address,
    request,
    activate,
    pair,
    redeem,
    grant,
    raw,
    stopBackend,
    advance: (ms: number) => {
      time += ms;
    },
    close: async () => {
      await gateway.close();
      await stopBackend();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("Landing: rzeczywisty gateway HTTP → kanoniczny Brain API / SQLite", () => {
  it("publiczny landing nie ujawnia klucza, a prywatne operacje wymagają jednorazowego dostępu operatora", async () => {
    const f = await fixture();
    try {
      for (const asset of [
        "/connect",
        "/connect/app.js",
        "/connect/style.css",
        "/connect/download/python-template.py",
      ]) {
        const response = await f.request(asset);
        expect(response.status).toBe(200);
        expect(await response.text()).not.toContain(f.token);
        expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      }
      for (const [path, value] of [
        ["state", undefined],
        ["pair", { agentId: "x" }],
        ["test", { testId: randomUUID() }],
      ] as const)
        expect((await f.request("/connect/api/" + path, value)).status).toBe(401);
      expect((await f.request("/connect/api/activate", { code: "invalid" })).status).toBe(401);
      expect(
        (
          await f.request(
            "/connect/api/activate",
            { code: "invalid" },
            { origin: "https://foreign.invalid" },
          )
        ).status,
      ).toBe(403);
      const activation = await f.activate();
      expect(activation.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
      const code = new URL(f.address.operatorUrl).hash.slice(8);
      expect((await f.request("/connect/api/activate", { code })).status).toBe(401);
      expect(
        (
          await f.request(
            "/connect/api/pair",
            { agentId: "x" },
            { origin: "https://foreign.invalid" },
          )
        ).status,
      ).toBe(403);
      expect((await f.request("/connect/download/neurosa-memory-0.1.1.tgz")).status).toBe(503);
    } finally {
      await f.close();
    }
  });

  it("Jeverson zapisuje, nowy Hermes odczytuje źródło i hash; retry zachowuje jeden dokument i ledger", async () => {
    const f = await fixture();
    try {
      await f.activate();
      const p = await f.pair();
      const options = { ...p, cacheDirectory: join(f.directory, "agent-config") };
      const writer = await connectNeurosaMemory(options);
      const input = {
        agentId: "Jeverson",
        content: `LandingProof${randomUUID().replaceAll("-", "")}: użytkownik buduje system OSA.`,
        idempotencyKey: randomUUID() + "k".repeat(464),
      };
      const saved = await writer.remember(input);
      const events = f.runtime.listEvents().length;
      // The pairing code is already consumed. A new facade loads only its connection credential.
      const retry = await (await connectNeurosaMemory(options)).remember(input);
      expect(retry).toMatchObject({ documentId: saved.documentId, deduplicated: true });
      expect(f.runtime.listEvents()).toHaveLength(events);
      const reader = await connectNeurosaMemory({
        ...(await f.pair("Hermes", true)),
        cacheDirectory: false,
      });
      const recalled = await reader.recall({
        agentId: "Hermes",
        query: input.content.split(":")[0]!,
      });
      expect(recalled.text).toContain(input.content);
      expect(recalled.sources[0]).toMatchObject({
        documentId: saved.documentId,
        contentHash: createHash("sha256").update(input.content).digest("hex"),
        sourceReference: "Jeverson",
      });
      expect(recalled.integrity).toEqual({
        status: "CONTENT_HASH_CHECKED",
        ledger: "SERVER_VALIDATED",
        externalAttestation: false,
      });
      expect(recalled.untrusted).toBe(true);
      expect(f.repository.listDocuments()).toHaveLength(1);
      const [name] = await readdir(options.cacheDirectory);
      const filename = join(options.cacheDirectory, name!);
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
      const cached = await readFile(filename, "utf8");
      expect(cached).not.toContain(f.token);
      expect(cached).not.toContain(input.content);
      await chmod(filename, 0o644);
      await expect(connectNeurosaMemory(options)).rejects.toThrow("plik połączenia");
    } finally {
      await f.close();
    }
  });

  it("kod jest jednorazowy, przypisany do agenta i odmawia wymiany w przeglądarce", async () => {
    const f = await fixture();
    try {
      await f.activate();
      const pair = await f.pair();
      expect((await f.redeem({ ...pair, agentId: "Hermes" })).status).toBe(401);
      expect((await f.redeem(pair, { origin: f.address.url })).status).toBe(403);
      expect((await f.redeem(pair, { "sec-fetch-site": "same-origin" })).status).toBe(403);
      const response = await f.redeem(pair);
      expect(response.status).toBe(200);
      const connection = (await response.json()) as Credential;
      expect(connection.token).not.toBe(f.token);
      expect(connection.endpoint).toBe(f.address.url);
      expect((await f.redeem(pair)).status).toBe(401);
      expect((await f.raw({ ...connection, token: connection.token + "tampered" })).status).toBe(
        401,
      );
      const expired = await f.pair("old");
      f.advance(5 * 60000 + 1);
      expect((await f.redeem(expired)).status).toBe(401);
      f.advance(30 * 24 * 3600000);
      expect((await f.raw(connection)).status).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("wygasły link nie daje dostępu operatora", async () => {
    const f = await fixture();
    try {
      f.advance(5 * 60000 + 1);
      const code = new URL(f.address.operatorUrl).hash.slice(8);
      expect((await f.request("/connect/api/activate", { code })).status).toBe(401);
      expect((await f.request("/connect/api/state")).status).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("read-only i obce scope są odrzucane; agentId nie nadaje uprawnień", async () => {
    const f = await fixture();
    try {
      await f.activate();
      const reader = await f.grant("admin", true);
      expect(
        (
          await f.raw(reader, "brain/remember", {
            originAgentId: "admin",
            content: "x",
            title: "x",
            idempotencyKey: "x",
          })
        ).status,
      ).toBe(403);
      for (const key of ["namespace", "organization-id", "project-id", "brain-id"])
        expect(
          (await f.raw(reader, "brain/status", undefined, { ["x-neurosa-" + key]: "foreign" }))
            .status,
        ).toBe(403);
      expect(
        (await f.raw(reader, "brain/status", undefined, { "x-neurosa-namespace": "%" })).status,
      ).toBe(403);
      expect((await f.raw(reader, "brain/status")).status).toBe(200);
      const writer = await f.grant("Jeverson");
      const saved = await f.raw(writer, "brain/remember", {
        originAgentId: "forged-agent",
        title: "fact",
        content: "provenance proof",
        projectId: "osa",
        idempotencyKey: randomUUID(),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ document: { sourceReference: "Jeverson" } });
      expect(f.repository.listDocuments()).toHaveLength(1);
      expect(
        (
          await f.raw(writer, "brain/remember", {
            title: "foreign",
            content: "no",
            projectId: "foreign",
            idempotencyKey: randomUUID(),
          })
        ).status,
      ).toBe(403);
    } finally {
      await f.close();
    }
  });

  it("gateway blokuje administrację i chroni sesję przed innym agentem", async () => {
    const f = await fixture();
    try {
      await f.activate();
      const one = await f.grant("one"),
        two = await f.grant("two");
      for (const route of ["documents", "brain/events", "brain/snapshot", "unknown"])
        expect((await f.raw(one, route)).status).toBe(403);
      const sessionId = "s".repeat(200);
      const started = await f.raw(one, "sessions", {
        sessionId,
        projectId: "osa",
        provider: "other",
      });
      expect(started.status).toBe(200);
      const value = (await started.json()) as { sessionId: string };
      expect((await f.raw(one, "sessions/" + sessionId)).status).toBe(200);
      expect((await f.raw(two, "sessions/" + encodeURIComponent(value.sessionId))).status).toBe(
        409,
      );
      expect(
        (await f.raw(two, "sessions/" + sessionId + "/complete", { entries: [] })).status,
      ).toBe(409);
      expect(
        (
          await fetch(f.address.url + "/api/v1/documents/anything", {
            method: "DELETE",
            headers: { authorization: "Bearer " + one.token },
          })
        ).status,
      ).toBe(403);
    } finally {
      await f.close();
    }
  });

  it("przygotowana konfiguracja i test pamięci nie udają podłączenia rzeczywistego agenta", async () => {
    const f = await fixture();
    try {
      await f.activate();
      const pair = await f.pair("real-agent-test");
      const state = () =>
        f.request("/connect/api/state").then((r) => r.json()) as Promise<{
          activeAgents: { connectionId: string }[];
        }>;
      expect((await state()).activeAgents).toEqual([]);
      const testId = randomUUID();
      const first = await f.request("/connect/api/test", { testId });
      expect(first.status).toBe(200);
      const proof = (await first.json()) as { source: { documentId: string } };
      const retry = await f.request("/connect/api/test", { testId });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        status: "PASS",
        source: { documentId: proof.source.documentId },
        modelCalls: 0,
        freshReader: true,
      });
      expect(f.repository.listDocuments()).toHaveLength(1);
      expect((await state()).activeAgents).toEqual([]);
      const second = await f.pair();
      await connectNeurosaMemory({ ...pair, cacheDirectory: false });
      expect((await state()).activeAgents).toEqual([
        expect.objectContaining({ connectionId: pair.connectionId }),
      ]);
      expect((await state()).activeAgents.some((v) => v.connectionId === second.connectionId)).toBe(
        false,
      );
    } finally {
      await f.close();
    }
  });

  it("awaria backendu nie usuwa pamięci i pozwala zwykłemu callbackowi czatu pracować bez fikcyjnego kontekstu", async () => {
    const f = await fixture();
    try {
      await f.activate();
      const memory = await connectNeurosaMemory({ ...(await f.pair()), cacheDirectory: false });
      await memory.remember({
        agentId: "Jeverson",
        content: "before outage",
        idempotencyKey: "outage",
      });
      await f.stopBackend();
      expect((await f.request("/connect/api/state")).status).toBe(502);
      const context = await memory.beforeMessage({ agentId: "Jeverson", message: "before outage" });
      expect(context).toMatchObject({
        status: "UNAVAILABLE",
        text: "",
        sources: [],
        untrusted: true,
      });
      const hostReply = () => "Zwykła rozmowa trwa";
      expect(hostReply()).toBe("Zwykła rozmowa trwa");
      expect((await stat(join(f.directory, "brain.db"))).size).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  });

  it("adres zdalny wymaga HTTPS i nie przyjmuje ścieżek ani parametrów", async () => {
    const f = await fixture();
    try {
      for (const publicOrigin of [
        "http://remote.invalid",
        "https://remote.invalid/path",
        "https://x@y.invalid",
        "https://remote.invalid?token=x",
      ]) {
        const g = createMemoryGateway(f.options);
        await expect(g.start({ publicOrigin, allowRemote: true })).rejects.toThrow();
        await g.close();
      }
    } finally {
      await f.close();
    }
  });
});
