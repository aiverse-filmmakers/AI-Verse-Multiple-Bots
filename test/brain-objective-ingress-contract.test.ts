import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_VERSE_BRAIN_OBJECTIVE_PROVIDER,
  BrainObjectiveIngress,
  BrainObjectiveIngressError,
  brainRootObjectiveId,
  type BrainObjectiveIngressInput,
  type BrainObjectiveProjection,
  type BrainObjectiveSource
} from "../src/brain-objective-ingress.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest, JsonObject } from "../src/types.js";

const WORKSPACE_ID = "ws_contract";
const OBJECTIVE_ID = "objective-contract";
const INTENT_DIGEST = "a".repeat(64);

class FixedBrainSource implements BrainObjectiveSource {
  project(workspaceId: string, objectiveId: string): BrainObjectiveProjection {
    assert.equal(workspaceId, WORKSPACE_ID);
    assert.equal(objectiveId, OBJECTIVE_ID);
    return {
      schema_version: "1.0",
      provider: AI_VERSE_BRAIN_OBJECTIVE_PROVIDER,
      workspace_id: WORKSPACE_ID,
      objective_id: OBJECTIVE_ID,
      objective_status: "READY",
      root_objective_id: brainRootObjectiveId(OBJECTIVE_ID, INTENT_DIGEST),
      intent_digest: INTENT_DIGEST,
      projected_at: "2026-09-10T12:00:00Z",
      source: {
        ref: `brain:objective:${OBJECTIVE_ID}`,
        kind: "objective",
        object_id: OBJECTIVE_ID,
        revision: 1,
        source_digest: "b".repeat(64),
        status: "READY"
      },
      parent_source: {
        ref: "brain:initiative:initiative-contract",
        kind: "initiative",
        object_id: "initiative-contract",
        revision: 1,
        source_digest: "c".repeat(64),
        status: "ACTIVE"
      },
      data: {
        objective: "Deliver the approved contract",
        criteria: [{ id: "criterion-1", statement: "Delivery exists", required_evidence: null, status: "unverified" }],
        verification_level: "V2",
        constraints: ["Do not publish"],
        boundaries: ["Stay in scope"],
        stop_conditions: ["Stop on brief change"],
        dependencies: [],
        risks: [],
        brain_budget: {},
        serves_ref: "initiative:initiative-contract",
        parent: {
          kind: "initiative",
          ref: "brain:initiative:initiative-contract",
          outcome: "Ship safely",
          hypothesis: "The approved plan is sufficient",
          next_action: "Deliver"
        }
      }
    };
  }
}

function leader(): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_contract-leader",
    name: "Contract Leader",
    kind: "durable",
    status: "active",
    role: { title: "Delivery Lead", mission: "Execute the bounded objective." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: WORKSPACE_ID },
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: ["*"],
      allowed_tools: ["read-local"],
      allowed_connections: ["drive"]
    },
    coordination: { default_mode: "direct", can_create_workers: true }
  };
}

function cloneInput(input: BrainObjectiveIngressInput): BrainObjectiveIngressInput {
  return JSON.parse(JSON.stringify(input)) as BrainObjectiveIngressInput;
}

test("Brain re-ingress is idempotent only for the exact requested execution and approval contract", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  gateway.createBot(leader());
  const ingress = new BrainObjectiveIngress(store, gateway, queue, new FixedBrainSource());

  const base: BrainObjectiveIngressInput = {
    leaderId: "bot_contract-leader",
    workspaceId: WORKSPACE_ID,
    objectiveId: OBJECTIVE_ID,
    reason: "Execute approved delivery",
    tools: ["read-local"],
    connections: ["drive"],
    budget: { max_actions: 4, max_tasks: 3 },
    maxHops: 3,
    deadlineAt: "2026-09-11T12:00:00Z",
    leaseExpiresAt: "2026-09-11T13:00:00Z",
    approval: {
      required: true,
      reason: "Operator must approve delivery",
      action: { kind: "campaign.deliver", summary: "Deliver approved campaign" }
    }
  };

  try {
    const first = ingress.ingest(base);
    const exactRepeat = cloneInput(base);
    if (exactRepeat.approval?.action) {
      exactRepeat.approval.action = {
        summary: "Deliver approved campaign",
        kind: "campaign.deliver"
      } as JsonObject;
    }
    const second = ingress.ingest(exactRepeat);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.task.id, first.task.id);
    assert.equal(first.task.payload.status, "waiting_approval");
    assert.equal(queue.getByItem(first.task.id), null);
    const brainIngress = first.task.payload.brain_ingress as JsonObject;
    assert.match(String(brainIngress.request_contract_digest), /^[a-f0-9]{64}$/);

    const variants: Array<[string, (value: BrainObjectiveIngressInput) => void]> = [
      ["reason", (value) => { value.reason = "Execute with a different audit reason"; }],
      ["maxHops", (value) => { value.maxHops = 4; }],
      ["deadlineAt", (value) => { value.deadlineAt = "2026-09-11T12:30:00Z"; }],
      ["leaseExpiresAt", (value) => { value.leaseExpiresAt = "2026-09-11T14:00:00Z"; }],
      ["approval reason", (value) => { if (value.approval) value.approval.reason = "A different approval reason"; }],
      ["approval action", (value) => {
        if (value.approval) value.approval.action = { kind: "campaign.deliver", summary: "Deliver a different campaign" };
      }]
    ];

    for (const [label, mutate] of variants) {
      const changed = cloneInput(base);
      mutate(changed);
      assert.throws(
        () => ingress.ingest(changed),
        (error: unknown) => error instanceof BrainObjectiveIngressError && error.code === "BRAIN_INGRESS_CONFLICT",
        `${label} change must fail closed`
      );
    }

    assert.equal(store.listObjects("task", WORKSPACE_ID).length, 1);
    assert.equal(store.listObjects("capability_lease", WORKSPACE_ID).length, 1);
    assert.equal(store.listObjects("approval", WORKSPACE_ID).length, 1);
    assert.equal(store.listEventsAfter(0, 100).filter((entry) => entry.event.type === "brain.objective_ingressed").length, 1);
    assert.equal(store.listEventsAfter(0, 100).filter((entry) => entry.event.type === "approval.requested").length, 1);
  } finally {
    queue.close();
    store.close();
  }
});
