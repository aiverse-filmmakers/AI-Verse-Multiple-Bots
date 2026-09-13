import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { A2AJsonRpcRuntimeAdapter } from "../src/a2a-runtime.js";
import { ClaudeCodePrintRuntimeAdapter } from "../src/claude-code-runtime.js";
import { CodexExecRuntimeAdapter } from "../src/codex-runtime.js";
import {
  ExternalManagedBotProviderRegistry,
  ExternalManagedBotRuntimeAdapter
} from "../src/external-managed-runtime.js";
import { HermesStdioRuntimeAdapter } from "../src/hermes-runtime.js";
import { OpenAICompatibleRuntimeAdapter } from "../src/openai-compatible-runtime.js";
import { OpenClawAgentExecRuntimeAdapter } from "../src/openclaw-runtime.js";
import {
  DeterministicRuntimeAdapter,
  type RuntimeAdapter,
  type RuntimeExecutionContext
} from "../src/runtime.js";
import type { JsonObject, StoredObject } from "../src/types.js";

interface CompatibilityAdapter {
  id: string;
  class: string;
  kind: string;
  durable_bot: boolean;
  temporary_worker: boolean;
  authority_mode: string;
  remote_recovery: string;
  evidence: string[];
  markers?: string[];
}

interface CompatibilityMatrix {
  suite_version: string;
  phase: string;
  title: string;
  goal: string;
  required_invariants: string[];
  adapters: CompatibilityAdapter[];
}

const root = process.cwd();
const matrixPath = resolve(root, "evals/phase-4-runtime-compatibility.json");
const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as CompatibilityMatrix;

function stored(id: string, kind: any, workspaceId: string, payload: JsonObject): StoredObject {
  return {
    id,
    kind,
    workspaceId,
    status: typeof payload.status === "string" ? payload.status : null,
    payload,
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:00Z"
  };
}

function baselineContext(principalKind: "bot" | "worker"): RuntimeExecutionContext {
  const runtime: JsonObject = { adapter: "deterministic" };
  const principal = principalKind === "bot"
    ? stored("bot_eval", "bot", "ws-eval", {
        id: "bot_eval",
        kind: "durable",
        status: "active",
        runtime
      })
    : stored("worker_eval", "worker", "ws-eval", {
        id: "worker_eval",
        kind: "temporary",
        run_id: "run_eval",
        status: "ready",
        runtime
      });
  return {
    principal,
    principalKind,
    ...(principalKind === "bot" ? { bot: principal as any } : {}),
    runtime,
    task: stored("task_eval", "task", "ws-eval", {
      id: "task_eval",
      type: "task.delegate",
      objective: "Prove the portable runtime result contract.",
      required_constraints: ["Preserve identity and authority"],
      assignee_id: principal.id,
      owner_id: principal.id,
      lease_id: "lease_eval",
      status: "running",
      ...(principalKind === "worker" ? { run_id: "run_eval" } : {})
    }),
    capabilityLease: stored("lease_eval", "capability_lease", "ws-eval", {
      id: "lease_eval",
      principal: principal.id,
      issued_to: principal.id,
      task_id: "task_eval",
      tools: [],
      connections: [],
      destructive_actions: "deny",
      expires_at: "2030-01-01T00:00:00Z"
    }),
    environmentLease: null,
    inputArtifacts: [],
    workspaceProjection: null,
    strategicIntent: null,
    historicalRecall: null,
    skillsCapabilityResolution: null,
    signal: new AbortController().signal
  };
}

function adapters(): RuntimeAdapter[] {
  return [
    new DeterministicRuntimeAdapter(),
    new OpenAICompatibleRuntimeAdapter(),
    new A2AJsonRpcRuntimeAdapter(),
    new HermesStdioRuntimeAdapter(),
    new OpenClawAgentExecRuntimeAdapter(),
    new CodexExecRuntimeAdapter(),
    new ClaudeCodePrintRuntimeAdapter(),
    new ExternalManagedBotRuntimeAdapter(new ExternalManagedBotProviderRegistry())
  ];
}

test("Phase 4.9 compatibility matrix covers every Gateway runtime registration exactly once", () => {
  assert.equal(matrix.phase, "4.9");
  assert.equal(matrix.suite_version, "1.0");
  assert.equal(new Set(matrix.adapters.map((entry) => entry.id)).size, matrix.adapters.length);
  assert.equal(new Set(matrix.adapters.map((entry) => entry.class)).size, matrix.adapters.length);

  const serverSource = readFileSync(resolve(root, "src/server.ts"), "utf8");
  const registeredClasses = [...serverSource.matchAll(/\.register\(new ([A-Za-z0-9_]+)/g)]
    .map((match) => match[1]!)
    .sort();
  const matrixClasses = matrix.adapters.map((entry) => entry.class).sort();

  assert.deepEqual(registeredClasses, matrixClasses);
  assert.deepEqual(
    adapters().map((adapter) => adapter.id).sort(),
    matrix.adapters.map((entry) => entry.id).sort()
  );
});

test("Phase 4.9 evidence map is executable, local, and traceable to deterministic tests", () => {
  for (const entry of matrix.adapters) {
    assert.ok(entry.evidence.length > 0, `${entry.id} must have evaluation evidence`);
    for (const relative of entry.evidence) {
      assert.match(relative, /^test\/[a-z0-9.-]+\.test\.ts$/);
      const path = resolve(root, relative);
      assert.equal(existsSync(path), true, `${entry.id} evidence file is missing: ${relative}`);
      const source = readFileSync(path, "utf8");
      assert.match(source, /test\("/, `${relative} contains no node:test cases`);
      for (const marker of entry.markers ?? []) {
        assert.equal(
          source.includes(marker),
          true,
          `${entry.id} evidence marker is missing from ${relative}: ${marker}`
        );
      }
    }
  }
});

test("Phase 4.9 matrix makes runtime exceptions explicit instead of pretending all adapters are identical", () => {
  const byId = new Map(matrix.adapters.map((entry) => [entry.id, entry]));
  for (const entry of matrix.adapters) {
    assert.equal(entry.durable_bot, true, `${entry.id} must support durable Bot execution`);
    assert.ok(entry.authority_mode.length > 0, `${entry.id} must declare an authority mode`);
    assert.ok(entry.remote_recovery.length > 0, `${entry.id} must declare a recovery mode`);
  }

  assert.equal(byId.get("external-managed")?.temporary_worker, false);
  for (const entry of matrix.adapters.filter((item) => item.id !== "external-managed")) {
    assert.equal(entry.temporary_worker, true, `${entry.id} should preserve temporary Worker identity`);
  }

  const recoveryAware = matrix.adapters
    .filter((entry) => entry.remote_recovery !== "none")
    .map((entry) => entry.id)
    .sort();
  assert.deepEqual(recoveryAware, ["a2a", "external-managed"]);
});

test("Phase 4.9 required invariants remain the Phase 4 portability contract", () => {
  assert.deepEqual(matrix.required_invariants, [
    "registered",
    "durable_bot_identity",
    "temporary_worker_identity_or_explicit_rejection",
    "authority_fail_closed",
    "failure_not_success",
    "local_cancellation_authoritative",
    "bounded_provenance",
    "recovery_mode_explicit"
  ]);
});

test("deterministic reference runtime proves the shared result contract for durable Bots and temporary Workers", async () => {
  const adapter = new DeterministicRuntimeAdapter();
  for (const principalKind of ["bot", "worker"] as const) {
    const context = baselineContext(principalKind);
    const result = await adapter.execute(context);
    assert.equal(result.output.executed_by, context.principal.id);
    assert.equal(result.output.execution_principal_kind, principalKind);
    assert.equal(result.output.runtime_adapter, "deterministic");
    assert.equal(result.output.lease_id, "lease_eval");
    assert.equal(result.artifactKind, "deterministic_task_result");
    assert.equal(result.usage?.actions, 1);
    assert.equal(result.receipts?.[0]?.adapter, "deterministic");
  }
});
