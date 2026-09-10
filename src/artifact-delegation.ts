import { normalizeMemoryRecallRequest, type MemoryRecallRequest } from "./ai-verse-memory-recall.js";
import type { DelegateInput, CoordinationGateway } from "./gateway.js";
import type { StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export interface ArtifactAwareDelegateInput extends DelegateInput {
  inputArtifactRefs?: string[];
  /** Optional explicit historical-recall request. It is normalized and bound to the Task before execution can be claimed. */
  memoryRecall?: unknown;
}

export interface ArtifactAwareDelegationResult {
  task: StoredObject;
  lease: StoredObject;
  approval: StoredObject | null;
  event: ReturnType<CoordinationGateway["emit"]>;
  inputArtifacts: StoredObject[];
  memoryRecall: MemoryRecallRequest | null;
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
  const memoryRecall = normalizeMemoryRecallRequest(input.memoryRecall, input.objective);
  const delegated = gateway.delegate(input);
  if (inputArtifacts.length === 0 && !memoryRecall) return { ...delegated, inputArtifacts, memoryRecall };

  const current = gateway.store.getObject(delegated.task.id);
  if (!current || current.kind !== "task") throw new Error(`Delegated Task ${delegated.task.id} disappeared before context attachment`);
  if (current.payload.status !== "assigned" && current.payload.status !== "waiting_approval") {
    throw new Error(`Task ${current.id} cannot receive execution context from status ${String(current.payload.status)}`);
  }

  const queued = gateway.executionQueue?.getByItem(current.id);
  if (queued && queued.state !== "queued") {
    throw new Error(`Task ${current.id} execution was claimed before input context could be attached`);
  }

  const refs = inputArtifacts.map((artifact) => artifact.id);
  const updatedTask = gateway.store.putObject("task", validateProtocolObject({
    ...current.payload,
    ...(inputArtifacts.length > 0 ? {
      input_artifact_refs: refs,
      input_artifacts_attached_at: new Date().toISOString(),
      input_artifacts_attached_by: input.createdBy
    } : {}),
    ...(memoryRecall ? {
      memory_recall: memoryRecall,
      memory_recall_requested_at: new Date().toISOString(),
      memory_recall_requested_by: input.createdBy
    } : {})
  }, "task"));

  if (inputArtifacts.length > 0) {
    gateway.emit({
      type: "task.inputs_attached",
      actorId: input.createdBy,
      workspaceId: input.workspaceId,
      taskId: current.id,
      correlationId: input.rootObjectiveId,
      summary: `Attached ${refs.length} input Artifact${refs.length === 1 ? "" : "s"} to ${current.id}`
    });
  }
  if (memoryRecall) {
    gateway.emit({
      type: "task.memory_recall_requested",
      actorId: input.createdBy,
      workspaceId: input.workspaceId,
      taskId: current.id,
      correlationId: input.rootObjectiveId,
      summary: `Bound explicit AI-Verse Memory recall to ${current.id}`
    });
  }

  return {
    ...delegated,
    task: updatedTask,
    inputArtifacts,
    memoryRecall
  };
}
