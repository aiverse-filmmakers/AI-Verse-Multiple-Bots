import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  PERSISTENCE_RELATIONS,
  PERSISTENCE_SCHEMA_VERSION
} from "../src/persistence-schema.js";
import { createCoordinationRepositories } from "../src/repository.js";
import { CoordinationStore } from "../src/store.js";

function dbPath(label: string): string {
  return `/tmp/aiverse-task3-${label}-${Date.now()}-${Math.random()}.db`;
}

function bot(id: string, name: string) {
  return {
    schema_version: "1.0",
    id,
    name,
    kind: "durable",
    status: "active",
    role: { title: name, mission: `Own ${name} work.` },
    runtime: { adapter: "native" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_test" },
    permissions: { policy_ref: "default" },
    coordination: { default_mode: "direct" }
  };
}

test("persistent coordination schema exposes versioned relations and repository views", () => {
  const store = new CoordinationStore(":memory:");
  try {
    assert.equal(store.schemaVersion(), String(PERSISTENCE_SCHEMA_VERSION));
    assert.deepEqual(store.schemaMigrations().map((migration) => migration.version), [1, 2, 3]);
    const relations = new Set(store.schemaRelations());
    for (const relation of PERSISTENCE_RELATIONS) assert.ok(relations.has(relation), `missing relation ${relation}`);
    assert.equal(store.doctor().ok, true);
  } finally {
    store.close();
  }
});

test("all durable coordination object repositories plus events and delivery queue survive restart", () => {
  const path = dbPath("restart");
  const timestamp = new Date().toISOString();

  {
    const store = new CoordinationStore(path);
    const repositories = createCoordinationRepositories(store);
    repositories.bots.put(bot("bot_a", "Research Lead"));
    repositories.workers.put({
      schema_version: "1.0", id: "worker_1", type: "worker", kind: "temporary",
      parent_owner_id: "bot_a", workspace_id: "ws_test", task_id: "task_1", run_id: "run_1"
    });
    repositories.rooms.put({
      schema_version: "1.0", id: "room_1", name: "Ops Room",
      scope: { type: "workspace", workspace_id: "ws_test" }, members: ["bot_a"], orchestration: { mode: "managed" }
    });
    repositories.threads.put({
      schema_version: "1.0", id: "thread_1", type: "thread", workspace_id: "ws_test",
      parent_message_id: "message_1", created_by: "bot_a", status: "open"
    });
    repositories.messages.put({
      schema_version: "1.0", id: "message_1", type: "message.chat", timestamp,
      sender_id: "bot_a", workspace_id: "ws_test", target: { kind: "bot", id: "bot_b" },
      content: [{ type: "text", text: "Persist me" }], provenance: { source: "task3-test" }
    });
    repositories.tasks.put({
      schema_version: "1.0", id: "task_1", type: "task.delegate", created_by: "bot_a",
      assignee_id: "bot_b", owner_id: "bot_a", workspace_id: "ws_test", root_objective_id: "root_1",
      reason: "persistence test", objective: "prove durable state", lease_id: "cap_1", status: "assigned",
      required_constraints: [], expected_output: { kind: "text" }
    });
    repositories.handoffs.put({
      schema_version: "1.0", id: "handoff_1", type: "handoff", source_owner_id: "bot_a",
      target_bot_id: "bot_b", workspace_id: "ws_test", task_id: "task_1", root_objective_id: "root_1",
      reason: "persistence test", return_policy: "stay_with_target", status: "requested", required_constraints: []
    });
    repositories.teamRuns.put({
      schema_version: "1.0", id: "run_1", type: "team_run", workspace_id: "ws_test",
      root_objective_id: "root_1", topology: "manager", status: "running"
    });
    repositories.artifacts.put({
      schema_version: "1.0", id: "artifact_1", type: "artifact", workspace_id: "ws_test",
      created_by: "bot_b", kind: "text", provenance: { source: "task3-test" }
    });
    repositories.approvals.put({
      schema_version: "1.0", id: "approval_1", type: "approval", workspace_id: "ws_test",
      actor_id: "operator", status: "pending", action: { kind: "task.execute", summary: "Execute task" }
    });
    repositories.capabilityLeases.put({
      schema_version: "1.0", id: "cap_1", type: "capability_lease", principal: "operator",
      issued_to: "bot_b", workspace_id: "ws_test", task_id: "task_1", expires_at: "2099-01-01T00:00:00.000Z"
    });
    repositories.environmentLeases.put({
      schema_version: "1.0", id: "env_1", type: "environment_lease", issued_to: "bot_b",
      workspace_id: "ws_test", environment_policy: "shared_workspace", environment_ref: "host-default",
      expires_at: "2099-01-01T00:00:00.000Z"
    });
    store.appendEvent({
      schema_version: "1.0", id: "event_1", type: "event.persistence", timestamp,
      actor_id: "bot_a", workspace_id: "ws_test", task_id: "task_1"
    });
    store.enqueueDelivery({
      id: "delivery_1", messageId: "message_1", senderId: "bot_a", targetKind: "bot",
      targetId: "bot_b", workspaceId: "ws_test", state: "queued", createdAt: timestamp, updatedAt: timestamp
    });
    store.close();
  }

  {
    const store = new CoordinationStore(path);
    const repositories = createCoordinationRepositories(store);
    assert.equal(repositories.bots.get("bot_a")?.kind, "bot");
    assert.equal(repositories.workers.get("worker_1")?.kind, "worker");
    assert.equal(repositories.rooms.get("room_1")?.kind, "room");
    assert.equal(repositories.threads.get("thread_1")?.kind, "thread");
    assert.equal(repositories.messages.get("message_1")?.kind, "message");
    assert.equal(repositories.tasks.get("task_1")?.kind, "task");
    assert.equal(repositories.handoffs.get("handoff_1")?.kind, "handoff");
    assert.equal(repositories.teamRuns.get("run_1")?.kind, "team_run");
    assert.equal(repositories.artifacts.get("artifact_1")?.kind, "artifact");
    assert.equal(repositories.approvals.get("approval_1")?.kind, "approval");
    assert.equal(repositories.capabilityLeases.get("cap_1")?.kind, "capability_lease");
    assert.equal(repositories.environmentLeases.get("env_1")?.kind, "environment_lease");
    assert.equal(store.listEventsAfter(0).some((entry) => entry.event.id === "event_1"), true);
    assert.equal(store.listMailbox("bot_b").some((delivery) => delivery.messageId === "message_1"), true);
    assert.equal(store.doctor().ok, true);
    store.close();
  }
});

test("legacy schema v1 migrates in place without losing stored coordination state", () => {
  const path = dbPath("v1-upgrade");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES ('schema_version', '1');
    CREATE TABLE objects (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, workspace_id TEXT, status TEXT,
      payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      timestamp TEXT NOT NULL, actor_id TEXT NOT NULL, workspace_id TEXT, run_id TEXT, task_id TEXT,
      room_id TEXT, thread_id TEXT, correlation_id TEXT, causation_id TEXT, trace_id TEXT,
      room_sequence INTEGER, payload TEXT NOT NULL
    );
    CREATE TABLE room_sequences (room_id TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, sender_id TEXT NOT NULL,
      target_kind TEXT NOT NULL, target_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE idempotency (
      key TEXT PRIMARY KEY, operation TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const created = new Date().toISOString();
  const legacyBot = bot("bot_legacy", "Legacy Bot");
  legacy.prepare(`
    INSERT INTO objects(id, kind, workspace_id, status, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("bot_legacy", "bot", "ws_test", "active", JSON.stringify(legacyBot), created, created);
  legacy.close();

  const store = new CoordinationStore(path);
  try {
    assert.equal(store.schemaVersion(), "3");
    assert.deepEqual(store.schemaMigrations().map((migration) => migration.version), [1, 2, 3]);
    assert.equal(store.getObject("bot_legacy")?.payload.name, "Legacy Bot");
    assert.ok(store.schemaRelations().includes("bots"));
  } finally {
    store.close();
  }
});

test("databases from a newer unsupported schema fail closed", () => {
  const path = dbPath("future-schema");
  const future = new DatabaseSync(path);
  future.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES ('schema_version', '999');
  `);
  future.close();
  assert.throws(
    () => new CoordinationStore(path),
    /newer than supported schema/
  );
});
