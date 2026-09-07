import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NeurosaConnect } from "@neurosa/connect";

const exec = promisify(execFile);

/** The same acceptance flow runs against the real entrypoint and the built image. */
export async function deploymentSmoke(mode: "process" | "docker", image = "neurosa:ci") {
  const dir = await mkdtemp(join(tmpdir(), "neurosa-deployment-"));
  const token = randomUUID();
  const name = `neurosa-test-${randomUUID()}`;
  const env: NodeJS.ProcessEnv = { ...process.env, NEUROSA_API_TOKEN: token };
  delete env.NEUROSA_CREDENTIALS_FILE;
  let child: ChildProcess | undefined;
  let container = false;
  let volume = false;
  let logs = "";
  const docker = async (...args: string[]) => (await exec("docker", args, { env })).stdout.trim();

  async function stop(crash = false) {
    if (mode === "docker" && container) {
      if (crash) await docker("kill", name);
      else await docker("stop", "--time", "10", name);
      logs += await docker("logs", name);
      await docker("rm", name);
      container = false;
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const current = child;
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => {
          current.kill("SIGKILL");
          reject(new Error("Proces nie zakończył się w limicie czasu"));
        }, 12000);
        current.once("exit", (code, signal) => {
          clearTimeout(timer);
          if ((!crash && code !== 0) || (crash && signal !== "SIGKILL"))
            reject(
              new Error(`Nieprawidłowe zakończenie procesu: ${String(code)}/${String(signal)}`),
            );
          else done();
        });
        current.kill(crash ? "SIGKILL" : "SIGTERM");
      });
    }
    child = undefined;
  }

  async function start(): Promise<string> {
    let url: string;
    if (mode === "docker") {
      await docker(
        "run",
        "--detach",
        "--name",
        name,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,nosuid,noexec,size=16m",
        "--publish",
        "127.0.0.1::8080",
        "--mount",
        `type=volume,source=${name},target=/data`,
        "--env",
        "NEUROSA_API_TOKEN",
        image,
      );
      container = true;
      url = `http://${await docker("port", name, "8080/tcp")}`;
    } else {
      child = spawn(process.execPath, ["--import", "tsx", "apps/brain-api/src/server.ts"], {
        env: {
          ...env,
          NEUROSA_API_HOST: "0.0.0.0",
          NEUROSA_ALLOW_REMOTE: "true",
          NEUROSA_API_PORT: "0",
          NEUROSA_DATABASE_PATH: join(dir, "brain.db"),
          NEUROSA_BRAIN_SOURCE: "examples/minimal-brain/brain.nsa",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const current = child;
      let startup = "";
      url = await new Promise<string>((done, reject) => {
        const timer = setTimeout(() => reject(new Error("Przekroczono czas startu API")), 15000);
        current.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        current.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("API zakończyło pracę przed startem"));
        });
        current.stderr?.on("data", (data: Buffer) => {
          logs += data.toString();
        });
        current.stdout?.on("data", (data: Buffer) => {
          startup += data.toString();
          logs += data.toString();
          const match = /http:\/\/0\.0\.0\.0:(\d+)/u.exec(startup);
          if (match) {
            clearTimeout(timer);
            done(`http://127.0.0.1:${match[1]}`);
          }
        });
      });
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      const ready = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
        .then((response) => response.ok)
        .catch(() => false);
      if (ready) return url;
      await delay(250);
    }
    throw new Error("Health API nie osiągnął gotowości");
  }

  try {
    if (mode === "docker") {
      await docker("volume", "create", name);
      volume = true;
    }
    let url = await start();
    const connect = (provider: string) =>
      new NeurosaConnect({
        baseUrl: url,
        token,
        brainId: "OsaBrain",
        provider,
      });
    assert.equal((await fetch(`${url}/api/v1/brain/status`)).status, 401);
    const wrong = new NeurosaConnect({ baseUrl: url, token, brainId: "Inny", provider: "osa" });
    await assert.rejects(() => wrong.status(), { status: 409 });
    const session = await connect("chatgpt").startSession(
      "deploy",
      "trwałość",
      "deployment-session",
    );
    const memories = [
      {
        title: "Test trwałości",
        content: "Pamięć przetrwa odtworzenie kontenera",
        factKey: "deployment-proof",
      },
    ];
    await session.complete(memories);
    const initial = (await connect("chatgpt").request("brain/events")) as { events: unknown[] };
    assert.ok(initial.events.length > 0);

    for (const crash of [false, true]) {
      await stop(crash);
      url = await start();
      const reader = connect("claude");
      assert.equal((await reader.recall("odtworzenie")).text.includes(memories[0]!.content), true);
      assert.equal(
        ((await reader.request("sessions/deployment-session")) as { status: string }).status,
        "COMPLETED",
      );
      const events = (await reader.request("brain/events")) as { events: unknown[] };
      assert.deepEqual(events.events.slice(0, initial.events.length), initial.events);
      assert.equal(
        ((await reader.request("brain/ledger/verify")) as { valid: boolean }).valid,
        true,
      );
      const before = events.events.length;
      await reader.complete("deployment-session", memories);
      assert.equal(
        ((await reader.request("brain/events")) as { events: unknown[] }).events.length,
        before,
      );
    }
    await stop();
    assert.equal(logs.includes(token), false, "Token nie może pojawić się w logach");
    return {
      status: "PASS",
      mode,
      checks: [
        "HTTP",
        "auth",
        "brainId",
        "session",
        "recall",
        "recreate",
        "crash-recovery",
        "ledger",
        "idempotency",
        "no-token-in-logs",
      ],
    };
  } finally {
    try {
      await stop();
    } finally {
      if (volume) await docker("volume", "rm", name);
      await rm(dir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "process";
  if (mode !== "process" && mode !== "docker") throw new Error("Tryb: process albo docker");
  console.log(JSON.stringify(await deploymentSmoke(mode, process.argv[3])));
}
