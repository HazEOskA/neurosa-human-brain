import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { compileSource, formatSource, hashSource, serializeNeuralProgram } from "@neurosa/compiler";

const validFixture = fileURLToPath(new URL("../fixtures/parser/valid-brain.nsa", import.meta.url));

describe("NEUROSA-HB compiler", () => {
  it("generates deterministic Neural IR 0.1", async () => {
    const source = await readFile(validFixture, "utf8");
    const first = compileSource(source, validFixture).ir;
    const second = compileSource(source, validFixture).ir;

    expect(first.version).toBe("0.1");
    expect(serializeNeuralProgram(first)).toBe(serializeNeuralProgram(second));
    expect(first.neurons.map((neuron) => neuron.id)).toEqual(["BrainArchitecture", "HydraLab"]);
    expect(first.synapses[0]).toMatchObject({
      sourceNeuronId: "BrainArchitecture",
      targetNeuronId: "HydraLab",
      weight: 0.64,
    });
  });

  it("generates a stable source SHA-256", () => {
    const source = "brain HashBrain {\n}\n";
    const expected = "132757c99e7696ad457ba4961ff5adc7728b6af8e2ca1d8e4ce2ef73b416660c";

    expect(hashSource(source)).toBe(expected);
    expect(compileSource(source, "hash.nsa").ir.sourceHash).toBe(expected);
  });

  it("formats source idempotently", () => {
    const source =
      'brain B { region R { neuron A { threshold: 0.5 source: obsidian("a.md") } neuron B {} synapse A -> B { mode: EXCITATORY weight: 0.7 } } }';
    const once = formatSource(source, "format.nsa");
    const twice = formatSource(once, "format.nsa");

    expect(twice).toBe(once);
    expect(once).toContain("    synapse A -> B {");
    expect(once.endsWith("\n")).toBe(true);
  });
});
