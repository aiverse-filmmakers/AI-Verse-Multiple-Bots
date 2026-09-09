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
import { TeamRunManager } from "../src/team-run-manager.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest, StoredObject } from "../src/types.js";

const LEADER = "bot_synthesis_leader";
const WORKSPACE = "ws_synthesis";

class SynthesisRuntime implements RuntimeAdapter {
  readonly id: string;
  constructor(readonly mode: "normal" | "malformed" | "bad_citation" | "aggregate_budget" = "normal", id = `synthesis-${mode}`) {
    this.id = id;
  }

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    const contract = (context.task.payload.expected_output as any)?.contract;
    if (contract === "verifier-verdict-v1") {
      const reports = context.inputArtifacts.filter((artifact) => artifact.payload.kind === "disagreement_report");
      return {
        summary: "Resolved scoped disagreement",
        artifactKind: "raw_verifier_result",
        output: {
          contract: "verifier-verdict-v1",
          report_verdicts: reports.map((report) => {
            const findings = ((report.payload.inline_content as any)?.findings ?? []).filter((finding: any) => finding.kind !== "confidence_gap");
            return {
              report_id: report.id,
              outcome: "resolved",
              finding_verdicts: findings.map((finding: any) => ({
                finding_id: finding.finding_id,
                status: "resolved",
                conclusion: "Scoped evidence resolves this finding.",
                evidence_artifact_refs: [finding.artifact_refs[0]]
              }))
            };
          })
        },
        usage: { actions: 1, input_tokens: 1, output_tokens: 1, cost: 0 }
      };
    }

    if (contract === "synthesis-final-v1") {
      if (this.mode === "malformed") {
        return { summary: "bad", artifactKind: "raw_synthesis_result", output: { contract: "wrong-contract", result: "bad" }, usage: { actions: 1 } };
      }
      const refs = context.inputArtifacts.map((artifact) => artifact.id);
      return {
        summary: "Synthesized final",
        artifactKind: "raw_synthesis_result",
        output: {
          contract: "synthesis-final-v1",
          result: { answer: "bounded final answer", sources: refs.length },
          summary: "One final result from scoped evidence.",
          used_source_artifact_refs: this.mode === "bad_citation" ? [...refs, `art_outside_${randomUUID()}`] : refs,
          unresolved_items: [],
          confidence: 0.9
        },
        usage: { actions: 1, input_tokens: 2, output_tokens: 2, cost: 0 }
      };
    }

    return {
      summary: "Worker candidate",
      artifactKind: "candidate",
      output: { claims: [{ subject: "candidate", kind: "fact", value: true }] },
      usage: { actions: this.mode === "aggregate_budget" ? 2 : 1, input_tokens: 1, output_tokens: 1, cost: 0 }
    };
  }
}

class BlockingSynthesisRuntime implements RuntimeAdapter {
  readonly id = "synthesis-blocking";
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    const contract = (context.task.payload.expected_output as any)?.contract;
    if (contract !== "synthesis-final-v1") return { summary: "candidate", artifactKind: "candidate", output: {}, usage: { actions: 1 } };
    this.startedResolve();
    return await new Promise<RuntimeExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ summary: "late", artifactKind: "raw_synthesis_result", output: { contract: "synthesis-final-v1", result: "late" }, usage: { actions: 1 } }), 5000);
      context.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(context.signal.reason instanceof Error ? context.signal.reason : new Error("aborted"));
      }, { once: true });
    });
  }
}

function bot(adapter: string, allowedTools: string[] = ["web"]): BotManifest {
  return {
    schema_version: "1.0",
    id: LEADER,
    name: "Synthesis Lead",
    kind: "durable",
    status: "active",
    role: { title: "Lead", mission: "Produce one bounded final result." },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: WORKSPACE },
    permissions: { policy_ref: "strict", can_create_workers: true, allowed_tools: allowedTools, allowed_connections: [] },
    coordination: { default_mode: "manager", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture(runtime: RuntimeAdapter = new SynthesisRuntime(), dbPath = `/tmp/aiverse-synthesis-${randomUUID()}.db`, createLeader = true, allowedTools: string[] = ["web"]) {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const gateway = new CoordinationGateway(store, queue);
  if (createLeader) gateway.createBot(bot(runtime.id, allowedTools));
  const teams = new TeamRunCoordinator(store);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 50);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
  const manager = new TeamRunManager(teams, gateway, queue, runner);
  const detector = new TeamRunDisagreementDetector(teams, gateway);
  return { store, queue, gateway, teams, runner, supervisor, manager, detector, synthesis: supervisor.synthesis, verifier: supervisor.verifier };
}

function runningRun(env: ReturnType<typeof fixture>, budget: Record<string, number> = {}): StoredObject {
  let run = env.teams.createRun({
    leaderId: LEADER,
    workspaceId: WORKSPACE,
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Produce the best bounded final answer from squad evidence.",
    topology: "dynamic_squad",
    budget: { max_workers: 4, max_tasks: 16, max_actions: 40, token_limit: 4000, ...budget }
  }).run;
  run = env.teams.transitionRun(run.id, "planning", LEADER).run;
  return env.teams.transitionRun(run.id, "running", LEADER).run;
}

function candidate(env: ReturnType<typeof fixture>, run: StoredObject, value: unknown = true): StoredObject {
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
    inline_content: { claims: [{ subject: "release", kind: "fact", value }] },
    provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] }
  });
}

function conflict(env: ReturnType<typeof fixture>, run: StoredObject) {
  const left = candidate(env, run, true);
  const right = candidate(env, run, false);
  const report = env.detector.analyze({ runId: run.id, actorId: LEADER, artifactRefs: [left.id, right.id] }).report;
  return { left, right, report };
}

async function close(env: ReturnType<typeof fixture>): Promise<void> {
  await env.supervisor.stop();
  env.queue.close();
  env.store.close();
}

test("durable leader creates one canonical final synthesis and completes the Team Run without a new Worker", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const left = candidate(env, run, "A");
    const right = candidate(env, run, "B");
    const workersBefore = env.teams.listWorkers(run.id).length;
    const scheduled = env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [left.id, right.id] });
    assert.equal(scheduled.status, "scheduled");
    if (scheduled.status !== "scheduled") return;
    assert.equal(scheduled.task.payload.owner_id, LEADER);
    assert.equal(scheduled.task.payload.assignee_id, LEADER);
    assert.equal(env.teams.listWorkers(run.id).length, workersBefore);
    env.supervisor.start();
    await env.supervisor.waitForIdle();

    const final = env.synthesis.finalArtifact(run.id)!;
    const latest = env.teams.getRun(run.id)!;
    assert.equal(final.payload.kind, "synthesis_final");
    assert.equal(final.payload.created_by, LEADER);
    assert.equal(latest.payload.status, "completed");
    assert.equal(latest.payload.final_artifact_ref, final.id);
    assert.deepEqual(new Set(final.payload.source_artifact_refs as string[]), new Set([left.id, right.id]));
    assert.equal((final.payload.inline_content as any).result.answer, "bounded final answer");
    assert.equal(env.synthesis.list(run.id).length, 1);
  } finally {
    await close(env);
  }
});

test("synthesis refuses unresolved verification debt before creating work", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const { left, right } = conflict(env, run);
    assert.throws(() => env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [left.id, right.id] }), /verification debt remains/);
    assert.equal(env.store.listObjects("task", WORKSPACE).filter((task) => task.payload.run_id === run.id && task.payload.synthesis_contract === "synthesis-final-v1").length, 0);
    assert.equal(env.teams.getRun(run.id)?.payload.status, "running");
  } finally {
    await close(env);
  }
});

test("synthesis refuses live temporary participation", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const source = candidate(env, run);
    env.teams.createWorker({ runId: run.id, createdBy: LEADER, roleTitle: "Still working", objective: "Do not finalize yet" });
    assert.throws(() => env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [source.id] }), /Worker\(s\) remain active/);
    assert.equal(env.teams.getRun(run.id)?.payload.status, "running");
  } finally {
    await close(env);
  }
});

test("cross-TeamRun source validation fails before the run enters synthesizing", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const other = runningRun(env);
    const foreign = candidate(env, other);
    assert.throws(() => env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [foreign.id] }), /outside Team Run/);
    assert.equal(env.teams.getRun(run.id)?.payload.status, "running");
    assert.equal(env.teams.getRun(run.id)?.payload.active_synthesis_task_id ?? null, null);
  } finally {
    await close(env);
  }
});

test("resolved verifier evidence permits synthesis but the raw verifier runtime Artifact is rejected", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const { left, right, report } = conflict(env, run);
    const verification = env.verifier.schedule({ runId: run.id, createdBy: LEADER });
    assert.equal(verification.status, "scheduled");
    if (verification.status !== "scheduled") return;
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const rawRef = (env.store.getObject(verification.task.id)?.payload.output_artifact_refs as string[])[0]!;
    assert.throws(() => env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [rawRef] }), /Raw verifier Artifact/);
    const verdict = env.verifier.latest(run.id)!;
    const scheduled = env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [left.id, right.id, report.id, verdict.id] });
    assert.equal(scheduled.status, "scheduled");
    await env.supervisor.waitForIdle();
    assert.equal(env.teams.getRun(run.id)?.payload.status, "completed");
    assert.ok(env.synthesis.finalArtifact(run.id));
  } finally {
    await close(env);
  }
});

test("malformed synthesis output creates no canonical final and leaves the Team Run retryable", async () => {
  const env = fixture(new SynthesisRuntime("malformed"));
  try {
    const run = runningRun(env);
    const source = candidate(env, run);
    env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [source.id] });
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const latest = env.teams.getRun(run.id)!;
    assert.equal(latest.payload.status, "synthesizing");
    assert.equal(latest.payload.synthesis_last_outcome, "failed");
    assert.equal(latest.payload.active_synthesis_task_id ?? null, null);
    assert.equal(env.synthesis.finalArtifact(run.id), null);
    assert.match(String(latest.payload.synthesis_failure_reason), /synthesis-final-v1/);
  } finally {
    await close(env);
  }
});

test("synthesis cannot cite an Artifact outside its selected source set", async () => {
  const env = fixture(new SynthesisRuntime("bad_citation"));
  try {
    const run = runningRun(env);
    const source = candidate(env, run);
    env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [source.id] });
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    assert.equal(env.synthesis.finalArtifact(run.id), null);
    assert.match(String(env.teams.getRun(run.id)?.payload.synthesis_failure_reason), /unscoped source Artifact/);
  } finally {
    await close(env);
  }
});

test("synthesis respects Team Run Task capacity before creating a synthesis Task", async () => {
  const env = fixture();
  try {
    const run = runningRun(env, { max_tasks: 1 });
    const managed = env.manager.createWorkerTask({ runId: run.id, createdBy: LEADER, roleTitle: "Researcher", objective: "Create one source", reason: "Need one source", recoveryPolicy: "retry_safe" });
    const result = await env.runner.runNext(managed.worker.id);
    assert.equal(result?.status, "completed");
    const sourceRef = (env.store.getObject(managed.task.id)?.payload.output_artifact_refs as string[])[0]!;
    assert.throws(() => env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [sourceRef] }), /no remaining Task capacity/);
    assert.equal(env.teams.getRun(run.id)?.payload.status, "running");
  } finally {
    await close(env);
  }
});

test("canceling active synthesis creates no final Artifact and keeps the run retryable", async () => {
  const runtime = new BlockingSynthesisRuntime();
  const env = fixture(runtime);
  try {
    const run = runningRun(env);
    const source = candidate(env, run);
    env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [source.id] });
    env.supervisor.start();
    await runtime.started;
    const settled = await env.synthesis.cancel(run.id, LEADER, "Stop finalization");
    await env.supervisor.waitForIdle();
    assert.equal(settled?.outcome, "canceled");
    assert.equal(env.synthesis.finalArtifact(run.id), null);
    assert.equal(env.teams.getRun(run.id)?.payload.status, "synthesizing");
    assert.equal(env.teams.getRun(run.id)?.payload.active_synthesis_task_id ?? null, null);
  } finally {
    await close(env);
  }
});

test("canonical synthesis settlement is idempotent and later scheduling returns the same final Artifact", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const source = candidate(env, run);
    const scheduled = env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [source.id] });
    if (scheduled.status !== "scheduled") throw new Error("expected synthesis Task");
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const first = env.synthesis.reconcileTask(scheduled.task.id)!;
    const second = env.synthesis.reconcileTask(scheduled.task.id)!;
    assert.equal(first.artifact?.id, second.artifact?.id);
    const repeated = env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [source.id] });
    assert.equal(repeated.status, "existing");
    if (repeated.status === "existing") assert.equal(repeated.artifact.id, first.artifact?.id);
    assert.equal(env.synthesis.list(run.id).length, 1);
  } finally {
    await close(env);
  }
});

test("completed but unreconciled synthesis survives database reopen and creates exactly one canonical final", async () => {
  const dbPath = `/tmp/aiverse-synthesis-restart-${randomUUID()}.db`;
  let runId = "";
  let taskId = "";
  {
    const runtime = new SynthesisRuntime("normal", "synthesis-restart");
    const env = fixture(runtime, dbPath, true);
    const run = runningRun(env);
    runId = run.id;
    const source = candidate(env, run);
    const scheduled = env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [source.id] });
    if (scheduled.status !== "scheduled") throw new Error("expected synthesis Task");
    taskId = scheduled.task.id;
    const result = await env.runner.runNext(LEADER);
    assert.equal(result?.status, "completed");
    assert.equal(env.synthesis.finalArtifact(run.id), null);
    env.queue.close();
    env.store.close();
  }
  {
    const runtime = new SynthesisRuntime("normal", "synthesis-restart");
    const env = fixture(runtime, dbPath, false);
    try {
      env.supervisor.start();
      await env.supervisor.waitForIdle();
      assert.equal(env.store.getObject(taskId)?.payload.status, "completed");
      assert.equal(env.teams.getRun(runId)?.payload.status, "completed");
      assert.ok(env.synthesis.finalArtifact(runId));
      assert.equal(env.synthesis.list(runId).length, 1);
    } finally {
      await close(env);
    }
  }
});

test("aggregate Team Run budget exhaustion during synthesis stays terminal and never resurrects the run", async () => {
  const env = fixture(new SynthesisRuntime("aggregate_budget"));
  try {
    const run = runningRun(env, { max_actions: 2, max_tasks: 4 });
    const managed = env.manager.createWorkerTask({ runId: run.id, createdBy: LEADER, roleTitle: "Researcher", objective: "Spend the bounded action budget", reason: "Create source", recoveryPolicy: "retry_safe" });
    const workerResult = await env.runner.runNext(managed.worker.id);
    assert.equal(workerResult?.status, "completed");
    const sourceRef = (env.store.getObject(managed.task.id)?.payload.output_artifact_refs as string[])[0]!;
    env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [sourceRef] });
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    const latest = env.teams.getRun(run.id)!;
    assert.equal(latest.payload.status, "budget_exhausted");
    assert.equal(env.synthesis.finalArtifact(run.id), null);
  } finally {
    await close(env);
  }
});