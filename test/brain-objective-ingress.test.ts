import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import {
  AI_VERSE_BRAIN_INGRESS_ACTOR,
  AiVerseBrainObjectiveSource,
  BrainObjectiveIngress,
  BrainObjectiveIngressError,
  assertBrainProjectionExecutable
} from "../src/brain-objective-ingress.js";
import { BrainObjectiveRuntimeRegistry } from "../src/brain-objective-runtime.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest, JsonObject } from "../src/types.js";

const WORKSPACE_ID = "ws-alpha";
const OBJECTIVE_ID = "objective-ready";
const INITIATIVE_ID = "initiative-active";
const CRITERION_SECRET = "CRITERION_TEXT_MUST_REMAIN_RUNTIME_ONLY";
const PARENT_SECRET = "PARENT_HYPOTHESIS_MUST_REMAIN_RUNTIME_ONLY";

function write(root: string, relative: string, content: string): void {
  const path = resolve(root, ...relative.split("/"));
  const segments = relative.split("/");
  if (segments.length > 1) mkdirSync(resolve(root, ...segments.slice(0, -1)), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8" });
}

function brainObject(kind: string, id: string, status: string, revision: number, payload: JsonObject): string {
  return JSON.stringify({
    schema_version: "1.0",
    id,
    kind,
    scope: `workspace:${WORKSPACE_ID}`,
    status,
    revision,
    created_at: "2026-09-10T10:00:00Z",
    updated_at: `2026-09-10T10:0${Math.min(revision, 9)}:00Z`,
    created_by: "brain",
    updated_by: "brain",
    source_refs: [],
    evidence_refs: [],
    supersedes: null,
    superseded_by: null,
    payload
  }, null, 2) + "\n";
}

function initiativePayload(): JsonObject {
  return {
    serves: ["brain:intent:goal-1"],
    gap_refs: ["gap-1"],
    hypothesis: PARENT_SECRET,
    outcome: "Ship the campaign safely",
    score_components: {},
    next_action: "Complete the approved delivery"
  };
}

function objectivePayload(outcome = "Deliver the approved campaign"): JsonObject {
  return {
    outcome,
    serves_ref: `initiative:${INITIATIVE_ID}`,
    criteria: [{
      id: "criterion-1",
      statement: CRITERION_SECRET,
      required_evidence: "A validated final export exists",
      status: "unverified",
      evidence_refs: []
    }],
    progress: "waiting",
    verification_level: "V2",
    constraints: ["Do not publish externally"],
    boundaries: ["Stay inside the approved brand direction"],
    stop_conditions: ["Stop if the canonical brief changes"],
    dependencies: ["Approved master brief"],
    risks: ["Rights clearance"],
    budget: { max_attempts: 3 },
    stall_threshold: 2
  };
}

function hostFixture(owner: "brain" | "os" | null = "brain"): string {
  const root = `/tmp/ai-verse-brain-ingress-${randomUUID()}`;
  mkdirSync(resolve(root, "operator", "brain"), { recursive: true });
  mkdirSync(resolve(root, "workspaces", WORKSPACE_ID, "brain", "objectives"), { recursive: true });
  mkdirSync(resolve(root, "workspaces", WORKSPACE_ID, "brain", "initiatives"), { recursive: true });
  mkdirSync(resolve(root, "workspaces", WORKSPACE_ID, "context"), { recursive: true });

  write(root, "AI-VERSE.yaml", [
    'schema_version: "2.0"',
    "architecture: unified-workspace",
    "paths:",
    "  workspaces: workspaces/",
    "extensions:",
    "  brain:",
    "    supported: true",
    "    enabled: true",
    ""
  ].join("\n"));
  write(root, "AGENTS.md", "# Runtime\nLoad .aiverse/extensions/registry.json when present.\n");
  write(root, "system/extensions/README.md", "# Extensions\nRegistry: .aiverse/extensions/registry.json\n");
  write(root, "operator/brain/installation.json", JSON.stringify({
    schema_version: "1.0",
    state_schema_version: "1.0",
    package_version: "0.1.0-beta.1",
    mode: "ai-verse-os-v2",
    installation_id: "installation-test",
    installed_at: "2026-09-10T10:00:00Z"
  }, null, 2) + "\n");

  const scopes: JsonObject = {};
  if (owner !== null) scopes[`workspace:${WORKSPACE_ID}`] = { owner };
  write(root, ".aiverse/direction/ownership.json", JSON.stringify({ schema_version: 1, scopes }, null, 2) + "\n");

  write(root, `workspaces/${WORKSPACE_ID}/WORKSPACE.yaml`, [
    'schema_version: "2.0"',
    `id: "${WORKSPACE_ID}"`,
    'name: "Alpha Workspace"',
    'type: "project"',
    'status: "active"',
    'purpose: "Deliver the campaign safely."',
    'current_context: "context/CURRENT.md"',
    "domains:",
    "  - filmmaking",
    "owners:",
    "  - operator_local",
    "success_criteria:",
    "  - approved campaign delivered",
    "canonical_sources:",
    "  - briefs/master.md",
    "connections: []",
    "privacy:",
    '  classification: "private"',
    "approval:",
    '  external_actions: "confirm"',
    ""
  ].join("\n"));
  write(root, `workspaces/${WORKSPACE_ID}/context/CURRENT.md`, [
    "# Current Workspace Context",
    "",
    "Last reviewed: 2026-09-10",
    "",
    "## Objective",
    "",
    "Deliver the approved campaign",
    "",
    "## Current state",
    "",
    "Ready for coordinated execution.",
    "",
    "## Next useful actions",
    "",
    "- execute the approved objective",
    "",
    "## Pending decisions",
    "",
    "- none",
    "",
    "## Constraints / approvals",
    "",
    "- external publishing requires confirmation",
    "",
    "## Source pointers",
    "",
    "- briefs/master.md",
    ""
  ].join("\n"));

  write(root, `workspaces/${WORKSPACE_ID}/brain/initiatives/${INITIATIVE_ID}.json`, brainObject(
    "initiative", INITIATIVE_ID, "ACTIVE", 1, initiativePayload()
  ));
  write(root, `workspaces/${WORKSPACE_ID}/brain/objectives/${OBJECTIVE_ID}.json`, brainObject(
    "objective", OBJECTIVE_ID, "READY", 1, objectivePayload()
  ));
  return root;
}

function updateObjective(root: string, status: string, revision: number, outcome = "Deliver the approved campaign"): void {
  write(root, `workspaces/${WORKSPACE_ID}/brain/objectives/${OBJECTIVE_ID}.json`, brainObject(
    "objective", OBJECTIVE_ID, status, revision, objectivePayload(outcome)
  ));
}

function leader(id = "bot_brain-leader"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: "Brain Objective Leader",
    kind: "durable",
    status: "active",
    role: { title: "Delivery Lead", mission: "Execute bounded strategic objectives safely." },
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

function harness(root: string) {
  const dbPath = `/tmp/ai-verse-brain-ingress-${randomUUID()}.db`;
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  gateway.createBot(leader());
  const source = new AiVerseBrainObjectiveSource(root);
  const ingress = new BrainObjectiveIngress(store, gateway, queue, source);
  return { dbPath, store, queue, policy, gateway, source, ingress };
}

function closeHarness(value: ReturnType<typeof harness>): void {
  value.queue.close();
  value.store.close();
  rmSync(value.dbPath, { force: true });
  rmSync(`${value.dbPath}-shm`, { force: true });
  rmSync(`${value.dbPath}-wal`, { force: true });
}

function httpJson(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => resolvePromise({ status: Number(res.statusCode), body: JSON.parse(chunks.join("") || "{}") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("Brain objective source requires explicit workspace direction ownership by Brain", () => {
  const root = hostFixture(null);
  try {
    const source = new AiVerseBrainObjectiveSource(root);
    assert.throws(
      () => source.project(WORKSPACE_ID, OBJECTIVE_ID),
      (error: unknown) => error instanceof BrainObjectiveIngressError && error.code === "BRAIN_NOT_DIRECTION_OWNER"
    );
    write(root, ".aiverse/direction/ownership.json", JSON.stringify({
      schema_version: 1,
      scopes: { [`workspace:${WORKSPACE_ID}`]: { owner: "os" } }
    }, null, 2) + "\n");
    assert.throws(
      () => source.project(WORKSPACE_ID, OBJECTIVE_ID),
      (error: unknown) => error instanceof BrainObjectiveIngressError && error.code === "BRAIN_NOT_DIRECTION_OWNER"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Brain semantic root remains stable across READY to RUNNING lifecycle revision when intent is unchanged", () => {
  const root = hostFixture();
  try {
    const source = new AiVerseBrainObjectiveSource(root);
    const ready = source.project(WORKSPACE_ID, OBJECTIVE_ID);
    updateObjective(root, "RUNNING", 2);
    const running = source.project(WORKSPACE_ID, OBJECTIVE_ID);
    assert.equal(running.intent_digest, ready.intent_digest);
    assert.equal(running.root_objective_id, ready.root_objective_id);
    assert.notEqual(running.source.source_digest, ready.source.source_digest);
    assert.equal(running.source.revision, 2);
    assert.doesNotThrow(() => assertBrainProjectionExecutable(running, ready.intent_digest, false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("READY Brain objective ingress is deterministic, idempotent and persists provenance instead of full Brain state", () => {
  const root = hostFixture();
  const h = harness(root);
  try {
    const first = h.ingress.ingest({
      leaderId: "bot_brain-leader",
      workspaceId: WORKSPACE_ID,
      objectiveId: OBJECTIVE_ID,
      tools: ["read-local"],
      connections: ["drive"],
      budget: { max_tasks: 4, max_actions: 4 }
    });
    const second = h.ingress.ingest({
      leaderId: "bot_brain-leader",
      workspaceId: WORKSPACE_ID,
      objectiveId: OBJECTIVE_ID,
      tools: ["read-local"],
      connections: ["drive"],
      budget: { max_tasks: 4, max_actions: 4 }
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.task.id, first.task.id);
    assert.match(String(first.task.payload.root_objective_id), /^brain:objective:/);
    assert.equal(first.task.payload.created_by, AI_VERSE_BRAIN_INGRESS_ACTOR);
    assert.deepEqual(first.task.payload.required_constraints, [
      "Brain boundary: Stay inside the approved brand direction",
      "Brain constraint: Do not publish externally",
      "Brain stop condition: Stop if the canonical brief changes"
    ]);
    assert.equal(h.queue.getByItem(first.task.id)?.state, "queued");
    assert.equal(h.store.listObjects("bot", WORKSPACE_ID).length, 1, "Brain ingress must not create a Bot identity");
    assert.equal(h.store.listEventsAfter(0, 100).filter((entry) => entry.event.type === "brain.objective_ingressed").length, 1);

    const persisted = JSON.stringify(h.store.listObjects());
    assert.equal(persisted.includes(CRITERION_SECRET), false);
    assert.equal(persisted.includes(PARENT_SECRET), false);
    assert.match(persisted, /intent_digest/);
  } finally {
    closeHarness(h);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime re-reads current Brain intent and publishes only strategic provenance with the Artifact", async () => {
  const root = hostFixture();
  const h = harness(root);
  try {
    const ingressed = h.ingress.ingest({
      leaderId: "bot_brain-leader",
      workspaceId: WORKSPACE_ID,
      objectiveId: OBJECTIVE_ID,
      budget: { max_actions: 4 }
    });
    const runtimes = new BrainObjectiveRuntimeRegistry(
      new RuntimeRegistry().register(new DeterministicRuntimeAdapter()),
      h.source
    );
    const runner = new BotRunner(h.store, h.gateway, h.queue, runtimes, "runner_brain-ingress");
    const result = await runner.runNext("bot_brain-leader");
    assert.ok(result);
    assert.equal(result?.status, "completed");
    assert.equal(result?.artifact?.payload.task_id, ingressed.task.id);
    const inline = result?.artifact?.payload.inline_content as JsonObject;
    assert.equal(inline.strategic_intent_digest, ingressed.projection.intent_digest);
    const receipts = result?.artifact?.payload.runtime_receipts as JsonObject[];
    const strategic = receipts.find((receipt) => receipt.kind === "brain_strategic_intent");
    assert.ok(strategic);
    assert.equal(strategic?.intent_digest, ingressed.projection.intent_digest);
    assert.equal(strategic?.objective_ref, `brain:objective:${OBJECTIVE_ID}`);

    const persisted = JSON.stringify(h.store.listObjects());
    assert.equal(persisted.includes(CRITERION_SECRET), false);
    assert.equal(persisted.includes(PARENT_SECRET), false);
  } finally {
    closeHarness(h);
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic Brain objective edit after ingress fails closed before runtime Artifact creation", async () => {
  const root = hostFixture();
  const h = harness(root);
  try {
    const ingressed = h.ingress.ingest({
      leaderId: "bot_brain-leader",
      workspaceId: WORKSPACE_ID,
      objectiveId: OBJECTIVE_ID
    });
    updateObjective(root, "READY", 2, "Deliver a materially different campaign");
    const runner = new BotRunner(
      h.store,
      h.gateway,
      h.queue,
      new BrainObjectiveRuntimeRegistry(new RuntimeRegistry().register(new DeterministicRuntimeAdapter()), h.source),
      "runner_brain-stale"
    );
    const result = await runner.runNext("bot_brain-leader");
    assert.equal(result?.status, "failed");
    assert.equal(result?.artifact, null);
    const task = h.store.getObject(ingressed.task.id);
    assert.equal(task?.payload.status, "failed");
    assert.match(String(task?.payload.failure_reason ?? ""), /changed after coordination ingress/i);
  } finally {
    closeHarness(h);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Brain cancellation or direction-owner revocation after ingress prevents execution", async () => {
  for (const mode of ["cancel", "owner"] as const) {
    const root = hostFixture();
    const h = harness(root);
    try {
      h.ingress.ingest({ leaderId: "bot_brain-leader", workspaceId: WORKSPACE_ID, objectiveId: OBJECTIVE_ID });
      if (mode === "cancel") updateObjective(root, "CANCELLED", 2);
      else write(root, ".aiverse/direction/ownership.json", JSON.stringify({
        schema_version: 1,
        scopes: { [`workspace:${WORKSPACE_ID}`]: { owner: "os" } }
      }, null, 2) + "\n");
      const runner = new BotRunner(
        h.store,
        h.gateway,
        h.queue,
        new BrainObjectiveRuntimeRegistry(new RuntimeRegistry().register(new DeterministicRuntimeAdapter()), h.source),
        `runner_brain-${mode}`
      );
      const result = await runner.runNext("bot_brain-leader");
      assert.equal(result?.status, "failed", mode);
      assert.equal(result?.artifact, null, mode);
    } finally {
      closeHarness(h);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("only READY objectives may enter coordination and requested authority cannot exceed durable leader grants", () => {
  const root = hostFixture();
  const h = harness(root);
  try {
    updateObjective(root, "QUEUED", 2);
    assert.throws(
      () => h.ingress.ingest({ leaderId: "bot_brain-leader", workspaceId: WORKSPACE_ID, objectiveId: OBJECTIVE_ID }),
      (error: unknown) => error instanceof BrainObjectiveIngressError && error.code === "BRAIN_OBJECTIVE_NOT_READY"
    );
    updateObjective(root, "READY", 3);
    assert.throws(
      () => h.ingress.ingest({
        leaderId: "bot_brain-leader",
        workspaceId: WORKSPACE_ID,
        objectiveId: OBJECTIVE_ID,
        tools: ["ungranted-dangerous-tool"]
      }),
      /not granted tool/i
    );
    assert.equal(h.store.listObjects("task", WORKSPACE_ID).length, 0);
  } finally {
    closeHarness(h);
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Gateway exposes one Brain objective ingress command with idempotent HTTP behavior", async () => {
  const root = hostFixture();
  const dbPath = `/tmp/ai-verse-brain-server-${randomUUID()}.db`;
  const service = createGatewayServer({ aiVerseOsRoot: root, dbPath, port: 0 });
  try {
    service.gateway.createBot(leader());
    const listening = await service.listen();
    const body = {
      leaderId: "bot_brain-leader",
      workspaceId: WORKSPACE_ID,
      objectiveId: OBJECTIVE_ID,
      budget: { max_actions: 4 }
    };
    const first = await httpJson(listening.port, "POST", "/v1/brain/objectives/ingest", body);
    assert.equal(first.status, 201);
    assert.match(String(first.body.task?.payload?.root_objective_id ?? ""), /^brain:objective:/);
    const second = await httpJson(listening.port, "POST", "/v1/brain/objectives/ingest", body);
    assert.equal(second.status, 200);
    assert.equal(second.body.task.id, first.body.task.id);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  }
});
