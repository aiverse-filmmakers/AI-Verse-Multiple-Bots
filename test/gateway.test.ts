import assert from "node:assert/strict";
import test from "node:test";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, name: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name,
    kind: "durable",
    status: "active",
    role: { title: name, mission: `Own ${name} work.` },
    runtime: { adapter: "native" },
    execution: { environment_policy: "shared_workspace", environment_ref: "host-default" },
    scope: { type: "workspace", workspace_id: "ws_test" },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
  };
}

test("persistent Bots and asynchronous mailbox survive store reopen", () => {
  const db = `/tmp/aiverse-bots-${Date.now()}-${Math.random()}.db`;
  {
    const store = new CoordinationStore(db);
    const gateway = new CoordinationGateway(store);
    gateway.createBot(bot("bot_a", "Research Lead"));
    gateway.createBot(bot("bot_b", "Finance Analyst"));
    const sent = gateway.sendMessage({
      senderId: "bot_a",
      targetKind: "bot",
      targetId: "bot_b",
      workspaceId: "ws_test",
      text: "Check pricing impact."
    });
    assert.equal(sent.delivery.state, "queued");
    assert.equal(store.listMailbox("bot_b").length, 1);
    store.close();
  }
  {
    const store = new CoordinationStore(db);
    const gateway = new CoordinationGateway(store);
    assert.equal(gateway.listBots("ws_test").length, 2);
    assert.equal(store.listMailbox("bot_b").length, 1);
    assert.ok(store.listEventsAfter(0).length >= 3);
    store.close();
  }
});
