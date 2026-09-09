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
import { TeamRunSynthesis } from "../src/team-run-synthesis.js";
import { TeamRunVerifier } from "../src/team-run-verifier.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest, JsonObject, StoredObject } from "../src/types.js";

class SynthesisRuntime implements RuntimeAdapter {
  constructor(
    readonly id = "synthesis-test",
    public synthesisMode: "valid" | "malformed" = "valid",
    public verifierOutcome: "resolved" | "unresolved" = "resolved"
  ) {}

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    if (context.task.payload.verification_contract === "verifier-verdict-v1") {
      const reports = context.inputArtifacts.filter((artifact) => artifact.payload.kind === "disagreement_report");
      return {
        summary: `Verifier ${this.verifierOutcome}`,
        artifactKind: "raw_verifier_result",
        output: {
          contract: "verifier-verdict-v1",
          report_verdicts: reports.map((report) => {
            const findings = Array.isArray((report.payload.inline_content as any)?.findings)
              ? (report.payload.inline_content as any).findings.filter((finding: any) => finding.kind !== "confidence_gap")
              : [];
            return {
              report_id: report.id,
              outcome: this.verifierOutcome,
              finding_verdicts: findings.map((finding: any) => ({
                finding_id: finding.finding_id,
                status: this.verifierOutcome,
                conclusion: this.verifierOutcome === "resolved" ? "Scoped evidence resolves this conflict." : "Evidence remains contradictory.",
                evidence_artifact_refs: this.verifierOutcome === "resolved" ? [finding.artifact_refs[0]] : []
              }))
            };
          })
        },
        usage: { input_tokens: 2, output_tokens: 2, cost: 0, actions: 1 }
      };
    }

    if (context.task.payload.synthesis_contract === "team-run-synthesis-v1") {
      if (this.synthesisMode === "malformed") {
        return {
          summary: "Malformed synthesis",
          artifactKind: "raw_synthesis_result",
          output: { contract: "wrong-contract", summary: "bad", result: {} },
          usage: { input_tokens: 1, output_tokens: 1, cost: 0, actions: 1 }
        };
      }
      return {
        summary: "Final bounded synthesis",
        artifactKind: "raw_synthesis_result",
        output: {
          contract: "team-run-synthesis-v1",
          summary: "Final bounded synthesis",
          result: {
            objective_id: context.task.payload.root_objective_id,
            input_count: context.inputArtifacts.length,
            synthesized_by: context.principal?.id ?? context.bot.id
          },
          used_artifact_refs: context.inputArtifacts.map((artifact) => artifact.id),
          claims: [{ subject: "synthesis", kind: "fact", value: "complete" }]
        },
        usage: { input_tokens: 4, output_tokens: 4, cost: 0, actions: 1 },
        receipts: [{ kind: "synthesis_test_runtime", adapter: this.id }]
      };
    }

    return {
      summary: "Generic runtime result",
      artifactKind: "generic_result",
      output: { result: "ok" },
      usage: { actions: 1 }
    };
  }
}

class BlockingSynthesisRuntime implements RuntimeAdapter {
  readonly id = "synthesis-blocking";
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    this.startedResolve();
    return await new Promise<RuntimeExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => resolve({
        summary: "late synthesis",
        artifactKind: "raw_synthesis_result",
        output: { contract: "team-run-synthesis-v1", summary: "late", result: { late: true } },
        usage: { actions: 1 }
      }), 5000);
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
    id: "bot_synthesis_leader",
    name: "Synthesis Lead",
    kind: "durable",
    status: "active",
    role: { title: "Synthesis Lead", mission: "Own final evidence-backed synthesis." },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_synthesis" },
    permissions: {
      policy_ref: "strict",
      allowed_peers: ["*"],
      allowed_tools: allowedTools,
      allowed_connections: [],
      can_create_workers: true,
      can_handoff: true
    },
    coordination: { default_mode: "manager", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture(
  runtime: RuntimeAdapter = new SynthesisRuntime(),
  dbPath = `/tmp/aiverse-synthesis-${randomUUID()}.db`,
  createLeader = true,
  allowedTools: string[] = []
) {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  if (createLeader) gateway.createBot(bot(runtime.id, allowedTools));
  const teams = new TeamRunCoordinator(store, gateway, policy);
  const detector = new TeamRunDisagreementDetector(teams, gateway);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 50);
  const verifier = new TeamRunVerifier(teams, gateway, queue, runner);
  const synthesis = new TeamRunSynthesis(teams, gateway, queue, runner);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0, undefined, undefined, undefined, undefined, verifier, synthesis);
  return { store, queue, policy, gateway, teams, detector, runner, verifier, synthesis, supervisor };
}

function runningRun(env: ReturnType<typeof fixture>, rootObjectiveId = `obj_${randomUUID()}`): StoredObject {
  let run = env.teams.createRun({
    createdBy: "bot_synthesis_leader",
    leaderId: "bot_synthesis_leader",
    workspaceId: "ws_synthesis",
    rootObjectiveId,
    topology: "dynamic_squad",
    budget: { max_workers: 4, max_tasks: 24, max_actions: 40, token_limit: 4000 }
  }).run;
  run = env.teams.transitionRun(run.id, "planning", "bot_synthesis_leader").object;
  return env.teams.transitionRun(run.id, "running", "bot_synthesis_leader").object;
}

function candidate(env: ReturnType<typeof fixture>, run: StoredObject, label: string, value: unknown): StoredObject {
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
    inline_content: { label, claims: [{ subject: label, kind: "fact", value }] },
    provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] }
  });
}

function setCandidates(env: ReturnType<typeof fixture>, runId: string, refs: string[]): StoredObject {
  const run = env.teams.getRun(runId)!;
  return env.gateway.record("team_run", {
    ...run.payload,
    candidate_artifact_refs: refs,
    artifact_refs: [...new Set([...(Array.isArray(run.payload.artifact_refs) ? run.payload.artifact_refs.map(String) : []), ...refs])],
    updated_at: new Date().toISOString()
  });
}

async function close(env: ReturnType<typeof fixture>): Promise<void> {
  await env.supervisor.stop();
  env.queue.close();
  env.store.close();
}

test("durable leader synthesis runs through canonical Task/leases and publishes one final Team Run Artifact", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const a = candidate(env, run, "market", "growing");
    const b = candidate(env, run, "risk", "moderate");
    setCandidates(env, run.id, [a.id, b.id]);

    const scheduled = env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" });
    assert.equal(scheduled.status, "scheduled");
    if (scheduled.status !== "scheduled") return;
    assert.equal(scheduled.task.payload.assignee_id, "bot_synthesis_leader");
    assert.equal(scheduled.task.payload.owner_id, "bot_synthesis_leader");
    assert.equal(scheduled.capabilityLease.payload.issued_to, "bot_synthesis_leader");
    assert.equal(scheduled.capabilityLease.payload.task_id, scheduled.task.id);
    assert.equal(scheduled.environmentLease.payload.issued_to, "bot_synthesis_leader");
    assert.equal(scheduled.environmentLease.payload.task_id, scheduled.task.id);
    assert.deepEqual(new Set(scheduled.candidateArtifactRefs), new Set([a.id, b.id]));
    assert.equal(env.teams.listWorkers(run.id).length, 0);
    assert.equal(scheduled.run.payload.status, "synthesizing");

    env.supervisor.start();
    await env.supervisor.waitForIdle();

    const latest = env.teams.getRun(run.id)!;
    const final = env.synthesis.finalArtifact(run.id)!;
    assert.equal(latest.payload.status, "completed");
    assert.equal(latest.payload.final_artifact_ref, final.id);
    assert.equal(final.payload.kind, "team_run_synthesis");
    assert.deepEqual(new Set(final.payload.source_candidate_artifact_refs as string[]), new Set([a.id, b.id]));
    assert.equal((final.payload.inline_content as any).contract, "team-run-synthesis-v1");
    assert.equal((final.payload.inline_content as any).result.synthesized_by, "bot_synthesis_leader");
    assert.equal(env.synthesis.list(run.id).length, 1);
  } finally { await close(env); }
});

test("verification debt blocks synthesis until a resolved verifier verdict becomes an explicit synthesis input", async () => {
  const runtime = new SynthesisRuntime("synthesis-with-verifier", "valid", "resolved");
  const env = fixture(runtime);
  try {
    const run = runningRun(env);
    const a = candidate(env, run, "database", "sqlite");
    const b = candidate(env, run, "database", "postgres");
    setCandidates(env, run.id, [a.id, b.id]);
    const report = env.detector.analyze({ runId: run.id, actorId: "bot_synthesis_leader", artifactRefs: [a.id, b.id] }).report;

    assert.throws(
      () => env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" }),
      /unresolved verification debt/
    );

    env.verifier.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" });
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const verified = env.teams.getRun(run.id)!;
    assert.equal(verified.payload.status, "verifying");
    assert.equal(verified.payload.verification_ready_for_synthesis, true);
    assert.deepEqual(verified.payload.resolved_verification_report_refs, [report.id]);

    const scheduled = env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" });
    assert.equal(scheduled.status, "scheduled");
    if (scheduled.status !== "scheduled") return;
    const verdict = env.verifier.latest(run.id)!;
    assert.ok(scheduled.verificationVerdictRefs.includes(verdict.id));
    assert.ok((scheduled.task.payload.input_artifact_refs as string[]).includes(verdict.id));
    await env.supervisor.waitForIdle();
    assert.equal(env.teams.getRun(run.id)?.payload.status, "completed");
    assert.ok((env.synthesis.finalArtifact(run.id)?.payload.source_verification_verdict_refs as string[]).includes(verdict.id));
  } finally { await close(env); }
});

test("an unresolved verifier verdict remains a hard synthesis gate", async () => {
  const runtime = new SynthesisRuntime("synthesis-unresolved-verifier", "valid", "unresolved");
  const env = fixture(runtime);
  try {
    const run = runningRun(env);
    const a = candidate(env, run, "queue", "redis");
    const b = candidate(env, run, "queue", "sqs");
    setCandidates(env, run.id, [a.id, b.id]);
    env.detector.analyze({ runId: run.id, actorId: "bot_synthesis_leader", artifactRefs: [a.id, b.id] });
    env.verifier.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" });
    env.supervisor.start();
    await env.supervisor.waitForIdle();

    assert.equal(env.teams.getRun(run.id)?.payload.requires_verification, true);
    assert.throws(
      () => env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" }),
      /unresolved verification debt/
    );
    assert.equal(env.synthesis.finalArtifact(run.id), null);
  } finally { await close(env); }
});

test("malformed synthesis output fails closed without a final Artifact and the leader can retry cleanly", async () => {
  const runtime = new SynthesisRuntime("synthesis-retry", "malformed");
  const env = fixture(runtime);
  try {
    const run = runningRun(env);
    const a = candidate(env, run, "answer", 42);
    setCandidates(env, run.id, [a.id]);
    env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" });
    env.supervisor.start();
    await env.supervisor.waitForIdle();

    let latest = env.teams.getRun(run.id)!;
    assert.equal(latest.payload.status, "synthesizing");
    assert.equal(latest.payload.active_synthesis_task_id, null);
    assert.equal(latest.payload.synthesis_last_outcome, "synthesis_failed");
    assert.match(String(latest.payload.synthesis_failure_reason), /team-run-synthesis-v1/);
    assert.equal(env.synthesis.finalArtifact(run.id), null);
    assert.equal(env.synthesis.latest(run.id)?.payload.kind, "synthesis_receipt");

    runtime.synthesisMode = "valid";
    const retry = env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" });
    assert.equal(retry.status, "scheduled");
    await env.supervisor.waitForIdle();
    latest = env.teams.getRun(run.id)!;
    assert.equal(latest.payload.status, "completed");
    assert.equal(latest.payload.synthesis_last_outcome, "completed");
    assert.ok(env.synthesis.finalArtifact(run.id));
    assert.equal((latest.payload.synthesis_task_ids as string[]).length, 2);
    assert.equal(env.synthesis.list(run.id).length, 2);
  } finally { await close(env); }
});

test("synthesis scope, unfinished run work, and leader tool authority fail closed before queue exposure", async () => {
  const env = fixture(new SynthesisRuntime("synthesis-guards"), undefined, true, ["web"]);
  try {
    const run = runningRun(env);
    const own = candidate(env, run, "own", true);
    setCandidates(env, run.id, [own.id]);
    const otherRun = runningRun(env);
    const foreign = candidate(env, otherRun, "foreign", true);

    assert.throws(
      () => env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader", artifactRefs: [foreign.id] }),
      /outside Team Run/
    );
    assert.throws(
      () => env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader", tools: ["shell"] }),
      /cannot expand leader tool authority/
    );

    const worker = env.teams.spawnWorker({
      runId: run.id,
      createdBy: "bot_synthesis_leader",
      role: { title: "unfinished", objective: "Remain unfinished for the guard test" }
    }).worker;
    assert.equal(worker.payload.status, "created");
    assert.throws(
      () => env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" }),
      /temporary Worker\(s\) are active|run Task\(s\) are still active/
    );
    assert.equal(env.queue.list("bot_synthesis_leader", ["queued"]).length, 0);
  } finally { await close(env); }
});

test("canceling active synthesis aborts runtime and leaves the Team Run retryable with no final Artifact", async () => {
  const runtime = new BlockingSynthesisRuntime();
  const env = fixture(runtime);
  try {
    const run = runningRun(env);
    const a = candidate(env, run, "cancel", true);
    setCandidates(env, run.id, [a.id]);
    env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" });
    env.supervisor.start();
    await runtime.started;
    const settled = await env.synthesis.cancel(run.id, "bot_synthesis_leader", "Stop final synthesis");
    await env.supervisor.waitForIdle();

    assert.equal(settled?.outcome, "canceled");
    const latest = env.teams.getRun(run.id)!;
    assert.equal(latest.payload.status, "synthesizing");
    assert.equal(latest.payload.active_synthesis_task_id, null);
    assert.equal(latest.payload.synthesis_last_outcome, "canceled");
    assert.equal(env.synthesis.finalArtifact(run.id), null);
    assert.equal(env.synthesis.latest(run.id)?.payload.kind, "synthesis_receipt");
  } finally { await close(env); }
});

test("completed but unreconciled synthesis settles after database reopen without duplicate final Artifacts", async () => {
  const dbPath = `/tmp/aiverse-synthesis-restart-${randomUUID()}.db`;
  let runId = "";
  let taskId = "";
  {
    const runtime = new SynthesisRuntime("synthesis-restart");
    const env = fixture(runtime, dbPath, true);
    const run = runningRun(env);
    runId = run.id;
    const a = candidate(env, run, "restart", "candidate");
    setCandidates(env, run.id, [a.id]);
    const scheduled = env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" });
    if (scheduled.status !== "scheduled") throw new Error("expected synthesis Task");
    taskId = scheduled.task.id;
    const result = await env.runner.runNext("bot_synthesis_leader");
    assert.equal(result?.status, "completed");
    assert.equal(env.teams.getRun(run.id)?.payload.status, "synthesizing");
    assert.equal(env.synthesis.finalArtifact(run.id), null);
    env.queue.close();
    env.store.close();
  }
  {
    const runtime = new SynthesisRuntime("synthesis-restart");
    const env = fixture(runtime, dbPath, false);
    try {
      env.supervisor.start();
      await env.supervisor.waitForIdle();
      const final = env.synthesis.finalArtifact(runId)!;
      assert.equal(env.teams.getRun(runId)?.payload.status, "completed");
      assert.equal(env.store.getObject(taskId)?.payload.status, "completed");
      assert.equal(env.synthesis.list(runId).filter((artifact) => artifact.payload.kind === "team_run_synthesis").length, 1);
      assert.ok(final.id.startsWith("art_synthesis_"));
    } finally { await close(env); }
  }
});

test("reconciling the same completed synthesis Task is deterministic and idempotent", async () => {
  const env = fixture(new SynthesisRuntime("synthesis-idempotent"));
  try {
    const run = runningRun(env);
    const a = candidate(env, run, "idempotent", true);
    setCandidates(env, run.id, [a.id]);
    const scheduled = env.synthesis.schedule({ runId: run.id, createdBy: "bot_synthesis_leader" });
    if (scheduled.status !== "scheduled") throw new Error("expected synthesis Task");
    await env.runner.runNext("bot_synthesis_leader");
    const first = env.synthesis.reconcileTask(scheduled.task.id)!;
    const second = env.synthesis.reconcileTask(scheduled.task.id)!;
    assert.equal(first.finalArtifact?.id, second.finalArtifact?.id);
    assert.equal(env.synthesis.list(run.id).length, 1);
    assert.equal(env.teams.getRun(run.id)?.payload.status, "completed");
  } finally { await close(env); }
});

test("HTTP Gateway exposes synthesis scheduling/state and returns the completed final Artifact", async () => {
  const app = createGatewayServer({ dbPath: `/tmp/aiverse-synthesis-http-${randomUUID()}.db` });
  const runtime = new SynthesisRuntime("synthesis-http");
  app.runtimes.register(runtime);
  app.gateway.createBot(bot(runtime.id));
  let run = app.teamRuns.createRun({ createdBy: "bot_synthesis_leader", leaderId: "bot_synthesis_leader", workspaceId: "ws_synthesis", rootObjectiveId: `obj_${randomUUID()}`, topology: "dynamic_squad", budget: { max_tasks: 10, max_actions: 20 } }).run;
  run = app.teamRuns.transitionRun(run.id, "planning", "bot_synthesis_leader").object;
  run = app.teamRuns.transitionRun(run.id, "running", "bot_synthesis_leader").object;
  const artifact = app.gateway.record("artifact", { schema_version: "1.0", id: `art_${randomUUID()}`, type: "artifact", workspace_id: "ws_synthesis", created_by: "worker_http", run_id: run.id, task_id: null, kind: "candidate", version: 1, content_ref: null, inline_content: { claims: [{ subject: "http", kind: "fact", value: true }] }, provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] } });
  app.gateway.record("team_run", { ...app.teamRuns.getRun(run.id)!.payload, candidate_artifact_refs: [artifact.id], updated_at: new Date().toISOString() });

  try {
    const address = await app.listen();
    const base = `http://${address.host}:${address.port}`;
    const scheduled = await fetch(`${base}/v1/team-runs/${run.id}/synthesis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ createdBy: "bot_synthesis_leader" })
    });
    assert.equal(scheduled.status, 202);
    assert.equal((await scheduled.json() as any).status, "scheduled");
    await app.supervisor.waitForIdle();

    const stateResponse = await fetch(`${base}/v1/team-runs/${run.id}/synthesis`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as any;
    assert.equal(state.run.payload.status, "completed");
    assert.equal(state.finalArtifact.payload.kind, "team_run_synthesis");
    assert.equal(state.finalArtifact.payload.inline_content.contract, "team-run-synthesis-v1");
  } finally {
    await app.close();
  }
});
