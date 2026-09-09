import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionOwnershipError, ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { RecoveryCoordinator } from "../src/recovery.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";
import { validateProtocolObject } from "../src/validator.js";

function bot(id: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Mission for ${id}` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_recovery" },
    permissions: { policy_ref: "default-bot" },
    coordination: { default_mode: "direct" }
  };
}

function fixture() {
  const dbPath = `/tmp/ai-verse-recovery-${randomUUID()}.db`;
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const gateway = new CoordinationGateway(store, queue);
  gateway.createBot(bot("bot_a"));
  gateway.createBot(bot("bot_b"));
  const recovery = new RecoveryCoordinator(store, queue, gateway);
  return { store, queue, gateway, recovery };
}

function staleTask(gateway: CoordinationGateway, queue: ExecutionQueue, store: CoordinationStore, options: { policy?: "manual" | "retry_safe"; maxAttempts?: number } = {}) {
  const delegated = gateway.delegate({
    createdBy: "bot_a",
    assigneeId: "bot_b",
    workspaceId: "ws_recovery",
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Recover this work safely",
    reason: "Recovery test"
  });
  if (options.policy) queue.setRecoveryPolicy(delegated.task.id, options.policy, options.maxAttempts);
  const claimed = queue.claimNext("bot_b", "runner_old", 1);
  if (!claimed) throw new Error("expected execution claim");
  const running = queue.markRunning(claimed.id, "runner_old", 1);
  store.putObject("task", validateProtocolObject({
    ...delegated.task.payload,
    status: "running",
    execution_runner_id: "runner_old",
    execution_attempt: running.attempts,
    started_at: new Date().toISOString()
  }, "task"));
  return { delegated, claimed: running };
}

test("retry_safe stale execution is requeued and late old runner loses write authority", () => {
  const { store, queue, gateway, recovery } = fixture();
  try {
    const { delegated, claimed } = staleTask(gateway, queue, store, { policy: "retry_safe", maxAttempts: 3 });
    const decisions = recovery.recoverStale(Date.now() + 2_000);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.action, "requeued");
    assert.equal(queue.getByItem(delegated.task.id)?.state, "queued");
    assert.equal(queue.getByItem(delegated.task.id)?.claimedBy, null);
    assert.equal(store.getObject(delegated.task.id)?.payload.status, "assigned");
    assert.throws(
      () => queue.finishOwned(claimed.id, "runner_old", "completed"),
      (error: unknown) => error instanceof ExecutionOwnershipError
    );
    const replacement = queue.claimNext("bot_b", "runner_new", 30);
    assert.equal(replacement?.attempts, 2);
    assert.equal(replacement?.claimedBy, "runner_new");
    const events = store.listEventsAfter(0, 100).map((entry) => entry.event.type);
    assert.ok(events.includes("execution.requeued"));
  } finally {
    queue.close();
    store.close();
  }
});

test("manual stale execution is dead-lettered instead of replayed", () => {
  const { store, queue, gateway, recovery } = fixture();
  try {
    const { delegated, claimed } = staleTask(gateway, queue, store);
    const decisions = recovery.recoverStale(Date.now() + 2_000);
    assert.equal(decisions[0]?.action, "dead_letter");
    assert.equal(queue.getByItem(delegated.task.id)?.state, "dead_letter");
    assert.equal(store.getObject(delegated.task.id)?.payload.status, "blocked");
    assert.equal(store.getObject(delegated.task.id)?.payload.recovery_required, true);
    assert.equal(recovery.listDeadLetters("ws_recovery").length, 1);
    assert.throws(
      () => queue.finishOwned(claimed.id, "runner_old", "completed"),
      (error: unknown) => error instanceof ExecutionOwnershipError
    );
  } finally {
    queue.close();
    store.close();
  }
});

test("retry_safe execution dead-letters after its attempt ceiling is exhausted", () => {
  const { store, queue, gateway, recovery } = fixture();
  try {
    const { delegated } = staleTask(gateway, queue, store, { policy: "retry_safe", maxAttempts: 1 });
    const decisions = recovery.recoverStale(Date.now() + 2_000);
    assert.equal(decisions[0]?.action, "dead_letter");
    assert.equal(queue.getByItem(delegated.task.id)?.state, "dead_letter");
    assert.match(String(queue.getByItem(delegated.task.id)?.lastError), /exhausted/i);
  } finally {
    queue.close();
    store.close();
  }
});

test("terminal Task with stale execution is reconciled and never replayed", () => {
  const { store, queue, gateway, recovery } = fixture();
  try {
    const { delegated } = staleTask(gateway, queue, store, { policy: "retry_safe", maxAttempts: 3 });
    const running = store.getObject(delegated.task.id);
    if (!running) throw new Error("Task missing");
    store.putObject("task", validateProtocolObject({
      ...running.payload,
      status: "completed",
      completed_at: new Date().toISOString(),
      output_artifact_refs: []
    }, "task"));
    const decisions = recovery.recoverStale(Date.now() + 2_000);
    assert.equal(decisions[0]?.action, "reconciled");
    assert.equal(queue.getByItem(delegated.task.id)?.state, "completed");
    assert.equal(queue.getByItem(delegated.task.id)?.claimedBy, null);
    assert.equal(store.getObject(delegated.task.id)?.payload.status, "completed");
    assert.equal(queue.list("bot_b", ["queued"]).length, 0);
  } finally {
    queue.close();
    store.close();
  }
});

test("only operator can retry dead-lettered Task", () => {
  const { store, queue, gateway, recovery } = fixture();
  try {
    const { delegated } = staleTask(gateway, queue, store);
    recovery.recoverStale(Date.now() + 2_000);
    assert.throws(() => recovery.retryDeadLetter(delegated.task.id, "bot_a"), /Only an operator/);
    const retried = recovery.retryDeadLetter(delegated.task.id, "operator_local", "Reviewed side effects and safe to retry");
    assert.equal(retried.execution.state, "queued");
    assert.equal(retried.task.payload.status, "assigned");
    assert.equal(retried.task.payload.recovery_retry_authorized_by, "operator_local");
    const events = store.listEventsAfter(0, 100).map((entry) => entry.event.type);
    assert.ok(events.includes("execution.retry_authorized"));
  } finally {
    queue.close();
    store.close();
  }
});

test("fresh heartbeat prevents stale recovery", () => {
  const { store, queue, gateway, recovery } = fixture();
  try {
    const { delegated, claimed } = staleTask(gateway, queue, store, { policy: "retry_safe", maxAttempts: 3 });
    queue.heartbeat(claimed.id, "runner_old", 10);
    const decisions = recovery.recoverStale(Date.now() + 2_000);
    assert.equal(decisions.length, 0);
    assert.equal(queue.getByItem(delegated.task.id)?.state, "running");
    assert.equal(queue.getByItem(delegated.task.id)?.claimedBy, "runner_old");
  } finally {
    queue.close();
    store.close();
  }
});
