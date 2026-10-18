import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NeurosaConnect, BrainConnectionError } from "@neurosa/connect";
import { z } from "zod";
import {
  createNeurosaMemory,
  connectNeurosaMemory,
  type NeurosaMemoryOptions,
} from "../../../packages/neurosa-memory/src/index.js";

interface GatewayOptions extends NeurosaMemoryOptions {
  readonly packagePath?: string;
  readonly now?: () => number;
}
class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const pairInput = z
  .object({ agentId: z.string().trim().min(1).max(100), readOnly: z.boolean().default(false) })
  .strict();
const claimsSchema = z
  .object({
    kind: z.enum(["operator", "agent"]),
    id: z.string().uuid(),
    expiresAt: z.number().int(),
    agentId: z.string().min(1).max(100).optional(),
    canWrite: z.boolean().optional(),
    diagnostic: z.boolean().optional(),
  })
  .strict();
type Claims = z.infer<typeof claimsSchema>;
const assets = new Map([
  ["/connect", ["index.html", "text/html; charset=utf-8"]],
  ["/connect/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/connect/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

/** A thin connection gateway. All durable memory remains in the existing Brain API. */
export function createMemoryGateway(options: GatewayOptions) {
  const now = options.now ?? Date.now;
  const scope = {
    namespace: options.namespace,
    organizationId: options.organizationId ?? options.namespace,
    projectId: options.projectId ?? options.namespace,
  };
  const memory = createNeurosaMemory(options);
  const upstream = new NeurosaConnect({
    baseUrl: options.endpoint,
    token: options.token,
    brainId: options.brainId,
    provider: "other",
    memoryScope: scope,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const bootstrap = randomBytes(32).toString("base64url");
  const bootstrapExpiry = now() + 5 * 60000;
  let bootstrapUsed = false;
  let origin = "";
  const pairs = new Map<
    string,
    { id: string; agentId: string; canWrite: boolean; diagnostic: boolean; expiresAt: number }
  >();
  const active = new Map<string, { connectionId: string; agentId: string; lastSeen: string }>();
  const attempts = new Map<string, { count: number; until: number }>();
  const secret = () =>
    createHmac("sha256", options.token)
      .update(JSON.stringify(["neurosa-connector-v1", origin, options.brainId, scope]))
      .digest();
  const mac = (value: string) => createHmac("sha256", secret()).update(value).digest("base64url");
  const equal = (a: string, b: string) => {
    const x = Buffer.from(a),
      y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const sign = (claims: Claims) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${mac(payload)}`;
  };
  const verify = (raw: string | undefined, kind: Claims["kind"]): Claims => {
    if (!raw || raw.length > 4096)
      throw new Problem(401, "ACCESS_REQUIRED", "Otwórz prywatny link operatora");
    const [body, signature, extra] = raw.split(".");
    if (!body || !signature || extra !== undefined || !equal(mac(body), signature))
      throw new Problem(401, "ACCESS_DENIED", "Brak dostępu do tego połączenia");
    let value: Claims;
    try {
      value = claimsSchema.parse(
        JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown,
      );
    } catch {
      throw new Problem(401, "ACCESS_DENIED", "Nieprawidłowe uprawnienie połączenia");
    }
    if (value.kind !== kind || value.expiresAt <= now() || (kind === "agent" && !value.agentId))
      throw new Problem(401, "ACCESS_EXPIRED", "Dostęp wygasł; przygotuj nowe połączenie");
    return value;
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const owner = (req: IncomingMessage) =>
    verify(
      req.headers.cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("neurosa_operator="))
        ?.slice("neurosa_operator=".length),
      "operator",
    );
  const sameOrigin = (req: IncomingMessage) => {
    if (req.headers.origin !== origin)
      throw new Problem(403, "ORIGIN_DENIED", "Żądanie pochodzi spoza strony połączenia");
  };
  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw new Problem(415, "JSON_REQUIRED", "Wymagane dane JSON");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 1024 * 1024) throw new Problem(413, "BODY_TOO_LARGE", "Za duży zapis");
      chunks.push(bytes);
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new Problem(400, "INVALID_JSON", "Nieprawidłowe dane");
    }
  }
  function newPair(agentId: string, canWrite = true, diagnostic = false) {
    for (const [key, value] of pairs) if (value.expiresAt <= now()) pairs.delete(key);
    if (pairs.size >= 128) throw new Problem(429, "PAIR_LIMIT", "Zbyt wiele oczekujących połączeń");
    const code = randomBytes(24).toString("base64url"),
      expiresAt = now() + 5 * 60000;
    const id = randomUUID();
    pairs.set(code, { id, agentId, canWrite, diagnostic, expiresAt });
    return {
      pairingCode: code,
      connectorUrl: origin,
      agentId,
      connectionId: id,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", origin);
    if (url.origin !== origin)
      throw new Problem(400, "INVALID_ORIGIN", "Nieprawidłowy adres żądania");
    const path = url.pathname;
    if (req.method === "GET" && path === "/") {
      res.writeHead(302, { location: "/connect" });
      res.end();
      return;
    }
    const asset = assets.get(path);
    if (req.method === "GET" && asset) {
      const content = await readFile(new URL(`../web/${asset[0]!}`, import.meta.url));
      res.writeHead(200, { "content-type": asset[1]! });
      res.end(content);
      return;
    }
    if (req.method === "GET" && path === "/health") {
      json(res, 200, { service: "NeurOSA Memory Connector", status: "OK" });
      return;
    }
    if (req.method === "GET" && path === "/connect/download/python-template.py") {
      const base = new URL("../../../packages/neurosa-memory/examples/", import.meta.url);
      const prefix = await readFile(new URL("pairing.py", base), "utf8");
      const helper = (await readFile(new URL("memory.py", base), "utf8")).split(
        '\nif __name__ == "__main__":',
      )[0]!;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        prefix +
          "\n" +
          helper +
          '\nif __name__ == "__main__":\n    print(json.dumps(health(), ensure_ascii=False))\n',
      );
      return;
    }
    if (req.method === "GET" && path === "/connect/download/neurosa-memory-0.1.1.tgz") {
      if (!options.packagePath)
        throw new Problem(503, "PACKAGE_UNAVAILABLE", "Pakiet nie jest jeszcze gotowy do pobrania");
      let archive: Buffer;
      try {
        archive = await readFile(options.packagePath);
      } catch {
        throw new Problem(503, "PACKAGE_UNAVAILABLE", "Pakiet nie jest jeszcze gotowy do pobrania");
      }
      res.writeHead(200, {
        "content-type": "application/gzip",
        "content-disposition": "attachment; filename=osatech-neurosa-memory-0.1.1.tgz",
      });
      res.end(archive);
      return;
    }
    if (req.method === "POST" && path === "/connect/api/activate") {
      sameOrigin(req);
      const value = await body(req);
      if (
        bootstrapUsed ||
        bootstrapExpiry <= now() ||
        typeof value.code !== "string" ||
        !equal(value.code, bootstrap)
      )
        throw new Problem(401, "LINK_EXPIRED", "Ten link został wykorzystany lub wygasł");
      bootstrapUsed = true;
      const cookie = sign({ kind: "operator", id: randomUUID(), expiresAt: now() + 8 * 3600000 });
      res.setHeader(
        "set-cookie",
        `neurosa_operator=${cookie}; HttpOnly; SameSite=Strict; Path=/connect; Max-Age=28800${origin.startsWith("https:") ? "; Secure" : ""}`,
      );
      json(res, 200, { status: "AUTHORIZED" });
      return;
    }
    if (req.method === "POST" && path === "/connect/pair/redeem") {
      // Browser fetch cannot receive an agent credential. The code is exchanged by the agent backend.
      if (
        req.headers.origin !== undefined ||
        req.headers["sec-fetch-site"] !== undefined ||
        req.headers["sec-fetch-dest"] !== undefined
      )
        throw new Problem(403, "AGENT_PROCESS_REQUIRED", "Kod wymienia proces agenta");
      const value = z
        .object({ pairingCode: z.string().min(20).max(200), agentId: z.string().min(1).max(100) })
        .strict()
        .parse(await body(req));
      const pair = pairs.get(value.pairingCode);
      if (!pair || pair.expiresAt <= now() || pair.agentId !== value.agentId)
        throw new Problem(
          401,
          "PAIRING_REJECTED",
          "Kod wygasł, został wykorzystany lub nie pasuje do agenta",
        );
      pairs.delete(value.pairingCode);
      const token = sign({
        kind: "agent",
        id: pair.id,
        agentId: pair.agentId,
        canWrite: pair.canWrite,
        diagnostic: pair.diagnostic,
        expiresAt: now() + 30 * 24 * 3600000,
      });
      json(res, 200, { endpoint: origin, token, brainId: options.brainId, ...scope });
      return;
    }
    if (path.startsWith("/connect/api/")) {
      owner(req);
      if (req.method === "GET" && path === "/connect/api/state") {
        const health = await memory.health();
        const names = [...active.values()];
        const packageAvailable = options.packagePath
          ? await stat(options.packagePath).then(
              (s) => s.isFile(),
              () => false,
            )
          : false;
        json(res, 200, {
          ready: true,
          packageAvailable,
          brainId: health.brainId,
          scope: health.scope,
          operationId: health.operationId,
          activeAgents: names,
        });
        return;
      }
      if (req.method !== "POST") throw new Problem(404, "NOT_FOUND", "Nie znaleziono operacji");
      sameOrigin(req);
      if (path === "/connect/api/pair") {
        const input = pairInput.parse(await body(req));
        await memory.health();
        const pair = newPair(input.agentId, !input.readOnly);
        const packageUrl = `${origin}/connect/download/neurosa-memory-0.1.1.tgz`;
        json(res, 200, {
          ...pair,
          packageUrl,
          mcp: {
            mcpServers: {
              neurosa: {
                command: "npx",
                args: ["--yes", `--package=${packageUrl}`, "neurosa-memory", "mcp"],
                env: {
                  NEUROSA_CONNECTOR_URL: origin,
                  NEUROSA_PAIR_CODE: pair.pairingCode,
                  NEUROSA_AGENT_ID: input.agentId,
                },
              },
            },
          },
        });
        return;
      }
      if (path === "/connect/api/test") {
        const input = z
          .object({ testId: z.string().uuid() })
          .strict()
          .parse(await body(req));
        const marker = `NeurosaConnect${input.testId.replaceAll("-", "")}`;
        const writer = await connectNeurosaMemory({
          ...newPair("Jeverson-test", true, true),
          cacheDirectory: false,
        });
        const saved = await writer.remember({
          agentId: "Jeverson-test",
          content: `${marker}: pamięć pozostaje między sesjami.`,
          idempotencyKey: `landing:${input.testId}`,
        });
        const reader = await connectNeurosaMemory({
          ...newPair("Hermes-test", false, true),
          cacheDirectory: false,
        });
        const recalled = await reader.recall({ agentId: "Hermes-test", query: marker });
        const source = recalled.sources.find(
          (s) => s.documentId === saved.documentId && s.contentHash === saved.contentHash,
        );
        if (!source)
          throw new Problem(409, "SOURCE_REJECTED", "Odczyt nie potwierdził źródła zapisu");
        json(res, 200, {
          status: "PASS",
          brainId: recalled.brainId,
          source,
          operationId: recalled.operationId,
          writeOperationId: saved.operationId,
          integrity: recalled.integrity,
          freshReader: true,
          modelCalls: 0,
        });
        return;
      }
    }
    if (path.startsWith("/api/v1/")) {
      const bearer = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : undefined;
      const credential = verify(bearer, "agent");
      const agentId = credential.agentId!;
      const expectedHeaders = {
        "x-neurosa-brain-id": options.brainId,
        "x-neurosa-namespace": scope.namespace,
        "x-neurosa-organization-id": scope.organizationId,
        "x-neurosa-project-id": scope.projectId,
      };
      for (const [key, expected] of Object.entries(expectedHeaders)) {
        const actual = req.headers[key];
        if (actual !== undefined) {
          let decoded: string | undefined;
          try {
            decoded = typeof actual === "string" ? decodeURIComponent(actual) : undefined;
          } catch {
            /* malformed scope is denied */
          }
          if (decoded !== expected)
            throw new Problem(403, "SCOPE_DENIED", "Połączenie wskazuje inną przestrzeń pamięci");
        }
      }
      let remotePath = path.slice("/api/v1/".length);
      const read =
        req.method === "GET" &&
        (/^brain\/(status|ledger\/verify)$/u.test(remotePath) ||
          /^documents\/[^/]+$/u.test(remotePath) ||
          /^sessions\/[^/]+$/u.test(remotePath));
      const recall = req.method === "POST" && remotePath === "brain/recall";
      const write =
        req.method === "POST" &&
        (remotePath === "brain/remember" ||
          remotePath === "sessions" ||
          /^sessions\/[^/]+\/complete$/u.test(remotePath));
      if (!read && !recall && !write)
        throw new Problem(403, "ROUTE_DENIED", "Ta operacja nie jest dostępna dla connectora");
      if (write && !credential.canWrite)
        throw new Problem(403, "WRITE_DENIED", "Agent ma dostęp tylko do odczytu");
      const prefix = `agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 24)}:`;
      const digest = (id: string) => createHash("sha256").update(id).digest("hex");
      const sessionId = (id: string) => {
        z.string().min(1).max(200).parse(id);
        return id.startsWith(prefix) && /^[a-f0-9]{64}$/u.test(id.slice(prefix.length))
          ? id
          : prefix + digest(id);
      };
      const ownedWrite = (value: Record<string, unknown>) => {
        const output: Record<string, unknown> = { ...value, originAgentId: agentId };
        if (typeof value.idempotencyKey === "string")
          output.idempotencyKey =
            prefix + digest(z.string().trim().min(1).max(500).parse(value.idempotencyKey));
        if (typeof value.sessionId === "string") output.sessionId = sessionId(value.sessionId);
        return output;
      };
      const input = req.method === "POST" ? await body(req) : undefined;
      let payload: Record<string, unknown> | undefined = input;
      if (input && remotePath === "brain/remember") payload = ownedWrite(input);
      if (input && remotePath === "sessions" && typeof input.sessionId === "string")
        payload = { ...input, sessionId: sessionId(input.sessionId) };
      if (remotePath.startsWith("sessions/")) {
        const parts = remotePath.split("/");
        remotePath = `sessions/${encodeURIComponent(sessionId(decodeURIComponent(parts[1]!)))}${parts[2] === "complete" ? "/complete" : ""}`;
        if (input && Array.isArray(input.entries))
          payload = {
            entries: input.entries.map((v) =>
              ownedWrite(z.record(z.string(), z.unknown()).parse(v)),
            ),
          };
      }
      const result = await upstream.request(remotePath, req.method, payload);
      if (!credential.diagnostic) {
        if (active.size >= 128 && !active.has(credential.id))
          active.delete(
            [...active.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))[0]!
              .connectionId,
          );
        active.set(credential.id, {
          connectionId: credential.id,
          agentId,
          lastSeen: new Date(now()).toISOString(),
        });
      }
      json(res, 200, result);
      return;
    }
    throw new Problem(404, "NOT_FOUND", "Nie znaleziono strony");
  }
  const server = createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    const key = req.socket.remoteAddress ?? "unknown";
    for (const [ip, value] of attempts) if (value.until <= now()) attempts.delete(ip);
    const limit = attempts.get(key) ?? { count: 0, until: now() + 60000 };
    limit.count++;
    if (attempts.size < 256 || attempts.has(key)) attempts.set(key, limit);
    if (limit.count > 240) {
      json(res, 429, { code: "RATE_LIMIT", message: "Zbyt wiele prób; spróbuj za chwilę" });
      return;
    }
    void route(req, res).catch((error: unknown) => {
      const status =
        error instanceof Problem
          ? error.status
          : error instanceof BrainConnectionError
            ? error.status || 502
            : error instanceof z.ZodError
              ? 400
              : 500;
      json(res, status, {
        code:
          error instanceof Problem || error instanceof BrainConnectionError
            ? error.code
            : "CONNECTOR_ERROR",
        message:
          error instanceof Problem
            ? error.message
            : "Nie udało się potwierdzić połączenia z NeurOSA",
      });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    async start(config: { port?: number; publicOrigin?: string; allowRemote?: boolean } = {}) {
      const publicUrl = config.publicOrigin ? new URL(config.publicOrigin) : undefined;
      if (
        publicUrl &&
        (publicUrl.username ||
          publicUrl.password ||
          publicUrl.search ||
          publicUrl.hash ||
          publicUrl.pathname !== "/" ||
          (publicUrl.protocol !== "https:" &&
            !(
              publicUrl.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(publicUrl.hostname)
            )))
      )
        throw new Error("Nieprawidłowy publicOrigin");
      if (config.allowRemote && (!publicUrl || publicUrl.protocol !== "https:"))
        throw new Error("Zdalny landing wymaga jawnego publicOrigin HTTPS");
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(config.port ?? 0, config.allowRemote ? "0.0.0.0" : "127.0.0.1", done);
      });
      const port = (server.address() as AddressInfo).port;
      origin = config.publicOrigin
        ? new URL(config.publicOrigin).origin
        : `http://127.0.0.1:${port}`;
      return { url: origin, operatorUrl: `${origin}/connect#access=${bootstrap}` };
    },
    async close() {
      if (!server.listening) return;
      server.closeIdleConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}
