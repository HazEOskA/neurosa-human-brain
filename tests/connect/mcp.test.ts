import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { BrainApiServer } from "@neurosa/brain-api";
import { SqliteRuntimeRepository } from "@neurosa/storage";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { compileSource } from "@neurosa/compiler";
import { providerTools } from "@neurosa/connect/tools";

it("rzeczywisty proces stdio MCP wykonuje sesję przez HTTP i zostawia ledger", async () => {
  const repository = new SqliteRuntimeRepository(":memory:");
  const runtime = new NeurosaRuntime(repository);
  runtime.load(
    compileSource("brain Mcp { region R { neuron N { threshold: 0.5 } } }", "mcp.nsa").ir,
  );
  const token = "mcp-test-token-1234567890123456789";
  const api = new BrainApiServer(runtime, repository, {
    credentials: [{ token, agentId: "mcp-agent", scopes: ["admin"] }],
  });
  const { url } = await api.start();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/neurosa-connect/src/cli.ts", "mcp"],
    {
      env: {
        ...process.env,
        NEUROSA_API_URL: url,
        NEUROSA_API_TOKEN: token,
        NEUROSA_BRAIN_ID: "Mcp",
        NEUROSA_PROVIDER: "claude",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  let id = 0;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderr += text;
  });
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    const resolve = pending.get(value.id as number);
    if (resolve) {
      pending.delete(value.id as number);
      resolve(value);
    }
  });
  async function request(method: string, params: unknown = {}) {
    id++;
    const current = id;
    const result = new Promise<Record<string, unknown>>((resolve) => pending.set(current, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n");
    return result;
  }
  try {
    expect(
      (
        await request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        })
      ).result,
    ).toMatchObject({ serverInfo: { name: "neurosa-connect" } });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    expect(JSON.stringify((await request("tools/list")).result)).toContain("neurosa_start_session");
    const start = await request("tools/call", {
      name: "neurosa_start_session",
      arguments: { sessionId: "mcp-session", projectId: "osa", query: "NeurOSA" },
    });
    expect(JSON.stringify(start)).toContain("ledgerHead");
    const completed = await request("tools/call", {
      name: "neurosa_complete_session",
      arguments: {
        sessionId: "mcp-session",
        entries: [{ title: "Decyzja MCP", content: "MCP dzieli jeden mózg", kind: "decision" }],
      },
    });
    expect(JSON.stringify(completed)).toContain("COMPLETED");
    expect(repository.getSession("mcp-session")?.status).toBe("COMPLETED");
    expect(repository.listDocuments()[0]?.content).toBe("MCP dzieli jeden mózg");
    expect(runtime.verifyLedger().valid).toBe(true);
    expect((await request("tools/call", { name: "nieznane", arguments: {} })).result).toMatchObject(
      { isError: true },
    );
    expect(stderr).not.toContain(token);
  } finally {
    child.stdin.end();
    child.kill();
    await once(child, "exit");
    lines.close();
    await api.close();
    runtime.close();
  }
}, 15000);

it.each(["chatgpt", "claude", "gemini", "grok", "osa"])(
  "udostępnia schematy narzędzi %s bez osobnego stanu",
  (provider) => {
    const value = JSON.stringify(providerTools(provider));
    expect(value).toContain("neurosa_start_session");
    expect(value).toContain("neurosa_complete_session");
  },
);
