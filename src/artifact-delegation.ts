import type { DelegateInput, CoordinationGateway } from "./gateway.js";
import { normalizeMemoryRecallRequest, type MemoryRecallRequest } from "./memory-recall-contract.js";
import type { StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export interface ArtifactAwareDelegateInput extends DelegateInput {
  inputArtifactRefs?: string[];
  memoryRecall?: MemoryRecallRequest;
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
  const memoryRecall = normalizeMemoryRecallRequest(input.memoryRecall);
  const delegated = gateway.delegate(input);
  if (inputArtifacts.length === 0 && !memoryRecall) return { ...delegated, inputArtifacts };

  const current = gateway.store.getObject(delegated.task.id);
  if (!current || current.kind !== "task") throw new Error(`Delegated Task ${delegated.task.id} disappeared before execution-context attachment`);
  if (current.payload.status !== "assigned" && current.payload.status !== "waiting_approval") {
    throw new Error(`Task ${current.id} cannot receive execution context from status ${String(current.payload.status)}`);
  }

  const queued = gateway.executionQueue?.getByItem(current.id);
  if (queued && queued.state !== "queued") {
    throw new Error(`Task ${current.id} execution was claimed before execution context could be attached`);
  }

  const refs = inputArtifacts.map((artifact) => artifact.id);
  const timestamp = new Date().toISOString();
  const updatedTask = gateway.store.putObject("task", validateProtocolObject({
    ...current.payload,
    input_artifact_refs: refs,
    ...(memoryRecall ? { memory_recall: memoryRecall } : {}),
    execution_context_attached_at: timestamp,
    execution_context_attached_by: input.createdBy,
    ...(refs.length > 0 ? {
      input_artifacts_attached_at: timestamp,
      input_artifacts_attached_by: input.createdBy
    } : {})
  }, "task"));

  gateway.emit({
    type: "task.inputs_attached",
    actorId: input.createdBy,
    workspaceId: input.workspaceId,
    taskId: current.id,
    correlationId: input.rootObjectiveId,
    summary: memoryRecall
      ? `Attached ${refs.length} input Artifact${refs.length === 1 ? "" : "s"} and bounded memory recall to ${current.id}`
      : `Attached ${refs.length} input Artifact${refs.length === 1 ? "" : "s"} to ${current.id}`
  });

  return {
    ...delegated,
    task: updatedTask,
    inputArtifacts
  };
}
