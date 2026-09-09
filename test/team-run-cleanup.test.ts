import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";
import { constraintsDigest } from "../src/constraints.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import { TeamRunCleanup } from "../src/team-run-cleanup.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest, JsonObject, StoredObject } from "../src/types.js";

const WORKSPACE = "ws_cleanup";
const ROOT = "obj_cleanup";

function bot(id: string, workspaceId = WORKSPACE): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: "Team Lead", mission: "Own bounded cleanup-safe work." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace", environment_ref: "host-default" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: ["*"],
      allowed_tools: ["*"],
      allowed_connections: ["*"],
      can_create_workers: true
    },
    coordination: { default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture(dbPath = ":memory:") {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(dbPath);
  const gateway = new CoordinationGateway(store, queue);
  gateway.createBot(bot("bot_leader"));
  const teams = new TeamRunCoordinator(store);
  const cleanup = new TeamRunCleanup(teams, gateway, queue);
  return { store, queue, gateway, teams, cleanup };
}

function createRunningRun(teams: TeamRunCoordinator, maxWorkers = 4): StoredObject {
  const run = teams.createRun({
    leaderId: "bot_leader",
    workspaceId: WORKSPACE,
    rootObjectiveId: ROOT,
    objective: "Prove cleanup preserves canonical evidence while removing transient authority.",
    topology: "dynamic_squad",
    budget: { max_workers: maxWorkers, max_tasks: 20, max_actions: 30 }
  }).run;
  teams.transitionRun(run.id, "planning", "bot_leader", "Plan test run");
  return teams.transitionRun(run.id, "running", "bot_leader", "Run test work").run;
}

function capabilityLease(id: string, taskId: string, issuedTo: string): JsonObject {
  return {
    schema_version: "1.0",
    id,
    type: "capability_lease",
    principal: "bot_leader",
    issued_to: issuedTo,
    workspace_id: WORKSPACE,
    task_id: taskId,
    tools: [],
    connections: [],
    destructive_actions: "deny",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  };
}

function taskPayload(input: {
  id: string;
  runId: string;
  assigneeId: string;
  leaseId: string;
  status?: string;
  environmentLeaseId?: string | null;
  rootObjectiveId?: string;
}): JsonObject {
  return {
    schema_version: "1.0",
    id: input.id,
    type: "task.delegate",
    created_by: "bot_leader",
    assignee_id: input.assigneeId,
    owner_id: input.assigneeId,
    workspace_id: WORKSPACE,
    run_id: input.runId,
    root_objective_id: input.rootObjectiveId ?? ROOT,
    parent_task_id: null,
    reason: "Cleanup acceptance task",
    objective: "Produce bounded evidence.",
    required_constraints: [],
    constraints_digest: constraintsDigest([]),
    expected_output: { contract: "structured_result" },
    input_artifact_refs: [],
    lease_id: input.leaseId,
    environment_lease_id: input.environmentLeaseId ?? null,
    response_target: { kind: "bot", id: "bot_leader" },
    deadline_at: null,
    budget: {},
    hop: 0,
    max_hops: 6,
    recovery_policy: "retry_safe",
    max_attempts: 2,
    status: input.status ?? "assigned"
  };
}

function discussionLifecycle(openingId: string, reservedAt: string): JsonObject {
  return {
    origin: "discussion_setup",
    discussion_opening_id: openingId,
    discussion_opening_reserved_at: reservedAt
  };
}

function completeWorkerTask(env: ReturnType<typeof fixture>, run: StoredObject, workerId: string, taskId: string, leaseId: string) {
  const worker = env.teams.createWorker({
    runId: run.id,
    createdBy: "bot_leader",
    workerId,
    roleTitle: "Cleanup Worker",
    objective: "Create evidence that must remain auditable."
  }).worker;
  env.gateway.record("capability_lease", capabilityLease(leaseId, taskId, worker.id));
  const task = env.gateway.record("task", taskPayload({ id: taskId, runId: run.id, assigneeId: worker.id, leaseId }));
  env.teams.attachWorkerTask(worker.id, task.id, "bot_leader");
  env.teams.transitionWorker(worker.id, "running", "bot_leader", "Execute cleanup test task");
  env.gateway.record("task", { ...task.payload, status: "completed", completed_at: new Date().toISOString(), output_artifact_refs: [] });
  env.teams.transitionWorker(worker.id, "completed", "bot_leader", "Worker completed before cleanup");
  return { worker: env.teams.getWorker(worker.id)!, task: env.gateway.store.getObject(task.id)! };
}

function completeRun(teams: TeamRunCoordinator, runId: string): StoredObject {
  teams.transitionRun(runId, "synthesizing", "bot_leader", "Prepare terminal run");
  return teams.transitionRun(runId, "completed", "bot_leader", "Terminal cleanup fixture").run;
}

function forceRunStatus(store: CoordinationStore, run: StoredObject, status: string): StoredObject {
  return store.putObject("team_run", {
    ...run.payload,
    status,
    terminal_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
}

function cleanupFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(path, { force: true });
}

test("terminal cleanup expires temporary identity, revokes capability authority, cancels residual execution, and preserves evidence", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env.teams);
    const { worker, task } = completeWorkerTask(env, run, "worker_cleanup_a", "task_cleanup_a", "lease_cleanup_a");
    const artifact = env.gateway.record("artifact", {
      schema_version: "1.0",
      id: "art_cleanup_a",
      type: "artifact",
      workspace_id: WORKSPACE,
      created_by: worker.id,
      run_id: run.id,
      task_id: task.id,
      kind: "cleanup_evidence",
      version: 1,
      content_ref: null,
      inline_content: { result: "preserve me" },
      provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] }
    });
    env.queue.enqueueTask(task.id, worker.id, WORKSPACE, { recoveryPolicy: "retry_safe", maxAttempts: 2 });
    completeRun(env.teams, run.id);

    const result = env.cleanup.cleanupRun(run.id, "bot_leader");
    assert.equal(result.status, "completed");
    assert.equal(env.teams.getWorker(worker.id)!.payload.status, "expired");
    assert.equal(env.gateway.store.getObject("lease_cleanup_a")!.payload.cleanup_run_id, run.id);
    assert.ok(Date.parse(String(env.gateway.store.getObject("lease_cleanup_a")!.payload.expires_at)) <= Date.now());
    assert.equal(env.queue.getByItem(task.id)!.state, "canceled");
    assert.equal(env.gateway.store.getObject(artifact.id)!.id, artifact.id);
    assert.equal(env.gateway.getBot("bot_leader")!.payload.status, "active");
    assert.ok(result.summary.preserved_artifact_refs.includes(artifact.id));
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("cleanup revokes run-exclusive environment leases but preserves an environment still referenced by another Team Run", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env.teams);
    const other = createRunningRun(env.teams);
    for (const envLease of [
      { id: "env_local", taskId: "task_env_local" },
      { id: "env_shared", taskId: null }
    ]) {
      env.gateway.record("environment_lease", {
        schema_version: "1.0",
        id: envLease.id,
        type: "environment_lease",
        issued_to: "bot_leader",
        workspace_id: WORKSPACE,
        environment_policy: "shared_workspace",
        environment_ref: `workspace:${WORKSPACE}`,
        ...(envLease.taskId ? { task_id: envLease.taskId } : {}),
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      });
    }
    env.gateway.record("capability_lease", capabilityLease("lease_env_local", "task_env_local", "bot_leader"));
    env.gateway.record("task", taskPayload({ id: "task_env_local", runId: run.id, assigneeId: "bot_leader", leaseId: "lease_env_local", status: "completed", environmentLeaseId: "env_local" }));
    env.gateway.record("capability_lease", capabilityLease("lease_env_shared", "task_env_shared", "bot_leader"));
    env.gateway.record("task", taskPayload({ id: "task_env_shared", runId: run.id, assigneeId: "bot_leader", leaseId: "lease_env_shared", status: "completed", environmentLeaseId: "env_shared" }));
    env.gateway.record("capability_lease", capabilityLease("lease_env_other", "task_env_other", "bot_leader"));
    env.gateway.record("task", taskPayload({ id: "task_env_other", runId: other.id, assigneeId: "bot_leader", leaseId: "lease_env_other", status: "completed", environmentLeaseId: "env_shared" }));
    completeRun(env.teams, run.id);

    const result = env.cleanup.cleanupRun(run.id, "bot_leader");
    assert.equal(env.gateway.store.getObject("env_local")!.payload.cleanup_run_id, run.id);
    assert.equal(env.gateway.store.getObject("env_shared")!.payload.cleanup_revoked_at, undefined);
    assert.ok(result.summary.environment_lease_ids_revoked.includes("env_local"));
    assert.ok(result.summary.shared_environment_lease_ids_preserved.includes("env_shared"));
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("cleanup closes temporary Room and Thread while preserving their Message and Artifact audit graph", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env.teams);
    const room = env.gateway.record("room", {
      schema_version: "1.0",
      id: "room_cleanup",
      name: "Temporary cleanup discussion",
      status: "active",
      temporary: true,
      run_id: run.id,
      scope: { type: "workspace", workspace_id: WORKSPACE },
      members: ["bot_leader"],
      orchestration: { mode: "review", leader: "bot_leader" },
      discussion: { status: "open", run_id: run.id, root_objective_id: ROOT, participant_ids: [], current_task_id: null }
    });
    const message = env.gateway.publishRoomMessage({ senderId: "bot_leader", roomId: room.id, workspaceId: WORKSPACE, text: "Preserve this transcript." }).message;
    const thread = env.gateway.record("thread", {
      schema_version: "1.0",
      id: "thread_cleanup",
      type: "thread",
      workspace_id: WORKSPACE,
      room_id: room.id,
      bot_conversation_id: null,
      parent_message_id: message.id,
      created_by: "bot_leader",
      status: "active"
    });
    const artifact = env.gateway.record("artifact", {
      schema_version: "1.0",
      id: "art_cleanup_room",
      type: "artifact",
      workspace_id: WORKSPACE,
      created_by: "bot_leader",
      run_id: run.id,
      task_id: null,
      kind: "discussion_candidate",
      version: 1,
      content_ref: null,
      inline_content: { result: "candidate" },
      provenance: { origin: "bot_generated", trusted_instruction: false, source_refs: [] }
    });
    env.teams.transitionRun(run.id, "canceled", "bot_leader", "End fixture");

    env.cleanup.cleanupRun(run.id, "bot_leader");
    assert.equal(env.gateway.store.getObject(room.id)!.payload.status, "closed");
    assert.equal(env.gateway.store.getObject(thread.id)!.payload.status, "closed");
    assert.equal(env.gateway.store.getObject(message.id)!.id, message.id);
    assert.equal(env.gateway.store.getObject(artifact.id)!.id, artifact.id);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("terminal cleanup is idempotent and emits one canonical completion event", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env.teams);
    env.teams.transitionRun(run.id, "canceled", "bot_leader", "End fixture");
    const first = env.cleanup.cleanupRun(run.id, "bot_leader");
    const second = env.cleanup.cleanupRun(run.id, "bot_leader");
    assert.equal(first.status, "completed");
    assert.equal(second.status, "already_clean");
    const events = env.store.listEventsAfter(0, 1000).filter((event) => event.event.type === "team_run.cleanup_completed" && event.event.run_id === run.id);
    assert.equal(events.length, 1);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("cleanup refuses a nonterminal Team Run without mutating it", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env.teams);
    assert.throws(() => env.cleanup.cleanupRun(run.id, "bot_leader"), /while status is running/);
    assert.equal(env.teams.getRun(run.id)!.payload.cleanup_status, undefined);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("inconsistent terminal state with live Worker remains blocked and operator-visible", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env.teams);
    const worker = env.teams.createWorker({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_cleanup_live",
      roleTitle: "Live Worker",
      objective: "Remain live to prove cleanup fails closed."
    }).worker;
    forceRunStatus(env.store, env.teams.getRun(run.id)!, "canceled");

    const result = env.cleanup.cleanupRun(run.id, "operator_cleanup");
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.blocker_ids, [worker.id]);
    assert.equal(env.teams.getWorker(worker.id)!.payload.status, "created");
    assert.equal(env.store.listEventsAfter(0, 1000).filter((event) => event.event.type === "team_run.cleanup_blocked").length, 1);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("stale tagged discussion setup is reaped exactly, unrelated Workers survive, and capacity is freed", () => {
  const env = fixture();
  try {
    let run = createRunningRun(env.teams, 3);
    const staleAt = Date.now() - 10 * 60 * 1000;
    const reservedAt = new Date(staleAt).toISOString();
    run = env.store.putObject("team_run", {
      ...run.payload,
      discussion_opening_id: "room_stale_setup",
      discussion_opening_reserved_at: reservedAt,
      updated_at: reservedAt
    });
    const one = env.teams.createWorker({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_stale_one",
      roleTitle: "Speaker One",
      objective: "Never activated.",
      lifecycle: discussionLifecycle("room_stale_setup", reservedAt)
    }).worker;
    const two = env.teams.createWorker({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_stale_two",
      roleTitle: "Speaker Two",
      objective: "Never activated.",
      lifecycle: discussionLifecycle("room_stale_setup", reservedAt)
    }).worker;
    const unrelated = env.teams.createWorker({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_unrelated_during_reservation",
      roleTitle: "Independent Worker",
      objective: "Remain outside abandoned discussion setup."
    }).worker;
    assert.equal((one.payload.lifecycle as JsonObject).discussion_opening_id, "room_stale_setup");
    assert.equal((two.payload.lifecycle as JsonObject).discussion_opening_id, "room_stale_setup");
    assert.equal(unrelated.payload.lifecycle, undefined);

    const reaped = env.cleanup.reapStaleDiscussionOpenings({ now: Date.now(), olderThanMs: 60_000, actorId: "operator_cleanup" });
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0]!.status, "reaped");
    assert.deepEqual(new Set(reaped[0]!.expiredWorkerIds), new Set([one.id, two.id]));
    assert.equal(env.teams.getWorker(one.id)!.payload.status, "expired");
    assert.equal(env.teams.getWorker(two.id)!.payload.status, "expired");
    assert.equal(env.teams.getWorker(unrelated.id)!.payload.status, "created");
    assert.equal(env.teams.getRun(run.id)!.payload.discussion_opening_id, null);

    const replacement = env.teams.createWorker({ runId: run.id, createdBy: "bot_leader", workerId: "worker_after_reap", roleTitle: "Replacement", objective: "Use released Worker capacity." }).worker;
    assert.equal(replacement.payload.status, "created");
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("fresh discussion setup reservation is not reaped", () => {
  const env = fixture();
  try {
    let run = createRunningRun(env.teams, 2);
    const reservedAt = Date.now();
    const reservedAtIso = new Date(reservedAt).toISOString();
    run = env.store.putObject("team_run", {
      ...run.payload,
      discussion_opening_id: "room_fresh_setup",
      discussion_opening_reserved_at: reservedAtIso,
      updated_at: reservedAtIso
    });
    const worker = env.teams.createWorker({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_fresh_setup",
      roleTitle: "Fresh Speaker",
      objective: "Still being prepared.",
      lifecycle: discussionLifecycle("room_fresh_setup", reservedAtIso)
    }).worker;
    const reaped = env.cleanup.reapStaleDiscussionOpenings({ now: reservedAt + 30_000, olderThanMs: 60_000, actorId: "operator_cleanup" });
    assert.equal(reaped.length, 0);
    assert.equal(env.teams.getWorker(worker.id)!.payload.status, "created");
    assert.equal(env.teams.getRun(run.id)!.payload.discussion_opening_id, "room_fresh_setup");
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("stale discussion reservation with task-bound participant fails closed instead of expiring live work", () => {
  const env = fixture();
  try {
    let run = createRunningRun(env.teams, 2);
    const staleAt = Date.now() - 10 * 60 * 1000;
    const reservedAt = new Date(staleAt).toISOString();
    run = env.store.putObject("team_run", {
      ...run.payload,
      discussion_opening_id: "room_stale_bound",
      discussion_opening_reserved_at: reservedAt,
      updated_at: reservedAt
    });
    const worker = env.teams.createWorker({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_stale_bound",
      roleTitle: "Bound Speaker",
      objective: "Has real work now.",
      lifecycle: discussionLifecycle("room_stale_bound", reservedAt)
    }).worker;
    env.gateway.record("capability_lease", capabilityLease("lease_stale_bound", "task_stale_bound", worker.id));
    env.gateway.record("task", taskPayload({ id: "task_stale_bound", runId: run.id, assigneeId: worker.id, leaseId: "lease_stale_bound" }));
    env.teams.attachWorkerTask(worker.id, "task_stale_bound", "bot_leader");

    const reaped = env.cleanup.reapStaleDiscussionOpenings({ now: Date.now(), olderThanMs: 60_000, actorId: "operator_cleanup" });
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0]!.status, "blocked");
    assert.deepEqual(reaped[0]!.blockerIds, [worker.id]);
    assert.equal(env.teams.getWorker(worker.id)!.payload.status, "ready");
    assert.equal(env.teams.getRun(run.id)!.payload.discussion_opening_id, "room_stale_bound");
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("supervisor startup recovers terminal cleanup and stale discussion setup after database reopen", async () => {
  const dbPath = `/tmp/aiverse-cleanup-${randomUUID()}.db`;
  cleanupFiles(dbPath);
  let first: ReturnType<typeof fixture> | null = fixture(dbPath);
  let supervisor: ExecutionSupervisor | null = null;
  try {
    const terminalRun = createRunningRun(first.teams, 2);
    const terminalWorker = first.teams.createWorker({ runId: terminalRun.id, createdBy: "bot_leader", workerId: "worker_restart_terminal", roleTitle: "Terminal Worker", objective: "Be canceled with the run." }).worker;
    first.teams.transitionRun(terminalRun.id, "canceled", "bot_leader", "Persist terminal state before restart");

    let activeRun = createRunningRun(first.teams, 2);
    const staleAt = Date.now() - 10 * 60 * 1000;
    const reservedAt = new Date(staleAt).toISOString();
    activeRun = first.store.putObject("team_run", {
      ...activeRun.payload,
      discussion_opening_id: "room_restart_stale",
      discussion_opening_reserved_at: reservedAt,
      updated_at: reservedAt
    });
    const staleWorker = first.teams.createWorker({
      runId: activeRun.id,
      createdBy: "bot_leader",
      workerId: "worker_restart_stale",
      roleTitle: "Stale Speaker",
      objective: "Never activated before crash.",
      lifecycle: discussionLifecycle("room_restart_stale", reservedAt)
    }).worker;
    first.queue.close();
    first.store.close();
    first = null;

    const store = new CoordinationStore(dbPath);
    const queue = new ExecutionQueue(dbPath);
    const gateway = new CoordinationGateway(store, queue);
    const runtimes = new RuntimeRegistry().register(new DeterministicRuntimeAdapter());
    const runner = new BotRunner(store, gateway, queue, runtimes);
    supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
    supervisor.start();
    await supervisor.waitForIdle();

    assert.equal(store.getObject(terminalWorker.id)!.payload.status, "expired");
    assert.equal(store.getObject(terminalRun.id)!.payload.cleanup_status, "completed");
    assert.equal(store.getObject(staleWorker.id)!.payload.status, "expired");
    assert.equal(store.getObject(activeRun.id)!.payload.discussion_opening_id, null);

    await supervisor.stop();
    supervisor = null;
    queue.close();
    store.close();

    const reopened = new CoordinationStore(dbPath);
    try {
      assert.equal(reopened.getObject(terminalWorker.id)!.payload.status, "expired");
      assert.equal(reopened.getObject(staleWorker.id)!.payload.status, "expired");
    } finally {
      reopened.close();
    }
  } finally {
    if (supervisor) await supervisor.stop();
    if (first) {
      first.queue.close();
      first.store.close();
    }
    cleanupFiles(dbPath);
  }
});

test("an unresolved Handoff attached to a terminal Team Run blocks cleanup instead of being silently rewritten", () => {
  const env = fixture();
  try {
    env.gateway.createBot(bot("bot_peer"));
    const run = createRunningRun(env.teams);
    env.gateway.record("capability_lease", capabilityLease("lease_handoff_cleanup", "task_handoff_cleanup", "bot_leader"));
    const task = env.gateway.record("task", taskPayload({ id: "task_handoff_cleanup", runId: run.id, assigneeId: "bot_leader", leaseId: "lease_handoff_cleanup" }));
    const handoff = env.gateway.requestHandoff({
      sourceOwnerId: "bot_leader",
      targetOwnerId: "bot_peer",
      workspaceId: WORKSPACE,
      workItemId: task.id,
      rootObjectiveId: ROOT,
      reason: "Leave this handoff unresolved to prove cleanup blocks.",
      returnPolicy: "return_on_completion"
    }).handoff;
    env.gateway.record("task", { ...task.payload, status: "canceled", canceled_at: new Date().toISOString() });
    forceRunStatus(env.store, env.teams.getRun(run.id)!, "canceled");

    const result = env.cleanup.cleanupRun(run.id, "operator_cleanup");
    assert.equal(result.status, "blocked");
    assert.ok(result.blocker_ids.includes(handoff.id));
    assert.equal(env.gateway.store.getObject(handoff.id)!.payload.status, "requested");
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("stale pending Approval on an already-terminal Task becomes non-actionable while its audit record is preserved", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env.teams);
    const delegated = env.gateway.delegate({
      createdBy: "bot_leader",
      assigneeId: "bot_leader",
      workspaceId: WORKSPACE,
      rootObjectiveId: ROOT,
      objective: "Approval residue cleanup",
      reason: "Require approval",
      approval: { required: true, action: { kind: "test.approval" } }
    });
    assert.ok(delegated.approval);
    env.gateway.record("task", {
      ...delegated.task.payload,
      run_id: run.id,
      status: "canceled",
      canceled_at: new Date().toISOString(),
      cancellation_reason: "Run terminated before approval"
    });
    forceRunStatus(env.store, env.teams.getRun(run.id)!, "canceled");

    const result = env.cleanup.cleanupRun(run.id, "operator_cleanup");
    const approval = env.gateway.store.getObject(delegated.approval!.id)!;
    assert.equal(result.status, "completed");
    assert.equal(approval.payload.status, "canceled");
    assert.equal(approval.payload.cleanup_run_id, run.id);
    assert.ok((result.summary as unknown as JsonObject).approval_ids_canceled instanceof Array);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("cleanup cancels live mailbox deliveries targeting expired temporary Workers while preserving Message audit", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env.teams);
    const worker = env.teams.createWorker({ runId: run.id, createdBy: "bot_leader", workerId: "worker_mail_cleanup", roleTitle: "Mailbox Worker", objective: "Receive one queued message." }).worker;
    const sent = env.gateway.sendMessage({ senderId: "bot_leader", targetKind: "worker", targetId: worker.id, workspaceId: WORKSPACE, text: "Do not leave this delivery actionable after cleanup." });
    assert.equal(env.store.listMailbox(worker.id, ["queued"])[0]!.messageId, sent.message.id);
    env.teams.transitionRun(run.id, "canceled", "bot_leader", "End run before delivery is processed");

    const result = env.cleanup.cleanupRun(run.id, "bot_leader");
    const delivery = env.store.listMailbox(worker.id, ["canceled"])[0];
    assert.ok(delivery);
    assert.equal(delivery!.messageId, sent.message.id);
    assert.equal(env.gateway.store.getObject(sent.message.id)!.id, sent.message.id);
    assert.ok((result.summary as unknown as JsonObject).delivery_message_ids_canceled instanceof Array);
  } finally {
    env.queue.close();
    env.store.close();
  }
});
