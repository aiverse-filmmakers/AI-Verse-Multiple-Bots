import { assertUsageWithinBudget, BudgetError, type RuntimeUsage } from "./budget.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { normalizeMemoryRecallRequest, type MemoryRecallProvider } from "./memory-recall-contract.js";
import { PrincipalRunner as BasePrincipalRunner, type CancelResult, type RunResult } from "./principal-runner.js";
import { RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult, type WorkspaceStateProjector } from "./runtime.js";
import { CoordinationStore } from "./store.js";
import { TeamRunControl } from "./team-run-control.js";
import { TeamRunCoordinator } from "./team-runs.js";
import type { JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export type { RunResult, CancelResult } from "./principal-runner.js";

const EXECUTABLE_RUN_STATES = new Set(["running", "synthesizing", "verifying"]);
const OPTIMISTIC_RETRY_LIMIT = 4;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function usage(value: unknown): RuntimeUsage {
  const source = asObject(value);
  return {
    input_tokens: Number(source.input_tokens ?? 0),
    output_tokens: Number(source.output_tokens ?? 0),
    cost: Number(source.cost ?? 0),
    actions: Number(source.actions ?? 0)
  };
}

function addUsage(a: RuntimeUsage, b: RuntimeUsage): RuntimeUsage {
  return {
    input_tokens: Number(a.input_tokens ?? 0) + Number(b.input_tokens ?? 0),
    output_tokens: Number(a.output_tokens ?? 0) + Number(b.output_tokens ?? 0),
    cost: Number(a.cost ?? 0) + Number(b.cost ?? 0),
    actions: Number(a.actions ?? 0) + Number(b.actions ?? 0)
  };
}

function assertBudgetDoesNotExpand(parentValue: unknown, childValue: unknown, label: string): void {
  const parent = asObject(parentValue);
  const child = asObject(childValue);
  for (const key of ["token_limit", "cost_limit", "wall_clock_seconds", "max_hops", "max_messages", "max_rounds", "max_tasks", "max_actions"]) {
    const p = parent[key];
    const c = child[key];
    if (typeof p === "number" && typeof c === "number" && c > p) {
      throw new BudgetError("WORKER_BUDGET_EXPANSION", `${label} ${key} ${c} exceeds Team Run limit ${p}`);
    }
  }
}

class WorkspaceProjectedRuntimeRegistry extends RuntimeRegistry {
  private readonly projected = new Map<string, RuntimeAdapter>();

  constructor(readonly base: RuntimeRegistry, readonly projector?: WorkspaceStateProjector) {
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
    if (!this.projector) return this.base.get(id);
    const existing = this.projected.get(id);
    if (existing) return existing;
    const inner = this.base.get(id);
    const projector = this.projector;
    const projected: RuntimeAdapter = {
      id: inner.id,
      async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
        const taskWorkspaceId = context.task.workspaceId;
        const principalWorkspaceId = context.principal.workspaceId;
        if (!taskWorkspaceId || !principalWorkspaceId || taskWorkspaceId !== principalWorkspaceId) {
          throw new Error(`Workspace projection requires Task ${context.task.id} and ${context.principal.id} to share one explicit workspace`);
        }
        const projection = projector.project(taskWorkspaceId);
        if (projection.workspace_id !== taskWorkspaceId) {
          throw new Error(`Workspace projector returned ${projection.workspace_id} for Task workspace ${taskWorkspaceId}`);
        }
        const result = await inner.execute({ ...context, workspaceProjection: projection });
        const projectionReceipt: JsonObject = {
          kind: "workspace_state_projection",
          provider: projection.provider,
          schema_version: projection.schema_version,
          workspace_id: projection.workspace_id,
          projection_digest: projection.projection_digest,
          sources: projection.sources.map((source) => ({ ref: source.ref, digest: source.digest }))
        };
        return {
          ...result,
          receipts: [...(result.receipts ?? []), projectionReceipt]
        };
      },
      ...(inner.cancel ? { cancel: (taskId: string) => inner.cancel!(taskId) } : {})
    };
    this.projected.set(id, projected);
    return projected;
  }
}

class MemoryRecallRuntimeRegistry extends RuntimeRegistry {
  private readonly recalled = new Map<string, RuntimeAdapter>();

  constructor(readonly base: RuntimeRegistry, readonly provider?: MemoryRecallProvider) {
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
    const existing = this.recalled.get(id);
    if (existing) return existing;
    const inner = this.base.get(id);
    const provider = this.provider;
    const recalled: RuntimeAdapter = {
      id: inner.id,
      async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
        const request = normalizeMemoryRecallRequest(context.task.payload.memory_recall);
        if (!request) return inner.execute(context);
        if (!provider) {
          throw new Error(`Task ${context.task.id} requests memory recall but no MemoryRecallProvider is configured`);
        }
        const taskWorkspaceId = context.task.workspaceId;
        const principalWorkspaceId = context.principal.workspaceId;
        if (!taskWorkspaceId || !principalWorkspaceId || taskWorkspaceId !== principalWorkspaceId) {
          throw new Error(`Memory recall requires Task ${context.task.id} and ${context.principal.id} to share one explicit workspace`);
        }
        const rootObjectiveId = typeof context.task.payload.root_objective_id === "string"
          ? context.task.payload.root_objective_id
          : "";
        if (!rootObjectiveId) throw new Error(`Memory recall Task ${context.task.id} has no root objective`);

        const projection = await provider.recall({
          workspaceId: taskWorkspaceId,
          principalId: context.principal.id,
          principalKind: context.principalKind,
          taskId: context.task.id,
          rootObjectiveId,
          request,
          signal: context.signal
        });
        if (projection.workspace_id !== taskWorkspaceId) {
          throw new Error(`Memory recall provider returned ${projection.workspace_id} for Task workspace ${taskWorkspaceId}`);
        }
        if (JSON.stringify(projection.request) !== JSON.stringify(request)) {
          throw new Error(`Memory recall provider changed the requested recall contract for Task ${context.task.id}`);
        }
        if (!Array.isArray(projection.sources) || projection.sources.length > request.limit) {
          throw new Error(`Memory recall provider exceeded the requested source limit for Task ${context.task.id}`);
        }

        const result = await inner.execute({ ...context, memoryRecall: projection });
        const receipt: JsonObject = {
          kind: "memory_recall_projection",
          provider: projection.provider,
          schema_version: projection.schema_version,
          workspace_id: projection.workspace_id,
          query_digest: projection.query_digest,
          projection_digest: projection.projection_digest,
          source_count: projection.sources.length,
          sources: projection.sources.map((source) => ({
            ref: source.ref,
            digest: source.digest,
            scope: source.scope,
            kind: source.kind,
            type: source.type
          }))
        };
        return {
          ...result,
          receipts: [...(result.receipts ?? []), receipt]
        };
      },
      ...(inner.cancel ? { cancel: (taskId: string) => inner.cancel!(taskId) } : {})
    };
    this.recalled.set(id, recalled);
    return recalled;
  }
}

class TeamRunGuardedRuntimeRegistry extends RuntimeRegistry {
  private readonly guarded = new Map<string, RuntimeAdapter>();

  constructor(readonly base: RuntimeRegistry, readonly store: CoordinationStore) {
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
    const store = this.store;
    const guarded: RuntimeAdapter = {
      id: inner.id,
      async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
        const runId = typeof context.task.payload.run_id === "string" ? context.task.payload.run_id : null;
        if (!runId) return inner.execute(context);

        const run = store.getObject(runId);
        if (!run || run.kind !== "team_run") throw new Error(`Team Run ${runId} not found for Task ${context.task.id}`);
        if (!EXECUTABLE_RUN_STATES.has(String(run.payload.status))) {
          throw new Error(`Team Run ${runId} is not executable from status ${String(run.payload.status)}`);
        }
        if (run.workspaceId !== context.task.workspaceId || context.principal.workspaceId !== run.workspaceId) {
          throw new Error(`Team Run ${runId}, Task ${context.task.id}, and ${context.principal.id} do not share one workspace`);
        }
        if (String(context.task.payload.root_objective_id) !== String(run.payload.root_objective_id)) {
          throw new Error(`Task ${context.task.id} does not preserve Team Run ${runId} root objective`);
        }
        const leaderId = String(run.payload.leader_id ?? "");
        const leader = store.getObject(leaderId);
        if (!leader || leader.kind !== "bot" || leader.payload.status !== "active" || leader.workspaceId !== run.workspaceId) {
          throw new Error(`Team Run ${runId} has no active same-workspace durable leader`);
        }
        const participants = stringArray(run.payload.participant_ids);
        if (context.principalKind === "bot" && context.principal.id !== leaderId && !participants.includes(context.principal.id)) {
          throw new Error(`Bot ${context.principal.id} is not a participant in Team Run ${runId}`);
        }
        if (context.principalKind === "worker" && String(context.principal.payload.run_id) !== runId) {
          throw new Error(`Worker ${context.principal.id} is outside Team Run ${runId}`);
        }
        assertBudgetDoesNotExpand(run.payload.budget, context.task.payload.budget, `Task ${context.task.id}`);

        const result = await inner.execute(context);
        let aggregate: RuntimeUsage = { input_tokens: 0, output_tokens: 0, cost: 0, actions: 0 };
        for (const task of store.listObjects("task", run.workspaceId ?? undefined)) {
          if (task.id === context.task.id || task.payload.run_id !== runId || task.payload.status !== "completed") continue;
          aggregate = addUsage(aggregate, usage(task.payload.usage));
        }
        aggregate = addUsage(aggregate, usage(result.usage));
        try {
          assertUsageWithinBudget(run.payload.budget, aggregate);
        } catch (error) {
          if (error instanceof BudgetError) {
            throw new BudgetError(`TEAM_RUN_${error.code}`, `Team Run ${runId}: ${error.message}`);
          }
          throw error;
        }
        return result;
      },
      ...(inner.cancel ? { cancel: (taskId: string) => inner.cancel!(taskId) } : {})
    };
    this.guarded.set(id, guarded);
    return guarded;
  }
}

export interface PrincipalRunnerOptions {
  runnerId?: string;
  executionLeaseSeconds?: number;
  heartbeatIntervalMs?: number;
  workspaceProjector?: WorkspaceStateProjector;
  memoryRecallProvider?: MemoryRecallProvider;
}

/**
 * Public common execution runner.
 *
 * It preserves the mature Phase 1 execution engine while adding a runtime guard
 * for any Task carrying `run_id`. This means durable Bots and temporary Workers
 * are both subject to the TeamRun lifecycle, participant scope, root objective,
 * and aggregate budget before a runtime result can become an Artifact.
 */
export class PrincipalRunner extends BasePrincipalRunner {
  readonly teamRunControl: TeamRunControl;

  constructor(
    store: CoordinationStore,
    gateway: CoordinationGateway,
    queue: ExecutionQueue,
    runtimes: RuntimeRegistry,
    runnerIdOrOptions?: string | PrincipalRunnerOptions,
    executionLeaseSeconds?: number,
    heartbeatIntervalMs?: number
  ) {
    const options: PrincipalRunnerOptions = typeof runnerIdOrOptions === "object" && runnerIdOrOptions !== null
      ? runnerIdOrOptions
      : {
          runnerId: runnerIdOrOptions,
          executionLeaseSeconds,
          heartbeatIntervalMs
        };
    const projectedRuntimes = new WorkspaceProjectedRuntimeRegistry(runtimes, options.workspaceProjector);
    const contextualRuntimes = new MemoryRecallRuntimeRegistry(projectedRuntimes, options.memoryRecallProvider);
    super(
      store,
      gateway,
      queue,
      new TeamRunGuardedRuntimeRegistry(contextualRuntimes, store),
      options.runnerId,
      options.executionLeaseSeconds,
      options.heartbeatIntervalMs
    );
    this.teamRunControl = new TeamRunControl(new TeamRunCoordinator(store), gateway, queue, this);
  }

  override async runNext(targetId: string): Promise<RunResult | null> {
    const queued = this.queue.list(targetId, ["queued"])[0];
    if (queued?.itemKind === "task") {
      const guard = await this.teamRunControl.guardQueuedTask(queued.itemId);
      if (!guard.executable) return null;
    }

    this.prepareTeamRunHandoffSettlement(targetId);
    const result = await super.runNext(targetId);
    if (!result) return null;

    const persistedTask = this.store.getObject(result.task.id);
    const task = persistedTask?.kind === "task" ? persistedTask : result.task;
    const runId = typeof task.payload.run_id === "string" ? task.payload.run_id : null;
    if (!runId) return result;

    this.persistRunUsage(runId);

    const outcome = result.status === "completed" ? "completed" : result.status === "canceled" ? "canceled" : "failed";
    const genericSettlement = this.gateway.settleHandoffForTask(task.id, outcome, targetId);
    let finalTask = genericSettlement?.task ?? this.store.getObject(task.id) ?? result.task;
    finalTask = this.normalizeTeamRunCompletionOwner(finalTask.id, outcome, targetId) ?? finalTask;

    const run = this.store.getObject(runId);
    const leaderId = run?.kind === "team_run" ? String(run.payload.leader_id ?? "") : "";
    if (leaderId && result.status === "failed" && String(finalTask.payload.failure_code ?? "").startsWith("TEAM_RUN_")) {
      await this.teamRunControl.exhaustBudget(runId, leaderId, String(finalTask.payload.failure_reason ?? "Team Run budget exhausted"), task.id);
    }

    if (leaderId && result.status === "canceled" && typeof finalTask.payload.team_run_budget_deadline_at === "string") {
      const deadlineMs = Date.parse(finalTask.payload.team_run_budget_deadline_at);
      if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
        await this.teamRunControl.exhaustBudget(
          runId,
          leaderId,
          `Team Run ${runId} exceeded its absolute wall-clock deadline ${finalTask.payload.team_run_budget_deadline_at}`,
          task.id
        );
      }
    }

    const latestRun = this.store.getObject(runId);
    if (latestRun?.kind === "team_run" && new Set(["canceled", "budget_exhausted"]).has(String(latestRun.payload.status))) {
      await this.teamRunControl.reconcileTerminalRun(runId);
    }
    return { ...result, task: this.store.getObject(finalTask.id) ?? finalTask };
  }

  override async cancelTask(taskId: string, actorId: string, reason = "Canceled by operator or owner"): Promise<CancelResult> {
    const result = await super.cancelTask(taskId, actorId, reason);
    const events = [...result.events];
    const tasks = result.tasks.map((task) => {
      if (typeof task.payload.run_id !== "string") return task;
      const settlement = this.gateway.settleHandoffForTask(task.id, "canceled", actorId);
      if (settlement) events.push(...settlement.events);
      return settlement?.task ?? this.store.getObject(task.id) ?? task;
    });
    return { tasks, events };
  }

  /**
   * TeamRun direct handoff reuses the Phase 1 Handoff object. The canonical
   * `return_on_completion` default normally returns to `source_owner_id`, but a
   * temporary TeamRun source may already be terminal after transfer. Before the
   * Task is claimable we therefore translate that canonical policy to
   * `stay_with_target` and record an additive TeamRun return-to-leader contract.
   */
  private prepareTeamRunHandoffSettlement(targetId: string): void {
    for (let attempt = 0; attempt < OPTIMISTIC_RETRY_LIMIT; attempt += 1) {
      const execution = this.queue.list(targetId, ["queued"])[0];
      if (!execution || execution.itemKind !== "task") return;
      const task = this.store.getObject(execution.itemId);
      if (!task || task.kind !== "task" || typeof task.payload.run_id !== "string") return;
      const handoffId = typeof task.payload.handoff_id === "string" ? task.payload.handoff_id : null;
      if (!handoffId) return;
      const handoff = this.store.getObject(handoffId);
      if (!handoff || handoff.kind !== "handoff" || handoff.payload.status !== "accepted") return;
      if (String(handoff.payload.run_id ?? "") !== String(task.payload.run_id)) return;
      if (String(handoff.payload.return_policy ?? "") !== "return_on_completion") return;
      if (handoff.payload.team_run_return_policy !== undefined) return;
      if (String(task.payload.owner_id ?? "") !== targetId || String(task.payload.assignee_id ?? "") !== targetId) return;

      const run = this.store.getObject(String(task.payload.run_id));
      if (!run || run.kind !== "team_run") return;
      const leaderId = String(run.payload.leader_id ?? "");
      if (!leaderId) return;
      const timestamp = new Date().toISOString();
      const updatedHandoff = validateProtocolObject({
        ...handoff.payload,
        return_policy: "stay_with_target",
        team_run_return_policy: "return_to_leader",
        return_owner_id: leaderId,
        team_run_return_normalized_at: timestamp
      }, "handoff");
      try {
        this.store.atomicMutation({
          preconditions: [
            { id: handoff.id, kind: "handoff", status: "accepted" },
            { id: task.id, kind: "task", status: "assigned", ownerId: targetId },
            { id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt }
          ],
          objects: [{ kind: "handoff", payload: updatedHandoff }],
          events: []
        });
        return;
      } catch (error) {
        const optimisticConflict = error instanceof Error && error.message.includes("changed since it was read");
        if (!optimisticConflict || attempt === OPTIMISTIC_RETRY_LIMIT - 1) throw error;
      }
    }
  }

  private normalizeTeamRunCompletionOwner(
    taskId: string,
    outcome: "completed" | "failed" | "canceled",
    executionTargetId: string
  ): StoredObject | null {
    if (outcome !== "completed") return null;
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task" || typeof task.payload.run_id !== "string") return null;
    const handoffId = typeof task.payload.handoff_id === "string" ? task.payload.handoff_id : null;
    if (!handoffId) return null;
    const handoff = this.store.getObject(handoffId);
    if (!handoff || handoff.kind !== "handoff" || handoff.payload.status !== "completed") return null;
    if (String(handoff.payload.run_id ?? "") !== String(task.payload.run_id)) return null;
    if (String(handoff.payload.team_run_return_policy ?? "") !== "return_to_leader") return null;

    const run = this.store.getObject(String(task.payload.run_id));
    const returnOwnerId = typeof handoff.payload.return_owner_id === "string" ? handoff.payload.return_owner_id : null;
    const returnOwner = returnOwnerId ? this.store.getObject(returnOwnerId) : null;
    const validReturnOwner = Boolean(
      run
      && run.kind === "team_run"
      && returnOwner
      && returnOwner.kind === "bot"
      && returnOwner.payload.status === "active"
      && returnOwner.workspaceId === task.workspaceId
      && run.workspaceId === task.workspaceId
      && String(run.payload.leader_id ?? "") === returnOwner.id
    );
    const timestamp = new Date().toISOString();

    if (!validReturnOwner || !returnOwner) {
      if (handoff.payload.return_skipped_reason === undefined) {
        this.store.putObject("handoff", validateProtocolObject({
          ...handoff.payload,
          ownership_returned: false,
          settled_owner_id: String(task.payload.owner_id ?? executionTargetId),
          return_skipped_reason: "Durable Team Run leader was unavailable at completion settlement",
          team_run_return_normalized_at: timestamp
        }, "handoff"));
        this.gateway.emit({
          type: "handoff.return_skipped",
          actorId: executionTargetId,
          workspaceId: task.workspaceId,
          runId: String(task.payload.run_id),
          taskId,
          correlationId: String(task.payload.root_objective_id),
          summary: `Kept ${taskId} with its completed target because the durable Team Run leader was unavailable`,
          attentionState: "unread_result"
        });
      }
      return task;
    }

    const currentOwnerId = String(task.payload.owner_id ?? "");
    if (currentOwnerId !== executionTargetId && currentOwnerId !== returnOwner.id) return null;
    const updatedHandoff = validateProtocolObject({
      ...handoff.payload,
      ownership_returned: true,
      settled_owner_id: returnOwner.id,
      return_owner_id: returnOwner.id,
      team_run_returned_at: timestamp,
      team_run_return_normalized_at: timestamp
    }, "handoff");
    if (currentOwnerId === returnOwner.id) {
      this.store.putObject("handoff", updatedHandoff);
      return task;
    }

    const updatedTask = validateProtocolObject({
      ...task.payload,
      owner_id: returnOwner.id,
      ownership_returned_at: timestamp,
      ownership_returned_from: executionTargetId,
      ownership_returned_by_handoff: handoff.id
    }, "task");
    const mutation = this.store.atomicMutation({
      preconditions: [
        { id: handoff.id, kind: "handoff", status: "completed" },
        { id: task.id, kind: "task", status: "completed", ownerId: executionTargetId }
      ],
      objects: [
        { kind: "handoff", payload: updatedHandoff },
        { kind: "task", payload: updatedTask }
      ],
      events: []
    });
    const normalizedTask = mutation.objects.find((object) => object.id === task.id) ?? task;
    this.gateway.emit({
      type: "ownership.changed",
      actorId: executionTargetId,
      workspaceId: task.workspaceId,
      runId: String(task.payload.run_id),
      taskId,
      correlationId: String(task.payload.root_objective_id),
      summary: `${returnOwner.id} received final Team Run ownership of ${taskId}`
    });
    return normalizedTask;
  }

  private persistRunUsage(runId: string): void {
    for (let attempt = 0; attempt < OPTIMISTIC_RETRY_LIMIT; attempt += 1) {
      const run = this.store.getObject(runId);
      if (!run || run.kind !== "team_run") return;
      let aggregate: RuntimeUsage = { input_tokens: 0, output_tokens: 0, cost: 0, actions: 0 };
      for (const task of this.store.listObjects("task", run.workspaceId ?? undefined)) {
        if (task.payload.run_id !== runId || task.payload.status !== "completed") continue;
        aggregate = addUsage(aggregate, usage(task.payload.usage));
      }
      const payload = validateProtocolObject({ ...run.payload, usage: aggregate, updated_at: new Date().toISOString() }, "team_run");
      try {
        this.store.atomicMutation({
          preconditions: [{ id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt }],
          objects: [{ kind: "team_run", payload }],
          events: []
        });
        return;
      } catch (error) {
        const optimisticConflict = error instanceof Error && error.message.includes("changed since it was read");
        if (!optimisticConflict || attempt === OPTIMISTIC_RETRY_LIMIT - 1) throw error;
      }
    }
  }
}

/** Backward-compatible public name used throughout the package. */
export class BotRunner extends PrincipalRunner {}
