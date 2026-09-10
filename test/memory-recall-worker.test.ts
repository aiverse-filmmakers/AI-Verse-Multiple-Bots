import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { MemoryRecallRuntimeRegistry } from "../src/memory-recall-runtime.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import {
  RuntimeRegistry,
  type HistoricalRecallProjection,
  type HistoricalRecallSource,
  type RuntimeAdapter,
  type RuntimeExecutionContext,
  type RuntimeExecutionResult
} from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunManager } from "../src/team-run-manager.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest } from "../src/types.js";

const WORKSPACE_ID = "ws-memory-worker";
const RECALL_MARKER = "WORKER_HISTORICAL_RECALL_SECRET";

function leader(runtimeAdapter: string): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_memory-worker-leader",
    name: "Memory Worker Leader",
    kind: "durable",
    status: "active",
    role: { title: "Memory Lead", mission: "Delegate one bounded recall-aware Worker task." },
    runtime: { adapter: runtimeAdapter },
    execution: { environment_policy: "shared_workspace", environment_ref: "host-default" },
    scope: { type: "workspace", workspace_id: WORKSPACE_ID },
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: ["*"],
      can_create_workers: true
    },
    coordination: { default_mode: "direct", max_parallel_workers: 1, max_hops: 2 }
  };
}

class WorkerMemorySource implements HistoricalRecallSource {
  calls: Array<{ workspaceId: string; query: string; limit?: number }> = [];

  async recall(workspaceId: string, request: any): Promise<HistoricalRecallProjection> {
    this.calls.push({ workspaceId, query: request.query, limit: request.limit });
    return {
      schema_version: "1.0",
      provider: "worker-memory-test",
      provider_version: "1.0.0",
      workspace_id: workspaceId,
      query_digest: "worker-query-digest",
      recall_digest: "worker-recall-digest",
      recalled_at: "2026-09-10T12:00:00.000Z",
      include_history: false,
      requested_limit: request.limit ?? 1,
      items: [{
        id: "mem_worker_1",
        kind: "memory",
        type: "experience",
        scope: `workspace:${workspaceId}`,
        content: RECALL_MARKER,
        why: "Worker-only historical evidence.",
        path: `workspaces/${workspaceId}/memory/atomic/2026/09/mem_worker_1.md`,
        digest: "worker-item-digest",
        source_identity: "worker-source-identity",
        source_version: "worker-source-version",
        freshness: "historical"
      }]
    };
  }
}

class WorkerMemoryCaptureRuntime implements RuntimeAdapter {
  readonly id = "capture-worker-memory-recall";
  seen: RuntimeExecutionContext | null = null;

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    this.seen = context;
    return {
      summary: "Temporary Worker consumed bounded historical recall.",
      artifactKind: "worker_memory_capture",
      output: {
        principal_id: context.principal.id,
        principal_kind: context.principalKind,
        recall_digest: context.historicalRecall?.recall_digest ?? null
      },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 }
    };
  }
}

test("temporary Team Run Worker receives the same explicit workspace-scoped Memory recall contract without durable promotion or recalled-text persistence", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  const runtime = new WorkerMemoryCaptureRuntime();
  const source = new WorkerMemorySource();
  gateway.createBot(leader(runtime.id));
  const teams = new TeamRunCoordinator(store);
  const runtimes = new MemoryRecallRuntimeRegistry(new RuntimeRegistry().register(runtime), source);
  const runner = new BotRunner(store, gateway, queue, runtimes, {
    runnerId: `runner_${randomUUID()}`,
    executionLeaseSeconds: 2,
    heartbeatIntervalMs: 100
  });
  const manager = new TeamRunManager(teams, gateway, queue, runner);

  try {
    const run = teams.createRun({
      leaderId: "bot_memory-worker-leader",
      workspaceId: WORKSPACE_ID,
      rootObjectiveId: `obj_${randomUUID()}`,
      objective: "Delegate one bounded historical-recall analysis.",
      topology: "manager",
      budget: { max_workers: 1, max_tasks: 2, max_actions: 2, token_limit: 1000 }
    }).run;
    const managed = manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_memory-worker-leader",
      workerId: "worker_memory-capture",
      roleTitle: "Historical Recall Specialist",
      objective: "Use the relevant prior lesson without widening workspace scope.",
      reason: "Phase 3.4 temporary Worker acceptance proof.",
      memoryRecall: { query: "prior lesson", limit: 1 }
    });

    assert.deepEqual(managed.task.payload.memory_recall, {
      query: "prior lesson",
      limit: 1,
      include_history: false
    });
    const result = await runner.runNext(managed.worker.id);
    assert.equal(result?.status, "completed");
    assert.deepEqual(source.calls, [{ workspaceId: WORKSPACE_ID, query: "prior lesson", limit: 1 }]);
    assert.equal(runtime.seen?.principalKind, "worker");
    assert.equal(runtime.seen?.principal.id, managed.worker.id);
    assert.equal(runtime.seen?.historicalRecall?.items[0]?.content, RECALL_MARKER);

    const worker = store.getObject(managed.worker.id);
    assert.equal(worker?.kind, "worker");
    assert.equal(gateway.getBot(managed.worker.id), null);

    const task = store.getObject(managed.task.id);
    const artifactId = (task?.payload.output_artifact_refs as string[])[0] as string;
    const artifact = store.getObject(artifactId);
    assert.ok(artifact);
    const recallReceipt = (artifact?.payload.runtime_receipts as any[]).find((receipt) => receipt.kind === "historical_memory_recall");
    assert.equal(recallReceipt?.workspace_id, WORKSPACE_ID);
    assert.equal(recallReceipt?.recall_digest, "worker-recall-digest");
    assert.equal(recallReceipt?.result_count, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(recallReceipt ?? {}, "content"), false);

    const persisted = JSON.stringify({
      workers: store.listObjects("worker", WORKSPACE_ID),
      tasks: store.listObjects("task", WORKSPACE_ID),
      artifacts: store.listObjects("artifact", WORKSPACE_ID),
      events: store.listEventsAfter(0, 500)
    });
    assert.equal(persisted.includes(RECALL_MARKER), false);
    assert.equal(persisted.includes("Worker-only historical evidence."), false);
  } finally {
    queue.close();
    store.close();
  }
});
