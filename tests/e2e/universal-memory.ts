import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

/** Real entrypoint + SQLite/WAL + separate installed-package agent processes. No LLM calls. */
export async function universalMemoryAcceptance(packagePath: string) {
  const directory = await mkdtemp(join(tmpdir(), "neurosa-universal-"));
  const token = randomUUID();
  const readerToken = randomUUID();
  const key = randomUUID();
  const nonce = `MemoryProof${randomUUID().replaceAll("-", "")}`;
  const content = `${nonce}: użytkownik buduje ekosystem OSA.`;
  const credentials = join(directory, "credentials.json");
  const checks: Record<string, unknown> = {};
  let child: ChildProcess | undefined;
  let logs = "";
  let url = "";
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith("NEUROSA_") || name.startsWith("OSA_NEUROSA_")) delete env[name];
  await writeFile(
    credentials,
    JSON.stringify([
      {
        token,
        agentId: "operator-testowy",
        scopes: ["brain:read", "memory:read", "memory:write", "events:read"],
      },
      { token: readerToken, agentId: "hermes-readonly", scopes: ["brain:read", "memory:read"] },
    ]),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );

  async function stop() {
    const current = child;
    child = undefined;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        current.kill("SIGKILL");
        reject(new Error("Testowy proces nie zakończył się w limicie"));
      }, 8000);
      current.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) done();
        else reject(new Error("Nieprawidłowe zakończenie testowego API"));
      });
      current.kill("SIGTERM");
    });
  }
  async function start() {
    child = spawn(process.execPath, ["--import", "tsx", "apps/brain-api/src/server.ts"], {
      cwd: root,
      env: {
        ...env,
        NEUROSA_API_HOST: "127.0.0.1",
        NEUROSA_API_PORT: "0",
        NEUROSA_ALLOW_REMOTE: "false",
        NEUROSA_DATABASE_PATH: join(directory, "brain.db"),
        NEUROSA_CREDENTIALS_FILE: credentials,
        NEUROSA_BRAIN_SOURCE: "examples/minimal-brain/brain.nsa",
        NEUROSA_MEMORY_NAMESPACE: "osa",
        NEUROSA_ORGANIZATION_ID: "osa",
        NEUROSA_PROJECT_ID: "osa",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const current = child;
    current.stderr?.on("data", (data: Buffer) => {
      logs += data.toString();
    });
    let startup = "";
    url = await new Promise<string>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Testowy Brain API nie wystartował")), 15000);
      current.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      current.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Testowy Brain API zakończył pracę przed startem"));
      });
      current.stdout?.on("data", (data: Buffer) => {
        logs += data.toString();
        startup += data.toString();
        const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(startup);
        if (match) {
          clearTimeout(timer);
          done(match[0]);
        }
      });
    });
  }
  const headers = () => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-neurosa-brain-id": "OsaBrain",
    "x-neurosa-organization-id": "osa",
    "x-neurosa-project-id": "osa",
    "x-neurosa-namespace": "osa",
  });
  async function raw(path: string) {
    const response = await fetch(`${url}/api/v1/${path}`, {
      headers: headers(),
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as Record<string, unknown>;
  }
  async function agent(action: string, overrides: Record<string, string> = {}) {
    const code = `import { createNeurosaMemory } from "@osatech/neurosa-memory";
      const e = process.env;
      const memory = createNeurosaMemory({ endpoint:e.TEST_ENDPOINT, token:e.TEST_TOKEN, brainId:"OsaBrain", namespace:e.TEST_NAMESPACE, timeoutMs:1000 });
      const action = e.TEST_ACTION;
      let result;
      if (action === "remember") result = await memory.remember({agentId:"jeverson",content:e.TEST_CONTENT,idempotencyKey:e.TEST_KEY});
      else if (action === "recall") result = await memory.recall({agentId:"hermes",query:e.TEST_QUERY});
      else if (action === "fallback") { const context = await memory.beforeMessage({agentId:"hermes",message:e.TEST_QUERY}); result = {context, chatResult: "Zwykła rozmowa może trwać bez pamięci"}; }
      else if (action === "deny") { try { await memory.remember({agentId:"admin",content:e.TEST_CONTENT}); result={denied:false}; } catch(error) { result={denied:true,status:error.status}; } }
      else if (action === "health-deny") { try { await memory.health(); result={denied:false}; } catch(error) { result={denied:true,status:error.status}; } }
      else result = await memory.health();
      console.log(JSON.stringify(result));`;
    const result = await exec(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: directory,
      env: {
        ...env,
        TEST_ENDPOINT: url,
        TEST_TOKEN: token,
        TEST_NAMESPACE: "osa",
        TEST_CONTENT: content,
        TEST_KEY: key,
        TEST_QUERY: nonce,
        TEST_ACTION: action,
        ...overrides,
      },
      timeout: 10000,
    });
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }
  try {
    await exec(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", resolve(packagePath)],
      { cwd: directory, env, timeout: 30000 },
    );
    const consumer = join(directory, "consumer.ts");
    await writeFile(
      consumer,
      'import { createNeurosaMemory, type NeurosaMemory, type RecallResult } from "@osatech/neurosa-memory";\nconst memory: NeurosaMemory = createNeurosaMemory({ endpoint: "https://memory.invalid", token: "unused-for-typecheck-123456789", brainId: "OsaBrain", namespace: "osa" });\nconst result: Promise<RecallResult> = memory.recall({ agentId: "hermes", query: "test" });\nvoid result;\n',
    );
    await exec(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--module",
        "NodeNext",
        "--target",
        "ES2022",
        consumer,
      ],
      { cwd: directory, env, timeout: 30000 },
    );
    checks.TYPESCRIPT_INSTALL = { status: "PASS", noWorkspaceDependencies: true };
    await start();
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const health = await agent("health");
    assert.equal(health.status, "OK");
    checks.T01 = {
      status: "PASS",
      mode: "LIVE_LOCAL_PROCESS",
      service: "NEUROSA-HB Brain API",
      brainId: health.brainId,
      operationId: health.operationId,
    };
    const first = await agent("remember");
    assert.equal(first.deduplicated, false);
    checks.T02 = {
      status: "PASS",
      writer: "jeverson",
      documentId: first.documentId,
      operationId: first.operationId,
    };
    const eventsBefore = await raw("brain/events");
    const retry = await agent("remember");
    assert.equal(retry.documentId, first.documentId);
    assert.equal(retry.deduplicated, true);
    assert.deepEqual(await raw("brain/events"), eventsBefore);
    checks.T03 = { status: "PASS", sameDocument: true, unchangedLedger: true };
    const recalled = await agent("recall");
    assert.ok(String(recalled.text).includes(content));
    const sources = recalled.sources as Record<string, unknown>[];
    assert.equal(sources[0]?.documentId, first.documentId);
    assert.equal(sources[0]?.sourceReference, "jeverson");
    checks.T04 = {
      status: "PASS",
      reader: "hermes",
      freshNodeProcess: true,
      chatHistoryProvided: false,
      operationId: recalled.operationId,
    };
    const document = await raw(`documents/${String(first.documentId)}`);
    const hash = createHash("sha256").update(String(document.content)).digest("hex");
    assert.equal(hash, first.contentHash);
    assert.equal(hash, sources[0]?.contentHash);
    assert.equal((await raw("brain/ledger/verify")).valid, true);
    const events = eventsBefore.events as { eventType: string; payload: Record<string, unknown> }[];
    assert.ok(
      events.some(
        (event) =>
          event.eventType === "MEMORY_WRITTEN" &&
          event.payload.documentId === first.documentId &&
          event.payload.contentHash === hash,
      ),
    );
    checks.T05 = {
      status: "PASS",
      documentId: first.documentId,
      contentHash: hash,
      ledger: "SERVER_VALIDATED",
      externalAttestation: false,
    };
    const python = await exec(
      "python3",
      [
        "-c",
        "import json, os, runpy; connector=runpy.run_path(os.environ['TEST_PYTHON_CONNECTOR']); print(json.dumps(connector['recall']('hermes-python', os.environ['TEST_PYTHON_QUERY'])))",
      ],
      {
        cwd: directory,
        env: {
          ...env,
          NEUROSA_API_URL: url,
          NEUROSA_API_TOKEN: readerToken,
          TEST_PYTHON_QUERY: nonce,
          TEST_PYTHON_CONNECTOR: join(
            directory,
            "node_modules/@osatech/neurosa-memory/examples/memory.py",
          ),
        },
        timeout: 10000,
      },
    );
    const pythonResult = JSON.parse(python.stdout) as {
      sources: { documentId: string; contentHash: string }[];
    };
    assert.equal(pythonResult.sources[0]?.documentId, first.documentId);
    assert.equal(pythonResult.sources[0]?.contentHash, hash);
    checks.HTTP_PYTHON = { status: "PASS", sameSourceAsJavaScript: true, tokenScope: "read-only" };
    assert.deepEqual(await agent("health-deny", { TEST_TOKEN: randomUUID() }), {
      denied: true,
      status: 401,
    });
    assert.deepEqual(await agent("health-deny", { TEST_NAMESPACE: "foreign" }), {
      denied: true,
      status: 403,
    });
    assert.deepEqual(await agent("deny", { TEST_TOKEN: readerToken }), {
      denied: true,
      status: 403,
    });
    checks.T06 = {
      status: "PASS",
      wrongToken: 401,
      foreignNamespace: 403,
      provenanceDoesNotGrantWrite: 403,
    };
    await stop();
    const fallback = await agent("fallback");
    assert.equal((fallback.context as Record<string, unknown>).status, "UNAVAILABLE");
    assert.equal((fallback.context as Record<string, unknown>).text, "");
    assert.ok(fallback.chatResult);
    checks.T07 = {
      status: "PASS",
      memoryStatus: "UNAVAILABLE",
      ordinaryHostCallbackContinues: true,
      fakeMemory: false,
      modelCalls: 0,
    };
    await start();
    const afterRestart = await agent("recall");
    assert.ok(String(afterRestart.text).includes(content));
    assert.deepEqual(afterRestart.sources, sources);
    const finalRetry = await agent("remember");
    assert.equal(finalRetry.deduplicated, true);
    assert.equal(((await raw("documents")).documents as unknown[]).length, 1);
    checks.T08 = {
      status: "PASS",
      restart: "SIGTERM then new process, same SQLite/WAL",
      sameSourceAndHash: true,
      idempotencySurvivesRestart: true,
      documents: 1,
    };
    await stop();
    assert.equal(logs.includes(token) || logs.includes(readerToken), false);
    const inputFiles = await exec(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "packages",
        "apps/brain-api",
        "apps/neurosa-connect",
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "tests/connect/universal-memory.test.ts",
        "tests/e2e/universal-memory.ts",
      ],
      { cwd: root },
    );
    const sourceHash = createHash("sha256");
    for (const file of [...new Set(inputFiles.stdout.trim().split("\n"))].sort())
      sourceHash
        .update(file)
        .update("\0")
        .update(await readFile(join(root, file)))
        .update("\0");
    return {
      schema: "neurosa.universal-memory.acceptance.v0.1",
      status: "PASS",
      recordedAt: new Date().toISOString(),
      backend: "canonical BrainApiServer + SqliteRuntimeRepository",
      backendAndConnectorSourceSha256: sourceHash.digest("hex"),
      nodeVersion: process.version,
      environment: "isolated local process, temporary SQLite/WAL",
      cloudAzure: "NOT_TESTED: endpoint and credential unavailable in this session",
      installation: "offline npm install of the packed package into a clean temporary project",
      packageSha256: createHash("sha256")
        .update(await readFile(packagePath))
        .digest("hex"),
      modelCalls: 0,
      tokensInLogs: false,
      checks,
    };
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Podaj ścieżkę do zbudowanego pakietu .tgz");
  const result = await universalMemoryAcceptance(resolve(process.argv[2]));
  if (process.argv[3]) {
    const output = resolve(process.argv[3]);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  }
  console.log(JSON.stringify(result, null, 2));
}
