import type { BrainApiStartOptions } from "@neurosa/brain-api";

export function listenOptions(env: NodeJS.ProcessEnv): BrainApiStartOptions {
  const remote = env.NEUROSA_ALLOW_REMOTE ?? "false";
  if (remote !== "true" && remote !== "false")
    throw new Error("NEUROSA_ALLOW_REMOTE musi mieć wartość true albo false");
  const raw = env.NEUROSA_API_PORT ?? env.PORT ?? "8644";
  const port = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("NEUROSA_API_PORT lub PORT musi być poprawnym numerem portu");
  const host = env.NEUROSA_API_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(host))
    throw new Error("NEUROSA_API_HOST musi być adresem loopback albo wildcard");
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && remote !== "true")
    throw new Error("Nasłuch poza loopback wymaga NEUROSA_ALLOW_REMOTE=true");
  return { host, port, allowRemote: remote === "true" };
}
