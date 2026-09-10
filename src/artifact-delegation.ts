import type { DelegateInput, CoordinationGateway } from "./gateway.js";
import { parseTaskMemoryRecallRequest } from "./memory-recall-runtime.js";
import { parseTaskSkillRefs } from "./skills-capability-runtime.js";
import type { StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export interface ArtifactAwareDelegateInput extends Omit<DelegateInput, "memoryRecall" | "skillRefs"> {
  inputArtifactRefs?: string[];
  /** Untrusted API input; normalized before the canonical Task is created. */
  memoryRecall?: unknown;
  /** Untrusted API input; normalized before the canonical Task is created. */
  skillRefs?: unknown;
}

export interface ArtifactAwareDelegationResult {
  task: StoredObject;
  lease: StoredObject;
  approval: StoredObject | null;
  event: ReturnType<CoordinationGateway["emit"]>;
  inputArtifacts: StoredObject[];
}

function uniqueRefs(refs: string[] | undefined): string[] {
  return [...new Set((refs ?? []).map((ref) => ref.trim()).filter(Boolean))];
}

export function validateDelegationInputArtifacts(
  gateway: CoordinationGateway,
  workspaceId: string,
  refs: string[] | undefined
): StoredObject[] {
  const artifacts: StoredObject[] = [];
  for (const ref of uniqueRefs(refs)) {
    const artifact = gateway.store.getObject(ref);
    if (!artifact || artifact.kind !== "artifact") throw new Error(`Input Artifact ${ref} not found`);
    if (artifact.workspaceId !== workspaceId) {
      throw new Error(`Input Artifact ${ref} is outside workspace ${workspaceId}`);
    }
    artifacts.push(artifact);
  }
  return artifacts;
}

export function delegateWithArtifacts(
  gateway: CoordinationGateway,
  input: ArtifactAwareDelegateInput
): ArtifactAwareDelegationResult {
  const inputArtifacts = validateDelegationInputArtifacts(gateway, input.workspaceId, input.inputArtifactRefs);
  const memoryRecall = parseTaskMemoryRecallRequest(input.memoryRecall);
  const skillRefs = parseTaskSkillRefs(input.skillRefs, input.workspaceId);
  const { inputArtifactRefs: _inputArtifactRefs, memoryRecall: _memoryRecall, skillRefs: _skillRefs, ...delegateInput } = input;
  const delegated = gateway.delegate({
    ...delegateInput,
    ...(memoryRecall ? { memoryRecall } : {}),
    ...(skillRefs.length > 0 ? { skillRefs } : {})
  });
  if (inputArtifacts.length === 0) return { ...delegated, inputArtifacts };

  const current = gateway.store.getObject(delegated.task.id);
  if (!current || current.kind !== "task") throw new Error(`Delegated Task ${delegated.task.id} disappeared before Artifact attachment`);
  if (current.payload.status !== "assigned" && current.payload.status !== "waiting_approval") {
    throw new Error(`Task ${current.id} cannot receive input Artifacts from status ${String(current.payload.status)}`);
  }

  const queued = gateway.executionQueue?.getByItem(current.id);
  if (queued && queued.state !== "queued") {
    throw new Error(`Task ${current.id} execution was claimed before input Artifacts could be attached`);
  }

  const refs = inputArtifacts.map((artifact) => artifact.id);
  const updatedTask = gateway.store.putObject("task", validateProtocolObject({
    ...current.payload,
    input_artifact_refs: refs,
    input_artifacts_attached_at: new Date().toISOString(),
    input_artifacts_attached_by: input.createdBy
  }, "task"));

  gateway.emit({
    type: "task.inputs_attached",
    actorId: input.createdBy,
    workspaceId: input.workspaceId,
    taskId: current.id,
    correlationId: input.rootObjectiveId,
    summary: `Attached ${refs.length} input Artifact${refs.length === 1 ? "" : "s"} to ${current.id}`
  });

  return {
    ...delegated,
    task: updatedTask,
    inputArtifacts
  };
}
