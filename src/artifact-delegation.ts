import type { DelegateInput, CoordinationGateway } from "./gateway.js";
import type { StoredObject } from "./types.js";

export interface ArtifactAwareDelegateInput extends DelegateInput {
  inputArtifactRefs?: string[];
}

export interface ArtifactAwareDelegationResult {
  task: StoredObject;
  lease: StoredObject;
  environmentLease: StoredObject | null;
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
    if (artifact.workspaceId !== workspaceId) throw new Error(`Input Artifact ${ref} is outside workspace ${workspaceId}`);
    artifacts.push(artifact);
  }
  return artifacts;
}

export function delegateWithArtifacts(
  gateway: CoordinationGateway,
  input: ArtifactAwareDelegateInput
): ArtifactAwareDelegationResult {
  const inputArtifacts = validateDelegationInputArtifacts(gateway, input.workspaceId, input.inputArtifactRefs);
  const delegated = gateway.delegate({ ...input, inputArtifactRefs: inputArtifacts.map((artifact) => artifact.id) });
  return { ...delegated, inputArtifacts };
}
