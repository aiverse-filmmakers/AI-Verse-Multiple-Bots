import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BudgetError } from "../src/budget.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunDisagreementDetector } from "../src/team-run-disagreement.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest, JsonObject, StoredObject } from "../src/types.js";

function bot(): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_disagreement_leader",
    name: "Disagreement Lead",
    kind: "durable",
    status: "active",
    role: { title: "Lead", mission: "Coordinate bounded candidate comparison." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_disagreement" },
    permissions: { policy_ref: "strict", can_create_workers: true },
    coordination: { default_mode: "manager", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture(dbPath = `/tmp/aiverse-disagreement-${randomUUID()}.db`, createLeader = true) {
  const store = new CoordinationStore(dbPath);
  const gateway = new CoordinationGateway(store);
  if (createLeader) gateway.createBot(bot());
  const teams = new TeamRunCoordinator(store);
  const detector = new TeamRunDisagreementDetector(teams, gateway);
  return { store, gateway, teams, detector };
}

function createRunningRun(env: ReturnType<typeof fixture>, budget: JsonObject = { max_tasks: 16, max_actions: 20 }) {
  let run = env.teams.createRun({
    leaderId: "bot_disagreement_leader",
    workspaceId: "ws_disagreement",
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Compare candidate conclusions without inventing hidden reasoning.",
    topology: "dynamic_squad",
    budget
  }).run;
  run = env.teams.transitionRun(run.id, "planning", "bot_disagreement_leader", "Prepare structured comparison").run;
  return env.teams.transitionRun(run.id, "running", "bot_disagreement_leader", "Candidate comparison ready").run;
}

function candidate(
  env: ReturnType<typeof fixture>,
  run: StoredObject,
  claims: JsonObject[],
  createdBy = `worker_${randomUUID()}`,
  extra: JsonObject = {}
): StoredObject {
  return env.gateway.record("artifact", {
    schema_version: "1.0",
    id: `art_${randomUUID()}`,
    type: "artifact",
    workspace_id: String(run.payload.workspace_id),
    created_by: createdBy,
    run_id: run.id,
    task_id: null,
    kind: "candidate",
    version: 1,
    content_ref: null,
    inline_content: { claims },
    provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] },
    ...extra
  });
}

function setDefaultCandidates(env: ReturnType<typeof fixture>, runId: string, refs: string[]): StoredObject {
  const run = env.teams.getRun(runId)!;
  return env.gateway.record("team_run", {
    ...run.payload,
    candidate_artifact_refs: refs,
    updated_at: new Date().toISOString()
  });
}

test("same fact with incompatible values creates a high-severity evidence conflict and requires verification", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ id: "claim-db-a", subject: "primary database", kind: "fact", value: "sqlite", confidence: 0.9 }]);
    const b = candidate(env, run, [{ id: "claim-db-b", subject: "Primary   Database", kind: "fact", value: "postgres", confidence: 0.85 }]);
    const result = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id] });

    assert.equal(result.status, "conflict");
    assert.equal(result.requiresVerification, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.kind, "evidence_conflict");
    assert.equal(result.findings[0]?.severity, "high");
    assert.deepEqual(result.findings[0]?.artifact_refs, [a.id, b.id].sort());
    assert.equal(result.report.payload.kind, "disagreement_report");
    assert.equal((result.report.payload.inline_content as any).recommended_action, "verify");
    assert.equal(env.teams.getRun(run.id)?.payload.latest_disagreement_report_ref, result.report.id);
    assert.equal(env.teams.getRun(run.id)?.payload.requires_verification, true);
  } finally {
    env.store.close();
  }
});

test("different recommendations remain compatible unless the candidates declare them mutually exclusive", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ subject: "deployment strategy", kind: "recommendation", value: "blue-green", confidence: 0.8 }]);
    const b = candidate(env, run, [{ subject: "deployment strategy", kind: "recommendation", value: "canary", confidence: 0.75 }]);
    const compatible = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id] });
    assert.equal(compatible.status, "compatible");
    assert.equal(compatible.requiresVerification, false);
    assert.equal(compatible.findings.length, 0);
    assert.deepEqual((compatible.report.payload.inline_content as any).compatible_subjects, ["deployment strategy"]);

    const c = candidate(env, run, [{ subject: "primary deployment", kind: "recommendation", value: "blue-green", exclusive_group: "primary-release-mode" }]);
    const d = candidate(env, run, [{ subject: "primary deployment", kind: "recommendation", value: "canary", exclusive_group: "primary-release-mode" }]);
    const conflict = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [c.id, d.id] });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.findings[0]?.kind, "incompatible_recommendation");
    assert.equal(conflict.findings[0]?.rationale_code, "exclusive_recommendations_differ");
  } finally {
    env.store.close();
  }
});

test("opposed stances on the same declared claim are a contradiction", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ subject: "ship this week", kind: "opinion", value: true, stance: "support" }]);
    const b = candidate(env, run, [{ subject: "ship this week", kind: "opinion", value: true, stance: "oppose" }]);
    const result = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id] });
    assert.equal(result.status, "conflict");
    assert.equal(result.findings[0]?.kind, "contradiction");
    assert.equal(result.findings[0]?.rationale_code, "opposed_stance_same_claim");
  } finally {
    env.store.close();
  }
});

test("same conclusion with a material confidence gap is surfaced without forcing verifier work", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ subject: "migration is reversible", kind: "fact", value: true, confidence: 0.95 }]);
    const b = candidate(env, run, [{ subject: "migration is reversible", kind: "fact", value: true, confidence: 0.45 }]);
    const result = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id], confidenceGapThreshold: 0.35 });
    assert.equal(result.status, "confidence_gap");
    assert.equal(result.requiresVerification, false);
    assert.equal(result.findings[0]?.kind, "confidence_gap");
    assert.equal(result.findings[0]?.confidence_delta, 0.5);
    assert.equal((result.report.payload.inline_content as any).recommended_action, "review_confidence");
  } finally {
    env.store.close();
  }
});

test("estimate differences become evidence conflicts only when they exceed declared tolerance", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ subject: "monthly cost", kind: "estimate", value: 100, tolerance: 5 }]);
    const b = candidate(env, run, [{ subject: "monthly cost", kind: "estimate", value: 120, tolerance: 5 }]);
    const conflict = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id] });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.findings[0]?.rationale_code, "estimate_gap_exceeds_declared_tolerance");

    const c = candidate(env, run, [{ subject: "latency", kind: "estimate", value: 100, tolerance: 10 }]);
    const d = candidate(env, run, [{ subject: "latency", kind: "estimate", value: 107, tolerance: 10 }]);
    const compatible = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [c.id, d.id] });
    assert.equal(compatible.status, "compatible");
  } finally {
    env.store.close();
  }
});

test("unstructured or non-comparable candidates report insufficient evidence instead of hallucinating disagreement", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ kind: "fact", value: true }]);
    const b = candidate(env, run, [{ subject: "different subject", kind: "opinion", value: "maybe" }]);
    const result = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id] });
    const inline = result.report.payload.inline_content as any;
    assert.equal(result.status, "insufficient_evidence");
    assert.equal(result.requiresVerification, false);
    assert.equal(inline.comparable_pair_count, 0);
    assert.equal(inline.invalid_claims.length, 1);
    assert.equal(inline.recommended_action, "collect_more_evidence");
  } finally {
    env.store.close();
  }
});

test("candidate scope and bounded input ceilings fail closed before a disagreement report is created", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env, { max_tasks: 2, max_actions: 10 });
    const a = candidate(env, run, [{ subject: "scope", kind: "fact", value: 1 }]);
    const b = candidate(env, run, [{ subject: "scope", kind: "fact", value: 2 }]);
    const c = candidate(env, run, [{ subject: "scope", kind: "fact", value: 3 }]);
    assert.throws(
      () => env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id, c.id] }),
      (error: unknown) => error instanceof BudgetError && error.code === "DISAGREEMENT_INPUT_LIMIT"
    );

    const otherRun = createRunningRun(env);
    const foreign = candidate(env, otherRun, [{ subject: "scope", kind: "fact", value: 2 }]);
    assert.throws(
      () => env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, foreign.id] }),
      /outside Team Run/
    );
    assert.equal(env.store.listObjects("artifact", "ws_disagreement").filter((artifact) => artifact.payload.kind === "disagreement_report").length, 0);
  } finally {
    env.store.close();
  }
});

test("identical analysis is deterministic and idempotent across repeated calls", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ subject: "cache", kind: "constraint", value: "required" }]);
    const b = candidate(env, run, [{ subject: "cache", kind: "constraint", value: "optional" }]);
    const first = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [b.id, a.id] });
    const second = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id] });
    assert.equal(second.report.id, first.report.id);
    assert.equal(env.detector.list(run.id).length, 1);
    assert.equal(env.teams.getRun(run.id)?.payload.disagreement_report_refs instanceof Array, true);
    assert.equal((env.teams.getRun(run.id)?.payload.disagreement_report_refs as string[]).length, 1);
    const events = env.store.listEventsAfter(0, 500).filter((entry) => entry.event.type === "disagreement.analyzed" && entry.event.run_id === run.id);
    assert.equal(events.length, 1);
  } finally {
    env.store.close();
  }
});

test("default candidate refs and persisted disagreement report survive database reopen", () => {
  const dbPath = `/tmp/aiverse-disagreement-reopen-${randomUUID()}.db`;
  let runId = "";
  let reportId = "";
  {
    const env = fixture(dbPath, true);
    const run = createRunningRun(env);
    runId = run.id;
    const a = candidate(env, run, [{ subject: "release blocker", kind: "fact", value: false, confidence: 0.9 }]);
    const b = candidate(env, run, [{ subject: "release blocker", kind: "fact", value: true, confidence: 0.8 }]);
    setDefaultCandidates(env, run.id, [a.id, b.id]);
    const result = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader" });
    reportId = result.report.id;
    assert.equal(result.status, "conflict");
    env.store.close();
  }
  {
    const env = fixture(dbPath, false);
    try {
      const report = env.detector.latest(runId);
      assert.equal(report?.id, reportId);
      assert.equal(report?.payload.kind, "disagreement_report");
      assert.equal((report?.payload.inline_content as any)?.status, "conflict");
      assert.equal(env.teams.getRun(runId)?.payload.latest_disagreement_report_ref, reportId);
      assert.equal(env.detector.list(runId).length, 1);
    } finally {
      env.store.close();
    }
  }
});
