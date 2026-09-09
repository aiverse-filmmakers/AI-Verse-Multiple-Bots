import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CanonicalEventBus } from "../src/event-bus.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest, CoordinationEvent } from "../src/types.js";

function pathFor(label: string): string {
  return `/tmp/aiverse-task4-${label}-${Date.now()}-${Math.random()}.db`;
}

function event(id: string, overrides: Partial<CoordinationEvent> = {}): CoordinationEvent {
  return {
    schema_version: "1.0",
    id,
    type: "event.test",
    timestamp: new Date().toISOString(),
    actor_id: "bot_a",
    workspace_id: "ws_test",
    ...overrides
  };
}

function bot(id: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: "Research Lead",
    kind: "durable",
    status: "active",
    role: { title: "Research Lead", mission: "Own research." },
    runtime: { adapter: "native" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_test" },
    permissions: { policy_ref: "default" },
    coordination: { default_mode: "direct" }
  };
}

test("canonical event bus assigns correlation and enforces causation chains", () => {
  const store = new CoordinationStore(":memory:");
  const bus = new CanonicalEventBus(store);
  try {
    const root = bus.publish(event("evt_root"));
    assert.match(String(root.event.correlation_id), /^corr_/);
    assert.equal(root.event.causation_id, null);

    const child = bus.publishCausedBy(event("evt_child"), root.event.id);
    assert.equal(child.event.causation_id, root.event.id);
    assert.equal(child.event.correlation_id, root.event.correlation_id);

    assert.throws(
      () => bus.publish(event("evt_conflict", {
        causation_id: root.event.id,
        correlation_id: "corr_conflicting"
      })),
      /conflicts with causation event/
    );
    assert.throws(
      () => bus.publish(event("evt_missing_parent", { causation_id: "evt_missing" })),
      /was not found/
    );
  } finally {
    store.close();
  }
});

test("Room and Team Run ordering are independent monotonic streams", () => {
  const store = new CoordinationStore(":memory:");
  const bus = new CanonicalEventBus(store);
  try {
    const a1 = bus.publish(event("evt_a1", { room_id: "room_a", run_id: "run_a" }));
    const b1 = bus.publish(event("evt_b1", { room_id: "room_b", run_id: "run_b" }));
    const a2 = bus.publish(event("evt_a2", { room_id: "room_a", run_id: "run_a" }));
    const mixed = bus.publish(event("evt_mixed", { room_id: "room_a", run_id: "run_b" }));

    assert.equal(a1.roomSequence, 1);
    assert.equal(b1.roomSequence, 1);
    assert.equal(a2.roomSequence, 2);
    assert.equal(mixed.roomSequence, 3);

    assert.equal(a1.runSequence, 1);
    assert.equal(b1.runSequence, 1);
    assert.equal(a2.runSequence, 2);
    assert.equal(mixed.runSequence, 2);

    assert.deepEqual(bus.replay({ scope: "room", roomId: "room_a" }).map((entry) => entry.roomSequence), [1, 2, 3]);
    assert.deepEqual(bus.replay({ scope: "run", runId: "run_b" }).map((entry) => entry.runSequence), [1, 2]);
  } finally {
    store.close();
  }
});

test("replay and correlation chains survive Coordination Gateway restart", () => {
  const path = pathFor("restart");
  let correlationId: string;
  let lastGlobalSequence: number;
  {
    const store = new CoordinationStore(path);
    const bus = new CanonicalEventBus(store);
    const root = bus.publish(event("evt_restart_root", { room_id: "room_restart", run_id: "run_restart" }));
    correlationId = String(root.event.correlation_id);
    const child = bus.publishCausedBy(
      event("evt_restart_child", { room_id: "room_restart", run_id: "run_restart" }),
      root.event.id
    );
    lastGlobalSequence = child.sequence;
    store.close();
  }
  {
    const store = new CoordinationStore(path);
    const bus = new CanonicalEventBus(store);
    try {
      const correlationReplay = bus.replay({ scope: "correlation", correlationId });
      assert.deepEqual(correlationReplay.map((entry) => entry.event.id), ["evt_restart_root", "evt_restart_child"]);
      assert.deepEqual(bus.replay({ scope: "room", roomId: "room_restart" }).map((entry) => entry.roomSequence), [1, 2]);
      assert.deepEqual(bus.replay({ scope: "run", runId: "run_restart" }).map((entry) => entry.runSequence), [1, 2]);
      assert.equal(bus.replay({ scope: "global", afterSequence: lastGlobalSequence }).length, 0);
    } finally {
      store.close();
    }
  }
});

test("event IDs and request keys are idempotent while SQLite prevents mutation or deletion", () => {
  const path = pathFor("append-only");
  const store = new CoordinationStore(path);
  const bus = new CanonicalEventBus(store);
  const original = event("evt_idempotent", { correlation_id: "corr_fixed" });
  const first = bus.publish(original, { idempotencyKey: "request-1" });
  const sameId = bus.publish({ ...original });
  const requestReplay = bus.publish(event("evt_retry_new_id", { correlation_id: "corr_other" }), { idempotencyKey: "request-1" });
  assert.equal(sameId.sequence, first.sequence);
  assert.equal(requestReplay.sequence, first.sequence);
  assert.equal(store.listEventsAfter(0).length, 1);
  assert.throws(
    () => bus.publish({ ...original, type: "event.conflicting" }),
    /already exists with different payload/
  );
  store.close();

  const raw = new DatabaseSync(path);
  try {
    assert.throws(
      () => raw.prepare("UPDATE events SET type = 'event.mutated' WHERE id = ?").run(original.id),
      /append-only/
    );
    assert.throws(
      () => raw.prepare("DELETE FROM events WHERE id = ?").run(original.id),
      /append-only/
    );
    const count = raw.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number };
    assert.equal(Number(count.count), 1);
  } finally {
    raw.close();
  }
});

test("Coordination Gateway publishes through the canonical bus", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  const delivered: string[] = [];
  const unsubscribe = gateway.subscribeEvents((entry) => delivered.push(entry.event.id));
  try {
    gateway.createBot(bot("bot_gateway"));
    const events = gateway.events.replay({ scope: "global" });
    assert.equal(events.length, 1);
    const firstEvent = events[0]!;
    assert.match(String(firstEvent.event.correlation_id), /^corr_/);
    assert.deepEqual(delivered, [firstEvent.event.id]);
  } finally {
    unsubscribe();
    store.close();
  }
});
