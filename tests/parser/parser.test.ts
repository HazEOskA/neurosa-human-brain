import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { NeurosaDiagnosticError, formatDiagnostic } from "@neurosa/ast";
import { lex } from "@neurosa/lexer";
import { parse } from "@neurosa/parser";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/parser/${name}`, import.meta.url));

describe("NEUROSA-HB lexer and parser", () => {
  it("lexes signed scalars and source locations", () => {
    const result = lex("threshold: -0.65", "inline.nsa");

    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.map((token) => token.kind)).toEqual([
      "IDENTIFIER",
      "COLON",
      "NUMBER",
      "EOF",
    ]);
    expect(result.tokens[2]?.value).toBe(-0.65);
    expect(result.tokens[2]?.span.start).toMatchObject({ line: 1, column: 12 });
  });

  it("parses the valid fixture into a located AST", async () => {
    const source = await readFile(fixture("valid-brain.nsa"), "utf8");
    const program = parse(source, "valid-brain.nsa");

    expect(program.kind).toBe("Program");
    expect(program.brain.id.name).toBe("OsaBrain");
    expect(program.brain.span.start).toMatchObject({ line: 1, column: 1 });
    expect(program.brain.regions).toHaveLength(1);
    expect(program.brain.regions[0]?.members).toHaveLength(3);
  });

  it("parses scalar properties and obsidian source references", async () => {
    const source = await readFile(fixture("valid-brain.nsa"), "utf8");
    const program = parse(source, "valid-brain.nsa");
    const neuron = program.brain.regions[0]?.members[0];

    expect(neuron?.kind).toBe("Neuron");
    if (neuron?.kind !== "Neuron") throw new Error("Expected a neuron fixture member");
    expect(
      neuron.properties.find((property) => property.name.name === "threshold")?.value,
    ).toMatchObject({
      kind: "ScalarLiteral",
      value: 0.72,
    });
    expect(
      neuron.properties.find((property) => property.name.name === "enabled")?.value,
    ).toMatchObject({
      kind: "ScalarLiteral",
      value: true,
    });
    expect(
      neuron.properties.find((property) => property.name.name === "source")?.value,
    ).toMatchObject({
      kind: "ObsidianSource",
      path: "projects/brain.md",
    });
  });

  it("parses a directed synapse and its scalar properties", async () => {
    const source = await readFile(fixture("valid-brain.nsa"), "utf8");
    const program = parse(source, "valid-brain.nsa");
    const synapse = program.brain.regions[0]?.members[2];

    expect(synapse).toMatchObject({
      kind: "Synapse",
      source: { name: "BrainArchitecture" },
      target: { name: "HydraLab" },
    });
    if (synapse?.kind !== "Synapse") throw new Error("Expected a synapse fixture member");
    expect(
      synapse.properties.find((property) => property.name.name === "weight")?.value,
    ).toMatchObject({
      value: 0.64,
    });
  });

  it("reports invalid syntax with file, line and column", async () => {
    const source = await readFile(fixture("invalid-brain.nsa"), "utf8");

    try {
      parse(source, "invalid-brain.nsa");
      expect.unreachable("Expected parser failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(NeurosaDiagnosticError);
      if (!(error instanceof NeurosaDiagnosticError)) throw error;
      expect(error.diagnostics[0]).toMatchObject({
        code: "NEUROSA-P100",
        span: { file: "invalid-brain.nsa", start: { line: 4, column: 17 } },
      });
      expect(formatDiagnostic(error.diagnostics[0]!)).toContain("invalid-brain.nsa:4:17");
    }
  });

  it("reports unexpected characters as lexer diagnostics", () => {
    expect(() => parse("brain B { @ }", "bad-character.nsa")).toThrowError(
      /NEUROSA-L001: Nieoczekiwany znak '@'/u,
    );
  });

  it("rejects unknown source functions", () => {
    const source = `brain B { region R { neuron N { source: remote("note.md") } } }`;
    expect(() => parse(source, "unknown-source.nsa")).toThrowError(
      /NEUROSA-P105: Nieznana funkcja źródłowa 'remote'/u,
    );
  });
});
