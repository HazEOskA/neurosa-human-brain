import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { NeurosaDiagnosticError } from "@neurosa/ast";
import {
  checkSource,
  compileSource,
  formatSource,
  serializeNeuralProgram,
} from "@neurosa/compiler";
import { parse } from "@neurosa/parser";

export interface CliIO {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const defaultIO: CliIO = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

const commands = ["parse", "check", "compile", "inspect", "format"] as const;
type Command = (typeof commands)[number];

function usage(): string {
  return [
    "Usage: neurosa <command> <file.nsa> [--write]",
    "Commands: parse, check, compile, inspect, format",
  ].join("\n");
}

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && commands.some((command) => command === value);
}

export async function runCli(argv: readonly string[], io: CliIO = defaultIO): Promise<number> {
  const [commandValue, fileValue, ...options] = argv;
  if (!isCommand(commandValue) || fileValue === undefined) {
    io.stderr(usage());
    return 2;
  }

  const file = resolve(fileValue);
  try {
    const source = await readFile(file, "utf8");
    switch (commandValue) {
      case "parse": {
        io.stdout(JSON.stringify(parse(source, file), null, 2));
        break;
      }
      case "check": {
        const checked = checkSource(source, file);
        if (checked.diagnostics.length > 0) throw new NeurosaDiagnosticError(checked.diagnostics);
        io.stdout(`Valid NEUROSA-HB program: ${checked.ast.brain.id.name}`);
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
            `Neural IR: ${ir.version}`,
            `Brain: ${ir.brainId}`,
            `Regions: ${String(ir.regions.length)}`,
            `Neurons: ${String(ir.neurons.length)}`,
            `Synapses: ${String(ir.synapses.length)}`,
            `Source SHA-256: ${ir.sourceHash}`,
          ].join("\n"),
        );
        break;
      }
      case "format": {
        const formatted = formatSource(source, file);
        if (options.includes("--write")) {
          await writeFile(file, formatted, "utf8");
          io.stdout(`Formatted ${file}`);
        } else {
          io.stdout(formatted.trimEnd());
        }
        break;
      }
    }
    return 0;
  } catch (error: unknown) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
