import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { BotRunner } from "../src/runner.js";
import { RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import { TeamRunDisagreementDetector } from "../src/team-run-disagreement.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import { TeamRunVerifier } from "../src/team-run-verifier.js";
import type { BotManifest, JsonObject, StoredObject } from "../src/types.js";

class VerdictRuntime implements RuntimeAdapter {
  readonly id: string;
  constructor(readonly mode: "resolved" | "unresolved" | "insufficient" | "malformed" | "mixed" = "resolved", id = `verifier-${mode}`) {
    this.id = id;
  }

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    if (this.mode === "malformed") {
      return { summary: "Malformed verifier output", artifactKind: "raw_verifier_result", output: { contract: "wrong-contract" }, usage: { actions: 1 } };
    }
    const reports = context.inputArtifacts.filter((artifact) => artifact.payload.kind === "disagreement_report");
    const report_verdicts = reports.map((report, index) => {
      const inline = report.payload.inline_content as any;
      const hardFindings = (inline.findings ?? []).filter((finding: any) => finding.kind !== "confidence_gap");
      const outcome = this.mode === "mixed"
        ? (index === 0 ? "resolved" : "unresolved")
        : this.mode === "insufficient"
          ? "insufficient_evidence"
          : this.mode;
      const status = outcome === "resolved" ? "resolved" : outcome === "unresolved" ? "unresolved" : "insufficient_evidence";
      return {
        report_id: report.id,
        outcome,
        finding_verdicts: hardFindings.map((finding: any) => ({
          finding_id: finding.finding_id,
          status,
          conclusion: status === "resolved" ? "Scoped evidence resolves this finding." : status === "unresolved" ? "Evidence remains contradictory." : "More evidence is required.",
          evidence_artifact_refs: status === "resolved" ? [finding.artifact_refs[0]] : []
        }))
      };
    });
    return {
      summary: `Verifier returned ${this.mode}`,
      artifactKind: "raw_verifier_result",
      output: { contract: "verifier-verdict-v1", report_verdicts },
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
      context.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(context.signal.reason instanceof Error ? context.signal.reason : new Error("aborted"));
      }, { once: true });
    });
  }
}

function bot(adapter: string, allowedTools: string[] = []): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_verifier_leader",
    name: "Verifier Lead",
    kind: "durable",
    status: "active",
    role: { title: "Lead", mission: "Coordinate bounded verification." },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_verifier" },
    permissions: { policy_ref: "strict", can_create_workers: true, allowed_tools: allowedTools, allowed_connections: [] },
    coordination: { default_mode: "manager", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture(runtime: RuntimeAdapter = new VerdictRuntime(), dbPath = `/tmp/aiverse-verifier-${randomUUID()}.db`, createLeader = true, allowedTools: string[] = []) {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const gateway = new CoordinationGateway(store, queue);
  if (createLeader) gateway.createBot(bot(runtime.id, allowedTools));
  const teams = new TeamRunCoordinator(store);
  const detector = new TeamRunDisagreementDetector(teams, gateway);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 50);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
  const verifier = new TeamRunVerifier(teams, gateway, queue, runner);
  return { store, queue, gateway, teams, detector, runner, supervisor, verifier };
}

function runningRun(env: ReturnType<typeof fixture>, maxWorkers = 4): StoredObject {
  let run = env.teams.createRun({
    leaderId: "bot_verifier_leader",
    workspaceId: "ws_verifier",
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Resolve candidate conflicts with bounded verification.",
    topology: "dynamic_squad",
    budget: { max_workers: maxWorkers, max_tasks: 16, max_actions: 20, token_limit: 1000 }
  }).run;
  run = env.teams.transitionRun(run.id, "planning", "bot_verifier_leader").run;
  return env.teams.transitionRun(run.id, "running", "bot_verifier_leader").run;
}

function candidate(env: ReturnType<typeof fixture>, run: StoredObject, subject: string, value: unknown): StoredObject {
  return env.gateway.record("artifact", {
    schema_version: "1.0",
    id: `art_${randomUUID()}`,
    type: "artifact",
    workspace_id: String(run.payload.workspace_id),
    created_by: `worker_${randomUUID()}`,
    run_id: run.id,
    task_id: null,
    kind: "candidate",
    version: 1,
    content_ref: null,
    inline_content: { claims: [{ subject, kind: "fact", value }] },
    provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] }
  });
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

test("resolved verifier work clears only its debt, creates a canonical verdict, and moves the run to synthesizing", async () => {
  const env = fixture(new VerdictRuntime("resolved"));
  try {
    const run = runningRun(env);
    const report = conflict(env, run);
    const scheduled = env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    assert.equal(scheduled.status, "scheduled");
    if (scheduled.status !== "scheduled") return;
    assert.equal(scheduled.task.payload.verification_contract, "verifier-verdict-v1");
    assert.deepEqual(scheduled.reportRefs, [report.id]);
    env.supervisor.start();
    await env.supervisor.waitForIdle();

    const latest = env.teams.getRun(run.id)!;
    assert.equal(latest.payload.requires_verification, false);
    assert.deepEqual(latest.payload.verification_required_report_refs, []);
    assert.deepEqual(latest.payload.resolved_verification_report_refs, [report.id]);
    assert.equal(latest.payload.status, "synthesizing");
    const verdict = env.verifier.latest(run.id)!;
    assert.equal(verdict.payload.kind, "verification_verdict");
    assert.equal((verdict.payload.inline_content as any).outcome, "resolved");
    assert.equal((verdict.payload.inline_content as any).resolved_report_refs[0], report.id);
    assert.equal(env.store.getObject(scheduled.worker.id)?.payload.status, "completed");
  } finally {
    await close(env);
  }
});

test("unresolved verifier work preserves verification debt and keeps the Team Run verifying", async () => {
  const env = fixture(new VerdictRuntime("unresolved"));
  try {
    const run = runningRun(env);
    const report = conflict(env, run);
    const scheduled = env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    assert.equal(scheduled.status, "scheduled");
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const latest = env.teams.getRun(run.id)!;
    assert.equal(latest.payload.requires_verification, true);
    assert.deepEqual(latest.payload.verification_required_report_refs, [report.id]);
    assert.equal(latest.payload.status, "verifying");
    assert.equal((env.verifier.latest(run.id)?.payload.inline_content as any)?.outcome, "unresolved");
  } finally {
    await close(env);
  }
});

test("insufficient verifier evidence keeps debt intact", async () => {
  const env = fixture(new VerdictRuntime("insufficient"));
  try {
    const run = runningRun(env);
    const report = conflict(env, run);
    env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const latest = env.teams.getRun(run.id)!;
    assert.deepEqual(latest.payload.verification_required_report_refs, [report.id]);
    assert.equal((env.verifier.latest(run.id)?.payload.inline_content as any)?.outcome, "insufficient_evidence");
  } finally {
    await close(env);
  }
});

test("verifier scheduling is skipped when no disagreement report requires verification", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const beforeWorkers = env.teams.listWorkers(run.id).length;
    const result = env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    assert.equal(result.status, "skipped");
    assert.equal(env.teams.listWorkers(run.id).length, beforeWorkers);
    assert.equal(env.store.listObjects("task", "ws_verifier").filter((task) => task.payload.run_id === run.id).length, 0);
  } finally {
    await close(env);
  }
});

test("malformed completed verifier output becomes verifier_failed and cannot clear debt", async () => {
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
  } finally {
    await close(env);
  }
});

test("one verifier Task can resolve one report while preserving unrelated unresolved debt", async () => {
  const env = fixture(new VerdictRuntime("mixed"));
  try {
    const run = runningRun(env);
    const first = conflict(env, run, "database choice");
    const second = conflict(env, env.teams.getRun(run.id)!, "queue choice");
    const scheduled = env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader" });
    assert.equal(scheduled.status, "scheduled");
    if (scheduled.status !== "scheduled") return;
    assert.equal(scheduled.reportRefs.length, 2);
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const latest = env.teams.getRun(run.id)!;
    const resolved = latest.payload.resolved_verification_report_refs as string[];
    const remaining = latest.payload.verification_required_report_refs as string[];
    assert.equal(resolved.length, 1);
    assert.equal(remaining.length, 1);
    assert.deepEqual(new Set([...resolved, ...remaining]), new Set([first.id, second.id]));
    assert.notEqual(resolved[0], remaining[0]);
    assert.equal(latest.payload.requires_verification, true);
    assert.equal(latest.payload.status, "verifying");
  } finally {
    await close(env);
  }
});

test("verifier cannot expand the durable leader tool authority", async () => {
  const env = fixture(new VerdictRuntime("resolved"), undefined, true, ["web"]);
  try {
    const run = runningRun(env);
    conflict(env, run);
    assert.throws(
      () => env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_leader", tools: ["shell"] }),
      /cannot expand leader tool authority/
    );
    assert.equal(env.teams.listWorkers(run.id).length, 0);
  } finally {
    await close(env);
  }
});

test("canceling an active verifier preserves debt and records a canceled canonical verdict", async () => {
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
  } finally {
    await close(env);
  }
});

test("reconciling the same completed verifier Task is idempotent", async () => {
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
  } finally {
    await close(env);
  }
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
    env.queue.close();
    env.store.close();
  }
  {
    const runtime = new VerdictRuntime("resolved", "verifier-restart");
    const env = fixture(runtime, dbPath, false);
    try {
      env.supervisor.start();
      await env.supervisor.waitForIdle();
      const verdict = env.verifier.latest(runId)!;
      assert.equal((verdict.payload.inline_content as any).outcome, "resolved");
      assert.equal(env.verifier.list(runId).length, 1);
      assert.equal(env.store.getObject(taskId)?.payload.status, "completed");
      assert.deepEqual(env.teams.getRun(runId)?.payload.verification_required_report_refs, []);
    } finally {
      await close(env);
    }
  }
});