import type { RuntimeUsage } from "./budget.js";
import type { BotManifest, JsonObject, StoredObject } from "./types.js";

export type ExecutionPrincipalKind = "bot" | "worker";

export interface WorkspaceProjectionSource {
  ref: string;
  digest: string;
}

export interface WorkspaceStateProjection {
  schema_version: "1.0";
  provider: string;
  workspace_id: string;
  projection_digest: string;
  projected_at: string;
  sources: WorkspaceProjectionSource[];
  data: JsonObject;
}

export interface WorkspaceStateProjector {
  project(workspaceId: string): WorkspaceStateProjection;
}

/** Generic runtime-only strategic context. Host adapters remain responsible for canonical ownership and freshness. */
export interface StrategicIntentProjection extends JsonObject {
  schema_version: string;
  provider: string;
  workspace_id: string;
  root_objective_id: string;
  intent_digest: string;
  data: JsonObject;
}

/** Generic runtime-only historical recall. Canonical memory remains owned by the host memory engine. */
export interface HistoricalRecallProjection extends JsonObject {
  schema_version: string;
  provider: string;
  workspace_id: string;
  request_digest: string;
  projection_digest: string;
  recalled_at: string;
  sources: JsonObject[];
  data: JsonObject;
}

export interface RuntimeExecutionContext {
  /** Canonical execution identity. Durable Bots and temporary Workers both use this field. */
  principal: StoredObject;
  principalKind: ExecutionPrincipalKind;
  /** Present only for durable Bot execution. Kept as an additive compatibility surface for adapters that need Bot-only metadata. */
  bot?: StoredObject<BotManifest>;
  /** Effective runtime configuration resolved by trusted coordination code. */
  runtime: JsonObject;
  task: StoredObject;
  capabilityLease: StoredObject;
  environmentLease: StoredObject | null;
  inputArtifacts: StoredObject[];
  /** Ephemeral, read-only host workspace context. Never canonical Multiple Bots state. */
  workspaceProjection?: WorkspaceStateProjection | null;
  /** Ephemeral, read-only strategic context supplied by an explicit host adapter. Never canonical Multiple Bots state. */
  strategicIntent?: StrategicIntentProjection | null;
  /** Ephemeral, read-only historical recall supplied only for an explicit Task request. Never canonical Multiple Bots state. */
  memoryRecall?: HistoricalRecallProjection | null;
  signal: AbortSignal;
}

export interface RuntimeExecutionResult {
  summary: string;
  artifactKind: string;
  output: JsonObject;
  usage?: RuntimeUsage;
  receipts?: JsonObject[];
}

export interface RuntimeAdapter {
  readonly id: string;
  execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult>;
  cancel?(taskId: string): Promise<void>;
}

export class RuntimeRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): this {
    if (this.adapters.has(adapter.id)) throw new Error(`Runtime adapter ${adapter.id} already registered`);
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): RuntimeAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Runtime adapter ${id} is not registered`);
    return adapter;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }
}

export class DeterministicRuntimeAdapter implements RuntimeAdapter {
  readonly id = "deterministic";

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Task canceled");
    const objective = String(context.task.payload.objective ?? "");
    const constraints = Array.isArray(context.task.payload.required_constraints)
      ? context.task.payload.required_constraints.map(String)
      : [];

    return {
      summary: `Completed deterministically: ${objective}`,
      artifactKind: "deterministic_task_result",
      output: {
        objective,
        required_constraints: constraints,
        executed_by: context.principal.id,
        execution_principal_kind: context.principalKind,
        runtime_adapter: this.id,
        lease_id: context.capabilityLease.id,
        ...(context.workspaceProjection
          ? { workspace_projection_digest: context.workspaceProjection.projection_digest }
          : {}),
        ...(context.strategicIntent
          ? { strategic_intent_digest: context.strategicIntent.intent_digest }
          : {}),
        ...(context.memoryRecall
          ? { memory_recall_projection_digest: context.memoryRecall.projection_digest }
          : {}),
        result: `Completed: ${objective}`
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cost: 0,
        actions: 1
      },
      receipts: [{ kind: "deterministic_execution", adapter: this.id, principal_kind: context.principalKind }]
    };
  }
}
