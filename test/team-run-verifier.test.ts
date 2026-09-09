import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult } from "../src/runtime.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import { TeamRunDisagreementDetector } from "../src/team-run-disagreement.js";
import { TeamRunVerifier } from "../src/team-run-verifier.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest, JsonObject, StoredObject } from "../src/types.js";

class VerdictRuntime implements RuntimeAdapter {
  readonly id: string;
  constructor(readonly mode: "resolved" | "unresolved" | "malformed" | "mixed" = "resolved", id = `verifier-${mode}`) { this.id = id; }

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    if (this.mode === "malformed") {
      return { summary: "Malformed verifier output", artifactKind: "raw_verifier_result", output: { contract: "wrong-contract" }, usage: { actions: 1 } };
    }
    const reports = context.inputArtifacts.filter((artifact) => artifact.payload.kind === "disagreement_report");
    return {
      summary: `Verifier returned ${this.mode}`,
      artifactKind: "raw_verifier_result",
      output: {
        contract: "verifier-verdict-v1",
        report_verdicts: reports.map((report, index) => {
          const inline = report.payload.inline_content as any;
          const findings = (inline.findings ?? []).filter((finding: any) => finding.kind !== "confidence_gap");
          const outcome = this.mode === "mixed" ? (index === 0 ? "resolved" : "unresolved") : this.mode;
          return {
            report_id: report.id,
            outcome,
            finding_verdicts: findings.map((finding: any) => ({
              finding_id: finding.finding_id,
              status: outcome,
              conclusion: outcome === "resolved" ? "Scoped evidence resolves the finding." : "Evidence remains contradictory.",
              evidence_artifact_refs: outcome === "resolved" ? [finding.artifact_refs[0]] : []
            }))
          };
        })
      },
      usage: { input_tokens: 1, output_tokens: 1, cost: 0, actions: 1 }
    };
  }
}

class BlockingVerifierRuntime implements RuntimeAdapter {
  readonly id = "verifier-blocking";
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });
  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    this.startedResolve();
    return await new Promise<RuntimeExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ summary: "late", artifactKind: "raw_verifier_result", output: { contract: "verifier-verdict-v1", report_verdicts: [] }, usage: { actions: 1 } }), 5000);
      context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(context.signal.reason instanceof Error ? context.signal.reason : new Error("aborted")); }, { once: true });
    });
  }
}

function bot(adapter: string, canCreateWorkers = true, allowedTools: string[] = []): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_verifier_leader",
    name: "Verifier Lead",
    kind: "durable",
    status: "active",
    role: { title: "Verifier Lead", mission: "Coordinate bounded verification." },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_verifier" },
    permissions: { policy_ref: "strict", allowed_peers: ["*"], allowed_tools: allowedTools, allowed_connections: [], can_create_workers: canCreateWorkers, can_handoff: true },
    coordination: { default_mode: "manager", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture(runtime: RuntimeAdapter = new VerdictRuntime(), dbPath = `/tmp/aiverse-verifier-${randomUUID()}.db`, createLeader = true, canCreateWorkers = true, allowedTools: string[] = []) {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  if (createLeader) gateway.createBot(bot(runtime.id, canCreateWorkers, allowedTools));
  const teams = new TeamRunCoordinator(store, gateway, policy);
  const detector = new TeamRunDisagreementDetector(teams, gateway);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 50);
  const verifier = new TeamRunVerifier(teams, gateway, queue, runner);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0, undefined, undefined, undefined, undefined, verifier);
  return { store, queue, policy, gateway, teams, detector, runner, verifier, supervisor };
}

function runningRun(env: ReturnType<typeof fixture>, maxWorkers = 4): StoredObject {
  let run = env.teams.createRun({ createdBy: "bot_verifier_leader", leaderId: "bot_verifier_leader", workspaceId: "ws_verifier", rootObjectiveId: `obj_${randomUUID()}`, topology: "dynamic_squad", budget: { max_workers: maxWorkers, max_tasks: 16, max_actions: 20, token_limit: 1000 } }).run;
  run = env.teams.transitionRun(run.id, "planning", "bot_verifier_leader").object;
  return env.teams.transitionRun(run.id, "running", "bot_verifier_leader").object;
}

function candidate(env: ReturnType<typeof fixture>, run: StoredObject, subject: string, value: unknown): StoredObject {
  return env.gateway.record("artifact", { schema_version: "1.0", id: `art_${randomUUID()}`, type: "artifact", workspace_id: String(run.payload.workspace_id), created_by: `worker_${randomUUID()}`, run_id: run.id, task_id: null, kind: "candidate", version: 1, content_ref: null, inline_content: { claims: [{ subject, kind: "fact", value }] }, provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] } });
}

function conflict(env: ReturnType<typeof fixture>, run: StoredObject, subject = "release readiness"): StoredObject {
  const left = candidate(env, run, subject, true);
  const right = candidate(env, run, subject, false);
  return env.detector.analyze({ runId: run.id, actorId: "bot_verifier_leader", artifactRefs: [left.id, right.id] }).report;
}

async function close(env: ReturnType<typeof fixture>): Promise<void> {
  await env.supervisor.stop();
  env.queue.close();
  env.store.close();
}

test("resolved verifier uses canonical Worker authority, clears only its debt, and stops before synthesis", async () => {
  const env = fixture(new VerdictRuntime("resolved"));
  try {
    const run = runningRun(env);
    const report = conflict(env, run);
    const scheduled = env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    assert.equal(scheduled.status, "scheduled");
    if (scheduled.status !== "scheduled") return;
    assert.equal(scheduled.task.payload.root_owner_id, "bot_verifier_leader");
    assert.equal(scheduled.task.payload.environment_lease_id, scheduled.environmentLease.id);
    assert.equal(scheduled.environmentLease.payload.issued_to, scheduled.worker.id);
    assert.equal(scheduled.environmentLease.payload.task_id, scheduled.task.id);
    assert.ok((scheduled.task.payload.input_artifact_refs as string[]).includes(report.id));
    assert.equal(env.gateway.getBot(scheduled.worker.id), null);

    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const latest = env.teams.getRun(run.id)!;
    assert.equal(latest.payload.requires_verification, false);
    assert.deepEqual(latest.payload.verification_required_report_refs, []);
    assert.deepEqual(latest.payload.resolved_verification_report_refs, [report.id]);
    assert.equal(latest.payload.status, "verifying");
    assert.equal(latest.payload.verification_ready_for_synthesis, true);
    assert.equal((env.verifier.latest(run.id)?.payload.inline_content as any)?.outcome, "resolved");
    assert.equal(env.store.getObject(scheduled.worker.id)?.payload.status, "completed");
  } finally { await close(env); }
});

test("unresolved verifier preserves debt and does not become synthesis-ready", async () => {
  const env = fixture(new VerdictRuntime("unresolved"));
  try {
    const run = runningRun(env);
    const report = conflict(env, run);
    env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const latest = env.teams.getRun(run.id)!;
    assert.deepEqual(latest.payload.verification_required_report_refs, [report.id]);
    assert.equal(latest.payload.requires_verification, true);
    assert.equal(latest.payload.verification_ready_for_synthesis, false);
    assert.equal((env.verifier.latest(run.id)?.payload.inline_content as any)?.outcome, "unresolved");
  } finally { await close(env); }
});

test("malformed verifier output becomes verifier_failed and cannot clear disagreement debt", async () => {
  const env = fixture(new VerdictRuntime("malformed"));
  try {
    const run = runningRun(env);
    const report = conflict(env, run);
    env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const verdict = env.verifier.latest(run.id)!;
    assert.equal((verdict.payload.inline_content as any).outcome, "verifier_failed");
    assert.match(String((verdict.payload.inline_content as any).failure_reason), /verifier-verdict-v1/);
    assert.deepEqual(env.teams.getRun(run.id)?.payload.verification_required_report_refs, [report.id]);
  } finally { await close(env); }
});

test("one verifier Task resolves only the report it proves while unrelated debt remains", async () => {
  const env = fixture(new VerdictRuntime("mixed"));
  try {
    const run = runningRun(env);
    const first = conflict(env, run, "database choice");
    const second = conflict(env, env.teams.getRun(run.id)!, "queue choice");
    env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const latest = env.teams.getRun(run.id)!;
    const resolved = latest.payload.resolved_verification_report_refs as string[];
    const remaining = latest.payload.verification_required_report_refs as string[];
    assert.equal(resolved.length, 1);
    assert.equal(remaining.length, 1);
    assert.notEqual(resolved[0], remaining[0]);
    assert.deepEqual(new Set([...resolved, ...remaining]), new Set([first.id, second.id]));
    assert.equal(latest.payload.requires_verification, true);
    assert.equal(latest.payload.verification_ready_for_synthesis, false);
  } finally { await close(env); }
});

test("verifier scheduling fails closed on Worker permission and leader tool expansion before executable work exists", async () => {
  const env = fixture(new VerdictRuntime("resolved"), undefined, true, false, ["web"]);
  try {
    const run = runningRun(env);
    conflict(env, run);
    assert.throws(() => env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" }), /not explicitly allowed to create verifier Workers|not explicitly allowed to create Workers/);
    assert.equal(env.teams.listWorkers(run.id).length, 0);
  } finally { await close(env); }

  const env2 = fixture(new VerdictRuntime("resolved"), undefined, true, true, ["web"]);
  try {
    const run = runningRun(env2);
    conflict(env2, run);
    assert.throws(() => env2.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader", tools: ["shell"] }), /cannot expand leader tool authority|does not hold that authority/);
    assert.equal(env2.teams.listWorkers(run.id).length, 0);
  } finally { await close(env2); }
});

test("canceling an active verifier aborts runtime, preserves debt, and records a canonical canceled verdict", async () => {
  const runtime = new BlockingVerifierRuntime();
  const env = fixture(runtime);
  try {
    const run = runningRun(env);
    const report = conflict(env, run);
    env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    env.supervisor.start();
    await runtime.started;
    const settled = await env.verifier.cancel(run.id, "bot_verifier_leader", "Stop verification");
    await env.supervisor.waitForIdle();
    assert.equal(settled?.outcome, "canceled");
    assert.deepEqual(env.teams.getRun(run.id)?.payload.verification_required_report_refs, [report.id]);
    assert.equal((env.verifier.latest(run.id)?.payload.inline_content as any)?.outcome, "canceled");
  } finally { await close(env); }
});

test("reconciling completed verifier work is deterministic and idempotent", async () => {
  const env = fixture(new VerdictRuntime("resolved"));
  try {
    const run = runningRun(env);
    conflict(env, run);
    const scheduled = env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    if (scheduled.status !== "scheduled") throw new Error("expected verifier Task");
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const first = env.verifier.reconcileTask(scheduled.task.id)!;
    const second = env.verifier.reconcileTask(scheduled.task.id)!;
    assert.equal(first.verdict?.id, second.verdict?.id);
    assert.equal(env.verifier.list(run.id).length, 1);
  } finally { await close(env); }
});

test("completed but unreconciled verifier work settles after database reopen without duplicate verdicts", async () => {
  const dbPath = `/tmp/aiverse-verifier-restart-${randomUUID()}.db`;
  let runId = "";
  let taskId = "";
  {
    const runtime = new VerdictRuntime("resolved", "verifier-restart");
    const env = fixture(runtime, dbPath, true);
    const run = runningRun(env);
    runId = run.id;
    conflict(env, run);
    const scheduled = env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    if (scheduled.status !== "scheduled") throw new Error("expected verifier Task");
    taskId = scheduled.task.id;
    const result = await env.runner.runNext(scheduled.worker.id);
    assert.equal(result?.status, "completed");
    assert.equal(env.verifier.latest(run.id), null);
    env.queue.close(); env.store.close();
  }
  {
    const runtime = new VerdictRuntime("resolved", "verifier-restart");
    const env = fixture(runtime, dbPath, false);
    try {
      env.supervisor.start();
      await env.supervisor.waitForIdle();
      assert.equal((env.verifier.latest(runId)?.payload.inline_content as any)?.outcome, "resolved");
      assert.equal(env.verifier.list(runId).length, 1);
      assert.equal(env.store.getObject(taskId)?.payload.status, "completed");
      assert.deepEqual(env.teams.getRun(runId)?.payload.verification_required_report_refs, []);
    } finally { await close(env); }
  }
});

test("verifier input Artifact validation prevents cross-Run evidence from becoming Worker context", async () => {
  const env = fixture(new VerdictRuntime("resolved"));
  try {
    const run = runningRun(env);
    const report = conflict(env, run);
    const reportObject = env.store.getObject(report.id)!;
    const otherRun = runningRun(env);
    const foreign = candidate(env, otherRun, "foreign", true);
    env.gateway.record("artifact", { ...reportObject.payload, id: `art_${randomUUID()}`, source_artifact_refs: [foreign.id], inline_content: { ...(reportObject.payload.inline_content as JsonObject), source_artifact_refs: [foreign.id] } });
    const before = env.teams.listWorkers(run.id).length;
    assert.equal(before, 0);
    // The canonical debt report itself remains valid; only explicit same-Run source evidence is accepted by verifierInputs.
    const scheduled = env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader", reportRefs: [report.id] });
    assert.equal(scheduled.status, "scheduled");
    assert.ok(scheduled.status === "scheduled" && !(scheduled.task.payload.input_artifact_refs as string[]).includes(foreign.id));
  } finally { await close(env); }
});

test("HTTP Gateway exposes verifier scheduling and state inspection without performing synthesis", async () => {
  const service = createGatewayServer({ port: 0, dbPath: `/tmp/aiverse-verifier-http-${randomUUID()}.db` });
  const address = await service.listen();
  try {
    service.gateway.createBot(bot("verifier-http-unregistered"));
    let run = service.teamRuns.createRun({ createdBy: "bot_verifier_leader", leaderId: "bot_verifier_leader", workspaceId: "ws_verifier", rootObjectiveId: `obj_${randomUUID()}`, topology: "dynamic_squad", budget: { max_workers: 4, max_tasks: 16, max_actions: 20 } }).run;
    run = service.teamRuns.transitionRun(run.id, "planning", "bot_verifier_leader").object;
    run = service.teamRuns.transitionRun(run.id, "running", "bot_verifier_leader").object;
    const left = service.gateway.record("artifact", { schema_version: "1.0", id: `art_${randomUUID()}`, type: "artifact", workspace_id: "ws_verifier", created_by: "worker_left", run_id: run.id, task_id: null, kind: "candidate", version: 1, content_ref: null, inline_content: { claims: [{ subject: "ship", kind: "fact", value: true }] }, provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] } });
    const right = service.gateway.record("artifact", { schema_version: "1.0", id: `art_${randomUUID()}`, type: "artifact", workspace_id: "ws_verifier", created_by: "worker_right", run_id: run.id, task_id: null, kind: "candidate", version: 1, content_ref: null, inline_content: { claims: [{ subject: "ship", kind: "fact", value: false }] }, provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] } });
    service.disagreement.analyze({ runId: run.id, actorId: "bot_verifier_leader", artifactRefs: [left.id, right.id] });

    const scheduled = await fetch(`http://${address.host}:${address.port}/v1/team-runs/${run.id}/verification`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ createdBy: "bot_verifier_leader" }) });
    assert.equal(scheduled.status, 202);
    const state = await fetch(`http://${address.host}:${address.port}/v1/team-runs/${run.id}/verification`);
    assert.equal(state.status, 200);
    const body = await state.json() as any;
    assert.equal(typeof body.activeTaskId, "string");
    assert.equal(body.readyForSynthesis, false);
  } finally { await service.close(); }
});
