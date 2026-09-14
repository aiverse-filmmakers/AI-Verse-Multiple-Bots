import type { BudgetEnvelope, RuntimeUsage } from "./budget.js";
import type { ExecutionQueue, ExecutionRecord, ExecutionState } from "./execution-queue.js";
import type { CoordinationStore } from "./store.js";
import type { AppendedEvent, JsonObject, StoredObject } from "./types.js";

export const OBSERVABILITY_SCHEMA = "1.0";
export const OBSERVABILITY_PROVIDER = "ai-verse-multiple-bots/observability-v1";
export const CANONICAL_TELEMETRY_OWNER = "ai-verse-token";
export const CANONICAL_TOKEN_PROJECTION = "@ai-verse/token/gateway";

type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  runtime_reported_cost_evidence: number;
  actions: number;
};

export interface PrincipalUsageView {
  id: string;
  runtime_adapter: string | null;
  tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  active_tasks: number;
  usage: UsageTotals;
}

export interface TeamRunUsageView {
  id: string;
  status: string;
  leader_id: string | null;
  topology: string | null;
  tasks: number;
  workers: number;
  usage: UsageTotals;
  canonical_usage: UsageTotals;
  usage_consistent: boolean;
  budget: {
    token_limit: number | null;
    cost_limit: number | null;
    max_actions: number | null;
  };
  utilization_percent: {
    tokens: number | null;
    runtime_reported_cost_evidence: number | null;
    actions: number | null;
  };
  updated_at: string;
}

export interface ObservabilityUsageView {
  totals: UsageTotals;
  authority: {
    semantic: "execution-local operational evidence";
    canonical_telemetry_owner: typeof CANONICAL_TELEMETRY_OWNER;
    canonical_cost_truth_owner: typeof CANONICAL_TELEMETRY_OWNER;
    canonical_cost_truth_states: string[];
    token_projection_interface: typeof CANONICAL_TOKEN_PROJECTION;
    prices_model_usage_here: false;
    writes_token_telemetry_here: false;
    runtime_usage_is_canonical_token_truth: false;
    purpose: string;
  };
  coverage: {
    total_tasks: number;
    completed_tasks: number;
    tasks_with_persisted_usage: number;
    note: string;
  };
  by_principal: PrincipalUsageView[];
  by_team_run: TeamRunUsageView[];
}

export interface ObservabilityTimelineView {
  counts_by_type: Record<string, number>;
  attention_counts: Record<string, number>;
  events: JsonObject[];
}

export interface ObservabilitySnapshot {
  schema_version: typeof OBSERVABILITY_SCHEMA;
  provider: typeof OBSERVABILITY_PROVIDER;
  projection_only: true;
  canonical_owner: "ai-verse-multiple-bots";
  observability_owns_truth: false;
  canonical_telemetry_owner: typeof CANONICAL_TELEMETRY_OWNER;
  canonical_cost_truth_owner: typeof CANONICAL_TELEMETRY_OWNER;
  token_projection_interface: typeof CANONICAL_TOKEN_PROJECTION;
  runtime_usage_is_canonical_token_truth: false;
  prices_model_usage_here: false;
  workspace_id: string;
  observed_at: string;
  event_cursor: number;
  window: {
    after_event_sequence: number;
    event_limit: number;
    events_returned: number;
  };
  summary: {
    bots: number;
    team_runs: number;
    workers: number;
    tasks: number;
    active_tasks: number;
    completed_tasks: number;
    failed_tasks: number;
    dead_letters: number;
    stale_executions: number;
  };
  outcomes: {
    task_status_counts: Record<string, number>;
    terminal_tasks: number;
    success_rate_percent: number | null;
  };
  execution: {
    state_counts: Record<string, number>;
    dead_letters: number;
    retryable_dead_letters: number;
    stale_executions: number;
  };
  usage: ObservabilityUsageView;
  latency: {
    terminal_task_samples: number;
    average_ms: number | null;
    min_ms: number | null;
    max_ms: number | null;
  };
  errors: ObservabilityErrorCounts;
  timeline: ObservabilityTimelineView;
  private_reasoning_exposed: false;
}

export interface ObservabilityUsageResponse {
  schema_version: typeof OBSERVABILITY_SCHEMA;
  provider: typeof OBSERVABILITY_PROVIDER;
  projection_only: true;
  canonical_owner: "ai-verse-multiple-bots";
  observability_owns_truth: false;
  canonical_telemetry_owner: typeof CANONICAL_TELEMETRY_OWNER;
  canonical_cost_truth_owner: typeof CANONICAL_TELEMETRY_OWNER;
  token_projection_interface: typeof CANONICAL_TOKEN_PROJECTION;
  runtime_usage_is_canonical_token_truth: false;
  prices_model_usage_here: false;
  workspace_id: string;
  observed_at: string;
  event_cursor: number;
  usage: ObservabilityUsageView;
  latency: ObservabilitySnapshot["latency"];
  outcomes: ObservabilitySnapshot["outcomes"];
  execution: ObservabilitySnapshot["execution"];
  private_reasoning_exposed: false;
}

export interface ObservabilityTimelineResponse {
  schema_version: typeof OBSERVABILITY_SCHEMA;
  provider: typeof OBSERVABILITY_PROVIDER;
  projection_only: true;
  canonical_owner: "ai-verse-multiple-bots";
  observability_owns_truth: false;
  canonical_telemetry_owner: typeof CANONICAL_TELEMETRY_OWNER;
  canonical_cost_truth_owner: typeof CANONICAL_TELEMETRY_OWNER;
  token_projection_interface: typeof CANONICAL_TOKEN_PROJECTION;
  runtime_usage_is_canonical_token_truth: false;
  prices_model_usage_here: false;
  workspace_id: string;
  observed_at: string;
  requested_after: number;
  event_cursor: number;
  limit: number;
  counts_by_type: Record<string, number>;
  attention_counts: Record<string, number>;
  events: JsonObject[];
  private_reasoning_exposed: false;
}

export interface ObservabilityErrorCounts extends JsonObject {
  failed_tasks: number;
  dead_letters: number;
  stale_executions: number;
  attention_events: number;
}

export class ObservabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "ObservabilityError";
  }
}

function requiredScope(value: string): string {
  const workspaceId = value.trim();
  if (!workspaceId || workspaceId.length > 256 || /[\0\r\n]/.test(workspaceId)) {
    throw new ObservabilityError(
      "INVALID_OBSERVABILITY_WORKSPACE",
      "Observability requires a non-empty workspace id of at most 256 characters"
    );
  }
  return workspaceId;
}

function boundedCursor(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ObservabilityError(
      "INVALID_OBSERVABILITY_CURSOR",
      "Observability cursor must be a non-negative integer"
    );
  }
  return value;
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new ObservabilityError(
      "INVALID_OBSERVABILITY_LIMIT",
      "Observability event limit must be an integer from 1 to 500"
    );
  }
  return value;
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNonNegative(value: unknown, label: string): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    throw new ObservabilityError(
      "INVALID_CANONICAL_USAGE",
      `${label} must be a non-negative finite number`,
      500
    );
  }
  return number;
}

function readUsage(value: unknown, label = "usage"): UsageTotals {
  const source = asObject(value);
  const input = finiteNonNegative(source.input_tokens, `${label}.input_tokens`);
  const output = finiteNonNegative(source.output_tokens, `${label}.output_tokens`);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    runtime_reported_cost_evidence: finiteNonNegative(source.cost, `${label}.cost`),
    actions: finiteNonNegative(source.actions, `${label}.actions`)
  };
}

function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    runtime_reported_cost_evidence: left.runtime_reported_cost_evidence + right.runtime_reported_cost_evidence,
    actions: left.actions + right.actions
  };
}

function emptyUsage(): UsageTotals {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, runtime_reported_cost_evidence: 0, actions: 0 };
}

function terminalTask(status: string): boolean {
  return ["completed", "failed", "canceled", "timeout", "budget_exhausted", "rejected_policy"].includes(status);
}

function activeTask(status: string): boolean {
  return ["created", "assigned", "accepted", "running", "waiting_input", "waiting_approval", "blocked"].includes(status);
}

function terminalTimestamp(task: StoredObject): string | null {
  const status = String(task.payload.status ?? "");
  const candidates = status === "completed"
    ? [task.payload.completed_at]
    : status === "failed"
      ? [task.payload.failed_at]
      : status === "canceled"
        ? [task.payload.canceled_at]
        : [task.payload.updated_at];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && Number.isFinite(Date.parse(candidate))) return candidate;
  }
  return Number.isFinite(Date.parse(task.updatedAt)) ? task.updatedAt : null;
}

function durationMs(task: StoredObject): number | null {
  if (!terminalTask(String(task.payload.status ?? ""))) return null;
  const ended = terminalTimestamp(task);
  if (!ended) return null;
  const start = Date.parse(task.createdAt);
  const end = Date.parse(ended);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function rounded(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function utilization(used: number, limit: unknown): number | null {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  return rounded((used / limit) * 100, 2);
}

function eventProjection(event: AppendedEvent): JsonObject {
  return {
    sequence: event.sequence,
    timestamp: optionalString(event.event.timestamp),
    type: String(event.event.type ?? "unknown"),
    actor_id: optionalString(event.event.actor_id),
    task_id: optionalString(event.event.task_id),
    run_id: optionalString(event.event.run_id),
    room_id: optionalString(event.event.room_id),
    thread_id: optionalString(event.event.thread_id),
    attention_state: optionalString(event.event.attention_state),
    summary: optionalString(event.event.summary)
  };
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function executionState(record: ExecutionRecord | null): ExecutionState | "not_queued" {
  return record?.state ?? "not_queued";
}

export class ObservabilityProjector {
  constructor(
    readonly store: CoordinationStore,
    readonly executionQueue: ExecutionQueue
  ) {}

  capabilities(workspaceInput: string): JsonObject {
    const workspaceId = requiredScope(workspaceInput);
    return {
      schema_version: OBSERVABILITY_SCHEMA,
      provider: OBSERVABILITY_PROVIDER,
      projection_only: true,
      canonical_owner: "ai-verse-multiple-bots",
      observability_owns_truth: false,
      canonical_telemetry_owner: CANONICAL_TELEMETRY_OWNER,
      canonical_cost_truth_owner: CANONICAL_TELEMETRY_OWNER,
      token_projection_interface: CANONICAL_TOKEN_PROJECTION,
      runtime_usage_is_canonical_token_truth: false,
      prices_model_usage_here: false,
      workspace_id: workspaceId,
      queries: [
        "observability.snapshot",
        "observability.usage",
        "observability.timeline"
      ],
      usage_dimensions: [
        "workspace",
        "principal",
        "team_run"
      ],
      usage_units: [
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "runtime_reported_cost_evidence",
        "actions"
      ],
      usage_semantics: "execution-local operational evidence",
      canonical_telemetry_owner: CANONICAL_TELEMETRY_OWNER,
      canonical_cost_truth_owner: CANONICAL_TELEMETRY_OWNER,
      canonical_cost_truth_states: ["ACTUAL", "CALCULATED", "UNKNOWN"],
      token_projection_interface: CANONICAL_TOKEN_PROJECTION,
      prices_model_usage_here: false,
      writes_token_telemetry_here: false,
      runtime_usage_is_canonical_token_truth: false,
      timeline_source: "canonical-coordination-events",
      private_reasoning_exposed: false
    };
  }

  snapshot(workspaceInput: string, afterInput = 0, limitInput = 100): ObservabilitySnapshot {
    const workspaceId = requiredScope(workspaceInput);
    const after = boundedCursor(afterInput);
    const limit = boundedLimit(limitInput);
    const tasks = this.store.listObjects("task", workspaceId);
    const bots = this.store.listObjects("bot", workspaceId);
    const runs = this.store.listObjects("team_run", workspaceId);
    const workers = this.store.listObjects("worker", workspaceId);
    const events = this.store.listWorkspaceEventsAfter(workspaceId, after, limit);
    const stale = this.executionQueue.listStale().filter((item) => item.workspaceId === workspaceId);
    const deadLetters = this.executionQueue.listDeadLetters(workspaceId);
    const executionByTask = new Map(tasks.map((task) => [task.id, this.executionQueue.getByItem(task.id)]));

    const taskStatusCounts: Record<string, number> = {};
    const executionStateCounts: Record<string, number> = {};
    let workspaceUsage = emptyUsage();
    let tasksWithUsage = 0;
    let completedTasks = 0;
    let terminalDurationTotal = 0;
    let terminalDurationMin: number | null = null;
    let terminalDurationMax: number | null = null;
    let terminalDurationSamples = 0;

    const principalUsage = new Map<string, {
      id: string;
      runtime_adapter: string | null;
      tasks: number;
      completed_tasks: number;
      failed_tasks: number;
      active_tasks: number;
      usage: UsageTotals;
    }>();

    for (const task of tasks) {
      const status = String(task.payload.status ?? "unknown");
      increment(taskStatusCounts, status);
      increment(executionStateCounts, executionState(executionByTask.get(task.id) ?? null));
      if (status === "completed") completedTasks += 1;

      const usagePresent = typeof task.payload.usage === "object" && task.payload.usage !== null && !Array.isArray(task.payload.usage);
      const taskUsage = usagePresent ? readUsage(task.payload.usage, `task:${task.id}:usage`) : emptyUsage();
      if (usagePresent) {
        tasksWithUsage += 1;
        workspaceUsage = addUsage(workspaceUsage, taskUsage);
      }

      const principalId = optionalString(task.payload.assignee_id ?? task.payload.owner_id);
      if (principalId) {
        const principal = this.store.getObject(principalId);
        const runtimeAdapter = principal && (principal.kind === "bot" || principal.kind === "worker")
          ? optionalString(asObject(principal.payload.runtime).adapter)
          : null;
        const current = principalUsage.get(principalId) ?? {
          id: principalId,
          runtime_adapter: runtimeAdapter,
          tasks: 0,
          completed_tasks: 0,
          failed_tasks: 0,
          active_tasks: 0,
          usage: emptyUsage()
        };
        current.tasks += 1;
        if (status === "completed") current.completed_tasks += 1;
        if (["failed", "timeout", "budget_exhausted", "rejected_policy"].includes(status)) current.failed_tasks += 1;
        if (activeTask(status)) current.active_tasks += 1;
        current.usage = addUsage(current.usage, taskUsage);
        principalUsage.set(principalId, current);
      }

      const duration = durationMs(task);
      if (duration !== null) {
        terminalDurationSamples += 1;
        terminalDurationTotal += duration;
        terminalDurationMin = terminalDurationMin === null ? duration : Math.min(terminalDurationMin, duration);
        terminalDurationMax = terminalDurationMax === null ? duration : Math.max(terminalDurationMax, duration);
      }
    }

    const runViews: TeamRunUsageView[] = runs.map((run) => {
      const runTasks = tasks.filter((task) => task.payload.run_id === run.id);
      let computedUsage = emptyUsage();
      for (const task of runTasks) {
        if (typeof task.payload.usage !== "object" || task.payload.usage === null || Array.isArray(task.payload.usage)) continue;
        computedUsage = addUsage(computedUsage, readUsage(task.payload.usage, `task:${task.id}:usage`));
      }
      const canonicalUsage = readUsage(run.payload.usage, `team_run:${run.id}:usage`);
      const budget = asObject(run.payload.budget) as BudgetEnvelope;
      const runWorkers = workers.filter((worker) => worker.payload.run_id === run.id);
      return {
        id: run.id,
        status: String(run.payload.status ?? "unknown"),
        leader_id: optionalString(run.payload.leader_id),
        topology: optionalString(run.payload.topology),
        tasks: runTasks.length,
        workers: runWorkers.length,
        usage: computedUsage,
        canonical_usage: canonicalUsage,
        usage_consistent:
          computedUsage.input_tokens === canonicalUsage.input_tokens
          && computedUsage.output_tokens === canonicalUsage.output_tokens
          && computedUsage.runtime_reported_cost_evidence === canonicalUsage.runtime_reported_cost_evidence
          && computedUsage.actions === canonicalUsage.actions,
        budget: {
          token_limit: typeof budget.token_limit === "number" ? budget.token_limit : null,
          cost_limit: typeof budget.cost_limit === "number" ? budget.cost_limit : null,
          max_actions: typeof budget.max_actions === "number" ? budget.max_actions : null
        },
        utilization_percent: {
          tokens: utilization(computedUsage.total_tokens, budget.token_limit),
          runtime_reported_cost_evidence: utilization(computedUsage.runtime_reported_cost_evidence, budget.cost_limit),
          actions: utilization(computedUsage.actions, budget.max_actions)
        },
        updated_at: run.updatedAt
      };
    }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(a.id).localeCompare(String(b.id)));

    const eventTypeCounts: Record<string, number> = {};
    const attentionCounts: Record<string, number> = {};
    for (const event of events) {
      increment(eventTypeCounts, String(event.event.type ?? "unknown"));
      const attention = optionalString(event.event.attention_state);
      if (attention) increment(attentionCounts, attention);
    }

    const failedTasks = tasks.filter((task) =>
      ["failed", "timeout", "budget_exhausted", "rejected_policy"].includes(String(task.payload.status ?? ""))
    ).length;
    const errors: ObservabilityErrorCounts = {
      failed_tasks: failedTasks,
      dead_letters: deadLetters.length,
      stale_executions: stale.length,
      attention_events: events.filter((event) => optionalString(event.event.attention_state) !== null).length
    };

    const principals: PrincipalUsageView[] = [...principalUsage.values()]
      .map((item) => ({
        ...item,
        usage: {
          ...item.usage,
          runtime_reported_cost_evidence: rounded(item.usage.runtime_reported_cost_evidence, 6)
        }
      }))
      .sort((a, b) =>
        b.usage.cost - a.usage.cost
        || b.usage.total_tokens - a.usage.total_tokens
        || a.id.localeCompare(b.id)
      );

    return {
      schema_version: OBSERVABILITY_SCHEMA,
      provider: OBSERVABILITY_PROVIDER,
      projection_only: true,
      canonical_owner: "ai-verse-multiple-bots",
      observability_owns_truth: false,
      canonical_telemetry_owner: CANONICAL_TELEMETRY_OWNER,
      canonical_cost_truth_owner: CANONICAL_TELEMETRY_OWNER,
      token_projection_interface: CANONICAL_TOKEN_PROJECTION,
      runtime_usage_is_canonical_token_truth: false,
      prices_model_usage_here: false,
      workspace_id: workspaceId,
      observed_at: new Date().toISOString(),
      event_cursor: this.store.latestEventSequence(),
      window: {
        after_event_sequence: after,
        event_limit: limit,
        events_returned: events.length
      },
      summary: {
        bots: bots.length,
        team_runs: runs.length,
        workers: workers.length,
        tasks: tasks.length,
        active_tasks: tasks.filter((task) => activeTask(String(task.payload.status ?? ""))).length,
        completed_tasks: completedTasks,
        failed_tasks: failedTasks,
        dead_letters: deadLetters.length,
        stale_executions: stale.length
      },
      outcomes: {
        task_status_counts: taskStatusCounts,
        terminal_tasks: tasks.filter((task) => terminalTask(String(task.payload.status ?? ""))).length,
        success_rate_percent: terminalTaskRate(tasks)
      },
      execution: {
        state_counts: executionStateCounts,
        dead_letters: deadLetters.length,
        retryable_dead_letters: deadLetters.filter((item) =>
          item.recoveryPolicy === "retry_safe" && item.attempts < item.maxAttempts
        ).length,
        stale_executions: stale.length
      },
      usage: {
        totals: {
          ...workspaceUsage,
          runtime_reported_cost_evidence: rounded(workspaceUsage.runtime_reported_cost_evidence, 6)
        },
        authority: {
          semantic: "execution-local operational evidence",
          canonical_telemetry_owner: CANONICAL_TELEMETRY_OWNER,
          canonical_cost_truth_owner: CANONICAL_TELEMETRY_OWNER,
          canonical_cost_truth_states: ["ACTUAL", "CALCULATED", "UNKNOWN"],
          token_projection_interface: CANONICAL_TOKEN_PROJECTION,
          prices_model_usage_here: false,
          writes_token_telemetry_here: false,
          runtime_usage_is_canonical_token_truth: false,
          purpose: "coordination budgets, runtime settlement, limits and operational observability"
        },
        coverage: {
          total_tasks: tasks.length,
          completed_tasks: completedTasks,
          tasks_with_persisted_usage: tasksWithUsage,
          note: "These are execution-local runtime usage receipts persisted on Multiple Bots Tasks. They support coordination budgets and operational observability only. Canonical historical/global telemetry and ACTUAL/CALCULATED/UNKNOWN monetary truth belong to AI-Verse Token."
        },
        by_principal: principals,
        by_team_run: runViews
      },
      latency: {
        terminal_task_samples: terminalDurationSamples,
        average_ms: terminalDurationSamples > 0 ? Math.round(terminalDurationTotal / terminalDurationSamples) : null,
        min_ms: terminalDurationMin,
        max_ms: terminalDurationMax
      },
      errors,
      timeline: {
        counts_by_type: eventTypeCounts,
        attention_counts: attentionCounts,
        events: events.map(eventProjection)
      },
      private_reasoning_exposed: false
    };
  }

  usage(workspaceInput: string): ObservabilityUsageResponse {
    const snapshot = this.snapshot(workspaceInput, this.store.latestEventSequence(), 1);
    return {
      schema_version: OBSERVABILITY_SCHEMA,
      provider: OBSERVABILITY_PROVIDER,
      projection_only: true,
      canonical_owner: "ai-verse-multiple-bots",
      observability_owns_truth: false,
      workspace_id: snapshot.workspace_id,
      observed_at: snapshot.observed_at,
      event_cursor: snapshot.event_cursor,
      usage: snapshot.usage,
      latency: snapshot.latency,
      outcomes: snapshot.outcomes,
      execution: snapshot.execution,
      private_reasoning_exposed: false
    };
  }

  timeline(workspaceInput: string, afterInput = 0, limitInput = 100): ObservabilityTimelineResponse {
    const workspaceId = requiredScope(workspaceInput);
    const after = boundedCursor(afterInput);
    const limit = boundedLimit(limitInput);
    const events = this.store.listWorkspaceEventsAfter(workspaceId, after, limit);
    const countsByType: Record<string, number> = {};
    const attentionCounts: Record<string, number> = {};
    for (const event of events) {
      increment(countsByType, String(event.event.type ?? "unknown"));
      const attention = optionalString(event.event.attention_state);
      if (attention) increment(attentionCounts, attention);
    }
    return {
      schema_version: OBSERVABILITY_SCHEMA,
      provider: OBSERVABILITY_PROVIDER,
      projection_only: true,
      canonical_owner: "ai-verse-multiple-bots",
      observability_owns_truth: false,
      canonical_telemetry_owner: CANONICAL_TELEMETRY_OWNER,
      canonical_cost_truth_owner: CANONICAL_TELEMETRY_OWNER,
      token_projection_interface: CANONICAL_TOKEN_PROJECTION,
      runtime_usage_is_canonical_token_truth: false,
      prices_model_usage_here: false,
      workspace_id: workspaceId,
      observed_at: new Date().toISOString(),
      requested_after: after,
      event_cursor: this.store.latestEventSequence(),
      limit,
      counts_by_type: countsByType,
      attention_counts: attentionCounts,
      events: events.map(eventProjection),
      private_reasoning_exposed: false
    };
  }
}

function terminalTaskRate(tasks: StoredObject[]): number | null {
  const terminal = tasks.filter((task) => terminalTask(String(task.payload.status ?? "")));
  if (terminal.length === 0) return null;
  const completed = terminal.filter((task) => String(task.payload.status ?? "") === "completed").length;
  return rounded((completed / terminal.length) * 100, 2);
}
