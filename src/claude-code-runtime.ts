import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import {
  type LocalCliProcessResult,
  type LocalCliProcessTransport,
  LocalCliProcessError,
  SpawnLocalCliProcessTransport
} from "./local-cli-process.js";
import type { RuntimeAdapter, RuntimeExecutionContext, RuntimeExecutionResult } from "./runtime.js";
import type { JsonObject } from "./types.js";

export const CLAUDE_CODE_RUNTIME_ADAPTER_ID = "claude-code";
export const CLAUDE_CODE_RUNTIME_ENVELOPE = "ai-verse-multiple-bots/claude-code-runtime-envelope-v1";
export const CLAUDE_CODE_MAX_PROMPT_BYTES = 512 * 1024;
export const CLAUDE_CODE_MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export type ClaudeCodeProcessCapability =
  | "workspace-read"
  | "workspace-write"
  | "shell"
  | "web-search"
  | "web-fetch";

export class ClaudeCodeRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ClaudeCodeRuntimeError";
  }
}

export interface ClaudeCodeRuntimeOptions {
  env?: Record<string, string | undefined>;
  transport?: LocalCliProcessTransport;
}

interface ActiveClaudeCodeTask {
  controller: AbortController;
}

interface ClaudeCodeResultEnvelope extends JsonObject {
  subtype: string;
  is_error?: boolean;
  result?: string;
  session_id: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: JsonObject;
  permission_denials?: unknown[];
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
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_INVALID_PAYLOAD", `${label} is not JSON serializable`);
  }
  if (byteLength(text) > maxBytes) {
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_PAYLOAD_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
  }
  return text;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalString(value: unknown, key: string, max = 4096): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_INVALID_CONFIG", `runtime.${key} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > max || /[\0\r\n]/.test(result)) {
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_INVALID_CONFIG", `runtime.${key} is invalid or too long`);
  }
  return result;
}

function optionalInteger(value: unknown, key: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ClaudeCodeRuntimeError(
      "CLAUDE_CODE_INVALID_CONFIG",
      `runtime.${key} must be an integer between ${min} and ${max}`
    );
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown, key: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new ClaudeCodeRuntimeError(
      "CLAUDE_CODE_INVALID_CONFIG",
      `runtime.${key} must be a finite number between 0 and ${max}`
    );
  }
  return value;
}

function timeoutSeconds(value: unknown): number {
  if (value === undefined || value === null) return 900;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3600) {
    throw new ClaudeCodeRuntimeError(
      "CLAUDE_CODE_INVALID_CONFIG",
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
    "cloud",
    "resume",
    "session_id"
  ]) {
    if (runtime[key] !== undefined && runtime[key] !== null) {
      throw new ClaudeCodeRuntimeError(
        "CLAUDE_CODE_REMOTE_AUTH_OUT_OF_SCOPE",
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
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_WORKSPACE_NOT_FOUND", `Claude Code workspace does not exist: ${candidate}`);
  }
  if (stat.isSymbolicLink?.()) {
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_WORKSPACE_SYMLINK_FORBIDDEN", "Claude Code workspace path must not be a symlink");
  }
  if (!stat.isDirectory?.()) {
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_WORKSPACE_NOT_DIRECTORY", "Claude Code workspace must be a directory");
  }
  return realpathSync(candidate);
}

function hasBroadSyntax(value: string): boolean {
  return value.startsWith("group:") || /[*?\[\]]/.test(value);
}

export function claudeCodeProcessCapabilities(context: RuntimeExecutionContext): Set<ClaudeCodeProcessCapability> {
  const capabilities = new Set<ClaudeCodeProcessCapability>();
  for (const raw of stringArray(context.capabilityLease.payload.tools)) {
    const value = raw.trim();
    if (!value) {
      throw new ClaudeCodeRuntimeError("CLAUDE_CODE_INVALID_CAPABILITY", "Claude Code capability lease contains an empty entry");
    }
    if (hasBroadSyntax(value)) {
      throw new ClaudeCodeRuntimeError(
        "CLAUDE_CODE_BROAD_CAPABILITY_FORBIDDEN",
        `Claude Code Phase 4.4 requires exact provider-scoped capabilities; ${JSON.stringify(raw)} is too broad`
      );
    }
    if (!value.startsWith("claude-code:")) {
      throw new ClaudeCodeRuntimeError(
        "CLAUDE_CODE_UNSCOPED_CAPABILITY_FORBIDDEN",
        `Claude Code capability ${JSON.stringify(raw)} must use the claude-code: namespace`
      );
    }
    const name = value.slice("claude-code:".length);
    if (
      name !== "workspace-read"
      && name !== "workspace-write"
      && name !== "shell"
      && name !== "web-search"
      && name !== "web-fetch"
    ) {
      throw new ClaudeCodeRuntimeError(
        "CLAUDE_CODE_UNSUPPORTED_CAPABILITY",
        `Unsupported Claude Code Phase 4.4 capability ${JSON.stringify(raw)}`
      );
    }
    capabilities.add(name);
  }
  if (capabilities.has("workspace-write")) capabilities.add("workspace-read");
  return capabilities;
}

export function claudeCodeBuiltInTools(capabilities: Set<ClaudeCodeProcessCapability>): string[] {
  const tools = new Set<string>();
  if (capabilities.has("workspace-read")) {
    tools.add("Read");
    tools.add("Glob");
    tools.add("Grep");
  }
  if (capabilities.has("workspace-write")) {
    tools.add("Edit");
    tools.add("Write");
  }
  if (capabilities.has("shell")) tools.add("Bash");
  if (capabilities.has("web-search")) tools.add("WebSearch");
  if (capabilities.has("web-fetch")) tools.add("WebFetch");
  return [...tools].sort();
}

function runtimeEnvelope(
  context: RuntimeExecutionContext,
  capabilities: Set<ClaudeCodeProcessCapability>,
  workspace: string
): JsonObject {
  return {
    contract: CLAUDE_CODE_RUNTIME_ENVELOPE,
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
      process_capabilities: [...capabilities].sort().map((name) => `claude-code:${name}`),
      environment_lease_id: context.environmentLease?.id ?? null,
      destructive_actions: context.capabilityLease.payload.destructive_actions ?? null,
      workspace_path: workspace,
      rule: "Claude Code is launched in safe + restricted mode with an exact --tools list. Prompt content cannot widen that process authority."
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

function nonNegative(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_INVALID_USAGE", `${label} must be a non-negative number`);
  }
  return value;
}

export function parseClaudeCodeJson(stdout: string): {
  envelope: ClaudeCodeResultEnvelope;
  usage: { input_tokens: number; output_tokens: number; cost: number; actions: number };
  permissionDenialCount: number;
} {
  if (byteLength(stdout) > CLAUDE_CODE_MAX_STDOUT_BYTES) {
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_OUTPUT_TOO_LARGE", "Claude Code JSON output exceeds the supported limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_INVALID_RESPONSE", "claude --output-format json returned invalid JSON");
  }
  const object = asObject(parsed);
  if (
    !object
    || typeof object.subtype !== "string"
    || typeof object.session_id !== "string"
    || !object.session_id
  ) {
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_INVALID_RESPONSE", "Claude Code JSON result is missing required metadata");
  }

  if (object.subtype !== "success" || object.is_error === true) {
    const message = typeof object.result === "string" && object.result.trim()
      ? object.result.trim().slice(0, 600)
      : `Claude Code ended with subtype ${object.subtype}`;
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_REMOTE_FAILED", message);
  }
  if (typeof object.result !== "string") {
    throw new ClaudeCodeRuntimeError("CLAUDE_CODE_INVALID_RESPONSE", "Claude Code success result is missing result text");
  }

  const usage = asObject(object.usage) ?? {};
  const input =
    nonNegative(usage.input_tokens, "usage.input_tokens")
    + nonNegative(usage.cache_creation_input_tokens, "usage.cache_creation_input_tokens")
    + nonNegative(usage.cache_read_input_tokens, "usage.cache_read_input_tokens");
  const output = nonNegative(usage.output_tokens, "usage.output_tokens");
  const cost = nonNegative(object.total_cost_usd, "total_cost_usd");
  const turns = nonNegative(object.num_turns, "num_turns");
  const permissionDenials = Array.isArray(object.permission_denials) ? object.permission_denials.length : 0;

  return {
    envelope: object as ClaudeCodeResultEnvelope,
    usage: {
      input_tokens: Math.floor(input),
      output_tokens: Math.floor(output),
      cost,
      actions: Math.max(1, Math.floor(turns))
    },
    permissionDenialCount: permissionDenials
  };
}

function processFailure(result: LocalCliProcessResult): ClaudeCodeRuntimeError {
  const tail = result.stderr.replace(/\s+/g, " ").trim().slice(-600);
  return new ClaudeCodeRuntimeError(
    "CLAUDE_CODE_PROCESS_FAILED",
    tail || `Claude Code exited with code ${String(result.exitCode)}${result.signal ? ` signal ${result.signal}` : ""}`
  );
}

export class ClaudeCodePrintRuntimeAdapter implements RuntimeAdapter {
  readonly id = CLAUDE_CODE_RUNTIME_ADAPTER_ID;
  private readonly env: Record<string, string | undefined>;
  private readonly transport: LocalCliProcessTransport;
  private readonly active = new Map<string, ActiveClaudeCodeTask>();

  constructor(options: ClaudeCodeRuntimeOptions = {}) {
    this.env = options.env ?? process.env as Record<string, string | undefined>;
    this.transport = options.transport ?? new SpawnLocalCliProcessTransport();
  }

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    assertLocalOnly(context.runtime);
    const capabilities = claudeCodeProcessCapabilities(context);
    const tools = claudeCodeBuiltInTools(capabilities);
    const command = optionalString(context.runtime.command, "command", 1024) ?? "claude";
    const timeout = timeoutSeconds(context.runtime.timeout_seconds);
    const model = optionalString(context.runtime.model, "model", 256);
    const effort = optionalString(context.runtime.effort, "effort", 64);
    const maxTurns = optionalInteger(context.runtime.max_turns, "max_turns", 1, 100);
    const maxBudgetUsd = optionalNonNegativeNumber(context.runtime.max_budget_usd, "max_budget_usd", 10_000);
    const workspace = assertWorkspacePath(optionalString(context.runtime.cwd, "cwd") ?? process.cwd());

    const controller = new AbortController();
    this.active.set(context.task.id, { controller });
    const abortFromParent = () => { void this.cancel(context.task.id); };
    if (context.signal.aborted) abortFromParent();
    else context.signal.addEventListener("abort", abortFromParent, { once: true });

    try {
      const toolList = tools.join(",");
      const args = [
        "-p",
        "Use the JSON task envelope supplied on stdin as the complete delegated request. Obey its authority limits.",
        "--safe-mode",
        "--restricted",
        "--tools",
        toolList,
        "--disallowedTools",
        "mcp__*",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--no-chrome"
      ];
      if (tools.length > 0) args.push("--allowedTools", toolList);
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (maxTurns !== undefined) args.push("--max-turns", String(maxTurns));
      if (maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(maxBudgetUsd));

      const prompt = boundedJson(
        runtimeEnvelope(context, capabilities, workspace),
        CLAUDE_CODE_MAX_PROMPT_BYTES,
        "Claude Code runtime envelope"
      );

      const result = await this.transport.run({
        command,
        args,
        cwd: workspace,
        env: {
          ...this.env,
          CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1"
        },
        stdin: prompt,
        signal: controller.signal,
        timeoutMs: (timeout + 30) * 1000,
        maxStdoutBytes: CLAUDE_CODE_MAX_STDOUT_BYTES
      });
      if (result.exitCode !== 0 || result.signal !== null) throw processFailure(result);
      const parsed = parseClaudeCodeJson(result.stdout.trim());
      const finalText = String(parsed.envelope.result ?? "").trim();

      return {
        summary: finalText
          ? (finalText.length > 240 ? `${finalText.slice(0, 237)}...` : finalText)
          : "Claude Code completed the delegated Task.",
        artifactKind: "claude_code_task_result",
        output: {
          text: finalText,
          remote_session_id: parsed.envelope.session_id,
          executed_by: context.principal.id,
          execution_principal_kind: context.principalKind
        },
        usage: parsed.usage,
        receipts: [{
          kind: "claude_code_process_execution",
          adapter: this.id,
          transport: "claude_print_json",
          remote_session_id: parsed.envelope.session_id,
          principal_kind: context.principalKind,
          local_task_id: context.task.id,
          process_capability_count: capabilities.size,
          enabled_builtin_tool_count: tools.length,
          permission_denial_count: parsed.permissionDenialCount,
          customization_policy: "safe_mode",
          machine_boundary: "restricted",
          permission_mode: "dontAsk",
          permission_prompts: "none",
          mcp_policy: "safe_mode_plus_explicit_mcp_deny",
          persistence: "disabled",
          remote_authentication: "not_supported_phase_4_4"
        }]
      };
    } catch (error) {
      if (error instanceof LocalCliProcessError) {
        throw new ClaudeCodeRuntimeError(
          error.code.replace(/^LOCAL_CLI_/, "CLAUDE_CODE_PROCESS_"),
          error.message
        );
      }
      throw error;
    } finally {
      this.active.delete(context.task.id);
      context.signal.removeEventListener("abort", abortFromParent);
      if (!controller.signal.aborted) controller.abort(new Error("Claude Code execution finished"));
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
