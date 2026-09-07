import type {
  BrainNode,
  Diagnostic,
  NeuronNode,
  ProgramNode,
  RegionNode,
  SynapseNode,
} from "@neurosa/ast";

export interface SemanticSymbols {
  readonly brains: ReadonlyMap<string, BrainNode>;
  readonly regions: ReadonlyMap<string, RegionNode>;
  readonly neurons: ReadonlyMap<string, NeuronNode>;
}

export interface SemanticAnalysisResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly symbols: SemanticSymbols;
}

function error(code: string, message: string, span: Diagnostic["span"]): Diagnostic {
  return { code, message, severity: "error", span };
}

function regionKey(brainId: string, regionId: string): string {
  return `${brainId}/${regionId}`;
}

function neuronKey(brainId: string, neuronId: string): string {
  return `${brainId}/${neuronId}`;
}

function validateDuplicateProperties(
  member: NeuronNode | SynapseNode,
  diagnostics: Diagnostic[],
): void {
  const properties = new Set<string>();
  for (const property of member.properties) {
    if (properties.has(property.name.name)) {
      diagnostics.push(
        error(
          "NEUROSA-E206",
          `Zduplikowana właściwość '${property.name.name}'`,
          property.name.span,
        ),
      );
    } else {
      properties.add(property.name.name);
    }
  }
}

export function analyzePrograms(programs: readonly ProgramNode[]): SemanticAnalysisResult {
  const diagnostics: Diagnostic[] = [];
  const brains = new Map<string, BrainNode>();
  const regions = new Map<string, RegionNode>();
  const neurons = new Map<string, NeuronNode>();

  for (const program of programs) {
    const brain = program.brain;
    if (brains.has(brain.id.name)) {
      diagnostics.push(
        error("NEUROSA-E201", `Zduplikowany brain '${brain.id.name}'`, brain.id.span),
      );
    } else {
      brains.set(brain.id.name, brain);
    }

    for (const region of brain.regions) {
      const key = regionKey(brain.id.name, region.id.name);
      if (regions.has(key)) {
        diagnostics.push(
          error("NEUROSA-E202", `Zduplikowany region '${region.id.name}'`, region.id.span),
        );
      } else {
        regions.set(key, region);
      }

      for (const member of region.members) {
        validateDuplicateProperties(member, diagnostics);
        if (member.kind !== "Neuron") continue;

        const key = neuronKey(brain.id.name, member.id.name);
        if (neurons.has(key)) {
          diagnostics.push(
            error("NEUROSA-E203", `Zduplikowany neuron '${member.id.name}'`, member.id.span),
          );
        } else {
          neurons.set(key, member);
        }
      }
    }
  }

  for (const program of programs) {
    const brainId = program.brain.id.name;
    for (const region of program.brain.regions) {
      for (const member of region.members) {
        if (member.kind !== "Synapse") continue;

        if (!neurons.has(neuronKey(brainId, member.source.name))) {
          diagnostics.push(
            error(
              "NEUROSA-E104",
              `Nieznany neuron źródłowy '${member.source.name}'`,
              member.source.span,
            ),
          );
        }
        if (!neurons.has(neuronKey(brainId, member.target.name))) {
          diagnostics.push(
            error(
              "NEUROSA-E105",
              `Nieznany neuron docelowy '${member.target.name}'`,
              member.target.span,
            ),
          );
        }
      }
    }
  }

  return { diagnostics, symbols: { brains, regions, neurons } };
}

export function analyzeProgram(program: ProgramNode): SemanticAnalysisResult {
  return analyzePrograms([program]);
}
