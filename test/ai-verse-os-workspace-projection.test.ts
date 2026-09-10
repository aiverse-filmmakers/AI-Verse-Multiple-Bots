import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import {
  AiVerseOsWorkspaceProjectionError,
  AiVerseOsWorkspaceProjector
} from "../src/ai-verse-os-workspace-projection.js";
import { createGatewayServer } from "../src/server.js";
import type { BotManifest } from "../src/types.js";

function write(root: string, relative: string, content: string): void {
  const path = resolve(root, ...relative.split("/"));
  const segments = relative.split("/");
  if (segments.length > 1) mkdirSync(resolve(root, ...segments.slice(0, -1)), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8" });
}

function hostFixture(): string {
  const root = `/tmp/ai-verse-workspace-projection-${randomUUID()}`;
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces"), { recursive: true });
  write(root, "AI-VERSE.yaml", [
    'schema_version: "2.0"',
    "architecture: unified-workspace",
    "paths:",
    "  workspaces: workspaces/",
    ""
  ].join("\n"));
  write(root, "AGENTS.md", "# Runtime\nLoad .aiverse/extensions/registry.json when present.\n");
  write(root, "system/extensions/README.md", "# Extensions\nRegistry: .aiverse/extensions/registry.json\n");
  return root;
}

function workspaceManifest(id: string, status = "active", currentContext = "context/CURRENT.md"): string {
  return [
    'schema_version: "2.0"',
    `id: "${id}"`,
    `name: "${id === "ws-alpha" ? "Alpha Workspace" : "Beta Workspace"}"`,
    'type: "project"',
    `status: "${status}"`,
    "domains:",
    "  - filmmaking",
    "  - ai",
    'purpose: "Produce the current campaign safely."',
    "owners:",
    "  - operator_local",
    "success_criteria:",
    "  - approved campaign delivered",
    `current_context: "${currentContext}"`,
    "canonical_sources:",
    "  - briefs/master.md",
    "connections:",
    "  - google-drive",
    "privacy:",
    '  classification: "private"',
    '  notes: "Do not cross workspace boundaries."',
    "approval:",
    '  external_actions: "confirm"',
    '  destructive_actions: "confirm"',
    '  high_stakes_decisions: "human-review"',
    ""
  ].join("\n");
}

function currentContext(marker: string): string {
  return [
    "# Current Workspace Context",
    "",
    "Last reviewed: 2026-09-10",
    "",
    "## Objective",
    "",
    `Finish campaign ${marker}`,
    "",
    "## Current state",
    "",
    "Storyboard approved; edit remains open.",
    "",
    "## Next useful actions",
    "",
    "- finish edit",
    "- validate export",
    "",
    "## Pending decisions",
    "",
    "- final music choice",
    "",
    "## Constraints / approvals",
    "",
    "- external publishing requires confirmation",
    "",
    "## Source pointers",
    "",
    "- briefs/master.md",
    "",
    "## Non-canonical extra section",
    "",
    "THIS_SHOULD_NOT_BE_PROJECTED",
    ""
  ].join("\n");
}

function addWorkspace(root: string, id: string, marker: string, status = "active", currentContextPath = "context/CURRENT.md"): void {
  write(root, `workspaces/${id}/WORKSPACE.yaml`, workspaceManifest(id, status, currentContextPath));
  if (!currentContextPath.includes("..")) write(root, `workspaces/${id}/${currentContextPath}`, currentContext(marker));
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

async function settleSupervisor(service: ReturnType<typeof createGatewayServer>): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  await service.supervisor.waitForIdle();
}

function modelBot(endpoint: string): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_projection-model",
    name: "Projection Model",
    kind: "durable",
    status: "active",
    role: { title: "Workspace Analyst", mission: "Use current workspace context without rewriting host truth." },
    runtime: { adapter: "openai-compatible", endpoint, model: "projection-test-model" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws-alpha" },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

test("active AI-Verse OS workspace projects only bounded canonical identity, boundaries, and current context", () => {
  const root = hostFixture();
  addWorkspace(root, "ws-alpha", "ALPHA_PRIVATE_MARKER");
  try {
    const projector = new AiVerseOsWorkspaceProjector(root);
    const first = projector.project("ws-alpha");
    const second = projector.project("ws-alpha");

    assert.equal(first.workspace_id, "ws-alpha");
    assert.equal(first.provider, "ai-verse-os-workspace-v1");
    assert.equal(first.projection_digest, second.projection_digest);
    assert.equal((first.data.identity as any).name, "Alpha Workspace");
    assert.equal((first.data.identity as any).status, "active");
    assert.deepEqual((first.data.identity as any).domains, ["filmmaking", "ai"]);
    assert.deepEqual((first.data.boundaries as any).declared_connections, ["google-drive"]);
    assert.equal((first.data.boundaries as any).privacy.classification, "private");
    assert.match(String((first.data.current_context as any).objective), /ALPHA_PRIVATE_MARKER/);
    assert.equal(JSON.stringify(first.data).includes("THIS_SHOULD_NOT_BE_PROJECTED"), false);
    assert.deepEqual(first.sources.map((source) => source.ref), [
      "workspaces/ws-alpha/WORKSPACE.yaml",
      "workspaces/ws-alpha/context/CURRENT.md"
    ]);
    assert.ok(first.sources.every((source) => /^[a-f0-9]{64}$/.test(source.digest)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace projection is live and uncached: a canonical context edit changes the next projection digest", () => {
  const root = hostFixture();
  addWorkspace(root, "ws-alpha", "VERSION_ONE");
  try {
    const projector = new AiVerseOsWorkspaceProjector(root);
    const first = projector.project("ws-alpha");
    write(root, "workspaces/ws-alpha/context/CURRENT.md", currentContext("VERSION_TWO"));
    const second = projector.project("ws-alpha");
    assert.notEqual(second.projection_digest, first.projection_digest);
    assert.match(String((second.data.current_context as any).objective), /VERSION_TWO/);
    assert.equal(JSON.stringify(second.data).includes("VERSION_ONE"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace projection fails closed on identity mismatch and non-active workspace state", () => {
  const root = hostFixture();
  addWorkspace(root, "ws-alpha", "ACTIVE");
  addWorkspace(root, "ws-beta", "PAUSED", "paused");
  try {
    const projector = new AiVerseOsWorkspaceProjector(root);
    assert.throws(
      () => projector.project("ws-beta"),
      (error: unknown) => error instanceof AiVerseOsWorkspaceProjectionError && error.code === "WORKSPACE_NOT_ACTIVE"
    );

    write(root, "workspaces/ws-alpha/WORKSPACE.yaml", workspaceManifest("ws-beta"));
    assert.throws(
      () => projector.project("ws-alpha"),
      (error: unknown) => error instanceof AiVerseOsWorkspaceProjectionError && error.code === "WORKSPACE_ID_MISMATCH"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace projection rejects current-context traversal, symlinks, and oversized sources", () => {
  const traversalRoot = hostFixture();
  addWorkspace(traversalRoot, "ws-alpha", "UNUSED", "active", "../ws-beta/context/CURRENT.md");
  try {
    const projector = new AiVerseOsWorkspaceProjector(traversalRoot);
    assert.throws(
      () => projector.project("ws-alpha"),
      (error: unknown) => error instanceof AiVerseOsWorkspaceProjectionError && error.code === "INVALID_WORKSPACE_PATH"
    );
  } finally {
    rmSync(traversalRoot, { recursive: true, force: true });
  }

  const symlinkRoot = hostFixture();
  addWorkspace(symlinkRoot, "ws-alpha", "ORIGINAL");
  const outside = `/tmp/ai-verse-workspace-external-${randomUUID()}.md`;
  try {
    writeFileSync(outside, currentContext("OUTSIDE"), { encoding: "utf8" });
    rmSync(resolve(symlinkRoot, "workspaces", "ws-alpha", "context", "CURRENT.md"), { force: true });
    symlinkSync(outside, resolve(symlinkRoot, "workspaces", "ws-alpha", "context", "CURRENT.md"));
    const projector = new AiVerseOsWorkspaceProjector(symlinkRoot);
    assert.throws(
      () => projector.project("ws-alpha"),
      (error: unknown) => error instanceof AiVerseOsWorkspaceProjectionError && error.code === "WORKSPACE_SYMLINK_REJECTED"
    );
  } finally {
    rmSync(symlinkRoot, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }

  const oversizedRoot = hostFixture();
  addWorkspace(oversizedRoot, "ws-alpha", "SMALL");
  try {
    write(rootPath(oversizedRoot, "workspaces/ws-alpha/context/CURRENT.md"), "", "");
  } catch {
    // unreachable helper guard; actual oversized write follows
  }
  try {
    write(oversizedRoot, "workspaces/ws-alpha/context/CURRENT.md", `# Current Workspace Context\n\n## Objective\n\n${"x".repeat(2048)}\n`);
    const projector = new AiVerseOsWorkspaceProjector(oversizedRoot, { maxCurrentContextBytes: 1024 });
    assert.throws(
      () => projector.project("ws-alpha"),
      (error: unknown) => error instanceof AiVerseOsWorkspaceProjectionError && error.code === "WORKSPACE_PROJECTION_TOO_LARGE"
    );
  } finally {
    rmSync(oversizedRoot, { recursive: true, force: true });
  }
});

function rootPath(root: string, relative: string): string {
  return resolve(root, ...relative.split("/"));
}

test("native runner passes live projection to the model but persists only projection provenance, never workspace text", async () => {
  const root = hostFixture();
  const secretMarker = `WORKSPACE_ONLY_${randomUUID()}`;
  addWorkspace(root, "ws-alpha", secretMarker);

  const modelRequests: any[] = [];
  const modelServer = createServer(async (req: any, res: any) => {
    const chunks: string[] = [];
    for await (const chunk of req) chunks.push(String(chunk));
    const body = JSON.parse(chunks.join("") || "{}") as any;
    modelRequests.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "projection_req_1",
      model: "projection-test-model",
      choices: [{ message: { role: "assistant", content: "Projection was consumed without echoing host state." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 8 }
    }));
  });
  const modelAddress = await new Promise<{ port: number }>((resolvePromise, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", () => {
      const value = modelServer.address();
      resolvePromise({ port: typeof value === "object" && value ? value.port : 0 });
    });
  });

  const dbPath = `/tmp/ai-verse-workspace-runtime-${randomUUID()}.db`;
  const service = createGatewayServer({ dbPath, port: 0, aiVerseOsRoot: root });
  const gatewayAddress = await service.listen();
  const endpoint = `http://127.0.0.1:${modelAddress.port}/v1/chat/completions`;
  try {
    const bot = await httpJson(gatewayAddress.port, "POST", "/v1/bots", modelBot(endpoint));
    assert.equal(bot.status, 201);
    const delegation = await httpJson(gatewayAddress.port, "POST", "/v1/delegations", {
      createdBy: "operator_local",
      assigneeId: "bot_projection-model",
      workspaceId: "ws-alpha",
      rootObjectiveId: "obj_projection",
      objective: "Use the current workspace context to decide the next safe editing step.",
      reason: "Current workspace state is required",
      requiredConstraints: ["Do not publish externally"]
    });
    assert.equal(delegation.status, 201);
    await settleSupervisor(service);

    assert.equal(modelRequests.length, 1);
    const systemPrompt = String(modelRequests[0]?.messages?.[0]?.content ?? "");
    const modelInput = JSON.parse(String(modelRequests[0]?.messages?.[1]?.content ?? "{}"));
    assert.match(systemPrompt, /read-only host context/i);
    assert.equal(modelInput.workspace_projection.workspace_id, "ws-alpha");
    assert.match(String(modelInput.workspace_projection.data.current_context.objective), new RegExp(secretMarker));

    const task = service.store.getObject(delegation.body.task.id);
    assert.equal(task?.payload.status, "completed");
    const artifactId = (task?.payload.output_artifact_refs as string[])[0] as string;
    const artifact = service.store.getObject(artifactId);
    assert.ok(artifact);
    const receipts = artifact?.payload.runtime_receipts as any[];
    const projectionReceipt = receipts.find((receipt) => receipt.kind === "workspace_state_projection");
    assert.equal(projectionReceipt?.workspace_id, "ws-alpha");
    assert.match(String(projectionReceipt?.projection_digest), /^[a-f0-9]{64}$/);
    assert.deepEqual(projectionReceipt?.sources.map((source: any) => source.ref), [
      "workspaces/ws-alpha/WORKSPACE.yaml",
      "workspaces/ws-alpha/context/CURRENT.md"
    ]);
    assert.equal(Object.prototype.hasOwnProperty.call(projectionReceipt, "data"), false);

    const persisted = JSON.stringify({
      bots: service.store.listObjects("bot", "ws-alpha"),
      tasks: service.store.listObjects("task", "ws-alpha"),
      artifacts: service.store.listObjects("artifact", "ws-alpha"),
      messages: service.store.listObjects("message", "ws-alpha"),
      events: service.store.listEventsAfter(0, 1000)
    });
    assert.equal(persisted.includes(secretMarker), false);
    assert.equal(persisted.includes("Storyboard approved; edit remains open."), false);
  } finally {
    await service.close();
    await new Promise<void>((resolvePromise, reject) => modelServer.close((error: Error | undefined) => error ? reject(error) : resolvePromise()));
    rmSync(root, { recursive: true, force: true });
    rmSync(dbPath, { force: true });
  }
});

test("workspace isolation is exact and standalone server mode does not project host state implicitly", async () => {
  const root = hostFixture();
  addWorkspace(root, "ws-alpha", "ALPHA_ONLY");
  addWorkspace(root, "ws-beta", "BETA_ONLY");
  try {
    const projector = new AiVerseOsWorkspaceProjector(root);
    const alpha = projector.project("ws-alpha");
    const beta = projector.project("ws-beta");
    assert.equal(JSON.stringify(alpha.data).includes("ALPHA_ONLY"), true);
    assert.equal(JSON.stringify(alpha.data).includes("BETA_ONLY"), false);
    assert.equal(JSON.stringify(beta.data).includes("BETA_ONLY"), true);
    assert.equal(JSON.stringify(beta.data).includes("ALPHA_ONLY"), false);

    const service = createGatewayServer({ dbPath: `/tmp/ai-verse-standalone-projection-${randomUUID()}.db`, port: 0 });
    try {
      assert.ok(service.runner);
      assert.equal((service.runner as any).workspaceProjector, undefined);
    } finally {
      await service.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
