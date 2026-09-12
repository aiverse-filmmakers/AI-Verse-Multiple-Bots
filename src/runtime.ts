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

export interface HistoricalRecallRequest {
  query: string;
  limit?: number;
  include_history?: boolean;
}

export interface HistoricalRecallItem {
  id: string;
  kind: string;
  type: string;
  scope: string;
  content: string;
  why?: string | null;
  path: string;
  digest: string;
  source_identity?: string | null;
  source?: string | null;
  updated_at?: string | null;
  source_version?: string | null;
  freshness?: string | null;
  indexed_at?: string | null;
  importance?: number | null;
  confidence?: number | null;
}

/** Ephemeral historical/contextual evidence. Canonical ownership remains with the host Memory provider. */
export interface HistoricalRecallProjection {
  schema_version: "1.0";
  provider: string;
  provider_version?: string | null;
  workspace_id: string;
  query_digest: string;
  recall_digest: string;
  recalled_at: string;
  include_history: boolean;
  requested_limit: number;
  items: HistoricalRecallItem[];
}

export interface HistoricalRecallSource {
  recall(workspaceId: string, request: HistoricalRecallRequest): Promise<HistoricalRecallProjection>;
}

export interface ResolvedSkillCapability extends JsonObject {
  requested_ref: string;
  id: string;
  name: string;
  description: string;
  provider: string;
  visibility: string;
  version: string;
  generation_id: string;
  path: string;
  digest_algorithm: string;
  digest: string;
  readiness: string;
  permission: string;
  approval: string;
  operators: string[];
  dependencies: string[];
  instructions: string;
  instruction_digest: string;
}

/**
 * Ephemeral task-scoped skill instructions resolved by the host capability resolver.
 * Resolution never grants tool, connection, permission, or approval authority.
 */
export interface SkillsCapabilityProjection {
  schema_version: "1.0";
  provider: string;
  workspace_id: string;
  request_digest: string;
  resolution_digest: string;
  resolved_at: string;
  capabilities: ResolvedSkillCapability[];
}

export interface SkillsCapabilitySource {
  resolve(workspaceId: string, skillRefs: string[]): Promise<SkillsCapabilityProjection>;
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
  /** Ephemeral, lower-authority historical evidence returned only for an explicit Task recall request. */
  historicalRecall?: HistoricalRecallProjection | null;
  /** Ephemeral task-scoped method instructions selected by the host capability resolver. Never an authority grant. */
  skillsCapabilityResolution?: SkillsCapabilityProjection | null;
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
  /**
   * Called only after the local coordination store has durably settled the Task.
   * Recovery-aware adapters use this to discard cached remote recovery state.
   */
  settle?(taskId: string): Promise<void>;
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
        ...(context.historicalRecall
          ? { historical_recall_digest: context.historicalRecall.recall_digest }
          : {}),
        ...(context.skillsCapabilityResolution
          ? { skills_capability_resolution_digest: context.skillsCapabilityResolution.resolution_digest }
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
