import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { RecoveryCoordinator } from "../src/recovery.js";
import { BotRunner } from "../src/runner.js";
import type { RuntimeAdapter, RuntimeExecutionContext, RuntimeExecutionResult } from "../src/runtime.js";
import { RuntimeRegistry } from "../src/runtime.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";
import { validateProtocolObject } from "../src/validator.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bot(id: string, adapter = "slow"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Mission for ${id}` },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_recovery_live" },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

class SlowRuntimeAdapter implements RuntimeAdapter {
  readonly id = "slow";

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    await sleep(260);
    if (context.signal.aborted) throw context.signal.reason ?? new Error("aborted");
    return {
      summary: "Slow work completed",
      artifactKind: "slow_result",
      output: { ok: true, task_id: context.task.id },
      usage: { input_tokens: 1, output_tokens: 1, cost: 0, actions: 1 }
    };
  }
}

test("live BotRunner heartbeats keep long-running work out of stale recovery", async () => {
  const dbPath = `/tmp/ai-verse-live-heartbeat-${randomUUID()}.db`;
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const gateway = new CoordinationGateway(store, queue);
  const recovery = new RecoveryCoordinator(store, queue, gateway);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_recovery_live",
      rootObjectiveId: "obj_live_heartbeat",
      objective: "Stay alive while working",
      reason: "Heartbeat integration test"
    });
    queue.setRecoveryPolicy(delegated.task.id, "retry_safe", 3);
    const runner = new BotRunner(
      store,
      gateway,
      queue,
      new RuntimeRegistry().register(new SlowRuntimeAdapter()),
      "runner_live",
      0.1,
      20
    );

    const run = runner.runNext("bot_b");
    await sleep(150);
    const execution = queue.getByItem(delegated.task.id);
    assert.equal(execution?.state, "running");
    assert.equal(execution?.claimedBy, "runner_live");
    assert.ok(Date.parse(String(execution?.leaseExpiresAt)) > Date.now());
    assert.equal(recovery.recoverStale(Date.now()).length, 0);

    const result = await run;
    assert.equal(result?.status, "completed");
    assert.equal(queue.getByItem(delegated.task.id)?.state, "completed");
  } finally {
    queue.close();
    store.close();
  }
});

function httpJson(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => resolve({ status: Number(res.statusCode), body: JSON.parse(chunks.join("") || "{}") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function httpBot(id: string, adapter: string) {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: "Exercise recovery HTTP contracts." },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_http_recovery" },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

test("HTTP delegation persists recovery policy and dead-letter retry is operator-only", async () => {
  const dbPath = `/tmp/ai-verse-http-recovery-${randomUUID()}.db`;
  const service = createGatewayServer({ dbPath, port: 0 });
  const address = await service.listen();
  try {
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", httpBot("bot_http_a", "deterministic"))).status, 201);
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", httpBot("bot_http_b", "unregistered_runtime"))).status, 201);

    const safe = await httpJson(address.port, "POST", "/v1/delegations", {
      createdBy: "bot_http_a",
      assigneeId: "bot_http_b",
      workspaceId: "ws_http_recovery",
      rootObjectiveId: "obj_http_safe",
      objective: "Replay-safe research",
      reason: "Verify recovery metadata",
      recoveryPolicy: "retry_safe",
      maxAttempts: 4
    });
    assert.equal(safe.status, 201);
    const executionList = await httpJson(address.port, "GET", "/v1/execution/bot_http_b");
    const safeExecution = executionList.body.executions.find((entry: any) => entry.itemId === safe.body.task.id);
    assert.equal(safeExecution.recoveryPolicy, "retry_safe");
    assert.equal(safeExecution.maxAttempts, 4);

    const manual = await httpJson(address.port, "POST", "/v1/delegations", {
      createdBy: "bot_http_a",
      assigneeId: "bot_http_b",
      workspaceId: "ws_http_recovery",
      rootObjectiveId: "obj_http_manual",
      objective: "Potential external side effect",
      reason: "Must not replay automatically",
      recoveryPolicy: "manual"
    });
    assert.equal(manual.status, 201);
    const claimed = service.executionQueue.claimNext("bot_http_b", "runner_crashed", 0.05);
    if (!claimed) throw new Error("expected manual Task claim");
    service.executionQueue.markRunning(claimed.id, "runner_crashed", 0.05);
    const task = service.store.getObject(claimed.itemId);
    if (!task) throw new Error("expected manual Task");
    service.store.putObject("task", validateProtocolObject({
      ...task.payload,
      status: "running",
      started_at: new Date().toISOString(),
      execution_runner_id: "runner_crashed"
    }, "task"));
    service.supervisor.sweepRecovery(Date.now() + 1_000);

    const deadLetters = await httpJson(address.port, "GET", "/v1/recovery/dead-letters?workspace=ws_http_recovery");
    assert.equal(deadLetters.status, 200);
    assert.ok(deadLetters.body.executions.some((entry: any) => entry.itemId === manual.body.task.id));

    const denied = await httpJson(address.port, "POST", `/v1/tasks/${manual.body.task.id}/retry`, { actorId: "bot_http_a" });
    assert.equal(denied.status, 400);
    const approved = await httpJson(address.port, "POST", `/v1/tasks/${manual.body.task.id}/retry`, {
      actorId: "operator_local",
      reason: "Reviewed external effects; retry is safe"
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.execution.state, "queued");
    assert.equal(approved.body.task.status, "assigned");
  } finally {
    await service.close();
  }
});
