import { resolve } from "node:path";
import { createMemoryGateway } from "./web.js";

export async function serveMemoryLanding(env: NodeJS.ProcessEnv): Promise<void> {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Ustaw serwerowe ${name}`);
    return value;
  };
  const gateway = createMemoryGateway({
    endpoint: required("NEUROSA_API_URL"),
    token: required("NEUROSA_API_TOKEN"),
    brainId: required("NEUROSA_BRAIN_ID"),
    namespace: required("NEUROSA_MEMORY_NAMESPACE"),
    organizationId: required("NEUROSA_ORGANIZATION_ID"),
    projectId: required("NEUROSA_PROJECT_ID"),
    packagePath: resolve(
      env.NEUROSA_MEMORY_PACKAGE ?? ".neurosa/packages/osatech-neurosa-memory-0.1.1.tgz",
    ),
  });
  const port = Number(env.NEUROSA_CONNECT_PORT ?? "8645");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Nieprawidłowy port landingu");
  const address = await gateway.start({
    port,
    ...(env.NEUROSA_CONNECT_PUBLIC_ORIGIN
      ? { publicOrigin: env.NEUROSA_CONNECT_PUBLIC_ORIGIN }
      : {}),
    allowRemote: env.NEUROSA_CONNECT_ALLOW_REMOTE === "true",
  });
  // This short-lived, one-use operator link is intentionally handed to the operator; it is not the Brain API token.
  process.stdout.write(`Prywatny link operatora (jednorazowy, 5 minut): ${address.operatorUrl}\n`);
  const close = () => {
    void gateway.close().then(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
