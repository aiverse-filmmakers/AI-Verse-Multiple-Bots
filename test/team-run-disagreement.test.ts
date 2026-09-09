import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BudgetError } from "../src/budget.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { createGatewayServer } from "../src/server.js";
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
    role: { title: "Disagreement Lead", mission: "Compare bounded candidate conclusions." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_disagreement" },
    permissions: {
      policy_ref: "strict",
      allowed_peers: ["*"],
      allowed_tools: [],
      allowed_connections: [],
      can_create_workers: true,
      can_handoff: true
    },
    coordination: { default_mode: "manager", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture(dbPath = `/tmp/aiverse-disagreement-${randomUUID()}.db`, createLeader = true) {
  const store = new CoordinationStore(dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, undefined, policy);
  if (createLeader) gateway.createBot(bot());
  const teams = new TeamRunCoordinator(store, gateway, policy);
  const detector = new TeamRunDisagreementDetector(teams, gateway);
  return { store, policy, gateway, teams, detector };
}

function createRunningRun(env: ReturnType<typeof fixture>) {
  let run = env.teams.createRun({
    createdBy: "bot_disagreement_leader",
    leaderId: "bot_disagreement_leader",
    workspaceId: "ws_disagreement",
    rootObjectiveId: `obj_${randomUUID()}`,
    topology: "dynamic_squad",
    budget: { max_tasks: 16, max_actions: 20 }
  }).run;
  run = env.teams.transitionRun(run.id, "planning", "bot_disagreement_leader", "Prepare candidate comparison").object;
  return env.teams.transitionRun(run.id, "running", "bot_disagreement_leader", "Candidates ready").object;
}

function candidate(env: ReturnType<typeof fixture>, run: StoredObject, claims: JsonObject[], createdBy = `worker_${randomUUID()}`): StoredObject {
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
    provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] }
  });
}

function setDefaultCandidates(env: ReturnType<typeof fixture>, runId: string, refs: string[]): void {
  const run = env.teams.getRun(runId)!;
  env.gateway.record("team_run", {
    ...run.payload,
    candidate_artifact_refs: refs,
    updated_at: new Date().toISOString()
  });
}

test("same fact with incompatible values creates deterministic evidence conflict and persistent verification debt", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ id: "db-a", subject: "Primary Database", kind: "fact", value: "sqlite", confidence: 0.9 }]);
    const b = candidate(env, run, [{ id: "db-b", subject: " primary   database ", kind: "fact", value: "postgres", confidence: 0.85 }]);
    const result = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id] });

    assert.equal(result.status, "conflict");
    assert.equal(result.requiresVerification, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.kind, "evidence_conflict");
    assert.equal(result.findings[0]?.severity, "high");
    assert.ok(result.findings[0]?.claim_refs.every((ref) => ref.startsWith("art_")));
    assert.equal(result.report.payload.kind, "disagreement_report");
    assert.equal((result.report.payload.inline_content as any).recommended_action, "verify");
    assert.equal(env.teams.getRun(run.id)?.payload.latest_disagreement_report_ref, result.report.id);
    assert.equal(env.teams.getRun(run.id)?.payload.requires_verification, true);
    assert.deepEqual(env.detector.verificationDebt(run.id).map((report) => report.id), [result.report.id]);
  } finally {
    env.store.close();
  }
});

test("different recommendations stay compatible unless explicit metadata says they are mutually exclusive", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ subject: "deployment strategy", kind: "recommendation", value: "blue-green" }]);
    const b = candidate(env, run, [{ subject: "deployment strategy", kind: "recommendation", value: "canary" }]);
    const compatible = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id] });
    assert.equal(compatible.status, "compatible");
    assert.equal(compatible.requiresVerification, false);
    assert.equal(compatible.findings.length, 0);

    const c = candidate(env, run, [{ subject: "primary deployment", kind: "recommendation", value: "blue-green", exclusive_group: "release-mode" }]);
    const d = candidate(env, run, [{ subject: "primary deployment", kind: "recommendation", value: "canary", exclusive_group: "release-mode" }]);
    const conflict = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [c.id, d.id] });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.findings[0]?.kind, "incompatible_recommendation");
    assert.equal(conflict.findings[0]?.rationale_code, "exclusive_recommendations_differ");
  } finally {
    env.store.close();
  }
});

test("confidence gaps are surfaced without pretending a hard contradiction exists", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ subject: "migration reversible", kind: "fact", value: true, confidence: 0.95 }]);
    const b = candidate(env, run, [{ subject: "migration reversible", kind: "fact", value: true, confidence: 0.45 }]);
    const result = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id] });
    assert.equal(result.status, "confidence_gap");
    assert.equal(result.requiresVerification, false);
    assert.equal(result.findings[0]?.kind, "confidence_gap");
    assert.equal(result.findings[0]?.confidence_delta, 0.5);
    assert.equal((result.report.payload.inline_content as any).recommended_action, "review_confidence");
  } finally {
    env.store.close();
  }
});

test("estimate conflict requires an explicit tolerance and never invents one", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ subject: "monthly cost", kind: "estimate", value: 100 }]);
    const b = candidate(env, run, [{ subject: "monthly cost", kind: "estimate", value: 150 }]);
    assert.equal(env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id] }).status, "compatible");

    const c = candidate(env, run, [{ subject: "monthly latency", kind: "estimate", value: 100, tolerance: 5 }]);
    const d = candidate(env, run, [{ subject: "monthly latency", kind: "estimate", value: 120 }]);
    const conflict = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [c.id, d.id] });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.findings[0]?.rationale_code, "estimate_gap_exceeds_declared_tolerance");
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

test("scope and explicit comparison ceilings fail closed before a report is created", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const a = candidate(env, run, [{ subject: "scope", kind: "fact", value: 1 }]);
    const b = candidate(env, run, [{ subject: "scope", kind: "fact", value: 2 }]);
    const c = candidate(env, run, [{ subject: "scope", kind: "fact", value: 3 }]);
    assert.throws(
      () => env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id, c.id], maxArtifacts: 2 }),
      (error: unknown) => error instanceof BudgetError && error.code === "DISAGREEMENT_INPUT_LIMIT"
    );

    const otherRun = createRunningRun(env);
    const foreign = candidate(env, otherRun, [{ subject: "scope", kind: "fact", value: 2 }]);
    assert.throws(
      () => env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [a.id, foreign.id] }),
      /outside Team Run/
    );
    assert.equal(env.detector.list(run.id).length, 0);
  } finally {
    env.store.close();
  }
});

test("identical comparison is deterministic/idempotent and later compatible analysis cannot clear earlier verification debt", () => {
  const env = fixture();
  try {
    const run = createRunningRun(env);
    const conflictA = candidate(env, run, [{ subject: "release ready", kind: "fact", value: true }]);
    const conflictB = candidate(env, run, [{ subject: "release ready", kind: "fact", value: false }]);
    const first = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [conflictB.id, conflictA.id] });
    const repeat = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [conflictA.id, conflictB.id] });
    assert.equal(repeat.report.id, first.report.id);
    assert.equal(env.detector.list(run.id).length, 1);
    assert.equal(env.store.listEventsAfter(0, 500).filter((entry) => entry.event.type === "disagreement.analyzed" && entry.event.run_id === run.id).length, 1);

    const compatibleA = candidate(env, run, [{ subject: "database engine", kind: "recommendation", value: "sqlite" }]);
    const compatibleB = candidate(env, run, [{ subject: "database engine", kind: "recommendation", value: "sqlite" }]);
    const compatible = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader", artifactRefs: [compatibleA.id, compatibleB.id] });
    assert.equal(compatible.status, "compatible");
    assert.equal(env.teams.getRun(run.id)?.payload.requires_verification, true);
    assert.deepEqual(env.detector.verificationDebt(run.id).map((report) => report.id), [first.report.id]);
  } finally {
    env.store.close();
  }
});

test("default candidate references and disagreement report survive database reopen", () => {
  const dbPath = `/tmp/aiverse-disagreement-reopen-${randomUUID()}.db`;
  let runId = "";
  let reportId = "";
  {
    const env = fixture(dbPath, true);
    const run = createRunningRun(env);
    runId = run.id;
    const a = candidate(env, run, [{ subject: "release blocker", kind: "fact", value: false }]);
    const b = candidate(env, run, [{ subject: "release blocker", kind: "fact", value: true }]);
    setDefaultCandidates(env, run.id, [a.id, b.id]);
    const result = env.detector.analyze({ runId: run.id, actorId: "bot_disagreement_leader" });
    reportId = result.report.id;
    env.store.close();
  }
  {
    const env = fixture(dbPath, false);
    try {
      assert.equal(env.detector.latest(runId)?.id, reportId);
      assert.equal((env.detector.latest(runId)?.payload.inline_content as any)?.status, "conflict");
      assert.equal(env.detector.list(runId).length, 1);
      assert.equal(env.detector.verificationDebt(runId).length, 1);
    } finally {
      env.store.close();
    }
  }
});

test("HTTP Gateway exposes explicit disagreement analysis plus latest/list report inspection", async () => {
  const app = createGatewayServer({ dbPath: `/tmp/aiverse-disagreement-http-${randomUUID()}.db`, port: 0 });
  try {
    app.gateway.createBot(bot());
    let run = app.teamRuns.createRun({
      createdBy: "bot_disagreement_leader",
      leaderId: "bot_disagreement_leader",
      workspaceId: "ws_disagreement",
      rootObjectiveId: `obj_${randomUUID()}`,
      topology: "dynamic_squad"
    }).run;
    run = app.teamRuns.transitionRun(run.id, "planning", "bot_disagreement_leader").object;
    run = app.teamRuns.transitionRun(run.id, "running", "bot_disagreement_leader").object;
    const a = app.gateway.record("artifact", {
      schema_version: "1.0", id: `art_${randomUUID()}`, type: "artifact", workspace_id: "ws_disagreement", created_by: "worker_http_a", run_id: run.id, task_id: null, kind: "candidate", version: 1, content_ref: null,
      inline_content: { claims: [{ subject: "ship", kind: "fact", value: true }] }, provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] }
    });
    const b = app.gateway.record("artifact", {
      schema_version: "1.0", id: `art_${randomUUID()}`, type: "artifact", workspace_id: "ws_disagreement", created_by: "worker_http_b", run_id: run.id, task_id: null, kind: "candidate", version: 1, content_ref: null,
      inline_content: { claims: [{ subject: "ship", kind: "fact", value: false }] }, provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] }
    });
    const address = await app.listen();
    const base = `http://${address.host}:${address.port}`;
    const analyzed = await fetch(`${base}/v1/team-runs/${encodeURIComponent(run.id)}/disagreement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId: "bot_disagreement_leader", artifactRefs: [a.id, b.id] })
    });
    assert.equal(analyzed.status, 201);
    const analysisBody = await analyzed.json() as any;
    assert.equal(analysisBody.status, "conflict");
    assert.equal(analysisBody.requiresVerification, true);

    const inspected = await fetch(`${base}/v1/team-runs/${encodeURIComponent(run.id)}/disagreement`);
    assert.equal(inspected.status, 200);
    const inspectBody = await inspected.json() as any;
    assert.equal(inspectBody.latest.id, analysisBody.report.id);
    assert.equal(inspectBody.reports.length, 1);
    assert.equal(inspectBody.verificationDebt.length, 1);
  } finally {
    await app.close();
  }
});
