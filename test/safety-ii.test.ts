import assert from "node:assert/strict";
import test from "node:test";
import { BudgetError } from "../src/budget.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationLoopError } from "../src/loop-guard.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { RuntimeRegistry, type RuntimeAdapter } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, adapter = "deterministic"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Mission for ${id}` },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_safety" },
    permissions: { policy_ref: "strict", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

function strictGateway(store: CoordinationStore, queue?: ExecutionQueue): CoordinationGateway {
  return new CoordinationGateway(store, queue, new CoordinationPolicy(store, { requireRegisteredBots: true }));
}

test("child Tasks inherit tighter parent budgets and root task-count limits", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = strictGateway(store);
  try {
    for (const id of ["bot_a", "bot_b", "bot_c"]) gateway.createBot(bot(id));
    const root = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_budget",
      objective: "Own the initial research",
      reason: "budget root",
      budget: { token_limit: 1000, cost_limit: 1, max_hops: 4, max_tasks: 2, max_actions: 5 }
    });
    const child = gateway.delegate({
      createdBy: "bot_b",
      assigneeId: "bot_c",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_budget",
      parentTaskId: root.task.id,
      objective: "Check one specialist angle",
      reason: "bounded child",
      budget: { token_limit: 9000, cost_limit: 9, max_hops: 9, max_tasks: 9, max_actions: 9 }
    });

    const inherited = child.task.payload.budget as Record<string, number>;
    assert.equal(inherited.token_limit, 1000);
    assert.equal(inherited.cost_limit, 1);
    assert.equal(inherited.max_hops, 4);
    assert.equal(inherited.max_tasks, 2);
    assert.equal(inherited.max_actions, 5);
    assert.equal(child.task.payload.max_hops, 4);

    assert.throws(() => gateway.delegate({
      createdBy: "bot_c",
      assigneeId: "bot_a",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_budget",
      parentTaskId: child.task.id,
      objective: "Create a third task",
      reason: "must exceed root task budget"
    }), (error: unknown) => error instanceof BudgetError && error.code === "TASK_BUDGET_EXCEEDED");
  } finally {
    store.close();
  }
});

test("delegation lineage blocks Bot ping-pong before the third transition", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = strictGateway(store);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    const first = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_loop",
      objective: "Research the issue",
      reason: "first pass"
    });
    const second = gateway.delegate({
      createdBy: "bot_b",
      assigneeId: "bot_a",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_loop",
      parentTaskId: first.task.id,
      objective: "Review the findings",
      reason: "review pass"
    });

    assert.throws(() => gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_loop",
      parentTaskId: second.task.id,
      objective: "Revise the findings again",
      reason: "would ping-pong"
    }), (error: unknown) => error instanceof CoordinationLoopError && error.code === "PING_PONG_DETECTED");
  } finally {
    store.close();
  }
});

test("runtime usage over budget fails before a successful Artifact is accepted", async () => {
  const highUsage: RuntimeAdapter = {
    id: "high-usage",
    async execute() {
      return {
        summary: "expensive result",
        artifactKind: "test",
        output: { result: "expensive" },
        usage: { input_tokens: 20, output_tokens: 20, cost: 2, actions: 4 }
      };
    }
  };
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = strictGateway(store, queue);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b", "high-usage"));
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_usage",
      objective: "Do bounded work",
      reason: "budget test",
      budget: { token_limit: 10, cost_limit: 0.5, max_actions: 2 }
    });
    const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(highUsage));
    const result = await runner.runNext("bot_b");
    if (!result) throw new Error("expected execution result");
    assert.equal(result.status, "failed");
    assert.equal(result.task.payload.failure_code, "TOKEN_BUDGET_EXCEEDED");
    assert.equal(store.listObjects("artifact").length, 0);
    assert.equal(queue.getByItem(delegated.task.id)?.state, "failed");
    assert.ok(store.listEventsAfter(0, 100).some((entry) => entry.event.type === "task.budget_exceeded"));
  } finally {
    queue.close();
    store.close();
  }
});

test("repeated identical completed output eventually fails as no progress", async () => {
  const constant: RuntimeAdapter = {
    id: "constant",
    async execute() {
      return {
        summary: "same result",
        artifactKind: "test",
        output: { answer: "unchanged" },
        usage: { input_tokens: 1, output_tokens: 1, cost: 0, actions: 1 }
      };
    }
  };
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = strictGateway(store, queue);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b", "constant"));
    const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(constant));

    for (let i = 0; i < 2; i += 1) {
      gateway.delegate({
        createdBy: "bot_a",
        assigneeId: "bot_b",
        workspaceId: "ws_safety",
        rootObjectiveId: "obj_stuck",
        objective: "Try to improve the same answer",
        reason: `attempt ${i + 1}`
      });
      const result = await runner.runNext("bot_b");
      assert.equal(result?.status, "completed");
    }

    gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_stuck",
      objective: "Try to improve the same answer",
      reason: "attempt 3"
    });
    const third = await runner.runNext("bot_b");
    assert.equal(third?.status, "failed");
    assert.equal(third?.task.payload.failure_code, "NO_PROGRESS_DETECTED");
    assert.equal(store.listObjects("artifact").length, 2);
    assert.ok(store.listEventsAfter(0, 200).some((entry) => entry.event.type === "task.no_progress"));
  } finally {
    queue.close();
    store.close();
  }
});


test("Handoff safety blocks repeated pair transitions and longer ownership cycles before creating new Handoff state", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = strictGateway(store);
  try {
    for (const id of ["bot_a", "bot_b", "bot_c"]) gateway.createBot(bot(id));

    const repeated = gateway.delegate({
      createdBy: "bot_c",
      assigneeId: "bot_a",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_handoff_repeat",
      objective: "Own repeat-guard work",
      reason: "safety setup"
    });
    for (let index = 1; index <= 2; index += 1) {
      gateway.record("handoff", {
        schema_version: "1.0",
        id: `handoff_repeat_${index}`,
        type: "handoff",
        source_owner_id: "bot_a",
        target_bot_id: "bot_b",
        workspace_id: "ws_safety",
        task_id: repeated.task.id,
        root_objective_id: "obj_handoff_repeat",
        reason: `prior transition ${index}`,
        required_constraints: [],
        return_policy: "explicit_only",
        status: "completed"
      });
    }

    assert.throws(() => gateway.requestHandoff({
      sourceOwnerId: "bot_a",
      targetOwnerId: "bot_b",
      workspaceId: "ws_safety",
      workItemId: repeated.task.id,
      rootObjectiveId: "obj_handoff_repeat",
      reason: "third transition must be blocked"
    }), (error: unknown) => error instanceof CoordinationLoopError && error.code === "PING_PONG_DETECTED");
    assert.equal(store.listObjects("handoff", "ws_safety").filter((item) => item.payload.root_objective_id === "obj_handoff_repeat").length, 2);
    assert.ok(store.listEventsAfter(0, 200).some((entry) =>
      entry.event.type === "safety.handoff_loop_blocked" && entry.event.task_id === repeated.task.id
    ));

    const cyclic = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_c",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_handoff_cycle",
      objective: "Own cycle-guard work",
      reason: "cycle setup"
    });
    gateway.record("handoff", {
      schema_version: "1.0",
      id: "handoff_cycle_ab",
      type: "handoff",
      source_owner_id: "bot_a",
      target_bot_id: "bot_b",
      workspace_id: "ws_safety",
      task_id: cyclic.task.id,
      root_objective_id: "obj_handoff_cycle",
      reason: "A to B",
      required_constraints: [],
      return_policy: "explicit_only",
      status: "completed"
    });
    gateway.record("handoff", {
      schema_version: "1.0",
      id: "handoff_cycle_bc",
      type: "handoff",
      source_owner_id: "bot_b",
      target_bot_id: "bot_c",
      workspace_id: "ws_safety",
      task_id: cyclic.task.id,
      root_objective_id: "obj_handoff_cycle",
      reason: "B to C",
      required_constraints: [],
      return_policy: "explicit_only",
      status: "completed"
    });

    assert.throws(() => gateway.requestHandoff({
      sourceOwnerId: "bot_c",
      targetOwnerId: "bot_a",
      workspaceId: "ws_safety",
      workItemId: cyclic.task.id,
      rootObjectiveId: "obj_handoff_cycle",
      reason: "C to A would close the cycle"
    }), (error: unknown) => error instanceof CoordinationLoopError && error.code === "LOOP_DETECTED");
    assert.equal(store.listObjects("handoff", "ws_safety").filter((item) => item.payload.root_objective_id === "obj_handoff_cycle").length, 2);
  } finally {
    store.close();
  }
});

test("Worker capacity guard enforces max_workers without counting terminal Workers", () => {
  const store = new CoordinationStore(":memory:");
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, undefined, policy);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.record("worker", {
      schema_version: "1.0",
      id: "worker_active_1",
      type: "worker",
      kind: "temporary",
      run_id: "run_capacity",
      created_by: "bot_a",
      parent_owner_id: "bot_a",
      task_id: "task_capacity_active_1",
      workspace_id: "ws_safety",
      role: { title: "Researcher", objective: "Research one bounded angle" },
      status: "running"
    });
    gateway.record("worker", {
      schema_version: "1.0",
      id: "worker_terminal",
      type: "worker",
      kind: "temporary",
      run_id: "run_capacity",
      created_by: "bot_a",
      parent_owner_id: "bot_a",
      task_id: "task_capacity_terminal",
      workspace_id: "ws_safety",
      role: { title: "Finished", objective: "Already finished" },
      status: "completed"
    });

    assert.deepEqual(policy.assertWorkerCapacity({
      workspaceId: "ws_safety",
      runId: "run_capacity",
      budget: { max_workers: 2 },
      additionalWorkers: 1
    }), { activeWorkers: 1, requestedWorkers: 1, limit: 2 });

    gateway.record("worker", {
      schema_version: "1.0",
      id: "worker_active_2",
      type: "worker",
      kind: "temporary",
      run_id: "run_capacity",
      created_by: "bot_a",
      parent_owner_id: "bot_a",
      task_id: "task_capacity_active_2",
      workspace_id: "ws_safety",
      role: { title: "Verifier", objective: "Verify one bounded angle" },
      status: "waiting"
    });

    assert.throws(() => policy.assertWorkerCapacity({
      workspaceId: "ws_safety",
      runId: "run_capacity",
      budget: { max_workers: 2 },
      additionalWorkers: 1
    }), (error: unknown) => error instanceof BudgetError && error.code === "WORKER_BUDGET_EXCEEDED");
  } finally {
    store.close();
  }
});

test("task owner can explicitly escalate to the user and unauthorized peers cannot", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = strictGateway(store);
  try {
    for (const id of ["bot_a", "bot_b", "bot_c"]) gateway.createBot(bot(id));
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_escalate",
      objective: "Resolve an ambiguous decision",
      reason: "Need bounded work",
      approval: { required: true, reason: "Hold execution while the decision is unresolved" }
    });

    const escalation = gateway.requestUserEscalation({
      taskId: delegated.task.id,
      actorId: "bot_b",
      reason: "I need the user's choice between the two safe options."
    });
    assert.equal(escalation.event.type, "user.escalation_requested");
    assert.equal(escalation.event.task_id, delegated.task.id);
    assert.equal(escalation.event.correlation_id, "obj_escalate");
    assert.equal(escalation.event.attention_state, "needs_input");

    assert.throws(() => gateway.requestUserEscalation({
      taskId: delegated.task.id,
      actorId: "bot_c",
      reason: "Unrelated peer must not escalate someone else's work"
    }), /not authorized to escalate/);
  } finally {
    store.close();
  }
});
