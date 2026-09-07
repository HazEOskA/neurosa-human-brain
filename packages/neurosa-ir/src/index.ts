import { z } from "zod";

export const NEURAL_IR_VERSION = "0.1" as const;

export const NeuronTypeSchema = z.enum([
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
]);

export const RelationTypeSchema = z.enum([
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
]);

export const NeuralRegionIRSchema = z.object({
  id: z.string().min(1),
  neuronIds: z.array(z.string().min(1)),
});

export const NeuronIRSchema = z.object({
  id: z.string().min(1),
  regionId: z.string().min(1),
  type: NeuronTypeSchema,
  title: z.string(),
  sourcePath: z.string().nullable(),
  excerpt: z.string(),
  threshold: z.number().min(0).max(1),
  restingPotential: z.number().min(-1).max(1),
  salience: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  enabled: z.boolean(),
});

export const SynapseIRSchema = z.object({
  id: z.string().min(1),
  regionId: z.string().min(1),
  sourceNeuronId: z.string().min(1),
  targetNeuronId: z.string().min(1),
  relationType: RelationTypeSchema,
  mode: z.enum(["EXCITATORY", "INHIBITORY"]),
  neurotransmitter: z.string().min(1),
  receptor: z.string().min(1),
  weight: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  transmissionDelayMs: z.number().min(0).max(60_000),
  decayRate: z.number().min(0).max(1),
  plasticity: z.enum(["NONE", "HEBBIAN", "STDP"]),
});

export const ProteinIRSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
export const PathwayIRSchema = z.object({
  id: z.string().min(1),
  neuronIds: z.array(z.string().min(1)),
});
export const RuntimePolicyIRSchema = z.object({ id: z.string().min(1) });

export const NeuralProgramSchema = z.object({
  version: z.literal(NEURAL_IR_VERSION),
  brainId: z.string().min(1),
  regions: z.array(NeuralRegionIRSchema),
  neurons: z.array(NeuronIRSchema),
  synapses: z.array(SynapseIRSchema),
  proteins: z.array(ProteinIRSchema),
  pathways: z.array(PathwayIRSchema),
  policies: z.array(RuntimePolicyIRSchema),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type NeuralRegionIR = z.infer<typeof NeuralRegionIRSchema>;
export type NeuronIR = z.infer<typeof NeuronIRSchema>;
export type SynapseIR = z.infer<typeof SynapseIRSchema>;
export type ProteinIR = z.infer<typeof ProteinIRSchema>;
export type PathwayIR = z.infer<typeof PathwayIRSchema>;
export type RuntimePolicyIR = z.infer<typeof RuntimePolicyIRSchema>;
export type NeuralProgram = z.infer<typeof NeuralProgramSchema>;

export function validateNeuralProgram(program: unknown): NeuralProgram {
  return NeuralProgramSchema.parse(program);
}

export function serializeNeuralProgram(program: NeuralProgram): string {
  return `${JSON.stringify(validateNeuralProgram(program), null, 2)}\n`;
}
