import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileSource } from "@neurosa/compiler";
import { HashChainLedger, InMemoryEventStore } from "@neurosa/event-ledger";
import { MIGRATION_1_SQL, SqliteRuntimeRepository } from "@neurosa/storage";
import { NativeBrainWorkspace } from "@neurosa/workspace";
import Database from "better-sqlite3";

function workspace(repository: SqliteRuntimeRepository): NativeBrainWorkspace {
  let id = 0;
  let tick = 0;
  return new NativeBrainWorkspace(repository, {
    idFactory: () => `id-${++id}`,
    now: () => `2026-08-03T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  });
}

describe("natywny workspace dokumentów", () => {
  it("zapisuje Markdown, frontmatter, tagi, nagłówki i wikilinki", () => {
    const repository = new SqliteRuntimeRepository(":memory:");
    repository.initialize();
    const brain = workspace(repository);
    const document = brain.createDocument({
      title: "Architektura",
      path: "projekty/architektura.md",
      content:
        "---\ntags: [brain, runtime]\nstatus: active\n---\n# Decyzja\nTreść #ważne [[Hydra|klient]]",
    });

    expect(document.frontmatter).toEqual({ tags: ["brain", "runtime"], status: "active" });
    expect(document.tags).toEqual(["brain", "runtime", "ważne"]);
    expect(document.headings).toEqual([{ level: 1, text: "Decyzja", slug: "decyzja" }]);
    expect(document.links).toEqual([
      { target: "Hydra", alias: "klient", resolvedDocumentId: null },
    ]);
    expect(document.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    repository.close();
  });

  it("tworzy historię niezmiennych rewizji", () => {
    const repository = new SqliteRuntimeRepository(":memory:");
    repository.initialize();
    const brain = workspace(repository);
    const created = brain.createDocument({ title: "Pamięć", path: "pamiec.md", content: "v1" });
    const updated = brain.updateDocument(created.documentId, { content: "v2" });

    expect(updated.revision).toBe(2);
    expect(
      repository.listDocumentRevisions(created.documentId).map((item) => item.snapshot.content),
    ).toEqual(["v1", "v2"]);
    repository.close();
  });

  it("rozwiązuje wikilinki i generuje backlinki także po późniejszym utworzeniu celu", () => {
    const repository = new SqliteRuntimeRepository(":memory:");
    repository.initialize();
    const brain = workspace(repository);
    const source = brain.createDocument({
      title: "Źródło",
      path: "zrodlo.md",
      content: "Powiązanie [[Cel]]",
    });
    expect(brain.getDocument(source.documentId).links[0]?.resolvedDocumentId).toBeNull();

    const target = brain.createDocument({ title: "Cel", path: "cel.md", content: "Treść celu" });
    expect(brain.getDocument(source.documentId).links[0]?.resolvedDocumentId).toBe(
      target.documentId,
    );
    expect(brain.getDocument(target.documentId).backlinks).toEqual([source.documentId]);
    repository.close();
  });

  it("wyszukuje lokalnie przez SQLite FTS5", () => {
    const repository = new SqliteRuntimeRepository(":memory:");
    repository.initialize();
    const brain = workspace(repository);
    brain.createDocument({
      title: "Konsolidacja",
      path: "konsolidacja.md",
      content: "Deterministyczna pamięć semantyczna #runtime",
    });
    brain.createDocument({ title: "Inny", path: "inny.md", content: "Niepowiązany tekst" });

    expect(brain.search("deterministyczna runtime").map((result) => result.document.title)).toEqual(
      ["Konsolidacja"],
    );
    repository.close();
  });

  it("przenosi dokument do kosza i pozwala go przywrócić", () => {
    const repository = new SqliteRuntimeRepository(":memory:");
    repository.initialize();
    const brain = workspace(repository);
    const document = brain.createDocument({
      title: "Kosz",
      path: "kosz.md",
      content: "do odzyskania",
    });
    brain.deleteDocument(document.documentId);

    expect(repository.listDocuments()).toEqual([]);
    expect(brain.search("odzyskania")).toEqual([]);
    expect(repository.listDocuments({ includeDeleted: true })).toHaveLength(1);
    expect(brain.restoreDocument(document.documentId).deletedAt).toBeNull();
    expect(brain.search("odzyskania")).toHaveLength(1);
    repository.close();
  });

  it("blokuje path traversal i ścieżki absolutne", () => {
    const repository = new SqliteRuntimeRepository(":memory:");
    repository.initialize();
    const brain = workspace(repository);
    expect(() => brain.createDocument({ title: "X", path: "../sekret.md", content: "x" })).toThrow(
      /poza natywny workspace/u,
    );
    expect(() => brain.createDocument({ title: "X", path: "/sekret.md", content: "x" })).toThrow(
      /względna/u,
    );
    repository.close();
  });

  it("dokumenty, foldery i FTS przeżywają restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "neurosa-workspace-"));
    const path = join(directory, "brain.db");
    try {
      const first = new SqliteRuntimeRepository(path);
      first.initialize();
      const firstWorkspace = workspace(first);
      const folder = firstWorkspace.createFolder({ name: "Projekty", path: "projekty" });
      const document = firstWorkspace.createDocument({
        title: "Hydra",
        path: "projekty/hydra.md",
        folderId: folder.folderId,
        content: "Trwała pamięć projektu",
        pinned: true,
      });
      first.close();

      const second = new SqliteRuntimeRepository(path);
      second.initialize();
      expect(second.loadFolder(folder.folderId)?.name).toBe("Projekty");
      expect(second.loadDocument(document.documentId)).toMatchObject({ pinned: true, revision: 1 });
      expect(second.searchDocuments("trwała projekt")).toHaveLength(1);
      second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migruje schema v1 do v2 bez utraty mózgu i ledgeru", async () => {
    const directory = await mkdtemp(join(tmpdir(), "neurosa-migration-"));
    const path = join(directory, "brain.db");
    try {
      const ir = compileSource(
        "brain Legacy { region R { neuron A { threshold: 0.5 } } }",
        "legacy.nsa",
      ).ir;
      const ledger = new HashChainLedger(new InMemoryEventStore());
      const event = ledger.append("RUNTIME_STARTED", null, { brainId: ir.brainId });
      const legacy = new Database(path);
      legacy.exec(
        "PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
      );
      legacy.exec(MIGRATION_1_SQL);
      legacy
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)")
        .run("2026-08-02T00:00:00.000Z");
      legacy
        .prepare(
          "INSERT INTO brains(brain_id, source_hash, ir_json, schema_version, updated_at) VALUES (?, ?, ?, 1, ?)",
        )
        .run(ir.brainId, ir.sourceHash, JSON.stringify(ir), "2026-08-02T00:00:00.000Z");
      legacy
        .prepare("INSERT INTO neurons VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1, NULL, 0, 0)")
        .run(
          ir.brainId,
          "A",
          "R",
          ir.neurons[0]!.restingPotential,
          ir.neurons[0]!.threshold,
          ir.neurons[0]!.salience,
          ir.neurons[0]!.confidence,
        );
      legacy
        .prepare("INSERT INTO ledger_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          event.sequence,
          event.eventId,
          event.eventType,
          event.activationId,
          event.timestamp,
          JSON.stringify(event.payload),
          event.previousHash,
          event.eventHash,
        );
      legacy.close();

      const migrated = new SqliteRuntimeRepository(path);
      migrated.initialize();
      expect(migrated.getSchemaVersion()).toBe(2);
      expect(migrated.loadBrain(ir.brainId)?.sourceHash).toBe(ir.sourceHash);
      expect(migrated.listEvents()).toEqual([event]);
      expect(migrated.verifyLedger()).toEqual({ valid: true, errors: [] });
      const brain = workspace(migrated);
      expect(
        brain.createDocument({ title: "Po migracji", path: "po.md", content: "działa" }).revision,
      ).toBe(1);
      migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
