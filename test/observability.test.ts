import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import {
  OBSERVABILITY_PROVIDER,
  ObservabilityProjector
} from "../src/observability.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, workspaceId = "ws_observe"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: "Exercise observability projections." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"], can_create_workers: true },
    coordination: { default_mode: "direct" }
  };
}

function task(
  id: string,
  status: string,
  ownerId: string,
  workspaceId = "ws_observe",
  extra: Record<string, unknown> = {}
) {
  return {
    schema_version: "1.0",
    id,
    type: "task.delegate",
    created_by: "operator_observe",
    assignee_id: ownerId,
    owner_id: ownerId,
    workspace_id: workspaceId,
    root_objective_id: "objective_" + id,
    parent_task_id: null,
    reason: "Observability test",
    objective: "Objective " + id,
    required_constraints: [],
    expected_output: { contract: "artifact" },
    lease_id: "lease_" + id,
    environment_lease_id: null,
    deadline_at: null,
    budget: {},
    approval_id: null,
    hop: 0,
    max_hops: 6,
    status,
    ...extra
  };
}

function httpJson(
  port: number,
  method: string,
  path: string
): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: { "content-type": "application/json" }
    }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => resolvePromise({
        status: Number(res.statusCode ?? 0),
        body: JSON.parse(chunks.join("") || "{}")
      }));
    });
    req.on("error", rejectPromise);
    req.end();
  });
}

test("Phase 5.12 observability aggregates persisted Task usage and execution health without mutating truth", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue);
  try {
    gateway.createBot(bot("bot_alpha"));
    gateway.createBot(bot("bot_beta"));

    store.putObject("task", task("task_done_a", "completed", "bot_alpha", "ws_observe", {
      completed_at: new Date().toISOString(),
      usage: { input_tokens: 100, output_tokens: 40, cost: 0.15, actions: 2 }
    }));
    store.putObject("task", task("task_done_b", "completed", "bot_beta", "ws_observe", {
      completed_at: new Date().toISOString(),
      usage: { input_tokens: 50, output_tokens: 10, cost: 0.05, actions: 1 }
    }));
    store.putObject("task", task("task_failed", "failed", "bot_beta", "ws_observe", {
      failed_at: new Date().toISOString(),
      failure_reason: "Provider unavailable"
    }));
    store.putObject("task", task("task_blocked", "blocked", "bot_alpha"));

    const execution = queue.enqueueTask(
      "task_blocked",
      "bot_alpha",
      "ws_observe",
      { recoveryPolicy: "retry_safe", maxAttempts: 3 }
    );
    queue.updateState(execution.id, "dead_letter", "Temporary network failure");

    gateway.emit({
      type: "task.completed",
      actorId: "bot_alpha",
      workspaceId: "ws_observe",
      taskId: "task_done_a",
      summary: "Result ready",
      attentionState: "unread_result"
    });

    const cursorBefore = store.latestEventSequence();
    const projection = new ObservabilityProjector(store, queue).snapshot("ws_observe", 0, 100);
    const cursorAfter = store.latestEventSequence();

    assert.equal(projection.provider, OBSERVABILITY_PROVIDER);
    assert.equal(projection.projection_only, true);
    assert.equal(projection.observability_owns_truth, false);
    assert.equal(projection.private_reasoning_exposed, false);
    assert.equal(cursorAfter, cursorBefore);

    assert.deepEqual(projection.usage.totals, {
      input_tokens: 150,
      output_tokens: 50,
      total_tokens: 200,
      runtime_reported_cost_evidence: 0.2,
      actions: 3
    });
    assert.equal(projection.canonical_telemetry_owner, "ai-verse-token");
    assert.equal(projection.canonical_cost_truth_owner, "ai-verse-token");
    assert.equal(projection.token_projection_interface, "@ai-verse/token/gateway");
    assert.equal(projection.runtime_usage_is_canonical_token_truth, false);
    assert.equal(projection.prices_model_usage_here, false);
    assert.equal(projection.usage.authority.semantic, "execution-local operational evidence");
    assert.equal(projection.usage.authority.writes_token_telemetry_here, false);
    assert.equal(Object.prototype.hasOwnProperty.call(projection.usage.totals, "cost"), false);
    assert.equal(projection.usage.coverage.tasks_with_persisted_usage, 2);
    assert.equal(projection.summary.failed_tasks, 1);
    assert.equal(projection.execution.dead_letters, 1);
    assert.equal(projection.execution.retryable_dead_letters, 1);
    assert.equal(projection.outcomes.task_status_counts.completed, 2);
    assert.equal(projection.outcomes.task_status_counts.failed, 1);
    assert.equal(projection.timeline.attention_counts.unread_result, 1);

    const alpha = projection.usage.by_principal.find((item: any) => item.id === "bot_alpha");
    assert.ok(alpha);
    assert.equal(alpha.runtime_adapter, "deterministic");
    assert.equal(alpha.usage.total_tokens, 140);
    assert.equal(alpha.tasks, 2);
  } finally {
    queue.close();
    store.close();
  }
});

test("Phase 5.12 Team Run usage shows canonical/computed consistency and budget utilization", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue);
  try {
    gateway.createBot(bot("bot_leader"));
    const run = store.putObject("team_run", {
      schema_version: "1.0",
      id: "run_observe",
      type: "team_run",
      workspace_id: "ws_observe",
      root_objective_id: "objective_run_observe",
      objective: "Observe one Team Run",
      leader_id: "bot_leader",
      participant_ids: ["bot_leader"],
      topology: "dynamic_squad",
      status: "completed",
      budget: { token_limit: 1000, cost_limit: 2, max_actions: 10 },
      usage: { input_tokens: 300, output_tokens: 100, cost: 0.5, actions: 4 },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    store.putObject("task", task("task_run_a", "completed", "bot_leader", "ws_observe", {
      run_id: run.id,
      root_objective_id: "objective_run_observe",
      completed_at: new Date().toISOString(),
      usage: { input_tokens: 200, output_tokens: 50, cost: 0.3, actions: 2 }
    }));
    store.putObject("task", task("task_run_b", "completed", "bot_leader", "ws_observe", {
      run_id: run.id,
      root_objective_id: "objective_run_observe",
      completed_at: new Date().toISOString(),
      usage: { input_tokens: 100, output_tokens: 50, cost: 0.2, actions: 2 }
    }));

    const projection = new ObservabilityProjector(store, queue).snapshot("ws_observe");
    const runView = projection.usage.by_team_run.find((item: any) => item.id === "run_observe");
    assert.ok(runView);
    assert.equal(runView.usage_consistent, true);
    assert.equal(runView.usage.total_tokens, 400);
    assert.equal(runView.utilization_percent.tokens, 40);
    assert.equal(runView.utilization_percent.runtime_reported_cost_evidence, 25);
    assert.equal(runView.utilization_percent.actions, 40);
  } finally {
    queue.close();
    store.close();
  }
});

test("Phase 5.12 timeline is workspace-scoped, cursor-based, compact, and exposes no hidden reasoning", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue);
  try {
    const first = gateway.emit({
      type: "task.started",
      actorId: "bot_alpha",
      workspaceId: "ws_observe",
      taskId: "task_a",
      summary: "Started visible work"
    });
    gateway.emit({
      type: "private.test",
      actorId: "bot_other",
      workspaceId: "ws_other",
      summary: "Other workspace"
    });
    const second = gateway.emit({
      type: "artifact.published",
      actorId: "bot_alpha",
      workspaceId: "ws_observe",
      taskId: "task_a",
      summary: "Published result",
      attentionState: "unread_result"
    });

    const projector = new ObservabilityProjector(store, queue);
    const timeline = projector.timeline("ws_observe", first.sequence, 100);

    assert.equal(timeline.events.length, 1);
    const visibleEvent = timeline.events[0];
    assert.ok(visibleEvent);
    assert.equal(visibleEvent.sequence, second.sequence);
    assert.equal(visibleEvent.summary, "Published result");
    assert.equal(JSON.stringify(timeline).includes("Other workspace"), false);
    assert.equal(timeline.private_reasoning_exposed, false);
    assert.equal(timeline.event_cursor, second.sequence);
  } finally {
    queue.close();
    store.close();
  }
});

test("Phase 5.12 HTTP views expose capabilities, usage and bounded timeline", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    service.gateway.createBot(bot("bot_http"));
    service.store.putObject("task", task("task_http", "completed", "bot_http", "ws_observe", {
      completed_at: new Date().toISOString(),
      usage: { input_tokens: 12, output_tokens: 8, cost: 0.01, actions: 1 }
    }));
    service.gateway.emit({
      type: "task.completed",
      actorId: "bot_http",
      workspaceId: "ws_observe",
      taskId: "task_http",
      summary: "HTTP result",
      attentionState: "unread_result"
    });

    const capabilities = await httpJson(
      address.port,
      "GET",
      "/v1/observability/capabilities?workspace=ws_observe"
    );
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.provider, OBSERVABILITY_PROVIDER);
    assert.equal(capabilities.body.observability_owns_truth, false);
    assert.equal(capabilities.body.canonical_telemetry_owner, "ai-verse-token");
    assert.equal(capabilities.body.canonical_cost_truth_owner, "ai-verse-token");
    assert.equal(capabilities.body.token_projection_interface, "@ai-verse/token/gateway");
    assert.equal(capabilities.body.runtime_usage_is_canonical_token_truth, false);
    assert.equal(capabilities.body.prices_model_usage_here, false);
    assert.equal(capabilities.body.private_reasoning_exposed, false);

    const usage = await httpJson(
      address.port,
      "GET",
      "/v1/observability/usage?workspace=ws_observe"
    );
    assert.equal(usage.status, 200);
    assert.equal(usage.body.usage.totals.total_tokens, 20);
    assert.equal(usage.body.usage.totals.runtime_reported_cost_evidence, 0.01);
    assert.equal(usage.body.canonical_telemetry_owner, "ai-verse-token");
    assert.equal(usage.body.canonical_cost_truth_owner, "ai-verse-token");
    assert.equal(usage.body.token_projection_interface, "@ai-verse/token/gateway");
    assert.equal(usage.body.runtime_usage_is_canonical_token_truth, false);
    assert.equal(usage.body.prices_model_usage_here, false);
    assert.equal(Object.prototype.hasOwnProperty.call(usage.body.usage.totals, "cost"), false);

    const timeline = await httpJson(
      address.port,
      "GET",
      "/v1/observability/timeline?workspace=ws_observe&after=0&limit=10"
    );
    assert.equal(timeline.status, 200);
    assert.equal(timeline.body.events.some((event: any) => event.summary === "HTTP result"), true);

    const invalid = await httpJson(
      address.port,
      "GET",
      "/v1/observability/snapshot?workspace=ws_observe&after=-1"
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "INVALID_OBSERVABILITY_CURSOR");
  } finally {
    await service.close();
  }
});


test("Phase 5.12 never claims Token pricing or ACTUAL/CALCULATED/UNKNOWN cost authority", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  try {
    store.putObject("task", task("task_token_boundary", "completed", "bot_missing", "ws_observe", {
      completed_at: new Date().toISOString(),
      usage: { input_tokens: 9, output_tokens: 4, cost: 0.33, actions: 2 }
    }));
    const projection = new ObservabilityProjector(store, queue).snapshot("ws_observe");
    const serialized = JSON.stringify(projection);

    assert.equal(projection.canonical_telemetry_owner, "ai-verse-token");
    assert.equal(projection.canonical_cost_truth_owner, "ai-verse-token");
    assert.equal(projection.token_projection_interface, "@ai-verse/token/gateway");
    assert.equal(projection.runtime_usage_is_canonical_token_truth, false);
    assert.equal(projection.prices_model_usage_here, false);
    assert.equal(projection.usage.authority.runtime_usage_is_canonical_token_truth, false);
    assert.equal(projection.usage.authority.prices_model_usage_here, false);
    assert.equal(projection.usage.authority.writes_token_telemetry_here, false);
    assert.equal(projection.usage.totals.runtime_reported_cost_evidence, 0.33);
    assert.equal(Object.prototype.hasOwnProperty.call(projection.usage.totals, "cost"), false);
    assert.equal(serialized.includes('"pricing_snapshot"'), false);
    assert.equal(serialized.includes('"tariff"'), false);
    assert.equal(serialized.includes('"actual_cost"'), false);
    assert.equal(serialized.includes('"calculated_cost"'), false);
  } finally {
    queue.close();
    store.close();
  }
});
