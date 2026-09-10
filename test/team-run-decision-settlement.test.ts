import assert from "node:assert/strict";
import test from "node:test";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunDecisionPolicy } from "../src/team-run-decision.js";
import type { BotManifest } from "../src/types.js";

function bot(): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_settlement_leader",
    name: "Settlement leader",
    kind: "durable",
    status: "active",
    role: { title: "Adaptive Lead", mission: "Choose bounded collaboration safely." },
    runtime: { adapter: "native" },
    execution: { environment_policy: "shared_workspace", environment_ref: "host-default" },
    scope: { type: "workspace", workspace_id: "ws_decision_settlement" },
    permissions: {
      policy_ref: "adaptive-settlement-test",
      allowed_peers: ["*"],
      allowed_tools: ["*"],
      allowed_connections: ["*"],
      can_create_workers: true
    },
    coordination: { default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
  };
}

test("decision Artifact and audit event settle atomically and retry cleanly after an interrupted mutation", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);
  const originalAtomicMutation = store.atomicMutation.bind(store);
  let failOnce = true;
  (store as unknown as { atomicMutation: CoordinationStore["atomicMutation"] }).atomicMutation = (input) => {
    if (failOnce && input.objects.some((object) => object.kind === "artifact" && object.payload.kind === "collaboration_decision")) {
      failOnce = false;
      throw new Error("simulated interrupted decision settlement");
    }
    return originalAtomicMutation(input);
  };

  const input = {
    leaderId: "bot_settlement_leader",
    workspaceId: "ws_decision_settlement",
    rootObjectiveId: "obj_atomic_decision",
    objective: "Compare two independent candidates.",
    work: { independentWorkstreams: 2, parallelSafe: true },
    budget: { max_workers: 2, max_tasks: 2 }
  };

  assert.throws(() => policy.decide(input), /simulated interrupted decision settlement/);
  assert.equal(policy.listDecisions("ws_decision_settlement").length, 0);
  assert.equal(
    store.listEventsAfter(0, 100).filter((event) => event.event.type === "collaboration.decision_recorded").length,
    0
  );

  const retried = policy.decide(input);
  assert.equal(retried.mode, "squad");
  assert.equal(policy.listDecisions("ws_decision_settlement").length, 1);
  assert.equal(
    store.listEventsAfter(0, 100).filter((event) => event.event.type === "collaboration.decision_recorded").length,
    1
  );
  store.close();
});

test("required ownership transfer fails closed when the hop budget cannot execute one handoff", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  gateway.createBot(bot());
  const policy = new TeamRunDecisionPolicy(store);

  const result = policy.decideAndOpen({
    leaderId: "bot_settlement_leader",
    workspaceId: "ws_decision_settlement",
    rootObjectiveId: "obj_no_handoff_hops",
    objective: "Transfer ownership of a scoped task to another run principal.",
    work: { ownershipTransferNeeded: true },
    budget: { max_workers: 1, max_tasks: 1, max_hops: 0 }
  });

  assert.equal(result.mode, "single");
  assert.equal(result.topology, "single");
  assert.equal(result.executionStatus, "blocked");
  assert.equal(result.run, null);
  assert.ok(result.reasons.some((entry) => entry.code === "HANDOFF_HOP_BUDGET_UNAVAILABLE"));
  assert.equal(store.listObjects("team_run", "ws_decision_settlement").length, 0);
  store.close();
});
