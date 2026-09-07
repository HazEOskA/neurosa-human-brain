import { randomUUID } from "node:crypto";
import type { AgentSession, MemoryWrite } from "@neurosa/document-domain";
import { z } from "zod";

export const CONNECT_PROVIDERS = ["chatgpt", "claude", "gemini", "grok", "osa", "other"] as const;
const contextSchema = z.object({
  brainId: z.string(),
  ledgerValid: z.boolean(),
  text: z.string(),
  ledgerHead: z.string(),
  references: z.array(z.unknown()),
  truncated: z.boolean(),
});
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
  ) {
    super(message);
  }
}
export interface ConnectOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly brainId: string;
  readonly provider: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}
export class NeurosaConnect {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly url: string;
  constructor(private readonly options: ConnectOptions) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Nieprawidłowy adres Brain API");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
      throw new Error("Zdalne Brain API wymaga HTTPS");
    if (options.token.length < 24 || !options.brainId.trim() || !options.provider.trim())
      throw new Error("Wymagane token, brainId i provider");
    this.url = options.baseUrl.replace(/\/+$/u, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`${this.url}/api/v1/${path}`, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        "x-neurosa-brain-id": this.options.brainId,
      },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as { message?: unknown } | null;
      throw new BrainConnectionError(
        response.status,
        typeof result?.message === "string" ? result.message : `Brain API: HTTP ${response.status}`,
      );
    }
    if (response.status === 204) return null;
    return response.json() as Promise<unknown>;
  }
  async status(): Promise<void> {
    const result = z
      .object({ brainId: z.string(), ledgerValid: z.boolean() })
      .parse(await this.request("brain/status"));
    if (result.brainId !== this.options.brainId || !result.ledgerValid)
      throw new Error("Nieprawidłowy mózg lub uszkodzony ledger");
  }
  async recall(query: string, maxChars = 12000): Promise<BrainContext> {
    const context = contextSchema.parse(
      await this.request("brain/recall", "POST", { query, includeCore: true, maxChars }),
    );
    if (context.brainId !== this.options.brainId || !context.ledgerValid)
      throw new Error("Nieprawidłowy mózg lub uszkodzony ledger");
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
