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

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`Zmienna ${name} musi być poprawnym numerem portu`);
  }
  return value;
}

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

const address = await server.start({
  host: "127.0.0.1",
  port: numberFromEnv("NEUROSA_API_PORT", 8644),
});

console.log(`NEUROSA-HB Brain API działa lokalnie: ${address.url}`);
console.log(`Mózg: ${compilation.ir.brainId}`);
console.log(`Baza: ${databasePath}`);

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
