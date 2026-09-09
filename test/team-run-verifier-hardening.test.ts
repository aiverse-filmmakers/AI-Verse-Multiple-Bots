import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { BotRunner } from "../src/runner.js";
import { RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import { TeamRunVerifier } from "../src/team-run-verifier.js";
import type { BotManifest, StoredObject } from "../src/types.js";

class ScopedVerdictRuntime implements RuntimeAdapter {
  readonly id = "verifier-hardening";
  foreignEvidenceRef: string | null = null;

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    const reports = context.inputArtifacts.filter((artifact) => artifact.payload.kind === "disagreement_report");
    return {
      summary: "Scoped verifier verdict",
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
              conclusion: "Claimed resolved by cited evidence.",
              evidence_artifact_refs: [this.foreignEvidenceRef ?? finding.artifact_refs[0]]
            }))
          };
        })
      },
      usage: { actions: 1 }
    };
  }
}

function bot(adapter: string): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_verifier_hardening_leader",
    name: "Verifier Hardening Lead",
    kind: "durable",
    status: "active",
    role: { title: "Lead", mission: "Protect verifier authority and scope." },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace", persistence: "durable" },
    scope: { type: "workspace", workspace_id: "ws_verifier_hardening" },
    permissions: { policy_ref: "strict", can_create_workers: true, allowed_tools: [], allowed_connections: [] },
    coordination: { default_mode: "manager", max_parallel_workers: 2, max_hops: 6 }
  };
}

function fixture(runtime = new ScopedVerdictRuntime()) {
  const store = new CoordinationStore(`/tmp/aiverse-verifier-hardening-${randomUUID()}.db`);
  const queue = new ExecutionQueue(store.dbPath);
  const gateway = new CoordinationGateway(store, queue);
  gateway.createBot(bot(runtime.id));
  const teams = new TeamRunCoordinator(store);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 50);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
  const verifier = new TeamRunVerifier(teams, gateway, queue, runner);
  return { store, queue, gateway, teams, runner, supervisor, verifier, runtime };
}

function runningRun(env: ReturnType<typeof fixture>, maxWorkers = 4): StoredObject {
  let run = env.teams.createRun({
    leaderId: "bot_verifier_hardening_leader",
    workspaceId: "ws_verifier_hardening",
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Verify one bounded conflict.",
    topology: "dynamic_squad",
    budget: { max_workers: maxWorkers, max_tasks: 8, max_actions: 10 }
  }).run;
  run = env.teams.transitionRun(run.id, "planning", "bot_verifier_hardening_leader").run;
  return env.teams.transitionRun(run.id, "running", "bot_verifier_hardening_leader").run;
}

function artifact(env: ReturnType<typeof fixture>, run: StoredObject, kind = "candidate"): StoredObject {
  return env.gateway.record("artifact", {
    schema_version: "1.0",
    id: `art_${randomUUID()}`,
    type: "artifact",
    workspace_id: String(run.payload.workspace_id),
    created_by: `worker_${randomUUID()}`,
    run_id: run.id,
    task_id: null,
    kind,
    version: 1,
    content_ref: null,
    inline_content: {},
    provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] }
  });
}

function addDebt(env: ReturnType<typeof fixture>, run: StoredObject): StoredObject {
  const left = artifact(env, run);
  const right = artifact(env, run);
  const report = env.gateway.record("artifact", {
    schema_version: "1.0",
    id: `art_disagreement_${randomUUID().replaceAll("-", "")}`,
    type: "artifact",
    workspace_id: String(run.payload.workspace_id),
    created_by: "bot_verifier_hardening_leader",
    run_id: run.id,
    task_id: null,
    kind: "disagreement_report",
    version: 1,
    content_ref: null,
    source_artifact_refs: [left.id, right.id],
    inline_content: {
      contract: "disagreement-report-v1",
      status: "conflict",
      requires_verification: true,
      source_artifact_refs: [left.id, right.id],
      findings: [{ finding_id: `finding_${randomUUID()}`, kind: "evidence_conflict", artifact_refs: [left.id, right.id], claim_refs: ["a", "b"] }]
    },
    provenance: { origin: "runtime_tool", trusted_instruction: false, source_refs: [left.id, right.id] }
  });
  const latest = env.teams.getRun(run.id)!;
  env.gateway.record("team_run", {
    ...latest.payload,
    verification_required_report_refs: [report.id],
    requires_verification: true,
    disagreement_report_refs: [report.id],
    latest_disagreement_report_ref: report.id,
    updated_at: new Date().toISOString()
  });
  return report;
}

async function close(env: ReturnType<typeof fixture>): Promise<void> {
  await env.supervisor.stop();
  env.queue.close();
  env.store.close();
}

test("cross-TeamRun resolution evidence fails closed and cannot clear verification debt", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const report = addDebt(env, run);
    const otherRun = runningRun(env);
    const foreign = artifact(env, otherRun);
    env.runtime.foreignEvidenceRef = foreign.id;

    env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_hardening_leader" });
    env.supervisor.start();
    await env.supervisor.waitForIdle();

    const verdict = env.verifier.latest(run.id)!;
    assert.equal((verdict.payload.inline_content as any).outcome, "verifier_failed");
    assert.match(String((verdict.payload.inline_content as any).failure_reason), /escaped Team Run/);
    assert.deepEqual(env.teams.getRun(run.id)?.payload.verification_required_report_refs, [report.id]);
    assert.equal(env.teams.getRun(run.id)?.payload.requires_verification, true);
  } finally {
    await close(env);
  }
});

test("exhausted Team Run Worker capacity blocks verifier scheduling before verifier records are created", async () => {
  const env = fixture();
  try {
    const run = runningRun(env, 1);
    addDebt(env, run);
    env.teams.createWorker({
      runId: run.id,
      createdBy: "bot_verifier_hardening_leader",
      roleTitle: "Existing Worker",
      objective: "Consume the only temporary Worker slot."
    });
    const beforeTasks = env.store.listObjects("task", "ws_verifier_hardening").length;
    const beforeLeases = env.store.listObjects("capability_lease", "ws_verifier_hardening").length;

    assert.throws(
      () => env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_hardening_leader" }),
      /no remaining temporary Worker capacity/
    );
    assert.equal(env.teams.listWorkers(run.id).length, 1);
    assert.equal(env.store.listObjects("task", "ws_verifier_hardening").length, beforeTasks);
    assert.equal(env.store.listObjects("capability_lease", "ws_verifier_hardening").length, beforeLeases);
    assert.equal(env.teams.getRun(run.id)?.payload.requires_verification, true);
  } finally {
    await close(env);
  }
});

test("verifier Worker inherits the leader execution policy by default", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    addDebt(env, run);
    const scheduled = env.verifier.schedule({ runId: run.id, createdBy: "bot_verifier_hardening_leader" });
    assert.equal(scheduled.status, "scheduled");
    if (scheduled.status !== "scheduled") return;
    assert.equal((scheduled.worker.payload.execution as any).environment_policy, "shared_workspace");
    assert.equal((scheduled.worker.payload.execution as any).persistence, "durable");
  } finally {
    await close(env);
  }
});

test("verifier execution override cannot change the leader environment policy", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    addDebt(env, run);
    assert.throws(
      () => env.verifier.schedule({
        runId: run.id,
        createdBy: "bot_verifier_hardening_leader",
        execution: { environment_policy: "isolated_run" }
      }),
      /cannot change leader environment policy/
    );
    assert.equal(env.teams.listWorkers(run.id).length, 0);
    assert.equal(env.store.listObjects("task", "ws_verifier_hardening").filter((task) => task.payload.run_id === run.id).length, 0);
  } finally {
    await close(env);
  }
});
