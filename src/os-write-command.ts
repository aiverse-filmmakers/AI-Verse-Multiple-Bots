import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import process from "node:process";
import { detectAiVerseOsCompatibility } from "./ai-verse-os-registration.js";
import { CoordinationGateway } from "./gateway.js";
import { CoordinationStore } from "./store.js";
import type { JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export const AI_VERSE_OS_WRITE_COMMAND_PROVIDER = "ai-verse-os/write-command-v1";
export const AI_VERSE_OS_WRITE_COMMAND_PATH = "scripts/write-command.mjs";
export const AI_VERSE_OS_WRITE_COMMAND_SCHEMA = "1.0";
export const AI_VERSE_OS_WRITE_COMMAND_MAX_BYTES = 128 * 1024;
export const AI_VERSE_OS_WRITE_COMMAND_DEFAULT_TIMEOUT_MS = 10_000;

const SCOPE = /^(operator|workspace:[a-z0-9][a-z0-9._-]{0,127})$/;
const OPERATION = /^[a-z][a-z0-9_.-]{0,127}$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const ACTIVE_WORKER_STATES = new Set(["created", "ready", "running", "waiting"]);

export interface OsWriteCommandProvenanceInput {
  taskId?: string;
  runId?: string;
  artifactRefs?: string[];
}

export interface OsWriteCommandInput {
  requestedBy: string;
  scope: string;
  operation: string;
  parameters: JsonObject;
  idempotencyKey: string;
  reason: string;
  createdAt: string;
  provenance?: OsWriteCommandProvenanceInput;
}

export interface OsWriteCommandRequest extends JsonObject {
  schema_version: "1.0";
  request_id: string;
  scope: string;
  operation: string;
  parameters: JsonObject;
  idempotency_key: string;
  requested_by: string;
  reason: string;
  created_at: string;
  provenance: JsonObject;
  request_fingerprint: string;
}

export interface OsWriteCommandReceipt extends JsonObject {
  schema_version: "1.0";
  provider: string;
  status: "queued";
  command_id: string;
  request_id: string;
  request_fingerprint: string;
  idempotency_key: string;
  scope: string;
  operation: string;
  requested_by: string;
  queued_at: string;
  host_permission: JsonObject;
  effect_occurred: false;
  canonical_effect_occurred: false;
  result: JsonObject;
  replayed: boolean;
}

export interface OsWriteCommandSink {
  enqueue(request: OsWriteCommandRequest): Promise<OsWriteCommandReceipt>;
}

export interface OsWriteCommandBoundaryResult {
  request: OsWriteCommandRequest;
  receipt: OsWriteCommandReceipt;
  artifact: StoredObject;
  created: boolean;
}

export interface AiVerseOsWriteCommandOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  execFileImpl?: typeof execFile;
}

export class OsWriteCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OsWriteCommandError";
  }
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = stableValue((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestValue(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedString(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim()) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", `${label} must be a non-empty string`);
  const text = value.trim();
  if (text.length > max || text.includes("\0") || /[\r\n]/.test(label === "reason" ? "" : text)) {
    throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", `${label} is invalid or oversized`);
  }
  return text;
}

function validateJson(value: unknown, label: string, depth = 0, state = { keys: 0 }): void {
  if (depth > 8) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", `${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", `${label} contains a non-finite number`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 16_384 || value.includes("\0")) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", `${label} contains an invalid or oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", `${label} exceeds 256 array items`);
    value.forEach((item, index) => validateJson(item, `${label}[${index}]`, depth + 1, state));
    return;
  }
  if (typeof value !== "object" || value === null) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", `${label} contains an unsupported value`);
  const keys = Object.keys(value as Record<string, unknown>);
  state.keys += keys.length;
  if (state.keys > 256) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", `${label} exceeds 256 total object keys`);
  for (const key of keys) {
    if (!key || key.length > 256 || key.includes("\0")) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", `${label} contains an invalid object key`);
    validateJson((value as Record<string, unknown>)[key], `${label}.${key}`, depth + 1, state);
  }
}

function safeContainedRegularFile(root: string, relativePath: string, label: string): string {
  const rootReal = realpathSync(root);
  let current = rootReal;
  for (const segment of relativePath.split("/")) {
    current = resolve(current, segment);
    if (!existsSync(current)) throw new OsWriteCommandError("OS_WRITE_UNAVAILABLE", `${label} is missing: ${relativePath}`);
    if (lstatSync(current).isSymbolicLink()) throw new OsWriteCommandError("OS_WRITE_UNSAFE", `${label} traverses a symlink: ${relativePath}`);
  }
  const real = realpathSync(current);
  const rel = real === rootReal ? "" : real.startsWith(`${rootReal}${sep}`) ? real.slice(rootReal.length + 1) : null;
  if (rel === null || !lstatSync(real).isFile()) throw new OsWriteCommandError("OS_WRITE_UNSAFE", `${label} is not a safe regular file inside the OS root`);
  return real;
}

const BRIDGE = String.raw`
import { pathToFileURL } from "node:url";
const modulePath = process.argv[1];
const osRoot = process.argv[2];
const request = JSON.parse(process.argv[3]);
const mod = await import(pathToFileURL(modulePath).href);
if (typeof mod.enqueueWriteCommand !== "function") throw new Error("OS write-command module does not export enqueueWriteCommand");
const result = mod.enqueueWriteCommand({ osRoot, request });
process.stdout.write(JSON.stringify(result));
`;

function runExecFile(
  execFileImpl: typeof execFile,
  args: string[],
  root: string,
  timeoutMs: number,
  maxBufferBytes: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFileImpl(
      process.execPath,
      args,
      { cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: maxBufferBytes },
      (error: any, stdout: string, stderr: string) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          rejectPromise(error);
          return;
        }
        resolvePromise({ stdout, stderr });
      }
    );
  });
}

export class AiVerseOsWriteCommandSink implements OsWriteCommandSink {
  readonly root: string;
  readonly commandPath: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly execFileImpl: typeof execFile;

  constructor(rootInput: string, options: AiVerseOsWriteCommandOptions = {}) {
    this.root = resolve(rootInput);
    const compatibility = detectAiVerseOsCompatibility(this.root);
    if (compatibility.status !== "compatible") {
      throw new OsWriteCommandError("OS_WRITE_UNAVAILABLE", `OS write-command boundary requires a compatible AI-Verse OS host: ${compatibility.reason}`);
    }
    this.commandPath = safeContainedRegularFile(this.root, AI_VERSE_OS_WRITE_COMMAND_PATH, "AI-Verse OS write-command module");
    this.timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs ?? AI_VERSE_OS_WRITE_COMMAND_DEFAULT_TIMEOUT_MS)));
    this.maxBufferBytes = Math.max(16_384, Math.min(512 * 1024, Math.floor(options.maxBufferBytes ?? AI_VERSE_OS_WRITE_COMMAND_MAX_BYTES)));
    this.execFileImpl = options.execFileImpl ?? execFile;
  }

  async enqueue(request: OsWriteCommandRequest): Promise<OsWriteCommandReceipt> {
    const compatibility = detectAiVerseOsCompatibility(this.root);
    if (compatibility.status !== "compatible") {
      throw new OsWriteCommandError("OS_WRITE_UNAVAILABLE", `AI-Verse OS compatibility changed: ${compatibility.reason}`);
    }
    safeContainedRegularFile(this.root, AI_VERSE_OS_WRITE_COMMAND_PATH, "AI-Verse OS write-command module");
    let stdout = "";
    try {
      ({ stdout } = await runExecFile(
        this.execFileImpl,
        ["--input-type=module", "--eval", BRIDGE, this.commandPath, this.root, JSON.stringify(request)],
        this.root,
        this.timeoutMs,
        this.maxBufferBytes
      ));
    } catch (error) {
      const stderr = String((error as any)?.stderr ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
      const timedOut = (error as any)?.killed === true || (error as any)?.signal === "SIGTERM";
      throw new OsWriteCommandError(
        timedOut ? "OS_WRITE_TIMEOUT" : "OS_WRITE_REJECTED",
        stderr || (error instanceof Error ? error.message : String(error))
      );
    }
    if (byteLength(stdout) > this.maxBufferBytes) throw new OsWriteCommandError("OS_WRITE_INVALID_RECEIPT", "OS write-command receipt exceeded the configured output bound");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new OsWriteCommandError("OS_WRITE_INVALID_RECEIPT", "OS write-command boundary returned malformed JSON");
    }
    return validateReceipt(parsed, request);
  }
}

export function computeOsWriteCommandFingerprint(request: JsonObject): string {
  return digestValue(request);
}

export function validateReceipt(value: unknown, request: OsWriteCommandRequest): OsWriteCommandReceipt {
  const receipt = asObject(value);
  if (receipt.schema_version !== AI_VERSE_OS_WRITE_COMMAND_SCHEMA
    || receipt.provider !== AI_VERSE_OS_WRITE_COMMAND_PROVIDER
    || receipt.status !== "queued"
    || receipt.request_id !== request.request_id
    || receipt.request_fingerprint !== request.request_fingerprint
    || receipt.idempotency_key !== request.idempotency_key
    || receipt.scope !== request.scope
    || receipt.operation !== request.operation
    || receipt.requested_by !== request.requested_by
    || receipt.effect_occurred !== false
    || receipt.canonical_effect_occurred !== false
    || typeof receipt.command_id !== "string"
    || !receipt.command_id.startsWith("os_write_")
    || typeof receipt.queued_at !== "string"
    || !Number.isFinite(Date.parse(receipt.queued_at))
    || typeof receipt.replayed !== "boolean") {
    throw new OsWriteCommandError("OS_WRITE_INVALID_RECEIPT", "OS write-command receipt is not bound to the exact request");
  }
  const permission = asObject(receipt.host_permission);
  if (permission.decision !== "allow"
    || permission.request_fingerprint !== request.request_fingerprint
    || permission.scope !== request.scope
    || permission.action_class !== "write_local_reversible"
    || typeof permission.source !== "string") {
    throw new OsWriteCommandError("OS_WRITE_INVALID_RECEIPT", "OS write-command receipt has an invalid permission binding");
  }
  const result = asObject(receipt.result);
  if (result.queue_state !== "pending_handler" || result.canonical_handler_dispatched !== false) {
    throw new OsWriteCommandError("OS_WRITE_INVALID_RECEIPT", "OS write-command receipt falsely claims canonical dispatch");
  }
  return receipt as OsWriteCommandReceipt;
}

export class OsWriteCommandBoundary {
  constructor(
    readonly store: CoordinationStore,
    readonly gateway: CoordinationGateway,
    readonly sink: OsWriteCommandSink
  ) {}

  async request(input: OsWriteCommandInput): Promise<OsWriteCommandBoundaryResult> {
    const principal = this.requirePrincipal(input.requestedBy, input.scope);
    const scope = boundedString(input.scope, "scope", 256);
    if (!SCOPE.test(scope)) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", "scope must be operator or workspace:<id>");
    const operation = boundedString(input.operation, "operation", 128);
    if (!OPERATION.test(operation)) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", "operation is invalid");
    const idempotencyKey = boundedString(input.idempotencyKey, "idempotencyKey", 256);
    if (!BOUNDED_ID.test(idempotencyKey)) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", "idempotencyKey is invalid");
    const reason = boundedString(input.reason, "reason", 4096);
    const createdAt = boundedString(input.createdAt, "createdAt", 128);
    if (!Number.isFinite(Date.parse(createdAt))) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", "createdAt must be a valid timestamp");
    if (!input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters)) {
      throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", "parameters must be an object");
    }
    validateJson(input.parameters, "parameters");
    const provenance = this.provenance(principal, scope, input.provenance);
    const identityDigest = digestValue({ requested_by: principal.id, scope, idempotency_key: idempotencyKey });
    const base: JsonObject = {
      schema_version: "1.0",
      request_id: `mb_write_${identityDigest.slice(0, 32)}`,
      scope,
      operation,
      parameters: stableValue(input.parameters) as JsonObject,
      idempotency_key: idempotencyKey,
      requested_by: `multiple-bots:${principal.id}`,
      reason,
      created_at: createdAt,
      provenance
    };
    const request = {
      ...base,
      request_fingerprint: computeOsWriteCommandFingerprint(base)
    } as OsWriteCommandRequest;
    const artifactId = `artifact_os_write_${identityDigest.slice(0, 32)}`;
    const existing = this.store.getObject(artifactId);
    if (existing) {
      this.assertExisting(existing, request);
      const replayReceipt = await this.sink.enqueue(request);
      return this.existing(existing, request, replayReceipt);
    }

    const receipt = await this.sink.enqueue(request);
    const parameterDigest = digestValue(request.parameters);
    const timestamp = new Date().toISOString();
    const payload = validateProtocolObject({
      schema_version: "1.0",
      id: artifactId,
      type: "artifact",
      workspace_id: scope.startsWith("workspace:") ? scope.slice("workspace:".length) : "operator",
      created_by: principal.id,
      kind: "os_write_command_receipt",
      request_id: request.request_id,
      request_fingerprint: request.request_fingerprint,
      request_contract_digest: digestValue({
        scope: request.scope,
        operation: request.operation,
        idempotency_key: request.idempotency_key,
        requested_by: request.requested_by,
        created_at: request.created_at,
        parameter_digest: parameterDigest,
        provenance: request.provenance
      }),
      scope: request.scope,
      operation: request.operation,
      idempotency_key: request.idempotency_key,
      parameter_digest: parameterDigest,
      command_id: receipt.command_id,
      os_provider: receipt.provider,
      os_status: receipt.status,
      os_queued_at: receipt.queued_at,
      os_replayed: receipt.replayed,
      canonical_effect_occurred: false,
      provenance: {
        type: "os_write_command",
        provider: receipt.provider,
        source_principal: principal.id,
        source_task_id: provenance.task_id ?? null,
        source_run_id: provenance.run_id ?? null,
        source_artifact_refs: provenance.artifact_refs ?? [],
        request_fingerprint: request.request_fingerprint
      },
      created_at: timestamp
    }, "artifact");
    try {
      this.store.atomicMutation({
        preconditions: principal.kind === "bot"
          ? [{ id: principal.id, kind: "bot", status: "active" }]
          : [{ id: principal.id, kind: "worker", status: String(principal.payload.status) }],
        objects: [{ kind: "artifact", payload }],
        events: [{
          schema_version: "1.0",
          id: `evt_os_write_${identityDigest.slice(0, 32)}`,
          type: "os.write_command_queued",
          timestamp,
          actor_id: principal.id,
          workspace_id: scope.startsWith("workspace:") ? scope.slice("workspace:".length) : null,
          task_id: typeof provenance.task_id === "string" ? provenance.task_id : null,
          run_id: typeof provenance.run_id === "string" ? provenance.run_id : null,
          correlation_id: request.request_id,
          summary: `Queued OS write command ${request.operation} through the owner-controlled boundary`
        }]
      });
    } catch (error) {
      const raced = this.store.getObject(artifactId);
      if (!raced) throw error;
      return this.existing(raced, request, receipt);
    }
    const artifact = this.store.getObject(artifactId);
    if (!artifact) throw new OsWriteCommandError("OS_WRITE_PERSISTENCE_FAILED", "OS write-command receipt artifact was not persisted");
    return { request, receipt, artifact, created: true };
  }

  private assertExisting(artifact: StoredObject, request: OsWriteCommandRequest): void {
    if (artifact.kind !== "artifact" || artifact.payload.kind !== "os_write_command_receipt") {
      throw new OsWriteCommandError("OS_WRITE_CONFLICT", `${artifact.id} already exists with another meaning`);
    }
    if (artifact.payload.request_fingerprint !== request.request_fingerprint
      || artifact.payload.scope !== request.scope
      || artifact.payload.operation !== request.operation
      || artifact.payload.idempotency_key !== request.idempotency_key) {
      throw new OsWriteCommandError("OS_WRITE_CONFLICT", "idempotency identity is already bound to a different OS write command");
    }
  }

  private existing(artifact: StoredObject, request: OsWriteCommandRequest, receipt: OsWriteCommandReceipt): OsWriteCommandBoundaryResult {
    this.assertExisting(artifact, request);
    return { request, receipt, artifact, created: false };
  }

  private requirePrincipal(idInput: string, scopeInput: string): StoredObject {
    const id = boundedString(idInput, "requestedBy", 256);
    const scope = boundedString(scopeInput, "scope", 256);
    const principal = this.store.getObject(id);
    if (!principal || (principal.kind !== "bot" && principal.kind !== "worker")) {
      throw new OsWriteCommandError("OS_WRITE_PRINCIPAL_DENIED", "requestedBy must be a registered durable Bot or temporary Worker");
    }
    if (principal.kind === "bot") {
      if (principal.payload.status !== "active") throw new OsWriteCommandError("OS_WRITE_PRINCIPAL_DENIED", `Bot ${id} is not active`);
      const botScope = asObject(principal.payload.scope);
      if (scope === "operator") {
        if (botScope.type !== "operator") throw new OsWriteCommandError("OS_WRITE_SCOPE_DENIED", `Bot ${id} is not operator-scoped`);
      } else {
        const workspaceId = scope.slice("workspace:".length);
        if (botScope.type !== "workspace" || botScope.workspace_id !== workspaceId || principal.workspaceId !== workspaceId) {
          throw new OsWriteCommandError("OS_WRITE_SCOPE_DENIED", `Bot ${id} is outside ${scope}`);
        }
      }
      return principal;
    }
    if (scope === "operator") throw new OsWriteCommandError("OS_WRITE_SCOPE_DENIED", "temporary Workers cannot request operator-scoped writes");
    const workspaceId = scope.slice("workspace:".length);
    if (principal.workspaceId !== workspaceId || !ACTIVE_WORKER_STATES.has(String(principal.payload.status))) {
      throw new OsWriteCommandError("OS_WRITE_SCOPE_DENIED", `Worker ${id} is not active in ${scope}`);
    }
    return principal;
  }

  private provenance(principal: StoredObject, scope: string, input?: OsWriteCommandProvenanceInput): JsonObject {
    const workspaceId = scope.startsWith("workspace:") ? scope.slice("workspace:".length) : null;
    const artifactRefs = [...new Set((input?.artifactRefs ?? []).map(String).map((value) => value.trim()).filter(Boolean))].sort();
    if (artifactRefs.length > 32) throw new OsWriteCommandError("OS_WRITE_INVALID_INPUT", "artifactRefs exceeds 32 items");
    const out: JsonObject = {
      source: "ai-verse-multiple-bots",
      principal_id: principal.id,
      principal_kind: principal.kind,
      scope,
      task_id: input?.taskId ?? null,
      run_id: input?.runId ?? null,
      artifact_refs: artifactRefs
    };
    if (input?.taskId) this.assertScopedRef(input.taskId, "task", workspaceId);
    if (input?.runId) this.assertScopedRef(input.runId, "team_run", workspaceId);
    for (const artifactRef of artifactRefs) this.assertScopedRef(artifactRef, "artifact", workspaceId);
    return out;
  }

  private assertScopedRef(id: string, kind: "task" | "team_run" | "artifact", workspaceId: string | null): void {
    const object = this.store.getObject(id);
    if (!object || object.kind !== kind) throw new OsWriteCommandError("OS_WRITE_PROVENANCE_INVALID", `${kind} provenance ref ${id} not found`);
    if (workspaceId !== null && object.workspaceId !== workspaceId) {
      throw new OsWriteCommandError("OS_WRITE_PROVENANCE_INVALID", `${kind} provenance ref ${id} escaped workspace ${workspaceId}`);
    }
    if (workspaceId === null && object.workspaceId !== null) {
      throw new OsWriteCommandError("OS_WRITE_PROVENANCE_INVALID", `${kind} provenance ref ${id} is not operator-scoped`);
    }
  }
}
