import { readFile, mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GoogleDriveSource,
  NeurosaIngest,
  extractDocument,
  parseConversationExport,
} from "@neurosa/ingest";
import { SharedKnowledge } from "@neurosa/workspace/knowledge";
import { SqliteRuntimeRepository } from "@neurosa/storage";
import { NeurosaRuntime } from "@neurosa/neural-runtime";
import { compileSource } from "@neurosa/compiler";
import { NeurosaConnect } from "@neurosa/connect";
import { BrainApiServer } from "@neurosa/brain-api";
import type { KnowledgeSource } from "@neurosa/document-domain";

const ir = compileSource(
  "brain Ingest { region R { neuron N { threshold: 0.5 } } }",
  "ingest.nsa",
).ir;
function knowledge() {
  const repository = new SqliteRuntimeRepository(":memory:");
  const runtime = new NeurosaRuntime(repository);
  runtime.load(ir);
  return { repository, runtime, brain: new SharedKnowledge(repository, "Ingest") };
}
const source: KnowledgeSource = {
  type: "GOOGLE_DRIVE",
  id: "gdrive://doc",
  version: "1",
  modifiedAt: "2026-01-01T00:00:00.000Z",
};
const base = { title: "Wiedza", content: "NeurOSA wersja pierwsza", source };

describe("provenance, wersjonowanie i deduplikacja źródeł", () => {
  it("powtórzenie importu nie tworzy dokumentu, rewizji ani eventu", () => {
    const f = knowledge();
    try {
      const first = f.brain.write("drive", base);
      const events = f.runtime.listEvents().length;
      const second = f.brain.write("drive", base);
      expect(second.deduplicated).toBe(true);
      expect(second.document.documentId).toBe(first.document.documentId);
      expect(f.repository.listDocuments()).toHaveLength(1);
      expect(f.runtime.listEvents()).toHaveLength(events);
      expect(f.repository.listDocumentRevisions(first.document.documentId)).toHaveLength(1);
    } finally {
      f.runtime.close();
    }
  });
  it("nowa wersja zachowuje poprzednią; starsza i rozbieżna wersja są blokowane", () => {
    const f = knowledge();
    try {
      const doc = f.brain.write("drive", base).document;
      f.brain.write("drive", {
        ...base,
        content: "NeurOSA wersja druga",
        source: { ...source, version: "2" },
      });
      expect(f.repository.listDocumentRevisions(doc.documentId)).toHaveLength(2);
      expect(() => f.brain.write("drive", base)).toThrow("Starsza wersja");
      expect(() =>
        f.brain.write("drive", { ...base, source: { ...source, version: "2" } }),
      ).toThrow("Ta sama wersja");
      expect(f.runtime.verifyLedger().valid).toBe(true);
    } finally {
      f.runtime.close();
    }
  });
  it("lokalna edycja importu wymaga jawnego rozstrzygnięcia konfliktu", () => {
    const f = knowledge();
    try {
      const doc = f.brain.write("drive", base).document;
      f.brain.update("operator", doc.documentId, { content: "Ręczna decyzja" }, 1);
      expect(() =>
        f.brain.write("drive", { ...base, source: { ...source, version: "2" } }),
      ).toThrow("zmieniono");
      f.brain.write("operator", {
        ...base,
        expectedRevision: 2,
        source: { ...source, version: "2" },
      });
      expect(f.repository.loadDocument(doc.documentId)?.revision).toBe(3);
    } finally {
      f.runtime.close();
    }
  });
  it("te same treści z dwóch źródeł współdzielą dokument, zmiana rozdziela źródła", () => {
    const f = knowledge();
    try {
      const one = f.brain.write("drive", base);
      const two = f.brain.write("drive", { ...base, source: { ...source, id: "gdrive://second" } });
      expect(two.document.documentId).toBe(one.document.documentId);
      expect(two.deduplicated).toBe(true);
      const changed = f.brain.write("drive", {
        ...base,
        content: "Zmiana pierwszego",
        source: { ...source, version: "2" },
      });
      expect(changed.document.documentId).not.toBe(two.document.documentId);
      expect(f.repository.loadDocument(two.document.documentId)?.content).toBe(base.content);
      expect(f.runtime.listEvents().some((e) => e.eventType === "SOURCE_LINKED")).toBe(true);
    } finally {
      f.runtime.close();
    }
  });
});

describe("eksporty i dokumenty", () => {
  it("ChatGPT zachowuje wszystkie gałęzie i identyfikatory rodziców", () => {
    const parsed = parseConversationExport(
      [
        {
          id: "conversation",
          title: "Rozmowa",
          current_node: "b",
          mapping: {
            root: { message: null },
            a: {
              parent: "root",
              message: { author: { role: "user" }, content: { parts: ["pytanie"] } },
            },
            b: {
              parent: "a",
              message: { author: { role: "assistant" }, content: { parts: ["odpowiedź A"] } },
            },
            c: {
              parent: "a",
              message: { author: { role: "assistant" }, content: { parts: ["odpowiedź B"] } },
            },
          },
        },
      ],
      "chatgpt",
    );
    expect(parsed[0]?.content).toContain("odpowiedź A");
    expect(parsed[0]?.content).toContain("odpowiedź B");
    expect(parsed[0]?.content).toContain("rodzic: a");
  });
  it("Claude i neutralny JSON Gemini/Grok zachowują tekst i role", () => {
    expect(
      parseConversationExport(
        [
          {
            uuid: "c",
            name: "Claude",
            chat_messages: [{ uuid: "m", sender: "human", text: "wiedza" }],
          },
        ],
        "claude",
      )[0]?.content,
    ).toContain("human");
    for (const provider of ["gemini", "grok"])
      expect(
        parseConversationExport(
          {
            conversations: [
              { id: "g", messages: [{ id: "m", role: "user", content: "stan projektu" }] },
            ],
          },
          provider,
        )[0]?.content,
      ).toContain("stan projektu");
  });
  it("nieznany format jest błędem zamiast pustego sukcesu", () => {
    expect(() => parseConversationExport({ id: "a", unsupported: [] }, "grok")).toThrow(
      "Nieobsługiwany",
    );
  });
  it.each(["docx", "pdf"])("odczytuje rzeczywisty plik %s", async (extension) => {
    expect(
      await extractDocument(
        await readFile(`tests/fixtures/ingest/sample.${extension}`),
        `sample.${extension}`,
      ),
    ).toContain("NeurOSA");
  });
  it("nie wykonuje skryptów i odrzuca nieobsługiwane dane binarne", async () => {
    const html = "<script>globalThis.unsafeExecuted = true</script><p>Wiedza</p>";
    expect(await extractDocument(Buffer.from(html), "a.html")).toBe(html);
    await expect(extractDocument(Buffer.from([0, 1, 2]), "a.exe")).rejects.toThrow(
      "Nieobsługiwany",
    );
  });
  it("symlink poza root jest odrzucany przed kontaktem z API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ingest-root-"));
    const outside = await mkdtemp(join(tmpdir(), "ingest-outside-"));
    try {
      await writeFile(join(outside, "secret.md"), "nie importuj");
      await symlink(join(outside, "secret.md"), join(dir, "link.md"));
      const fetcher = vi.fn<typeof fetch>();
      const client = new NeurosaConnect({
        baseUrl: "http://127.0.0.1:1",
        token: "token-do-testow-neurosa-12345",
        brainId: "Ingest",
        provider: "osa",
        fetch: fetcher,
      });
      await expect(new NeurosaIngest(client).file("link.md", dir)).rejects.toThrow(
        "poza dozwolonym",
      );
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("Google Drive → rzeczywiste Brain API → recall", () => {
  it("paginacja, eksport Google Docs, replay i aktualizacja wersji", async () => {
    const f = knowledge();
    const token = "token-testowego-importera-12345678";
    const api = new BrainApiServer(f.runtime, f.repository, {
      credentials: [{ token, agentId: "drive", scopes: ["admin"] }],
      rateLimitPerMinute: 1000,
    });
    const { url } = await api.start();
    const client = new NeurosaConnect({ baseUrl: url, token, brainId: "Ingest", provider: "osa" });
    let version = "1";
    let mismatch = false;
    const calls: string[] = [];
    const file = () => ({
      id: "doc",
      name: "Dokument",
      mimeType: "application/vnd.google-apps.document",
      version,
      modifiedTime: "2026-01-01T00:00:00.000Z",
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      calls.push(url.toString());
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-drive-token");
      if (url.pathname.endsWith("/export"))
        return await Promise.resolve(new Response(`NeurOSA import Drive ${version}`));
      if (url.pathname.endsWith("/doc"))
        return Response.json({ ...file(), version: mismatch ? "9" : version });
      if (url.searchParams.has("pageToken")) return Response.json({ files: [file()] });
      return Response.json({ files: [], nextPageToken: "page2" });
    };
    const drive = new GoogleDriveSource(() => Promise.resolve("test-drive-token"), fetcher);
    try {
      expect((await drive.sync("folder", new NeurosaIngest(client))).complete).toBe(true);
      expect((await client.recall("Drive")).text).toContain("NeurOSA import Drive 1");
      await drive.sync("folder", new NeurosaIngest(client));
      expect(f.repository.listDocuments()).toHaveLength(1);
      const doc = f.repository.listDocuments()[0]!;
      expect(doc.revision).toBe(1);
      version = "2";
      await drive.sync("folder", new NeurosaIngest(client));
      expect(f.repository.loadDocument(doc.documentId)?.revision).toBe(2);
      mismatch = true;
      const failed = await drive.sync("folder", new NeurosaIngest(client));
      expect(failed.complete).toBe(false);
      expect(failed.failed[0]?.reason).toContain("zmienił");
      expect(calls.some((call) => call.includes("pageToken=page2"))).toBe(true);
      expect(f.runtime.verifyLedger().valid).toBe(true);
    } finally {
      await api.close();
      f.runtime.close();
    }
  });
  it("401 i niepełny wynik Drive nie są zgłaszane jako sukces", async () => {
    const client = new NeurosaConnect({
      baseUrl: "http://127.0.0.1:1",
      token: "test-token-neurosa-123456789",
      brainId: "Ingest",
      provider: "osa",
    });
    const ingest = new NeurosaIngest(client);
    const denied = new GoogleDriveSource(
      () => Promise.resolve("token"),
      () => Promise.resolve(new Response("", { status: 401 })),
    );
    await expect(denied.sync("folder", ingest)).rejects.toThrow("HTTP 401");
    const incomplete = new GoogleDriveSource(
      () => Promise.resolve("token"),
      () => Promise.resolve(Response.json({ files: [], incompleteSearch: true })),
    );
    await expect(incomplete.sync("folder", ingest)).rejects.toThrow("niepełne");
  });
});

it("bezpośredni PATCH i DELETE nie omijają kontroli rewizji importu", () => {
  const f = knowledge();
  try {
    const doc = f.brain.write("drive", base).document;
    expect(() => f.brain.update("agent", doc.documentId, { content: "nadpisanie" })).toThrow(
      "expectedRevision",
    );
    expect(() => f.brain.remove("agent", doc.documentId)).toThrow("expectedRevision");
    expect(f.repository.loadDocument(doc.documentId)?.content).toBe(base.content);
    f.brain.update("operator", doc.documentId, { content: "jawne rozstrzygnięcie" }, 1);
    expect(f.repository.loadDocument(doc.documentId)?.revision).toBe(2);
  } finally {
    f.runtime.close();
  }
});

it("nieznana kolejność eksportów nie zastępuje nowszej pamięci w ciemno", () => {
  const f = knowledge();
  try {
    const imported = {
      ...base,
      source: { type: "CHAT_EXPORT" as const, id: "chatgpt:abc", version: "hash-first" },
    };
    f.brain.write("import", imported);
    const changed = {
      ...imported,
      content: "inna treść",
      source: { ...imported.source, version: "hash-second" },
    };
    expect(() => f.brain.write("import", changed)).toThrow("Nieznana kolejność");
    f.brain.write("operator", { ...changed, expectedRevision: 1 });
    expect(f.repository.listDocuments()[0]?.revision).toBe(2);
  } finally {
    f.runtime.close();
  }
});

it("awaria dopisania ledgeru wycofuje dokument i receipt", () => {
  const f = knowledge();
  try {
    const append = vi.spyOn(f.repository, "appendEvent").mockImplementation(() => {
      throw new Error("dysk niedostępny");
    });
    expect(() => f.brain.write("import", { ...base, idempotencyKey: "disk-failure" })).toThrow(
      "dysk niedostępny",
    );
    expect(f.repository.listDocuments()).toHaveLength(0);
    append.mockRestore();
    expect(f.brain.write("import", { ...base, idempotencyKey: "disk-failure" }).deduplicated).toBe(
      false,
    );
    expect(f.runtime.verifyLedger().valid).toBe(true);
  } finally {
    f.runtime.close();
  }
});
