import { createHash, randomUUID } from "node:crypto";
import { BrainConnectionError, NeurosaConnect } from "@neurosa/connect";
import { z } from "zod";
import type { MemoryIntegrity, NeurosaMemory, NeurosaMemoryOptions } from "./types.js";
import type { PairingOptions } from "./pairing.js";
import { loadConnection } from "./connection.js";

export type * from "./types.js";
export type { PairingOptions } from "./pairing.js";

export async function connectNeurosaMemory(options: PairingOptions): Promise<NeurosaMemory> {
  // Cached credentials allow an optional hook to handle outages in a fresh session.
  // Only health/read/write operations report backend availability.
  return createNeurosaMemory(await loadConnection(options));
}

const label = z.string().trim().min(1).max(200);
const rememberSchema = z
  .object({
    agentId: label,
    content: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value) <= 128 * 1024),
    title: z.string().trim().min(1).max(500).optional(),
    idempotencyKey: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
const recallSchema = z
  .object({
    agentId: label,
    query: z.string().trim().min(1).max(12000),
    maxChars: z.number().int().min(512).max(64000).optional(),
  })
  .strict();
const ackSchema = z.object({
  brainId: z.string(),
  ledgerValid: z.literal(true),
  operationId: z.string().min(1),
  memoryScope: z.object({ organizationId: label, projectId: label, namespace: label }),
  deduplicated: z.boolean(),
  document: z.object({
    documentId: z.string().min(1),
    content: z.string(),
    contentHash: z.string(),
    revision: z.number().int().min(1),
    sourceReference: z.string().nullable(),
  }),
});

/** Server-side facade over the existing NeurOSA Connect transport; stores nothing locally. */
export function createNeurosaMemory(options: NeurosaMemoryOptions): NeurosaMemory {
  if ("window" in globalThis && "document" in globalThis)
    throw new Error("NeurOSA wymaga backendu; token nie może trafić do przeglądarki");
  const namespace = label.parse(options.namespace);
  const brainId = options.brainId;
  const scope = Object.freeze({
    namespace,
    organizationId: label.parse(options.organizationId ?? namespace),
    projectId: label.parse(options.projectId ?? namespace),
  });
  const writePolicy = options.writePolicy;
  const client = new NeurosaConnect({
    baseUrl: options.endpoint,
    token: options.token,
    brainId: options.brainId,
    provider: "other",
    memoryScope: scope,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const integrity = (hasSources: boolean): MemoryIntegrity => ({
    status: hasSources ? "CONTENT_HASH_CHECKED" : "NO_SOURCES",
    ledger: "SERVER_VALIDATED",
    externalAttestation: false,
  });
  const invalid = () =>
    new BrainConnectionError(
      409,
      "Odrzucono niespójną odpowiedź pamięci",
      "NEUROSA_INTEGRITY_REJECTED",
    );
  const api: NeurosaMemory = {
    async health() {
      const result = await client.health();
      if (!result.operationId) throw invalid();
      return {
        status: "OK",
        brainId: result.brainId,
        scope,
        operationId: result.operationId,
        ledger: "SERVER_VALIDATED",
      };
    },
    async remember(input) {
      const value = rememberSchema.parse(input);
      const idempotencyKey = value.idempotencyKey ?? randomUUID();
      const parsed = ackSchema.safeParse(
        await client.remember({
          originAgentId: value.agentId,
          title: value.title ?? `Pamięć (${value.agentId})`,
          content: value.content,
          projectId: scope.projectId,
          idempotencyKey,
        }),
      );
      if (!parsed.success) throw invalid();
      const result = parsed.data;
      if (
        result.brainId !== brainId ||
        (Object.keys(scope) as (keyof typeof scope)[]).some(
          (key) => result.memoryScope[key] !== scope[key],
        ) ||
        result.document.content !== value.content ||
        result.document.sourceReference !== value.agentId ||
        createHash("sha256").update(result.document.content).digest("hex") !==
          result.document.contentHash
      )
        throw invalid();
      return {
        documentId: result.document.documentId,
        contentHash: result.document.contentHash,
        revision: result.document.revision,
        brainId: result.brainId,
        operationId: result.operationId,
        idempotencyKey,
        deduplicated: result.deduplicated,
        integrity: integrity(true),
      };
    },
    async recall(input) {
      const value = recallSchema.parse(input);
      const result = await client.recall(value.query, value.maxChars);
      if (!result.operationId || !/^[a-f0-9]{64}$/u.test(result.ledgerHead)) throw invalid();
      return {
        text: result.text,
        sources: result.references.map((ref) => ({
          documentId: ref.documentId,
          revision: ref.revision,
          contentHash: ref.contentHash,
          sourceReference: ref.sourceReference,
          title: ref.title!,
          content: ref.excerpt!,
        })),
        brainId: result.brainId,
        scope,
        operationId: result.operationId,
        ledgerHead: result.ledgerHead,
        integrity: integrity(result.references.length > 0),
        truncated: result.truncated,
        untrusted: true,
      };
    },
    async beforeMessage(input) {
      try {
        const result = await api.recall({
          agentId: input.agentId,
          query: input.message,
          ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
        });
        return { ...result, status: result.sources.length ? "AVAILABLE" : "EMPTY" };
      } catch (error) {
        if (input.required) throw error;
        if (error instanceof z.ZodError)
          return {
            status: "UNAVAILABLE",
            untrusted: true,
            text: "",
            sources: [],
            error: {
              code: "NEUROSA_INVALID_REQUEST",
              status: 400,
              message: "Nieprawidłowe zapytanie pamięci",
            },
          };
        if (!(error instanceof BrainConnectionError)) throw error;
        return {
          status: "UNAVAILABLE",
          untrusted: true,
          text: "",
          sources: [],
          error: { code: error.code, status: error.status, message: error.message },
        };
      }
    },
    async afterMessage(input) {
      if (!writePolicy) return { status: "SKIPPED", reason: "EXPLICIT_REMEMBER_REQUIRED" };
      const value = await writePolicy(Object.freeze({ ...input }));
      if (value === null) return { status: "SKIPPED", reason: "POLICY_DECLINED" };
      return { status: "SAVED", memory: await api.remember({ ...value, agentId: input.agentId }) };
    },
  };
  return Object.freeze(api);
}
