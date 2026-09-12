import { execFile, spawn } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import type { RuntimeAdapter, RuntimeExecutionContext, RuntimeExecutionResult } from "./runtime.js";
import type { JsonObject } from "./types.js";

export const OPENCLAW_RUNTIME_ADAPTER_ID = "openclaw";
export const OPENCLAW_RUNTIME_ENVELOPE = "ai-verse-multiple-bots/openclaw-runtime-envelope-v1";
export const OPENCLAW_MAX_PROMPT_BYTES = 512 * 1024;
export const OPENCLAW_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const OPENCLAW_NO_TOOLS_SENTINEL = "__ai_verse_multiple_bots_no_tools__";

export class OpenClawRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OpenClawRuntimeError";
  }
}

export interface OpenClawCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

export interface OpenClawCommandTransport {
  run(
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
  ): Promise<OpenClawCommandResult>;
}

export interface OpenClawRuntimeOptions {
  env?: Record<string, string | undefined>;
  transport?: OpenClawCommandTransport;
}

interface ActiveOpenClawTask {
  controller: AbortController;
}

interface OpenClawEnvelope extends JsonObject {
  ok: boolean;
  status: string;
  final: string;
  payloads: unknown[];
  model: string | null;
  provider: string | null;
  sessionId: string;
  usage?: JsonObject;
  costUsd?: number;
  assistantTurns?: number;
  codeModeEngaged?: boolean;
  toolSummary?: JsonObject;
  error?: JsonObject;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedJson(value: unknown, maxBytes: number, label: string): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new OpenClawRuntimeError("OPENCLAW_INVALID_PAYLOAD", `${label} is not JSON serializable`);
  }
  if (byteLength(text) > maxBytes) {
    throw new OpenClawRuntimeError("OPENCLAW_PAYLOAD_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
  }
  return text;
}

function optionalString(value: unknown, key: string, max = 4096): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new OpenClawRuntimeError("OPENCLAW_INVALID_CONFIG", `runtime.${key} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > max || /[\0\r\n]/.test(result)) {
    throw new OpenClawRuntimeError("OPENCLAW_INVALID_CONFIG", `runtime.${key} is invalid or too long`);
  }
  return result;
}

function timeoutSeconds(value: unknown): number {
  if (value === undefined || value === null) return 600;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3600) {
    throw new OpenClawRuntimeError(
      "OPENCLAW_INVALID_CONFIG",
      "runtime.timeout_seconds must be an integer between 1 and 3600"
    );
  }
  return value;
}

function codeMode(value: unknown): "direct" | "auto" | "code" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "direct" || value === "auto" || value === "code") return value;
  throw new OpenClawRuntimeError("OPENCLAW_INVALID_CONFIG", "runtime.code_mode must be direct, auto, or code");
}

function assertLocalOnly(runtime: JsonObject): void {
  for (const key of [
    "endpoint",
    "url",
    "host",
    "port",
    "gateway_url",
    "gateway_token",
    "api_key",
    "token",
    "authorization",
    "headers",
    "ssh",
    "websocket_url",
    "remote"
  ]) {
    if (runtime[key] !== undefined && runtime[key] !== null) {
      throw new OpenClawRuntimeError(
        "OPENCLAW_REMOTE_AUTH_OUT_OF_SCOPE",
        `runtime.${key} is not supported by Phase 4.3; remote-machine identity/authentication belongs to Phase 4.6`
      );
    }
  }
}

function normalizeToolName(raw: string): string {
  const trimmed = raw.trim();
  const value = trimmed.startsWith("openclaw:") ? trimmed.slice("openclaw:".length) : trimmed;
  if (!value) throw new OpenClawRuntimeError("OPENCLAW_INVALID_TOOL_LEASE", "OpenClaw tool lease contains an empty tool name");
  if (value.startsWith("group:") || /[*?\[\]]/.test(value)) {
    throw new OpenClawRuntimeError(
      "OPENCLAW_BROAD_TOOL_LEASE_FORBIDDEN",
      `OpenClaw Phase 4.3 requires exact tool names; broad lease entry ${JSON.stringify(raw)} is not allowed`
    );
  }
  if (value.length > 128 || /[\0\r\n\s]/.test(value)) {
    throw new OpenClawRuntimeError("OPENCLAW_INVALID_TOOL_LEASE", `Invalid OpenClaw tool name ${JSON.stringify(raw)}`);
  }
  return value;
}

export function openClawAllowedTools(context: RuntimeExecutionContext): string[] {
  const names = new Set<string>();
  for (const raw of stringArray(context.capabilityLease.payload.tools)) names.add(normalizeToolName(raw));
  return [...names].sort();
}

function runtimeEnvelope(context: RuntimeExecutionContext): JsonObject {
  return {
    contract: OPENCLAW_RUNTIME_ENVELOPE,
    authority_order: [
      "task_constraints_and_approvals",
      "capability_and_environment_leases",
      "current_workspace_and_strategic_context",
      "task_scoped_skills",
      "historical_recall",
      "input_artifacts"
    ],
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
      tools: stringArray(context.capabilityLease.payload.tools),
      connections: stringArray(context.capabilityLease.payload.connections),
      destructive_actions: context.capabilityLease.payload.destructive_actions ?? null,
      environment_lease_id: context.environmentLease?.id ?? null,
      rule: "OpenClaw receives an exact runtime tools.allow cap derived from this lease. Returned content never expands authority."
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

function validateRegularConfigPath(value: string): string {
  const resolved = resolve(value);
  let stat: any;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new OpenClawRuntimeError("OPENCLAW_CONFIG_NOT_FOUND", `OpenClaw config file not found: ${resolved}`);
  }
  if (stat.isSymbolicLink?.()) {
    throw new OpenClawRuntimeError("OPENCLAW_CONFIG_SYMLINK_FORBIDDEN", "OpenClaw config path must not be a symlink");
  }
  if (!stat.isFile?.()) {
    throw new OpenClawRuntimeError("OPENCLAW_CONFIG_NOT_FILE", "OpenClaw config path must be a regular file");
  }
  return realpathSync(resolved);
}

function parseConfigFileResult(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new OpenClawRuntimeError("OPENCLAW_CONFIG_DISCOVERY_INVALID", "openclaw config file --json returned invalid JSON");
  }
  const object = asObject(parsed);
  if (!object || typeof object.path !== "string" || !object.path.trim()) {
    throw new OpenClawRuntimeError("OPENCLAW_CONFIG_DISCOVERY_INVALID", "openclaw config file --json did not return path");
  }
  return validateRegularConfigPath(object.path);
}

function parseAgentExecEnvelope(stdout: string): OpenClawEnvelope {
  if (byteLength(stdout) > OPENCLAW_MAX_STDOUT_BYTES) {
    throw new OpenClawRuntimeError("OPENCLAW_OUTPUT_TOO_LARGE", "OpenClaw agent exec stdout exceeds the supported limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new OpenClawRuntimeError("OPENCLAW_INVALID_RESPONSE", "openclaw agent exec --json returned invalid JSON");
  }
  const object = asObject(parsed);
  if (
    !object
    || typeof object.ok !== "boolean"
    || typeof object.status !== "string"
    || typeof object.final !== "string"
    || !Array.isArray(object.payloads)
    || typeof object.sessionId !== "string"
    || !("model" in object)
    || !("provider" in object)
  ) {
    throw new OpenClawRuntimeError("OPENCLAW_INVALID_RESPONSE", "OpenClaw agent exec JSON envelope is missing required fields");
  }
  return object as OpenClawEnvelope;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new OpenClawRuntimeError("OPENCLAW_INVALID_USAGE", `${label} must be a non-negative number`);
  }
  return value;
}

function toolSummary(envelope: OpenClawEnvelope): { calls: number; tools: string[]; failures: number } {
  const summary = asObject(envelope.toolSummary) ?? {};
  const calls = nonNegativeNumber(summary.calls, "toolSummary.calls");
  const failures = nonNegativeNumber(summary.failures, "toolSummary.failures");
  const tools = stringArray(summary.tools).map((name) => name.trim()).filter(Boolean);
  return { calls: Math.floor(calls), tools, failures: Math.floor(failures) };
}

function assertObservedToolsAllowed(observed: string[], allowed: string[]): void {
  const allow = new Set(allowed);
  const unauthorized = [...new Set(observed.filter((name) => !allow.has(name)))].sort();
  if (unauthorized.length > 0) {
    throw new OpenClawRuntimeError(
      "OPENCLAW_TOOL_POLICY_VIOLATION",
      `OpenClaw reported tool execution outside the local capability lease: ${unauthorized.slice(0, 12).join(", ")}`
    );
  }
}

function usageFromEnvelope(envelope: OpenClawEnvelope, toolCalls: number): JsonObject {
  const usage = asObject(envelope.usage) ?? {};
  const input = nonNegativeNumber(usage.input, "usage.input");
  const output = nonNegativeNumber(usage.output, "usage.output");
  const cost = nonNegativeNumber(envelope.costUsd, "costUsd");
  const turns = nonNegativeNumber(envelope.assistantTurns, "assistantTurns");
  return {
    input_tokens: Math.floor(input),
    output_tokens: Math.floor(output),
    cost,
    actions: Math.max(1, Math.floor(turns) + toolCalls)
  };
}

function safeErrorMessage(envelope: OpenClawEnvelope, result: OpenClawCommandResult): string {
  const error = asObject(envelope.error);
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim().slice(0, 500);
  if (result.stderr.trim()) return result.stderr.replace(/\s+/g, " ").trim().slice(-500);
  return `OpenClaw agent exec ended with status ${envelope.status}`;
}

function createOverlay(configPath: string, allowedTools: string[]): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ai-verse-openclaw-"));
  const path = join(dir, "openclaw-overlay.json");
  const allow = allowedTools.length > 0 ? allowedTools : [OPENCLAW_NO_TOOLS_SENTINEL];
  const overlay = {
    $include: configPath,
    tools: { allow }
  };
  writeFileSync(path, JSON.stringify(overlay, null, 2) + "\n", { mode: 0o600 });
  return { dir, path };
}

function appendIncludeRoot(env: Record<string, string | undefined>, root: string): Record<string, string | undefined> {
  const existing = (env.OPENCLAW_INCLUDE_ROOTS ?? "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const roots = [...new Set([...existing, root])];
  return {
    ...env,
    OPENCLAW_INCLUDE_ROOTS: roots.join(delimiter),
    OPENCLAW_CONFIG_READONLY: "1"
  };
}

export class OpenClawCliCommandTransport implements OpenClawCommandTransport {
  constructor(
    private readonly spawnImpl: typeof spawn = spawn,
    private readonly execFileImpl: typeof execFile = execFile
  ) {}

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
    if (options.signal.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("OpenClaw process canceled");
    }

    return await new Promise<OpenClawCommandResult>((resolvePromise, rejectPromise) => {
      let child: any;
      try {
        child = this.spawnImpl(command, args, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false
        });
      } catch (error) {
        rejectPromise(new OpenClawRuntimeError(
          "OPENCLAW_SPAWN_FAILED",
          `Could not start OpenClaw: ${error instanceof Error ? error.message : String(error)}`
        ));
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let forceKill: ReturnType<typeof setTimeout> | null = null;
      const timeout = setTimeout(() => {
        if (settled) return;
        child.kill?.("SIGTERM");
        forceKill = setTimeout(() => child.kill?.("SIGKILL"), 1000);
      }, options.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        options.signal.removeEventListener("abort", abort);
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      };

      const abort = () => {
        if (settled) return;
        child.kill?.("SIGTERM");
        forceKill = setTimeout(() => child.kill?.("SIGKILL"), 1000);
      };
      options.signal.addEventListener("abort", abort, { once: true });

      child.stdout?.on("data", (chunk: unknown) => {
        stdout += String(chunk);
        if (byteLength(stdout) > options.maxStdoutBytes) {
          child.kill?.("SIGTERM");
          fail(new OpenClawRuntimeError("OPENCLAW_OUTPUT_TOO_LARGE", "OpenClaw stdout exceeded the supported limit"));
        }
      });
      child.stderr?.on("data", (chunk: unknown) => {
        stderr = (stderr + String(chunk)).slice(-32_768);
      });
      child.once?.("error", (error: Error) => fail(new OpenClawRuntimeError("OPENCLAW_PROCESS_ERROR", error.message)));
      child.once?.("exit", (code: number | null, processSignal: string | null) => {
        if (settled) return;
        if (options.signal.aborted) {
          fail(options.signal.reason instanceof Error ? options.signal.reason : new Error("OpenClaw process canceled"));
          return;
        }
        settled = true;
        cleanup();
        resolvePromise({ stdout, stderr, exitCode: code, signal: processSignal });
      });

      if (options.stdin !== undefined) child.stdin?.end(options.stdin);
      else child.stdin?.end();
    });
  }

  async discoverConfigPath(
    command: string,
    env: Record<string, string | undefined>,
    signal: AbortSignal
  ): Promise<string> {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("OpenClaw config discovery canceled");

    return await new Promise<string>((resolvePromise, rejectPromise) => {
      let child: any = null;
      const abort = () => {
        try { child?.kill?.("SIGTERM"); } catch {}
        rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("OpenClaw config discovery canceled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        child = this.execFileImpl(
          command,
          ["config", "file", "--json"],
          { env, encoding: "utf8", maxBuffer: 256 * 1024 },
          (error: Error | null, stdout: string, stderr: string) => {
            signal.removeEventListener("abort", abort);
            if (signal.aborted) {
              rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("OpenClaw config discovery canceled"));
              return;
            }
            if (error) {
              rejectPromise(new OpenClawRuntimeError(
                "OPENCLAW_CONFIG_DISCOVERY_FAILED",
                `Could not resolve active OpenClaw config: ${stderr.replace(/\s+/g, " ").trim().slice(-500) || error.message}`
              ));
              return;
            }
            try {
              resolvePromise(parseConfigFileResult(stdout));
            } catch (parseError) {
              rejectPromise(parseError);
            }
          }
        );
      } catch (error) {
        signal.removeEventListener("abort", abort);
        rejectPromise(new OpenClawRuntimeError(
          "OPENCLAW_CONFIG_DISCOVERY_FAILED",
          `Could not start OpenClaw config discovery: ${error instanceof Error ? error.message : String(error)}`
        ));
      }
    });
  }
}

export class OpenClawAgentExecRuntimeAdapter implements RuntimeAdapter {
  readonly id = OPENCLAW_RUNTIME_ADAPTER_ID;
  private readonly env: Record<string, string | undefined>;
  private readonly transport: OpenClawCommandTransport & { discoverConfigPath?: (
    command: string,
    env: Record<string, string | undefined>,
    signal: AbortSignal
  ) => Promise<string> };
  private readonly active = new Map<string, ActiveOpenClawTask>();

  constructor(options: OpenClawRuntimeOptions = {}) {
    this.env = options.env ?? process.env as Record<string, string | undefined>;
    this.transport = options.transport ?? new OpenClawCliCommandTransport();
  }

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    assertLocalOnly(context.runtime);
    const command = optionalString(context.runtime.command, "command", 1024) ?? "openclaw";
    const timeout = timeoutSeconds(context.runtime.timeout_seconds);
    const mode = codeMode(context.runtime.code_mode);
    const model = optionalString(context.runtime.model, "model", 256);
    const thinking = optionalString(context.runtime.thinking, "thinking", 64);
    if (context.runtime.local_model_lean !== undefined && typeof context.runtime.local_model_lean !== "boolean") {
      throw new OpenClawRuntimeError("OPENCLAW_INVALID_CONFIG", "runtime.local_model_lean must be boolean");
    }

    const cwd = resolve(optionalString(context.runtime.cwd, "cwd") ?? process.cwd());
    let cwdStat: any;
    try {
      cwdStat = lstatSync(cwd);
    } catch {
      throw new OpenClawRuntimeError("OPENCLAW_CWD_NOT_FOUND", `OpenClaw cwd does not exist: ${cwd}`);
    }
    if (!cwdStat.isDirectory?.()) throw new OpenClawRuntimeError("OPENCLAW_CWD_NOT_DIRECTORY", "OpenClaw cwd must be a directory");

    const allowedTools = openClawAllowedTools(context);
    const controller = new AbortController();
    this.active.set(context.task.id, { controller });
    const abortFromParent = () => { void this.cancel(context.task.id); };
    if (context.signal.aborted) abortFromParent();
    else context.signal.addEventListener("abort", abortFromParent, { once: true });

    let overlayDir: string | null = null;
    try {
      const explicitConfig = optionalString(context.runtime.config_path, "config_path");
      const configPath = explicitConfig
        ? validateRegularConfigPath(explicitConfig)
        : await this.discoverConfigPath(command, controller.signal);

      const overlay = createOverlay(configPath, allowedTools);
      overlayDir = overlay.dir;
      const env = appendIncludeRoot(this.env, dirname(configPath));
      const args = [
        "agent",
        "exec",
        "--message-file",
        "-",
        "--cwd",
        cwd,
        "--config",
        overlay.path,
        "--timeout",
        String(timeout),
        "--json"
      ];
      if (model) args.push("--model", model);
      if (thinking) args.push("--thinking", thinking);
      if (mode) args.push("--code-mode", mode);
      if (context.runtime.local_model_lean === true) args.push("--local-model-lean");

      const prompt = boundedJson(runtimeEnvelope(context), OPENCLAW_MAX_PROMPT_BYTES, "OpenClaw runtime envelope");
      const result = await this.transport.run(command, args, {
        cwd,
        env,
        stdin: prompt,
        signal: controller.signal,
        timeoutMs: (timeout + 30) * 1000,
        maxStdoutBytes: OPENCLAW_MAX_STDOUT_BYTES
      });
      const envelope = parseAgentExecEnvelope(result.stdout.trim());

      if (
        result.exitCode !== 0
        || result.signal !== null
        || envelope.ok !== true
        || envelope.status !== "ok"
      ) {
        const code = envelope.status === "timeout" || result.exitCode === 2
          ? "OPENCLAW_REMOTE_TIMEOUT"
          : "OPENCLAW_REMOTE_FAILED";
        throw new OpenClawRuntimeError(code, safeErrorMessage(envelope, result));
      }

      const summary = toolSummary(envelope);
      assertObservedToolsAllowed(summary.tools, allowedTools);
      const usage = usageFromEnvelope(envelope, summary.calls);
      const finalText = envelope.final.trim();

      return {
        summary: finalText
          ? (finalText.length > 240 ? `${finalText.slice(0, 237)}...` : finalText)
          : "OpenClaw completed the delegated Task.",
        artifactKind: "openclaw_task_result",
        output: {
          text: finalText,
          remote_session_id: envelope.sessionId,
          executed_by: context.principal.id,
          execution_principal_kind: context.principalKind
        },
        usage,
        receipts: [{
          kind: "openclaw_execution",
          adapter: this.id,
          transport: "agent_exec_cli",
          protocol: "openclaw-agent-exec-json-v1",
          remote_session_id: envelope.sessionId,
          model: typeof envelope.model === "string" ? envelope.model : null,
          provider: typeof envelope.provider === "string" ? envelope.provider : null,
          observed_tool_call_count: summary.calls,
          observed_tool_failure_count: summary.failures,
          assistant_turns: typeof envelope.assistantTurns === "number" ? envelope.assistantTurns : null,
          code_mode_engaged: envelope.codeModeEngaged === true,
          tool_policy: "temporary_readonly_global_allow_overlay",
          principal_kind: context.principalKind,
          local_task_id: context.task.id,
          remote_authentication: "not_supported_phase_4_3"
        }]
      };
    } finally {
      if (overlayDir) {
        try { rmSync(overlayDir, { recursive: true, force: true }); } catch {}
      }
      this.active.delete(context.task.id);
      context.signal.removeEventListener("abort", abortFromParent);
      if (!controller.signal.aborted) controller.abort(new Error("OpenClaw execution finished"));
    }
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) return;
    if (!active.controller.signal.aborted) {
      active.controller.abort(new Error(`Runtime Task ${taskId} canceled`));
    }
  }

  private async discoverConfigPath(command: string, signal: AbortSignal): Promise<string> {
    if (!this.transport.discoverConfigPath) {
      throw new OpenClawRuntimeError(
        "OPENCLAW_CONFIG_PATH_REQUIRED",
        "runtime.config_path is required when the configured OpenClaw transport cannot discover the active config"
      );
    }
    return await this.transport.discoverConfigPath(command, this.env, signal);
  }
}
