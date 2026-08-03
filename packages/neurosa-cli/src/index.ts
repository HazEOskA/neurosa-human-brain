import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { NeurosaDiagnosticError } from "@neurosa/ast";
import {
  checkSource,
  compileSource,
  formatSource,
  serializeNeuralProgram,
} from "@neurosa/compiler";
import type { NeurosaRuntime as NeurosaRuntimeClass } from "@neurosa/neural-runtime";
import { parse } from "@neurosa/parser";
import type { SqliteRuntimeRepository as SqliteRuntimeRepositoryClass } from "@neurosa/storage";
import type { ObsidianOneTimeImporter as ObsidianOneTimeImporterClass } from "@neurosa/storage/obsidian-import";

export interface CliIO {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const defaultIO: CliIO = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

type Command = "parse" | "check" | "compile" | "inspect" | "format" | "run";

const commandAliases: Readonly<Record<string, Command>> = {
  parsuj: "parse",
  sprawdz: "check",
  kompiluj: "compile",
  zbadaj: "inspect",
  formatuj: "format",
  uruchom: "run",
  parse: "parse",
  check: "check",
  compile: "compile",
  inspect: "inspect",
  format: "format",
  run: "run",
};

export function usage(): string {
  return [
    "Użycie:",
    "  neurosa <polecenie> <plik.nsa> [opcje]",
    "  neurosa importuj obsidian <ścieżka-vault> [opcje]",
    "",
    "Polecenia:",
    "  parsuj      Utwórz i pokaż AST",
    "  sprawdz     Sprawdź składnię, semantykę i typy",
    "  kompiluj    Wygeneruj neuronową reprezentację pośrednią IR 0.1",
    "  zbadaj      Pokaż podsumowanie programu",
    "  formatuj    Sformatuj źródło; użyj --zapisz, aby nadpisać plik",
    "  uruchom     Uruchom ograniczoną aktywację neuronalną",
    "  importuj    Skopiuj dane z Obsidiana do natywnej pamięci NEUROSA-HB",
    "",
    "Opcje importu:",
    "  --stan <plik>                 Baza SQLite",
    "  --workspace <katalog>         Natywny katalog skopiowanych danych",
    "  --brain <id>                  Identyfikator mózgu importu",
    "  --maks-plik-bajtow <liczba>   Limit rozmiaru notatki Markdown",
    "  --maks-zalacznik-bajtow <liczba> Limit rozmiaru załącznika",
    "  --json                        Stabilny raport maszynowy",
  ].join("\n");
}

function optionValue(options: readonly string[], name: string): string | undefined {
  const index = options.indexOf(name);
  return index < 0 ? undefined : options[index + 1];
}

function numberOption(
  options: readonly string[],
  name: string,
  fallback: number,
  integer = false,
): number {
  const raw = optionValue(options, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`Opcja ${name} wymaga poprawnej ${integer ? "liczby całkowitej" : "liczby"}`);
  }
  return value;
}

function operatorError(error: unknown, file: string): string {
  if (error instanceof NeurosaDiagnosticError) return error.message;
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return `Nie znaleziono pliku lub katalogu '${file}'`;
  }
  if (error instanceof Error && /SQLITE|SQLite/u.test(error.message)) {
    return "Błąd bazy stanu SQLite";
  }
  return `Błąd: ${error instanceof Error ? error.message : String(error)}`;
}

async function loadRuntimeModules(): Promise<{
  NeurosaRuntime: typeof NeurosaRuntimeClass;
  SqliteRuntimeRepository: typeof SqliteRuntimeRepositoryClass;
}> {
  const warningListeners = process.listeners("warning") as Array<(warning: Error) => void>;
  process.removeAllListeners("warning");
  try {
    const [runtimeModule, storageModule] = await Promise.all([
      import("@neurosa/neural-runtime"),
      import("@neurosa/storage"),
    ]);
    await new Promise<void>((resolveImport) => setImmediate(resolveImport));
    return {
      NeurosaRuntime: runtimeModule.NeurosaRuntime,
      SqliteRuntimeRepository: storageModule.SqliteRuntimeRepository,
    };
  } finally {
    for (const listener of warningListeners) process.on("warning", listener);
  }
}

async function loadImporterModules(): Promise<{
  ObsidianOneTimeImporter: typeof ObsidianOneTimeImporterClass;
  SqliteRuntimeRepository: typeof SqliteRuntimeRepositoryClass;
}> {
  const [importerModule, storageModule] = await Promise.all([
    import("@neurosa/storage/obsidian-import"),
    import("@neurosa/storage"),
  ]);
  return {
    ObsidianOneTimeImporter: importerModule.ObsidianOneTimeImporter,
    SqliteRuntimeRepository: storageModule.SqliteRuntimeRepository,
  };
}

async function runObsidianImport(argv: readonly string[], io: CliIO): Promise<number> {
  const [, sourceType, vaultValue, ...options] = argv;
  if (sourceType !== "obsidian" || vaultValue === undefined) {
    io.stderr(usage());
    return 2;
  }
  const vaultPath = resolve(vaultValue);
  const statePath = resolve(optionValue(options, "--stan") ?? ".neurosa/brain.db");
  const workspacePath = resolve(optionValue(options, "--workspace") ?? ".neurosa/workspace");
  const brainId = optionValue(options, "--brain") ?? "ObsidianImportBrain";
  const { ObsidianOneTimeImporter, SqliteRuntimeRepository } = await loadImporterModules();
  const repository = new SqliteRuntimeRepository(statePath);
  try {
    const importer = new ObsidianOneTimeImporter(repository);
    const report = await importer.import({
      vaultPath,
      workspacePath,
      brainId,
      maxNoteSizeBytes: numberOption(options, "--maks-plik-bajtow", 2 * 1024 * 1024, true),
      maxAttachmentSizeBytes: numberOption(
        options,
        "--maks-zalacznik-bajtow",
        25 * 1024 * 1024,
        true,
      ),
    });
    if (options.includes("--json")) {
      io.stdout(JSON.stringify(report, null, 2));
    } else {
      io.stdout(
        [
          `Import zakończony: ${report.importId}`,
          `Mózg: ${report.brainId}`,
          `Dokumenty: ${String(report.documentCount)}`,
          `Załączniki: ${String(report.attachmentCount)}`,
          `Neurony: ${String(report.neuronCount)}`,
          `Synapsy: ${String(report.synapseCount)}`,
          `Nierozwiązane wikilinki: ${String(report.unresolvedLinks.length)}`,
          `Ostrzeżenia: ${String(report.warnings.length)}`,
          `Skrót źródła SHA-256: ${report.sourceHash}`,
          `Raport: ${report.reportPath}`,
          `Baza stanu: ${statePath}`,
          `Natywny workspace: ${workspacePath}`,
        ].join("\n"),
      );
    }
    return 0;
  } finally {
    repository.close();
  }
}

export async function runCli(argv: readonly string[], io: CliIO = defaultIO): Promise<number> {
  if (argv[0] === "importuj" || argv[0] === "import") {
    try {
      return await runObsidianImport(argv, io);
    } catch (error: unknown) {
      io.stderr(operatorError(error, argv[2] ?? "Vault Obsidiana"));
      return 1;
    }
  }

  const [commandValue, fileValue, ...options] = argv;
  const command = commandValue === undefined ? undefined : commandAliases[commandValue];
  if (command === undefined || fileValue === undefined) {
    io.stderr(usage());
    return 2;
  }

  const file = resolve(fileValue);
  try {
    const source = await readFile(file, "utf8");
    switch (command) {
      case "parse": {
        io.stdout(JSON.stringify(parse(source, file), null, 2));
        break;
      }
      case "check": {
        const checked = checkSource(source, file);
        if (checked.diagnostics.length > 0) throw new NeurosaDiagnosticError(checked.diagnostics);
        io.stdout(`Program NEUROSA-HB jest poprawny: ${checked.ast.brain.id.name}`);
        break;
      }
      case "compile": {
        io.stdout(serializeNeuralProgram(compileSource(source, file).ir).trimEnd());
        break;
      }
      case "inspect": {
        const { ir } = compileSource(source, file);
        io.stdout(
          [
            `Wersja neuronowej reprezentacji IR: ${ir.version}`,
            `Mózg: ${ir.brainId}`,
            `Regiony: ${String(ir.regions.length)}`,
            `Neurony: ${String(ir.neurons.length)}`,
            `Synapsy: ${String(ir.synapses.length)}`,
            `Skrót źródła SHA-256: ${ir.sourceHash}`,
          ].join("\n"),
        );
        break;
      }
      case "format": {
        const formatted = formatSource(source, file);
        if (options.includes("--zapisz") || options.includes("--write")) {
          await writeFile(file, formatted, "utf8");
          io.stdout(`Sformatowano plik ${file}`);
        } else {
          io.stdout(formatted.trimEnd());
        }
        break;
      }
      case "run": {
        const { NeurosaRuntime, SqliteRuntimeRepository } = await loadRuntimeModules();
        const { ir } = compileSource(source, file);
        const statePath = resolve(optionValue(options, "--stan") ?? ".neurosa/brain.db");
        const neuronId = optionValue(options, "--neuron") ?? ir.neurons[0]?.id;
        if (neuronId === undefined) throw new Error("Program nie zawiera neuronu startowego");
        const deterministic = options.includes("--deterministycznie");
        const activationId = deterministic
          ? `aktywacja-${ir.sourceHash.slice(0, 16)}`
          : `aktywacja-${randomUUID()}`;
        const repository = new SqliteRuntimeRepository(statePath);
        const runtime = new NeurosaRuntime(repository);
        try {
          runtime.load(ir);
          const result = runtime.activate({
            activationId,
            seedNeuronIds: [neuronId],
            initialStrength: numberOption(options, "--sila", 1),
            maksymalnaLiczbaSkokow: numberOption(options, "--maks-skoki", 8, true),
            minimalnaSila: 0.01,
            limitZdarzen: numberOption(options, "--limit-zdarzen", 500, true),
            limitCzasuMs: numberOption(options, "--limit-czasu-ms", 5_000),
            trybDeterministyczny: deterministic,
          });
          const ledger = runtime.verifyLedger();
          if (!ledger.valid) {
            throw new Error(
              `Weryfikacja dziennika zdarzeń nie powiodła się: ${ledger.errors.join("; ")}`,
            );
          }

          if (options.includes("--json")) {
            io.stdout(
              JSON.stringify(
                {
                  wersja: "0.1",
                  bazaStanu: statePath,
                  ledgerPoprawny: ledger.valid,
                  wynik: result,
                },
                null,
                2,
              ),
            );
          } else {
            io.stdout(
              [
                `Identyfikator aktywacji: ${result.activationId}`,
                `Aktywowane neurony: ${String(result.activatedNeuronIds.length)}`,
                `Odpalone neurony: ${String(result.firedNeuronIds.length)}`,
                `Dostarczone impulsy: ${String(result.deliveredImpulses.length)}`,
                `Zdarzenia aktywacji: ${String(result.eventCount)}`,
                `Powód zatrzymania: ${result.stopReason}`,
                `Baza stanu i dziennik zdarzeń: ${statePath}`,
              ].join("\n"),
            );
          }
        } finally {
          runtime.close();
        }
        break;
      }
    }
    return 0;
  } catch (error: unknown) {
    io.stderr(operatorError(error, file));
    return 1;
  }
}
