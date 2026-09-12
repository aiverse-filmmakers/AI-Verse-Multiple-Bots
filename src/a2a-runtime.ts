import type { RuntimeAdapter, RuntimeExecutionContext, RuntimeExecutionResult } from "./runtime.js";
import type { JsonObject } from "./types.js";

export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_JSONRPC_BINDING = "JSONRPC";
export const A2A_AGENT_CARD_MAX_BYTES = 256 * 1024;
export const A2A_REQUEST_MAX_BYTES = 512 * 1024;
export const A2A_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

const TERMINAL = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED"
]);
const INTERRUPTED = new Set(["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]);

export class A2ARuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "A2ARuntimeError";
  }
}

export interface A2ARuntimeOptions {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface SafeUrl {
  requestUrl: string;
  receiptUrl: string;
}

interface A2AInterface {
  url: SafeUrl;
  protocolVersion: string;
  tenant?: string;
}

interface A2AAgentCard {
  name: string;
  version: string;
  interface: A2AInterface;
  inputMode: "application/json" | "text/plain";
  outputModes: string[];
}

interface ActiveA2ATask {
  controller: AbortController;
  remoteTaskId: string | null;
  interface: A2AInterface | null;
  cancelRequested: boolean;
  actionCount: number;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function safeUrl(value: unknown, label: string): SafeUrl {
  if (typeof value !== "string" || !value.trim()) throw new A2ARuntimeError("A2A_INVALID_CONFIG", `${label} must be a non-empty URL`);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new A2ARuntimeError("A2A_INVALID_CONFIG", `${label} must be a valid HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new A2ARuntimeError("A2A_INVALID_CONFIG", `${label} protocol ${url.protocol} is not supported`);
  }
  if (url.username || url.password) {
    throw new A2ARuntimeError("A2A_CREDENTIALS_FORBIDDEN", `${label} must not embed credentials`);
  }
  const requestUrl = url.toString();
  url.search = "";
  url.hash = "";
  return { requestUrl, receiptUrl: url.toString() };
}

function requiredRuntimeString(runtime: JsonObject, key: string): string {
  const value = runtime[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new A2ARuntimeError("A2A_INVALID_CONFIG", `a2a runtime requires runtime.${key}`);
  }
  return value.trim();
}

function pollInterval(runtime: JsonObject): number {
  const raw = runtime.poll_interval_ms;
  if (raw === undefined || raw === null) return 250;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 25 || raw > 10_000) {
    throw new A2ARuntimeError("A2A_INVALID_CONFIG", "runtime.poll_interval_ms must be an integer between 25 and 10000");
  }
  return raw;
}

function boundedJson(value: unknown, maxBytes: number, label: string): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new A2ARuntimeError("A2A_INVALID_PAYLOAD", `${label} is not JSON serializable`);
  }
  if (bytes(text) > maxBytes) {
    throw new A2ARuntimeError("A2A_PAYLOAD_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
  }
  return text;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("A2A execution canceled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("A2A execution canceled"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function responseSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function stateOf(task: JsonObject): string {
  const status = asObject(task.status);
  const state = status?.state;
  if (typeof state !== "string" || !state) throw new A2ARuntimeError("A2A_INVALID_RESPONSE", "A2A Task is missing status.state");
  return state;
}

function partsOf(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.map(asObject).filter((part): part is JsonObject => Boolean(part));
}

function summaryFromParts(parts: JsonObject[]): string | null {
  for (const part of parts) {
    if (typeof part.text === "string" && part.text.trim()) return part.text.trim();
  }
  for (const part of parts) {
    if ("data" in part) {
      const text = JSON.stringify(part.data);
      if (text && text !== "null") return text;
    }
  }
  return null;
}

function statusMessageSummary(task: JsonObject): string | null {
  const status = asObject(task.status);
  const message = asObject(status?.message);
  return summaryFromParts(partsOf(message?.parts));
}

function remoteFailureMessage(task: JsonObject): string {
  const state = stateOf(task);
  return statusMessageSummary(task) ?? `Remote A2A task ended in ${state}`;
}

function validateA2AArtifacts(value: unknown): JsonObject[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new A2ARuntimeError("A2A_INVALID_RESPONSE", "A2A Task artifacts must be an array");
  return value.map((raw, index) => {
    const artifact = asObject(raw);
    if (!artifact || typeof artifact.artifactId !== "string" || !artifact.artifactId) {
      throw new A2ARuntimeError("A2A_INVALID_RESPONSE", `A2A Artifact ${index} is missing artifactId`);
    }
    const parts = partsOf(artifact.parts);
    if (parts.length === 0) throw new A2ARuntimeError("A2A_INVALID_RESPONSE", `A2A Artifact ${artifact.artifactId} has no parts`);
    return artifact;
  });
}

function runtimeEnvelope(context: RuntimeExecutionContext): JsonObject {
  const leaseTools = stringArray(context.capabilityLease.payload.tools);
  const leaseConnections = stringArray(context.capabilityLease.payload.connections);
  return {
    contract: "ai-verse-multiple-bots/a2a-runtime-envelope-v1",
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
      tools: leaseTools,
      connections: leaseConnections,
      destructive_actions: context.capabilityLease.payload.destructive_actions ?? null,
      environment_lease_id: context.environmentLease?.id ?? null
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

export class A2AJsonRpcRuntimeAdapter implements RuntimeAdapter {
  readonly id = "a2a";
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly active = new Map<string, ActiveA2ATask>();

  constructor(options: A2ARuntimeOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    const runtime = context.runtime;
    for (const key of ["api_key", "token", "authorization", "api_key_env", "bearer_token_env", "headers"]) {
      if (runtime[key] !== undefined && runtime[key] !== null) {
        throw new A2ARuntimeError(
          "A2A_AUTH_OUT_OF_SCOPE",
          `runtime.${key} is not supported by Phase 4.1; A2A authentication belongs to the later remote identity/authentication slice`
        );
      }
    }

    const cardUrl = safeUrl(requiredRuntimeString(runtime, "agent_card_url"), "runtime.agent_card_url");
    const interval = pollInterval(runtime);
    const controller = new AbortController();
    const active: ActiveA2ATask = {
      controller,
      remoteTaskId: null,
      interface: null,
      cancelRequested: false,
      actionCount: 0
    };
    this.active.set(context.task.id, active);

    const abortFromParent = () => {
      void this.cancel(context.task.id);
    };
    if (context.signal.aborted) abortFromParent();
    else context.signal.addEventListener("abort", abortFromParent, { once: true });

    try {
      const card = await this.discover(cardUrl, controller.signal, active);
      active.interface = card.interface;
      const envelope = runtimeEnvelope(context);
      const envelopeText = boundedJson(envelope, A2A_REQUEST_MAX_BYTES, "A2A runtime envelope");
      const messagePart: JsonObject = card.inputMode === "application/json"
        ? { data: envelope, mediaType: "application/json" }
        : { text: envelopeText, mediaType: "text/plain" };

      const params: JsonObject = {
        message: {
          messageId: `aiverse:${context.task.id}`,
          role: "ROLE_USER",
          parts: [messagePart],
          metadata: {
            source: "ai-verse-multiple-bots",
            local_task_id: context.task.id,
            local_principal_id: context.principal.id,
            local_principal_kind: context.principalKind,
            workspace_id: context.task.workspaceId
          }
        },
        configuration: {
          acceptedOutputModes: card.outputModes,
          historyLength: 0,
          returnImmediately: true
        },
        metadata: {
          local_task_id: context.task.id,
          root_objective_id: context.task.payload.root_objective_id ?? null
        }
      };
      if (card.interface.tenant) params.tenant = card.interface.tenant;

      const sendResult = await this.rpc(
        card.interface,
        "SendMessage",
        params,
        `send:${context.task.id}`,
        controller.signal,
        active
      );
      const direct = asObject(sendResult.message);
      const initialTask = asObject(sendResult.task);

      if (direct && initialTask) throw new A2ARuntimeError("A2A_INVALID_RESPONSE", "SendMessage response contained both task and message");
      if (direct) return this.resultFromMessage(context, card, direct, active.actionCount);
      if (!initialTask) throw new A2ARuntimeError("A2A_INVALID_RESPONSE", "SendMessage response contained neither task nor message");

      const remoteTaskId = initialTask.id;
      if (typeof remoteTaskId !== "string" || !remoteTaskId) {
        throw new A2ARuntimeError("A2A_INVALID_RESPONSE", "Remote A2A Task is missing id");
      }
      active.remoteTaskId = remoteTaskId;
      if (active.cancelRequested || controller.signal.aborted) {
        await this.cancelRemote(active).catch(() => undefined);
        throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("A2A execution canceled");
      }

      let task = initialTask;
      while (!TERMINAL.has(stateOf(task)) && !INTERRUPTED.has(stateOf(task))) {
        await this.sleepImpl(interval, controller.signal);
        const getParams: JsonObject = { id: remoteTaskId, historyLength: 0 };
        if (card.interface.tenant) getParams.tenant = card.interface.tenant;
        task = await this.rpc(
          card.interface,
          "GetTask",
          getParams,
          `get:${context.task.id}:${active.actionCount}`,
          controller.signal,
          active
        );
        if (typeof task.id !== "string" || task.id !== remoteTaskId) {
          throw new A2ARuntimeError("A2A_INVALID_RESPONSE", "GetTask returned a different remote task id");
        }
      }

      const state = stateOf(task);
      if (state === "TASK_STATE_COMPLETED") {
        return this.resultFromTask(context, card, task, active.actionCount);
      }
      if (state === "TASK_STATE_INPUT_REQUIRED") {
        throw new A2ARuntimeError("A2A_INPUT_REQUIRED", remoteFailureMessage(task));
      }
      if (state === "TASK_STATE_AUTH_REQUIRED") {
        throw new A2ARuntimeError("A2A_AUTH_REQUIRED", `Remote A2A agent requires authorization: ${remoteFailureMessage(task)}`);
      }
      if (state === "TASK_STATE_CANCELED") {
        throw new A2ARuntimeError("A2A_REMOTE_CANCELED", remoteFailureMessage(task));
      }
      if (state === "TASK_STATE_REJECTED") {
        throw new A2ARuntimeError("A2A_REMOTE_REJECTED", remoteFailureMessage(task));
      }
      throw new A2ARuntimeError("A2A_REMOTE_FAILED", remoteFailureMessage(task));
    } finally {
      this.active.delete(context.task.id);
      context.signal.removeEventListener("abort", abortFromParent);
      if (!controller.signal.aborted) controller.abort(new Error("A2A execution finished"));
    }
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) return;
    active.cancelRequested = true;
    await this.cancelRemote(active).catch(() => undefined);
    if (!active.controller.signal.aborted) active.controller.abort(new Error(`Runtime Task ${taskId} canceled`));
  }

  private async discover(cardUrl: SafeUrl, signal: AbortSignal, active: ActiveA2ATask): Promise<A2AAgentCard> {
    active.actionCount += 1;
    const response = await this.fetchImpl(cardUrl.requestUrl, {
      method: "GET",
      headers: { accept: "application/json, application/a2a+json" },
      signal
    });
    const card = await this.readJson(response, "Agent Card", A2A_AGENT_CARD_MAX_BYTES);
    if (!response.ok) {
      throw new A2ARuntimeError("A2A_AGENT_CARD_HTTP", `A2A Agent Card HTTP ${response.status}`);
    }

    const name = card.name;
    const version = card.version;
    if (typeof name !== "string" || !name.trim() || typeof version !== "string" || !version.trim()) {
      throw new A2ARuntimeError("A2A_INVALID_AGENT_CARD", "Agent Card requires non-empty name and version");
    }
    const securityRequirements = card.securityRequirements;
    if (Array.isArray(securityRequirements) && securityRequirements.length > 0) {
      throw new A2ARuntimeError(
        "A2A_AUTH_OUT_OF_SCOPE",
        "Agent Card requires authentication; Phase 4.1 intentionally defers remote identity/authentication"
      );
    }
    const capabilities = asObject(card.capabilities);
    if (!capabilities) throw new A2ARuntimeError("A2A_INVALID_AGENT_CARD", "Agent Card requires capabilities");
    const extensions = Array.isArray(capabilities.extensions) ? capabilities.extensions : [];
    if (extensions.some((raw) => asObject(raw)?.required === true)) {
      throw new A2ARuntimeError("A2A_REQUIRED_EXTENSION_UNSUPPORTED", "Agent Card requires an A2A extension not implemented by Phase 4.1");
    }

    const inputModes = stringArray(card.defaultInputModes);
    const outputModes = stringArray(card.defaultOutputModes);
    if (inputModes.length === 0 || outputModes.length === 0) {
      throw new A2ARuntimeError("A2A_INVALID_AGENT_CARD", "Agent Card requires defaultInputModes and defaultOutputModes");
    }
    const inputMode = inputModes.includes("application/json")
      ? "application/json"
      : inputModes.includes("text/plain")
        ? "text/plain"
        : null;
    if (!inputMode) {
      throw new A2ARuntimeError("A2A_CONTENT_TYPE_UNSUPPORTED", "A2A agent accepts neither application/json nor text/plain input");
    }

    const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
    let selected: A2AInterface | null = null;
    for (const raw of interfaces) {
      const item = asObject(raw);
      if (!item || item.protocolBinding !== A2A_JSONRPC_BINDING || item.protocolVersion !== A2A_PROTOCOL_VERSION) continue;
      const url = safeUrl(item.url, "Agent Card JSONRPC interface");
      selected = {
        url,
        protocolVersion: A2A_PROTOCOL_VERSION,
        ...(typeof item.tenant === "string" && item.tenant.trim() ? { tenant: item.tenant.trim() } : {})
      };
      break;
    }
    if (!selected) {
      throw new A2ARuntimeError("A2A_INTERFACE_UNSUPPORTED", "Agent Card exposes no supported JSONRPC A2A v1.0 interface");
    }

    return {
      name: name.trim(),
      version: version.trim(),
      interface: selected,
      inputMode,
      outputModes: [...new Set(outputModes)].slice(0, 32)
    };
  }

  private async rpc(
    iface: A2AInterface,
    method: "SendMessage" | "GetTask" | "CancelTask",
    params: JsonObject,
    requestId: string,
    signal: AbortSignal | undefined,
    active?: ActiveA2ATask
  ): Promise<JsonObject> {
    if (active) active.actionCount += 1;
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      method,
      params
    };
    const body = boundedJson(payload, A2A_REQUEST_MAX_BYTES, `A2A ${method} request`);
    const response = await this.fetchImpl(iface.url.requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "A2A-Version": iface.protocolVersion
      },
      body,
      ...(signal ? { signal } : {})
    });
    const decoded = await this.readJson(response, `A2A ${method} response`, A2A_RESPONSE_MAX_BYTES);
    if (!response.ok) {
      throw new A2ARuntimeError("A2A_HTTP_ERROR", `A2A ${method} HTTP ${response.status}`);
    }
    if (decoded.jsonrpc !== "2.0" || decoded.id !== requestId) {
      throw new A2ARuntimeError("A2A_INVALID_RESPONSE", `A2A ${method} returned an invalid JSON-RPC envelope`);
    }
    const rpcError = asObject(decoded.error);
    if (rpcError) {
      const code = rpcError.code;
      const message = typeof rpcError.message === "string" ? rpcError.message : "A2A JSON-RPC error";
      throw new A2ARuntimeError("A2A_RPC_ERROR", `A2A ${method} error ${String(code)}: ${message.slice(0, 500)}`);
    }
    const result = asObject(decoded.result);
    if (!result) throw new A2ARuntimeError("A2A_INVALID_RESPONSE", `A2A ${method} response is missing result`);
    return result;
  }

  private async readJson(response: Response, label: string, maxBytes: number): Promise<JsonObject> {
    const length = response.headers.get("content-length");
    if (length && Number(length) > maxBytes) {
      throw new A2ARuntimeError("A2A_RESPONSE_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
    }
    const text = await response.text();
    if (bytes(text) > maxBytes) throw new A2ARuntimeError("A2A_RESPONSE_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new A2ARuntimeError("A2A_INVALID_RESPONSE", `${label} returned invalid JSON: ${responseSnippet(text)}`);
    }
    const object = asObject(parsed);
    if (!object) throw new A2ARuntimeError("A2A_INVALID_RESPONSE", `${label} must contain a JSON object`);
    return object;
  }

  private async cancelRemote(active: ActiveA2ATask): Promise<void> {
    if (!active.interface || !active.remoteTaskId) return;
    const params: JsonObject = {
      id: active.remoteTaskId,
      metadata: { source: "ai-verse-multiple-bots", reason: "local_task_canceled" }
    };
    if (active.interface.tenant) params.tenant = active.interface.tenant;
    await this.rpc(
      active.interface,
      "CancelTask",
      params,
      `cancel:${active.remoteTaskId}`,
      undefined
    );
  }

  private resultFromMessage(
    context: RuntimeExecutionContext,
    card: A2AAgentCard,
    message: JsonObject,
    actionCount: number
  ): RuntimeExecutionResult {
    const parts = partsOf(message.parts);
    if (parts.length === 0) throw new A2ARuntimeError("A2A_INVALID_RESPONSE", "Direct A2A Message response has no parts");
    const summary = summaryFromParts(parts) ?? `A2A response from ${card.name}`;
    return {
      summary: summary.length > 240 ? `${summary.slice(0, 237)}...` : summary,
      artifactKind: "a2a_message_result",
      output: {
        remote_message_id: typeof message.messageId === "string" ? message.messageId : null,
        parts,
        executed_by: context.principal.id,
        execution_principal_kind: context.principalKind
      },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: actionCount },
      receipts: [this.receipt(context, card, null, null, 0, actionCount)]
    };
  }

  private resultFromTask(
    context: RuntimeExecutionContext,
    card: A2AAgentCard,
    task: JsonObject,
    actionCount: number
  ): RuntimeExecutionResult {
    const artifacts = validateA2AArtifacts(task.artifacts);
    const firstArtifactSummary = artifacts
      .map((artifact) => summaryFromParts(partsOf(artifact.parts)))
      .find((value): value is string => Boolean(value));
    const summary = firstArtifactSummary ?? statusMessageSummary(task) ?? `A2A task ${String(task.id)} completed`;
    const contextId = typeof task.contextId === "string" ? task.contextId : null;
    return {
      summary: summary.length > 240 ? `${summary.slice(0, 237)}...` : summary,
      artifactKind: "a2a_task_result",
      output: {
        remote_task_id: task.id,
        remote_context_id: contextId,
        remote_state: stateOf(task),
        artifacts,
        executed_by: context.principal.id,
        execution_principal_kind: context.principalKind
      },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: actionCount },
      receipts: [this.receipt(context, card, String(task.id), contextId, artifacts.length, actionCount)]
    };
  }

  private receipt(
    context: RuntimeExecutionContext,
    card: A2AAgentCard,
    remoteTaskId: string | null,
    contextId: string | null,
    artifactCount: number,
    actionCount: number
  ): JsonObject {
    return {
      kind: "a2a_execution",
      adapter: this.id,
      protocol: "a2a",
      protocol_version: card.interface.protocolVersion,
      protocol_binding: A2A_JSONRPC_BINDING,
      agent_name: card.name,
      agent_version: card.version,
      endpoint: card.interface.url.receiptUrl,
      remote_task_id: remoteTaskId,
      remote_context_id: contextId,
      remote_artifact_count: artifactCount,
      request_count: actionCount,
      principal_kind: context.principalKind,
      local_task_id: context.task.id,
      authentication: "not_supported_phase_4_1"
    };
  }
}
