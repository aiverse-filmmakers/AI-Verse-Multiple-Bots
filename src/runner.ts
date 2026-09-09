import { assertUsageWithinBudget, BudgetError, type RuntimeUsage } from "./budget.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { PrincipalRunner as BasePrincipalRunner, type RunResult } from "./principal-runner.js";
import { RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult } from "./runtime.js";
import { CoordinationStore } from "./store.js";
import { TeamRunCoordinator } from "./team-runs.js";
import type { JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export type { RunResult, CancelResult } from "./principal-runner.js";

const EXECUTABLE_RUN_STATES = new Set(["running", "synthesizing", "verifying"]);
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);

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
        const participants = stringArray(run.payload.participant_ids);
        if (context.principalKind === "bot" && context.principal.id !== run.payload.leader_id && !participants.includes(context.principal.id)) {
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

/**
 * Public common execution runner.
 *
 * It preserves the mature Phase 1 execution engine while adding a runtime guard
 * for any Task carrying `run_id`. This means durable Bots and temporary Workers
 * are both subject to the TeamRun lifecycle, participant scope, root objective,
 * and aggregate budget before a runtime result can become an Artifact.
 */
export class PrincipalRunner extends BasePrincipalRunner {
  constructor(
    store: CoordinationStore,
    gateway: CoordinationGateway,
    queue: ExecutionQueue,
    runtimes: RuntimeRegistry,
    runnerId?: string,
    executionLeaseSeconds?: number,
    heartbeatIntervalMs?: number
  ) {
    super(store, gateway, queue, new TeamRunGuardedRuntimeRegistry(runtimes, store), runnerId, executionLeaseSeconds, heartbeatIntervalMs);
  }

  override async runNext(targetId: string): Promise<RunResult | null> {
    const result = await super.runNext(targetId);
    if (!result) return null;

    const persistedTask = this.store.getObject(result.task.id);
    const task = persistedTask?.kind === "task" ? persistedTask : result.task;
    const runId = typeof task.payload.run_id === "string" ? task.payload.run_id : null;
    if (!runId) return result;

    this.persistRunUsage(runId);

    const outcome = result.status === "completed" ? "completed" : result.status === "canceled" ? "canceled" : "failed";
    const settlement = this.gateway.settleHandoffForTask(task.id, outcome, targetId);
    const finalTask = settlement?.task ?? this.store.getObject(task.id) ?? result.task;

    if (result.status === "failed" && String(finalTask.payload.failure_code ?? "").startsWith("TEAM_RUN_")) {
      await this.exhaustRun(runId, String(finalTask.payload.failure_reason ?? "Team Run budget exhausted"), task.id);
    }
    return { ...result, task: finalTask };
  }

  private persistRunUsage(runId: string): void {
    for (let attempt = 0; attempt < 4; attempt += 1) {
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
        if (!(error instanceof Error) || !error.message.includes("changed since it was read") || attempt === 3) throw error;
      }
    }
  }

  private async exhaustRun(runId: string, reason: string, failedTaskId: string): Promise<void> {
    const teams = new TeamRunCoordinator(this.store);
    const run = teams.getRun(runId);
    if (!run || new Set(["completed", "failed", "canceled", "budget_exhausted"]).has(String(run.payload.status))) return;
    const leaderId = String(run.payload.leader_id ?? "");
    for (const sibling of this.store.listObjects("task", run.workspaceId ?? undefined)) {
      if (sibling.id === failedTaskId || sibling.payload.run_id !== runId || TERMINAL_TASK_STATES.has(String(sibling.payload.status))) continue;
      await this.cancelTask(sibling.id, leaderId, `Team Run ${runId} budget exhausted: ${reason}`);
    }
    const latest = teams.getRun(runId);
    if (latest && !new Set(["completed", "failed", "canceled", "budget_exhausted"]).has(String(latest.payload.status))) {
      teams.transitionRun(runId, "budget_exhausted", leaderId, reason);
    }
  }
}

/** Backward-compatible public name used throughout the package. */
export class BotRunner extends PrincipalRunner {}
