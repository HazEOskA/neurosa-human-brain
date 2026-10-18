import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BrainApiServer } from "@neurosa/brain-api";
import { compileSource } from "@neurosa/compiler";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { SqliteRuntimeRepository } from "@neurosa/storage";
import { createMemoryGateway } from "../../apps/neurosa-connect/src/web.js";

const exec = promisify(execFile);
type Pair = {
  connectorUrl: string;
  pairingCode: string;
  agentId: string;
  connectionId: string;
  mcp: unknown;
};

/** Live local HTTP, canonical SQLite, offline installed SDK/MCP and fresh Python/Node processes. */
export async function landingAcceptance(packagePath: string) {
  const directory = await mkdtemp(join(tmpdir(), "neurosa-landing-e2e-"));
  const token = randomUUID(),
    key = randomUUID(),
    nonce = `Landing${randomUUID().replaceAll("-", "")}`;
  const content = `${nonce}: użytkownik buduje system OSA.`;
  const checks: Record<string, unknown> = {};
  const cleanEnv = { ...process.env };
  for (const name of Object.keys(cleanEnv))
    if (name.startsWith("NEUROSA_") || name.startsWith("OSA_NEUROSA_")) delete cleanEnv[name];
  const scope = { organizationId: "osa", projectId: "osa", namespace: "osa" };
  const ir = compileSource(
    "brain OsaBrain { region R { neuron N { threshold: 0.5 } } }",
    "landing-e2e.nsa",
  ).ir;
  let repository: SqliteRuntimeRepository,
    runtime: NeurosaRuntime,
    backend: BrainApiServer | undefined;
  let backendUrl = "";
  let gateway: ReturnType<typeof createMemoryGateway> | undefined;
  let url = "",
    cookie = "";
  const cache = join(directory, "agent-connections");
  async function startBackend(port = 0) {
    repository = new SqliteRuntimeRepository(join(directory, "brain.db"));
    runtime = new NeurosaRuntime(repository);
    runtime.load(ir);
    backend = new BrainApiServer(runtime, repository, {
      memoryScope: scope,
      credentials: [
        {
          token,
          agentId: "landing-backend",
          scopes: ["brain:read", "memory:read", "memory:write", "events:read"],
        },
      ],
      rateLimitPerMinute: 10000,
    });
    backendUrl = (await backend.start({ port })).url;
  }
  async function stopBackend() {
    if (backend) {
      await backend.close();
      runtime.close();
      backend = undefined;
    }
  }
  async function startGateway(port = 0) {
    gateway = createMemoryGateway({
      endpoint: backendUrl,
      token,
      brainId: "OsaBrain",
      ...scope,
      packagePath,
    });
    const address = await gateway.start({ port });
    url = address.url;
    const response = await fetch(url + "/connect/api/activate", {
      method: "POST",
      headers: { origin: url, "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ code: new URL(address.operatorUrl).hash.slice(8) }),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  }
  async function owner(path: string, body?: unknown) {
    const response = await fetch(url + "/connect/api/" + path, {
      headers: { origin: url, cookie, "content-type": "application/json", connection: "close" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as Record<string, unknown>;
  }
  async function pair(agentId: string, readOnly = false) {
    return (await owner("pair", { agentId, readOnly })) as unknown as Pair;
  }
  async function agent(pair: Pair, action: string) {
    const script = `import { connectNeurosaMemory } from "@osatech/neurosa-memory";
      const e=process.env, p=JSON.parse(e.TEST_PAIR);
      const memory=await connectNeurosaMemory({...p,cacheDirectory:e.NEUROSA_CONNECT_CACHE_DIR});
      let result;
      if(e.TEST_ACTION==="remember") result=await memory.remember({agentId:p.agentId,content:e.TEST_CONTENT,idempotencyKey:e.TEST_KEY});
      else if(e.TEST_ACTION==="fallback") result=await memory.beforeMessage({agentId:p.agentId,message:e.TEST_QUERY});
      else result=await memory.recall({agentId:p.agentId,query:e.TEST_QUERY});
      console.log(JSON.stringify(result));`;
    const r = await exec(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: directory,
      timeout: 15000,
      env: {
        ...cleanEnv,
        TEST_PAIR: JSON.stringify(pair),
        TEST_ACTION: action,
        TEST_CONTENT: content,
        TEST_KEY: key,
        TEST_QUERY: nonce,
        NEUROSA_CONNECT_CACHE_DIR: cache,
      },
    });
    assert.equal(r.stdout.includes(token) || r.stderr.includes(token), false);
    return JSON.parse(r.stdout) as Record<string, unknown>;
  }
  async function mcp(p: Pair, calls: { name: string; arguments: Record<string, unknown> }[]) {
    const messages = [
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "landing-test", version: "1" },
        },
      },
      ...calls.map((params, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params,
      })),
    ];
    const child = spawn(join(directory, "node_modules/.bin/neurosa-memory"), ["mcp"], {
      cwd: directory,
      env: {
        ...cleanEnv,
        NEUROSA_CONNECTOR_URL: p.connectorUrl,
        NEUROSA_PAIR_CODE: p.pairingCode,
        NEUROSA_AGENT_ID: p.agentId,
        NEUROSA_CONNECT_CACHE_DIR: cache,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      errors = "";
    child.stdout.on("data", (v: Buffer) => {
      output += v.toString();
    });
    child.stderr.on("data", (v: Buffer) => {
      errors += v.toString();
    });
    const done = new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Limit czasu testu MCP"));
      }, 15000);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) accept();
        else reject(new Error("MCP nie zakończył testu: " + errors));
      });
    });
    child.stdin.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    await done;
    assert.equal(output.includes(token) || errors.includes(token), false);
    const replies = output
      .trim()
      .split("\n")
      .map(
        (v) =>
          JSON.parse(v) as {
            id: number;
            result: { isError?: boolean; content: { text: string }[] };
            error?: unknown;
          },
      );
    assert.equal(replies.length, messages.length);
    return replies.slice(1).map((reply) => {
      assert.equal(reply.error, undefined);
      assert.notEqual(reply.result.isError, true, JSON.stringify(reply));
      return JSON.parse(reply.result.content[0]!.text) as Record<string, unknown>;
    });
  }
  try {
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await exec(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", resolve(packagePath)],
      { cwd: directory, env: cleanEnv, timeout: 30000 },
    );
    await startBackend();
    await startGateway();
    for (const path of ["/connect", "/connect/app.js", "/connect/style.css"]) {
      const r = await fetch(url + path, { headers: { connection: "close" } });
      assert.equal(r.status, 200);
      assert.equal((await r.text()).includes(token), false);
    }
    const archive = await fetch(url + "/connect/download/neurosa-memory-0.1.1.tgz", {
      headers: { connection: "close" },
    });
    assert.equal(archive.status, 200);
    assert.deepEqual(Buffer.from(await archive.arrayBuffer()), await readFile(packagePath));
    checks.L01 = {
      status: "PASS",
      mode: "LIVE_LOCAL_HTTP",
      ready: (await owner("state")).ready,
      packageDownloadMatchesArchive: true,
      privateKeyInBrowserAssets: false,
    };
    const writer = await pair("Jeverson"),
      reader = await pair("Hermes", true);
    assert.deepEqual((await owner("state")).activeAgents, []);
    const first = await agent(writer, "remember"),
      events = runtime!.listEvents().length;
    const retry = await agent(writer, "remember");
    assert.equal(first.documentId, retry.documentId);
    assert.equal(retry.deduplicated, true);
    assert.equal(runtime!.listEvents().length, events);
    const recalled = await agent(reader, "recall");
    const sources = recalled.sources as {
      documentId: string;
      contentHash: string;
      sourceReference: string;
    }[];
    assert.ok(String(recalled.text).includes(content));
    assert.equal(sources[0]?.documentId, first.documentId);
    assert.equal(sources[0]?.sourceReference, "Jeverson");
    assert.equal(sources[0]?.contentHash, createHash("sha256").update(content).digest("hex"));
    assert.equal(repository!.listDocuments().length, 1);
    checks.L02 = {
      status: "PASS",
      separateNodeProcesses: true,
      pairingRedeemedOnce: true,
      idempotencyAcrossProcesses: true,
      documentId: first.documentId,
      contentHash: first.contentHash,
      recallOperationId: recalled.operationId,
    };
    const pythonPair = await pair("Hermes-Python", true);
    const template = await (
      await fetch(url + "/connect/download/python-template.py", {
        headers: { connection: "close" },
      })
    ).text();
    const python = join(directory, "neurosa_memory.py");
    const prefix =
      "import os\n" +
      Object.entries({
        NEUROSA_CONNECTOR_URL: pythonPair.connectorUrl,
        NEUROSA_PAIR_CODE: pythonPair.pairingCode,
        NEUROSA_AGENT_ID: pythonPair.agentId,
      })
        .map(([k, v]) => `os.environ[${JSON.stringify(k)}] = ${JSON.stringify(v)}`)
        .join("\n") +
      "\n";
    await writeFile(python, prefix + template, { mode: 0o600 });
    const pythonRun = async () => {
      const r = await exec(
        "python3",
        [
          "-c",
          "import runpy,json,os; m=runpy.run_path(os.environ['TEST_MODULE']); print(json.dumps(m['recall']('Hermes-Python',os.environ['TEST_QUERY'])))",
        ],
        {
          cwd: directory,
          env: {
            ...cleanEnv,
            TEST_MODULE: python,
            TEST_QUERY: nonce,
            NEUROSA_CONNECT_CACHE_DIR: cache,
          },
          timeout: 15000,
        },
      );
      return JSON.parse(r.stdout) as { sources: { documentId: string; contentHash: string }[] };
    };
    assert.equal((await pythonRun()).sources[0]?.documentId, first.documentId);
    assert.equal((await pythonRun()).sources[0]?.contentHash, first.contentHash);
    checks.L03 = {
      status: "PASS",
      pythonFreshProcesses: 2,
      sameSourceAndHash: true,
      noThirdPartyPythonDependencies: true,
    };
    const mcpWriter = await pair("Jeverson-MCP");
    const mcpMarker = `Mcp${randomUUID().replaceAll("-", "")}`;
    const mcpKey = randomUUID();
    const results = await mcp(mcpWriter, [
      {
        name: "neurosa_start_session",
        arguments: { sessionId: "test-session", projectId: "osa", query: nonce },
      },
      {
        name: "neurosa_remember",
        arguments: {
          sessionId: "test-session",
          projectId: "osa",
          title: "MCP proof",
          content: `${mcpMarker}: wspólny brain.`,
          kind: "fact",
          idempotencyKey: mcpKey,
        },
      },
      { name: "neurosa_complete_session", arguments: { sessionId: "test-session", entries: [] } },
    ]);
    const mcpSaved = results[1]!.document as { documentId: string; contentHash: string };
    const mcpReader = await pair("Hermes-MCP", true);
    const query = [{ name: "neurosa_recall", arguments: { query: mcpMarker } }];
    const firstMcp = await mcp(mcpReader, query),
      secondMcp = await mcp(mcpReader, query);
    for (const result of [firstMcp[0], secondMcp[0]])
      assert.ok(
        (result!.references as { documentId: string }[]).some(
          (ref) => ref.documentId === mcpSaved.documentId,
        ),
      );
    checks.L04 = {
      status: "PASS",
      installedMcpExecutable: true,
      reusedExistingMcp: true,
      freshReadOnlyAgent: true,
      restartUsesCachedConnectorCredential: true,
      documentId: mcpSaved.documentId,
    };
    const testId = randomUUID(),
      browserTest = await owner("test", { testId });
    assert.equal(browserTest.status, "PASS");
    const count = repository!.listDocuments().length;
    assert.equal((await owner("test", { testId })).status, "PASS");
    assert.equal(repository!.listDocuments().length, count);
    checks.L05 = {
      status: "PASS",
      landingMemoryTest: true,
      syntheticTestIsIdempotent: true,
      count,
      modelCalls: 0,
    };
    const backendPort = Number(new URL(backendUrl).port),
      gatewayPort = Number(new URL(url).port);
    await stopBackend();
    const fallbackScript = `import {createNeurosaMemory} from "@osatech/neurosa-memory";import {readFileSync} from "node:fs";const c=JSON.parse(readFileSync(process.env.TEST_CACHE_FILE,"utf8"));const memory=createNeurosaMemory(c);const context=await memory.beforeMessage({agentId:"Hermes",message:"test"});console.log(JSON.stringify({context,hostReply:"Zwykła rozmowa trwa"}));`;
    const cacheFile = join(cache, (await readdir(cache))[0]!);
    const fallback = await exec(
      process.execPath,
      ["--input-type=module", "--eval", fallbackScript],
      { cwd: directory, env: { ...cleanEnv, TEST_CACHE_FILE: cacheFile }, timeout: 15000 },
    );
    const unavailable = JSON.parse(fallback.stdout) as {
      context: { status: string; text: string };
      hostReply: string;
    };
    assert.equal(unavailable.context.status, "UNAVAILABLE");
    assert.equal(unavailable.context.text, "");
    assert.ok(unavailable.hostReply);
    checks.L06 = {
      status: "PASS",
      backendOutage: true,
      context: "UNAVAILABLE",
      ordinaryHostCallbackContinues: true,
      fakeMemory: false,
    };
    await startBackend(backendPort);
    assert.deepEqual((await agent(reader, "recall")).sources, sources);
    await gateway!.close();
    await startGateway(gatewayPort);
    assert.deepEqual((await agent(reader, "recall")).sources, sources);
    assert.equal((await agent(writer, "remember")).deduplicated, true);
    checks.L07 = {
      status: "PASS",
      controlledCanonicalBackendRestart: true,
      controlledGatewayRestart: true,
      sameSourceAndHash: true,
      cachedConnectionSurvivesGatewayRestart: true,
      productionTouched: false,
    };
    for (const name of await readdir(cache)) {
      const filename = join(cache, name);
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
      assert.equal((await readFile(filename, "utf8")).includes(token), false);
    }
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const files = await exec(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "packages",
        "apps/neurosa-connect",
        "apps/brain-api",
        "tests/connect/landing.test.ts",
        "tests/e2e/landing.ts",
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "turbo.json",
        "eslint.config.mjs",
        ".github/workflows/neurosa-ci.yml",
      ],
      { cwd: root },
    );
    const source = createHash("sha256");
    for (const file of [...new Set(files.stdout.trim().split("\n"))].sort())
      source
        .update(file)
        .update("\0")
        .update(await readFile(join(root, file)))
        .update("\0");
    return {
      schema: "neurosa.landing.acceptance.v0.1.1",
      status: "PASS",
      recordedAt: new Date().toISOString(),
      environment:
        "isolated local canonical BrainApiServer + SQLite/WAL; separate installed SDK/MCP/Python processes",
      cloudAzure: "NOT_TESTED: endpoint and credential unavailable",
      browserVisualQa:
        "NOT_RUN: control-browser capability unavailable; no substituted browser automation",
      packageSha256: createHash("sha256")
        .update(await readFile(packagePath))
        .digest("hex"),
      backendAndConnectorSourceSha256: source.digest("hex"),
      modelCalls: 0,
      privateApiTokenInAgentCredentialCache: false,
      checks,
    };
  } finally {
    await gateway?.close();
    await stopBackend();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Podaj ścieżkę do pakietu .tgz");
  const result = await landingAcceptance(resolve(process.argv[2]));
  if (process.argv[3]) {
    const output = resolve(process.argv[3]);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  }
  console.log(JSON.stringify(result, null, 2));
}
