import { NeurosaConnect } from "@neurosa/connect";
import { serveStdio } from "../../../apps/neurosa-connect/src/mcp.js";
import { loadConnection } from "./connection.js";

try {
  if (process.argv[2] !== "mcp") throw new Error("Polecenie: neurosa-memory mcp");
  const input = {
    connectorUrl: process.env.NEUROSA_CONNECTOR_URL ?? "",
    pairingCode: process.env.NEUROSA_PAIR_CODE ?? "",
    agentId: process.env.NEUROSA_AGENT_ID ?? "",
    ...(process.env.NEUROSA_CONNECT_CACHE_DIR
      ? { cacheDirectory: process.env.NEUROSA_CONNECT_CACHE_DIR }
      : {}),
  };
  const connection = await loadConnection(input);
  await serveStdio(
    new NeurosaConnect({
      baseUrl: connection.endpoint,
      token: connection.token,
      brainId: connection.brainId,
      provider: "other",
      memoryScope: {
        organizationId: connection.organizationId!,
        projectId: connection.projectId!,
        namespace: connection.namespace,
      },
    }),
  );
} catch {
  process.stderr.write(
    "Nie udało się podłączyć NeurOSA. Przygotuj nowy kod parowania na landingu.\n",
  );
  process.exitCode = 1;
}
