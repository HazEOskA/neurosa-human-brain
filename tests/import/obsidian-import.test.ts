import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteRuntimeRepository } from "@neurosa/storage";
import {
  assertSafeImportRelativePath,
  ObsidianOneTimeImporter,
} from "@neurosa/storage/obsidian-import";

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<{
  readonly root: string;
  readonly vault: string;
  readonly workspace: string;
  readonly database: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "neurosa-import-"));
  temporaryDirectories.push(root);
  const vault = join(root, "Vault");
  const workspace = join(root, "NativeBrain");
  await mkdir(vault, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { root, vault, workspace, database: join(root, "brain.db") };
}

async function importVault(project: Awaited<ReturnType<typeof temporaryProject>>) {
  const repository = new SqliteRuntimeRepository(project.database);
  const importer = new ObsidianOneTimeImporter(repository);
  const report = await importer.import({
    vaultPath: project.vault,
    workspacePath: project.workspace,
    brainId: "TestBrain",
  });
  return { repository, report };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("jednorazowy importer Obsidiana", () => {
  it("kopiuje Markdown, foldery, frontmatter i tagi bez zmiany źródła", async () => {
    const project = await temporaryProject();
    await mkdir(join(project.vault, "projekty"), { recursive: true });
    const source = `---\ntitle: Architektura\ntags: [neurosa, projekt]\n---\n# Mózg\nTreść #ważne\n`;
    const sourcePath = join(project.vault, "projekty", "brain.md");
    await writeFile(sourcePath, source, "utf8");

    const { repository, report } = await importVault(project);
    try {
      expect(report.documentCount).toBe(1);
      const [document] = repository.listDocuments();
      expect(document?.title).toBe("Architektura");
      expect(document?.sourceType).toBe("OBSIDIAN_IMPORT");
      expect(document?.tags).toEqual(["neurosa", "projekt", "ważne"]);
      expect(repository.listFolders().length).toBeGreaterThan(0);
      expect(await readFile(sourcePath, "utf8")).toBe(source);
      expect(
        await readFile(
          join(project.workspace, "documents", ...document!.path.split("/").slice(1)),
          "utf8",
        ),
      ).toBe(source);
    } finally {
      repository.close();
    }
  });

  it("rozwiązuje wikilinki i wylicza backlinki", async () => {
    const project = await temporaryProject();
    await writeFile(join(project.vault, "A.md"), "# A\n[[B|Dokument B]]\n", "utf8");
    await writeFile(join(project.vault, "B.md"), "# B\n", "utf8");

    const { repository } = await importVault(project);
    try {
      const documents = repository.listDocuments();
      const a = documents.find((document) => document.title === "A")!;
      const b = documents.find((document) => document.title === "B")!;
      expect(a.links).toHaveLength(1);
      expect(a.links[0]?.resolvedDocumentId).toBe(b.documentId);
      expect(b.backlinks).toContain(a.documentId);
    } finally {
      repository.close();
    }
  });

  it("tworzy neurony i rzeczywistą synapsę dla rozwiązanych wikilinków", async () => {
    const project = await temporaryProject();
    await writeFile(join(project.vault, "Źródło.md"), "# Źródło\n[[Cel]]\n", "utf8");
    await writeFile(join(project.vault, "Cel.md"), "# Cel\n", "utf8");

    const { repository, report } = await importVault(project);
    try {
      const brain = repository.loadBrain("TestBrain");
      expect(brain).not.toBeNull();
      expect(brain?.ir.neurons).toHaveLength(2);
      expect(brain?.ir.synapses).toHaveLength(1);
      expect(brain?.ir.synapses[0]?.relationType).toBe("REFERENCES");
      expect(report.neuronCount).toBe(2);
      expect(report.synapseCount).toBe(1);
    } finally {
      repository.close();
    }
  });

  it("kopiuje załącznik i działa po usunięciu źródłowego Vaultu oraz restarcie", async () => {
    const project = await temporaryProject();
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await writeFile(join(project.vault, "Notatka.md"), "# Notatka\n![[obraz.png]]\n", "utf8");
    await writeFile(join(project.vault, "obraz.png"), image);

    const first = await importVault(project);
    const document = first.repository.listDocuments()[0]!;
    const attachment = document.attachments[0]!;
    first.repository.close();
    await rm(project.vault, { recursive: true });

    const restarted = new SqliteRuntimeRepository(project.database);
    try {
      restarted.initialize();
      expect(restarted.listDocuments()).toHaveLength(1);
      expect(restarted.loadBrain("TestBrain")?.ir.neurons).toHaveLength(1);
      expect(await readFile(join(project.workspace, ...attachment.storagePath.split("/")))).toEqual(
        image,
      );
      expect(restarted.verifyLedger().valid).toBe(true);
    } finally {
      restarted.close();
    }
  });

  it("pomija symlinki i blokuje próbę wyjścia poza Vault", async () => {
    const project = await temporaryProject();
    const outside = join(project.root, "sekret.md");
    await writeFile(outside, "tajne", "utf8");
    await symlink(outside, join(project.vault, "link.md"));
    await writeFile(join(project.vault, "bezpieczna.md"), "# Bezpieczna\n", "utf8");

    const { repository, report } = await importVault(project);
    try {
      expect(report.documentCount).toBe(1);
      expect(report.warnings.some((warning) => warning.code === "POMINIĘTO_SYMLINK")).toBe(true);
      expect(() => assertSafeImportRelativePath("../../sekret.md")).toThrow(/poza katalog/u);
    } finally {
      repository.close();
    }
  });

  it("nie kopiuje wykonywalnych ani skryptowych załączników", async () => {
    const project = await temporaryProject();
    await writeFile(join(project.vault, "Notatka.md"), "# Notatka\n![[uruchom.sh]]\n", "utf8");
    await writeFile(join(project.vault, "uruchom.sh"), "rm -rf /", "utf8");

    const { repository, report } = await importVault(project);
    try {
      expect(report.attachmentCount).toBe(0);
      expect(report.warnings.some((warning) => warning.code === "POMINIĘTO_ZABLOKOWANY_TYP")).toBe(
        true,
      );
      expect(repository.listDocuments()[0]?.attachments).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it("odrzuca duży plik przed wczytaniem go do natywnej pamięci", async () => {
    const project = await temporaryProject();
    await writeFile(join(project.vault, "duża.md"), "x".repeat(1024), "utf8");
    const repository = new SqliteRuntimeRepository(project.database);
    try {
      const report = await new ObsidianOneTimeImporter(repository).import({
        vaultPath: project.vault,
        workspacePath: project.workspace,
        brainId: "TestBrain",
        maxNoteSizeBytes: 32,
      });
      expect(report.documentCount).toBe(0);
      expect(
        report.warnings.some((warning) => warning.code === "PRZEKROCZONO_LIMIT_ROZMIARU"),
      ).toBe(true);
    } finally {
      repository.close();
    }
  });

  it("zapisuje poprawny hash-chain ledger i nie duplikuje grafu przy ponownym imporcie", async () => {
    const project = await temporaryProject();
    await writeFile(join(project.vault, "A.md"), "# A\n[[B]]\n", "utf8");
    await writeFile(join(project.vault, "B.md"), "# B\n", "utf8");
    const repository = new SqliteRuntimeRepository(project.database);
    try {
      const importer = new ObsidianOneTimeImporter(repository);
      await importer.import({
        vaultPath: project.vault,
        workspacePath: project.workspace,
        brainId: "TestBrain",
      });
      await importer.import({
        vaultPath: project.vault,
        workspacePath: project.workspace,
        brainId: "TestBrain",
      });
      expect(repository.listDocuments()).toHaveLength(2);
      expect(repository.loadBrain("TestBrain")?.ir.neurons).toHaveLength(2);
      expect(repository.loadBrain("TestBrain")?.ir.synapses).toHaveLength(1);
      expect(repository.listEvents().some((event) => event.eventType === "IMPORT_COMPLETED")).toBe(
        true,
      );
      expect(repository.verifyLedger()).toEqual({ valid: true, errors: [] });
    } finally {
      repository.close();
    }
  });
});
