import assert from "node:assert/strict";
import test from "node:test";
import { BudgetError } from "../src/budget.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest, JsonObject } from "../src/types.js";

function bot(id: string, workspaceId = "ws_phase2", canCreateWorkers = true): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: "Team Lead", mission: "Own bounded coordinated work." },
    runtime: { adapter: "native" },
    execution: { environment_policy: "shared_workspace", environment_ref: "host-default" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: ["*"],
      can_create_workers: canCreateWorkers
    },
    coordination: { default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
  };
}

function workerTask(id: string, workerId: string, workspaceId = "ws_phase2"): JsonObject {
  return {
    schema_version: "1.0",
    id,
    type: "task.delegate",
    created_by: "bot_leader",
    assignee_id: workerId,
    owner_id: workerId,
    workspace_id: workspaceId,
    root_objective_id: "obj_phase2",
    reason: "Bound Team Run assignment",
    objective: "Produce one bounded contribution.",
    required_constraints: ["Do not publish externally"],
    expected_output: { contract: "structured_result" },
    lease_id: "lease_phase2",
    status: "assigned"
  };
}

test("Team Run creation requires an active durable leader in the same workspace", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot("bot_leader"));
  const teams = new TeamRunCoordinator(store);

  const created = teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_phase2",
    rootObjectiveId: "obj_phase2",
    objective: "Research three independent implementation options.",
    topology: "dynamic_squad",
    budget: { max_workers: 3, token_limit: 10000 }
  });

  assert.equal(created.run.kind, "team_run");
  assert.equal(created.run.payload.status, "created");
  assert.equal(created.run.payload.leader_id, "bot_leader");
  assert.deepEqual(created.run.payload.participant_ids, ["bot_leader"]);
  assert.equal(created.event.event.type, "team_run.created");
  assert.equal(created.event.event.run_id, created.run.id);
  assert.throws(() => teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_other",
    rootObjectiveId: "obj_other"
  }), /outside workspace/);
  assert.throws(() => teams.createRun({
    leaderId: "worker_not-a-bot",
    workspaceId: "ws_phase2",
    rootObjectiveId: "obj_other"
  }), /must be a durable Bot/);
  store.close();
});

test("temporary Workers remain run-scoped and max_workers is enforced", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot("bot_leader"));
  const teams = new TeamRunCoordinator(store);
  const run = teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_phase2",
    rootObjectiveId: "obj_phase2",
    budget: { max_workers: 1 }
  }).run;

  const created = teams.createWorker({
    runId: run.id,
    createdBy: "bot_leader",
    workerId: "worker_source-auditor",
    roleTitle: "Source Auditor",
    objective: "Independently verify the primary sources."
  });

  assert.equal(created.worker.kind, "worker");
  assert.equal(created.worker.payload.kind, "temporary");
  assert.equal(created.worker.payload.status, "created");
  assert.equal(created.worker.payload.run_id, run.id);
  assert.equal(created.worker.payload.task_id, null);
  assert.equal("memory" in created.worker.payload, false);
  assert.equal("room_id" in created.worker.payload, false);
  assert.ok((created.run.payload.participant_ids as unknown[]).includes("worker_source-auditor"));
  assert.throws(
    () => teams.transitionWorker("worker_source-auditor", "ready", "bot_leader"),
    /without a bound Task/
  );
  assert.throws(
    () => teams.createWorker({
      runId: run.id,
      createdBy: "bot_leader",
      roleTitle: "Second Worker",
      objective: "Should exceed the run budget."
    }),
    (error: unknown) => error instanceof BudgetError && error.code === "WORKER_BUDGET_EXCEEDED"
  );
  store.close();
});

test("Worker Task binding unlocks the bounded lifecycle and terminal cleanup", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot("bot_leader"));
  const teams = new TeamRunCoordinator(store);
  const run = teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_phase2",
    rootObjectiveId: "obj_phase2",
    budget: { max_workers: 2, token_limit: 5000 }
  }).run;
  teams.createWorker({
    runId: run.id,
    createdBy: "bot_leader",
    workerId: "worker_verifier",
    roleTitle: "Verifier",
    objective: "Verify the candidate answer.",
    budget: { token_limit: 2000 }
  });
  store.putObject("task", workerTask("task_worker-verifier", "worker_verifier"));

  const bound = teams.attachWorkerTask("worker_verifier", "task_worker-verifier", "bot_leader");
  assert.equal(bound.worker.payload.status, "ready");
  assert.equal(bound.worker.payload.task_id, "task_worker-verifier");
  assert.equal(bound.event.event.type, "worker.task_bound");

  teams.transitionRun(run.id, "running", "bot_leader");
  assert.equal(teams.transitionWorker("worker_verifier", "running", "bot_leader").worker.payload.status, "running");
  assert.equal(teams.transitionWorker("worker_verifier", "waiting", "bot_leader").worker.payload.status, "waiting");
  assert.equal(teams.transitionWorker("worker_verifier", "running", "bot_leader").worker.payload.status, "running");
  assert.equal(teams.transitionWorker("worker_verifier", "completed", "bot_leader").worker.payload.status, "completed");

  teams.transitionRun(run.id, "synthesizing", "bot_leader");
  assert.equal(teams.transitionRun(run.id, "completed", "bot_leader").run.payload.status, "completed");
  const cleaned = teams.cleanupWorkers(run.id, "bot_leader");
  assert.equal(cleaned.workers.length, 1);
  assert.equal(cleaned.workers[0]!.payload.status, "expired");
  assert.equal(cleaned.events[0]!.event.type, "worker.expired");
  assert.throws(() => teams.transitionWorker("worker_verifier", "running", "bot_leader"), /Invalid Worker transition/);
  store.close();
});

test("canceling a Team Run atomically cancels active Workers before expiry cleanup", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot("bot_leader"));
  const teams = new TeamRunCoordinator(store);
  const run = teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_phase2",
    rootObjectiveId: "obj_phase2",
    budget: { max_workers: 2 }
  }).run;
  teams.createWorker({
    runId: run.id,
    createdBy: "bot_leader",
    workerId: "worker_cancel-me",
    roleTitle: "Temporary Researcher",
    objective: "Stop when the run stops."
  });

  const canceled = teams.transitionRun(run.id, "canceled", "bot_leader", "Operator stopped the objective");
  assert.equal(canceled.run.payload.status, "canceled");
  assert.equal(canceled.workers.length, 1);
  assert.equal(canceled.workers[0]!.payload.status, "canceled");
  assert.ok(canceled.events.some((event) => event.event.type === "worker.status_changed"));
  assert.throws(() => teams.createWorker({
    runId: run.id,
    createdBy: "bot_leader",
    roleTitle: "Late Worker",
    objective: "Must not be created."
  }), /terminal Team Run/);

  const cleaned = teams.cleanupWorkers(run.id, "bot_leader");
  assert.equal(cleaned.workers[0]!.payload.status, "expired");
  store.close();
});

test("only the Team Run leader can mutate a run and can_create_workers is enforced", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot("bot_leader", "ws_phase2", false));
  gateway.createBot(bot("bot_peer"));
  const teams = new TeamRunCoordinator(store);
  const run = teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_phase2",
    rootObjectiveId: "obj_phase2"
  }).run;

  assert.throws(() => teams.createWorker({
    runId: run.id,
    createdBy: "bot_leader",
    roleTitle: "Denied Worker",
    objective: "Leader policy denies Worker creation."
  }), /not allowed to create temporary Workers/);
  assert.throws(() => teams.transitionRun(run.id, "running", "bot_peer"), /Only Team Run leader/);
  store.close();
});

test("Team Run and expired Worker audit state survive store restart", () => {
  const db = `/tmp/aiverse-teamrun-${Date.now()}-${Math.random()}.db`;
  let runId = "";
  {
    const store = new CoordinationStore(db);
    const gateway = new CoordinationGateway(store);
    gateway.createBot(bot("bot_leader"));
    const teams = new TeamRunCoordinator(store);
    const run = teams.createRun({
      leaderId: "bot_leader",
      workspaceId: "ws_phase2",
      rootObjectiveId: "obj_phase2",
      budget: { max_workers: 1 }
    }).run;
    runId = run.id;
    teams.createWorker({
      runId,
      createdBy: "bot_leader",
      workerId: "worker_persistent-audit",
      roleTitle: "Audit Worker",
      objective: "Prove run-scoped state survives restart."
    });
    teams.transitionRun(runId, "canceled", "bot_leader");
    teams.cleanupWorkers(runId, "bot_leader");
    store.close();
  }
  {
    const store = new CoordinationStore(db);
    const teams = new TeamRunCoordinator(store);
    assert.equal(teams.getRun(runId)?.payload.status, "canceled");
    assert.equal(teams.getWorker("worker_persistent-audit")?.payload.status, "expired");
    const runEvents = store.listEventsAfter(0).filter((event) => event.event.run_id === runId);
    assert.ok(runEvents.some((event) => event.event.type === "team_run.created"));
    assert.ok(runEvents.some((event) => event.event.type === "worker.created"));
    assert.ok(runEvents.some((event) => event.event.type === "worker.expired"));
    store.close();
  }
});
