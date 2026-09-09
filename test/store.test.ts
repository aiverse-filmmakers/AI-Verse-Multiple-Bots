import assert from "node:assert/strict";
import test from "node:test";
import { CoordinationStore } from "../src/store.js";
import { createId } from "../src/id.js";

test("event store is append-only, ordered, and idempotent", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const event = {
      schema_version: "1.0" as const,
      id: createId("evt"),
      type: "event.test",
      timestamp: new Date().toISOString(),
      actor_id: "bot_a",
      workspace_id: "ws_test",
      room_id: "room_test"
    };
    const first = store.appendEvent(event, "request-1");
    const replay = store.appendEvent({ ...event, id: createId("evt") }, "request-1");
    assert.equal(first.sequence, 1);
    assert.equal(first.roomSequence, 1);
    assert.deepEqual(replay, first);
    assert.equal(store.listEventsAfter(0).length, 1);
  } finally {
    store.close();
  }
});

test("room ordering is independent per room", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const base = { schema_version: "1.0" as const, type: "event.test", timestamp: new Date().toISOString(), actor_id: "bot_a" };
    const a1 = store.appendEvent({ ...base, id: createId("evt"), room_id: "room_a" });
    const b1 = store.appendEvent({ ...base, id: createId("evt"), room_id: "room_b" });
    const a2 = store.appendEvent({ ...base, id: createId("evt"), room_id: "room_a" });
    assert.equal(a1.roomSequence, 1);
    assert.equal(b1.roomSequence, 1);
    assert.equal(a2.roomSequence, 2);
  } finally {
    store.close();
  }
});
