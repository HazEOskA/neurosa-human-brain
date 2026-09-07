import { createHash } from "node:crypto";

import {
  NeurosaDiagnosticError,
  type Diagnostic,
  type NeuronNode,
  type ProgramNode,
  type PropertyNode,
  type PropertyValueNode,
  type RegionMemberNode,
  type SynapseNode,
} from "@neurosa/ast";
import {
  NEURAL_IR_VERSION,
  validateNeuralProgram,
  type NeuralProgram,
  type NeuronIR,
  type SynapseIR,
} from "@neurosa/ir";
import { parse } from "@neurosa/parser";
import { analyzeProgram } from "@neurosa/semantic-analysis";
import { typeCheckProgram } from "@neurosa/type-checker";

export interface SourceCheckResult {
  readonly ast: ProgramNode;
  readonly diagnostics: readonly Diagnostic[];
}

export interface CompilationResult {
  readonly ast: ProgramNode;
  readonly ir: NeuralProgram;
}

export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function checkSource(source: string, file = "<memory>"): SourceCheckResult {
  const ast = parse(source, file);
  const semantic = analyzeProgram(ast);
  const types = typeCheckProgram(ast);
  return { ast, diagnostics: [...semantic.diagnostics, ...types.diagnostics] };
}

function findProperty(member: RegionMemberNode, name: string): PropertyNode | undefined {
  return member.properties.find((property) => property.name.name === name);
}

function scalar(property: PropertyNode | undefined): string | number | boolean | undefined {
  return property?.value.kind === "ScalarLiteral" ? property.value.value : undefined;
}

function stringValue(member: RegionMemberNode, name: string, fallback: string): string {
  const value = scalar(findProperty(member, name));
  return typeof value === "string" ? value : fallback;
}

function numberValue(member: RegionMemberNode, name: string, fallback: number): number {
  const value = scalar(findProperty(member, name));
  return typeof value === "number" ? value : fallback;
}

function booleanValue(member: RegionMemberNode, name: string, fallback: boolean): boolean {
  const value = scalar(findProperty(member, name));
  return typeof value === "boolean" ? value : fallback;
}

function sourcePath(neuron: NeuronNode): string | null {
  const source = findProperty(neuron, "source")?.value;
  return source?.kind === "ObsidianSource" ? source.path : null;
}

function neuronToIR(neuron: NeuronNode, regionId: string): NeuronIR {
  return {
    id: neuron.id.name,
    regionId,
    type: stringValue(neuron, "type", "UNKNOWN").toUpperCase() as NeuronIR["type"],
    title: stringValue(neuron, "title", neuron.id.name),
    sourcePath: sourcePath(neuron),
    excerpt: stringValue(neuron, "excerpt", ""),
    threshold: numberValue(neuron, "threshold", 0.5),
    restingPotential: numberValue(neuron, "restingPotential", 0),
    salience: numberValue(neuron, "salience", 0.5),
    confidence: numberValue(neuron, "confidence", 1),
    enabled: booleanValue(neuron, "enabled", true),
  };
}

function synapseToIR(synapse: SynapseNode, regionId: string, ordinal: number): SynapseIR {
  const mode = stringValue(synapse, "mode", "EXCITATORY").toUpperCase() as SynapseIR["mode"];
  return {
    id: `${regionId}/${synapse.source.name}->${synapse.target.name}#${String(ordinal)}`,
    regionId,
    sourceNeuronId: synapse.source.name,
    targetNeuronId: synapse.target.name,
    relationType: stringValue(
      synapse,
      "relation",
      "RELATED_TO",
    ).toUpperCase() as SynapseIR["relationType"],
    mode,
    neurotransmitter: stringValue(
      synapse,
      "neurotransmitter",
      mode === "INHIBITORY" ? "GABA" : "GLUTAMATE",
    ),
    receptor: stringValue(synapse, "receptor", "CONTEXTUAL"),
    weight: numberValue(synapse, "weight", 0.5),
    confidence: numberValue(synapse, "confidence", 1),
    transmissionDelayMs: numberValue(synapse, "transmissionDelayMs", 0),
    decayRate: numberValue(synapse, "decayRate", 0),
    plasticity: stringValue(synapse, "plasticity", "NONE").toUpperCase() as SynapseIR["plasticity"],
  };
}

function generateIR(ast: ProgramNode, source: string): NeuralProgram {
  const regions = [...ast.brain.regions]
    .sort((left, right) => left.id.name.localeCompare(right.id.name))
    .map((region) => ({
      id: region.id.name,
      neuronIds: region.members
        .filter((member): member is NeuronNode => member.kind === "Neuron")
        .map((neuron) => neuron.id.name)
        .sort((left, right) => left.localeCompare(right)),
    }));

  const neurons = ast.brain.regions
    .flatMap((region) =>
      region.members
        .filter((member): member is NeuronNode => member.kind === "Neuron")
        .map((neuron) => neuronToIR(neuron, region.id.name)),
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  let ordinal = 0;
  const synapses = ast.brain.regions
    .flatMap((region) =>
      region.members
        .filter((member): member is SynapseNode => member.kind === "Synapse")
        .map((synapse) => synapseToIR(synapse, region.id.name, (ordinal += 1))),
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  return validateNeuralProgram({
    version: NEURAL_IR_VERSION,
    brainId: ast.brain.id.name,
    regions,
    neurons,
    synapses,
    proteins: [],
    pathways: [],
    policies: [],
    sourceHash: hashSource(source),
  });
}

export function compileSource(source: string, file = "<memory>"): CompilationResult {
  const checked = checkSource(source, file);
  if (checked.diagnostics.length > 0) {
    throw new NeurosaDiagnosticError(checked.diagnostics);
  }
  return { ast: checked.ast, ir: generateIR(checked.ast, source) };
}

function formatValue(value: PropertyValueNode): string {
  if (value.kind === "ObsidianSource") return `obsidian(${JSON.stringify(value.path)})`;
  if (typeof value.value !== "string") return String(value.value);
  return value.raw.startsWith('"') ? JSON.stringify(value.value) : value.value;
}

function formatProperties(properties: readonly PropertyNode[], indentation: string): string[] {
  return properties.map(
    (property) => `${indentation}${property.name.name}: ${formatValue(property.value)}`,
  );
}

function formatMember(member: RegionMemberNode): string[] {
  if (member.kind === "Neuron") {
    return [
      `    neuron ${member.id.name} {`,
      ...formatProperties(member.properties, "      "),
      "    }",
    ];
  }
  return [
    `    synapse ${member.source.name} -> ${member.target.name} {`,
    ...formatProperties(member.properties, "      "),
    "    }",
  ];
}

export function formatAst(program: ProgramNode): string {
  const lines = [`brain ${program.brain.id.name} {`];
  program.brain.regions.forEach((region, regionIndex) => {
    if (regionIndex > 0) lines.push("");
    lines.push(`  region ${region.id.name} {`);
    region.members.forEach((member, memberIndex) => {
      if (memberIndex > 0) lines.push("");
      lines.push(...formatMember(member));
    });
    lines.push("  }");
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function formatSource(source: string, file = "<memory>"): string {
  return formatAst(parse(source, file));
}

export { serializeNeuralProgram } from "@neurosa/ir";
