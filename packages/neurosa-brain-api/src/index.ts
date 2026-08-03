import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { BrainDocument, BrainWorkspaceRepository } from "@neurosa/document-domain";
import type { NeurosaRuntime } from "@neurosa/neural-runtime";
import type { ActivationRequest, BrainEvent } from "@neurosa/runtime-domain";
import { NativeBrainWorkspace } from "@neurosa/workspace";

export const BRAIN_API_VERSION = "v1" as const;

export const BRAIN_API_SCOPES = [
  "brain:read",
  "brain:activate",
  "memory:read",
  "memory:write",
  "events:read",
  "admin",
] as const;

export type BrainApiScope = (typeof BRAIN_API_SCOPES)[number];

export interface BrainApiCredential {
  readonly token: string;
  readonly agentId: string;
  readonly scopes: readonly BrainApiScope[];
}

export interface BrainApiOptions {
  readonly credentials: readonly BrainApiCredential[];
  readonly allowedOrigins?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly rateLimitPerMinute?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export interface BrainApiStartOptions {
  readonly host?: string;
  readonly port?: number;
}

export interface BrainApiAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

interface AuthContext {
  readonly agentId: string;
  readonly scopes: ReadonlySet<BrainApiScope>;
  readonly tokenKey: string;
}

interface JsonError {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
}

interface RateEntry {
  count: number;
  resetAt: number;
}

interface DocumentMutationInput {
  readonly title?: unknown;
  readonly path?: unknown;
  readonly content?: unknown;
  readonly pinned?: unknown;
  readonly favorite?: unknown;
  readonly archived?: unknown;
}

interface ActivationInput {
  readonly activationId?: unknown;
  readonly seedNeuronIds?: unknown;
  readonly initialStrength?: unknown;
  readonly maksymalnaLiczbaSkokow?: unknown;
  readonly minimalnaSila?: unknown;
  readonly limitZdarzen?: unknown;
  readonly limitCzasuMs?: unknown;
  readonly trybDeterministyczny?: unknown;
}

class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function asString(value: unknown, name: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiProblem(400, "NIEPRAWIDŁOWE_DANE", `Pole '${name}' musi być niepustym tekstem`);
  }
  return value.trim();
}

function asBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ApiProblem(400, "NIEPRAWIDŁOWE_DANE", `Pole '${name}' musi być wartością logiczną`);
  }
  return value;
}

function asNumber(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isFinite(result) ||
    result < minimum ||
    result > maximum ||
    (integer && !Number.isInteger(result))
  ) {
    throw new ApiProblem(
      400,
      "NIEPRAWIDŁOWE_DANE",
      `Pole '${name}' musi mieścić się w zakresie ${String(minimum)}–${String(maximum)}`,
    );
  }
  return result;
}

function json(
  response: ServerResponse,
  status: number,
  payload: unknown,
  correlationId: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-correlation-id": correlationId,
    ...headers,
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function pathParts(request: IncomingMessage): string[] {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  return url.pathname.split("/").filter(Boolean);
}

function query(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
}

function documentSummary(document: BrainDocument): unknown {
  return {
    documentId: document.documentId,
    title: document.title,
    path: document.path,
    tags: document.tags,
    revision: document.revision,
    sourceType: document.sourceType,
    archived: document.archived,
    deletedAt: document.deletedAt,
    updatedAt: document.updatedAt,
  };
}

export class BrainEventStream {
  private readonly clients = new Set<ServerResponse>();

  subscribe(response: ServerResponse, correlationId: string): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-correlation-id": correlationId,
    });
    response.write(`event: polaczono\ndata: ${JSON.stringify({ status: "POŁĄCZONO" })}\n\n`);
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
  }

  publish(events: readonly BrainEvent[]): void {
    for (const event of events) {
      const frame = `id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const client of this.clients) client.write(frame);
    }
  }

  close(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}

export class BrainApiServer {
  private readonly server: Server;
  private readonly workspace: NativeBrainWorkspace;
  private readonly eventStream = new BrainEventStream();
  private readonly rates = new Map<string, RateEntry>();
  private readonly credentials: readonly BrainApiCredential[];
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly maxBodyBytes: number;
  private readonly rateLimitPerMinute: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private address: BrainApiAddress | null = null;

  constructor(
    private readonly runtime: NeurosaRuntime,
    private readonly repository: BrainWorkspaceRepository,
    options: BrainApiOptions,
  ) {
    if (options.credentials.length === 0) {
      throw new Error("Brain API wymaga co najmniej jednego lokalnego tokenu dostępu");
    }
    for (const credential of options.credentials) {
      if (credential.token.length < 24) {
        throw new Error("Token Brain API musi mieć co najmniej 24 znaki");
      }
    }
    this.credentials = options.credentials;
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this.rateLimitPerMinute = options.rateLimitPerMinute ?? 120;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.workspace = new NativeBrainWorkspace(repository);
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(options: BrainApiStartOptions = {}): Promise<BrainApiAddress> {
    if (this.address !== null) return this.address;
    const host = options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
      throw new Error("Brain API domyślnie może nasłuchiwać wyłącznie lokalnie");
    }
    await new Promise<void>((resolveStart, rejectStart) => {
      this.server.once("error", rejectStart);
      this.server.listen(options.port ?? 0, host, () => {
        this.server.off("error", rejectStart);
        resolveStart();
      });
    });
    const address = this.server.address() as AddressInfo;
    this.address = { host, port: address.port, url: `http://${host}:${String(address.port)}` };
    return this.address;
  }

  async close(): Promise<void> {
    this.eventStream.close();
    if (!this.server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => {
      this.server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    });
    this.address = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const correlationId = this.correlationId(request);
    try {
      this.applyCors(request, response, correlationId);
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "x-correlation-id": correlationId });
        response.end();
        return;
      }
      if (request.method === "GET" && request.url === "/health") {
        json(
          response,
          200,
          { status: "OK", service: "NEUROSA-HB Brain API", version: BRAIN_API_VERSION },
          correlationId,
        );
        return;
      }
      const auth = this.authenticate(request);
      this.enforceRate(auth, request);
      await this.route(request, response, auth, correlationId);
    } catch (error: unknown) {
      const problem =
        error instanceof ApiProblem
          ? error
          : new ApiProblem(500, "BŁĄD_WEWNĘTRZNY", "Wewnętrzny błąd Brain API");
      const payload: JsonError = { code: problem.code, message: problem.message, correlationId };
      json(response, problem.status, payload, correlationId);
    }
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AuthContext,
    correlationId: string,
  ): Promise<void> {
    const parts = pathParts(request);
    if (parts[0] !== "api" || parts[1] !== BRAIN_API_VERSION) {
      throw new ApiProblem(404, "NIE_ZNALEZIONO", "Nie znaleziono endpointu Brain API");
    }
    const route = parts.slice(2);

    if (request.method === "GET" && route.join("/") === "brain/status") {
      this.requireScope(auth, "brain:read");
      const program = this.runtime.getProgram();
      const verification = this.runtime.verifyLedger();
      json(
        response,
        200,
        {
          status: "GOTOWY",
          version: BRAIN_API_VERSION,
          brainId: program.brainId,
          sourceHash: program.sourceHash,
          regions: program.regions.length,
          neurons: this.runtime.getNeuronStates().length,
          synapses: this.runtime.getSynapseStates().length,
          ledgerValid: verification.valid,
        },
        correlationId,
      );
      return;
    }

    if (request.method === "GET" && route.join("/") === "brain/regions") {
      this.requireScope(auth, "brain:read");
      json(response, 200, { regions: this.runtime.getProgram().regions }, correlationId);
      return;
    }

    if (request.method === "GET" && route.join("/") === "brain/neurons") {
      this.requireScope(auth, "brain:read");
      json(response, 200, { neurons: this.runtime.getNeuronStates() }, correlationId);
      return;
    }

    if (
      request.method === "GET" &&
      route[0] === "brain" &&
      route[1] === "neurons" &&
      route[2] !== undefined
    ) {
      this.requireScope(auth, "brain:read");
      const neuron = this.runtime.getNeuronStates().find((candidate) => candidate.id === route[2]);
      if (neuron === undefined)
        throw new ApiProblem(404, "NIE_ZNALEZIONO", `Nie znaleziono neuronu '${route[2]}'`);
      json(response, 200, neuron, correlationId);
      return;
    }

    if (request.method === "GET" && route.join("/") === "brain/synapses") {
      this.requireScope(auth, "brain:read");
      json(response, 200, { synapses: this.runtime.getSynapseStates() }, correlationId);
      return;
    }

    if (request.method === "GET" && route.join("/") === "brain/events") {
      this.requireScope(auth, "events:read");
      const after = Number(query(request).get("afterSequence") ?? "0");
      const events = this.runtime
        .listEvents()
        .filter((event) => event.sequence > (Number.isFinite(after) ? after : 0));
      json(response, 200, { events }, correlationId);
      return;
    }

    if (request.method === "GET" && route.join("/") === "brain/events/stream") {
      this.requireScope(auth, "events:read");
      this.eventStream.subscribe(response, correlationId);
      return;
    }

    if (request.method === "GET" && route.join("/") === "brain/ledger/verify") {
      this.requireScope(auth, "brain:read");
      json(response, 200, this.runtime.verifyLedger(), correlationId);
      return;
    }

    if (request.method === "POST" && route.join("/") === "brain/activate") {
      this.requireScope(auth, "brain:activate");
      const body = (await this.readJson(request)) as ActivationInput;
      const seedNeuronIds = Array.isArray(body.seedNeuronIds)
        ? body.seedNeuronIds.map((value) => asString(value, "seedNeuronIds") as string)
        : [];
      if (seedNeuronIds.length === 0) {
        throw new ApiProblem(
          400,
          "NIEPRAWIDŁOWE_DANE",
          "Wymagany jest co najmniej jeden neuron startowy",
        );
      }
      const activationId = asString(body.activationId, "activationId", false) ?? this.idFactory();
      const before = this.runtime.listEvents().length;
      const activation: ActivationRequest = {
        activationId,
        seedNeuronIds,
        initialStrength: asNumber(body.initialStrength, "initialStrength", 1, 0, 1),
        maksymalnaLiczbaSkokow: asNumber(
          body.maksymalnaLiczbaSkokow,
          "maksymalnaLiczbaSkokow",
          8,
          0,
          64,
          true,
        ),
        minimalnaSila: asNumber(body.minimalnaSila, "minimalnaSila", 0.01, 0, 1),
        limitZdarzen: asNumber(body.limitZdarzen, "limitZdarzen", 500, 1, 10_000, true),
        limitCzasuMs: asNumber(body.limitCzasuMs, "limitCzasuMs", 5_000, 10, 60_000, true),
        trybDeterministyczny: asBoolean(body.trybDeterministyczny, "trybDeterministyczny") ?? true,
      };
      const result = this.runtime.activate(activation);
      this.eventStream.publish(this.runtime.listEvents().slice(before));
      json(response, 200, result, correlationId);
      return;
    }

    if (
      request.method === "GET" &&
      route[0] === "brain" &&
      route[1] === "activations" &&
      route[2] !== undefined
    ) {
      this.requireScope(auth, "brain:read");
      const activation = this.runtime.inspectActivation(route[2]);
      if (activation === null)
        throw new ApiProblem(404, "NIE_ZNALEZIONO", `Nie znaleziono aktywacji '${route[2]}'`);
      json(response, 200, activation, correlationId);
      return;
    }

    if (request.method === "GET" && route.length === 1 && route[0] === "documents") {
      this.requireScope(auth, "memory:read");
      const search = query(request).get("q")?.trim();
      if (search !== undefined && search.length > 0) {
        json(response, 200, { results: this.workspace.search(search) }, correlationId);
      } else {
        json(
          response,
          200,
          { documents: this.repository.listDocuments().map(documentSummary) },
          correlationId,
        );
      }
      return;
    }

    if (request.method === "GET" && route[0] === "documents" && route[1] !== undefined) {
      this.requireScope(auth, "memory:read");
      json(response, 200, this.workspace.getDocument(route[1]), correlationId);
      return;
    }

    if (request.method === "POST" && route.length === 1 && route[0] === "documents") {
      this.requireScope(auth, "memory:write");
      const body = (await this.readJson(request)) as DocumentMutationInput;
      const pinned = asBoolean(body.pinned, "pinned");
      const favorite = asBoolean(body.favorite, "favorite");
      const document = this.workspace.createDocument({
        title: asString(body.title, "title") as string,
        path: asString(body.path, "path") as string,
        content: asString(body.content, "content") as string,
        sourceType: "API",
        sourceReference: auth.agentId,
        ...(pinned === undefined ? {} : { pinned }),
        ...(favorite === undefined ? {} : { favorite }),
      });
      json(response, 201, document, correlationId);
      return;
    }

    if (request.method === "PATCH" && route[0] === "documents" && route[1] !== undefined) {
      this.requireScope(auth, "memory:write");
      const body = (await this.readJson(request)) as DocumentMutationInput;
      const title = asString(body.title, "title", false);
      const path = asString(body.path, "path", false);
      const content = asString(body.content, "content", false);
      const pinned = asBoolean(body.pinned, "pinned");
      const favorite = asBoolean(body.favorite, "favorite");
      const archived = asBoolean(body.archived, "archived");
      const document = this.workspace.updateDocument(route[1], {
        ...(title === undefined ? {} : { title }),
        ...(path === undefined ? {} : { path }),
        ...(content === undefined ? {} : { content }),
        ...(pinned === undefined ? {} : { pinned }),
        ...(favorite === undefined ? {} : { favorite }),
        ...(archived === undefined ? {} : { archived }),
      });
      json(response, 200, document, correlationId);
      return;
    }

    if (request.method === "DELETE" && route[0] === "documents" && route[1] !== undefined) {
      this.requireScope(auth, "memory:write");
      this.workspace.deleteDocument(route[1]);
      response.writeHead(204, { "x-correlation-id": correlationId });
      response.end();
      return;
    }

    if (request.method === "POST" && route.join("/") === "brain/recall") {
      this.requireScope(auth, "memory:read");
      const body = (await this.readJson(request)) as { query?: unknown; limit?: unknown };
      const search = asString(body.query, "query") as string;
      const limit = asNumber(body.limit, "limit", 10, 1, 100, true);
      json(
        response,
        200,
        { query: search, memories: this.workspace.search(search, limit) },
        correlationId,
      );
      return;
    }

    if (
      request.method === "POST" &&
      (route.join("/") === "brain/remember" || route.join("/") === "brain/observe")
    ) {
      this.requireScope(auth, "memory:write");
      const body = (await this.readJson(request)) as DocumentMutationInput & { kind?: unknown };
      const kind = route[1] === "observe" ? "obserwacja" : "pamięć";
      const title = asString(body.title, "title") as string;
      const content = asString(body.content, "content") as string;
      const path =
        asString(body.path, "path", false) ??
        `agent/${auth.agentId}/${kind}-${this.idFactory()}.md`;
      const document = this.workspace.createDocument({
        title,
        path,
        content,
        sourceType: "API",
        sourceReference: auth.agentId,
      });
      json(response, 201, { status: "ZAPAMIĘTANO", document }, correlationId);
      return;
    }

    throw new ApiProblem(404, "NIE_ZNALEZIONO", "Nie znaleziono endpointu Brain API");
  }

  private authenticate(request: IncomingMessage): AuthContext {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) {
      throw new ApiProblem(401, "BRAK_UWIERZYTELNIENIA", "Wymagany jest lokalny token Bearer");
    }
    const token = header.slice("Bearer ".length);
    const credential = this.credentials.find((candidate) => safeTokenEqual(candidate.token, token));
    if (credential === undefined) {
      throw new ApiProblem(401, "NIEPRAWIDŁOWY_TOKEN", "Token dostępu jest nieprawidłowy");
    }
    return {
      agentId: credential.agentId,
      scopes: new Set(credential.scopes),
      tokenKey: credential.agentId,
    };
  }

  private requireScope(auth: AuthContext, scope: BrainApiScope): void {
    if (!auth.scopes.has(scope) && !auth.scopes.has("admin")) {
      throw new ApiProblem(403, "BRAK_UPRAWNIEŃ", `Token nie posiada wymaganego scope '${scope}'`);
    }
  }

  private enforceRate(auth: AuthContext, request: IncomingMessage): void {
    const now = this.now();
    const key = `${auth.tokenKey}:${request.method ?? "GET"}:${new URL(request.url ?? "/", "http://127.0.0.1").pathname}`;
    const current = this.rates.get(key);
    const entry =
      current === undefined || current.resetAt <= now
        ? { count: 0, resetAt: now + 60_000 }
        : current;
    entry.count += 1;
    this.rates.set(key, entry);
    if (entry.count > this.rateLimitPerMinute) {
      throw new ApiProblem(429, "LIMIT_ZAPYTAŃ", "Przekroczono lokalny limit zapytań Brain API");
    }
  }

  private applyCors(
    request: IncomingMessage,
    response: ServerResponse,
    correlationId: string,
  ): void {
    const origin = request.headers.origin;
    if (origin === undefined) return;
    if (!this.allowedOrigins.has(origin)) {
      throw new ApiProblem(
        403,
        "NIEDOZWOLONE_POCHODZENIE",
        "Pochodzenie żądania nie jest dozwolone",
      );
    }
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader(
      "access-control-allow-headers",
      "authorization, content-type, x-correlation-id",
    );
    response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.setHeader("x-correlation-id", correlationId);
  }

  private correlationId(request: IncomingMessage): string {
    const provided = request.headers["x-correlation-id"];
    return typeof provided === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(provided)
      ? provided
      : this.idFactory();
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer<ArrayBufferLike>[] = [];
    let size = 0;
    for await (const chunk of request) {
      const raw: unknown = chunk;
      if (!(raw instanceof Uint8Array)) {
        throw new ApiProblem(
          400,
          "NIEPRAWIDŁOWY_PAYLOAD",
          "Fragment żądania ma nieprawidłowy format",
        );
      }
      const buffer = Buffer.from(raw);
      size += buffer.length;
      if (size > this.maxBodyBytes) {
        throw new ApiProblem(413, "ZA_DUŻY_PAYLOAD", "Payload przekracza dozwolony limit");
      }
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new ApiProblem(400, "NIEPRAWIDŁOWY_JSON", "Treść żądania nie jest poprawnym JSON-em");
    }
  }
}
