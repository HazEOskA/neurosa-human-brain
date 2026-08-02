import type { Diagnostic } from "@neurosa/ast";
import { parse } from "@neurosa/parser";
import { analyzeProgram, analyzePrograms } from "@neurosa/semantic-analysis";
import { typeCheckProgram } from "@neurosa/type-checker";

const validSource = `brain TestBrain {
  region Memory {
    neuron Source {
      type: concept
      source: obsidian("source.md")
      threshold: 0.6
    }
    neuron Target {
      type: memory
      threshold: 0.7
    }
    synapse Source -> Target {
      relation: SUPPORTS
      mode: EXCITATORY
      weight: 0.8
    }
  }
}
`;

function diagnosticsFor(source: string): readonly Diagnostic[] {
  const ast = parse(source, "semantic-test.nsa");
  return [...analyzeProgram(ast).diagnostics, ...typeCheckProgram(ast).diagnostics];
}

function expectDiagnostic(source: string, code: string): Diagnostic {
  const diagnostic = diagnosticsFor(source).find((candidate) => candidate.code === code);
  expect(diagnostic, `Expected diagnostic ${code}`).toBeDefined();
  return diagnostic!;
}

describe("NEUROSA-HB semantic analysis", () => {
  it("accepts a valid program", () => {
    expect(diagnosticsFor(validSource)).toEqual([]);
  });

  it("rejects a duplicate brain across source units", () => {
    const first = parse("brain Shared {}", "first.nsa");
    const second = parse("brain Shared {}", "second.nsa");
    expect(analyzePrograms([first, second]).diagnostics).toContainEqual(
      expect.objectContaining({ code: "NEUROSA-E201" }),
    );
  });

  it("rejects a duplicate region", () => {
    const source = `brain B { region R {} region R {} }`;
    expectDiagnostic(source, "NEUROSA-E202");
  });

  it("rejects a duplicate neuron with source location", () => {
    const source = `brain B {
  region R {
    neuron N {}
    neuron N {}
  }
}`;
    const diagnostic = expectDiagnostic(source, "NEUROSA-E203");
    expect(diagnostic.span).toMatchObject({
      file: "semantic-test.nsa",
      start: { line: 4, column: 12 },
    });
  });

  it("rejects an unresolved source neuron", () => {
    const source = `brain B { region R { neuron Target {} synapse Missing -> Target {} } }`;
    expectDiagnostic(source, "NEUROSA-E104");
  });

  it("rejects an unresolved target neuron", () => {
    const source = `brain B { region R { neuron Source {} synapse Source -> Missing {} } }`;
    expectDiagnostic(source, "NEUROSA-E105");
  });

  it("rejects a duplicate property", () => {
    const source = `brain B { region R { neuron N { threshold: 0.5 threshold: 0.6 } } }`;
    expectDiagnostic(source, "NEUROSA-E206");
  });
});

describe("NEUROSA-HB type checker", () => {
  it("rejects an invalid synapse weight", () => {
    const source = `brain B {
  region R {
    neuron A {}
    neuron B {}
    synapse A -> B { weight: 1.01 }
  }
}`;
    expectDiagnostic(source, "NEUROSA-E309");
  });

  it("rejects an invalid neuron threshold", () => {
    const source = `brain B { region R { neuron N { threshold: -0.01 } } }`;
    expectDiagnostic(source, "NEUROSA-E310");
  });

  it("rejects an invalid enum value", () => {
    const source = `brain B { region R { neuron N { type: fantasy } } }`;
    expectDiagnostic(source, "NEUROSA-E308");
  });

  it("rejects an unsupported property", () => {
    const source = `brain B { region R { neuron N { randomGlow: true } } }`;
    expectDiagnostic(source, "NEUROSA-E307");
  });

  it("rejects a property with the wrong type", () => {
    const source = `brain B { region R { neuron N { threshold: high } } }`;
    expectDiagnostic(source, "NEUROSA-E305");
  });
});
