import {
  CONTINUITY_V1, continuityTaskPath, continuityCheckpointPath,
  isTaskRecordV1, isCheckpointRecordV1,
  type TaskRecordV1, type CheckpointRecordV1
} from "@neurosa/document-domain";

const task: TaskRecordV1 = {
  schema_version: CONTINUITY_V1, record_type: "task",
  task_id: "task_mastra", project_id: "osa-architecture",
  title: "Benchmark Mastra", goal: "Porównać runtime z Mastra",
  status: "ACTIVE", next_action: "Przeprowadzić test orkiestracji",
  blockers: [], last_checkpoint_id: null, source_refs: ["chat:123"], evidence_refs: [],
  created_at: "2026-10-14T19:00:00.000Z", updated_at: "2026-10-14T19:00:00.000Z"
};
const checkpoint: CheckpointRecordV1 = {
  schema_version: CONTINUITY_V1, record_type: "checkpoint",
  checkpoint_id: "cp_001", task_id: task.task_id, project_id: task.project_id,
  captured_at: "2026-10-14T20:00:00.000Z", status_after: "PAUSED",
  completed_steps: ["Przeanalizowano API"], decisions: ["Test tylko READ_ONLY"],
  open_items: ["Test orkiestracji"], blockers: [],
  next_action: "Przeprowadzić test orkiestracji", source_refs: ["chat:123"],
  evidence_refs: ["git:sha256"], git_refs: ["repo@sha"], verification: "CLAIMED"
};

describe("OSA Continuity V1 — kontrakt kanoniczny", () => {
  it("akceptuje zgodny TaskRecord i CheckpointRecord", () => {
    expect(isTaskRecordV1(task)).toBe(true);
    expect(isCheckpointRecordV1(checkpoint)).toBe(true);
    expect(continuityTaskPath(task.project_id, task.task_id))
      .toBe("continuity/v1/tasks/osa-architecture/task_mastra.md");
    expect(continuityCheckpointPath(task.project_id, task.task_id, checkpoint.checkpoint_id))
      .toBe("continuity/v1/checkpoints/osa-architecture/task_mastra/cp_001.md");
  });
  it("odrzuca błędną wersję, status, dodatkowe pola i przejście ścieżki", () => {
    expect(isTaskRecordV1({ ...task, schema_version: "osa-continuity/v2" })).toBe(false);
    expect(isTaskRecordV1({ ...task, status: "SUPER_DONE" })).toBe(false);
    expect(isTaskRecordV1({ ...task, created_at: "nie-data" })).toBe(false);
    expect(isTaskRecordV1({ ...task, hidden: "unexpected" })).toBe(false);
    expect(isCheckpointRecordV1({ ...checkpoint, verification: "PROVEN" })).toBe(false);
    expect(isCheckpointRecordV1({ ...checkpoint, task_id: "../repo" })).toBe(false);
    expect(() => continuityTaskPath("../other", "task_mastra")).toThrow();
    expect(() => continuityCheckpointPath("osa-architecture", "task_mastra", "../../other")).toThrow();
  });
  it("wymaga jawnego pola next_action nawet gdy zadanie jest PAUSED", () => {
    expect(isTaskRecordV1({ ...task, status: "PAUSED", next_action: "Wracamy do testów" })).toBe(true);
    expect(isTaskRecordV1({ ...task, next_action: undefined })).toBe(false);
  });
});
