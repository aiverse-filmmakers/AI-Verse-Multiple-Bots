import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { SkillsCapabilityRuntimeRegistry } from "../src/skills-capability-runtime.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunManager } from "../src/team-run-manager.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, skills: string[]): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: "Execute only declared capabilities." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws-skills" },
    capabilities: { skill_refs: skills },
    permissions: {
      policy_ref: "strict",
      allowed_peers: ["*"],
      allowed_tools: ["safe.tool"],
      allowed_connections: [],
      can_create_workers: true,
      can_handoff: true
    },
    coordination: { default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture() {
  const dbPath = `/tmp/aiverse-skills-integration-${randomUUID()}.db`;
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  gateway.createBot(bot("bot_leader", ["deep-research", "evidence-verification"]));
  gateway.createBot(bot("bot_specialist", ["deep-research"]));
  gateway.createBot(bot("bot_without_skill", []));
  return { store, queue, gateway };
}

test("durable Bot Task stores method references separately from capability lease authority and preserves Approval", () => {
  const env = fixture();
  try {
    const result = env.gateway.delegate({
      createdBy: "bot_leader",
      assigneeId: "bot_leader",
      workspaceId: "ws-skills",
      rootObjectiveId: "obj-skills-approval",
      objective: "Perform bounded research",
      reason: "Use the declared research method",
      skillRefs: ["deep-research"],
      tools: ["safe.tool"],
      connections: [],
      approval: { required: true, reason: "Human review before execution" }
    });
    assert.deepEqual(result.task.payload.skill_refs, ["deep-research"]);
    assert.deepEqual(result.lease.payload.tools, ["safe.tool"]);
    assert.deepEqual(result.lease.payload.connections, []);
    assert.equal(Object.prototype.hasOwnProperty.call(result.lease.payload, "skill_refs"), false);
    assert.equal(result.lease.payload.destructive_actions, "approval_required");
    assert.equal(result.task.payload.status, "waiting_approval");
    assert.equal(result.approval?.payload.status, "pending");
    assert.equal(env.queue.getByItem(result.task.id), null);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("undeclared durable Bot skill is rejected before Task or lease creation", () => {
  const env = fixture();
  try {
    const tasksBefore = env.store.listObjects("task", "ws-skills").length;
    const leasesBefore = env.store.listObjects("capability_lease", "ws-skills").length;
    assert.throws(
      () => env.gateway.delegate({
        createdBy: "bot_leader",
        assigneeId: "bot_without_skill",
        workspaceId: "ws-skills",
        rootObjectiveId: "obj-skills-denied",
        objective: "Use capability not declared by target",
        reason: "Negative test",
        skillRefs: ["deep-research"]
      }),
      /does not declare skill capability deep-research/i
    );
    assert.equal(env.store.listObjects("task", "ws-skills").length, tasksBefore);
    assert.equal(env.store.listObjects("capability_lease", "ws-skills").length, leasesBefore);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("handoff preserves Task skill binding and reissues only existing lease authority", () => {
  const env = fixture();
  try {
    const delegated = env.gateway.delegate({
      createdBy: "bot_leader",
      assigneeId: "bot_leader",
      workspaceId: "ws-skills",
      rootObjectiveId: "obj-skills-handoff",
      objective: "Research and hand off",
      reason: "Specialist continuation",
      skillRefs: ["deep-research"],
      tools: ["safe.tool"]
    });

    assert.throws(
      () => env.gateway.requestHandoff({
        sourceOwnerId: "bot_leader",
        targetOwnerId: "bot_without_skill",
        workspaceId: "ws-skills",
        workItemId: delegated.task.id,
        rootObjectiveId: "obj-skills-handoff",
        reason: "Invalid target"
      }),
      /does not declare skill capability deep-research/i
    );
    assert.equal(env.store.listObjects("handoff", "ws-skills").length, 0);

    const requested = env.gateway.requestHandoff({
      sourceOwnerId: "bot_leader",
      targetOwnerId: "bot_specialist",
      workspaceId: "ws-skills",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj-skills-handoff",
      reason: "Valid specialist target"
    });
    const accepted = env.gateway.acceptHandoff(requested.handoff.id, "bot_specialist");
    const task = accepted.workItem;
    const newLease = env.store.getObject(String(task.payload.lease_id));
    assert.deepEqual(task.payload.skill_refs, ["deep-research"]);
    assert.ok(newLease);
    assert.deepEqual(newLease?.payload.tools, ["safe.tool"]);
    assert.deepEqual(newLease?.payload.connections, []);
    assert.equal(Object.prototype.hasOwnProperty.call(newLease?.payload ?? {}, "skill_refs"), false);
    assert.notEqual(newLease?.id, delegated.lease.id);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("temporary Worker receives only explicitly selected leader skill subset and never auto-inherits the full leader set", () => {
  const env = fixture();
  const runner = new BotRunner(
    env.store,
    env.gateway,
    env.queue,
    new RuntimeRegistry().register(new DeterministicRuntimeAdapter())
  );
  const teams = new TeamRunCoordinator(env.store);
  const manager = new TeamRunManager(teams, env.gateway, env.queue, runner);
  try {
    const run = teams.createRun({
      leaderId: "bot_leader",
      workspaceId: "ws-skills",
      rootObjectiveId: `obj-worker-${randomUUID()}`,
      topology: "manager",
      budget: { max_workers: 2, max_hops: 6 }
    }).run;
    const selected = manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_skill_subset",
      roleTitle: "Verifier",
      objective: "Verify the evidence only",
      reason: "Bounded specialist",
      skillRefs: ["evidence-verification"],
      tools: ["safe.tool"]
    });
    assert.deepEqual((selected.worker.payload.capabilities as any)?.skill_refs, ["evidence-verification"]);
    assert.deepEqual(selected.task.payload.skill_refs, ["evidence-verification"]);
    assert.equal(Object.prototype.hasOwnProperty.call(selected.lease.payload, "skill_refs"), false);

    const run2 = teams.createRun({
      leaderId: "bot_leader",
      workspaceId: "ws-skills",
      rootObjectiveId: `obj-worker-empty-${randomUUID()}`,
      topology: "manager",
      budget: { max_workers: 2, max_hops: 6 }
    }).run;
    const plain = teams.createWorker({
      runId: run2.id,
      createdBy: "bot_leader",
      workerId: "worker_no_inherited_skills",
      roleTitle: "Plain Worker",
      objective: "Do not inherit leader skills."
    }).worker;
    assert.equal(Object.prototype.hasOwnProperty.call(plain.payload, "capabilities"), false);

    const workersBefore = teams.listWorkers(run2.id).length;
    assert.throws(
      () => teams.createWorker({
        runId: run2.id,
        createdBy: "bot_leader",
        roleTitle: "Denied Worker",
        objective: "Cannot receive an undeclared leader skill.",
        skillRefs: ["publishing"]
      }),
      /does not declare skill capability publishing/i
    );
    assert.equal(teams.listWorkers(run2.id).length, workersBefore);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("standalone execution remains available without Skills, while an explicit skill dependency fails closed", async () => {
  const env = fixture();
  const runtimes = new SkillsCapabilityRuntimeRegistry(
    new RuntimeRegistry().register(new DeterministicRuntimeAdapter())
  );
  const runner = new BotRunner(env.store, env.gateway, env.queue, runtimes);
  try {
    const skilled = env.gateway.delegate({
      createdBy: "bot_leader",
      assigneeId: "bot_leader",
      workspaceId: "ws-skills",
      rootObjectiveId: "obj-standalone-skilled",
      objective: "Requires an unavailable Skills source",
      reason: "Explicit capability dependency",
      skillRefs: ["deep-research"]
    });
    const failed = await runner.runNext("bot_leader");
    assert.equal(failed?.task.id, skilled.task.id);
    assert.equal(failed?.status, "failed");
    assert.match(String(failed?.task.payload.failure_reason), /no host capability-resolution source is configured/i);
    assert.equal(env.store.listObjects("artifact", "ws-skills").length, 0);

    const ordinary = env.gateway.delegate({
      createdBy: "bot_leader",
      assigneeId: "bot_leader",
      workspaceId: "ws-skills",
      rootObjectiveId: "obj-standalone-ordinary",
      objective: "Ordinary standalone work",
      reason: "No skill dependency"
    });
    const completed = await runner.runNext("bot_leader");
    assert.equal(completed?.task.id, ordinary.task.id);
    assert.equal(completed?.status, "completed");
    assert.equal(env.store.listObjects("artifact", "ws-skills").length, 1);
  } finally {
    env.queue.close();
    env.store.close();
  }
});
