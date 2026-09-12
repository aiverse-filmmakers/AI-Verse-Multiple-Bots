import assert from "node:assert/strict";
import test from "node:test";
import {
  HermesRuntimeError,
  HermesStdioGatewayTransport,
  HermesStdioRuntimeAdapter,
  type HermesGatewayEvent,
  type HermesGatewayTransport,
  type HermesStdioTransportConfig
} from "../src/hermes-runtime.js";
import { createGatewayServer } from "../src/server.js";
import type { RuntimeExecutionContext } from "../src/runtime.js";
import type { JsonObject, StoredObject } from "../src/types.js";

function stored(id: string, kind: any, workspaceId: string, payload: JsonObject): StoredObject {
  return {
    id,
    kind,
    workspaceId,
    status: typeof payload.status === "string" ? payload.status : null,
    payload,
    createdAt: "2026-09-12T18:00:00Z",
    updatedAt: "2026-09-12T18:00:00Z"
  };
}

function context(
  tools: string[] = ["read_file", "hermes:web_search"],
  runtime: JsonObject = { adapter: "hermes", profile: "worker" },
  principalKind: "bot" | "worker" = "bot",
  signal = new AbortController().signal
): RuntimeExecutionContext {
  const principal = principalKind === "bot"
    ? stored("bot_hermes", "bot", "ws-hermes", {
        schema_version: "1.0",
        id: "bot_hermes",
        name: "Hermes teammate",
        kind: "durable",
        status: "active",
        role: { title: "Researcher", mission: "Complete delegated work." },
        runtime,
        execution: { environment_policy: "external_managed" },
        scope: { type: "workspace", workspace_id: "ws-hermes" },
        permissions: { policy_ref: "default-bot" },
        coordination: {}
      })
    : stored("worker_hermes", "worker", "ws-hermes", {
        schema_version: "1.0",
        id: "worker_hermes",
        type: "worker",
        kind: "temporary",
        run_id: "run_hermes",
        parent_owner_id: "bot_leader",
        workspace_id: "ws-hermes",
        role: { title: "Hermes worker", objective: "Do bounded work." },
        runtime,
        status: "ready"
      });

  return {
    principal,
    principalKind,
    ...(principalKind === "bot" ? { bot: principal as any } : {}),
    runtime,
    task: stored("task_hermes", "task", "ws-hermes", {
      schema_version: "1.0",
      id: "task_hermes",
      type: "task.delegate",
      workspace_id: "ws-hermes",
      created_by: "bot_leader",
      assignee_id: principal.id,
      owner_id: principal.id,
      root_objective_id: "root:hermes",
      objective: "Inspect the supplied evidence and return the conclusion.",
      required_constraints: ["Do not widen authority"],
      expected_output: { contract: "analysis-v1" },
      input_artifact_refs: [],
      lease_id: "lease_hermes",
      environment_lease_id: null,
      deadline_at: null,
      budget: {},
      hop: 0,
      max_hops: 6,
      status: "running",
      ...(principalKind === "worker" ? { run_id: "run_hermes" } : {})
    }),
    capabilityLease: stored("lease_hermes", "capability_lease", "ws-hermes", {
      schema_version: "1.0",
      id: "lease_hermes",
      type: "capability_lease",
      principal: principal.id,
      issued_to: principal.id,
      workspace_id: "ws-hermes",
      task_id: "task_hermes",
      tools,
      connections: ["docs"],
      destructive_actions: "deny",
      expires_at: "2030-01-01T00:00:00Z"
    }),
    environmentLease: null,
    inputArtifacts: [
      stored("artifact_input", "artifact", "ws-hermes", {
        schema_version: "1.0",
        id: "artifact_input",
        type: "artifact",
        workspace_id: "ws-hermes",
        created_by: "bot_leader",
        kind: "evidence",
        version: 1,
        inline_content: { observation: "INPUT_EVIDENCE" },
        provenance: { origin: "operator", trusted_instruction: false }
      })
    ],
    workspaceProjection: {
      schema_version: "1.0",
      provider: "test-os",
      workspace_id: "ws-hermes",
      projection_digest: "a".repeat(64),
      projected_at: "2026-09-12T18:00:00Z",
      sources: [{ ref: "WORKSPACE.yaml", digest: "b".repeat(64) }],
      data: { current_state: "CURRENT_CONTEXT" }
    },
    strategicIntent: {
      schema_version: "1.0",
      provider: "test-brain",
      workspace_id: "ws-hermes",
      root_objective_id: "root:hermes",
      intent_digest: "c".repeat(64),
      data: { goal: "STRATEGIC_CONTEXT" }
    },
    historicalRecall: null,
    skillsCapabilityResolution: null,
    signal
  };
}

class FakeTransport implements HermesGatewayTransport {
  readonly requests: Array<{ method: string; params: JsonObject }> = [];
  readonly events: HermesGatewayEvent[] = [];
  readonly waiters: Array<{
    resolve: (event: HermesGatewayEvent) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];
  started = false;
  closed = false;
  sessionId = "runtime-session-1";
  storedSessionId = "stored-session-1";
  info: JsonObject = {
    model: "hermes-test-model",
    provider: "test-provider",
    version: "9.9.9",
    yolo: false,
    approval_mode: "manual",
    lazy: false,
    tools: {
      file: ["read_file"],
      web: ["web_search"]
    },
    skills: {}
  };
  completion: JsonObject = {
    text: "Hermes finished the delegated task.",
    status: "complete",
    usage: { input: 12, output: 7, total: 19, calls: 2, cost_usd: 0.004 }
  };
  promptMode: "complete" | "hold" | "approval" | "error" = "complete";

  async start(_signal: AbortSignal): Promise<void> {
    this.started = true;
  }

  async request(method: string, params: JsonObject, _signal?: AbortSignal): Promise<JsonObject> {
    this.requests.push({ method, params });
    if (method === "session.create") {
      this.push({ type: "session.info", session_id: this.sessionId, payload: this.info });
      return { session_id: this.sessionId, stored_session_id: this.storedSessionId, info: { lazy: true } };
    }
    if (method === "prompt.submit") {
      if (this.promptMode === "complete") {
        this.push({ type: "tool.start", session_id: this.sessionId, payload: { name: "read_file" } });
        this.push({ type: "message.complete", session_id: this.sessionId, payload: this.completion });
      } else if (this.promptMode === "approval") {
        this.push({ type: "approval.request", session_id: this.sessionId, payload: { command: "rm", description: "unsafe" } });
      } else if (this.promptMode === "error") {
        this.push({ type: "error", session_id: this.sessionId, payload: { message: "remote Hermes failure" } });
      }
      return { status: "streaming" };
    }
    if (method === "session.interrupt") return { ok: true };
    if (method === "session.close") return { closed: true };
    return {};
  }

  async nextEvent(signal: AbortSignal): Promise<HermesGatewayEvent> {
    if (this.events.length > 0) return this.events.shift()!;
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    return await new Promise<HermesGatewayEvent>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        }
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(new Error("closed"));
    }
  }

  push(event: HermesGatewayEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve(event);
    } else {
      this.events.push(event);
    }
  }
}

function adapterWith(fake: FakeTransport): HermesStdioRuntimeAdapter {
  return new HermesStdioRuntimeAdapter({
    env: { PATH: "/usr/bin" },
    transportFactory: () => fake
  });
}

test("Hermes runtime executes through documented TUI gateway RPC while preserving durable Bot identity and bounded provenance", async () => {
  const fake = new FakeTransport();
  const adapter = adapterWith(fake);
  const result = await adapter.execute(context());

  assert.equal(fake.started, true);
  assert.equal(fake.closed, true);
  assert.deepEqual(fake.requests.map((request) => request.method), [
    "session.create",
    "prompt.submit",
    "session.close"
  ]);

  const created = fake.requests[0]!.params;
  assert.equal(created.source, "ai-verse-multiple-bots");
  assert.equal(created.profile, "worker");
  assert.equal(created.hidden, true);
  assert.equal(created.close_on_disconnect, true);

  const prompt = JSON.parse(String(fake.requests[1]!.params.text));
  assert.equal(prompt.contract, "ai-verse-multiple-bots/hermes-runtime-envelope-v1");
  assert.equal(prompt.execution_identity.principal_id, "bot_hermes");
  assert.equal(prompt.execution_identity.principal_kind, "bot");
  assert.equal(prompt.execution_identity.workspace_id, "ws-hermes");
  assert.equal(prompt.task.id, "task_hermes");
  assert.equal(prompt.workspace_projection.data.current_state, "CURRENT_CONTEXT");
  assert.equal(prompt.strategic_intent.data.goal, "STRATEGIC_CONTEXT");
  assert.equal(prompt.input_artifacts[0].inline_content.observation, "INPUT_EVIDENCE");

  assert.equal(result.artifactKind, "hermes_task_result");
  assert.equal(result.summary, "Hermes finished the delegated task.");
  assert.equal(result.output.remote_session_id, "stored-session-1");
  assert.equal(result.output.execution_principal_kind, "bot");
  assert.equal(result.usage?.input_tokens, 12);
  assert.equal(result.usage?.output_tokens, 7);
  assert.equal(result.usage?.cost, 0.004);
  assert.equal(result.usage?.actions, 3);

  const receipt = result.receipts?.[0] as JsonObject;
  assert.equal(receipt.kind, "hermes_execution");
  assert.equal(receipt.transport, "tui_gateway_stdio_jsonrpc");
  assert.equal(receipt.observed_tool_count, 2);
  assert.equal(receipt.tool_event_count, 1);
  assert.equal(receipt.principal_kind, "bot");
  const serializedReceipt = JSON.stringify(receipt);
  assert.equal(serializedReceipt.includes("CURRENT_CONTEXT"), false);
  assert.equal(serializedReceipt.includes("STRATEGIC_CONTEXT"), false);
  assert.equal(serializedReceipt.includes("INPUT_EVIDENCE"), false);
  assert.equal(serializedReceipt.includes("read_file"), false);
  assert.equal(serializedReceipt.includes("web_search"), false);
});

test("Hermes runtime preserves temporary Worker identity without promoting it into a Bot", async () => {
  const fake = new FakeTransport();
  const adapter = adapterWith(fake);
  const result = await adapter.execute(context(["read_file", "web_search"], { adapter: "hermes" }, "worker"));

  const prompt = JSON.parse(String(fake.requests[1]!.params.text));
  assert.equal(prompt.execution_identity.principal_id, "worker_hermes");
  assert.equal(prompt.execution_identity.principal_kind, "worker");
  assert.equal(prompt.task.run_id, "run_hermes");
  assert.equal(result.output.execution_principal_kind, "worker");
  assert.equal(result.receipts?.[0]?.principal_kind, "worker");
});

test("Hermes live tool surface must be an exact subset of the local capability lease before prompt submission", async () => {
  const fake = new FakeTransport();
  const adapter = adapterWith(fake);

  await assert.rejects(
    () => adapter.execute(context(["read_file"])),
    (error: unknown) => error instanceof HermesRuntimeError
      && error.code === "HERMES_CAPABILITY_LEASE_VIOLATION"
      && /web_search/.test(error.message)
  );
  assert.deepEqual(fake.requests.map((request) => request.method), ["session.create", "session.close"]);
});

test("Hermes runtime refuses YOLO and non-manual approval modes before delegated work begins", async () => {
  for (const info of [
    { yolo: true, approval_mode: "manual" },
    { yolo: false, approval_mode: "off" },
    { yolo: false, approval_mode: "smart" }
  ]) {
    const fake = new FakeTransport();
    fake.info = { ...fake.info, ...info };
    const adapter = adapterWith(fake);
    await assert.rejects(
      () => adapter.execute(context()),
      (error: unknown) => error instanceof HermesRuntimeError && error.code === "HERMES_APPROVAL_MODE_UNSAFE"
    );
    assert.equal(fake.requests.some((request) => request.method === "prompt.submit"), false);
  }
});

test("Hermes interaction-required events fail closed and are never auto-approved by the adapter", async () => {
  const fake = new FakeTransport();
  fake.promptMode = "approval";
  const adapter = adapterWith(fake);

  await assert.rejects(
    () => adapter.execute(context()),
    (error: unknown) => error instanceof HermesRuntimeError && error.code === "HERMES_INTERACTION_REQUIRED"
  );
  assert.equal(fake.requests.some((request) => request.method === "approval.respond"), false);
  assert.equal(fake.requests.some((request) => request.method === "session.interrupt"), true);
});

test("Hermes remote error events do not become successful local Artifacts", async () => {
  const fake = new FakeTransport();
  fake.promptMode = "error";
  const adapter = adapterWith(fake);

  await assert.rejects(
    () => adapter.execute(context()),
    (error: unknown) => error instanceof HermesRuntimeError
      && error.code === "HERMES_REMOTE_ERROR"
      && /remote Hermes failure/.test(error.message)
  );
});

test("Hermes adapter rejects remote/auth configuration because that authority belongs to Phase 4.6", async () => {
  for (const runtime of [
    { adapter: "hermes", endpoint: "https://remote.example" },
    { adapter: "hermes", api_key_env: "HERMES_KEY" },
    { adapter: "hermes", token: "secret" },
    { adapter: "hermes", websocket_url: "wss://remote.example/api/ws" }
  ]) {
    const fake = new FakeTransport();
    const adapter = adapterWith(fake);
    await assert.rejects(
      () => adapter.execute(context(["read_file", "web_search"], runtime)),
      (error: unknown) => error instanceof HermesRuntimeError && error.code === "HERMES_REMOTE_AUTH_OUT_OF_SCOPE"
    );
    assert.equal(fake.started, false);
  }
});

test("local cancellation interrupts the exact Hermes session and aborts local execution without waiting for Hermes to finish", async () => {
  const fake = new FakeTransport();
  fake.promptMode = "hold";
  const adapter = adapterWith(fake);

  const running = adapter.execute(context());
  while (!fake.requests.some((request) => request.method === "prompt.submit")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await adapter.cancel("task_hermes");
  await assert.rejects(() => running, /canceled/i);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const interrupt = fake.requests.find((request) => request.method === "session.interrupt");
  assert.equal(interrupt?.params.session_id, "runtime-session-1");
  assert.equal(fake.closed, true);
});

class MiniStream {
  private readonly handlers = new Map<string, Array<(...args: any[]) => void>>();
  on(name: string, handler: (...args: any[]) => void): this {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
    return this;
  }
  once(name: string, handler: (...args: any[]) => void): this {
    const wrapper = (...args: any[]) => {
      this.off(name, wrapper);
      handler(...args);
    };
    return this.on(name, wrapper);
  }
  off(name: string, handler: (...args: any[]) => void): void {
    const list = this.handlers.get(name) ?? [];
    this.handlers.set(name, list.filter((candidate) => candidate !== handler));
  }
  emit(name: string, ...args: any[]): void {
    for (const handler of [...(this.handlers.get(name) ?? [])]) handler(...args);
  }
}

test("Hermes stdio transport parses newline JSON-RPC, validates responses, and uses shell:false", async () => {
  const stdout = new MiniStream();
  const stderr = new MiniStream();
  const lifecycle = new MiniStream();
  const writes: string[] = [];
  let spawnCall: any = null;
  const child: any = {
    stdout,
    stderr,
    stdin: {
      write(line: string, callback?: (error?: Error | null) => void) {
        writes.push(line);
        const request = JSON.parse(line);
        queueMicrotask(() => {
          stdout.emit("data", JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { ok: true, echo_method: request.method }
          }) + "\n");
        });
        callback?.(null);
      },
      end() {}
    },
    once: lifecycle.once.bind(lifecycle),
    kill(signal: string) { lifecycle.emit("exit", null, signal); }
  };

  const config: HermesStdioTransportConfig = {
    command: "python3",
    args: ["-m", "tui_gateway.entry"],
    cwd: "/tmp/hermes",
    env: { PATH: "/usr/bin" },
    startupTimeoutMs: 1000,
    rpcTimeoutMs: 1000,
    maxLineBytes: 1024 * 1024
  };
  const transport = new HermesStdioGatewayTransport(config, (file, args, options) => {
    spawnCall = { file, args, options };
    queueMicrotask(() => {
      stdout.emit("data", JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "gateway.ready", payload: {} }
      }) + "\n");
    });
    return child;
  });

  const controller = new AbortController();
  await transport.start(controller.signal);
  const result = await transport.request("session.create", { source: "test" }, controller.signal);
  assert.deepEqual(result, { ok: true, echo_method: "session.create" });
  assert.equal(writes.length, 1);
  assert.equal(spawnCall.file, "python3");
  assert.deepEqual(spawnCall.args, ["-m", "tui_gateway.entry"]);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(spawnCall.options.cwd, "/tmp/hermes");
  await transport.close();
});

test("Gateway registers Hermes as a normal host-neutral runtime alongside existing adapters", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  await service.listen();
  await service.supervisor.waitForIdle();
  try {
    assert.equal(service.runtimes.has("hermes"), true);
    assert.equal(service.runtimes.get("hermes").id, "hermes");
    assert.equal(service.runtimes.has("a2a"), true);
  } finally {
    await service.close();
  }
});
