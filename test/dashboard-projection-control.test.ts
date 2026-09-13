import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { request } from "node:http";
import test from "node:test";
import {
  DASHBOARD_PROJECTION_PROVIDER,
  DashboardProjectionProjector
} from "../src/dashboard-projection.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";

function manifest(id: string, workspaceId: string) {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: "Worker", mission: "Dashboard projection test" },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"], can_create_workers: true },
    coordination: { default_mode: "direct" }
  } as const;
}

function task(id: string, workspaceId: string, ownerId: string, status = "assigned") {
  return {
    schema_version: "1.0",
    id,
    type: "task.delegate",
    created_by: "operator_dashboard",
    assignee_id: ownerId,
    owner_id: ownerId,
    workspace_id: workspaceId,
    root_objective_id: "objective_" + id,
    reason: "Dashboard test",
    objective: "Objective " + id,
    required_constraints: [],
    expected_output: { contract: "artifact" },
    lease_id: "lease_" + id,
    status
  };
}

function approval(id: string, workspaceId: string, taskId: string) {
  return {
    schema_version: "1.0",
    id,
    type: "approval",
    workspace_id: workspaceId,
    actor_id: "bot_a",
    task_id: taskId,
    requested_by: "operator_dashboard",
    requested_at: new Date().toISOString(),
    status: "pending",
    reason: "Confirm action",
    action: { kind: "task.execute", summary: "Run approved task" }
  };
}

function artifact(id: string, workspaceId: string, taskId: string) {
  return {
    schema_version: "1.0",
    id,
    type: "artifact",
    workspace_id: workspaceId,
    created_by: "bot_a",
    task_id: taskId,
    kind: "report",
    title: "Result",
    summary: "Projected artifact summary",
    provenance: { origin: "bot_generated", trusted_instruction: false }
  };
}

function httpJson(
  port: number,
  method: string,
  path: string,
  body?: unknown
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
      res.on("end", () => {
        resolvePromise({
          status: Number(res.statusCode ?? 0),
          body: JSON.parse(chunks.join("") || "{}")
        });
      });
    });
    req.on("error", rejectPromise);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("Phase 5.9 Dashboard snapshot is read-only, workspace-scoped, and compact", () => {
  const dbPath = "/tmp/dashboard-projection-" + randomUUID() + ".db";
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(dbPath);
  try {
    store.putObject("bot", manifest("bot_a", "ws_a"));
    store.putObject("bot", manifest("bot_b", "ws_b"));
    store.putObject("task", task("task_a", "ws_a", "bot_a", "waiting_approval"));
    store.putObject("task", task("task_b", "ws_b", "bot_b"));
    store.putObject("approval", approval("approval_a", "ws_a", "task_a"));
    store.putObject("artifact", artifact("artifact_a", "ws_a", "task_a"));

    const cursorBefore = store.latestEventSequence();
    const projection = new DashboardProjectionProjector(store, queue).project("ws_a");
    const cursorAfter = store.latestEventSequence();

    assert.equal(projection.provider, DASHBOARD_PROJECTION_PROVIDER);
    assert.equal(projection.projection_only, true);
    assert.equal(projection.dashboard_owns_truth, false);
    assert.equal(projection.canonical_owner, "ai-verse-multiple-bots");
    assert.equal(projection.workspace_id, "ws_a");
    assert.equal(cursorAfter, cursorBefore);
    assert.deepEqual(projection.bots.map((bot) => bot.id), ["bot_a"]);
    assert.deepEqual(projection.tasks.map((item) => item.id), ["task_a"]);
    assert.deepEqual(projection.approvals.map((item) => item.id), ["approval_a"]);
    assert.deepEqual(projection.artifacts.map((item) => item.id), ["artifact_a"]);
    assert.equal(projection.bots[0]?.activity, "approval-needed");
    assert.equal(projection.attention[0]?.kind, "approval");
    assert.equal(projection.attention[0]?.control, "approval.approve");
    assert.equal(projection.counts.pending_approvals, 1);
  } finally {
    queue.close();
    store.close();
  }
});

test("Phase 5.9 Dashboard HTTP snapshot, capabilities, and event replay never cross workspace scope", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    service.gateway.createBot(manifest("bot_a", "ws_a"));
    service.gateway.createBot(manifest("bot_b", "ws_b"));
    service.gateway.emit({
      type: "dashboard.test.a",
      actorId: "operator_dashboard",
      workspaceId: "ws_a",
      summary: "A only"
    });
    service.gateway.emit({
      type: "dashboard.test.b",
      actorId: "operator_dashboard",
      workspaceId: "ws_b",
      summary: "B only"
    });

    const capabilities = await httpJson(
      address.port,
      "GET",
      "/v1/dashboard/capabilities?workspace=ws_a"
    );
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.projection_only, true);
    assert.equal(capabilities.body.dashboard_owns_truth, false);
    assert.equal(capabilities.body.controls.includes("task.cancel"), true);
    assert.equal(capabilities.body.controls.includes("team_run.cancel"), true);

    const snapshot = await httpJson(
      address.port,
      "GET",
      "/v1/dashboard/snapshot?workspace=ws_a"
    );
    assert.equal(snapshot.status, 200);
    assert.deepEqual(snapshot.body.bots.map((bot: any) => bot.id), ["bot_a"]);
    assert.equal(JSON.stringify(snapshot.body).includes("bot_b"), false);

    const events = await httpJson(
      address.port,
      "GET",
      "/v1/dashboard/events?workspace=ws_a&after=0&limit=100"
    );
    assert.equal(events.status, 200);
    assert.equal(events.body.events.length >= 2, true);
    assert.equal(
      events.body.events.every((item: any) => item.event.workspace_id === "ws_a"),
      true
    );
    assert.equal(
      events.body.events.some((item: any) => item.event.summary === "B only"),
      false
    );
  } finally {
    await service.close();
  }
});

test("Phase 5.9 Dashboard controls reuse canonical Bot and Approval owners and reject cross-workspace targets", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    service.gateway.createBot(manifest("bot_a", "ws_a"));
    service.gateway.createBot(manifest("bot_b", "ws_b"));

    const crossWorkspace = await httpJson(
      address.port,
      "POST",
      "/v1/dashboard/control",
      {
        action: "bot.disable",
        workspaceId: "ws_a",
        targetId: "bot_b",
        actorId: "operator_dashboard"
      }
    );
    assert.equal(crossWorkspace.status, 400);
    assert.equal(crossWorkspace.body.error, "DASHBOARD_WORKSPACE_MISMATCH");
    assert.equal(service.gateway.getBot("bot_b")?.payload.status, "active");

    const nonOperator = await httpJson(
      address.port,
      "POST",
      "/v1/dashboard/control",
      {
        action: "bot.disable",
        workspaceId: "ws_a",
        targetId: "bot_a",
        actorId: "bot_a"
      }
    );
    assert.equal(nonOperator.status, 400);
    assert.equal(nonOperator.body.error, "DASHBOARD_OPERATOR_REQUIRED");

    const disabled = await httpJson(
      address.port,
      "POST",
      "/v1/dashboard/control",
      {
        action: "bot.disable",
        workspaceId: "ws_a",
        targetId: "bot_a",
        actorId: "operator_dashboard"
      }
    );
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.provider, "ai-verse-multiple-bots/dashboard-control-v1");
    assert.equal(disabled.body.dashboard_owns_truth, false);
    assert.equal(disabled.body.resulting_status, "disabled");
    assert.equal(service.gateway.getBot("bot_a")?.payload.status, "disabled");

    service.store.putObject("task", task("task_approval", "ws_a", "bot_a", "waiting_approval"));
    service.store.putObject("approval", approval("approval_dashboard", "ws_a", "task_approval"));

    const approved = await httpJson(
      address.port,
      "POST",
      "/v1/dashboard/control",
      {
        action: "approval.approve",
        workspaceId: "ws_a",
        targetId: "approval_dashboard",
        actorId: "operator_dashboard"
      }
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.resulting_status, "approved");
    assert.equal(service.store.getObject("approval_dashboard")?.payload.status, "approved");
    assert.equal(service.store.getObject("task_approval")?.payload.status, "assigned");
  } finally {
    await service.close();
  }
});

test("Phase 5.9 Dashboard task cancel and retry route through canonical runner/recovery boundaries", async () => {
  const dbPath = "/tmp/dashboard-control-recovery-" + randomUUID() + ".db";
  const service = createGatewayServer({ dbPath, port: 0 });
  const address = await service.listen();
  try {
    service.store.putObject("bot", {
      ...manifest("bot_a", "ws_a"),
      runtime: { adapter: "dashboard-test-nonexecuting" }
    });

    service.store.putObject("task", task("task_cancel", "ws_a", "bot_a"));
    service.executionQueue.enqueueTask("task_cancel", "bot_a", "ws_a");
    const canceled = await httpJson(
      address.port,
      "POST",
      "/v1/dashboard/control",
      {
        action: "task.cancel",
        workspaceId: "ws_a",
        targetId: "task_cancel",
        actorId: "operator_dashboard",
        reason: "Stop from Dashboard"
      }
    );
    assert.equal(canceled.status, 200);
    assert.equal(canceled.body.resulting_status, "canceled");
    assert.equal(service.store.getObject("task_cancel")?.payload.status, "canceled");
    assert.equal(service.executionQueue.getByItem("task_cancel")?.state, "canceled");

    service.store.putObject("task", task("task_retry", "ws_a", "bot_a", "blocked"));
    const execution = service.executionQueue.enqueueTask(
      "task_retry",
      "bot_a",
      "ws_a",
      { recoveryPolicy: "retry_safe", maxAttempts: 3 }
    );
    service.executionQueue.updateState(execution.id, "dead_letter", "temporary failure");

    const snapshotBefore = await httpJson(
      address.port,
      "GET",
      "/v1/dashboard/snapshot?workspace=ws_a"
    );
    const dead = snapshotBefore.body.tasks.find((item: any) => item.id === "task_retry");
    assert.equal(dead.execution_state, "dead_letter");
    assert.equal(dead.controls.includes("task.retry"), true);

    const retried = await httpJson(
      address.port,
      "POST",
      "/v1/dashboard/control",
      {
        action: "task.retry",
        workspaceId: "ws_a",
        targetId: "task_retry",
        actorId: "operator_dashboard"
      }
    );
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.resulting_status, "queued");
    assert.equal(service.executionQueue.getByItem("task_retry")?.state, "queued");
  } finally {
    await service.close();
    rmSync(dbPath, { force: true });
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
  }
});

test("Phase 5.9 Dashboard can cancel a Team Run only through the existing Team Run control plane", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    service.gateway.createBot(manifest("bot_lead", "ws_a"));
    const created = service.teamRunCoordinator.createRun({
      leaderId: "bot_lead",
      workspaceId: "ws_a",
      rootObjectiveId: "objective_dashboard_run",
      objective: "Exercise Dashboard run control",
      topology: "dynamic_squad"
    });

    const canceled = await httpJson(
      address.port,
      "POST",
      "/v1/dashboard/control",
      {
        action: "team_run.cancel",
        workspaceId: "ws_a",
        targetId: created.run.id,
        actorId: "operator_dashboard",
        reason: "Cancel from Dashboard"
      }
    );
    assert.equal(canceled.status, 200);
    assert.equal(canceled.body.resulting_status, "canceled");
    assert.equal(service.teamRunCoordinator.getRun(created.run.id)?.payload.status, "canceled");

    const snapshot = await httpJson(
      address.port,
      "GET",
      "/v1/dashboard/snapshot?workspace=ws_a"
    );
    const run = snapshot.body.team_runs.find((item: any) => item.id === created.run.id);
    assert.equal(run.status, "canceled");
    assert.deepEqual(run.controls, []);
  } finally {
    await service.close();
  }
});
