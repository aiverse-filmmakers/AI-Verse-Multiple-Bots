import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import { TeamRunDiscussion } from "../src/team-run-discussion.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest } from "../src/types.js";

function bot(adapter = "deterministic"): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_leader",
    name: "Discussion Lead",
    kind: "durable",
    status: "active",
    role: { title: "Discussion Lead", mission: "Run bounded multi-agent discussion." },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_discussion" },
    permissions: {
      policy_ref: "strict",
      allowed_peers: ["*"],
      allowed_tools: [],
      allowed_connections: [],
      can_create_workers: true,
      can_handoff: true
    },
    coordination: { default_mode: "manager", max_parallel_workers: 2, max_hops: 6 }
  };
}

function fixture(runtime: RuntimeAdapter = new DeterministicRuntimeAdapter(), dbPath = `/tmp/aiverse-discussion-${randomUUID()}.db`, createBot = true) {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const gateway = new CoordinationGateway(store, queue);
  if (createBot) gateway.createBot(bot(runtime.id));
  const teams = new TeamRunCoordinator(store);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 50);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
  const discussion = new TeamRunDiscussion(teams, gateway, queue, runner);
  return { store, queue, gateway, teams, runner, supervisor, discussion };
}

function createRun(env: ReturnType<typeof fixture>, topology: "group_room" | "manager" | "dynamic_squad" | "hybrid" = "group_room", budget: Record<string, number> = { max_workers: 2, max_messages: 4, max_rounds: 2, max_tasks: 4, max_actions: 10 }) {
  return env.teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_discussion",
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Debate a bounded implementation choice.",
    topology,
    budget
  }).run;
}

function speakers() {
  return [
    { key: "builder", roleTitle: "Builder", objective: "Argue for the strongest implementation path.", workerId: "worker_discussion_builder" },
    { key: "skeptic", roleTitle: "Skeptic", objective: "Challenge assumptions and identify failure modes.", workerId: "worker_discussion_skeptic" }
  ];
}

async function closeFixture(env: ReturnType<typeof fixture>): Promise<void> {
  await env.supervisor.stop();
  env.queue.close();
  env.store.close();
}

test("group discussion uses a temporary Room while Workers stay outside durable Room membership and Bot registry", async () => {
  const env = fixture();
  try {
    const run = createRun(env);
    const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Choose a persistence strategy", speakers: speakers(), rounds: 2 });
    assert.deepEqual(opened.room.payload.members, ["bot_leader"]);
    assert.deepEqual(opened.room.payload.temporary_participant_ids, ["worker_discussion_builder", "worker_discussion_skeptic"]);
    assert.equal(opened.room.payload.temporary, true);
    assert.equal(opened.thread.payload.room_id, opened.room.id);
    assert.equal(env.gateway.getBot("worker_discussion_builder"), null);
    assert.equal(env.gateway.getBot("worker_discussion_skeptic"), null);
    assert.equal(opened.workers.length, 2);
    assert.equal(env.teams.listWorkers(run.id).length, 2);
    assert.equal(opened.firstTask?.payload.assignee_id, "worker_discussion_builder");
  } finally {
    await closeFixture(env);
  }
});

test("two temporary participants are reused across two rounds and produce four ordered candidate Artifacts", async () => {
  const env = fixture();
  try {
    const run = createRun(env);
    const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Compare two architectures", speakers: speakers(), rounds: 2, maxMessages: 4 });
    env.supervisor.start();
    await env.supervisor.waitForIdle();

    const room = env.discussion.get(opened.room.id);
    assert.equal(room?.payload.status, "closed");
    assert.equal((room?.payload.discussion as any)?.status, "completed");
    assert.equal(env.teams.listWorkers(run.id).length, 2);
    assert.equal(env.store.getObject("worker_discussion_builder")?.payload.status, "completed");
    assert.equal(env.store.getObject("worker_discussion_skeptic")?.payload.status, "completed");

    const tasks = env.store.listObjects("task", "ws_discussion")
      .filter((task) => task.payload.discussion_room_id === opened.room.id)
      .sort((a, b) => Number(a.payload.discussion_turn_index) - Number(b.payload.discussion_turn_index));
    assert.equal(tasks.length, 4);
    assert.deepEqual(tasks.map((task) => task.payload.assignee_id), [
      "worker_discussion_builder",
      "worker_discussion_skeptic",
      "worker_discussion_builder",
      "worker_discussion_skeptic"
    ]);
    assert.deepEqual(tasks.map((task) => task.payload.status), ["completed", "completed", "completed", "completed"]);

    const candidates = env.discussion.candidateArtifacts(opened.room.id);
    assert.equal(candidates.length, 4);
    assert.deepEqual(candidates.map((artifact) => artifact.payload.created_by), [
      "worker_discussion_builder",
      "worker_discussion_skeptic",
      "worker_discussion_builder",
      "worker_discussion_skeptic"
    ]);
    assert.equal(env.gateway.listBots("ws_discussion").length, 1);
  } finally {
    await closeFixture(env);
  }
});

test("later discussion turns receive prior candidate Artifacts as structured inputs", async () => {
  const env = fixture();
  try {
    const run = createRun(env);
    const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Iterative evidence review", speakers: speakers(), rounds: 2 });
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const tasks = env.store.listObjects("task", "ws_discussion")
      .filter((task) => task.payload.discussion_room_id === opened.room.id)
      .sort((a, b) => Number(a.payload.discussion_turn_index) - Number(b.payload.discussion_turn_index));
    assert.deepEqual(tasks.map((task) => (task.payload.input_artifact_refs as unknown[]).length), [0, 1, 2, 3]);
    const messages = env.store.listObjects("message", "ws_discussion")
      .filter((message) => message.payload.room_id === opened.room.id && Array.isArray(message.payload.artifact_refs) && message.payload.artifact_refs.length > 0);
    assert.equal(messages.length, 5); // four Worker candidate messages plus the leader's bounded completion message
    const workerMessages = messages.filter((message) => String(message.payload.sender_id).startsWith("worker_"));
    assert.equal(workerMessages.length, 4);
    assert.ok(workerMessages.every((message) => (message.payload.provenance as any)?.origin === "worker_generated"));
  } finally {
    await closeFixture(env);
  }
});

test("Team Run max_messages, max_rounds and max_tasks cap the requested discussion before work is scheduled", async () => {
  const env = fixture();
  try {
    const run = createRun(env, "group_room", { max_workers: 2, max_messages: 2, max_rounds: 1, max_tasks: 2, max_actions: 10 });
    const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "One bounded round", speakers: speakers(), rounds: 5, maxMessages: 20 });
    const state = opened.room.payload.discussion as any;
    assert.equal(state.max_rounds, 1);
    assert.equal(state.max_messages, 2);
    assert.equal(state.turn_plan.length, 2);
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    assert.equal(env.store.listObjects("task", "ws_discussion").filter((task) => task.payload.discussion_room_id === opened.room.id).length, 2);
  } finally {
    await closeFixture(env);
  }
});

test("discussion fails closed on topologies that do not justify group deliberation", async () => {
  const env = fixture();
  try {
    const run = createRun(env, "manager");
    assert.throws(
      () => env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Should not open", speakers: speakers() }),
      /does not justify group discussion/
    );
    assert.equal(env.teams.listWorkers(run.id).length, 0);
    assert.equal(env.discussion.list(run.id).length, 0);
  } finally {
    await closeFixture(env);
  }
});

class AbortableRuntime implements RuntimeAdapter {
  readonly id = "discussion-abortable";
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    this.startedResolve();
    return await new Promise<RuntimeExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ summary: "late", artifactKind: "late", output: { late: true }, usage: { actions: 1 } }), 5000);
      context.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(context.signal.reason instanceof Error ? context.signal.reason : new Error("aborted"));
      }, { once: true });
    });
  }
}

test("canceling an active discussion cancels the current Task and closes every temporary participant", async () => {
  const runtime = new AbortableRuntime();
  const env = fixture(runtime);
  try {
    const run = createRun(env);
    const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Cancel this debate", speakers: speakers(), rounds: 2 });
    env.supervisor.start();
    await runtime.started;
    const closed = await env.discussion.cancel(opened.room.id, "bot_leader", "Operator ended discussion");
    await env.supervisor.waitForIdle();
    assert.equal((closed.payload.discussion as any)?.status, "canceled");
    assert.equal(env.store.getObject(opened.firstTask!.id)?.payload.status, "canceled");
    assert.ok(env.teams.listWorkers(run.id).every((worker) => ["canceled", "completed", "failed"].includes(String(worker.payload.status))));
    assert.equal(env.discussion.candidateArtifacts(opened.room.id).length, 0);
  } finally {
    await closeFixture(env);
  }
});

test("restart after a completed but unreconciled turn resumes at the next turn without duplicating completed work", async () => {
  const dbPath = `/tmp/aiverse-discussion-restart-${randomUUID()}.db`;
  let roomId = "";
  let firstTaskId = "";
  {
    const env = fixture(new DeterministicRuntimeAdapter(), dbPath, true);
    const run = createRun(env);
    const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Restart-safe debate", speakers: speakers(), rounds: 2 });
    roomId = opened.room.id;
    firstTaskId = opened.firstTask!.id;
    const first = await env.runner.runNext("worker_discussion_builder");
    assert.equal(first?.status, "completed");
    assert.equal(env.store.getObject(firstTaskId)?.payload.status, "completed");
    assert.equal((env.discussion.get(roomId)?.payload.discussion as any)?.current_task_id, firstTaskId);
    env.queue.close();
    env.store.close();
  }
  {
    const env = fixture(new DeterministicRuntimeAdapter(), dbPath, false);
    try {
      env.supervisor.start();
      await env.supervisor.waitForIdle();
      const room = env.discussion.get(roomId);
      assert.equal((room?.payload.discussion as any)?.status, "completed");
      const tasks = env.store.listObjects("task", "ws_discussion")
        .filter((task) => task.payload.discussion_room_id === roomId)
        .sort((a, b) => Number(a.payload.discussion_turn_index) - Number(b.payload.discussion_turn_index));
      assert.equal(tasks.length, 4);
      assert.equal(tasks.filter((task) => task.id === firstTaskId).length, 1);
      assert.deepEqual(tasks.map((task) => task.payload.discussion_turn_index), [0, 1, 2, 3]);
      assert.equal(env.discussion.candidateArtifacts(roomId).length, 4);
      const firstArtifactId = (env.store.getObject(firstTaskId)?.payload.output_artifact_refs as string[])[0]!;
      const firstArtifactMessages = env.store.listObjects("message", "ws_discussion")
        .filter((message) => message.payload.room_id === roomId && Array.isArray(message.payload.artifact_refs) && message.payload.artifact_refs.includes(firstArtifactId));
      assert.equal(firstArtifactMessages.length, 2); // Worker candidate message + final leader collection message
    } finally {
      await closeFixture(env);
    }
  }
});
