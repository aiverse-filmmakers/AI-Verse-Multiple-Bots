import { createId } from "./id.js";
import type { DelegateInput, CoordinationGateway } from "./gateway.js";
import type { CoordinationEvent, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export interface ArtifactAwareDelegateInput extends DelegateInput {
  inputArtifactRefs?: string[];
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
  const delegated = gateway.delegate(input);
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

  const coordinationEvent: CoordinationEvent = {
    schema_version: "1.0",
    id: createId("evt"),
    type: "task.inputs_attached",
    timestamp: new Date().toISOString(),
    actor_id: input.createdBy,
    workspace_id: input.workspaceId,
    task_id: current.id,
    correlation_id: input.rootObjectiveId,
    summary: `Attached ${refs.length} input Artifact${refs.length === 1 ? "" : "s"} to ${current.id}`
  };
  gateway.store.appendEvent(coordinationEvent);

  return {
    ...delegated,
    task: updatedTask,
    inputArtifacts
  };
}
