import assert from "node:assert/strict";
import { request } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { BudgetError } from "../src/budget.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, workspaceId = "ws_runs", canCreateWorkers = true): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Lead bounded Team Runs for ${workspaceId}` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: {
      policy_ref: "team-run-test",
      allowed_peers: ["*"],
      allowed_tools: ["web.search"],
      allowed_connections: ["drive"],
      can_create_workers: canCreateWorkers
    },
    coordination: { default_mode: "direct", max_parallel_workers: 2 }
  };
}

function setup(workspaceId = "ws_runs") {
  const store = new CoordinationStore(":memory:");
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, undefined, policy);
  gateway.createBot(bot("bot_lead", workspaceId));
  const teamRuns = new TeamRunCoordinator(store, gateway, policy);
  return { store, policy, gateway, teamRuns };
}

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

test("Team Run lifecycle is durable, explicitly led and run-sequenced", () => {
  const { store, teamRuns } = setup();
  try {
    const created = teamRuns.createRun({
      createdBy: "bot_lead",
      leaderId: "bot_lead",
      workspaceId: "ws_runs",
      rootObjectiveId: "obj_run_1",
      budget: { max_workers: 2, max_tasks: 4 }
    });
    assert.equal(created.run.payload.status, "created");
    assert.equal(created.event.runSequence, 1);
    assert.deepEqual(created.run.payload.participant_ids, ["bot_lead"]);

    const planning = teamRuns.transitionRun(created.run.id, "planning", "bot_lead");
    const running = teamRuns.transitionRun(created.run.id, "running", "bot_lead");
    assert.equal(planning.object.payload.status, "planning");
    assert.equal(running.object.payload.status, "running");
    assert.deepEqual(store.listRunEvents(created.run.id).map((entry) => entry.runSequence), [1, 2, 3]);
    assert.throws(() => teamRuns.transitionRun(created.run.id, "created", "bot_lead"), /cannot transition/);
  } finally {
    store.close();
  }
});

test("temporary Worker creation is atomic, Task-bound, authority-bounded and never creates a durable Bot", () => {
  const { store, gateway, teamRuns } = setup();
  try {
    const run = teamRuns.createRun({
      createdBy: "bot_lead",
      leaderId: "bot_lead",
      workspaceId: "ws_runs",
      rootObjectiveId: "obj_workers",
      budget: { max_workers: 2, max_tasks: 4, token_limit: 1000 }
    }).run;
    teamRuns.transitionRun(run.id, "planning", "bot_lead");

    const spawned = teamRuns.spawnWorker({
      runId: run.id,
      createdBy: "bot_lead",
      role: { title: "Source Auditor", objective: "Independently verify the primary-source claims" },
      tools: ["web.search"],
      connections: ["drive"],
      budget: { token_limit: 500 },
      expectedOutput: { contract: "claim-verification-report-v1" }
    });

    assert.equal(spawned.worker.kind, "worker");
    assert.equal(spawned.worker.payload.kind, "temporary");
    assert.equal(spawned.worker.payload.run_id, run.id);
    assert.equal(spawned.worker.payload.task_id, spawned.task.id);
    assert.equal(spawned.worker.payload.parent_owner_id, "bot_lead");
    assert.equal(spawned.task.payload.run_id, run.id);
    assert.equal(spawned.task.payload.owner_id, spawned.worker.id);
    assert.equal(spawned.task.payload.assignee_id, spawned.worker.id);
    assert.equal(spawned.task.payload.status, "created");
    assert.equal(spawned.task.payload.execution_state, "not_scheduled");
    assert.equal((spawned.task.payload.budget as any).token_limit, 500);
    assert.equal(spawned.capabilityLease.payload.issued_to, spawned.worker.id);
    assert.deepEqual(spawned.capabilityLease.payload.tools, ["web.search"]);
    assert.equal(spawned.environmentLease.payload.environment_ref, "workspace:ws_runs");
    assert.equal(gateway.getBot(spawned.worker.id), null);
    assert.equal(gateway.listBots("ws_runs").length, 1);
    assert.ok((spawned.run.payload.participant_ids as string[]).includes(spawned.worker.id));
    assert.ok((spawned.run.payload.worker_ids as string[]).includes(spawned.worker.id));
    assert.ok((spawned.run.payload.task_ids as string[]).includes(spawned.task.id));
    assert.equal(store.listObjects("worker", "ws_runs").length, 1);
    assert.deepEqual(store.listRunEvents(run.id).slice(-3).map((entry) => entry.event.type), [
      "worker.created",
      "task.created",
      "run.participant_added"
    ]);
  } finally {
    store.close();
  }
});

test("Team Run max_workers and leader max_parallel_workers both bound temporary Worker creation", () => {
  const { store, teamRuns } = setup();
  try {
    const run = teamRuns.createRun({
      createdBy: "bot_lead",
      leaderId: "bot_lead",
      workspaceId: "ws_runs",
      rootObjectiveId: "obj_capacity",
      budget: { max_workers: 3, max_tasks: 10 }
    }).run;
    teamRuns.transitionRun(run.id, "planning", "bot_lead");
    for (const title of ["Researcher", "Verifier"]) {
      teamRuns.spawnWorker({
        runId: run.id,
        createdBy: "bot_lead",
        role: { title, objective: `${title} objective` }
      });
    }
    assert.throws(() => teamRuns.spawnWorker({
      runId: run.id,
      createdBy: "bot_lead",
      role: { title: "Third", objective: "Must exceed leader parallel capacity" }
    }), (error: unknown) => error instanceof BudgetError && error.code === "WORKER_BUDGET_EXCEEDED");
    assert.equal(teamRuns.listWorkers(run.id).length, 2);
  } finally {
    store.close();
  }
});

test("Worker lifecycle is explicit and terminal state is coupled to its Task", () => {
  const { store, teamRuns } = setup();
  try {
    const run = teamRuns.createRun({
      createdBy: "bot_lead",
      leaderId: "bot_lead",
      workspaceId: "ws_runs",
      rootObjectiveId: "obj_worker_lifecycle",
      budget: { max_workers: 2, max_tasks: 4 }
    }).run;
    teamRuns.transitionRun(run.id, "planning", "bot_lead");
    const spawned = teamRuns.spawnWorker({
      runId: run.id,
      createdBy: "bot_lead",
      role: { title: "Analyst", objective: "Perform one bounded analysis" }
    });

    const ready = teamRuns.transitionWorker(spawned.worker.id, "ready", "bot_lead");
    assert.equal(ready.object.payload.status, "ready");
    assert.throws(() => teamRuns.transitionWorker(spawned.worker.id, "running", spawned.worker.id), /Task .* is created/);

    const task = store.getObject(spawned.task.id);
    if (!task) throw new Error("expected Worker Task");
    store.putObject("task", { ...task.payload, status: "assigned" });
    const running = teamRuns.transitionWorker(spawned.worker.id, "running", spawned.worker.id);
    assert.equal(running.object.payload.status, "running");
    assert.throws(() => teamRuns.transitionWorker(spawned.worker.id, "completed", spawned.worker.id), /cannot complete before Task/);

    const assignedTask = store.getObject(spawned.task.id);
    if (!assignedTask) throw new Error("expected assigned Worker Task");
    store.putObject("task", { ...assignedTask.payload, status: "completed" });
    const completed = teamRuns.transitionWorker(spawned.worker.id, "completed", spawned.worker.id);
    assert.equal(completed.object.payload.status, "completed");
    assert.throws(() => teamRuns.transitionWorker(spawned.worker.id, "ready", "bot_lead"), /cannot transition/);
  } finally {
    store.close();
  }
});

test("Run completion refuses active Workers and pre-execution Worker cancellation settles its Task atomically", () => {
  const { store, teamRuns } = setup();
  try {
    const run = teamRuns.createRun({
      createdBy: "bot_lead",
      leaderId: "bot_lead",
      workspaceId: "ws_runs",
      rootObjectiveId: "obj_terminal_guard",
      budget: { max_workers: 1, max_tasks: 3 }
    }).run;
    teamRuns.transitionRun(run.id, "planning", "bot_lead");
    teamRuns.transitionRun(run.id, "running", "bot_lead");
    const spawned = teamRuns.spawnWorker({
      runId: run.id,
      createdBy: "bot_lead",
      role: { title: "Disposable Reviewer", objective: "Review before scheduling" }
    });
    assert.throws(() => teamRuns.transitionRun(run.id, "completed", "bot_lead"), /Workers are active/);

    const canceled = teamRuns.transitionWorker(spawned.worker.id, "canceled", "bot_lead", "No longer needed");
    assert.equal(canceled.object.payload.status, "canceled");
    assert.equal(store.getObject(spawned.task.id)?.payload.status, "canceled");
    const completed = teamRuns.transitionRun(run.id, "completed", "bot_lead");
    assert.equal(completed.object.payload.status, "completed");
  } finally {
    store.close();
  }
});

test("Team Run and Worker state survive restart with canonical run replay", () => {
  const dbPath = resolve("runtime", `team-run-restart-${Date.now()}-${Math.random()}.db`);
  let runId = "";
  let workerId = "";
  {
      const store = new CoordinationStore(dbPath);
      const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
      const gateway = new CoordinationGateway(store, undefined, policy);
      gateway.createBot(bot("bot_lead"));
      const teamRuns = new TeamRunCoordinator(store, gateway, policy);
      const run = teamRuns.createRun({
        createdBy: "bot_lead",
        leaderId: "bot_lead",
        workspaceId: "ws_runs",
        rootObjectiveId: "obj_restart",
        budget: { max_workers: 1, max_tasks: 3 }
      }).run;
      runId = run.id;
      teamRuns.transitionRun(run.id, "planning", "bot_lead");
      const worker = teamRuns.spawnWorker({
        runId: run.id,
        createdBy: "bot_lead",
        role: { title: "Restart Worker", objective: "Prove persistence" }
      }).worker;
      workerId = worker.id;
      store.close();
    }
    {
      const store = new CoordinationStore(dbPath);
      const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
      const gateway = new CoordinationGateway(store, undefined, policy);
      const teamRuns = new TeamRunCoordinator(store, gateway, policy);
      assert.equal(teamRuns.getRun(runId)?.payload.status, "planning");
      assert.equal(store.getObject(workerId)?.kind, "worker");
      const events = store.listRunEvents(runId);
      assert.ok(events.length >= 5);
      assert.deepEqual(events.map((entry) => entry.runSequence), events.map((_, index) => index + 1));
      store.close();
    }
});

test("HTTP gateway exposes Team Run creation, lifecycle, Worker spawn and run replay", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", bot("bot_lead"))).status, 201);
    const created = await httpJson(address.port, "POST", "/v1/team-runs", {
      createdBy: "bot_lead",
      leaderId: "bot_lead",
      workspaceId: "ws_runs",
      rootObjectiveId: "obj_http_run",
      budget: { max_workers: 1, max_tasks: 3 }
    });
    assert.equal(created.status, 201);
    const runId = created.body.run.id;

    const planning = await httpJson(address.port, "POST", `/v1/team-runs/${runId}/transition`, {
      actorId: "bot_lead",
      status: "planning"
    });
    assert.equal(planning.status, 200);

    const worker = await httpJson(address.port, "POST", `/v1/team-runs/${runId}/workers`, {
      createdBy: "bot_lead",
      role: { title: "HTTP Worker", objective: "Prove the public lifecycle contract" },
      tools: ["web.search"]
    });
    assert.equal(worker.status, 201);
    assert.equal(worker.body.worker.payload.run_id, runId);
    assert.equal(service.executionQueue.getByItem(worker.body.task.id), null);

    const workers = await httpJson(address.port, "GET", `/v1/team-runs/${runId}/workers`);
    assert.equal(workers.status, 200);
    assert.equal(workers.body.workers.length, 1);

    const events = await httpJson(address.port, "GET", `/v1/team-runs/${runId}/events?after=0`);
    assert.equal(events.status, 200);
    assert.ok(events.body.events.length >= 5);
    assert.ok(events.body.events.every((entry: any) => entry.event.run_id === runId));
  } finally {
    await service.close();
  }
});

test("Worker creation fails closed without explicit permission and rejects unsupported environment policies", () => {
  const store = new CoordinationStore(":memory:");
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, undefined, policy);
  const implicit = bot("bot_implicit");
  delete (implicit.permissions as any).can_create_workers;
  gateway.createBot(implicit);
  gateway.createBot(bot("bot_explicit"));
  const teamRuns = new TeamRunCoordinator(store, gateway, policy);
  try {
    const implicitRun = teamRuns.createRun({
      createdBy: "bot_implicit",
      leaderId: "bot_implicit",
      workspaceId: "ws_runs",
      rootObjectiveId: "obj_implicit_permission",
      budget: { max_workers: 1, max_tasks: 2 }
    }).run;
    teamRuns.transitionRun(implicitRun.id, "planning", "bot_implicit");
    assert.throws(() => teamRuns.spawnWorker({
      runId: implicitRun.id,
      createdBy: "bot_implicit",
      role: { title: "Implicit", objective: "Must fail closed" }
    }), /not explicitly allowed to create Workers/);

    const explicitRun = teamRuns.createRun({
      createdBy: "bot_explicit",
      leaderId: "bot_explicit",
      workspaceId: "ws_runs",
      rootObjectiveId: "obj_bad_environment",
      budget: { max_workers: 1, max_tasks: 2 }
    }).run;
    teamRuns.transitionRun(explicitRun.id, "planning", "bot_explicit");
    assert.throws(() => teamRuns.spawnWorker({
      runId: explicitRun.id,
      createdBy: "bot_explicit",
      role: { title: "Unsafe Env", objective: "Must reject forged environment policy" },
      environmentPolicy: "host_root" as any,
      environmentRef: "forged:root"
    }), /Unsupported Worker environment policy host_root/);
    assert.equal(teamRuns.listWorkers(explicitRun.id).length, 0);
  } finally {
    store.close();
  }
});

test("Worker creation rejects authority expansion, disabled creation permission and unauthorized creators", () => {
  const store = new CoordinationStore(":memory:");
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, undefined, policy);
  gateway.createBot(bot("bot_locked", "ws_runs", false));
  gateway.createBot(bot("bot_other"));
  const teamRuns = new TeamRunCoordinator(store, gateway, policy);
  try {
    const lockedRun = teamRuns.createRun({
      createdBy: "bot_locked",
      leaderId: "bot_locked",
      workspaceId: "ws_runs",
      rootObjectiveId: "obj_locked",
      budget: { max_workers: 1, max_tasks: 2 }
    }).run;
    teamRuns.transitionRun(lockedRun.id, "planning", "bot_locked");
    assert.throws(() => teamRuns.spawnWorker({
      runId: lockedRun.id,
      createdBy: "bot_locked",
      role: { title: "Denied", objective: "Must not be created" }
    }), /not explicitly allowed to create Workers/);

    const run = teamRuns.createRun({
      createdBy: "bot_other",
      leaderId: "bot_other",
      workspaceId: "ws_runs",
      rootObjectiveId: "obj_authority",
      budget: { max_workers: 1, max_tasks: 2 }
    }).run;
    teamRuns.transitionRun(run.id, "planning", "bot_other");
    assert.throws(() => teamRuns.spawnWorker({
      runId: run.id,
      createdBy: "bot_other",
      role: { title: "Overreach", objective: "Try to gain a forbidden tool" },
      tools: ["shell.root"]
    }), /does not hold that authority/);
    assert.throws(() => teamRuns.spawnWorker({
      runId: run.id,
      createdBy: "bot_locked",
      role: { title: "Wrong creator", objective: "Must not create" }
    }), /Only Team Run leader/);
  } finally {
    store.close();
  }
});
