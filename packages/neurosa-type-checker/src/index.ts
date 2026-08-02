import type {
  Diagnostic,
  NeuronNode,
  ProgramNode,
  PropertyNode,
  PropertyValueNode,
  SynapseNode,
} from "@neurosa/ast";

export const NEURON_TYPES = [
  "CONCEPT",
  "NOTE",
  "DECISION",
  "PROJECT",
  "REPOSITORY",
  "TOOL",
  "PERSON",
  "EVENT",
  "EVIDENCE",
  "PROCEDURE",
  "RISK",
  "MEMORY",
  "SYSTEM",
  "UNKNOWN",
] as const;

export const RELATION_TYPES = [
  "REFERENCES",
  "DEPENDS_ON",
  "IMPLEMENTS",
  "SUPPORTS",
  "CONTRADICTS",
  "CAUSED_BY",
  "RESULTED_IN",
  "PART_OF",
  "SUPERSEDES",
  "BLOCKS",
  "VERIFIED_BY",
  "USED_WITH",
  "RELATED_TO",
] as const;

export const SYNAPSE_MODES = ["EXCITATORY", "INHIBITORY"] as const;
export const PLASTICITY_MODES = ["NONE", "HEBBIAN", "STDP"] as const;

type PropertyKind = "number" | "string" | "boolean" | "obsidian" | "enum";

interface PropertySchema {
  readonly kind: PropertyKind;
  readonly values?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly rangeCode?: string;
}

export const NEURON_PROPERTY_SCHEMA: Readonly<Record<string, PropertySchema>> = {
  type: { kind: "enum", values: NEURON_TYPES },
  title: { kind: "string" },
  source: { kind: "obsidian" },
  excerpt: { kind: "string" },
  threshold: { kind: "number", minimum: 0, maximum: 1, rangeCode: "NEUROSA-E310" },
  restingPotential: { kind: "number", minimum: -1, maximum: 1 },
  salience: { kind: "number", minimum: 0, maximum: 1 },
  confidence: { kind: "number", minimum: 0, maximum: 1 },
  enabled: { kind: "boolean" },
};

export const SYNAPSE_PROPERTY_SCHEMA: Readonly<Record<string, PropertySchema>> = {
  relation: { kind: "enum", values: RELATION_TYPES },
  mode: { kind: "enum", values: SYNAPSE_MODES },
  neurotransmitter: { kind: "string" },
  receptor: { kind: "string" },
  weight: { kind: "number", minimum: 0, maximum: 1, rangeCode: "NEUROSA-E309" },
  confidence: { kind: "number", minimum: 0, maximum: 1 },
  transmissionDelayMs: { kind: "number", minimum: 0, maximum: 60_000 },
  decayRate: { kind: "number", minimum: 0, maximum: 1 },
  plasticity: { kind: "enum", values: PLASTICITY_MODES },
};

export interface TypeCheckResult {
  readonly diagnostics: readonly Diagnostic[];
}

function error(code: string, message: string, property: PropertyNode): Diagnostic {
  return { code, message, severity: "error", span: property.value.span };
}

function scalarValue(value: PropertyValueNode): string | number | boolean | undefined {
  return value.kind === "ScalarLiteral" ? value.value : undefined;
}

function expectedType(schema: PropertySchema): string {
  const names: Readonly<Record<PropertyKind, string>> = {
    number: "liczbą",
    string: "tekstem",
    boolean: "wartością logiczną",
    obsidian: "odwołaniem obsidian",
    enum: "identyfikatorem enum",
  };
  return names[schema.kind];
}

function checkProperty(
  property: PropertyNode,
  schema: PropertySchema,
  diagnostics: Diagnostic[],
): void {
  if (schema.kind === "obsidian") {
    if (property.value.kind !== "ObsidianSource") {
      diagnostics.push(
        error(
          "NEUROSA-E305",
          `Właściwość '${property.name.name}' musi mieć postać obsidian("ścieżka")`,
          property,
        ),
      );
    }
    return;
  }

  const value = scalarValue(property.value);
  const actualType = typeof value;
  const requiredType = schema.kind === "enum" ? "string" : schema.kind;
  if (value === undefined || actualType !== requiredType) {
    diagnostics.push(
      error(
        "NEUROSA-E305",
        `Właściwość '${property.name.name}' musi być ${expectedType(schema)}`,
        property,
      ),
    );
    return;
  }

  if (schema.kind === "enum") {
    const normalized = String(value).toUpperCase();
    if (!(schema.values ?? []).includes(normalized)) {
      diagnostics.push(
        error(
          "NEUROSA-E308",
          `Nieprawidłowa wartość enum '${String(value)}' dla właściwości '${property.name.name}'`,
          property,
        ),
      );
    }
    return;
  }

  if (schema.kind !== "number") return;
  const numericValue = value as number;
  const belowMinimum = schema.minimum !== undefined && numericValue < schema.minimum;
  const aboveMaximum = schema.maximum !== undefined && numericValue > schema.maximum;
  if (belowMinimum || aboveMaximum) {
    const range = `${schema.minimum ?? "-∞"}..${schema.maximum ?? "∞"}`;
    diagnostics.push(
      error(
        schema.rangeCode ?? "NEUROSA-E311",
        `Właściwość '${property.name.name}' musi mieścić się w zakresie ${range}; otrzymano ${numericValue}`,
        property,
      ),
    );
  }
}

function checkMember(
  member: NeuronNode | SynapseNode,
  schema: Readonly<Record<string, PropertySchema>>,
  diagnostics: Diagnostic[],
): void {
  for (const property of member.properties) {
    const definition = schema[property.name.name];
    if (definition === undefined) {
      diagnostics.push(
        error(
          "NEUROSA-E307",
          `Nieobsługiwana właściwość ${member.kind === "Neuron" ? "neuronu" : "synapsy"} '${property.name.name}'`,
          property,
        ),
      );
      continue;
    }
    checkProperty(property, definition, diagnostics);
  }
}

export function typeCheckProgram(program: ProgramNode): TypeCheckResult {
  const diagnostics: Diagnostic[] = [];
  for (const region of program.brain.regions) {
    for (const member of region.members) {
      checkMember(
        member,
        member.kind === "Neuron" ? NEURON_PROPERTY_SCHEMA : SYNAPSE_PROPERTY_SCHEMA,
        diagnostics,
      );
    }
  }
  return { diagnostics };
}
