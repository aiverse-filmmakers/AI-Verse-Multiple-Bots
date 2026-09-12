import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../src/server.js";

const WORKSPACE = "ws-alpha";

function write(root: string, relative: string, content: string): void {
  const target = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8" });
}

function osFixture(): string {
  const root = `/tmp/ai-verse-four-cs-host-${randomUUID()}`;
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
    'purpose: "Four Cs health test workspace."',
    ""
  ].join("\n"));
  return root;
}

function httpJson(port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => resolvePromise({
        status: Number(res.statusCode),
        body: JSON.parse(chunks.join("") || "{}")
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("Gateway exposes additive Four Cs evidence without changing the existing health contract", async () => {
  const db = `/tmp/four-cs-server-${randomUUID()}.db`;
  const service = createGatewayServer({ dbPath: db, port: 0 });
  const address = await service.listen();
  try {
    const oldHealth = await httpJson(address.port, "/health");
    assert.equal(oldHealth.status, 200);
    assert.equal(typeof oldHealth.body.ok, "boolean");
    assert.equal(oldHealth.body.provider, undefined);

    const fourCs = await httpJson(address.port, "/v1/health/4cs");
    assert.equal(fourCs.status, 200);
    assert.equal(fourCs.body.provider, "ai-verse-multiple-bots/4cs-health-v1");
    assert.equal(fourCs.body.mode, "standalone");
    assert.equal(fourCs.body.projection_only, true);
    assert.equal(fourCs.body.ownership.assigns_four_cs_score, false);
  } finally {
    await service.close();
    rmSync(db, { force: true });
    rmSync(`${db}-shm`, { force: true });
    rmSync(`${db}-wal`, { force: true });
  }
});

test("native Gateway health can live-probe one canonical workspace without copying workspace content", async () => {
  const root = osFixture();
  const db = `/tmp/four-cs-native-server-${randomUUID()}.db`;
  const service = createGatewayServer({ dbPath: db, aiVerseOsRoot: root, port: 0 });
  const address = await service.listen();
  try {
    const result = await httpJson(address.port, `/v1/health/4cs?workspace=${WORKSPACE}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.mode, "ai_verse_os");
    assert.equal(result.body.scope, `workspace:${WORKSPACE}`);
    assert.equal(result.body.four_cs.context.status, "verified");
    assert.equal(result.body.integration_contracts.workspace_projection, true);
    assert.equal(result.body.integration_contracts.brain_ingress, true);
    assert.equal(result.body.integration_contracts.memory_recall, true);
    assert.equal(result.body.integration_contracts.skills_resolution, true);
    assert.equal(result.body.integration_contracts.automation_ingress, true);
    assert.equal(result.body.ownership.canonical_health_owner, "ai-verse-os/audit");
    assert.equal(JSON.stringify(result.body).includes("Four Cs health test workspace"), false);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(db, { force: true });
    rmSync(`${db}-shm`, { force: true });
    rmSync(`${db}-wal`, { force: true });
  }
});

test("health endpoint rejects invalid workspace scopes without mutating coordination state", async () => {
  const db = `/tmp/four-cs-invalid-scope-${randomUUID()}.db`;
  const service = createGatewayServer({ dbPath: db, port: 0 });
  const before = service.store.listObjects().length;
  const address = await service.listen();
  try {
    const result = await httpJson(address.port, "/v1/health/4cs?workspace=../escape");
    assert.equal(result.status, 400);
    assert.match(String(result.body.message), /canonical AI-Verse workspace id/i);
    assert.equal(service.store.listObjects().length, before);
  } finally {
    await service.close();
    rmSync(db, { force: true });
    rmSync(`${db}-shm`, { force: true });
    rmSync(`${db}-wal`, { force: true });
  }
});
