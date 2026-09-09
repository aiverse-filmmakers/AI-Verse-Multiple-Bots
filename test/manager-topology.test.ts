import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { ManagerTopologyCoordinator } from "../src/manager-topology.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest } from "../src/types.js";

function bot(id = "bot_manager", workspaceId = "ws_manager"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: "Own coherent final output while supervising bounded specialists" },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: {
      policy_ref: "manager-test",
      allowed_peers: ["*"],
      allowed_tools: ["web.search"],
      allowed_connections: ["drive"],
      can_create_workers: true
    },
    coordination: { default_mode: "manager", max_parallel_workers: 4, max_hops: 6 }
  };
}

function setup(dbPath = ":memory:") {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  gateway.createBot(bot());
  const teamRuns = new TeamRunCoordinator(store, gateway, policy);
  const manager = new ManagerTopologyCoordinator(store, gateway, teamRuns, queue);
  const runtimes = new RuntimeRegistry().register(new DeterministicRuntimeAdapter());
  const runner = new BotRunner(store, gateway, queue, runtimes);
  return { store, queue, policy, gateway, teamRuns, manager, runtimes, runner };
}

function createManagerRun(teamRuns: TeamRunCoordinator) {
  const run = teamRuns.createRun({
    createdBy: "bot_manager",
    leaderId: "bot_manager",
    workspaceId: "ws_manager",
    rootObjectiveId: `obj_manager_${Date.now()}_${Math.random()}`,
    topology: "manager",
    budget: { max_workers: 4, max_tasks: 8 }
  }).run;
  teamRuns.transitionRun(run.id, "planning", "bot_manager");
  return run;
}

function spawn(teamRuns: TeamRunCoordinator, runId: string, title: string) {
  return teamRuns.spawnWorker({
    runId,
    createdBy: "bot_manager",
    role: { title, objective: `${title} performs one bounded specialist contribution` },
    tools: ["web.search"],
    budget: { token_limit: 100 }
  });
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

test("manager topology schedules exactly one specialist while leader retains root ownership", () => {
  const { store, queue, teamRuns, manager } = setup();
  try {
    const run = createManagerRun(teamRuns);
    const first = spawn(teamRuns, run.id, "Research Specialist");
    const second = spawn(teamRuns, run.id, "Technical Specialist");
    assert.equal(queue.getByItem(first.task.id), null);
    assert.equal(queue.getByItem(second.task.id), null);
    teamRuns.transitionRun(run.id, "running", "bot_manager");

    const scheduled = manager.schedule({ runId: run.id, workerId: first.worker.id, actorId: "bot_manager" });
    assert.equal(scheduled.task.payload.status, "assigned");
    assert.equal(scheduled.task.payload.owner_id, first.worker.id);
    assert.equal(scheduled.task.payload.assignee_id, first.worker.id);
    assert.equal(scheduled.task.payload.root_owner_id, "bot_manager");
    assert.equal(scheduled.run.payload.leader_id, "bot_manager");
    assert.equal((scheduled.run.payload.manager_state as any).active_worker_id, first.worker.id);
    assert.equal(scheduled.execution.targetId, first.worker.id);
    assert.equal(scheduled.execution.state, "queued");
    assert.throws(
      () => manager.schedule({ runId: run.id, workerId: second.worker.id, actorId: "bot_manager" }),
      /already has active specialist/
    );
  } finally {
    queue.close();
    store.close();
  }
});

test("manager-supervised Worker executes through canonical runner and releases the slot for the next specialist", async () => {
  const { store, queue, gateway, teamRuns, manager, runner } = setup();
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0, manager);
  try {
    const run = createManagerRun(teamRuns);
    const first = spawn(teamRuns, run.id, "First Specialist");
    const second = spawn(teamRuns, run.id, "Second Specialist");
    teamRuns.transitionRun(run.id, "running", "bot_manager");

    manager.schedule({ runId: run.id, workerId: first.worker.id, actorId: "bot_manager" });
    supervisor.start();
    await supervisor.waitForIdle();

    const firstTask = store.getObject(first.task.id);
    const firstWorker = store.getObject(first.worker.id);
    assert.equal(firstTask?.payload.status, "completed");
    assert.equal(firstWorker?.payload.status, "completed");
    const artifactId = (firstTask?.payload.output_artifact_refs as string[])[0] as string;
    const artifact = store.getObject(artifactId);
    assert.equal(artifact?.payload.created_by, first.worker.id);
    assert.equal((artifact?.payload.provenance as any)?.origin, "worker_generated");
    assert.equal((artifact?.payload.inline_content as any)?.executed_by, first.worker.id);
    assert.equal((artifact?.payload.inline_content as any)?.execution_principal_kind, "worker");
    assert.equal((manager.getState(run.id) as any).active_worker_id, null);

    manager.schedule({ runId: run.id, workerId: second.worker.id, actorId: "bot_manager" });
    await supervisor.waitForIdle();
    assert.equal(store.getObject(second.task.id)?.payload.status, "completed");
    assert.equal(store.getObject(second.worker.id)?.payload.status, "completed");
    assert.equal((manager.getState(run.id) as any).active_worker_id, null);
    assert.deepEqual((manager.getState(run.id) as any).completed_worker_ids, [first.worker.id, second.worker.id]);
    assert.equal(teamRuns.getRun(run.id)?.payload.leader_id, "bot_manager");
  } finally {
    await supervisor.stop();
    queue.close();
    store.close();
  }
});

test("manager scheduling rejects wrong topology, wrong actor and cross-run Worker", () => {
  const { store, queue, gateway, teamRuns, manager } = setup();
  try {
    gateway.createBot(bot("bot_intruder"));
    const nonManager = teamRuns.createRun({
      createdBy: "bot_manager",
      leaderId: "bot_manager",
      workspaceId: "ws_manager",
      rootObjectiveId: "obj_non_manager",
      topology: "dynamic_squad",
      budget: { max_workers: 2, max_tasks: 4 }
    }).run;
    teamRuns.transitionRun(nonManager.id, "planning", "bot_manager");
    const foreign = spawn(teamRuns, nonManager.id, "Foreign Worker");
    teamRuns.transitionRun(nonManager.id, "running", "bot_manager");
    assert.throws(
      () => manager.schedule({ runId: nonManager.id, workerId: foreign.worker.id, actorId: "bot_manager" }),
      /not manager/
    );

    const managerRun = createManagerRun(teamRuns);
    const local = spawn(teamRuns, managerRun.id, "Local Worker");
    teamRuns.transitionRun(managerRun.id, "running", "bot_manager");
    assert.throws(
      () => manager.schedule({ runId: managerRun.id, workerId: local.worker.id, actorId: "bot_intruder" }),
      /Only Manager Team Run leader/
    );
    assert.throws(
      () => manager.schedule({ runId: managerRun.id, workerId: foreign.worker.id, actorId: "bot_manager" }),
      /outside Manager Team Run/
    );
  } finally {
    queue.close();
    store.close();
  }
});

test("queued manager specialist survives restart and supervisor resumes the same Worker", async () => {
  const dbPath = `/tmp/ai-verse-manager-restart-${Date.now()}-${Math.random()}.db`;
  let runId = "";
  let workerId = "";
  let taskId = "";
  {
    const { store, queue, teamRuns, manager } = setup(dbPath);
    const run = createManagerRun(teamRuns);
    runId = run.id;
    const specialist = spawn(teamRuns, run.id, "Restart Specialist");
    workerId = specialist.worker.id;
    taskId = specialist.task.id;
    teamRuns.transitionRun(run.id, "running", "bot_manager");
    manager.schedule({ runId: run.id, workerId, actorId: "bot_manager" });
    assert.equal(queue.getByItem(taskId)?.state, "queued");
    queue.close();
    store.close();
  }

  const service = createGatewayServer({ dbPath, port: 0 });
  await service.listen();
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.supervisor.waitForIdle();
    assert.equal(service.store.getObject(taskId)?.payload.status, "completed");
    assert.equal(service.store.getObject(workerId)?.payload.status, "completed");
    assert.equal((service.managerTopology.getState(runId) as any).active_worker_id, null);
    const runEvents = service.store.listRunEvents(runId);
    assert.ok(runEvents.some((entry) => entry.event.type === "manager.specialist_scheduled"));
    assert.ok(runEvents.some((entry) => entry.event.type === "manager.specialist_completed"));
  } finally {
    await service.close();
  }
});

test("HTTP manager endpoint schedules an existing temporary Worker without bypassing canonical execution", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", bot())).status, 201);
    const created = await httpJson(address.port, "POST", "/v1/team-runs", {
      createdBy: "bot_manager",
      leaderId: "bot_manager",
      workspaceId: "ws_manager",
      rootObjectiveId: "obj_http_manager",
      topology: "manager",
      budget: { max_workers: 2, max_tasks: 4 }
    });
    assert.equal(created.status, 201);
    const runId = created.body.run.id;
    assert.equal((await httpJson(address.port, "POST", `/v1/team-runs/${runId}/transition`, { actorId: "bot_manager", status: "planning" })).status, 200);
    const worker = await httpJson(address.port, "POST", `/v1/team-runs/${runId}/workers`, {
      createdBy: "bot_manager",
      role: { title: "HTTP Specialist", objective: "Execute only after manager scheduling" }
    });
    assert.equal(worker.status, 201);
    assert.equal(service.executionQueue.getByItem(worker.body.task.id), null);
    assert.equal((await httpJson(address.port, "POST", `/v1/team-runs/${runId}/transition`, { actorId: "bot_manager", status: "running" })).status, 200);

    const scheduled = await httpJson(address.port, "POST", `/v1/team-runs/${runId}/manager/schedule`, {
      actorId: "bot_manager",
      workerId: worker.body.worker.id
    });
    assert.equal(scheduled.status, 202);
    assert.equal(scheduled.body.task.payload.status, "assigned");
    await service.supervisor.waitForIdle();
    assert.equal(service.store.getObject(worker.body.task.id)?.payload.status, "completed");

    const managerState = await httpJson(address.port, "GET", `/v1/team-runs/${runId}/manager`);
    assert.equal(managerState.status, 200);
    assert.equal(managerState.body.state.active_worker_id, null);
  } finally {
    await service.close();
  }
});

test("Worker inherits safe runtime handles but raw leader runtime credentials cannot propagate", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  const safe = bot("bot_safe_runtime");
  safe.runtime = {
    adapter: "openai-compatible",
    endpoint: "https://model.example.test/v1/chat/completions",
    model: "mock-model",
    api_key_env: "SAFE_HANDLE"
  };
  gateway.createBot(safe);
  const teamRuns = new TeamRunCoordinator(store, gateway, policy);
  try {
    const run = teamRuns.createRun({
      createdBy: "bot_safe_runtime",
      leaderId: "bot_safe_runtime",
      workspaceId: "ws_manager",
      rootObjectiveId: "obj_safe_runtime",
      topology: "manager",
      budget: { max_workers: 1, max_tasks: 2 }
    }).run;
    teamRuns.transitionRun(run.id, "planning", "bot_safe_runtime");
    const worker = teamRuns.spawnWorker({
      runId: run.id,
      createdBy: "bot_safe_runtime",
      role: { title: "Model Specialist", objective: "Use inherited safe runtime configuration" }
    }).worker;
    assert.equal((worker.payload.runtime as any).adapter, "openai-compatible");
    assert.equal((worker.payload.runtime as any).endpoint, "https://model.example.test/v1/chat/completions");
    assert.equal((worker.payload.runtime as any).model, "mock-model");
    assert.equal((worker.payload.runtime as any).api_key_env, "SAFE_HANDLE");
    assert.equal((worker.payload.runtime as any).api_key, undefined);

    const unsafe = bot("bot_unsafe_runtime");
    unsafe.runtime = { adapter: "openai-compatible", endpoint: "https://model.example.test/v1", model: "x", api_key: "never-copy" } as any;
    gateway.createBot(unsafe);
    const unsafeRun = teamRuns.createRun({
      createdBy: "bot_unsafe_runtime",
      leaderId: "bot_unsafe_runtime",
      workspaceId: "ws_manager",
      rootObjectiveId: "obj_unsafe_runtime",
      topology: "manager",
      budget: { max_workers: 1, max_tasks: 2 }
    }).run;
    teamRuns.transitionRun(unsafeRun.id, "planning", "bot_unsafe_runtime");
    assert.throws(() => teamRuns.spawnWorker({
      runId: unsafeRun.id,
      createdBy: "bot_unsafe_runtime",
      role: { title: "Unsafe", objective: "Must not inherit a raw credential" }
    }), /Raw runtime credential api_key is forbidden/);
  } finally {
    queue.close();
    store.close();
  }
});
