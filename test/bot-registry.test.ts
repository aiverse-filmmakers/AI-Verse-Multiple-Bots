import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import test from "node:test";
import { BotRegistryError } from "../src/bot-registry.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { RoomCoordinator } from "../src/rooms.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

interface BotOptions {
  workspace?: string;
  scope?: "workspace" | "operator";
  status?: "active" | "disabled" | "archived";
  aliases?: string[];
  handle?: string;
  managerId?: string;
  peers?: string[];
  roleTitle?: string;
  runtime?: string;
}

function bot(id: string, name: string, options: BotOptions = {}): BotManifest {
  const scope = options.scope ?? "workspace";
  return {
    schema_version: "1.0",
    id,
    name,
    kind: "durable",
    status: options.status ?? "active",
    role: { title: options.roleTitle ?? name, mission: `Own ${name} work.` },
    runtime: { adapter: options.runtime ?? "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: scope === "operator"
      ? { type: "operator" }
      : { type: "workspace", workspace_id: options.workspace ?? "ws_registry" },
    permissions: {
      policy_ref: "default-bot",
      ...(options.peers ? { allowed_peers: options.peers } : {})
    },
    coordination: {
      default_mode: "direct",
      ...(options.aliases ? { aliases: options.aliases } : {}),
      ...(options.managerId ? { manager_id: options.managerId } : {})
    },
    ...(options.handle ? { ui: { handle: options.handle } } : {})
  };
}

function assertRegistryCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof BotRegistryError && error.code === code;
}

test("Bot registry rejects durable ID/address collisions and keeps archived addresses reserved", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    gateway.createBot(bot("bot_alpha", "Alpha", { aliases: ["lead"], handle: "alpha-ui" }));

    assert.throws(
      () => gateway.createBot(bot("bot_alpha", "Replacement Alpha")),
      assertRegistryCode("BOT_ID_COLLISION")
    );
    assert.throws(
      () => gateway.createBot(bot("bot_beta", "Lead")),
      assertRegistryCode("BOT_ADDRESS_COLLISION")
    );

    const otherWorkspace = gateway.createBot(bot("bot_beta", "Lead", { workspace: "ws_other", aliases: ["lead"] }));
    assert.equal(otherWorkspace.workspaceId, "ws_other");
    assert.equal(gateway.resolveBotAddress("ws_registry", "@lead")?.id, "bot_alpha");

    const archived = gateway.transitionBot("bot_alpha", "archived", "operator_local");
    assert.equal(archived.payload.status, "archived");
    assert.equal(gateway.resolveBotAddress("ws_registry", "lead"), null);
    assert.throws(
      () => gateway.createBot(bot("bot_gamma", "Gamma", { aliases: ["lead"] })),
      assertRegistryCode("BOT_ADDRESS_COLLISION")
    );
    assert.throws(
      () => gateway.transitionBot("bot_alpha", "active", "operator_local"),
      assertRegistryCode("ARCHIVED_TERMINAL")
    );
  } finally {
    store.close();
  }
});

test("professional role titles are descriptive and never become implicit Bot addresses", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  const rooms = new RoomCoordinator(store, gateway);
  try {
    gateway.createBot(bot("bot_research-one", "Research One", { roleTitle: "Researcher" }));
    gateway.createBot(bot("bot_research-two", "Research Two", { roleTitle: "Researcher" }));
    const room = rooms.createRoom({
      id: "room_research",
      name: "Research",
      workspaceId: "ws_registry",
      memberIds: ["bot_research-one", "bot_research-two"]
    });

    assert.deepEqual(rooms.resolveAlias(room, "researcher"), []);
    assert.deepEqual(rooms.resolveAlias(room, "research-one"), ["bot_research-one"]);
    assert.deepEqual(rooms.resolveAlias(room, "Research Two"), ["bot_research-two"]);
    assert.throws(() => rooms.sendMessage({
      roomId: room.id,
      senderId: "operator_local",
      text: "@researcher respond",
      activateSpeakers: false
    }), /Unresolved Room mention/);
  } finally {
    store.close();
  }
});

test("disabled Room members cannot speak, resolve as active mentions, or own Room work", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  const rooms = new RoomCoordinator(store, gateway);
  try {
    gateway.createBot(bot("bot_alpha", "Alpha"));
    gateway.createBot(bot("bot_beta", "Beta"));
    const room = rooms.createRoom({
      id: "room_lifecycle",
      name: "Lifecycle",
      workspaceId: "ws_registry",
      memberIds: ["bot_alpha", "bot_beta"],
      leaderId: "bot_alpha"
    });

    assert.throws(() => gateway.transitionBot("bot_beta", "disabled", "bot_alpha"), /Only an operator/);
    const disabled = gateway.transitionBot("bot_beta", "disabled", "operator_local");
    assert.equal(disabled.payload.status, "disabled");
    assert.deepEqual(rooms.resolveAlias(room, "beta"), []);
    assert.throws(() => rooms.sendMessage({
      roomId: room.id,
      senderId: "bot_beta",
      text: "I should not speak"
    }), /not active/);
    assert.throws(() => rooms.setWorkOwner({
      roomId: room.id,
      actorId: "operator_local",
      workItemId: "task_example",
      ownerId: "bot_beta"
    }), /not active/);

    const active = gateway.transitionBot("bot_beta", "active", "operator_local");
    assert.equal(active.payload.status, "active");
    assert.deepEqual(rooms.resolveAlias(room, "beta"), ["bot_beta"]);
    assert.throws(
      () => gateway.transitionBot("bot_beta", "archived", "operator_local"),
      assertRegistryCode("BOT_IN_ACTIVE_ROOM")
    );
  } finally {
    store.close();
  }
});

test("Bot lifecycle refuses disable/archive while the Bot owns live Task work", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  try {
    gateway.createBot(bot("bot_creator", "Creator", { peers: ["bot_worker"] }));
    gateway.createBot(bot("bot_worker", "Worker"));
    const delegated = gateway.delegate({
      createdBy: "bot_creator",
      assigneeId: "bot_worker",
      workspaceId: "ws_registry",
      rootObjectiveId: "obj_registry_live",
      objective: "Keep this Task live",
      reason: "Registry lifecycle guard"
    });
    assert.equal(delegated.task.payload.status, "assigned");

    assert.throws(
      () => gateway.transitionBot("bot_worker", "disabled", "operator_local"),
      assertRegistryCode("BOT_HAS_LIVE_WORK")
    );
    assert.throws(
      () => gateway.transitionBot("bot_worker", "archived", "operator_local"),
      assertRegistryCode("BOT_HAS_LIVE_WORK")
    );
  } finally {
    queue.close();
    store.close();
  }
});

test("manager relationships enforce scope, availability, dependency safety and cycle detection", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    const manager = gateway.createBot(bot("bot_manager", "Manager"));
    gateway.createBot(bot("bot_worker", "Worker", { managerId: "bot_manager" }));

    assert.throws(
      () => gateway.transitionBot("bot_manager", "disabled", "operator_local"),
      assertRegistryCode("BOT_HAS_MANAGER_DEPENDENTS")
    );
    assert.throws(
      () => gateway.createBot(bot("bot_cross", "Cross", { workspace: "ws_other", managerId: "bot_manager" })),
      assertRegistryCode("MANAGER_SCOPE_MISMATCH")
    );
    assert.throws(
      () => gateway.createBot(bot("bot_self", "Self", { managerId: "bot_self" })),
      assertRegistryCode("SELF_MANAGER")
    );

    const hypotheticalCycle = {
      ...manager.payload,
      coordination: { ...manager.payload.coordination, manager_id: "bot_worker" }
    } as BotManifest;
    assert.throws(
      () => gateway.registry.assertRelationships(hypotheticalCycle),
      assertRegistryCode("MANAGER_CYCLE")
    );

    gateway.transitionBot("bot_worker", "disabled", "operator_local");
    assert.equal(gateway.transitionBot("bot_manager", "disabled", "operator_local").payload.status, "disabled");
    assert.throws(
      () => gateway.transitionBot("bot_manager", "archived", "operator_local"),
      assertRegistryCode("BOT_HAS_MANAGER_DEPENDENTS")
    );
  } finally {
    store.close();
  }
});

test("peer relationships support safe forward declaration and reject cross-scope resolution", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    gateway.createBot(bot("bot_a", "A", { peers: ["bot_b"] }));
    assert.equal(gateway.createBot(bot("bot_b", "B")).id, "bot_b");
    assert.throws(
      () => gateway.createBot(bot("bot_self", "Self", { peers: ["bot_self"] })),
      assertRegistryCode("SELF_PEER")
    );
  } finally {
    store.close();
  }

  const crossStore = new CoordinationStore(":memory:");
  const crossGateway = new CoordinationGateway(crossStore);
  try {
    crossGateway.createBot(bot("bot_source", "Source", { workspace: "ws_one", peers: ["bot_future"] }));
    assert.throws(
      () => crossGateway.createBot(bot("bot_future", "Future", { workspace: "ws_two" })),
      assertRegistryCode("PEER_SCOPE_MISMATCH")
    );
  } finally {
    crossStore.close();
  }
});

test("operator-scoped Bots use an isolated registry namespace", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    gateway.createBot(bot("bot_operator-chief", "Chief", { scope: "operator", aliases: ["chief-of-staff"] }));
    gateway.createBot(bot("bot_workspace-chief", "Chief", { workspace: "ws_registry" }));
    assert.equal(gateway.resolveOperatorBotAddress("chief")?.id, "bot_operator-chief");
    assert.equal(gateway.resolveBotAddress("ws_registry", "chief")?.id, "bot_workspace-chief");
    assert.throws(
      () => gateway.createBot(bot("bot_operator-two", "Second", { scope: "operator", aliases: ["chief-of-staff"] })),
      assertRegistryCode("BOT_ADDRESS_COLLISION")
    );
  } finally {
    store.close();
  }
});

function httpJson(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => resolve({ status: Number(res.statusCode), body: JSON.parse(chunks.join("") || "{}") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("HTTP Bot registry exposes address resolution and operator-audited lifecycle transitions", async () => {
  const dbPath = `/tmp/ai-verse-registry-http-${randomUUID()}.db`;
  const service = createGatewayServer({ dbPath, port: 0 });
  const address = await service.listen();
  try {
    const created = await httpJson(address.port, "POST", "/v1/bots", bot("bot_http-registry", "Registry Bot", {
      workspace: "ws_registry",
      aliases: ["watcher"]
    }));
    assert.equal(created.status, 201);

    const resolved = await httpJson(address.port, "GET", "/v1/bots/resolve?workspace=ws_registry&address=%40watcher");
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.id, "bot_http-registry");

    const denied = await httpJson(address.port, "POST", "/v1/bots/bot_http-registry/disable", { actorId: "bot_intruder" });
    assert.equal(denied.status, 400);

    const disabled = await httpJson(address.port, "POST", "/v1/bots/bot_http-registry/disable", { actorId: "operator_local" });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.payload.status, "disabled");

    const fetched = await httpJson(address.port, "GET", "/v1/bots/bot_http-registry");
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.payload.status, "disabled");

    const activated = await httpJson(address.port, "POST", "/v1/bots/bot_http-registry/activate", { actorId: "operator_local" });
    assert.equal(activated.status, 200);
    assert.equal(activated.body.payload.status, "active");

    const archived = await httpJson(address.port, "POST", "/v1/bots/bot_http-registry/archive", { actorId: "operator_local" });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.payload.status, "archived");

    const missingAddress = await httpJson(address.port, "GET", "/v1/bots/resolve?workspace=ws_registry&address=watcher");
    assert.equal(missingAddress.status, 404);
    const cannotReactivate = await httpJson(address.port, "POST", "/v1/bots/bot_http-registry/activate", { actorId: "operator_local" });
    assert.equal(cannotReactivate.status, 400);

    const eventTypes = service.store.listEventsAfter(0, 100).map((entry) => entry.event.type);
    assert.ok(eventTypes.includes("bot.disabled"));
    assert.ok(eventTypes.includes("bot.activated"));
    assert.ok(eventTypes.includes("bot.archived"));
  } finally {
    await service.close();
  }
});
