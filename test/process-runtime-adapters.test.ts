import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ClaudeCodePrintRuntimeAdapter,
  ClaudeCodeRuntimeError,
  claudeCodeBuiltInTools,
  parseClaudeCodeJson
} from "../src/claude-code-runtime.js";
import {
  CodexExecRuntimeAdapter,
  CodexRuntimeError,
  codexProcessCapabilities,
  parseCodexJsonl
} from "../src/codex-runtime.js";
import {
  LocalCliProcessError,
  type LocalCliProcessRequest,
  type LocalCliProcessResult,
  type LocalCliProcessTransport,
  SpawnLocalCliProcessTransport
} from "../src/local-cli-process.js";
import type { RuntimeExecutionContext } from "../src/runtime.js";
import { createGatewayServer } from "../src/server.js";
import type { JsonObject, StoredObject } from "../src/types.js";

function stored(id: string, kind: any, workspaceId: string, payload: JsonObject): StoredObject {
  return {
    id,
    kind,
    workspaceId,
    status: typeof payload.status === "string" ? payload.status : null,
    payload,
    createdAt: "2026-09-12T20:00:00Z",
    updatedAt: "2026-09-12T20:00:00Z"
  };
}

function workspaceFixture(): { dir: string; workspace: string } {
  const dir = mkdtempSync(join(tmpdir(), "ai-verse-process-runtime-test-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "PROCESS_RUNTIME_EVIDENCE\n");
  return { dir, workspace };
}

function runtimeContext(
  adapter: "codex" | "claude-code",
  workspace: string,
  tools: string[],
  runtimeExtra: JsonObject = {},
  principalKind: "bot" | "worker" = "bot",
  signal = new AbortController().signal
): RuntimeExecutionContext {
  const runtime: JsonObject = { adapter, cwd: workspace, ...runtimeExtra };
  const principal = principalKind === "bot"
    ? stored(`bot_${adapter}`, "bot", "ws-process", {
        schema_version: "1.0",
        id: `bot_${adapter}`,
        name: "Process teammate",
        kind: "durable",
        status: "active",
        role: { title: "Engineer", mission: "Complete delegated work." },
        runtime,
        execution: { environment_policy: "external_managed" },
        scope: { type: "workspace", workspace_id: "ws-process" },
        permissions: { policy_ref: "default-bot" },
        coordination: {}
      })
    : stored(`worker_${adapter}`, "worker", "ws-process", {
        schema_version: "1.0",
        id: `worker_${adapter}`,
        type: "worker",
        kind: "temporary",
        run_id: "run_process",
        parent_owner_id: "bot_leader",
        workspace_id: "ws-process",
        role: { title: "Process worker", objective: "Do bounded work." },
        runtime,
        status: "ready"
      });

  return {
    principal,
    principalKind,
    ...(principalKind === "bot" ? { bot: principal as any } : {}),
    runtime,
    task: stored(`task_${adapter}`, "task", "ws-process", {
      schema_version: "1.0",
      id: `task_${adapter}`,
      type: "task.delegate",
      workspace_id: "ws-process",
      created_by: "bot_leader",
      assignee_id: principal.id,
      owner_id: principal.id,
      root_objective_id: "root:process",
      objective: "Inspect the supplied evidence and complete the delegated work.",
      required_constraints: ["Do not widen authority"],
      expected_output: { contract: "process-v1" },
      input_artifact_refs: [],
      lease_id: `lease_${adapter}`,
      environment_lease_id: null,
      deadline_at: null,
      budget: {},
      hop: 0,
      max_hops: 6,
      status: "running",
      ...(principalKind === "worker" ? { run_id: "run_process" } : {})
    }),
    capabilityLease: stored(`lease_${adapter}`, "capability_lease", "ws-process", {
      schema_version: "1.0",
      id: `lease_${adapter}`,
      type: "capability_lease",
      principal: principal.id,
      issued_to: principal.id,
      workspace_id: "ws-process",
      task_id: `task_${adapter}`,
      tools,
      connections: [],
      destructive_actions: "deny",
      expires_at: "2030-01-01T00:00:00Z"
    }),
    environmentLease: null,
    inputArtifacts: [
      stored("artifact_process_input", "artifact", "ws-process", {
        schema_version: "1.0",
        id: "artifact_process_input",
        type: "artifact",
        workspace_id: "ws-process",
        created_by: "bot_leader",
        kind: "evidence",
        version: 1,
        inline_content: { observation: "PROCESS_INPUT_EVIDENCE" },
        provenance: { origin: "operator", trusted_instruction: false }
      })
    ],
    workspaceProjection: {
      schema_version: "1.0",
      provider: "test-os",
      workspace_id: "ws-process",
      projection_digest: "a".repeat(64),
      projected_at: "2026-09-12T20:00:00Z",
      sources: [{ ref: "WORKSPACE.yaml", digest: "b".repeat(64) }],
      data: { current_state: "PROCESS_CURRENT_CONTEXT" }
    },
    strategicIntent: {
      schema_version: "1.0",
      provider: "test-brain",
      workspace_id: "ws-process",
      root_objective_id: "root:process",
      intent_digest: "c".repeat(64),
      data: { goal: "PROCESS_STRATEGIC_CONTEXT" }
    },
    historicalRecall: null,
    skillsCapabilityResolution: null,
    signal
  };
}

function codexSuccess(options: {
  command?: boolean;
  fileChange?: boolean;
  webSearch?: boolean;
  mcp?: boolean;
  collab?: boolean;
  text?: string;
} = {}): string {
  const lines: JsonObject[] = [
    { type: "thread.started", thread_id: "codex-thread-1" },
    { type: "turn.started" }
  ];
  let itemIndex = 1;
  const add = (type: string) => lines.push({
    type: "item.completed",
    item: { id: `item-${itemIndex++}`, type }
  });
  if (options.command) add("command_execution");
  if (options.fileChange) add("file_change");
  if (options.webSearch) add("web_search");
  if (options.mcp) add("mcp_tool_call");
  if (options.collab) add("collab_tool_call");
  lines.push({
    type: "item.completed",
    item: {
      id: `item-${itemIndex++}`,
      type: "reasoning",
      text: "PRIVATE_REASONING_SHOULD_NOT_PERSIST"
    }
  });
  lines.push({
    type: "item.completed",
    item: {
      id: `item-${itemIndex++}`,
      type: "agent_message",
      text: options.text ?? "Codex completed the delegated task."
    }
  });
  lines.push({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_write_input_tokens: 1,
      output_tokens: 7,
      reasoning_output_tokens: 3
    }
  });
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function claudeSuccess(overrides: JsonObject = {}): string {
  return JSON.stringify({
    subtype: "success",
    is_error: false,
    result: "Claude Code completed the delegated task.",
    session_id: "claude-session-1",
    total_cost_usd: 0.012,
    num_turns: 3,
    usage: {
      input_tokens: 11,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 4,
      output_tokens: 9
    },
    permission_denials: [],
    ...overrides
  });
}

class FakeProcessTransport implements LocalCliProcessTransport {
  readonly calls: LocalCliProcessRequest[] = [];
  codexInventory: LocalCliProcessResult = {
    stdout: JSON.stringify([
      { name: "managed.docs", enabled: true },
      { name: "user-local", enabled: true }
    ]),
    stderr: "",
    exitCode: 0,
    signal: null
  };
  codexExec: LocalCliProcessResult = {
    stdout: codexSuccess({ command: true, fileChange: true }),
    stderr: "",
    exitCode: 0,
    signal: null
  };
  claudeExec: LocalCliProcessResult = {
    stdout: claudeSuccess(),
    stderr: "",
    exitCode: 0,
    signal: null
  };
  holdCodexExec = false;
  holdClaude = false;

  async run(request: LocalCliProcessRequest): Promise<LocalCliProcessResult> {
    this.calls.push({
      ...request,
      args: [...request.args],
      env: { ...request.env }
    });
    if (request.args[0] === "mcp") return this.codexInventory;
    if (request.command === "codex") {
      if (!this.holdCodexExec) return this.codexExec;
      return await this.waitForAbort(request.signal);
    }
    if (request.command === "claude") {
      if (!this.holdClaude) return this.claudeExec;
      return await this.waitForAbort(request.signal);
    }
    throw new Error(`Unexpected fake command ${request.command}`);
  }

  private async waitForAbort(signal: AbortSignal): Promise<LocalCliProcessResult> {
    return await new Promise<LocalCliProcessResult>((_resolve, reject) => {
      const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("canceled"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
}

function configValues(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-c" && typeof args[index + 1] === "string") values.push(args[index + 1]!);
  }
  return values;
}

test("Codex adapter uses an isolated harness, explicit permission profile, MCP inventory disable, and ephemeral JSONL exec", async () => {
  const fixture = workspaceFixture();
  try {
    const fake = new FakeProcessTransport();
    const adapter = new CodexExecRuntimeAdapter({ env: { PATH: "/usr/bin" }, transport: fake });
    const context = runtimeContext(
      "codex",
      fixture.workspace,
      ["codex:workspace-write", "codex:web-search"],
      { model: "gpt-test", timeout_seconds: 30 }
    );
    const result = await adapter.execute(context);

    assert.equal(fake.calls.length, 2);
    const inventory = fake.calls[0]!;
    const exec = fake.calls[1]!;
    assert.equal(inventory.command, "codex");
    assert.deepEqual(inventory.args, ["mcp", "list", "--json"]);
    assert.notEqual(inventory.cwd, fixture.workspace);

    assert.equal(exec.command, "codex");
    assert.equal(exec.args[0], "exec");
    for (const flag of [
      "--strict-config",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "-C"
    ]) assert.equal(exec.args.includes(flag), true, flag);
    assert.equal(exec.args.includes("--model"), true);
    assert.equal(exec.args[exec.args.length - 1], "-");
    const cdIndex = exec.args.indexOf("-C");
    assert.equal(exec.args[cdIndex + 1], inventory.cwd);
    assert.equal(existsSync(inventory.cwd), false);

    const overrides = configValues(exec.args);
    assert.equal(overrides.includes('approval_policy="never"'), true);
    assert.equal(overrides.includes('default_permissions="ai-verse-runtime"'), true);
    assert.equal(overrides.some((value) =>
      value.startsWith("permissions.ai-verse-runtime.filesystem=")
      && value.includes('":minimal"="read"')
      && value.includes(JSON.stringify(fixture.workspace))
      && value.includes('"write"')
    ), true);
    assert.equal(overrides.includes("permissions.ai-verse-runtime.network.enabled=false"), true);
    assert.equal(overrides.includes("features.shell_tool=true"), true);
    assert.equal(overrides.includes("features.unified_exec=true"), true);
    assert.equal(overrides.includes("features.plugins=false"), true);
    assert.equal(overrides.includes("features.hooks=false"), true);
    assert.equal(overrides.includes("features.multi_agent=false"), true);
    assert.equal(overrides.includes("features.multi_agent_v2=false"), true);
    assert.equal(overrides.includes("features.memories=false"), true);
    assert.equal(overrides.includes("orchestrator.skills.enabled=false"), true);
    assert.equal(overrides.includes("skills.include_instructions=false"), true);
    assert.equal(overrides.includes('web_search="live"'), true);
    assert.equal(overrides.includes('mcp_servers."managed.docs".enabled=false'), true);
    assert.equal(overrides.includes('mcp_servers."user-local".enabled=false'), true);

    const prompt = JSON.parse(exec.stdin);
    assert.equal(prompt.contract, "ai-verse-multiple-bots/codex-runtime-envelope-v1");
    assert.equal(prompt.execution_identity.principal_id, "bot_codex");
    assert.equal(prompt.execution_identity.principal_kind, "bot");
    assert.equal(prompt.authority.workspace_path, fixture.workspace);
    assert.deepEqual(prompt.authority.process_capabilities, [
      "codex:web-search",
      "codex:workspace-read",
      "codex:workspace-write"
    ]);
    assert.equal(prompt.workspace_projection.data.current_state, "PROCESS_CURRENT_CONTEXT");
    assert.equal(prompt.strategic_intent.data.goal, "PROCESS_STRATEGIC_CONTEXT");
    assert.equal(prompt.input_artifacts[0].inline_content.observation, "PROCESS_INPUT_EVIDENCE");

    assert.equal(result.artifactKind, "codex_task_result");
    assert.equal(result.output.remote_thread_id, "codex-thread-1");
    assert.equal(result.output.execution_principal_kind, "bot");
    assert.equal(result.usage?.input_tokens, 13);
    assert.equal(result.usage?.output_tokens, 10);
    assert.equal(result.usage?.actions, 3);

    const receipt = result.receipts?.[0] as JsonObject;
    assert.equal(receipt.mcp_preflight_server_count, 2);
    assert.equal(receipt.mcp_policy, "inventory_then_explicit_disable");
    assert.equal(receipt.project_config_policy, "temporary_harness_cwd");
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(fixture.workspace), false);
    assert.equal(serialized.includes("PROCESS_CURRENT_CONTEXT"), false);
    assert.equal(serialized.includes("PROCESS_STRATEGIC_CONTEXT"), false);
    assert.equal(serialized.includes("PRIVATE_REASONING_SHOULD_NOT_PERSIST"), false);
    assert.equal(serialized.includes("managed.docs"), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Codex zero-capability mode disables workspace execution and web search", async () => {
  const fixture = workspaceFixture();
  try {
    const fake = new FakeProcessTransport();
    fake.codexExec.stdout = codexSuccess();
    const adapter = new CodexExecRuntimeAdapter({ transport: fake });
    await adapter.execute(runtimeContext("codex", fixture.workspace, []));
    const exec = fake.calls[1]!;
    const overrides = configValues(exec.args);
    assert.equal(overrides.includes("features.shell_tool=false"), true);
    assert.equal(overrides.includes("features.unified_exec=false"), true);
    assert.equal(overrides.includes("features.standalone_web_search=false"), true);
    assert.equal(overrides.includes('web_search="disabled"'), true);
    const fsOverride = overrides.find((value) => value.startsWith("permissions.ai-verse-runtime.filesystem="))!;
    assert.equal(fsOverride.includes(fixture.workspace), false);
    assert.equal(fsOverride.includes('":minimal"="read"'), true);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Codex workspace-read is read-only while workspace-write implies read", async () => {
  const fixture = workspaceFixture();
  try {
    for (const item of [
      { tools: ["codex:workspace-read"], expected: '"read"' },
      { tools: ["codex:workspace-write"], expected: '"write"' }
    ]) {
      const fake = new FakeProcessTransport();
      fake.codexExec.stdout = codexSuccess({ command: true, fileChange: item.expected === '"write"' });
      const adapter = new CodexExecRuntimeAdapter({ transport: fake });
      await adapter.execute(runtimeContext("codex", fixture.workspace, item.tools));
      const overrides = configValues(fake.calls[1]!.args);
      const fsOverride = overrides.find((value) => value.startsWith("permissions.ai-verse-runtime.filesystem="))!;
      assert.equal(fsOverride.includes(item.expected), true);
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Codex requires exact codex:-scoped capabilities and rejects broad or unknown grants before subprocess work", async () => {
  const fixture = workspaceFixture();
  try {
    const cases = [
      { tools: ["*"], code: "CODEX_BROAD_CAPABILITY_FORBIDDEN" },
      { tools: ["group:fs"], code: "CODEX_BROAD_CAPABILITY_FORBIDDEN" },
      { tools: ["codex:workspace-*"], code: "CODEX_BROAD_CAPABILITY_FORBIDDEN" },
      { tools: ["read"], code: "CODEX_UNSCOPED_CAPABILITY_FORBIDDEN" },
      { tools: ["codex:mcp"], code: "CODEX_UNSUPPORTED_CAPABILITY" }
    ];
    for (const item of cases) {
      const fake = new FakeProcessTransport();
      const adapter = new CodexExecRuntimeAdapter({ transport: fake });
      await assert.rejects(
        () => adapter.execute(runtimeContext("codex", fixture.workspace, item.tools)),
        (error: unknown) => error instanceof CodexRuntimeError && error.code === item.code
      );
      assert.equal(fake.calls.length, 0);
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Codex JSONL parser ignores reasoning and enforces observed tool classes against the lease", () => {
  const readWrite = new Set<any>(["workspace-read", "workspace-write"]);
  const parsed = parseCodexJsonl(codexSuccess({ command: true, fileChange: true }), readWrite);
  assert.equal(parsed.finalText, "Codex completed the delegated task.");
  assert.equal(parsed.finalText.includes("PRIVATE_REASONING"), false);

  assert.throws(
    () => parseCodexJsonl(codexSuccess({ command: true }), new Set()),
    (error: unknown) => error instanceof CodexRuntimeError && error.code === "CODEX_WORKSPACE_POLICY_VIOLATION"
  );
  assert.throws(
    () => parseCodexJsonl(codexSuccess({ fileChange: true }), new Set<any>(["workspace-read"])),
    (error: unknown) => error instanceof CodexRuntimeError && error.code === "CODEX_WRITE_POLICY_VIOLATION"
  );
  assert.throws(
    () => parseCodexJsonl(codexSuccess({ webSearch: true }), new Set()),
    (error: unknown) => error instanceof CodexRuntimeError && error.code === "CODEX_WEB_POLICY_VIOLATION"
  );
  assert.throws(
    () => parseCodexJsonl(codexSuccess({ mcp: true }), new Set()),
    (error: unknown) => error instanceof CodexRuntimeError && error.code === "CODEX_MCP_POLICY_VIOLATION"
  );
  assert.throws(
    () => parseCodexJsonl(codexSuccess({ collab: true }), new Set()),
    (error: unknown) => error instanceof CodexRuntimeError && error.code === "CODEX_COLLAB_POLICY_VIOLATION"
  );
});

test("Codex rejects malformed MCP inventory and remote/session configuration", async () => {
  const fixture = workspaceFixture();
  try {
    {
      const fake = new FakeProcessTransport();
      fake.codexInventory.stdout = "{bad";
      const adapter = new CodexExecRuntimeAdapter({ transport: fake });
      await assert.rejects(
        () => adapter.execute(runtimeContext("codex", fixture.workspace, [])),
        (error: unknown) => error instanceof CodexRuntimeError && error.code === "CODEX_MCP_INVENTORY_INVALID"
      );
      assert.equal(fake.calls.length, 1);
    }
    for (const runtimeExtra of [
      { endpoint: "https://remote.example" },
      { token: "secret" },
      { ssh: "host" },
      { thread_id: "old-thread" }
    ]) {
      const fake = new FakeProcessTransport();
      const adapter = new CodexExecRuntimeAdapter({ transport: fake });
      await assert.rejects(
        () => adapter.execute(runtimeContext("codex", fixture.workspace, [], runtimeExtra)),
        (error: unknown) => error instanceof CodexRuntimeError && error.code === "CODEX_REMOTE_AUTH_OUT_OF_SCOPE"
      );
      assert.equal(fake.calls.length, 0);
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Codex preserves temporary Worker identity and Team Run lineage", async () => {
  const fixture = workspaceFixture();
  try {
    const fake = new FakeProcessTransport();
    fake.codexExec.stdout = codexSuccess();
    const adapter = new CodexExecRuntimeAdapter({ transport: fake });
    const result = await adapter.execute(
      runtimeContext("codex", fixture.workspace, [], {}, "worker")
    );
    const prompt = JSON.parse(fake.calls[1]!.stdin);
    assert.equal(prompt.execution_identity.principal_id, "worker_codex");
    assert.equal(prompt.execution_identity.principal_kind, "worker");
    assert.equal(prompt.task.run_id, "run_process");
    assert.equal(result.output.execution_principal_kind, "worker");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Codex cancellation aborts the active exec after MCP preflight", async () => {
  const fixture = workspaceFixture();
  try {
    const fake = new FakeProcessTransport();
    fake.holdCodexExec = true;
    const adapter = new CodexExecRuntimeAdapter({ transport: fake });
    const running = adapter.execute(runtimeContext("codex", fixture.workspace, []));
    while (fake.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.cancel("task_codex");
    await assert.rejects(() => running, /canceled/i);
    assert.equal(existsSync(fake.calls[0]!.cwd), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Claude Code adapter uses safe + restricted print mode with an exact built-in tool set and no persistence", async () => {
  const fixture = workspaceFixture();
  try {
    const fake = new FakeProcessTransport();
    const adapter = new ClaudeCodePrintRuntimeAdapter({
      env: { PATH: "/usr/bin", HOME: "/home/test" },
      transport: fake
    });
    const result = await adapter.execute(runtimeContext(
      "claude-code",
      fixture.workspace,
      ["claude-code:workspace-write", "claude-code:web-search"],
      { model: "sonnet", effort: "high", max_turns: 8, max_budget_usd: 5, timeout_seconds: 30 }
    ));

    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0]!;
    assert.equal(call.command, "claude");
    assert.equal(call.cwd, fixture.workspace);
    for (const flag of [
      "-p",
      "--safe-mode",
      "--restricted",
      "--tools",
      "--disallowedTools",
      "--permission-mode",
      "--permission-prompts",
      "--output-format",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--no-chrome",
      "--allowedTools",
      "--model",
      "--effort",
      "--max-turns",
      "--max-budget-usd"
    ]) assert.equal(call.args.includes(flag), true, flag);

    const toolsIndex = call.args.indexOf("--tools");
    assert.equal(call.args[toolsIndex + 1], "Edit,Glob,Grep,Read,WebSearch,Write");
    const allowIndex = call.args.indexOf("--allowedTools");
    assert.equal(call.args[allowIndex + 1], "Edit,Glob,Grep,Read,WebSearch,Write");
    const denyIndex = call.args.indexOf("--disallowedTools");
    assert.equal(call.args[denyIndex + 1], "mcp__*");
    assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(call.args[call.args.indexOf("--permission-prompts") + 1], "none");
    assert.equal(call.args[call.args.indexOf("--output-format") + 1], "json");
    assert.equal(call.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, "1");

    const prompt = JSON.parse(call.stdin);
    assert.equal(prompt.contract, "ai-verse-multiple-bots/claude-code-runtime-envelope-v1");
    assert.equal(prompt.execution_identity.principal_id, "bot_claude-code");
    assert.equal(prompt.authority.workspace_path, fixture.workspace);
    assert.deepEqual(prompt.authority.process_capabilities, [
      "claude-code:web-search",
      "claude-code:workspace-read",
      "claude-code:workspace-write"
    ]);
    assert.equal(prompt.workspace_projection.data.current_state, "PROCESS_CURRENT_CONTEXT");

    assert.equal(result.artifactKind, "claude_code_task_result");
    assert.equal(result.output.remote_session_id, "claude-session-1");
    assert.equal(result.usage?.input_tokens, 17);
    assert.equal(result.usage?.output_tokens, 9);
    assert.equal(result.usage?.cost, 0.012);
    assert.equal(result.usage?.actions, 3);

    const receipt = result.receipts?.[0] as JsonObject;
    assert.equal(receipt.enabled_builtin_tool_count, 6);
    assert.equal(receipt.customization_policy, "safe_mode");
    assert.equal(receipt.machine_boundary, "restricted");
    assert.equal(receipt.mcp_policy, "safe_mode_plus_explicit_mcp_deny");
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(fixture.workspace), false);
    assert.equal(serialized.includes("PROCESS_CURRENT_CONTEXT"), false);
    assert.equal(serialized.includes("Read"), false);
    assert.equal(serialized.includes("WebSearch"), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Claude Code zero-capability mode passes an explicit empty --tools list and no auto-approve list", async () => {
  const fixture = workspaceFixture();
  try {
    const fake = new FakeProcessTransport();
    const adapter = new ClaudeCodePrintRuntimeAdapter({ transport: fake });
    await adapter.execute(runtimeContext("claude-code", fixture.workspace, []));
    const args = fake.calls[0]!.args;
    const toolsIndex = args.indexOf("--tools");
    assert.equal(args[toolsIndex + 1], "");
    assert.equal(args.includes("--allowedTools"), false);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Claude Code exact capability mapping is stable and provider-scoped", () => {
  const fixture = workspaceFixture();
  try {
    const context = runtimeContext(
      "claude-code",
      fixture.workspace,
      [
        "claude-code:workspace-write",
        "claude-code:shell",
        "claude-code:web-search",
        "claude-code:web-fetch"
      ]
    );
    const tools = claudeCodeBuiltInTools(
      // capability parser is exercised by adapter tests; this directly proves the tool mapping.
      new Set<any>(["workspace-read", "workspace-write", "shell", "web-search", "web-fetch"])
    );
    assert.deepEqual(tools, ["Bash", "Edit", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "Write"]);
    assert.equal(context.capabilityLease.payload.tools.length, 4);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Claude Code rejects broad, unscoped, unknown, and remote/session grants before subprocess work", async () => {
  const fixture = workspaceFixture();
  try {
    const cases = [
      { tools: ["*"], runtime: {}, code: "CLAUDE_CODE_BROAD_CAPABILITY_FORBIDDEN" },
      { tools: ["claude-code:web-*"], runtime: {}, code: "CLAUDE_CODE_BROAD_CAPABILITY_FORBIDDEN" },
      { tools: ["Read"], runtime: {}, code: "CLAUDE_CODE_UNSCOPED_CAPABILITY_FORBIDDEN" },
      { tools: ["claude-code:mcp"], runtime: {}, code: "CLAUDE_CODE_UNSUPPORTED_CAPABILITY" },
      { tools: [], runtime: { cloud: true }, code: "CLAUDE_CODE_REMOTE_AUTH_OUT_OF_SCOPE" },
      { tools: [], runtime: { token: "secret" }, code: "CLAUDE_CODE_REMOTE_AUTH_OUT_OF_SCOPE" },
      { tools: [], runtime: { session_id: "old-session" }, code: "CLAUDE_CODE_REMOTE_AUTH_OUT_OF_SCOPE" }
    ];
    for (const item of cases) {
      const fake = new FakeProcessTransport();
      const adapter = new ClaudeCodePrintRuntimeAdapter({ transport: fake });
      await assert.rejects(
        () => adapter.execute(runtimeContext("claude-code", fixture.workspace, item.tools, item.runtime)),
        (error: unknown) => error instanceof ClaudeCodeRuntimeError && error.code === item.code
      );
      assert.equal(fake.calls.length, 0);
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Claude Code JSON parser maps usage and cost while failure/malformed results fail closed", () => {
  const parsed = parseClaudeCodeJson(claudeSuccess({
    permission_denials: [{ tool: "Bash" }]
  }));
  assert.equal(parsed.envelope.result, "Claude Code completed the delegated task.");
  assert.equal(parsed.usage.input_tokens, 17);
  assert.equal(parsed.usage.output_tokens, 9);
  assert.equal(parsed.usage.cost, 0.012);
  assert.equal(parsed.permissionDenialCount, 1);

  assert.throws(
    () => parseClaudeCodeJson(JSON.stringify({
      subtype: "error_max_turns",
      is_error: true,
      result: "Stopped",
      session_id: "s"
    })),
    (error: unknown) => error instanceof ClaudeCodeRuntimeError && error.code === "CLAUDE_CODE_REMOTE_FAILED"
  );
  assert.throws(
    () => parseClaudeCodeJson("{bad"),
    (error: unknown) => error instanceof ClaudeCodeRuntimeError && error.code === "CLAUDE_CODE_INVALID_RESPONSE"
  );
});

test("Claude Code preserves temporary Worker identity and Team Run lineage", async () => {
  const fixture = workspaceFixture();
  try {
    const fake = new FakeProcessTransport();
    const adapter = new ClaudeCodePrintRuntimeAdapter({ transport: fake });
    const result = await adapter.execute(
      runtimeContext("claude-code", fixture.workspace, [], {}, "worker")
    );
    const prompt = JSON.parse(fake.calls[0]!.stdin);
    assert.equal(prompt.execution_identity.principal_id, "worker_claude-code");
    assert.equal(prompt.execution_identity.principal_kind, "worker");
    assert.equal(prompt.task.run_id, "run_process");
    assert.equal(result.output.execution_principal_kind, "worker");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Claude Code cancellation aborts the exact active print process", async () => {
  const fixture = workspaceFixture();
  try {
    const fake = new FakeProcessTransport();
    fake.holdClaude = true;
    const adapter = new ClaudeCodePrintRuntimeAdapter({ transport: fake });
    const running = adapter.execute(runtimeContext("claude-code", fixture.workspace, []));
    while (fake.calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.cancel("task_claude-code");
    await assert.rejects(() => running, /canceled/i);
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
    this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler));
  }

  emit(name: string, ...args: any[]): void {
    for (const handler of [...(this.handlers.get(name) ?? [])]) handler(...args);
  }
}

test("shared local CLI transport always uses shell:false, stdin piping, and explicit lifecycle results", async () => {
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
          stdout.emit("data", "OUTPUT");
          lifecycle.emit("exit", 0, null);
        });
      }
    },
    once: lifecycle.once.bind(lifecycle),
    kill(signal: string) {
      lifecycle.emit("exit", null, signal);
    }
  };
  const transport = new SpawnLocalCliProcessTransport(
    ((file: string, args: string[], options: any) => {
      spawnCall = { file, args, options };
      return child;
    }) as any
  );
  const controller = new AbortController();
  const result = await transport.run({
    command: "tool",
    args: ["--json"],
    cwd: "/tmp",
    env: { PATH: "/usr/bin" },
    stdin: "PROMPT",
    signal: controller.signal,
    timeoutMs: 1000
  });
  assert.equal(spawnCall.file, "tool");
  assert.deepEqual(spawnCall.args, ["--json"]);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(stdin, "PROMPT");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "OUTPUT");
});

test("shared local CLI transport converts an outer process deadline into an explicit timeout error", async () => {
  const stdout = new MiniStream();
  const stderr = new MiniStream();
  const lifecycle = new MiniStream();
  const kills: string[] = [];
  const child: any = {
    stdout,
    stderr,
    stdin: { end() {} },
    once: lifecycle.once.bind(lifecycle),
    kill(signal: string) {
      kills.push(signal);
      if (signal === "SIGTERM") queueMicrotask(() => lifecycle.emit("exit", null, signal));
    }
  };
  const transport = new SpawnLocalCliProcessTransport((() => child) as any);
  const controller = new AbortController();
  await assert.rejects(
    () => transport.run({
      command: "tool",
      args: [],
      cwd: "/tmp",
      env: {},
      stdin: "",
      signal: controller.signal,
      timeoutMs: 5
    }),
    (error: unknown) => error instanceof LocalCliProcessError && error.code === "LOCAL_CLI_TIMEOUT"
  );
  assert.deepEqual(kills, ["SIGTERM"]);
});

test("Gateway registers Codex and Claude Code as ordinary host-neutral runtimes", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  await service.listen();
  await service.supervisor.waitForIdle();
  try {
    assert.equal(service.runtimes.has("codex"), true);
    assert.equal(service.runtimes.get("codex").id, "codex");
    assert.equal(service.runtimes.has("claude-code"), true);
    assert.equal(service.runtimes.get("claude-code").id, "claude-code");
    assert.equal(service.runtimes.has("a2a"), true);
    assert.equal(service.runtimes.has("hermes"), true);
    assert.equal(service.runtimes.has("openclaw"), true);
  } finally {
    await service.close();
  }
});
