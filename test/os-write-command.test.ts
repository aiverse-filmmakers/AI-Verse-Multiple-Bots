import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  AI_VERSE_OS_WRITE_COMMAND_PROVIDER,
  AiVerseOsWriteCommandSink,
  OsWriteCommandBoundary,
  OsWriteCommandError,
  computeOsWriteCommandFingerprint,
  type OsWriteCommandReceipt,
  type OsWriteCommandRequest,
  type OsWriteCommandSink
} from "../src/os-write-command.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest, JsonObject } from "../src/types.js";

const WORKSPACE = "ws-alpha";

function write(root: string, relative: string, content: string): void {
  const target = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8" });
}

function hostFixture(withWriteCommand = true): string {
  const root = `/tmp/ai-verse-os-write-command-${randomUUID()}`;
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces", WORKSPACE), { recursive: true });
  mkdirSync(resolve(root, "runtime"), { recursive: true });
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
    'name: "Alpha"',
    'type: "project"',
    'status: "active"',
    'purpose: "Test OS write command routing."',
    ""
  ].join("\n"));
  if (withWriteCommand) {
    write(root, "scripts/write-command.mjs", [
      'export function enqueueWriteCommand({ request }) {',
      '  return {',
      '    schema_version: "1.0",',
      '    provider: "ai-verse-os/write-command-v1",',
      '    status: "queued",',
      '    command_id: "os_write_" + request.request_fingerprint.slice(0, 32),',
      '    request_id: request.request_id,',
      '    request_fingerprint: request.request_fingerprint,',
      '    idempotency_key: request.idempotency_key,',
      '    scope: request.scope,',
      '    operation: request.operation,',
      '    requested_by: request.requested_by,',
      '    queued_at: "2026-09-12T00:00:01Z",',
      '    host_permission: {',
      '      decision: "allow",',
      '      source: "fixture",',
      '      reason: "fixture allows queue",',
      '      request_fingerprint: request.request_fingerprint,',
      '      scope: request.scope,',
      '      action_class: "write_local_reversible"',
      '    },',
      '    effect_occurred: false,',
      '    canonical_effect_occurred: false,',
      '    result: { queue_state: "pending_handler", canonical_handler_dispatched: false },',
      '    replayed: false',
      '  };',
      '}',
      ""
    ].join("\n"));
  }
  return root;
}

function bot(id = "bot_writer", workspace = WORKSPACE): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: "Writer", mission: "Request owner-controlled writes without owning OS state." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: workspace },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

function operatorBot(): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_operator-writer",
    name: "Operator Writer",
    kind: "durable",
    status: "active",
    role: { title: "Operator Writer", mission: "Request operator-scoped owner writes." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "operator" },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

class RecordingSink implements OsWriteCommandSink {
  calls: OsWriteCommandRequest[] = [];
  async enqueue(request: OsWriteCommandRequest): Promise<OsWriteCommandReceipt> {
    this.calls.push(request);
    return {
      schema_version: "1.0",
      provider: AI_VERSE_OS_WRITE_COMMAND_PROVIDER,
      status: "queued",
      command_id: `os_write_${request.request_fingerprint.slice(0, 32)}`,
      request_id: request.request_id,
      request_fingerprint: request.request_fingerprint,
      idempotency_key: request.idempotency_key,
      scope: request.scope,
      operation: request.operation,
      requested_by: request.requested_by,
      queued_at: "2026-09-12T00:00:01Z",
      host_permission: {
        decision: "allow",
        source: "test",
        reason: "bounded runtime enqueue",
        request_fingerprint: request.request_fingerprint,
        scope: request.scope,
        action_class: "write_local_reversible"
      },
      effect_occurred: false,
      canonical_effect_occurred: false,
      result: { queue_state: "pending_handler", canonical_handler_dispatched: false },
      replayed: this.calls.length > 1
    };
  }
}

function harness() {
  const dbPath = `/tmp/multiple-bots-os-write-${randomUUID()}.db`;
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  gateway.createBot(bot());
  gateway.createBot(operatorBot());
  const sink = new RecordingSink();
  const boundary = new OsWriteCommandBoundary(store, gateway, sink);
  return { dbPath, store, queue, policy, gateway, sink, boundary };
}

function closeHarness(env: ReturnType<typeof harness>): void {
  env.queue.close();
  env.store.close();
  rmSync(env.dbPath, { force: true });
  rmSync(`${env.dbPath}-shm`, { force: true });
  rmSync(`${env.dbPath}-wal`, { force: true });
}

function requestInput(overrides: Partial<Parameters<OsWriteCommandBoundary["request"]>[0]> = {}) {
  return {
    requestedBy: "bot_writer",
    scope: `workspace:${WORKSPACE}`,
    operation: "candidate.route",
    parameters: {
      candidate_kind: "knowledge",
      text: "RUNTIME_ONLY_CANDIDATE_CONTENT",
      confidence: 0.92
    },
    idempotencyKey: "candidate-route-001",
    reason: "Route validated candidate through the OS owner boundary",
    createdAt: "2026-09-12T00:00:00Z",
    ...overrides
  };
}

function httpJson(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => resolvePromise({ status: Number(res.statusCode), body: JSON.parse(chunks.join("") || "{}") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("write-command request is exact, deterministic, owner-routed, and persists only receipt provenance", async () => {
  const env = harness();
  try {
    const result = await env.boundary.request(requestInput());
    assert.equal(result.created, true);
    assert.equal(result.receipt.canonical_effect_occurred, false);
    assert.equal(env.sink.calls.length, 1);
    assert.equal(result.request.requested_by, "multiple-bots:bot_writer");
    assert.equal(result.request.scope, `workspace:${WORKSPACE}`);
    assert.match(result.request.request_fingerprint, /^[a-f0-9]{64}$/);

    const { request_fingerprint: _ignored, ...base } = result.request;
    assert.equal(computeOsWriteCommandFingerprint(base), result.request.request_fingerprint);

    assert.equal(result.artifact.payload.kind, "os_write_command_receipt");
    assert.equal(result.artifact.payload.parameter_digest, createHash("sha256").update(JSON.stringify({
      candidate_kind: "knowledge",
      confidence: 0.92,
      text: "RUNTIME_ONLY_CANDIDATE_CONTENT"
    })).digest("hex"));
    assert.equal(JSON.stringify(result.artifact.payload).includes("RUNTIME_ONLY_CANDIDATE_CONTENT"), false);
    assert.equal(result.artifact.payload.canonical_effect_occurred, false);
  } finally {
    closeHarness(env);
  }
});

test("exact replay recontacts the OS owner boundary while preserving one local receipt artifact", async () => {
  const env = harness();
  try {
    const first = await env.boundary.request(requestInput());
    const second = await env.boundary.request(requestInput());
    assert.equal(first.artifact.id, second.artifact.id);
    assert.equal(second.created, false);
    assert.equal(env.sink.calls.length, 2);
    assert.equal(env.store.listObjects("artifact", WORKSPACE).filter((item) => item.payload.kind === "os_write_command_receipt").length, 1);
  } finally {
    closeHarness(env);
  }
});

test("semantic drift under the same idempotency identity fails locally before a second host command", async () => {
  const env = harness();
  try {
    await env.boundary.request(requestInput());
    await assert.rejects(
      () => env.boundary.request(requestInput({
        operation: "candidate.other",
        parameters: { candidate_kind: "decision" }
      })),
      (error: unknown) => error instanceof OsWriteCommandError && error.code === "OS_WRITE_CONFLICT"
    );
    assert.equal(env.sink.calls.length, 1);
  } finally {
    closeHarness(env);
  }
});

test("principal and provenance scope cannot cross workspace or widen from Worker to operator", async () => {
  const env = harness();
  try {
    await assert.rejects(
      () => env.boundary.request(requestInput({ scope: "workspace:other" })),
      (error: unknown) => error instanceof OsWriteCommandError && error.code === "OS_WRITE_SCOPE_DENIED"
    );

    const foreignArtifact = env.gateway.record("artifact", {
      schema_version: "1.0",
      id: "artifact_foreign",
      type: "artifact",
      workspace_id: "other",
      created_by: "bot_foreign",
      kind: "candidate",
      provenance: { type: "test" }
    });
    assert.equal(foreignArtifact.workspaceId, "other");
    await assert.rejects(
      () => env.boundary.request(requestInput({
        idempotencyKey: "candidate-route-foreign",
        provenance: { artifactRefs: ["artifact_foreign"] }
      })),
      (error: unknown) => error instanceof OsWriteCommandError && error.code === "OS_WRITE_PROVENANCE_INVALID"
    );
    assert.equal(env.sink.calls.length, 0);
  } finally {
    closeHarness(env);
  }
});

test("operator-scoped writes require an operator-scoped durable Bot", async () => {
  const env = harness();
  try {
    await assert.rejects(
      () => env.boundary.request(requestInput({ scope: "operator" })),
      (error: unknown) => error instanceof OsWriteCommandError && error.code === "OS_WRITE_SCOPE_DENIED"
    );
    const result = await env.boundary.request(requestInput({
      requestedBy: "bot_operator-writer",
      scope: "operator",
      idempotencyKey: "operator-route-001"
    }));
    assert.equal(result.request.scope, "operator");
    assert.equal(result.artifact.payload.workspace_id, "operator");
  } finally {
    closeHarness(env);
  }
});

test("native sink consumes the OS-owned module and rejects unsafe or forged receipts", async () => {
  const root = hostFixture(true);
  try {
    const sink = new AiVerseOsWriteCommandSink(root);
    const base = {
      schema_version: "1.0" as const,
      request_id: "mb_write_native",
      scope: `workspace:${WORKSPACE}`,
      operation: "candidate.route",
      parameters: { value: "native" },
      idempotency_key: "native-001",
      requested_by: "multiple-bots:bot_writer",
      reason: "native contract",
      created_at: "2026-09-12T00:00:00Z",
      provenance: { source: "test" }
    };
    const request: OsWriteCommandRequest = { ...base, request_fingerprint: computeOsWriteCommandFingerprint(base) };
    const receipt = await sink.enqueue(request);
    assert.equal(receipt.provider, AI_VERSE_OS_WRITE_COMMAND_PROVIDER);
    assert.equal(receipt.request_fingerprint, request.request_fingerprint);
    assert.equal(receipt.canonical_effect_occurred, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (process.platform !== "win32") {
    const symlinkRoot = hostFixture(false);
    const outside = `/tmp/write-command-outside-${randomUUID()}.mjs`;
    try {
      writeFileSync(outside, "export function enqueueWriteCommand() { return {}; }\n", { encoding: "utf8" });
      mkdirSync(resolve(symlinkRoot, "scripts"), { recursive: true });
      symlinkSync(outside, resolve(symlinkRoot, "scripts", "write-command.mjs"));
      assert.throws(
        () => new AiVerseOsWriteCommandSink(symlinkRoot),
        (error: unknown) => error instanceof OsWriteCommandError && error.code === "OS_WRITE_UNSAFE"
      );
    } finally {
      rmSync(symlinkRoot, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  }
});

test("native server keeps old hosts usable but exposes OS write command only when the host contract exists", async () => {
  const oldRoot = hostFixture(false);
  const oldDb = `/tmp/os-write-old-host-${randomUUID()}.db`;
  const oldService = createGatewayServer({ dbPath: oldDb, aiVerseOsRoot: oldRoot, port: 0 });
  oldService.gateway.createBot(bot());
  const oldAddress = await oldService.listen();
  try {
    const denied = await httpJson(oldAddress.port, "POST", "/v1/os/write-commands", requestInput());
    assert.equal(denied.status, 400);
    assert.match(String(denied.body.message), /requires native AI-Verse OS mode/i);
  } finally {
    await oldService.close();
    rmSync(oldRoot, { recursive: true, force: true });
    rmSync(oldDb, { force: true });
    rmSync(`${oldDb}-shm`, { force: true });
    rmSync(`${oldDb}-wal`, { force: true });
  }

  const root = hostFixture(true);
  const db = `/tmp/os-write-native-host-${randomUUID()}.db`;
  const service = createGatewayServer({ dbPath: db, aiVerseOsRoot: root, port: 0 });
  service.gateway.createBot(bot());
  const address = await service.listen();
  try {
    const created = await httpJson(address.port, "POST", "/v1/os/write-commands", requestInput({ idempotencyKey: "http-native-001" }));
    assert.equal(created.status, 201);
    assert.equal(created.body.receipt.canonical_effect_occurred, false);
    const replay = await httpJson(address.port, "POST", "/v1/os/write-commands", requestInput({ idempotencyKey: "http-native-001" }));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.created, false);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(db, { force: true });
    rmSync(`${db}-shm`, { force: true });
    rmSync(`${db}-wal`, { force: true });
  }
});
