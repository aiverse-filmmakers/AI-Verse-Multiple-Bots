import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunDisagreementDetector } from "../src/team-run-disagreement.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest, JsonObject, StoredObject } from "../src/types.js";

function bot(): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_disagreement_hardening_leader",
    name: "Disagreement Hardening Lead",
    kind: "durable",
    status: "active",
    role: { title: "Lead", mission: "Protect structured disagreement state." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_disagreement_hardening" },
    permissions: { policy_ref: "strict", can_create_workers: true },
    coordination: { default_mode: "manager", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture() {
  const store = new CoordinationStore(`/tmp/aiverse-disagreement-hardening-${randomUUID()}.db`);
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const teams = new TeamRunCoordinator(store);
  const detector = new TeamRunDisagreementDetector(teams, gateway);
  return { store, gateway, teams, detector };
}

function runningRun(env: ReturnType<typeof fixture>): StoredObject {
  let run = env.teams.createRun({
    leaderId: "bot_disagreement_hardening_leader",
    workspaceId: "ws_disagreement_hardening",
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Compare bounded candidates.",
    topology: "dynamic_squad",
    budget: { max_tasks: 16, max_actions: 20 }
  }).run;
  run = env.teams.transitionRun(run.id, "planning", "bot_disagreement_hardening_leader").run;
  return env.teams.transitionRun(run.id, "running", "bot_disagreement_hardening_leader").run;
}

function candidate(env: ReturnType<typeof fixture>, run: StoredObject, claims: JsonObject[]): StoredObject {
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
    inline_content: { claims },
    provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] }
  });
}

test("a later compatible subset cannot clear unresolved Team Run verification debt", () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const conflictA = candidate(env, run, [{ subject: "release ready", kind: "fact", value: true }]);
    const conflictB = candidate(env, run, [{ subject: "release ready", kind: "fact", value: false }]);
    const conflict = env.detector.analyze({
      runId: run.id,
      actorId: "bot_disagreement_hardening_leader",
      artifactRefs: [conflictA.id, conflictB.id]
    });
    assert.equal(conflict.requiresVerification, true);

    const compatibleA = candidate(env, run, [{ subject: "database engine", kind: "recommendation", value: "sqlite" }]);
    const compatibleB = candidate(env, run, [{ subject: "database engine", kind: "recommendation", value: "sqlite" }]);
    const compatible = env.detector.analyze({
      runId: run.id,
      actorId: "bot_disagreement_hardening_leader",
      artifactRefs: [compatibleA.id, compatibleB.id]
    });

    assert.equal(compatible.status, "compatible");
    assert.equal(compatible.requiresVerification, false);
    const latestRun = env.teams.getRun(run.id)!;
    assert.equal(latestRun.payload.latest_disagreement_report_ref, compatible.report.id);
    assert.equal(latestRun.payload.requires_verification, true);
    assert.deepEqual(latestRun.payload.verification_required_report_refs, [conflict.report.id]);
  } finally {
    env.store.close();
  }
});

test("latest and list ignore disagreement-report references that belong to another Team Run", () => {
  const env = fixture();
  try {
    const runA = runningRun(env);
    const a = candidate(env, runA, [{ subject: "primary store", kind: "fact", value: "sqlite" }]);
    const b = candidate(env, runA, [{ subject: "primary store", kind: "fact", value: "postgres" }]);
    const reportA = env.detector.analyze({
      runId: runA.id,
      actorId: "bot_disagreement_hardening_leader",
      artifactRefs: [a.id, b.id]
    }).report;

    const runB = runningRun(env);
    env.gateway.record("team_run", {
      ...runB.payload,
      latest_disagreement_report_ref: reportA.id,
      disagreement_report_refs: [reportA.id],
      updated_at: new Date().toISOString()
    });

    assert.equal(env.detector.latest(runB.id), null);
    assert.deepEqual(env.detector.list(runB.id), []);
  } finally {
    env.store.close();
  }
});
