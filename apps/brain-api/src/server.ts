import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BrainApiServer, type BrainApiScope } from "@neurosa/brain-api";
import { compileSource } from "@neurosa/compiler";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { SqliteRuntimeRepository } from "@neurosa/storage";

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

const token = process.env.NEUROSA_API_TOKEN;
if (token === undefined) {
  throw new Error("Ustaw NEUROSA_API_TOKEN o długości co najmniej 24 znaków");
}

const sourcePath = resolve(process.env.NEUROSA_BRAIN_SOURCE ?? "examples/minimal-brain/brain.nsa");
const databasePath = resolve(process.env.NEUROSA_DATABASE_PATH ?? ".neurosa/brain.db");
const source = await readFile(sourcePath, "utf8");
const compilation = compileSource(source, sourcePath);
const repository = new SqliteRuntimeRepository(databasePath);
const runtime = new NeurosaRuntime(repository);
runtime.load(compilation.ir);

const server = new BrainApiServer(runtime, repository, {
  credentials: [
    {
      token,
      agentId: process.env.NEUROSA_AGENT_ID ?? "operator-localny",
      scopes: scopesFromEnv(),
    },
  ],
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
