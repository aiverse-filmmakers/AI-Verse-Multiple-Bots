import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import {
  AI_VERSE_AUTOMATION_INGRESS_ACTOR,
  AiVerseOsAutomationInvocationSource,
  AutomationWakeIngress,
  AutomationWakeIngressError
} from "../src/automation-wake-ingress.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

const WORKSPACE = "ws-alpha";
const JOB_PATH = "automations/jobs/daily-research.yaml";
const JOB_TEXT = "schema_version: \"1.0\"\nname: daily-research\nSECRET_AUTOMATION_DEFINITION\n";
const LOCAL_TRIGGER_PATH = "workspaces/ws-alpha/automations/file-change.yaml";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function write(root: string, relative: string, content: string): void {
  const target = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8" });
}

function hostFixture(status = "active"): string {
  const root = `/tmp/ai-verse-automation-${randomUUID()}`;
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces", WORKSPACE), { recursive: true });
  write(root, "AI-VERSE.yaml", [
    'schema_version: "2.0"',
    "architecture: unified-workspace",
    "paths:",
    "  workspaces: workspaces/",
    ""
  ].join("\n"));
  write(root, "AGENTS.md", "# Runtime\nLoad .aiverse/extensions/registry.json when present.\n");
  write(root, "system/extensions/README.md", "# Extensions\nRegistry: .aiverse/extensions/registry.json\n");
  write(root, `workspaces/${WORKSPACE}/WORKSPACE.yaml`, [
    'schema_version: "2.0"',
    `id: "${WORKSPACE}"`,
    'name: "Automation Workspace"',
    'type: "project"',
    `status: "${status}"`,
    'purpose: "Run bounded automated work."',
    ""
  ].join("\n"));
  write(root, JOB_PATH, JOB_TEXT);
  write(root, LOCAL_TRIGGER_PATH, "event: file-change\n");
  return root;
}

function bot(id = "bot_automation", canCreateWorkers = true): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: "Automation Agent", mission: "Execute bounded automated work safely." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: WORKSPACE },
    capabilities: { skill_refs: ["deep-research"] },
    permissions: {
      policy_ref: "strict",
      allowed_peers: ["*"],
      allowed_tools: ["read-local"],
      allowed_connections: ["drive"],
      can_create_workers: canCreateWorkers,
      can_handoff: true
    },
    coordination: { default_mode: "manager", max_parallel_workers: 4, max_hops: 6 }
  };
}

function harness(root: string, canCreateWorkers = true) {
  const dbPath = `/tmp/aiverse-automation-ingress-${randomUUID()}.db`;
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  gateway.createBot(bot("bot_automation", canCreateWorkers));
  const source = new AiVerseOsAutomationInvocationSource(root);
  const ingress = new AutomationWakeIngress(store, gateway, queue, source);
  return { dbPath, store, queue, policy, gateway, source, ingress };
}

function closeHarness(env: ReturnType<typeof harness>): void {
  env.queue.close();
  env.store.close();
  rmSync(env.dbPath, { force: true });
  rmSync(`${env.dbPath}-shm`, { force: true });
  rmSync(`${env.dbPath}-wal`, { force: true });
}

function baseInvocation(invocationId = "invocation-001") {
  return {
    automationId: "daily-research",
    invocationId,
    workspaceId: WORKSPACE,
    firedAt: "2026-09-10T18:00:00Z",
    source: { kind: "job" as const, path: JOB_PATH, digest: sha256(JOB_TEXT) }
  };
}

function botWake(invocationId = "invocation-001") {
  return {
    ...baseInvocation(invocationId),
    target: { kind: "bot" as const, botId: "bot_automation" },
    objective: "Review today's bounded research queue.",
    reason: "Daily automation fired",
    requiredConstraints: ["Do not publish externally"],
    skillRefs: ["deep-research"],
    tools: ["read-local"],
    connections: ["drive"],
    budget: { max_tasks: 4, max_actions: 8, max_hops: 2 },
    recoveryPolicy: "retry_safe" as const,
    maxAttempts: 2
  };
}

function teamRunWake(invocationId = "run-invocation-001") {
  return {
    ...baseInvocation(invocationId),
    target: { kind: "team_run" as const, leaderId: "bot_automation", topology: "manager" as const },
    objective: "Coordinate the scheduled weekly research review.",
    reason: "Weekly review automation fired",
    requiredConstraints: ["Keep all work inside the workspace"],
    skillRefs: ["deep-research"],
    tools: ["read-local"],
    connections: ["drive"],
    budget: {
      max_workers: 2,
      max_tasks: 6,
      max_actions: 12,
      max_hops: 3,
      wall_clock_seconds: 900
    }
  };
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

test("native automation source binds exact active workspace, shared/job or local source scope, and current source digest", () => {
  const root = hostFixture();
  try {
    const source = new AiVerseOsAutomationInvocationSource(root);
    const shared = source.project(baseInvocation("source-shared"));
    assert.equal(shared.provider, "ai-verse-os-automation-v1");
    assert.equal(shared.source.scope, "shared");
    assert.equal(shared.source.path, JOB_PATH);
    assert.equal(shared.source.source_digest, sha256(JOB_TEXT));
    assert.match(shared.projection_digest, /^[a-f0-9]{64}$/);

    const localText = "event: file-change\n";
    const local = source.project({
      automationId: "file-change",
      invocationId: "source-local",
      workspaceId: WORKSPACE,
      firedAt: "2026-09-10T18:01:00Z",
      source: { kind: "trigger", path: LOCAL_TRIGGER_PATH, digest: sha256(localText) }
    });
    assert.equal(local.source.scope, `workspace:${WORKSPACE}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native automation source fails closed on paused workspace, stale digest, traversal, and symlinked source", () => {
  const paused = hostFixture("paused");
  try {
    const source = new AiVerseOsAutomationInvocationSource(paused);
    assert.throws(() => source.project(baseInvocation()), /execution requires an active workspace/i);
  } finally {
    rmSync(paused, { recursive: true, force: true });
  }

  const root = hostFixture();
  try {
    const source = new AiVerseOsAutomationInvocationSource(root);
    write(root, JOB_PATH, JOB_TEXT + "changed: true\n");
    assert.throws(
      () => source.project(baseInvocation()),
      (error: unknown) => error instanceof AutomationWakeIngressError && error.code === "AUTOMATION_SOURCE_CHANGED"
    );
    assert.throws(
      () => source.project({ ...baseInvocation(), source: { kind: "job", path: "automations/jobs/../policies/x.yaml", digest: sha256("x") } }),
      /traversal/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const symlinkRoot = hostFixture();
  const outside = `/tmp/automation-source-outside-${randomUUID()}.yaml`;
  try {
    writeFileSync(outside, JOB_TEXT, { encoding: "utf8" });
    rmSync(resolve(symlinkRoot, ...JOB_PATH.split("/")), { force: true });
    symlinkSync(outside, resolve(symlinkRoot, ...JOB_PATH.split("/")));
    const source = new AiVerseOsAutomationInvocationSource(symlinkRoot);
    assert.throws(
      () => source.project(baseInvocation()),
      (error: unknown) => error instanceof AutomationWakeIngressError && error.code === "AUTOMATION_SOURCE_UNSAFE"
    );
  } finally {
    rmSync(symlinkRoot, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("Bot wake is deterministic and idempotent while preserving normal Task lease authority", () => {
  const root = hostFixture();
  const env = harness(root);
  try {
    const first = env.ingress.ingest(botWake());
    assert.equal(first.mode, "bot");
    if (first.mode !== "bot") return;
    assert.equal(first.created, true);
    assert.equal(first.task.payload.created_by, AI_VERSE_AUTOMATION_INGRESS_ACTOR);
    assert.deepEqual(first.task.payload.skill_refs, ["deep-research"]);
    assert.deepEqual(first.lease.payload.tools, ["read-local"]);
    assert.deepEqual(first.lease.payload.connections, ["drive"]);
    assert.equal(first.lease.payload.destructive_actions, "deny");
    assert.equal(Object.prototype.hasOwnProperty.call(first.lease.payload, "skill_refs"), false);
    assert.ok(env.queue.getByItem(first.task.id));
    assert.equal(JSON.stringify(first.task.payload).includes("SECRET_AUTOMATION_DEFINITION"), false);

    const second = env.ingress.ingest(botWake());
    assert.equal(second.mode, "bot");
    if (second.mode !== "bot") return;
    assert.equal(second.created, false);
    assert.equal(second.task.id, first.task.id);
    assert.equal(env.store.listObjects("task", WORKSPACE).length, 1);
    assert.equal(env.store.listObjects("capability_lease", WORKSPACE).length, 1);
    assert.equal(env.store.listEventsAfter(0, 100).filter((event) => event.event.type === "automation.invocation_ingressed").length, 1);
  } finally {
    closeHarness(env);
    rmSync(root, { recursive: true, force: true });
  }
});

test("same automation invocation cannot drift contract or change from Bot wake to Team Run", () => {
  const root = hostFixture();
  const env = harness(root);
  try {
    env.ingress.ingest(botWake("immutable-invocation"));
    assert.throws(
      () => env.ingress.ingest({ ...botWake("immutable-invocation"), objective: "Changed objective" }),
      (error: unknown) => error instanceof AutomationWakeIngressError && error.code === "AUTOMATION_INGRESS_CONFLICT"
    );
    assert.throws(
      () => env.ingress.ingest(teamRunWake("immutable-invocation")),
      (error: unknown) => error instanceof AutomationWakeIngressError && error.code === "AUTOMATION_INGRESS_CONFLICT"
    );
  } finally {
    closeHarness(env);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bot wake preserves Approval gating and creates no executable queue item until normal approval flow", () => {
  const root = hostFixture();
  const env = harness(root);
  try {
    const result = env.ingress.ingest({
      ...botWake("approval-invocation"),
      approval: { required: true, reason: "Operator review required" }
    });
    assert.equal(result.mode, "bot");
    if (result.mode !== "bot") return;
    assert.equal(result.task.payload.status, "waiting_approval");
    assert.equal(result.approval?.payload.status, "pending");
    assert.equal(env.queue.getByItem(result.task.id), null);

    const approved = env.gateway.approve(String(result.approval?.id), "operator_local");
    assert.equal(approved.task.payload.status, "assigned");
    assert.ok(env.queue.getByItem(result.task.id));
  } finally {
    closeHarness(env);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bot wake cannot exceed durable target authority", () => {
  const root = hostFixture();
  const env = harness(root);
  try {
    assert.throws(
      () => env.ingress.ingest({ ...botWake("authority-invocation"), tools: ["shell-root"] }),
      /not granted tool shell-root/i
    );
    assert.equal(env.store.listObjects("task", WORKSPACE).length, 0);
  } finally {
    closeHarness(env);
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded Team Run start stores coordination requirements only, is idempotent, and grants no Task authority", () => {
  const root = hostFixture();
  const env = harness(root);
  try {
    const first = env.ingress.ingest(teamRunWake());
    assert.equal(first.mode, "team_run");
    if (first.mode !== "team_run") return;
    assert.equal(first.created, true);
    assert.equal(first.run.payload.status, "created");
    assert.equal(first.run.payload.topology, "manager");
    assert.deepEqual(first.run.payload.required_tools, ["read-local"]);
    assert.deepEqual(first.run.payload.required_connections, ["drive"]);
    assert.deepEqual(first.run.payload.required_skill_refs, ["deep-research"]);
    assert.equal(JSON.stringify(first.run.payload).includes("SECRET_AUTOMATION_DEFINITION"), false);
    assert.equal(env.store.listObjects("task", WORKSPACE).length, 0);
    assert.equal(env.store.listObjects("capability_lease", WORKSPACE).length, 0);
    assert.equal(env.store.listObjects("approval", WORKSPACE).length, 0);

    const second = env.ingress.ingest(teamRunWake());
    assert.equal(second.mode, "team_run");
    if (second.mode !== "team_run") return;
    assert.equal(second.created, false);
    assert.equal(second.run.id, first.run.id);
    assert.equal(env.store.listObjects("team_run", WORKSPACE).length, 1);
  } finally {
    closeHarness(env);
    rmSync(root, { recursive: true, force: true });
  }
});

test("automated Team Run requires explicit hard bounds, leader worker authority, and resolved run-start approval", () => {
  const root = hostFixture();
  const env = harness(root);
  try {
    assert.throws(
      () => env.ingress.ingest({ ...teamRunWake("unbounded"), budget: { max_workers: 2 } }),
      (error: unknown) => error instanceof AutomationWakeIngressError && error.code === "AUTOMATION_BUDGET_REQUIRED"
    );
    assert.throws(
      () => env.ingress.ingest({ ...teamRunWake("approval-run"), approval: { required: true } }),
      (error: unknown) => error instanceof AutomationWakeIngressError && error.code === "AUTOMATION_APPROVAL_REQUIRED"
    );
  } finally {
    closeHarness(env);
  }

  const denied = harness(root, false);
  try {
    assert.throws(
      () => denied.ingress.ingest(teamRunWake("worker-denied")),
      /cannot create temporary Workers/i
    );
    assert.equal(denied.store.listObjects("team_run", WORKSPACE).length, 0);
  } finally {
    closeHarness(denied);
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay revalidates canonical automation source, so removing or changing the host definition acts as a kill fence", () => {
  const root = hostFixture();
  const env = harness(root);
  try {
    env.ingress.ingest(botWake("source-fence"));
    write(root, JOB_PATH, JOB_TEXT + "disabled: true\n");
    assert.throws(
      () => env.ingress.ingest(botWake("source-fence")),
      (error: unknown) => error instanceof AutomationWakeIngressError && error.code === "AUTOMATION_SOURCE_CHANGED"
    );
    assert.equal(env.store.listObjects("task", WORKSPACE).length, 1);
  } finally {
    closeHarness(env);
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP automation invocation exists only in native AI-Verse OS mode", async () => {
  const standalone = createGatewayServer({ dbPath: `/tmp/aiverse-automation-standalone-${randomUUID()}.db`, port: 0 });
  const standaloneAddress = await standalone.listen();
  try {
    const denied = await httpJson(standaloneAddress.port, "POST", "/v1/automations/invoke", botWake("http-standalone"));
    assert.equal(denied.status, 400);
    assert.match(String(denied.body.message), /requires native AI-Verse OS mode/i);
  } finally {
    await standalone.close();
  }

  const root = hostFixture();
  const dbPath = `/tmp/aiverse-automation-http-${randomUUID()}.db`;
  const service = createGatewayServer({ dbPath, aiVerseOsRoot: root, port: 0 });
  service.gateway.createBot(bot());
  const address = await service.listen();
  try {
    const created = await httpJson(address.port, "POST", "/v1/automations/invoke", botWake("http-native"));
    assert.equal(created.status, 201);
    assert.equal(created.body.mode, "bot");
    assert.equal(created.body.created, true);
    const replay = await httpJson(address.port, "POST", "/v1/automations/invoke", botWake("http-native"));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.created, false);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  }
});
