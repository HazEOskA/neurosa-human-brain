export interface SourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface SourceSpan {
  readonly file: string;
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface IdentifierNode {
  readonly kind: "Identifier";
  readonly name: string;
  readonly span: SourceSpan;
}

export type ScalarValue = string | number | boolean;

export interface ScalarLiteralNode {
  readonly kind: "ScalarLiteral";
  readonly value: ScalarValue;
  readonly raw: string;
  readonly span: SourceSpan;
}

export interface ObsidianSourceNode {
  readonly kind: "ObsidianSource";
  readonly path: string;
  readonly span: SourceSpan;
}

export type PropertyValueNode = ScalarLiteralNode | ObsidianSourceNode;

export interface PropertyNode {
  readonly kind: "Property";
  readonly name: IdentifierNode;
  readonly value: PropertyValueNode;
  readonly span: SourceSpan;
}

export interface NeuronNode {
  readonly kind: "Neuron";
  readonly id: IdentifierNode;
  readonly properties: readonly PropertyNode[];
  readonly span: SourceSpan;
}

export interface SynapseNode {
  readonly kind: "Synapse";
  readonly source: IdentifierNode;
  readonly target: IdentifierNode;
  readonly properties: readonly PropertyNode[];
  readonly span: SourceSpan;
}

export type RegionMemberNode = NeuronNode | SynapseNode;

export interface RegionNode {
  readonly kind: "Region";
  readonly id: IdentifierNode;
  readonly members: readonly RegionMemberNode[];
  readonly span: SourceSpan;
}

export interface BrainNode {
  readonly kind: "Brain";
  readonly id: IdentifierNode;
  readonly regions: readonly RegionNode[];
  readonly span: SourceSpan;
}

export interface ProgramNode {
  readonly kind: "Program";
  readonly brain: BrainNode;
  readonly span: SourceSpan;
}

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: DiagnosticSeverity;
  readonly span: SourceSpan;
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const { file, start } = diagnostic.span;
  return `${diagnostic.code}: ${diagnostic.message}\nw ${file}:${start.line}:${start.column}`;
}

export class NeurosaDiagnosticError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join("\n"));
    this.name = "NeurosaDiagnosticError";
    this.diagnostics = diagnostics;
  }
}
