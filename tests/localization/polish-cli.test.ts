import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, usage, type CliIO } from "@neurosa/cli";

const validSource = `brain PolskiBrain {
  region Pamiec {
    neuron Start { threshold: 0.5 salience: 1 confidence: 1 }
  }
}`;

function capture(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

describe("polski interfejs operatora CLI", () => {
  it("prezentuje polską pomoc bez angielskich etykiet", () => {
    const help = usage();
    expect(help).toContain("Użycie:");
    expect(help).toContain("Polecenia:");
    expect(help).toContain("parsuj");
    expect(help).toContain("uruchom");
    expect(help).not.toMatch(/Usage|Commands|Neural IR/u);
  });

  it("obsługuje polskie polecenia i komunikaty sukcesu", async () => {
    const directory = await mkdtemp(join(tmpdir(), "neurosa-pl-cli-"));
    const file = join(directory, "brain.nsa");
    const database = join(directory, "brain.db");
    await writeFile(file, validSource, "utf8");
    try {
      for (const command of ["parsuj", "sprawdz", "kompiluj", "zbadaj", "formatuj"]) {
        const output = capture();
        const options = command === "formatuj" ? ["--zapisz"] : [];
        expect(await runCli([command, file, ...options], output.io)).toBe(0);
      }

      const checked = capture();
      await runCli(["sprawdz", file], checked.io);
      expect(checked.stdout.join("\n")).toContain("Program NEUROSA-HB jest poprawny");

      const inspected = capture();
      await runCli(["zbadaj", file], inspected.io);
      expect(inspected.stdout.join("\n")).toContain("Mózg: PolskiBrain");
      expect(inspected.stdout.join("\n")).toContain("Regiony: 1");

      const run = capture();
      expect(
        await runCli(
          ["uruchom", file, "--stan", database, "--neuron", "Start", "--deterministycznie"],
          run.io,
        ),
      ).toBe(0);
      expect(run.stdout.join("\n")).toContain("Identyfikator aktywacji:");
      expect(run.stdout.join("\n")).toContain("Powód zatrzymania:");
      expect(await readFile(file, "utf8")).toContain("brain PolskiBrain");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("zwraca polskie komunikaty błędów parsera i runtime'u", async () => {
    const directory = await mkdtemp(join(tmpdir(), "neurosa-pl-errors-"));
    const invalid = join(directory, "invalid.nsa");
    const valid = join(directory, "valid.nsa");
    await writeFile(invalid, "brain B { region R { neuron N { threshold 0.5 } } }", "utf8");
    await writeFile(valid, validSource, "utf8");
    try {
      const parserError = capture();
      expect(await runCli(["sprawdz", invalid], parserError.io)).toBe(1);
      expect(parserError.stderr.join("\n")).toContain("Oczekiwano ':'");
      expect(parserError.stderr.join("\n")).toContain("w ");

      const runtimeError = capture();
      expect(
        await runCli(
          ["uruchom", valid, "--stan", join(directory, "brain.db"), "--neuron", "Brak"],
          runtimeError.io,
        ),
      ).toBe(1);
      expect(runtimeError.stderr.join("\n")).toContain("Nieznany neuron startowy 'Brak'");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("nie ujawnia znanych angielskich komunikatów operatora", async () => {
    const directory = await mkdtemp(join(tmpdir(), "neurosa-pl-lock-"));
    const file = join(directory, "brain.nsa");
    await writeFile(file, validSource, "utf8");
    try {
      const output = capture();
      await runCli(["sprawdz", file], output.io);
      await runCli(["zbadaj", file], output.io);
      const visible = [usage(), ...output.stdout, ...output.stderr].join("\n");
      expect(visible).not.toMatch(
        /Usage|Commands|Valid NEUROSA-HB program|Formatted|Neural IR|Brain:|Regions:|Neurons:|Synapses:|Source SHA-256|Expected|Unknown|Duplicate|Invalid|Unsupported/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
