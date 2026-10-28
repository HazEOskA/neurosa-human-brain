import { randomBytes } from "node:crypto";

type Options = { origin: string; token: string; brainId: string };
type Json = Record<string, unknown>;

/** Local-only staged service smoke. Does not depend on or modify production. */
export async function runStagingMemorySmoke(input: Options): Promise<{
  result: "PASS";
  write_readback: true;
  cross_request_recall: true;
  source_reference: true;
  ledger_valid: true;
  real_brain_api: true;
}> {
  if (
    process.env.RAILWAY_PROJECT_ID !== "bbfcceb0-cef8-422b-8eb9-b1761b2a670d" ||
    process.env.RAILWAY_ENVIRONMENT_NAME !== "staging" ||
    process.env.NEUROSA_DATABASE_PATH !== "/data/brain.db" ||
    !input.origin.startsWith("http://127.0.0.1:") ||
    !input.token ||
    input.token.length < 24
  )
    throw Error("STAGING_SMOKE_DISABLED");
  const request = async (path: string, body?: Json) => {
    const response = await fetch(input.origin + "/api/v1/" + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + input.token, "content-type": "application/json" },
      signal: AbortSignal.timeout(10000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw Error("STAGING_SMOKE_HTTP_FAIL");
    return (await response.json()) as Json;
  };
  const nonce = randomBytes(12).toString("hex");
  const secret = "OSA-STAGING-" + nonce;
  const saved = await request("brain/remember", {
    title: "OSA staging E2E marker",
    path: "osa/staging-memory-" + nonce + ".md",
    content: JSON.stringify({
      kind: "AUTHENTICATED_USER_STATEMENT",
      data: { text: "Nazwa informacji: kod kontrolny OSA. Wartość: " + secret },
    }),
    projectId: "osa-proof-staging",
  });
  const document = saved.document as Json | undefined;
  const documentId = document?.documentId;
  if (saved.status !== "ZAPAMIĘTANO" || typeof documentId !== "string")
    throw Error("STAGING_SMOKE_WRITE_FAIL");
  const restored = await request("documents/" + encodeURIComponent(documentId));
  if (typeof restored.content !== "string" || !restored.content.includes(secret))
    throw Error("STAGING_SMOKE_READBACK_FAIL");
  const question = [
    "W poprzedniej rozmowie zapisałem informację oznaczoną jako „kod kontrolny OSA”.",
    "Odzyskaj informację z NeurOSA i podaj jej wartość wraz z dokumentem źródłowym.",
    "Nie zgaduj ani nie korzystaj z historii rozmowy.",
  ].join(" ");
  if (question.includes(secret)) throw Error("STAGING_SMOKE_SELF_LEAK");
  const recalled = await request("brain/recall", {
    query: question,
    includeCore: true,
    maxChars: 12000,
    limit: 10,
  });
  const refs: unknown = recalled.references;
  if (
    recalled.brainId !== input.brainId ||
    recalled.ledgerValid !== true ||
    typeof recalled.text !== "string" ||
    !recalled.text.includes(secret) ||
    !Array.isArray(refs) ||
    !(refs as unknown[]).some((entry: unknown) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const ref = entry as Record<string, unknown>;
      return ref["documentId"] === documentId && ref["sourceCurrent"] === true;
    })
  )
    throw Error("STAGING_SMOKE_RECALL_FAIL");
  return {
    result: "PASS",
    write_readback: true,
    cross_request_recall: true,
    source_reference: true,
    ledger_valid: true,
    real_brain_api: true,
  };
}
