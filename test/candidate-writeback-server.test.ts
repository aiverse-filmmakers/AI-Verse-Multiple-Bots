import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../src/server.js";
import type { BotManifest, JsonObject } from "../src/types.js";

const WORKSPACE = "ws-alpha";

function write(root: string, relative: string, content: string): void {
  const target = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8" });
}

function hostFixture(withWriteCommand: boolean): string {
  const root = `/tmp/ai-verse-candidate-host-${randomUUID()}`;
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
    'purpose: "Candidate write-back acceptance fixture."',
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
      '    queued_at: "2026-09-12T17:00:01Z",',
      '    host_permission: { decision: "allow", source: "fixture", reason: "allowed", request_fingerprint: request.request_fingerprint, scope: request.scope, action_class: "write_local_reversible" },',
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

function bot(): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_writer",
    name: "Writer",
    kind: "durable",
    status: "active",
    role: { title: "Writer", mission: "Nominate owner-routed candidates." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: WORKSPACE },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

function sourceArtifact(): JsonObject {
  return {
    schema_version: "1.0",
    id: "artifact_source",
    type: "artifact",
    workspace_id: WORKSPACE,
    created_by: "bot_writer",
    kind: "synthesis_final",
    version: 1,
    inline_content: { result: "verified source result" },
    provenance: { origin: "bot_generated", trusted_instruction: false }
  };
}

function candidateBody() {
  return {
    requestedBy: "bot_writer",
    workspaceId: WORKSPACE,
    candidateKind: "knowledge",
    sourceArtifactRef: "artifact_source",
    title: "Reusable finding",
    summary: "Verified output that may be useful as canonical workspace knowledge.",
    content: { statement: "HTTP_CANDIDATE_CONTENT" },
    confidence: 0.9,
    idempotencyKey: "http-candidate-001",
    reason: "Submit bounded candidate to OS owner evaluation",
    createdAt: "2026-09-12T17:00:00Z"
  };
}

function httpJson(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } },
      (res: any) => {
        const chunks: string[] = [];
        res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
        res.on("end", () => resolvePromise({
          status: Number(res.statusCode),
          body: JSON.parse(chunks.join("") || "{}")
        }));
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("native candidate endpoint is additive and exists only when the Phase 3.7 owner contract exists", async () => {
  const oldRoot = hostFixture(false);
  const oldDb = `/tmp/candidate-old-host-${randomUUID()}.db`;
  const oldService = createGatewayServer({ dbPath: oldDb, aiVerseOsRoot: oldRoot, port: 0 });
  oldService.gateway.createBot(bot());
  oldService.gateway.record("artifact", sourceArtifact());
  const oldAddress = await oldService.listen();
  try {
    const denied = await httpJson(oldAddress.port, "POST", "/v1/candidates/write-back", candidateBody());
    assert.equal(denied.status, 400);
    assert.match(String(denied.body.message), /requires native AI-Verse OS mode/i);
    assert.equal(oldService.candidateWritebacks, undefined);
  } finally {
    await oldService.close();
    rmSync(oldRoot, { recursive: true, force: true });
    rmSync(oldDb, { force: true });
    rmSync(`${oldDb}-shm`, { force: true });
    rmSync(`${oldDb}-wal`, { force: true });
  }

  const root = hostFixture(true);
  const db = `/tmp/candidate-native-host-${randomUUID()}.db`;
  const service = createGatewayServer({ dbPath: db, aiVerseOsRoot: root, port: 0 });
  service.gateway.createBot(bot());
  service.gateway.record("artifact", sourceArtifact());
  const address = await service.listen();
  try {
    assert.ok(service.candidateWritebacks);
    const created = await httpJson(address.port, "POST", "/v1/candidates/write-back", candidateBody());
    assert.equal(created.status, 201);
    assert.equal(created.body.candidateKind, "knowledge");
    assert.equal(created.body.route.request.operation, "candidate.route");
    assert.equal(created.body.route.receipt.canonical_effect_occurred, false);
    assert.equal(JSON.stringify(created.body.route.artifact.payload).includes("HTTP_CANDIDATE_CONTENT"), false);

    const replay = await httpJson(address.port, "POST", "/v1/candidates/write-back", candidateBody());
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
