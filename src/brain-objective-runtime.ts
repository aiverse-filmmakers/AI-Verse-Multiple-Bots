import {
  assertBrainProjectionExecutable,
  parseBrainRootObjectiveId,
  type BrainObjectiveSource
} from "./brain-objective-ingress.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeExecutionContext,
  type RuntimeExecutionResult
} from "./runtime.js";
import type { JsonObject } from "./types.js";

/**
 * Host-adapter runtime fence for Tasks descended from a Brain objective root.
 *
 * The root objective ID carries the semantic intent digest. Before any runtime
 * executes, this wrapper re-reads canonical Brain state and proves that the
 * exact workspace/object is still executable and semantically unchanged.
 * Full Brain content is injected only into the ephemeral runtime context; the
 * returned receipt contains provenance/digests only.
 */
export class BrainObjectiveRuntimeRegistry extends RuntimeRegistry {
  private readonly guarded = new Map<string, RuntimeAdapter>();

  constructor(readonly base: RuntimeRegistry, readonly source: BrainObjectiveSource) {
    super();
  }

  override register(adapter: RuntimeAdapter): this {
    this.base.register(adapter);
    return this;
  }

  override has(id: string): boolean {
    return this.base.has(id);
  }

  override get(id: string): RuntimeAdapter {
    const existing = this.guarded.get(id);
    if (existing) return existing;
    const inner = this.base.get(id);
    const source = this.source;
    const guarded: RuntimeAdapter = {
      id: inner.id,
      async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
        const rootObjectiveId = String(context.task.payload.root_objective_id ?? "");
        const binding = parseBrainRootObjectiveId(rootObjectiveId);
        if (!binding) return inner.execute(context);

        const workspaceId = context.task.workspaceId;
        if (!workspaceId || !context.principal.workspaceId || context.principal.workspaceId !== workspaceId) {
          throw new Error(`Brain strategic intent requires Task ${context.task.id} and ${context.principal.id} to share one explicit workspace`);
        }

        const projection = source.project(workspaceId, binding.objectiveId);
        if (projection.workspace_id !== workspaceId) {
          throw new Error(`Brain objective source returned workspace ${projection.workspace_id} for Task workspace ${workspaceId}`);
        }
        assertBrainProjectionExecutable(projection, binding.intentDigest, false);
        if (projection.root_objective_id !== rootObjectiveId) {
          throw new Error(`Brain objective ${binding.objectiveId} no longer matches Task ${context.task.id} root objective`);
        }

        const result = await inner.execute({ ...context, strategicIntent: projection });
        const receipt: JsonObject = {
          kind: "brain_strategic_intent",
          provider: projection.provider,
          schema_version: projection.schema_version,
          workspace_id: projection.workspace_id,
          root_objective_id: projection.root_objective_id,
          objective_ref: projection.source.ref,
          objective_revision: projection.source.revision,
          objective_source_digest: projection.source.source_digest,
          intent_digest: projection.intent_digest,
          parent_ref: projection.parent_source?.ref ?? null,
          parent_revision: projection.parent_source?.revision ?? null,
          parent_source_digest: projection.parent_source?.source_digest ?? null
        };
        return { ...result, receipts: [...(result.receipts ?? []), receipt] };
      },
      ...(inner.cancel ? { cancel: (taskId: string) => inner.cancel!(taskId) } : {})
    };
    this.guarded.set(id, guarded);
    return guarded;
  }
}
