import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  type LocalCliProcessResult,
  type LocalCliProcessTransport,
  LocalCliProcessError,
  SpawnLocalCliProcessTransport
} from "./local-cli-process.js";
import type { RuntimeAdapter, RuntimeExecutionContext, RuntimeExecutionResult } from "./runtime.js";
import type { JsonObject } from "./types.js";

export const CODEX_RUNTIME_ADAPTER_ID = "codex";
export const CODEX_RUNTIME_ENVELOPE = "ai-verse-multiple-bots/codex-runtime-envelope-v1";
export const CODEX_MAX_PROMPT_BYTES = 512 * 1024;
export const CODEX_MAX_JSONL_BYTES = 8 * 1024 * 1024;

export type CodexProcessCapability =
  | "workspace-read"
  | "workspace-write"
  | "web-search";

export class CodexRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexRuntimeError";
  }
}

export interface CodexRuntimeOptions {
  env?: Record<string, string | undefined>;
  transport?: LocalCliProcessTransport;
}

interface ActiveCodexTask {
  controller: AbortController;
}

interface ParsedCodexResult {
  threadId: string;
  finalText: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cost: number;
    actions: number;
  };
  observed: {
    commandExecutions: number;
    fileChanges: number;
    webSearches: number;
    mcpCalls: number;
    collabCalls: number;
  };
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedJson(value: unknown, maxBytes: number, label: string): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new CodexRuntimeError("CODEX_INVALID_PAYLOAD", `${label} is not JSON serializable`);
  }
  if (byteLength(text) > maxBytes) {
    throw new CodexRuntimeError("CODEX_PAYLOAD_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
  }
  return text;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalString(value: unknown, key: string, max = 4096): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new CodexRuntimeError("CODEX_INVALID_CONFIG", `runtime.${key} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > max || /[\0\r\n]/.test(result)) {
    throw new CodexRuntimeError("CODEX_INVALID_CONFIG", `runtime.${key} is invalid or too long`);
  }
  return result;
}

function timeoutSeconds(value: unknown): number {
  if (value === undefined || value === null) return 900;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3600) {
    throw new CodexRuntimeError(
      "CODEX_INVALID_CONFIG",
      "runtime.timeout_seconds must be an integer between 1 and 3600"
    );
  }
  return value;
}

function assertLocalOnly(runtime: JsonObject): void {
  for (const key of [
    "endpoint",
    "url",
    "host",
    "port",
    "api_key",
    "token",
    "authorization",
    "headers",
    "ssh",
    "websocket_url",
    "remote",
    "resume",
    "session_id",
    "thread_id"
  ]) {
    if (runtime[key] !== undefined && runtime[key] !== null) {
      throw new CodexRuntimeError(
        "CODEX_REMOTE_AUTH_OUT_OF_SCOPE",
        `runtime.${key} is not supported by Phase 4.4; remote identity/authentication and reconnect semantics belong to later Phase 4 slices`
      );
    }
  }
}

function assertWorkspacePath(value: string): string {
  const candidate = resolve(value);
  let stat: any;
  try {
    stat = lstatSync(candidate);
  } catch {
    throw new CodexRuntimeError("CODEX_WORKSPACE_NOT_FOUND", `Codex workspace does not exist: ${candidate}`);
  }
  if (stat.isSymbolicLink?.()) {
    throw new CodexRuntimeError("CODEX_WORKSPACE_SYMLINK_FORBIDDEN", "Codex workspace path must not be a symlink");
  }
  if (!stat.isDirectory?.()) {
    throw new CodexRuntimeError("CODEX_WORKSPACE_NOT_DIRECTORY", "Codex workspace must be a directory");
  }
  return realpathSync(candidate);
}

function hasBroadSyntax(value: string): boolean {
  return value.startsWith("group:") || /[*?\[\]]/.test(value);
}

export function codexProcessCapabilities(context: RuntimeExecutionContext): Set<CodexProcessCapability> {
  const capabilities = new Set<CodexProcessCapability>();
  for (const raw of stringArray(context.capabilityLease.payload.tools)) {
    const value = raw.trim();
    if (!value) {
      throw new CodexRuntimeError("CODEX_INVALID_CAPABILITY", "Codex capability lease contains an empty entry");
    }
    if (hasBroadSyntax(value)) {
      throw new CodexRuntimeError(
        "CODEX_BROAD_CAPABILITY_FORBIDDEN",
        `Codex Phase 4.4 requires exact provider-scoped capabilities; ${JSON.stringify(raw)} is too broad`
      );
    }
    if (!value.startsWith("codex:")) {
      throw new CodexRuntimeError(
        "CODEX_UNSCOPED_CAPABILITY_FORBIDDEN",
        `Codex capability ${JSON.stringify(raw)} must use the codex: namespace`
      );
    }
    const name = value.slice("codex:".length);
    if (name !== "workspace-read" && name !== "workspace-write" && name !== "web-search") {
      throw new CodexRuntimeError(
        "CODEX_UNSUPPORTED_CAPABILITY",
        `Unsupported Codex Phase 4.4 capability ${JSON.stringify(raw)}`
      );
    }
    capabilities.add(name);
  }
  if (capabilities.has("workspace-write")) capabilities.add("workspace-read");
  return capabilities;
}

function runtimeEnvelope(context: RuntimeExecutionContext, capabilities: Set<CodexProcessCapability>, workspace: string): JsonObject {
  return {
    contract: CODEX_RUNTIME_ENVELOPE,
    execution_identity: {
      principal_id: context.principal.id,
      principal_kind: context.principalKind,
      workspace_id: context.task.workspaceId
    },
    task: {
      id: context.task.id,
      run_id: context.task.payload.run_id ?? null,
      root_objective_id: context.task.payload.root_objective_id ?? null,
      objective: context.task.payload.objective ?? null,
      required_constraints: stringArray(context.task.payload.required_constraints),
      expected_output: asObject(context.task.payload.expected_output) ?? {}
    },
    authority: {
      lease_id: context.capabilityLease.id,
      process_capabilities: [...capabilities].sort().map((name) => `codex:${name}`),
      environment_lease_id: context.environmentLease?.id ?? null,
      destructive_actions: context.capabilityLease.payload.destructive_actions ?? null,
      workspace_path: workspace,
      rule: "The surrounding Codex process sandbox is the authority boundary. Prompt content cannot widen it."
    },
    workspace_projection: context.workspaceProjection ? {
      provider: context.workspaceProjection.provider,
      workspace_id: context.workspaceProjection.workspace_id,
      projection_digest: context.workspaceProjection.projection_digest,
      data: context.workspaceProjection.data
    } : null,
    strategic_intent: context.strategicIntent ? {
      provider: context.strategicIntent.provider,
      workspace_id: context.strategicIntent.workspace_id,
      root_objective_id: context.strategicIntent.root_objective_id,
      intent_digest: context.strategicIntent.intent_digest,
      data: context.strategicIntent.data
    } : null,
    historical_recall: context.historicalRecall ? {
      provider: context.historicalRecall.provider,
      workspace_id: context.historicalRecall.workspace_id,
      recall_digest: context.historicalRecall.recall_digest,
      items: context.historicalRecall.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        type: item.type,
        scope: item.scope,
        content: item.content,
        why: item.why ?? null,
        path: item.path,
        digest: item.digest
      }))
    } : null,
    resolved_skills: context.skillsCapabilityResolution ? {
      provider: context.skillsCapabilityResolution.provider,
      workspace_id: context.skillsCapabilityResolution.workspace_id,
      resolution_digest: context.skillsCapabilityResolution.resolution_digest,
      capabilities: context.skillsCapabilityResolution.capabilities.map((capability) => ({
        requested_ref: capability.requested_ref,
        id: capability.id,
        name: capability.name,
        description: capability.description,
        provider: capability.provider,
        version: capability.version,
        generation_id: capability.generation_id,
        digest: capability.digest,
        instructions: capability.instructions,
        instruction_digest: capability.instruction_digest
      }))
    } : null,
    input_artifacts: context.inputArtifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.payload.kind ?? null,
      version: artifact.payload.version ?? null,
      inline_content: artifact.payload.inline_content ?? null,
      content_ref: artifact.payload.content_ref ?? null,
      provenance: artifact.payload.provenance ?? null
    }))
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function configOverride(args: string[], value: string): void {
  args.push("-c", value);
}

function baseCodexOverrides(args: string[], workspace: string, capabilities: Set<CodexProcessCapability>): void {
  const access = capabilities.has("workspace-write")
    ? "write"
    : capabilities.has("workspace-read")
      ? "read"
      : null;

  configOverride(args, 'approval_policy="never"');
  configOverride(args, 'default_permissions="ai-verse-runtime"');
  const filesystemEntries = [ '":minimal"="read"' ];
  if (access) filesystemEntries.push(`${tomlString(workspace)}=${tomlString(access)}`);
  configOverride(args, `permissions.ai-verse-runtime.filesystem={${filesystemEntries.join(",")}}`);
  configOverride(args, "permissions.ai-verse-runtime.network.enabled=false");

  const shellEnabled = capabilities.has("workspace-read");
  const webEnabled = capabilities.has("web-search");
  const booleans: Record<string, boolean> = {
    "features.apps": false,
    "features.code_mode": false,
    "features.code_mode_only": false,
    "features.context_management": false,
    "features.current_time_reminder": false,
    "features.deferred_executor": false,
    "features.enable_fanout": false,
    "features.goals": false,
    "features.hooks": false,
    "features.image_generation": false,
    "features.memories": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "features.plugins": false,
    "features.request_permissions_tool": false,
    "features.shell_snapshot": false,
    "features.shell_tool": shellEnabled,
    "features.standalone_web_search": webEnabled,
    "features.token_budget": false,
    "features.tool_suggest": false,
    "features.unified_exec": shellEnabled,
    "features.view_image": false,
    "orchestrator.skills.enabled": false,
    "skills.include_instructions": false,
    "tools.experimental_request_user_input.enabled": false,
    "tools.update_plan.enabled": false,
    "orchestrator.mcp.enabled": false
  };
  for (const [key, enabled] of Object.entries(booleans)) {
    configOverride(args, `${key}=${enabled ? "true" : "false"}`);
  }
  configOverride(args, `web_search=${tomlString(webEnabled ? "live" : "disabled")}`);
}

function parseMcpInventory(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CodexRuntimeError("CODEX_MCP_INVENTORY_INVALID", "codex mcp list --json returned invalid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new CodexRuntimeError("CODEX_MCP_INVENTORY_INVALID", "codex mcp list --json must return an array");
  }
  const names: string[] = [];
  for (const item of parsed) {
    const object = asObject(item);
    if (!object || typeof object.name !== "string" || !object.name.trim()) {
      throw new CodexRuntimeError("CODEX_MCP_INVENTORY_INVALID", "Codex MCP inventory contains an invalid server entry");
    }
    const name = object.name.trim();
    if (name.length > 256 || /[\0\r\n]/.test(name)) {
      throw new CodexRuntimeError("CODEX_MCP_INVENTORY_INVALID", "Codex MCP inventory contains an invalid server name");
    }
    names.push(name);
  }
  return [...new Set(names)].sort();
}

function disableDiscoveredMcp(args: string[], names: string[]): void {
  for (const name of names) {
    configOverride(args, `mcp_servers.${tomlString(name)}.enabled=false`);
  }
}

function nonNegative(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CodexRuntimeError("CODEX_INVALID_USAGE", `${label} must be a non-negative number`);
  }
  return value;
}

export function parseCodexJsonl(stdout: string, capabilities: Set<CodexProcessCapability>): ParsedCodexResult {
  if (byteLength(stdout) > CODEX_MAX_JSONL_BYTES) {
    throw new CodexRuntimeError("CODEX_OUTPUT_TOO_LARGE", "Codex JSONL exceeds the supported limit");
  }

  let threadId = "";
  let finalText = "";
  let turnCompleted = false;
  let turnFailed = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let actions = 0;
  const observed = {
    commandExecutions: 0,
    fileChanges: 0,
    webSearches: 0,
    mcpCalls: 0,
    collabCalls: 0
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new CodexRuntimeError("CODEX_INVALID_JSONL", "codex exec --json emitted an invalid JSONL frame");
    }
    const object = asObject(event);
    if (!object || typeof object.type !== "string") {
      throw new CodexRuntimeError("CODEX_INVALID_JSONL", "Codex JSONL event is missing type");
    }

    if (object.type === "thread.started") {
      if (typeof object.thread_id !== "string" || !object.thread_id) {
        throw new CodexRuntimeError("CODEX_INVALID_JSONL", "Codex thread.started is missing thread_id");
      }
      threadId = object.thread_id;
      continue;
    }

    if (object.type === "turn.completed") {
      turnCompleted = true;
      const usage = asObject(object.usage) ?? {};
      inputTokens += nonNegative(usage.input_tokens, "usage.input_tokens");
      inputTokens += nonNegative(usage.cached_input_tokens, "usage.cached_input_tokens");
      inputTokens += nonNegative(usage.cache_write_input_tokens, "usage.cache_write_input_tokens");
      outputTokens += nonNegative(usage.output_tokens, "usage.output_tokens");
      outputTokens += nonNegative(usage.reasoning_output_tokens, "usage.reasoning_output_tokens");
      continue;
    }

    if (object.type === "turn.failed" || object.type === "error") {
      turnFailed = true;
      continue;
    }

    if (object.type !== "item.started" && object.type !== "item.updated" && object.type !== "item.completed") {
      continue;
    }

    const item = asObject(object.item);
    if (!item || typeof item.type !== "string") continue;
    if (object.type !== "item.completed") continue;

    if (item.type === "agent_message") {
      if (typeof item.text === "string") finalText = item.text;
      continue;
    }

    if (item.type === "reasoning" || item.type === "todo_list" || item.type === "error") {
      continue;
    }

    actions += 1;
    if (item.type === "command_execution") observed.commandExecutions += 1;
    else if (item.type === "file_change") observed.fileChanges += 1;
    else if (item.type === "web_search") observed.webSearches += 1;
    else if (item.type === "mcp_tool_call") observed.mcpCalls += 1;
    else if (item.type === "collab_tool_call") observed.collabCalls += 1;
  }

  if (!threadId) {
    throw new CodexRuntimeError("CODEX_INVALID_JSONL", "Codex did not emit thread.started");
  }
  if (!turnCompleted || turnFailed) {
    throw new CodexRuntimeError("CODEX_REMOTE_FAILED", "Codex did not complete the delegated turn successfully");
  }
  if (observed.mcpCalls > 0) {
    throw new CodexRuntimeError("CODEX_MCP_POLICY_VIOLATION", "Codex reported an MCP tool call during a Phase 4.4 process run");
  }
  if (observed.collabCalls > 0) {
    throw new CodexRuntimeError("CODEX_COLLAB_POLICY_VIOLATION", "Codex reported a collaboration tool call during a Phase 4.4 process run");
  }
  if ((observed.commandExecutions > 0 || observed.fileChanges > 0) && !capabilities.has("workspace-read")) {
    throw new CodexRuntimeError("CODEX_WORKSPACE_POLICY_VIOLATION", "Codex reported workspace execution without a workspace capability");
  }
  if (observed.fileChanges > 0 && !capabilities.has("workspace-write")) {
    throw new CodexRuntimeError("CODEX_WRITE_POLICY_VIOLATION", "Codex reported file changes without codex:workspace-write");
  }
  if (observed.webSearches > 0 && !capabilities.has("web-search")) {
    throw new CodexRuntimeError("CODEX_WEB_POLICY_VIOLATION", "Codex reported web search without codex:web-search");
  }

  return {
    threadId,
    finalText: finalText.trim(),
    usage: {
      input_tokens: Math.floor(inputTokens),
      output_tokens: Math.floor(outputTokens),
      cost: 0,
      actions: Math.max(1, actions + 1)
    },
    observed
  };
}

function processFailure(prefix: string, result: LocalCliProcessResult): CodexRuntimeError {
  const tail = result.stderr.replace(/\s+/g, " ").trim().slice(-600);
  return new CodexRuntimeError(
    `${prefix}_FAILED`,
    tail || `Codex process exited with code ${String(result.exitCode)}${result.signal ? ` signal ${result.signal}` : ""}`
  );
}

export class CodexExecRuntimeAdapter implements RuntimeAdapter {
  readonly id = CODEX_RUNTIME_ADAPTER_ID;
  private readonly env: Record<string, string | undefined>;
  private readonly transport: LocalCliProcessTransport;
  private readonly active = new Map<string, ActiveCodexTask>();

  constructor(options: CodexRuntimeOptions = {}) {
    this.env = options.env ?? process.env as Record<string, string | undefined>;
    this.transport = options.transport ?? new SpawnLocalCliProcessTransport();
  }

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    assertLocalOnly(context.runtime);
    const capabilities = codexProcessCapabilities(context);
    const command = optionalString(context.runtime.command, "command", 1024) ?? "codex";
    const timeout = timeoutSeconds(context.runtime.timeout_seconds);
    const model = optionalString(context.runtime.model, "model", 256);
    const workspace = assertWorkspacePath(optionalString(context.runtime.cwd, "cwd") ?? process.cwd());

    const controller = new AbortController();
    this.active.set(context.task.id, { controller });
    const abortFromParent = () => { void this.cancel(context.task.id); };
    if (context.signal.aborted) abortFromParent();
    else context.signal.addEventListener("abort", abortFromParent, { once: true });

    const harnessDir = mkdtempSync(join(tmpdir(), "ai-verse-codex-"));
    try {
      const inventory = await this.transport.run({
        command,
        args: ["mcp", "list", "--json"],
        cwd: harnessDir,
        env: this.env,
        stdin: "",
        signal: controller.signal,
        timeoutMs: Math.min(30_000, timeout * 1000),
        maxStdoutBytes: 1024 * 1024
      });
      if (inventory.exitCode !== 0 || inventory.signal !== null) throw processFailure("CODEX_MCP_INVENTORY", inventory);
      const mcpServers = parseMcpInventory(inventory.stdout.trim());

      const args = [
        "exec",
        "--strict-config",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--json",
        "-C",
        harnessDir
      ];
      if (model) args.push("--model", model);
      baseCodexOverrides(args, workspace, capabilities);
      disableDiscoveredMcp(args, mcpServers);
      args.push("-");

      const prompt = boundedJson(runtimeEnvelope(context, capabilities, workspace), CODEX_MAX_PROMPT_BYTES, "Codex runtime envelope");
      const result = await this.transport.run({
        command,
        args,
        cwd: harnessDir,
        env: this.env,
        stdin: prompt,
        signal: controller.signal,
        timeoutMs: (timeout + 30) * 1000,
        maxStdoutBytes: CODEX_MAX_JSONL_BYTES
      });
      if (result.exitCode !== 0 || result.signal !== null) throw processFailure("CODEX_EXEC", result);
      const parsed = parseCodexJsonl(result.stdout, capabilities);

      return {
        summary: parsed.finalText
          ? (parsed.finalText.length > 240 ? `${parsed.finalText.slice(0, 237)}...` : parsed.finalText)
          : "Codex completed the delegated Task.",
        artifactKind: "codex_task_result",
        output: {
          text: parsed.finalText,
          remote_thread_id: parsed.threadId,
          executed_by: context.principal.id,
          execution_principal_kind: context.principalKind
        },
        usage: parsed.usage,
        receipts: [{
          kind: "codex_process_execution",
          adapter: this.id,
          transport: "codex_exec_jsonl",
          remote_thread_id: parsed.threadId,
          principal_kind: context.principalKind,
          local_task_id: context.task.id,
          process_capability_count: capabilities.size,
          observed_command_execution_count: parsed.observed.commandExecutions,
          observed_file_change_count: parsed.observed.fileChanges,
          observed_web_search_count: parsed.observed.webSearches,
          mcp_preflight_server_count: mcpServers.length,
          mcp_policy: "inventory_then_explicit_disable",
          project_config_policy: "temporary_harness_cwd",
          user_config_policy: "ignored_auth_preserved",
          persistence: "ephemeral",
          remote_authentication: "not_supported_phase_4_4"
        }]
      };
    } catch (error) {
      if (error instanceof LocalCliProcessError) {
        throw new CodexRuntimeError(error.code.replace(/^LOCAL_CLI_/, "CODEX_PROCESS_"), error.message);
      }
      throw error;
    } finally {
      try { rmSync(harnessDir, { recursive: true, force: true }); } catch {}
      this.active.delete(context.task.id);
      context.signal.removeEventListener("abort", abortFromParent);
      if (!controller.signal.aborted) controller.abort(new Error("Codex execution finished"));
    }
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) return;
    if (!active.controller.signal.aborted) {
      active.controller.abort(new Error(`Runtime Task ${taskId} canceled`));
    }
  }
}
