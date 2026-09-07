import { z } from "zod";
import type { MemoryWrite } from "@neurosa/document-domain";
import type { NeurosaConnect } from "./index";

const nonempty = z.string().trim().min(1).max(500);
export const CONNECT_TOOL_SCHEMAS = {
  neurosa_start_session: z.object({
    sessionId: nonempty,
    projectId: nonempty,
    query: nonempty,
    maxChars: z.number().int().min(512).max(64000).default(12000),
  }),
  neurosa_recall: z.object({
    query: nonempty,
    maxChars: z.number().int().min(512).max(64000).default(12000),
  }),
  neurosa_remember: z.object({
    sessionId: nonempty,
    projectId: nonempty,
    title: nonempty,
    content: z.string().min(1).max(900000),
    kind: z.enum(["fact", "decision", "project", "event", "observation"]),
    idempotencyKey: nonempty,
    factKey: nonempty.optional(),
    expectedRevision: z.number().int().min(0).optional(),
  }),
  neurosa_complete_session: z.object({
    sessionId: nonempty,
    entries: z.array(z.record(z.string(), z.unknown())).max(100),
  }),
} as const;
const descriptions: Record<keyof typeof CONNECT_TOOL_SCHEMAS, string> = {
  neurosa_start_session:
    "Rozpocznij sesję przed pracą: pobierz aktualny stan, core context i relewantną pamięć NeurOSA.",
  neurosa_recall: "Pobierz aktualny, ograniczony kontekst ze wspólnego mózgu.",
  neurosa_remember:
    "Zapisz fakt, decyzję, stan projektu lub wydarzenie z identyfikatorem sesji i idempotencją.",
  neurosa_complete_session:
    "Atomowo zapisz wyniki i zakończ sesję. Nie wywołuj przed ukończeniem pracy.",
};
export function connectTools() {
  return Object.entries(CONNECT_TOOL_SCHEMAS).map(([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof CONNECT_TOOL_SCHEMAS],
    inputSchema: z.toJSONSchema(schema, { target: "draft-7" }),
  }));
}
export async function executeConnectTool(
  client: NeurosaConnect,
  name: string,
  args: unknown,
): Promise<unknown> {
  switch (name) {
    case "neurosa_start_session": {
      const value = CONNECT_TOOL_SCHEMAS.neurosa_start_session.parse(args);
      const session = await client.startSession(
        value.projectId,
        value.query,
        value.sessionId,
        value.maxChars,
      );
      return { session: session.session, context: session.context };
    }
    case "neurosa_recall": {
      const value = CONNECT_TOOL_SCHEMAS.neurosa_recall.parse(args);
      return client.recall(value.query, value.maxChars);
    }
    case "neurosa_remember": {
      const value = CONNECT_TOOL_SCHEMAS.neurosa_remember.parse(args);
      return client.remember(JSON.parse(JSON.stringify(value)) as MemoryWrite);
    }
    case "neurosa_complete_session": {
      const value = CONNECT_TOOL_SCHEMAS.neurosa_complete_session.parse(args);
      return client.complete(value.sessionId, value.entries as unknown as MemoryWrite[]);
    }
    default:
      throw new Error("Nieznane narzędzie NeurOSA");
  }
}

/** Provider-neutral schema projections; execution always calls the same Brain API. */
export function providerTools(provider: string): readonly unknown[] {
  const tools = connectTools();
  if (provider === "claude")
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  if (provider === "gemini")
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: t.inputSchema,
        })),
      },
    ];
  if (provider === "chatgpt" || provider === "grok")
    return tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  return tools;
}
