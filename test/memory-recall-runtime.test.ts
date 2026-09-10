import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { AiVerseMemoryRecallError, AiVerseMemoryRecallSource } from "../src/ai-verse-memory-recall.js";
import { MemoryRecallRuntimeRegistry, parseTaskMemoryRecallRequest } from "../src/memory-recall-runtime.js";
import { OpenAICompatibleRuntimeAdapter } from "../src/openai-compatible-runtime.js";
import {
  RuntimeRegistry,
  type HistoricalRecallProjection,
  type HistoricalRecallSource,
  type RuntimeAdapter,
  type RuntimeExecutionContext
} from "../src/runtime.js";
import type { JsonObject, StoredObject } from "../src/types.js";

function write(root: string, relative: string, content: string): void {
  const path = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8" });
}

function nativeHostFixture(withMemory = true): string {
  const root = `/tmp/ai-verse-memory-recall-${randomUUID()}`;
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces/ws-alpha"), { recursive: true });
  write(root, "AI-VERSE.yaml", [
    'schema_version: "2.0"',
    "architecture: unified-workspace",
    "paths:",
    "  workspaces: workspaces/",
    ""
  ].join("\n"));
  write(root, "AGENTS.md", "# Runtime\nLoad .aiverse/extensions/registry.json when present.\n");
  write(root, "system/extensions/README.md", "# Extensions\nRegistry: .aiverse/extensions/registry.json\n");
  if (withMemory) {
    write(root, "scripts/ai-verse-memory/memory.py", "# entrypoint\n");
    write(root, "scripts/ai-verse-memory/memory_engine.py", "# engine\n");
    write(root, "scripts/ai-verse-memory/os_compat.py", "# compatibility\n");
  }
  return root;
}

function stored(id: string, kind: string, workspaceId: string, payload: JsonObject): StoredObject {
  const now = "2026-09-10T12:00:00.000Z";
  return { id, kind: kind as any, workspaceId, payload, createdAt: now, updatedAt: now };
}

function runtimeContext(memoryRecall?: JsonObject): RuntimeExecutionContext {
  const bot = stored("bot_memory", "bot", "ws-alpha", {
    schema_version: "1.0",
    id: "bot_memory",
    type: "bot",
    name: "Memory Bot",
    role: { title: "Analyst", mission: "Use scoped context." },
    status: "active"
  });
  return {
    principal: bot,
    principalKind: "bot",
    bot: bot as any,
    runtime: {},
    task: stored("task_memory", "task", "ws-alpha", {
      schema_version: "1.0",
      id: "task_memory",
      type: "task.delegate",
      workspace_id: "ws-alpha",
      root_objective_id: "root_memory",
      objective: "Use the relevant historical lesson",
      required_constraints: [],
      ...(memoryRecall ? { memory_recall: memoryRecall } : {})
    }),
    capabilityLease: stored("lease_memory", "capability_lease", "ws-alpha", { id: "lease_memory" }),
    environmentLease: null,
    inputArtifacts: [],
    signal: new AbortController().signal
  };
}

function projection(scope = "workspace:ws-alpha", content = "HISTORICAL_SECRET_MARKER"): HistoricalRecallProjection {
  return {
    schema_version: "1.0",
    provider: "test-memory",
    workspace_id: "ws-alpha",
    query_digest: "query-digest",
    recall_digest: "recall-digest",
    recalled_at: "2026-09-10T12:00:00.000Z",
    include_history: false,
    requested_limit: 4,
    items: [{
      id: "mem_1",
      kind: "memory",
      type: "experience",
      scope,
      content,
      path: "workspaces/ws-alpha/memory/atomic/2026-09/mem_1.md",
      digest: "item-digest",
      source_version: "source-v1",
      freshness: "historical"
    }]
  };
}

class FakeRecallSource implements HistoricalRecallSource {
  calls: Array<{ workspaceId: string; query: string; limit?: number }> = [];
  constructor(readonly result: HistoricalRecallProjection = projection()) {}
  async recall(workspaceId: string, request: any): Promise<HistoricalRecallProjection> {
    this.calls.push({ workspaceId, query: request.query, limit: request.limit });
    return this.result;
  }
}

class CaptureRuntime implements RuntimeAdapter {
  readonly id = "capture";
  contexts: RuntimeExecutionContext[] = [];
  async execute(context: RuntimeExecutionContext): Promise<any> {
    this.contexts.push(context);
    return {
      summary: "captured",
      artifactKind: "capture",
      output: { ok: true },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 },
      receipts: [{ kind: "inner" }]
    };
  }
}

test("Task Memory recall request is explicit, bounded, and cannot widen workspace scope", () => {
  assert.equal(parseTaskMemoryRecallRequest(undefined), null);
  assert.equal(parseTaskMemoryRecallRequest(false), null);
  assert.deepEqual(parseTaskMemoryRecallRequest({ query: "past lesson", limit: 4 }), {
    query: "past lesson",
    limit: 4,
    include_history: false
  });
  assert.throws(() => parseTaskMemoryRecallRequest({ query: "x", all_workspaces: true }), /cannot widen/i);
  assert.throws(() => parseTaskMemoryRecallRequest({ query: "x", workspace_id: "ws-beta" }), /cannot widen/i);
  assert.throws(() => parseTaskMemoryRecallRequest({ query: "x", limit: 13 }), /integer from 1 to 12/i);
});

test("no recall request invokes no Memory source and leaves ordinary execution unchanged", async () => {
  const base = new RuntimeRegistry();
  const inner = new CaptureRuntime();
  base.register(inner);
  const source = new FakeRecallSource();
  const registry = new MemoryRecallRuntimeRegistry(base, source);

  const result = await registry.get("capture").execute(runtimeContext());
  assert.equal(result.summary, "captured");
  assert.equal(source.calls.length, 0);
  assert.equal(inner.contexts.length, 1);
  assert.equal(inner.contexts[0]?.historicalRecall, undefined);
});

test("explicit recall reaches runtime but persisted receipt contains provenance and no recalled text", async () => {
  const base = new RuntimeRegistry();
  const inner = new CaptureRuntime();
  base.register(inner);
  const source = new FakeRecallSource();
  const registry = new MemoryRecallRuntimeRegistry(base, source);

  const result = await registry.get("capture").execute(runtimeContext({ query: "past lesson", limit: 4 }));
  assert.deepEqual(source.calls, [{ workspaceId: "ws-alpha", query: "past lesson", limit: 4 }]);
  assert.equal(inner.contexts[0]?.historicalRecall?.items[0]?.content, "HISTORICAL_SECRET_MARKER");
  const persisted = JSON.stringify(result.receipts);
  assert.match(persisted, /historical_memory_recall/);
  assert.match(persisted, /recall-digest/);
  assert.match(persisted, /source-v1/);
  assert.equal(persisted.includes("HISTORICAL_SECRET_MARKER"), false);
});

test("out-of-scope historical result fails before the model runtime can execute", async () => {
  const base = new RuntimeRegistry();
  const inner = new CaptureRuntime();
  base.register(inner);
  const source = new FakeRecallSource(projection("workspace:ws-beta"));
  const registry = new MemoryRecallRuntimeRegistry(base, source);

  await assert.rejects(
    () => registry.get("capture").execute(runtimeContext({ query: "past lesson" })),
    /escaped Task workspace scope/i
  );
  assert.equal(inner.contexts.length, 0);
});

test("explicit recall fails closed when no Memory source is configured", async () => {
  const base = new RuntimeRegistry();
  const inner = new CaptureRuntime();
  base.register(inner);
  const registry = new MemoryRecallRuntimeRegistry(base);

  await assert.rejects(
    () => registry.get("capture").execute(runtimeContext({ query: "past lesson" })),
    /no Memory recall source is configured/i
  );
  assert.equal(inner.contexts.length, 0);
});

test("AI-Verse Memory source uses argument-vector native workspace recall and accepts only workspace plus operator results", async () => {
  const root = nativeHostFixture();
  const calls: Array<{ file: string; args: string[]; options: any }> = [];
  const execFileImpl = ((file: string, args: string[], options: any, callback: any) => {
    calls.push({ file, args, options });
    callback(null, [
      "# Memory recall",
      "",
      "Query: past lesson",
      "Scope: workspace:ws-alpha",
      "",
      "## mem_workspace [memory/experience] (workspace:ws-alpha)",
      "Workspace lesson text",
      "source=session; updated=2026-09-09T12:00:00+00:00; version=abc123; freshness=historical; path=workspaces/ws-alpha/memory/atomic/2026-09/mem_workspace.md",
      "",
      "## profile_1 [profile/profile] (operator)",
      "Operator preference text",
      "version=def456; freshness=fresh; path=operator/profile/PROFILE.md",
      ""
    ].join("\n"), "");
  }) as any;

  try {
    const source = new AiVerseMemoryRecallSource(root, { pythonExecutable: "python-test", execFileImpl });
    const recalled = await source.recall("ws-alpha", { query: "past lesson", limit: 2 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.file, "python-test");
    assert.deepEqual(calls[0]?.args.slice(-7), ["recall", "past lesson", "--workspace", "ws-alpha", "--limit", "2"].slice(-7));
    assert.equal(calls[0]?.options.shell, undefined);
    assert.deepEqual(recalled.items.map((item) => item.scope), ["workspace:ws-alpha", "operator"]);
    assert.equal(recalled.items.length, 2);
    assert.match(recalled.query_digest, /^[a-f0-9]{64}$/);
    assert.match(recalled.recall_digest, /^[a-f0-9]{64}$/);
    assert.match(recalled.items[0]?.digest ?? "", /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Memory source rejects unrelated workspace output and missing installed engine", async () => {
  const root = nativeHostFixture();
  const badExec = ((_file: string, _args: string[], _options: any, callback: any) => {
    callback(null, [
      "# Memory recall",
      "",
      "Query: past lesson",
      "",
      "## mem_bad [memory/fact] (workspace:ws-beta)",
      "Should never cross workspaces",
      "path=workspaces/ws-beta/memory/atomic/2026-09/mem_bad.md",
      ""
    ].join("\n"), "");
  }) as any;

  try {
    const source = new AiVerseMemoryRecallSource(root, { execFileImpl: badExec });
    await assert.rejects(() => source.recall("ws-alpha", { query: "past lesson" }), (error: any) => {
      assert.ok(error instanceof AiVerseMemoryRecallError);
      assert.equal(error.code, "MEMORY_SCOPE_VIOLATION");
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const missing = nativeHostFixture(false);
  try {
    const source = new AiVerseMemoryRecallSource(missing, { execFileImpl: (() => undefined) as any });
    await assert.rejects(() => source.recall("ws-alpha", { query: "past lesson" }), (error: any) => {
      assert.ok(error instanceof AiVerseMemoryRecallError);
      assert.equal(error.code, "MEMORY_UNAVAILABLE");
      return true;
    });
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }
});

test("OpenAI-compatible prompting marks historical recall lower authority than current host context", async () => {
  let requestBody: any = null;
  const adapter = new OpenAICompatibleRuntimeAdapter({
    fetchImpl: (async (_url: any, init: any) => {
      requestBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        id: "response_1",
        model: "test-model",
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any,
    env: {}
  });
  const context = runtimeContext({ query: "past lesson" });
  context.runtime = { endpoint: "https://example.test/v1/chat/completions", model: "test-model" };
  context.workspaceProjection = {
    schema_version: "1.0",
    provider: "workspace-test",
    workspace_id: "ws-alpha",
    projection_digest: "workspace-digest",
    projected_at: "2026-09-10T12:00:00.000Z",
    sources: [],
    data: { current_state: "CURRENT_CANONICAL_MARKER" }
  };
  context.historicalRecall = projection();

  await adapter.execute(context);
  const system = String(requestBody.messages[0].content);
  const user = String(requestBody.messages[1].content);
  assert.match(system, /read-only host context/i);
  assert.match(system, /historical recall.*lower-authority/i);
  assert.match(system, /current workspace context.*take precedence/i);
  assert.match(user, /CURRENT_CANONICAL_MARKER/);
  assert.match(user, /HISTORICAL_SECRET_MARKER/);
});
