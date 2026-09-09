import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CoordinationPolicy } from "../src/policy.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import { TeamRunDiscussion } from "../src/team-run-discussion.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import { createGatewayServer } from "../src/server.js";
import type { BotManifest } from "../src/types.js";

function bot(adapter = "deterministic"): BotManifest {
  return { schema_version: "1.0", id: "bot_leader", name: "Discussion Lead", kind: "durable", status: "active", role: { title: "Discussion Lead", mission: "Run bounded deliberation." }, runtime: { adapter }, execution: { environment_policy: "shared_workspace" }, scope: { type: "workspace", workspace_id: "ws_discussion" }, permissions: { policy_ref: "strict", allowed_peers: ["*"], allowed_tools: ["tool.echo"], allowed_connections: ["conn.notes"], can_create_workers: true, can_handoff: true }, coordination: { default_mode: "manager", max_parallel_workers: 3, max_hops: 6 } };
}

function fixture(runtime: RuntimeAdapter = new DeterministicRuntimeAdapter(), dbPath = `/tmp/aiverse-discussion-${randomUUID()}.db`, createBot = true) {
  const store = new CoordinationStore(dbPath); const queue = new ExecutionQueue(store.dbPath); const policy = new CoordinationPolicy(store, { requireRegisteredBots: true }); const gateway = new CoordinationGateway(store, queue, policy);
  if (createBot) gateway.createBot(bot(runtime.id));
  const teams = new TeamRunCoordinator(store, gateway, policy); const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 50); const discussion = new TeamRunDiscussion(teams, gateway, queue, runner); const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0, undefined, undefined, undefined, discussion);
  return { store, queue, gateway, teams, runner, discussion, supervisor };
}
function createRun(env: ReturnType<typeof fixture>, topology: "group_room" | "manager" | "dynamic_squad" | "hybrid" = "group_room", budget: Record<string, number> = { max_workers: 2, max_messages: 4, max_rounds: 2, max_tasks: 4, max_actions: 20 }) {
  return env.teams.createRun({ createdBy: "bot_leader", leaderId: "bot_leader", workspaceId: "ws_discussion", rootObjectiveId: `obj_${randomUUID()}`, topology, budget }).run;
}
function speakers() { return [{ key: "builder", roleTitle: "Builder", objective: "Argue the strongest implementation path.", tools: ["tool.echo"] }, { key: "skeptic", roleTitle: "Skeptic", objective: "Challenge assumptions and failure modes.", connections: ["conn.notes"] }]; }
async function closeEnv(env: ReturnType<typeof fixture>) { await env.supervisor.stop(); env.queue.close(); env.store.close(); }

test("group discussion uses a temporary Room/Thread while canonical placeholder Tasks become first turns", async () => {
  const env = fixture(); try {
    const run = createRun(env); const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Choose persistence strategy", speakers: speakers(), rounds: 2 });
    assert.deepEqual(opened.room.payload.members, ["bot_leader"]); assert.equal((opened.room.payload.temporary_participant_ids as unknown[]).length, 2); assert.equal(opened.thread.payload.room_id, opened.room.id); assert.equal(opened.workers.length, 2); assert.ok(opened.workers.every((worker) => env.gateway.getBot(worker.id) === null));
    assert.equal(opened.firstTask?.id, opened.workers[0]?.payload.task_id); assert.equal(opened.firstTask?.payload.status, "assigned"); assert.equal(env.store.listObjects("task", "ws_discussion").filter((task) => task.payload.run_id === run.id).length, 2);
  } finally { await closeEnv(env); }
});

test("two Workers are reused across two bounded rounds and later turns receive prior Artifacts", async () => {
  const env = fixture(); try {
    const run = createRun(env); const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Compare architectures", speakers: speakers(), rounds: 2, maxMessages: 4 }); env.supervisor.start(); await env.supervisor.waitForIdle();
    const room = env.discussion.get(opened.room.id); assert.equal(room?.payload.status, "closed"); assert.equal((room?.payload.discussion as any)?.status, "completed");
    const tasks = env.store.listObjects("task", "ws_discussion").filter((task) => task.payload.discussion_room_id === opened.room.id).sort((a,b) => Number(a.payload.discussion_turn_index)-Number(b.payload.discussion_turn_index));
    assert.equal(tasks.length, 4); assert.deepEqual(tasks.map((task) => (task.payload.input_artifact_refs as unknown[]).length), [0,1,2,3]); assert.equal(env.discussion.candidateArtifacts(opened.room.id).length, 4); assert.ok(env.teams.listWorkers(run.id).every((worker) => worker.payload.status === "completed")); assert.equal(env.gateway.listBots("ws_discussion").length, 1);
  } finally { await closeEnv(env); }
});

test("discussion caps requested rounds/messages/tasks and rejects unjustified topology or insufficient budget", async () => {
  const env = fixture(); try {
    const bounded = createRun(env, "group_room", { max_workers: 2, max_messages: 2, max_rounds: 1, max_tasks: 2, max_actions: 10 }); const opened = env.discussion.open({ runId: bounded.id, createdBy: "bot_leader", topic: "One round", speakers: speakers(), rounds: 8, maxMessages: 20 }); const state = opened.room.payload.discussion as any; assert.equal(state.max_rounds, 1); assert.equal(state.max_messages, 2); assert.equal(state.turn_plan.length, 2);
    await env.discussion.cancel(opened.room.id, "bot_leader");
    const manager = createRun(env, "manager"); assert.throws(() => env.discussion.open({ runId: manager.id, createdBy: "bot_leader", topic: "No group chat", speakers: speakers() }), /does not justify group discussion/);
    const tiny = createRun(env, "group_room", { max_workers: 2, max_messages: 1, max_rounds: 1, max_tasks: 1 }); assert.throws(() => env.discussion.open({ runId: tiny.id, createdBy: "bot_leader", topic: "Too small", speakers: speakers() }), /at least one turn from each/);
  } finally { await closeEnv(env); }
});

test("temporary Worker publication is scoped to its discussion Team Run and candidate Artifact", async () => {
  const env = fixture(); try {
    const run = createRun(env, "group_room", { max_workers: 3, max_messages: 2, max_rounds: 1, max_tasks: 3 }); const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Scoped debate", speakers: speakers(), rounds: 1, maxMessages: 2 });
    const foreignRun = createRun(env, "group_room", { max_workers: 1, max_messages: 1, max_rounds: 1, max_tasks: 1 }); env.teams.transitionRun(foreignRun.id, "planning", "bot_leader"); env.teams.transitionRun(foreignRun.id, "running", "bot_leader"); const foreign = env.teams.spawnWorker({ runId: foreignRun.id, createdBy: "bot_leader", role: { title: "Foreign", objective: "Cannot cross runs" } }).worker;
    assert.throws(() => env.gateway.publishRoomMessage({ senderId: foreign.id, roomId: opened.room.id, workspaceId: "ws_discussion", text: "cross-run", artifactRefs: [] }), /durable or cross-run Room/);
  } finally { await closeEnv(env); }
});

class AbortableRuntime implements RuntimeAdapter { readonly id = "discussion-abortable"; private start!: () => void; readonly started = new Promise<void>((resolve) => { this.start = resolve; }); async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> { this.start(); return await new Promise((resolve, reject) => { const timer = setTimeout(() => resolve({ summary: "late", artifactKind: "late", output: { late: true }, usage: { actions: 1 } }), 5000); context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(context.signal.reason instanceof Error ? context.signal.reason : new Error("aborted")); }, { once: true }); }); } }

test("canceling an active discussion aborts current work and settles all temporary participants", async () => {
  const runtime = new AbortableRuntime(); const env = fixture(runtime); try {
    const run = createRun(env); const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Cancel debate", speakers: speakers(), rounds: 2 }); env.supervisor.start(); await runtime.started; const closed = await env.discussion.cancel(opened.room.id, "bot_leader", "Stop discussion"); await env.supervisor.waitForIdle(); assert.equal((closed.payload.discussion as any)?.status, "canceled"); assert.equal(env.store.getObject(opened.firstTask!.id)?.payload.status, "canceled"); assert.ok(env.teams.listWorkers(run.id).every((worker) => ["canceled","failed","completed"].includes(String(worker.payload.status)))); assert.equal(env.discussion.candidateArtifacts(opened.room.id).length, 0);
  } finally { await closeEnv(env); }
});

test("restart reconciles a completed discussion turn and continues without duplicating it", async () => {
  const dbPath = `/tmp/aiverse-discussion-restart-${randomUUID()}.db`; let roomId = ""; let firstTaskId = "";
  { const env = fixture(new DeterministicRuntimeAdapter(), dbPath, true); const run = createRun(env); const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Restart debate", speakers: speakers(), rounds: 1, maxMessages: 2 }); roomId = opened.room.id; firstTaskId = opened.firstTask!.id; await env.runner.runNext(String(opened.firstTask!.payload.assignee_id)); env.queue.close(); env.store.close(); }
  { const env = fixture(new DeterministicRuntimeAdapter(), dbPath, false); try { env.supervisor.start(); await env.supervisor.waitForIdle(); const room = env.discussion.get(roomId); assert.equal((room?.payload.discussion as any)?.status, "completed"); const tasks = env.store.listObjects("task", "ws_discussion").filter((task) => task.payload.discussion_room_id === roomId); assert.equal(tasks.length, 2); assert.equal(tasks.filter((task) => task.id === firstTaskId).length, 1); assert.equal(env.discussion.candidateArtifacts(roomId).length, 2); } finally { await closeEnv(env); } }
});

test("speaker grants remain bounded and reach turn-scoped capability leases", async () => {
  const env = fixture(); try {
    const run = createRun(env); const opened = env.discussion.open({ runId: run.id, createdBy: "bot_leader", topic: "Capability debate", speakers: speakers(), rounds: 1, maxMessages: 2 }); const lease = env.store.getObject(String(opened.firstTask?.payload.lease_id)); assert.deepEqual(lease?.payload.tools, ["tool.echo"]); assert.deepEqual(lease?.payload.connections, []);
    await env.discussion.cancel(opened.room.id, "bot_leader");
    const other = createRun(env); assert.throws(() => env.discussion.open({ runId: other.id, createdBy: "bot_leader", topic: "Expansion", speakers: [{ key: "a", roleTitle: "A", objective: "A", tools: ["forbidden.tool"] }, { key: "b", roleTitle: "B", objective: "B" }] }), /expand leader tool authority/);
  } finally { await closeEnv(env); }
});

test("HTTP Gateway exposes bounded discussion creation, inspection and cancellation", async () => {
  const service = createGatewayServer({ dbPath: `/tmp/aiverse-discussion-http-${randomUUID()}.db` }); const address = await service.listen(); try {
    service.gateway.createBot(bot()); const run = service.teamRuns.createRun({ createdBy: "bot_leader", leaderId: "bot_leader", workspaceId: "ws_discussion", rootObjectiveId: `obj_${randomUUID()}`, topology: "group_room", budget: { max_workers: 2, max_messages: 2, max_rounds: 1, max_tasks: 2 } }).run;
    const response = await fetch(`http://${address.host}:${address.port}/v1/team-runs/${run.id}/discussions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ createdBy: "bot_leader", topic: "HTTP debate", speakers: speakers(), rounds: 1, maxMessages: 2 }) }); assert.equal(response.status, 201); const opened = await response.json() as any; assert.equal(opened.room.payload.temporary, true);
    const get = await fetch(`http://${address.host}:${address.port}/v1/discussions/${opened.room.id}`); assert.equal(get.status, 200); const body = await get.json() as any; assert.equal(body.discussion.id, opened.room.id);
    const cancel = await fetch(`http://${address.host}:${address.port}/v1/discussions/${opened.room.id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actorId: "bot_leader", reason: "HTTP stop" }) }); assert.equal(cancel.status, 200);
  } finally { await service.close(); }
});
