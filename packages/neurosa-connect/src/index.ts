import { createHash, randomUUID } from "node:crypto";
import type { AgentSession, MemoryWrite, MemoryScope } from "@neurosa/document-domain";
import { z } from "zod";

export const CONNECT_PROVIDERS = ["chatgpt", "claude", "gemini", "grok", "osa", "other"] as const;
const scopeSchema = z
  .object({
    organizationId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    namespace: z.string().min(1).max(200),
  })
  .strict();
const referenceSchema = z.object({
  documentId: z.string().min(1),
  revision: z.number().int().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceReference: z.string().nullable(),
  core: z.boolean(),
  title: z.string().optional(),
  excerpt: z.string().optional(),
  offset: z.number().int().min(0).optional(),
});
const contextSchema = z.object({
  brainId: z.string(),
  ledgerValid: z.boolean(),
  text: z.string(),
  ledgerHead: z.string(),
  references: z.array(referenceSchema),
  truncated: z.boolean(),
  memoryScope: scopeSchema.optional(),
  operationId: z.string().min(1).optional(),
});
const statusSchema = z.object({
  brainId: z.string(),
  ledgerValid: z.boolean(),
  ledgerHead: z.string().optional(),
  memoryScope: scopeSchema.optional(),
  operationId: z.string().min(1).optional(),
});
export type BrainHealth = z.infer<typeof statusSchema>;
export type BrainContext = z.infer<typeof contextSchema>;
const sessionSchema = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  projectId: z.string(),
  provider: z.string(),
  status: z.enum(["OPEN", "COMPLETED"]),
  createdAt: z.string(),
  completedAt: z.string().optional(),
});
export class BrainConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "NEUROSA_ERROR",
  ) {
    super(message);
  }
}
export interface ConnectOptions {
  readonly memoryScope?: MemoryScope;
  readonly baseUrl: string;
  readonly token: string;
  readonly brainId: string;
  readonly provider: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}
export class NeurosaConnect {
  private readonly options: ConnectOptions;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly url: string;
  constructor(options: ConnectOptions) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Nieprawidłowy adres Brain API");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
      throw new Error("Zdalne Brain API wymaga HTTPS");
    if (options.token.length < 24 || !options.brainId.trim() || !options.provider.trim())
      throw new Error("Wymagane token, brainId i provider");
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000)
    )
      throw new Error("Timeout NeurOSA: 1–60000 ms");
    this.options = Object.freeze({
      ...options,
      ...(options.memoryScope
        ? { memoryScope: Object.freeze(scopeSchema.parse(options.memoryScope)) }
        : {}),
    });
    this.url = options.baseUrl.replace(/\/+$/u, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    try {
      const response = await this.fetcher(`${this.url}/api/v1/${path}`, {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
          "x-neurosa-brain-id": this.options.brainId,
          ...(this.options.memoryScope
            ? {
                "x-neurosa-organization-id": encodeURIComponent(
                  this.options.memoryScope.organizationId,
                ),
                "x-neurosa-project-id": encodeURIComponent(this.options.memoryScope.projectId),
                "x-neurosa-namespace": encodeURIComponent(this.options.memoryScope.namespace),
              }
            : {}),
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new BrainConnectionError(
          response.status,
          `NeurOSA: HTTP ${response.status}`,
          response.status === 401 || response.status === 403
            ? "NEUROSA_ACCESS_DENIED"
            : "NEUROSA_HTTP_ERROR",
        );
      }
      if (response.status === 204) return null;
      if (!response.body)
        throw new BrainConnectionError(502, "Brak odpowiedzi NeurOSA", "NEUROSA_INVALID_RESPONSE");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1024 * 1024) {
            await reader.cancel();
            throw new BrainConnectionError(
              502,
              "Odpowiedź NeurOSA przekracza 1 MiB",
              "NEUROSA_RESPONSE_TOO_LARGE",
            );
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        throw new BrainConnectionError(
          502,
          "Nieprawidłowy JSON NeurOSA",
          "NEUROSA_INVALID_RESPONSE",
        );
      }
    } catch (error) {
      if (error instanceof BrainConnectionError) throw error;
      throw new BrainConnectionError(0, "Nie można połączyć się z NeurOSA", "NEUROSA_UNAVAILABLE");
    }
  }
  private checkBinding(result: {
    brainId: string;
    ledgerValid: boolean;
    memoryScope?: MemoryScope | undefined;
  }): void {
    if (result.brainId !== this.options.brainId || !result.ledgerValid)
      throw new BrainConnectionError(
        409,
        "Nieprawidłowy mózg lub uszkodzony ledger",
        "NEUROSA_INTEGRITY_REJECTED",
      );
    const scope = this.options.memoryScope;
    if (
      scope &&
      (!result.memoryScope ||
        (Object.keys(scope) as (keyof MemoryScope)[]).some(
          (key) => result.memoryScope![key] !== scope[key],
        ))
    )
      throw new BrainConnectionError(
        403,
        "Brak zgodnego serwerowego scope pamięci",
        "NEUROSA_SCOPE_REJECTED",
      );
  }
  async health(): Promise<BrainHealth> {
    const parsed = statusSchema.safeParse(await this.request("brain/status"));
    if (!parsed.success)
      throw new BrainConnectionError(
        502,
        "Nieprawidłowy status NeurOSA",
        "NEUROSA_INVALID_RESPONSE",
      );
    this.checkBinding(parsed.data);
    return parsed.data;
  }
  async status(): Promise<void> {
    await this.health();
  }
  async recall(query: string, maxChars = 12000): Promise<BrainContext> {
    const parsed = contextSchema.safeParse(
      await this.request("brain/recall", "POST", { query, includeCore: true, maxChars }),
    );
    if (!parsed.success)
      throw new BrainConnectionError(
        502,
        "Nieprawidłowy kontekst NeurOSA",
        "NEUROSA_INVALID_RESPONSE",
      );
    const context = parsed.data;
    this.checkBinding(context);
    if (context.text.length > maxChars)
      throw new BrainConnectionError(
        502,
        "Przekroczony budżet kontekstu",
        "NEUROSA_INVALID_RESPONSE",
      );
    if (this.options.memoryScope) {
      for (const ref of context.references) {
        const document = z
          .object({
            documentId: z.string(),
            revision: z.number(),
            contentHash: z.string(),
            content: z.string(),
            title: z.string(),
            sourceReference: z.string().nullable(),
          })
          .safeParse(await this.request(`documents/${encodeURIComponent(ref.documentId)}`));
        if (
          !document.success ||
          document.data.documentId !== ref.documentId ||
          document.data.revision !== ref.revision ||
          document.data.contentHash !== ref.contentHash ||
          createHash("sha256").update(document.data.content).digest("hex") !== ref.contentHash ||
          ref.excerpt === undefined ||
          ref.offset === undefined ||
          ref.title !== document.data.title ||
          ref.sourceReference !== document.data.sourceReference ||
          document.data.content.slice(ref.offset, ref.offset + ref.excerpt.length) !== ref.excerpt
        )
          throw new BrainConnectionError(
            409,
            "Niespójna treść źródła NeurOSA",
            "NEUROSA_INTEGRITY_REJECTED",
          );
      }
      // Only verified excerpts can become agent context, never arbitrary remote text.
      context.text = context.references
        .map((ref) => `[${ref.documentId} r${ref.revision}] ${ref.title!}\n${ref.excerpt!}`)
        .join("\n\n");
      if (context.text.length > maxChars)
        throw new BrainConnectionError(
          502,
          "Przekroczony budżet źródeł",
          "NEUROSA_INVALID_RESPONSE",
        );
    }
    return context;
  }
  async startSession(
    projectId: string,
    query: string,
    sessionId: string = randomUUID(),
    maxChars = 12000,
  ): Promise<ConnectedSession> {
    await this.status();
    const raw = sessionSchema.parse(
      await this.request("sessions", "POST", {
        sessionId,
        projectId,
        provider: this.options.provider,
      }),
    );
    if (raw.status !== "OPEN") throw new Error("Sesja jest już zakończona; użyj nowego sessionId");
    const session = JSON.parse(JSON.stringify(raw)) as AgentSession;
    return new ConnectedSession(this, session, await this.recall(query, maxChars));
  }
  async remember(input: MemoryWrite): Promise<unknown> {
    await this.status();
    return this.request("brain/remember", "POST", input);
  }
  async observe(input: MemoryWrite): Promise<unknown> {
    await this.status();
    return this.request("brain/observe", "POST", input);
  }
  async complete(sessionId: string, entries: readonly MemoryWrite[]): Promise<unknown> {
    await this.status();
    return this.request(`sessions/${encodeURIComponent(sessionId)}/complete`, "POST", { entries });
  }
  /** Hooks around a model/agent callback. A failed task leaves an OPEN session for recovery. */
  async runSession<T>(
    projectId: string,
    query: string,
    work: (
      context: BrainContext,
      session: ConnectedSession,
    ) => Promise<{ result: T; memories: readonly MemoryWrite[] }>,
    sessionId?: string,
  ): Promise<T> {
    const session = await this.startSession(projectId, query, sessionId);
    const output = await work(session.context, session);
    await session.complete(output.memories);
    return output.result;
  }
}
export class ConnectedSession {
  constructor(
    private readonly client: NeurosaConnect,
    readonly session: AgentSession,
    public context: BrainContext,
  ) {}
  async recall(query: string, maxChars = 12000): Promise<BrainContext> {
    this.context = await this.client.recall(query, maxChars);
    return this.context;
  }
  remember(input: MemoryWrite): Promise<unknown> {
    return this.client.remember({
      ...input,
      projectId: this.session.projectId,
      sessionId: this.session.sessionId,
    });
  }
  complete(entries: readonly MemoryWrite[]): Promise<unknown> {
    return this.client.complete(this.session.sessionId, entries);
  }
}
