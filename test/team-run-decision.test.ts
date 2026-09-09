import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunDecisionPolicy } from "../src/team-run-decision.js";
import type { BotManifest } from "../src/types.js";

function bot(
  id = "bot_leader",
  workspaceId = "ws_decision",
  options: {
    canCreateWorkers?: boolean;
    maxParallelWorkers?: number;
    allowedTools?: string[];
    allowedConnections?: string[];
  } = {}
): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: "Adaptive Lead", mission: "Choose the minimum justified collaboration shape." },
    runtime: { adapter: "native" },
    execution: { environment_policy: "shared_workspace", environment_ref: "host-default" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: {
      policy_ref: "adaptive-test",
      allowed_peers: ["*"],
      allowed_tools: options.allowedTools ?? ["*"],
      allowed_connections: options.allowedConnections ?? ["*"],
      can_create_workers: options.canCreateWorkers ?? true
    },
    coordination: {
      default_mode: "direct",
      max_parallel_workers: options.maxParallelWorkers ?? 4,
      max_hops: 6
    }
  };
}

function reasonCodes(result: ReturnType<TeamRunDecisionPolicy["decide"]>): string[] {
  return result.reasons.map((item) => String(item.code));
}

test("simple linear work stays with the durable Bot and records one idempotent decision", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const input = {
    leaderId: "bot_leader",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_simple",
    objective: "Summarize one already-scoped document.",
    work: {
      independentWorkstreams: 1,
      sequentialStages: 1,
      uncertainty: "low" as const,
      verificationNeed: "none" as const
    },
    budget: { max_workers: 3, max_tasks: 4 }
  };
  const first = policy.decide(input);
  const second = policy.decide(input);

  assert.equal(first.mode, "single");
  assert.equal(first.topology, "single");
  assert.equal(first.suggestedWorkerCount, 0);
  assert.equal(first.executionStatus, "ready");
  assert.ok(reasonCodes(first).includes("SIMPLE_LINEAR_WORK"));
  assert.equal(first.artifact.id, second.artifact.id);
  assert.equal(store.listObjects("team_run", "ws_decision").length, 0);
  assert.equal(
    store.listEventsAfter(0, 100).filter((event) => event.event.type === "collaboration.decision_recorded").length,
    1
  );
  store.close();
});

test("independent parallel-safe work selects the minimum bounded parallel panel and opens one auditable Team Run", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const result = policy.decideAndOpen({
    leaderId: "bot_leader",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_parallel",
    objective: "Compare three independent implementation candidates.",
    work: {
      independentWorkstreams: 3,
      parallelSafe: true,
      uncertainty: "medium",
      latencySensitivity: "high"
    },
    requiredConstraints: ["Do not publish externally", "Use only scoped evidence"],
    approvalRequired: true,
    budget: { max_workers: 4, max_tasks: 6, token_limit: 12000, cost_limit: 2 }
  });

  assert.equal(result.mode, "squad");
  assert.equal(result.topology, "parallel_panel");
  assert.equal(result.suggestedWorkerCount, 3);
  assert.ok(result.run);
  assert.equal(result.run!.payload.root_objective_id, "obj_parallel");
  assert.equal(result.run!.payload.decision_artifact_ref, result.artifact.id);
  assert.equal(result.run!.payload.approval_required, true);
  assert.equal((result.run!.payload.budget as Record<string, unknown>).max_workers, 3);
  assert.deepEqual(result.run!.payload.required_constraints, ["Do not publish externally", "Use only scoped evidence"]);
  assert.ok(reasonCodes(result).includes("PARALLEL_WORKSTREAMS"));
  assert.ok(reasonCodes(result).includes("LATENCY_SENSITIVITY_FAVORS_PARALLEL"));

  const reopened = policy.openSelectedRun(result.artifact.id);
  assert.equal(reopened.run!.id, result.run!.id);
  assert.equal(store.listObjects("team_run", "ws_decision").length, 1);
  assert.equal(
    store.listEventsAfter(0, 100).filter((event) => event.event.type === "team_run.created" && event.event.run_id === result.run!.id).length,
    1
  );
  store.close();
});

test("required verification selects one temporary verifier when the durable leader can do the primary work", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const result = policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_verify",
    objective: "Produce one answer that requires an independent correctness check.",
    work: { verificationNeed: "required" },
    budget: { max_workers: 2, max_tasks: 2 }
  });

  assert.equal(result.mode, "squad");
  assert.equal(result.topology, "dynamic_squad");
  assert.equal(result.suggestedWorkerCount, 1);
  assert.ok(reasonCodes(result).includes("VERIFICATION_REQUIRED"));
  store.close();
});

test("high cost sensitivity serializes otherwise parallel work unless latency is explicitly high", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const serial = policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_cost",
    objective: "Inspect three independent candidates under a tight cost preference.",
    work: {
      independentWorkstreams: 3,
      parallelSafe: true,
      costSensitivity: "high",
      latencySensitivity: "medium"
    },
    budget: { max_workers: 4, max_tasks: 5 }
  });
  const parallel = policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_latency",
    objective: "Inspect three independent candidates under a tight latency preference.",
    work: {
      independentWorkstreams: 3,
      parallelSafe: true,
      costSensitivity: "high",
      latencySensitivity: "high"
    },
    budget: { max_workers: 4, max_tasks: 5 }
  });

  assert.equal(serial.topology, "manager");
  assert.equal(serial.suggestedWorkerCount, 1);
  assert.ok(reasonCodes(serial).includes("COST_SENSITIVITY_FAVORS_SERIAL"));
  assert.equal(parallel.topology, "parallel_panel");
  assert.equal(parallel.suggestedWorkerCount, 3);
  store.close();
});

test("bounded discussion and mixed collaboration select group_room and hybrid only when their cumulative budgets support them", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const discussion = policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_discussion",
    objective: "Have two specialist roles challenge one design for one round.",
    work: { discussionNeeded: true, discussionParticipants: 2, discussionRounds: 1 },
    budget: { max_workers: 2, max_tasks: 2, max_messages: 4, max_rounds: 1 }
  });
  const hybrid = policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_hybrid",
    objective: "Compare parallel candidates and then challenge them in a bounded discussion.",
    work: {
      independentWorkstreams: 2,
      parallelSafe: true,
      discussionNeeded: true,
      discussionParticipants: 2,
      discussionRounds: 1
    },
    budget: { max_workers: 4, max_tasks: 5, max_messages: 4, max_rounds: 1 }
  });
  const constrained = policy.decide({
    leaderId: "bot_leader",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_discussion_constrained",
    objective: "Attempt the same discussion with insufficient message budget.",
    work: { discussionNeeded: true, discussionParticipants: 2, discussionRounds: 1 },
    budget: { max_workers: 2, max_tasks: 2, max_messages: 2, max_rounds: 1 }
  });

  assert.equal(discussion.topology, "group_room");
  assert.equal(discussion.suggestedWorkerCount, 2);
  assert.equal(hybrid.topology, "hybrid");
  assert.equal(hybrid.suggestedWorkerCount, 4);
  assert.equal(constrained.topology, "manager");
  assert.ok(reasonCodes(constrained).includes("DISCUSSION_BUDGET_INSUFFICIENT"));
  store.close();
});

test("worker authority or budget denial fails closed to single without opening a Team Run", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot("bot_no_workers", "ws_decision", { canCreateWorkers: false }));
  gateway.createBot(bot("bot_zero_budget"));
  const policy = new TeamRunDecisionPolicy(store);

  const denied = policy.decideAndOpen({
    leaderId: "bot_no_workers",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_denied",
    objective: "Research three independent sources.",
    work: { independentWorkstreams: 3, parallelSafe: true },
    budget: { max_workers: 3, max_tasks: 3 }
  });
  const zero = policy.decideAndOpen({
    leaderId: "bot_zero_budget",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_zero",
    objective: "Research three independent sources.",
    work: { independentWorkstreams: 3, parallelSafe: true },
    budget: { max_workers: 0, max_tasks: 3 }
  });

  assert.equal(denied.mode, "single");
  assert.equal(denied.executionStatus, "degraded");
  assert.equal(denied.run, null);
  assert.ok(reasonCodes(denied).includes("WORKER_CREATION_NOT_AUTHORIZED"));
  assert.equal(zero.mode, "single");
  assert.equal(zero.executionStatus, "degraded");
  assert.equal(zero.run, null);
  assert.ok(reasonCodes(zero).includes("WORKER_BUDGET_UNAVAILABLE"));
  assert.equal(store.listObjects("team_run", "ws_decision").length, 0);
  store.close();
});

test("required capability outside leader authority blocks orchestration instead of expanding Worker permissions", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot("bot_limited", "ws_decision", { allowedTools: ["search"], allowedConnections: ["github"] }));
  const policy = new TeamRunDecisionPolicy(store);

  const result = policy.decideAndOpen({
    leaderId: "bot_limited",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_authority",
    objective: "Use a capability that is not authorized.",
    work: { specialistRoles: 1 },
    requiredTools: ["shell"],
    requiredConnections: ["github"],
    budget: { max_workers: 1, max_tasks: 1 }
  });

  assert.equal(result.mode, "single");
  assert.equal(result.executionStatus, "blocked");
  assert.equal(result.run, null);
  assert.ok(reasonCodes(result).includes("REQUIRED_AUTHORITY_UNAVAILABLE"));
  store.close();
});

test("an existing compatible Team Run for the same root objective is reused even when later signals would choose another topology", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const first = policy.decideAndOpen({
    leaderId: "bot_leader",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_one_run",
    objective: "Compare two independent candidates.",
    work: { independentWorkstreams: 2, parallelSafe: true },
    budget: { max_workers: 2, max_tasks: 3 }
  });
  const second = policy.decideAndOpen({
    leaderId: "bot_leader",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_one_run",
    objective: "Compare two independent candidates.",
    work: { discussionNeeded: true, discussionParticipants: 2, discussionRounds: 1 },
    budget: { max_workers: 2, max_tasks: 3 }
  });

  assert.ok(first.run);
  assert.ok(second.run);
  assert.equal(second.run!.id, first.run!.id);
  assert.equal(second.topology, first.topology);
  assert.ok(reasonCodes(second).includes("EXISTING_OBJECTIVE_RUN_REUSED"));
  assert.equal(store.listObjects("team_run", "ws_decision").length, 1);
  store.close();
});

test("adaptive decision and selected run survive database reopen without duplicate decision or run events", () => {
  const dbPath = resolve(`/tmp/ai-verse-decision-${randomUUID()}.db`);
  rmSync(dbPath, { force: true });
  const input = {
    leaderId: "bot_leader",
    workspaceId: "ws_decision",
    rootObjectiveId: "obj_restart",
    objective: "Compare two independent restart-safe candidates.",
    work: { independentWorkstreams: 2, parallelSafe: true },
    requiredConstraints: ["Remain inside workspace"],
    budget: { max_workers: 2, max_tasks: 3 }
  };

  let decisionId = "";
  let runId = "";
  {
    const store = new CoordinationStore(dbPath);
    const gateway = new CoordinationGateway(store);
    gateway.createBot(bot());
    const policy = new TeamRunDecisionPolicy(store);
    const first = policy.decideAndOpen(input);
    decisionId = first.artifact.id;
    runId = first.run!.id;
    store.close();
  }
  {
    const store = new CoordinationStore(dbPath);
    const policy = new TeamRunDecisionPolicy(store);
    const second = policy.decideAndOpen(input);
    assert.equal(second.artifact.id, decisionId);
    assert.equal(second.run!.id, runId);
    assert.equal(store.listObjects("team_run", "ws_decision").length, 1);
    const events = store.listEventsAfter(0, 100);
    assert.equal(events.filter((event) => event.event.type === "collaboration.decision_recorded").length, 1);
    assert.equal(events.filter((event) => event.event.type === "team_run.created" && event.event.run_id === runId).length, 1);
    store.close();
  }
  rmSync(dbPath, { force: true });
});
