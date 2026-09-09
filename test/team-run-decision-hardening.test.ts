import assert from "node:assert/strict";
import test from "node:test";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunDecisionPolicy } from "../src/team-run-decision.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest, JsonObject } from "../src/types.js";

function bot(id = "bot_leader", workspaceId = "ws_decision_hardening"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: "Adaptive Lead", mission: "Choose bounded collaboration." },
    runtime: { adapter: "native" },
    execution: { environment_policy: "shared_workspace", environment_ref: "host-default" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: {
      policy_ref: "adaptive-hardening",
      allowed_peers: ["*"],
      allowed_tools: ["search", "read"],
      allowed_connections: ["github"],
      can_create_workers: true
    },
    coordination: { default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
  };
}

function codes(result: ReturnType<TeamRunDecisionPolicy["decide"]>): string[] {
  return result.reasons.map((entry) => String(entry.code));
}

test("parallel work plus required verification reserves a separate lifetime Worker identity for the verifier", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const result = policy.decideAndOpen({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_parallel_verify",
    objective: "Generate two independent candidates and verify the result.",
    work: { independentWorkstreams: 2, parallelSafe: true, verificationNeed: "required" },
    budget: { max_workers: 3, max_tasks: 3 }
  });

  assert.equal(result.topology, "dynamic_squad");
  assert.equal(result.executionStatus, "ready");
  assert.equal(result.suggestedWorkerCount, 3);
  assert.equal((result.run!.payload.budget as JsonObject).max_workers, 3);
  assert.ok(codes(result).includes("PARALLEL_WORKSTREAMS"));
  assert.ok(codes(result).includes("VERIFICATION_REQUIRED"));
  store.close();
});

test("required verification is never stranded by fan-out when lifetime Worker capacity is too small", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const result = policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_verify_priority",
    objective: "Compare two candidates but preserve independent verification.",
    work: { independentWorkstreams: 2, parallelSafe: true, verificationNeed: "required" },
    budget: { max_workers: 2, max_tasks: 3 }
  });

  assert.equal(result.topology, "dynamic_squad");
  assert.equal(result.executionStatus, "degraded");
  assert.equal(result.suggestedWorkerCount, 1);
  assert.ok(codes(result).includes("PARALLEL_DROPPED_FOR_VERIFICATION_CAPACITY"));
  assert.ok(codes(result).includes("VERIFICATION_REQUIRED"));
  store.close();
});

test("discussion plus required verification accounts for discussion participants and a later verifier cumulatively", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const result = policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_discussion_verify",
    objective: "Have two roles challenge the answer, then verify the settled evidence.",
    work: {
      discussionNeeded: true,
      discussionParticipants: 2,
      discussionRounds: 1,
      verificationNeed: "required"
    },
    budget: { max_workers: 3, max_tasks: 3, max_messages: 4, max_rounds: 1 }
  });

  assert.equal(result.topology, "hybrid");
  assert.equal(result.executionStatus, "ready");
  assert.equal(result.suggestedWorkerCount, 3);
  assert.ok(codes(result).includes("DISCUSSION_REQUIRED"));
  assert.ok(codes(result).includes("VERIFICATION_REQUIRED"));
  store.close();
});

test("serial manager planning reserves cumulative identities for distinct sequential stages", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const result = policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_stages",
    objective: "Run three sequential stages with bounded helpers.",
    work: { sequentialStages: 3 },
    budget: { max_workers: 3, max_tasks: 3 }
  });

  assert.equal(result.topology, "manager");
  assert.equal(result.suggestedWorkerCount, 2);
  assert.ok(codes(result).includes("SEQUENTIAL_STAGES"));
  store.close();
});

test("existing Team Run reuse fails closed when current immutable constraints, approval, or budget are tighter", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  policy.decideAndOpen({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_boundary",
    objective: "Compare two bounded candidates.",
    work: { independentWorkstreams: 2, parallelSafe: true },
    requiredConstraints: ["Stay local"],
    requiredTools: ["search"],
    budget: { max_workers: 2, max_tasks: 4 }
  });

  assert.throws(() => policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_boundary",
    objective: "Compare two bounded candidates.",
    work: { independentWorkstreams: 2, parallelSafe: true },
    requiredConstraints: ["Stay local", "No external publication"],
    requiredTools: ["search"],
    budget: { max_workers: 2, max_tasks: 4 }
  }), /does not preserve all current immutable constraints/);

  assert.throws(() => policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_boundary",
    objective: "Compare two bounded candidates.",
    work: { independentWorkstreams: 2, parallelSafe: true },
    requiredConstraints: ["Stay local"],
    requiredTools: ["search"],
    approvalRequired: true,
    budget: { max_workers: 2, max_tasks: 4 }
  }), /does not preserve the current approval requirement/);

  assert.throws(() => policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_boundary",
    objective: "Compare two bounded candidates.",
    work: { independentWorkstreams: 2, parallelSafe: true },
    requiredConstraints: ["Stay local"],
    requiredTools: ["search"],
    budget: { max_workers: 1, max_tasks: 4 }
  }), /broader max_workers boundary/);

  assert.equal(store.listObjects("team_run", "ws_decision_hardening").length, 1);
  store.close();
});

test("poisoned collaboration decision Artifact fails validation before a Team Run can open", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const result = policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_poison",
    objective: "Compare two candidates.",
    work: { independentWorkstreams: 2, parallelSafe: true },
    budget: { max_workers: 2, max_tasks: 2 }
  });
  const poisonedDecision = {
    ...(result.artifact.payload.decision as JsonObject),
    topology: "pipeline"
  };
  store.putObject("artifact", {
    ...result.artifact.payload,
    decision: poisonedDecision
  });

  assert.throws(() => policy.openSelectedRun(result.artifact.id), /decision\.topology is unsupported/);
  assert.equal(store.listObjects("team_run", "ws_decision_hardening").length, 0);
  store.close();
});

test("multiple Team Runs for one root objective are treated as an orchestration-loop inconsistency", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const teams = new TeamRunCoordinator(store);
  teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_duplicate",
    objective: "First run.",
    topology: "manager",
    budget: { max_workers: 1 }
  });
  teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_duplicate",
    objective: "Second run.",
    topology: "manager",
    budget: { max_workers: 1 }
  });
  const policy = new TeamRunDecisionPolicy(store);

  assert.throws(() => policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision_hardening",
    rootObjectiveId: "obj_duplicate",
    objective: "Do not create a third run.",
    work: { specialistRoles: 1 },
    budget: { max_workers: 1 }
  }), /already has multiple Team Runs/);
  assert.equal(store.listObjects("team_run", "ws_decision_hardening").length, 2);
  store.close();
});
