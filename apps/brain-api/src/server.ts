import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BRAIN_API_SCOPES,
  BrainApiServer,
  type BrainApiScope,
  type BrainApiCredential,
} from "@neurosa/brain-api";
import { compileSource } from "@neurosa/compiler";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { SqliteRuntimeRepository } from "@neurosa/storage";
import { z } from "zod";
import { listenOptions } from "./config.js";

const listen = listenOptions(process.env);

function scopesFromEnv(): BrainApiScope[] {
  const raw = process.env.NEUROSA_API_SCOPES ?? "admin";
  return raw
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean) as BrainApiScope[];
}

const credentialFile = process.env.NEUROSA_CREDENTIALS_FILE;
let credentials: readonly BrainApiCredential[];
if (credentialFile !== undefined) {
  const schema = z
    .array(
      z
        .object({
          token: z.string().min(24),
          agentId: z.string().min(1).max(200),
          scopes: z.array(z.enum(BRAIN_API_SCOPES)),
        })
        .strict(),
    )
    .min(1);
  credentials = schema.parse(
    JSON.parse(await readFile(resolve(credentialFile), "utf8")) as unknown,
  );
  if (
    new Set(credentials.map((c) => c.token)).size !== credentials.length ||
    new Set(credentials.map((c) => c.agentId)).size !== credentials.length
  )
    throw new Error("Każdy klient wymaga osobnego tokenu i agentId");
} else {
  const token = process.env.NEUROSA_API_TOKEN;
  if (token === undefined) throw new Error("Ustaw NEUROSA_API_TOKEN lub NEUROSA_CREDENTIALS_FILE");
  credentials = [
    { token, agentId: process.env.NEUROSA_AGENT_ID ?? "operator-localny", scopes: scopesFromEnv() },
  ];
  const extra = process.env.NEUROSA_STAGING_PREVIEW_TOKEN;
  if (extra !== undefined) {
    if (
      process.env.RAILWAY_PROJECT_ID !== "bbfcceb0-cef8-422b-8eb9-b1761b2a670d" ||
      process.env.RAILWAY_ENVIRONMENT_NAME !== "staging" ||
      extra.length < 32 ||
      extra === token ||
      credentials[0]!.agentId === "osa-proof-preview-staging"
    )
      throw new Error("Nieprawidłowy dodatkowy dostęp staging");
    credentials = [
      ...credentials,
      {
        token: extra,
        agentId: "osa-proof-preview-staging",
        scopes: ["brain:read", "memory:read", "memory:write"],
      },
    ];
  }
}

const sourcePath = resolve(process.env.NEUROSA_BRAIN_SOURCE ?? "examples/minimal-brain/brain.nsa");
const databasePath = resolve(process.env.NEUROSA_DATABASE_PATH ?? ".neurosa/brain.db");
const source = await readFile(sourcePath, "utf8");
const compilation = compileSource(source, sourcePath);
const repository = new SqliteRuntimeRepository(databasePath);
const runtime = new NeurosaRuntime(repository);
runtime.load(compilation.ir);

const server = new BrainApiServer(runtime, repository, {
  credentials,
  allowedOrigins: (process.env.NEUROSA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
});

const address = await server.start(listen);

console.log(`NEUROSA-HB Brain API nasłuchuje: ${address.url}`);
console.log(`Mózg: ${compilation.ir.brainId}`);
console.log(`Baza: ${databasePath}`);

// Opt-in staging-only integration probe. Never enabled in production.
// The test uses the running Brain API and its current isolated DB.
// Print only verdict booleans, never tokens, memory contents, or URLs.
const stagingSmokeProject =
  process.env.RAILWAY_PROJECT_ID === "bbfcceb0-cef8-422b-8eb9-b1761b2a670d" &&
  process.env.RAILWAY_ENVIRONMENT_NAME === "staging" &&
  process.env.NEUROSA_DATABASE_PATH === "/data/brain.db";
console.log(
  "NEUROSA_STAGING_SMOKE_CONFIG " +
    (stagingSmokeProject ? "ENABLED" : "DISABLED") +
    " FLAG_" +
    (process.env.NEUROSA_STAGING_MEMORY_SMOKE === "enabled" ? "ENABLED" : "NOT_ENABLED"),
);
if (stagingSmokeProject) {
  void import("./staging-memory-smoke.js")
    .then(({ runStagingMemorySmoke }) =>
      runStagingMemorySmoke({
        origin: "http://127.0.0.1:" + (process.env.NEUROSA_API_PORT ?? process.env.PORT ?? "8080"),
        token: credentials[0]!.token,
        brainId: compilation.ir.brainId,
      }),
    )
    .then((result) => console.log("NEUROSA_STAGING_LIVE_MEMORY_E2E " + result.result))
    .catch(() => console.error("NEUROSA_STAGING_LIVE_MEMORY_E2E FAIL"));
}

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  runtime.close();
}

process.once("SIGINT", () => {
  void close().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().then(() => process.exit(0));
});
