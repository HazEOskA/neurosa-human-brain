import { z } from "zod";
import { BrainConnectionError } from "@neurosa/connect";
import type { NeurosaMemoryOptions } from "./types.js";

export interface PairingOptions {
  readonly connectorUrl: string;
  readonly pairingCode: string;
  readonly agentId: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Stores only the connector credential, never memory or the private Brain API token. */
  readonly cacheDirectory?: string | false;
}

/** This exchange runs in the agent process, never in the browser. */
export async function redeemPairing(options: PairingOptions): Promise<NeurosaMemoryOptions> {
  if ("window" in globalThis) throw new Error("Parowanie uruchom w procesie agenta");
  const url = new URL(options.connectorUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Nieprawidłowy adres connectora; zdalne połączenie wymaga HTTPS");
  const input = z
    .object({
      pairingCode: z.string().min(20).max(200),
      agentId: z.string().trim().min(1).max(100),
    })
    .parse(options);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      `${url.origin}/connect/pair/redeem`,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      throw new BrainConnectionError(
        response.status,
        "Kod parowania wygasł, został wykorzystany lub nie pasuje do agenta",
        "NEUROSA_PAIRING_REJECTED",
      );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Brak odpowiedzi parowania");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 16000) throw new Error("Za duża odpowiedź parowania");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const result = z
      .object({
        token: z.string().min(24).max(4096),
        endpoint: z.string(),
        brainId: z.string(),
        namespace: z.string(),
        organizationId: z.string(),
        projectId: z.string(),
      })
      .parse(JSON.parse(raw) as unknown);
    if (result.endpoint !== url.origin) throw new Error("Odrzucono przekierowanie connectora");
    return { ...result, ...(options.fetch ? { fetch: options.fetch } : {}) };
  } catch (error) {
    if (error instanceof BrainConnectionError) throw error;
    throw new BrainConnectionError(
      0,
      "Parowanie NeurOSA jest niedostępne",
      "NEUROSA_PAIRING_UNAVAILABLE",
    );
  }
}
