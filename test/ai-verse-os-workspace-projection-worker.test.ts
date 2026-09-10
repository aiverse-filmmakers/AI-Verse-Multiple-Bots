import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { AiVerseOsWorkspaceProjector, AiVerseOsWorkspaceProjectionError } from "../src/ai-verse-os-workspace-projection.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult, type WorkspaceStateProjection } from "../src/runtime.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunManager } from "../src/team-run-manager.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest } from "../src/types.js";

const WORKSPACE_ID = "ws-projection-worker";

function write(root: string, relative: string, content: string): void {
  const target = resolve(root, ...relative.split("/"));
  const parent = target.slice(0, target.lastIndexOf("/"));
  if (parent) mkdirSync(parent, { recursive: true });
  writeFileSync(target, content, "utf8");
}

function createHost(marker: string): string {
  const root = `/tmp/ai-verse-worker-projection-host-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  write(root, "AI-VERSE.yaml", [
    'schema_version: "2.0"',
    "architecture: unified-workspace",
    "paths:",
    "  workspaces: workspaces/",
    ""
  ].join("\n"));
  write(root, "AGENTS.md", "# Runtime\nLoad .aiverse/extensions/registry.json when present.\n");
  write(root, "system/extensions/README.md", "# Extensions\nRegistry: .aiverse/extensions/registry.json\n");
  write(root, `workspaces/${WORKSPACE_ID}/WORKSPACE.yaml`, [
    'schema_version: "2.0"',
    `id: "${WORKSPACE_ID}"`,
    'name: "Worker Projection Workspace"',
    'type: "project"',
    'status: "active"',
    'purpose: "Prove temporary Worker projection isolation."',
    `current_context: "context/CURRENT.md"`,
    "domains:",
    "  - testing",
    "owners:",
    "  - operator_local",
    "success_criteria:",
    "  - worker receives live scoped projection",
    "canonical_sources:",
    "  - context/CURRENT.md",
    "connections: []",
    ""
  ].join("\n"));
  write(root, `workspaces/${WORKSPACE_ID}/context/CURRENT.md`, [
    "# Current Workspace Context",
    "",
    "Last reviewed: 2026-09-10",
    "",
    "## Objective",
    "",
    `Worker must see ${marker}`,
    "",
    "## Current state",
    "",
    "Temporary Worker execution is ready.",
    "",
    "## Next useful actions",
    "",
    "- execute the bounded Worker task",
    ""
  ].join("\n"));
  return root;
}

function leader(runtimeAdapter: string): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_projection-worker-leader",
    name: "Projection Worker Leader",
    kind: "durable",
    status: "active",
    role: { title: "Projection Lead", mission: "Delegate one bounded Worker task." },
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

class WorkerProjectionCaptureRuntime implements RuntimeAdapter {
  readonly id = "capture-worker-workspace-projection";
  seen: { principalKind: string; principalId: string; projection: WorkspaceStateProjection | null } | null = null;

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    this.seen = {
      principalKind: context.principalKind,
      principalId: context.principal.id,
      projection: context.workspaceProjection ?? null
    };
    return {
      summary: "Temporary Worker consumed scoped workspace projection.",
      artifactKind: "worker_projection_capture",
      output: { principal_id: context.principal.id, principal_kind: context.principalKind },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 }
    };
  }
}

test("temporary Worker receives the same live workspace-scoped projection contract without persisting host text", async () => {
  const marker = `WORKER_ONLY_${randomUUID()}`;
  const root = createHost(marker);
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  const runtime = new WorkerProjectionCaptureRuntime();
  gateway.createBot(leader(runtime.id));
  const teams = new TeamRunCoordinator(store);
  const runner = new BotRunner(
    store,
    gateway,
    queue,
    new RuntimeRegistry().register(runtime),
    {
      runnerId: `runner_${randomUUID()}`,
      executionLeaseSeconds: 2,
      heartbeatIntervalMs: 100,
      workspaceProjector: new AiVerseOsWorkspaceProjector(root)
    }
  );
  const manager = new TeamRunManager(teams, gateway, queue, runner);

  try {
    const run = teams.createRun({
      leaderId: "bot_projection-worker-leader",
      workspaceId: WORKSPACE_ID,
      rootObjectiveId: `obj_${randomUUID()}`,
      objective: "Delegate current workspace analysis to one temporary Worker.",
      topology: "manager",
      budget: { max_workers: 1, max_tasks: 2, max_actions: 2, token_limit: 1000 }
    }).run;
    const managed = manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_projection-worker-leader",
      workerId: "worker_projection-capture",
      roleTitle: "Projection Specialist",
      objective: "Use the current workspace state to produce one bounded result.",
      reason: "Explicit Worker projection acceptance proof."
    });

    const result = await runner.runNext(managed.worker.id);
    assert.equal(result?.status, "completed");
    assert.equal(runtime.seen?.principalKind, "worker");
    assert.equal(runtime.seen?.principalId, managed.worker.id);
    assert.equal(runtime.seen?.projection?.workspace_id, WORKSPACE_ID);
    assert.match(String((runtime.seen?.projection?.data.current_context as any)?.objective), new RegExp(marker));

    const task = store.getObject(managed.task.id);
    const artifactId = (task?.payload.output_artifact_refs as string[])[0] as string;
    const artifact = store.getObject(artifactId);
    assert.ok(artifact);
    const projectionReceipt = (artifact?.payload.runtime_receipts as any[]).find((receipt) => receipt.kind === "workspace_state_projection");
    assert.equal(projectionReceipt?.workspace_id, WORKSPACE_ID);
    assert.match(String(projectionReceipt?.projection_digest), /^[a-f0-9]{64}$/);
    assert.equal(Object.prototype.hasOwnProperty.call(projectionReceipt, "data"), false);

    const persisted = JSON.stringify({
      workers: store.listObjects("worker", WORKSPACE_ID),
      tasks: store.listObjects("task", WORKSPACE_ID),
      artifacts: store.listObjects("artifact", WORKSPACE_ID),
      events: store.listEventsAfter(0, 500)
    });
    assert.equal(persisted.includes(marker), false);
    assert.equal(persisted.includes("Temporary Worker execution is ready."), false);
  } finally {
    queue.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid explicit AI-Verse OS root fails before the gateway can become usable", () => {
  const root = `/tmp/ai-verse-invalid-host-${randomUUID()}`;
  const dbPath = `/tmp/ai-verse-invalid-host-${randomUUID()}.db`;
  try {
    assert.throws(
      () => createGatewayServer({ aiVerseOsRoot: root, dbPath }),
      (error: unknown) => error instanceof AiVerseOsWorkspaceProjectionError && error.code === "INCOMPATIBLE_AI_VERSE_OS"
    );
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dbPath, { force: true });
  }
});
