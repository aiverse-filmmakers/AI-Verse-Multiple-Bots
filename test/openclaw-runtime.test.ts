import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  OPENCLAW_NO_TOOLS_SENTINEL,
  OpenClawAgentExecRuntimeAdapter,
  OpenClawCliCommandTransport,
  OpenClawRuntimeError,
  type OpenClawCommandResult,
  type OpenClawCommandTransport
} from "../src/openclaw-runtime.js";
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
    createdAt: "2026-09-12T19:00:00Z",
    updatedAt: "2026-09-12T19:00:00Z"
  };
}

function runtimeContext(
  tools: string[] = ["openclaw:read", "web_search"],
  runtime: JsonObject = { adapter: "openclaw" },
  principalKind: "bot" | "worker" = "bot",
  signal = new AbortController().signal
): RuntimeExecutionContext {
  const principal = principalKind === "bot"
    ? stored("bot_openclaw", "bot", "ws-openclaw", {
        schema_version: "1.0",
        id: "bot_openclaw",
        name: "OpenClaw teammate",
        kind: "durable",
        status: "active",
        role: { title: "Researcher", mission: "Complete delegated work." },
        runtime,
        execution: { environment_policy: "external_managed" },
        scope: { type: "workspace", workspace_id: "ws-openclaw" },
        permissions: { policy_ref: "default-bot" },
        coordination: {}
      })
    : stored("worker_openclaw", "worker", "ws-openclaw", {
        schema_version: "1.0",
        id: "worker_openclaw",
        type: "worker",
        kind: "temporary",
        run_id: "run_openclaw",
        parent_owner_id: "bot_leader",
        workspace_id: "ws-openclaw",
        role: { title: "OpenClaw worker", objective: "Do bounded work." },
        runtime,
        status: "ready"
      });

  return {
    principal,
    principalKind,
    ...(principalKind === "bot" ? { bot: principal as any } : {}),
    runtime,
    task: stored("task_openclaw", "task", "ws-openclaw", {
      schema_version: "1.0",
      id: "task_openclaw",
      type: "task.delegate",
      workspace_id: "ws-openclaw",
      created_by: "bot_leader",
      assignee_id: principal.id,
      owner_id: principal.id,
      root_objective_id: "root:openclaw",
      objective: "Inspect the supplied evidence and return the conclusion.",
      required_constraints: ["Do not widen authority"],
      expected_output: { contract: "analysis-v1" },
      input_artifact_refs: [],
      lease_id: "lease_openclaw",
      environment_lease_id: null,
      deadline_at: null,
      budget: {},
      hop: 0,
      max_hops: 6,
      status: "running",
      ...(principalKind === "worker" ? { run_id: "run_openclaw" } : {})
    }),
    capabilityLease: stored("lease_openclaw", "capability_lease", "ws-openclaw", {
      schema_version: "1.0",
      id: "lease_openclaw",
      type: "capability_lease",
      principal: principal.id,
      issued_to: principal.id,
      workspace_id: "ws-openclaw",
      task_id: "task_openclaw",
      tools,
      connections: ["docs"],
      destructive_actions: "deny",
      expires_at: "2030-01-01T00:00:00Z"
    }),
    environmentLease: null,
    inputArtifacts: [
      stored("artifact_openclaw_input", "artifact", "ws-openclaw", {
        schema_version: "1.0",
        id: "artifact_openclaw_input",
        type: "artifact",
        workspace_id: "ws-openclaw",
        created_by: "bot_leader",
        kind: "evidence",
        version: 1,
        inline_content: { observation: "OPENCLAW_INPUT_EVIDENCE" },
        provenance: { origin: "operator", trusted_instruction: false }
      })
    ],
    workspaceProjection: {
      schema_version: "1.0",
      provider: "test-os",
      workspace_id: "ws-openclaw",
      projection_digest: "a".repeat(64),
      projected_at: "2026-09-12T19:00:00Z",
      sources: [{ ref: "WORKSPACE.yaml", digest: "b".repeat(64) }],
      data: { current_state: "OPENCLAW_CURRENT_CONTEXT" }
    },
    strategicIntent: {
      schema_version: "1.0",
      provider: "test-brain",
      workspace_id: "ws-openclaw",
      root_objective_id: "root:openclaw",
      intent_digest: "c".repeat(64),
      data: { goal: "OPENCLAW_STRATEGIC_CONTEXT" }
    },
    historicalRecall: null,
    skillsCapabilityResolution: null,
    signal
  };
}

function successEnvelope(overrides: JsonObject = {}): JsonObject {
  return {
    ok: true,
    status: "ok",
    final: "OpenClaw finished the delegated task.",
    payloads: [{ text: "OpenClaw finished the delegated task." }],
    usage: { input: 14, output: 8, total: 22 },
    costUsd: 0.006,
    assistantTurns: 2,
    codeModeEngaged: false,
    toolSummary: { calls: 2, tools: ["read", "web_search"], failures: 0 },
    model: "openai/test-model",
    provider: "openai",
    sessionId: "oc-session-1",
    ...overrides
  };
}

class FakeOpenClawTransport implements OpenClawCommandTransport {
  readonly calls: Array<{
    command: string;
    args: string[];
    options: {
      cwd?: string;
      env: Record<string, string | undefined>;
      stdin?: string;
      timeoutMs: number;
      maxStdoutBytes: number;
    };
  }> = [];
  configPath: string;
  result: OpenClawCommandResult = {
    stdout: JSON.stringify(successEnvelope()),
    stderr: "",
    exitCode: 0,
    signal: null
  };
  overlayContent: JsonObject | null = null;
  overlayPath: string | null = null;
  hold = false;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  async discoverConfigPath(
    _command: string,
    _env: Record<string, string | undefined>,
    _signal: AbortSignal
  ): Promise<string> {
    return this.configPath;
  }

  async run(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env: Record<string, string | undefined>;
      stdin?: string;
      signal: AbortSignal;
      timeoutMs: number;
      maxStdoutBytes: number;
    }
  ): Promise<OpenClawCommandResult> {
    this.calls.push({
      command,
      args,
      options: {
        cwd: options.cwd,
        env: { ...options.env },
        stdin: options.stdin,
        timeoutMs: options.timeoutMs,
        maxStdoutBytes: options.maxStdoutBytes
      }
    });
    const configIndex = args.indexOf("--config");
    if (configIndex >= 0) {
      const path = args[configIndex + 1]!;
      this.overlayPath = path;
      this.overlayContent = JSON.parse(readFileSync(path, "utf8"));
    }
    if (!this.hold) return this.result;
    return await new Promise<OpenClawCommandResult>((resolve, reject) => {
      const abort = () => reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("canceled"));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

function fixtureConfig(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ai-verse-openclaw-test-"));
  const path = join(dir, "openclaw.json");
  writeFileSync(path, JSON.stringify({
    tools: {
      profile: "coding",
      deny: ["exec"]
    },
    agents: {
      defaults: {
        sandbox: { mode: "all" }
      }
    }
  }) + "\n");
  return { dir, path };
}

function adapterWith(fake: FakeOpenClawTransport): OpenClawAgentExecRuntimeAdapter {
  return new OpenClawAgentExecRuntimeAdapter({
    env: { PATH: "/usr/bin", OPENCLAW_INCLUDE_ROOTS: "/existing/root" },
    transport: fake as any
  });
}

test("OpenClaw runtime uses agent exec with a temporary read-only exact tool overlay and preserves Bot identity", async () => {
  const fixture = fixtureConfig();
  try {
    const fake = new FakeOpenClawTransport(fixture.path);
    const adapter = adapterWith(fake);
    const result = await adapter.execute(runtimeContext());

    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0]!;
    assert.equal(call.command, "openclaw");
    assert.deepEqual(call.args.slice(0, 4), ["agent", "exec", "--message-file", "-"]);
    assert.equal(call.args.includes("--json"), true);
    assert.equal(call.args.includes("--config"), true);
    assert.equal(call.args.includes("--cwd"), true);
    assert.equal(call.args.includes("--timeout"), true);
    assert.equal(call.options.env.OPENCLAW_CONFIG_READONLY, "1");
    assert.equal(String(call.options.env.OPENCLAW_INCLUDE_ROOTS).includes(dirname(fixture.path)), true);
    assert.equal(String(call.options.env.OPENCLAW_INCLUDE_ROOTS).includes("/existing/root"), true);

    assert.deepEqual(fake.overlayContent, {
      $include: fixture.path,
      tools: { allow: ["read", "web_search"] }
    });
    assert.equal(fake.overlayPath ? existsSync(fake.overlayPath) : true, false);

    const prompt = JSON.parse(String(call.options.stdin));
    assert.equal(prompt.contract, "ai-verse-multiple-bots/openclaw-runtime-envelope-v1");
    assert.equal(prompt.execution_identity.principal_id, "bot_openclaw");
    assert.equal(prompt.execution_identity.principal_kind, "bot");
    assert.equal(prompt.execution_identity.workspace_id, "ws-openclaw");
    assert.equal(prompt.task.id, "task_openclaw");
    assert.equal(prompt.workspace_projection.data.current_state, "OPENCLAW_CURRENT_CONTEXT");
    assert.equal(prompt.strategic_intent.data.goal, "OPENCLAW_STRATEGIC_CONTEXT");
    assert.equal(prompt.input_artifacts[0].inline_content.observation, "OPENCLAW_INPUT_EVIDENCE");

    assert.equal(result.artifactKind, "openclaw_task_result");
    assert.equal(result.summary, "OpenClaw finished the delegated task.");
    assert.equal(result.output.remote_session_id, "oc-session-1");
    assert.equal(result.output.execution_principal_kind, "bot");
    assert.equal(result.usage?.input_tokens, 14);
    assert.equal(result.usage?.output_tokens, 8);
    assert.equal(result.usage?.cost, 0.006);
    assert.equal(result.usage?.actions, 4);

    const receipt = result.receipts?.[0] as JsonObject;
    assert.equal(receipt.transport, "agent_exec_cli");
    assert.equal(receipt.observed_tool_call_count, 2);
    assert.equal(receipt.principal_kind, "bot");
    assert.equal(receipt.tool_policy, "temporary_readonly_global_allow_overlay");
    const serializedReceipt = JSON.stringify(receipt);
    assert.equal(serializedReceipt.includes(fixture.path), false);
    assert.equal(serializedReceipt.includes("read"), false);
    assert.equal(serializedReceipt.includes("web_search"), false);
    assert.equal(serializedReceipt.includes("OPENCLAW_CURRENT_CONTEXT"), false);
    assert.equal(serializedReceipt.includes("OPENCLAW_STRATEGIC_CONTEXT"), false);
    assert.equal(serializedReceipt.includes("OPENCLAW_INPUT_EVIDENCE"), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OpenClaw runtime preserves temporary Worker identity and run lineage", async () => {
  const fixture = fixtureConfig();
  try {
    const fake = new FakeOpenClawTransport(fixture.path);
    const adapter = adapterWith(fake);
    const result = await adapter.execute(runtimeContext(["read", "web_search"], { adapter: "openclaw" }, "worker"));

    const prompt = JSON.parse(String(fake.calls[0]!.options.stdin));
    assert.equal(prompt.execution_identity.principal_id, "worker_openclaw");
    assert.equal(prompt.execution_identity.principal_kind, "worker");
    assert.equal(prompt.task.run_id, "run_openclaw");
    assert.equal(result.output.execution_principal_kind, "worker");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OpenClaw exact tool leases may use openclaw: prefixes but reject groups, globs, and wildcards", async () => {
  const fixture = fixtureConfig();
  try {
    const fake = new FakeOpenClawTransport(fixture.path);
    const adapter = adapterWith(fake);
    fake.result.stdout = JSON.stringify(successEnvelope({
      toolSummary: { calls: 1, tools: ["read"], failures: 0 }
    }));
    await adapter.execute(runtimeContext(["openclaw:read"]));
    assert.deepEqual(fake.overlayContent?.tools, { allow: ["read"] });

    for (const tools of [
      ["group:fs"],
      ["*"],
      ["outlook__*"],
      ["read?"],
      ["tool[abc]"]
    ]) {
      const blocked = new FakeOpenClawTransport(fixture.path);
      const blockedAdapter = adapterWith(blocked);
      await assert.rejects(
        () => blockedAdapter.execute(runtimeContext(tools)),
        (error: unknown) => error instanceof OpenClawRuntimeError
          && error.code === "OPENCLAW_BROAD_TOOL_LEASE_FORBIDDEN"
      );
      assert.equal(blocked.calls.length, 0);
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("zero-tool OpenClaw lease becomes a non-empty impossible allow cap rather than an unrestricted empty allowlist", async () => {
  const fixture = fixtureConfig();
  try {
    const fake = new FakeOpenClawTransport(fixture.path);
    fake.result.stdout = JSON.stringify(successEnvelope({
      toolSummary: { calls: 0, tools: [], failures: 0 }
    }));
    const adapter = adapterWith(fake);
    await adapter.execute(runtimeContext([]));
    assert.deepEqual(fake.overlayContent?.tools, { allow: [OPENCLAW_NO_TOOLS_SENTINEL] });
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OpenClaw toolSummary is checked after execution and cannot claim tool use outside the local lease", async () => {
  const fixture = fixtureConfig();
  try {
    const fake = new FakeOpenClawTransport(fixture.path);
    fake.result.stdout = JSON.stringify(successEnvelope({
      toolSummary: { calls: 1, tools: ["exec"], failures: 0 }
    }));
    const adapter = adapterWith(fake);

    await assert.rejects(
      () => adapter.execute(runtimeContext(["read"])),
      (error: unknown) => error instanceof OpenClawRuntimeError
        && error.code === "OPENCLAW_TOOL_POLICY_VIOLATION"
        && /exec/.test(error.message)
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OpenClaw error and timeout envelopes never become successful local Artifacts", async () => {
  const fixture = fixtureConfig();
  try {
    const cases = [
      {
        envelope: successEnvelope({
          ok: false,
          status: "error",
          final: "",
          error: { message: "provider failed", kind: "agent_error" }
        }),
        exitCode: 1,
        expectedCode: "OPENCLAW_REMOTE_FAILED"
      },
      {
        envelope: successEnvelope({
          ok: false,
          status: "timeout",
          final: "",
          error: { message: "turn timed out", kind: "timeout" }
        }),
        exitCode: 2,
        expectedCode: "OPENCLAW_REMOTE_TIMEOUT"
      }
    ];
    for (const item of cases) {
      const fake = new FakeOpenClawTransport(fixture.path);
      fake.result = {
        stdout: JSON.stringify(item.envelope),
        stderr: "",
        exitCode: item.exitCode,
        signal: null
      };
      const adapter = adapterWith(fake);
      await assert.rejects(
        () => adapter.execute(runtimeContext()),
        (error: unknown) => error instanceof OpenClawRuntimeError
          && error.code === item.expectedCode
      );
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OpenClaw malformed stable JSON fails closed", async () => {
  const fixture = fixtureConfig();
  try {
    const fake = new FakeOpenClawTransport(fixture.path);
    fake.result.stdout = "{not-json";
    const adapter = adapterWith(fake);
    await assert.rejects(
      () => adapter.execute(runtimeContext()),
      (error: unknown) => error instanceof OpenClawRuntimeError && error.code === "OPENCLAW_INVALID_RESPONSE"
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("OpenClaw adapter rejects remote/Gateway authentication fields because Phase 4.6 owns that boundary", async () => {
  const fixture = fixtureConfig();
  try {
    for (const runtime of [
      { adapter: "openclaw", endpoint: "https://remote.example" },
      { adapter: "openclaw", gateway_url: "wss://remote.example" },
      { adapter: "openclaw", gateway_token: "secret" },
      { adapter: "openclaw", ssh: "host" }
    ]) {
      const fake = new FakeOpenClawTransport(fixture.path);
      const adapter = adapterWith(fake);
      await assert.rejects(
        () => adapter.execute(runtimeContext(["read"], runtime)),
        (error: unknown) => error instanceof OpenClawRuntimeError
          && error.code === "OPENCLAW_REMOTE_AUTH_OUT_OF_SCOPE"
      );
      assert.equal(fake.calls.length, 0);
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("explicit OpenClaw config symlinks fail before execution", async () => {
  const fixture = fixtureConfig();
  const link = join(fixture.dir, "linked-config.json");
  try {
    symlinkSync(fixture.path, link);
    const fake = new FakeOpenClawTransport(fixture.path);
    const adapter = adapterWith(fake);
    await assert.rejects(
      () => adapter.execute(runtimeContext(["read"], { adapter: "openclaw", config_path: link })),
      (error: unknown) => error instanceof OpenClawRuntimeError
        && error.code === "OPENCLAW_CONFIG_SYMLINK_FORBIDDEN"
    );
    assert.equal(fake.calls.length, 0);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("local cancellation aborts the active one-shot OpenClaw run", async () => {
  const fixture = fixtureConfig();
  try {
    const fake = new FakeOpenClawTransport(fixture.path);
    fake.hold = true;
    const adapter = adapterWith(fake);
    const running = adapter.execute(runtimeContext(["read", "web_search"]));

    while (fake.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.cancel("task_openclaw");
    await assert.rejects(() => running, /canceled/i);
    assert.equal(fake.overlayPath ? existsSync(fake.overlayPath) : true, false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
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

test("OpenClaw CLI transport spawns shell:false, writes stdin, and parses process lifecycle", async () => {
  const stdout = new MiniStream();
  const stderr = new MiniStream();
  const lifecycle = new MiniStream();
  let spawnCall: any = null;
  let stdin = "";
  const child: any = {
    stdout,
    stderr,
    stdin: {
      end(value?: string) {
        stdin = value ?? "";
        queueMicrotask(() => {
          stdout.emit("data", JSON.stringify(successEnvelope()) + "\n");
          lifecycle.emit("exit", 0, null);
        });
      }
    },
    once: lifecycle.once.bind(lifecycle),
    kill(signal: string) {
      lifecycle.emit("exit", null, signal);
    }
  };
  const transport = new OpenClawCliCommandTransport(
    ((file: string, args: string[], options: any) => {
      spawnCall = { file, args, options };
      return child;
    }) as any,
    (() => { throw new Error("unused"); }) as any
  );
  const controller = new AbortController();
  const result = await transport.run(
    "openclaw",
    ["agent", "exec", "--json"],
    {
      cwd: "/tmp",
      env: { PATH: "/usr/bin" },
      stdin: "PROMPT",
      signal: controller.signal,
      timeoutMs: 1000,
      maxStdoutBytes: 1024 * 1024
    }
  );
  assert.equal(spawnCall.file, "openclaw");
  assert.deepEqual(spawnCall.args, ["agent", "exec", "--json"]);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(stdin, "PROMPT");
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).status, "ok");
});

test("OpenClaw config discovery uses the documented config file --json command", async () => {
  const fixture = fixtureConfig();
  try {
    let call: any = null;
    const fakeExec = ((file: string, args: string[], options: any, callback: any) => {
      call = { file, args, options };
      queueMicrotask(() => callback(null, JSON.stringify({ path: fixture.path }), ""));
      return { kill() {} };
    }) as any;
    const transport = new OpenClawCliCommandTransport((() => { throw new Error("unused"); }) as any, fakeExec);
    const controller = new AbortController();
    const path = await transport.discoverConfigPath("openclaw", { PATH: "/usr/bin" }, controller.signal);
    assert.equal(path, fixture.path);
    assert.equal(call.file, "openclaw");
    assert.deepEqual(call.args, ["config", "file", "--json"]);
    assert.equal(call.options.maxBuffer, 256 * 1024);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Gateway registers OpenClaw as a normal host-neutral runtime alongside A2A and Hermes", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  await service.listen();
  await service.supervisor.waitForIdle();
  try {
    assert.equal(service.runtimes.has("openclaw"), true);
    assert.equal(service.runtimes.get("openclaw").id, "openclaw");
    assert.equal(service.runtimes.has("a2a"), true);
    assert.equal(service.runtimes.has("hermes"), true);
  } finally {
    await service.close();
  }
});
