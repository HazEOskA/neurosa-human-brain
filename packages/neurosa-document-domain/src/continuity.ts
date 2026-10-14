/** OSA Continuity V1 — typy i walidacja. Jedyny kanoniczny magazyn: dokumenty NeurOSA. */
export const CONTINUITY_V1 = "osa-continuity/v1" as const;
export const TASK_STATUSES = ["BACKLOG", "ACTIVE", "PAUSED", "BLOCKED", "DONE", "ARCHIVED"] as const;
export const PROOF_STATUSES = ["UNKNOWN", "CLAIMED", "VERIFIED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type ProofStatus = (typeof PROOF_STATUSES)[number];

export interface TaskRecordV1 {
  schema_version: typeof CONTINUITY_V1;
  record_type: "task";
  task_id: string;
  project_id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  next_action: string;
  blockers: string[];
  last_checkpoint_id: string | null;
  source_refs: string[];
  evidence_refs: string[];
  created_at: string;
  updated_at: string;
}

export interface CheckpointRecordV1 {
  schema_version: typeof CONTINUITY_V1;
  record_type: "checkpoint";
  checkpoint_id: string;
  task_id: string;
  project_id: string;
  captured_at: string;
  status_after: TaskStatus;
  completed_steps: string[];
  decisions: string[];
  open_items: string[];
  blockers: string[];
  next_action: string;
  source_refs: string[];
  evidence_refs: string[];
  git_refs: string[];
  verification: ProofStatus;
}

const slug = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z0-9][a-z0-9_-]{2,79}$/u.test(v);
const bounded = (v: unknown, max: number, empty = false): v is string =>
  typeof v === "string" && v.length <= max && (empty || v.trim().length > 0);
const list = (v: unknown, count = 50): v is string[] =>
  Array.isArray(v) && v.length <= count && v.every((x) => bounded(x, 2000));
const iso = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(v) &&
  Number.isFinite(Date.parse(v));
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k)) && keys.every((k) => Object.hasOwn(v, k));
const taskKeys = ["schema_version","record_type","task_id","project_id","title","goal",
  "status","next_action","blockers","last_checkpoint_id","source_refs","evidence_refs","created_at","updated_at"];
const checkpointKeys = ["schema_version","record_type","checkpoint_id","task_id","project_id",
  "captured_at","status_after","completed_steps","decisions","open_items","blockers",
  "next_action","source_refs","evidence_refs","git_refs","verification"];

export function isTaskRecordV1(v: unknown): v is TaskRecordV1 {
  if (!object(v) || !exact(v, taskKeys)) return false;
  return v.schema_version === CONTINUITY_V1 && v.record_type === "task" &&
    slug(v.task_id) && slug(v.project_id) && bounded(v.title, 200) &&
    bounded(v.goal, 2000) && TASK_STATUSES.includes(v.status as TaskStatus) &&
    bounded(v.next_action, 2000, true) && list(v.blockers, 30) &&
    (v.last_checkpoint_id === null || slug(v.last_checkpoint_id)) &&
    list(v.source_refs) && list(v.evidence_refs) && iso(v.created_at) &&
    iso(v.updated_at) && Date.parse(v.updated_at) >= Date.parse(v.created_at);
}
export function isCheckpointRecordV1(v: unknown): v is CheckpointRecordV1 {
  if (!object(v) || !exact(v, checkpointKeys)) return false;
  return v.schema_version === CONTINUITY_V1 && v.record_type === "checkpoint" &&
    slug(v.checkpoint_id) && slug(v.task_id) && slug(v.project_id) &&
    iso(v.captured_at) && TASK_STATUSES.includes(v.status_after as TaskStatus) &&
    list(v.completed_steps) && list(v.decisions) && list(v.open_items) &&
    list(v.blockers, 30) && bounded(v.next_action, 2000, true) &&
    list(v.source_refs) && list(v.evidence_refs) && list(v.git_refs) &&
    PROOF_STATUSES.includes(v.verification as ProofStatus);
}
export function continuityTaskPath(projectId: string, taskId: string): string {
  if (!slug(projectId) || !slug(taskId)) throw new Error("Nieprawidłowy identyfikator zadania");
  return `continuity/v1/tasks/${projectId}/${taskId}.md`;
}
export function continuityCheckpointPath(projectId: string, taskId: string, checkpointId: string): string {
  if (!slug(checkpointId)) throw new Error("Nieprawidłowy identyfikator checkpointu");
  return `continuity/v1/checkpoints/${projectId}/${taskId}/${checkpointId}.md`;
}
