import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { redeemPairing, type PairingOptions } from "./pairing.js";
import type { NeurosaMemoryOptions } from "./types.js";

const credential = z.object({
  endpoint: z.string().url(),
  token: z.string().min(24).max(4096),
  brainId: z.string(),
  namespace: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
});

/** Local connection credential only. The canonical Brain remains the only memory store. */
export async function loadConnection(input: PairingOptions): Promise<NeurosaMemoryOptions> {
  if ("window" in globalThis) throw new Error("Połączenie uruchom w procesie agenta");
  if (input.cacheDirectory === false) return redeemPairing(input);
  const directory = input.cacheDirectory ?? join(homedir(), ".config", "neurosa", "connections");
  const key = [input.connectorUrl, input.pairingCode, input.agentId];
  const filename = join(
    directory,
    createHash("sha256").update(JSON.stringify(key)).digest("hex") + ".json",
  );
  async function read() {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > 16000 ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      )
        throw new Error("Nieprawidłowy plik połączenia");
      const result = credential.parse(JSON.parse(await file.readFile("utf8")) as unknown);
      if (result.endpoint !== new URL(input.connectorUrl).origin)
        throw new Error("Odrzucono inne połączenie");
      return { ...result, ...(input.fetch ? { fetch: input.fetch } : {}) };
    } finally {
      await file.close();
    }
  }
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let result: NeurosaMemoryOptions;
  try {
    result = await redeemPairing(input);
  } catch (error) {
    try {
      return await read();
    } catch {
      throw error;
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(filename, JSON.stringify(credential.parse(result)), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    return read();
  }
  return result;
}
