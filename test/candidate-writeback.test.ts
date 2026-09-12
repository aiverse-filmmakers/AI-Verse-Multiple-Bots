import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";
import {
  CandidateWritebackError,
  CandidateWritebackRouter
} from "../src/candidate-writeback.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import {
  AI_VERSE_OS_WRITE_COMMAND_PROVIDER,
  OsWriteCommandBoundary,
  OsWriteCommandError,
  type OsWriteCommandReceipt,
  type OsWriteCommandRequest,
  type OsWriteCommandSink
} from "../src/os-write-command.js";
import { CoordinationPolicy } from "../src/policy.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest, JsonObject } from "../src/types.js";

const WORKSPACE = "ws-alpha";

function bot(id = "bot_writer"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: "Writer", mission: "Nominate bounded owner-routed write-back candidates." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: WORKSPACE },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

class RecordingSink implements OsWriteCommandSink {
  calls: OsWriteCommandRequest[] = [];

  async enqueue(request: OsWriteCommandRequest): Promise<OsWriteCommandReceipt> {
    this.calls.push(request);
    return {
      schema_version: "1.0",
      provider: AI_VERSE_OS_WRITE_COMMAND_PROVIDER,
      status: "queued",
      command_id: `os_write_${request.request_fingerprint.slice(0, 32)}`,
      request_id: request.request_id,
      request_fingerprint: request.request_fingerprint,
      idempotency_key: request.idempotency_key,
      scope: request.scope,
      operation: request.operation,
      requested_by: request.requested_by,
      queued_at: "2026-09-12T17:00:01Z",
      host_permission: {
        decision: "allow",
        source: "test",
        reason: "owner queue accepted candidate",
        request_fingerprint: request.request_fingerprint,
        scope: request.scope,
        action_class: "write_local_reversible"
      },
      effect_occurred: false,
      canonical_effect_occurred: false,
      result: { queue_state: "pending_handler", canonical_handler_dispatched: false },
      replayed: this.calls.length > 1
    };
  }
}

function artifact(id: string, workspaceId = WORKSPACE, kind = "synthesis_final"): JsonObject {
  return {
    schema_version: "1.0",
    id,
    type: "artifact",
    workspace_id: workspaceId,
    created_by: "bot_writer",
    kind,
    version: 1,
    inline_content: { result: "source result" },
    provenance: { origin: "bot_generated", trusted_instruction: false }
  };
}

function harness() {
  const dbPath = `/tmp/multiple-bots-candidate-writeback-${randomUUID()}.db`;
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  gateway.createBot(bot());
  gateway.record("artifact", artifact("artifact_source"));
  gateway.record("artifact", artifact("artifact_evidence", WORKSPACE, "verification_verdict"));
  const sink = new RecordingSink();
  const writes = new OsWriteCommandBoundary(store, gateway, sink);
  const router = new CandidateWritebackRouter(gateway, writes);
  return { dbPath, store, queue, gateway, sink, writes, router };
}

function close(env: ReturnType<typeof harness>): void {
  env.queue.close();
  env.store.close();
  rmSync(env.dbPath, { force: true });
  rmSync(`${env.dbPath}-shm`, { force: true });
  rmSync(`${env.dbPath}-wal`, { force: true });
}

function input(overrides: Partial<Parameters<CandidateWritebackRouter["route"]>[0]> = {}) {
  return {
    requestedBy: "bot_writer",
    workspaceId: WORKSPACE,
    candidateKind: "knowledge" as const,
    sourceArtifactRef: "artifact_source",
    title: "Validated operating observation",
    summary: "A bounded reusable observation from verified coordination output.",
    content: {
      statement: "CANDIDATE_SECRET_CONTENT",
      applicability: "workspace"
    },
    confidence: 0.91,
    evidenceArtifactRefs: ["artifact_evidence"],
    idempotencyKey: "candidate-001",
    reason: "Nominate verified output for OS owner evaluation",
    createdAt: "2026-09-12T17:00:00Z",
    ...overrides
  };
}

test("knowledge candidate routes through the existing OS owner boundary without claiming canonical promotion", async () => {
  const env = harness();
  try {
    const result = await env.router.route(input());
    assert.equal(result.created, true);
    assert.equal(result.candidateKind, "knowledge");
    assert.match(result.candidateDigest, /^[a-f0-9]{64}$/);
    assert.equal(env.sink.calls.length, 1);

    const request = env.sink.calls[0]!;
    assert.equal(request.operation, "candidate.route");
    assert.equal(request.scope, `workspace:${WORKSPACE}`);
    assert.equal(request.parameters.candidate_kind, "knowledge");
    assert.equal(request.parameters.owner_action, "evaluate_for_promotion");
    assert.equal(request.parameters.canonical_effect_requested, false);
    assert.equal(request.parameters.source_artifact_ref, "artifact_source");
    assert.deepEqual(request.parameters.evidence_artifact_refs, ["artifact_evidence"]);
    assert.equal(request.parameters.candidate_digest, result.candidateDigest);

    assert.equal(result.route.receipt.canonical_effect_occurred, false);
    assert.equal(result.route.artifact.payload.kind, "os_write_command_receipt");
    assert.equal(JSON.stringify(result.route.artifact.payload).includes("CANDIDATE_SECRET_CONTENT"), false);
    assert.equal(result.route.artifact.payload.operation, "candidate.route");

    const events = env.store.listEventsAfter(0, 100).map((entry) => entry.event.type);
    assert.equal(events.includes("candidate.writeback_queued"), true);
  } finally {
    close(env);
  }
});

test("decision candidate uses the same bounded owner route and remains a candidate", async () => {
  const env = harness();
  try {
    const result = await env.router.route(input({
      candidateKind: "decision",
      idempotencyKey: "decision-001",
      title: "Proposed delivery decision",
      summary: "Verified evidence supports choosing option B.",
      content: { decision: "Choose option B", rationale: "Best verified constraint fit" }
    }));
    assert.equal(result.candidateKind, "decision");
    assert.equal(env.sink.calls[0]!.parameters.candidate_kind, "decision");
    assert.equal(env.sink.calls[0]!.parameters.canonical_effect_requested, false);
    assert.equal(result.route.receipt.effect_occurred, false);
  } finally {
    close(env);
  }
});

test("exact replay is idempotent and semantic drift is rejected before another host dispatch", async () => {
  const env = harness();
  try {
    const first = await env.router.route(input());
    const second = await env.router.route(input());
    assert.equal(first.route.artifact.id, second.route.artifact.id);
    assert.equal(second.created, false);
    assert.equal(env.sink.calls.length, 2);

    await assert.rejects(
      () => env.router.route(input({ content: { statement: "changed candidate" } })),
      (error: unknown) => error instanceof OsWriteCommandError && error.code === "OS_WRITE_CONFLICT"
    );
    assert.equal(env.sink.calls.length, 2);
  } finally {
    close(env);
  }
});

test("candidate source and evidence cannot escape workspace scope", async () => {
  const env = harness();
  try {
    env.gateway.record("artifact", artifact("artifact_foreign", "other"));
    await assert.rejects(
      () => env.router.route(input({ sourceArtifactRef: "artifact_foreign", idempotencyKey: "foreign-source" })),
      (error: unknown) => error instanceof CandidateWritebackError && error.code === "CANDIDATE_SCOPE_DENIED"
    );
    await assert.rejects(
      () => env.router.route(input({ evidenceArtifactRefs: ["artifact_foreign"], idempotencyKey: "foreign-evidence" })),
      (error: unknown) => error instanceof CandidateWritebackError && error.code === "CANDIDATE_SCOPE_DENIED"
    );
    assert.equal(env.sink.calls.length, 0);
  } finally {
    close(env);
  }
});

test("candidate validation fails closed before OS dispatch", async () => {
  const env = harness();
  try {
    await assert.rejects(
      () => env.router.route(input({ candidateKind: "memory" as any, idempotencyKey: "bad-kind" })),
      (error: unknown) => error instanceof CandidateWritebackError && error.code === "CANDIDATE_INVALID_KIND"
    );
    await assert.rejects(
      () => env.router.route(input({ confidence: 1.5, idempotencyKey: "bad-confidence" })),
      (error: unknown) => error instanceof CandidateWritebackError && error.code === "CANDIDATE_INVALID_INPUT"
    );
    await assert.rejects(
      () => env.router.route(input({ content: {}, idempotencyKey: "empty-content" })),
      (error: unknown) => error instanceof CandidateWritebackError && error.code === "CANDIDATE_INVALID_INPUT"
    );
    assert.equal(env.sink.calls.length, 0);
  } finally {
    close(env);
  }
});

test("temporary Workers may nominate workspace candidates but receive no canonical write authority", async () => {
  const env = harness();
  try {
    env.gateway.record("worker", {
      schema_version: "1.0",
      id: "worker_candidate",
      type: "worker",
      kind: "temporary",
      run_id: "run_candidate",
      created_by: "bot_writer",
      workspace_id: WORKSPACE,
      role: { title: "Researcher", objective: "Produce bounded candidate evidence" },
      status: "ready"
    });
    const result = await env.router.route(input({
      requestedBy: "worker_candidate",
      idempotencyKey: "worker-candidate"
    }));
    assert.equal(result.route.request.requested_by, "multiple-bots:worker_candidate");
    assert.equal(result.route.receipt.canonical_effect_occurred, false);
  } finally {
    close(env);
  }
});
