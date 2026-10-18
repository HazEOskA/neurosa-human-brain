import { NeurosaConnect } from "@neurosa/connect";
import { GoogleDriveSource, NeurosaIngest } from "@neurosa/ingest";
import { serveStdio } from "./mcp";
import { serveMemoryLanding } from "./web-cli.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Ustaw ${name}`);
  return value;
}
const command = process.argv[2];
try {
  if (command === "web") {
    await serveMemoryLanding(process.env);
  } else {
    const client = new NeurosaConnect({
      baseUrl: required("NEUROSA_API_URL"),
      token: required("NEUROSA_API_TOKEN"),
      brainId: required("NEUROSA_BRAIN_ID"),
      provider: process.env.NEUROSA_PROVIDER ?? "other",
      ...(process.env.NEUROSA_MEMORY_NAMESPACE
        ? {
            memoryScope: {
              namespace: process.env.NEUROSA_MEMORY_NAMESPACE,
              organizationId: required("NEUROSA_ORGANIZATION_ID"),
              projectId: required("NEUROSA_PROJECT_ID"),
            },
          }
        : {}),
    });
    const ingest = new NeurosaIngest(client, process.env.NEUROSA_PROJECT_ID ?? "shared");
    if (command === "mcp") await serveStdio(client);
    else if (command === "status") {
      await client.status();
      console.log("NeurOSA: połączenie i ledger poprawne");
    } else if (command === "importuj") {
      const path = process.argv[3];
      const root = process.argv[4];
      if (!path || !root)
        throw new Error("Użycie: importuj <plik> <dozwolony-katalog> [dostawca-eksportu]");
      console.log(JSON.stringify(await ingest.file(path, root, process.argv[5]), null, 2));
    } else if (command === "drive") {
      const folder = process.argv[3];
      if (!folder) throw new Error("Użycie: drive <folder-id>");
      const source = new GoogleDriveSource(() =>
        Promise.resolve(required("GOOGLE_DRIVE_ACCESS_TOKEN")),
      );
      const result = await source.sync(folder, ingest);
      console.log(JSON.stringify(result, null, 2));
      if (!result.complete) process.exitCode = 1;
    } else
      throw new Error(
        "Polecenia: web | status | mcp | importuj <plik> <katalog> [dostawca] | drive <folder-id>",
      );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Błąd NeurOSA Connect");
  process.exitCode = 1;
}
