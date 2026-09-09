import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { RoomCoordinator } from "../src/rooms.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, name: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name,
    kind: "durable",
    status: "active",
    role: { title: name, mission: `Own ${name} work.` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_room" },
    permissions: { policy_ref: "default-bot" },
    coordination: { default_mode: "direct" }
  };
}

function phaseBot(id: string, name: string, endpoint: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name,
    kind: "durable",
    status: "active",
    role: { title: name, mission: `${name} owns bounded Phase 1 acceptance work.` },
    runtime: {
      adapter: "openai-compatible",
      endpoint,
      model: "phase1-model-v1",
      api_key_env: "AI_VERSE_PHASE1_ACCEPTANCE_KEY",
      temperature: 0,
      max_tokens: 256
    },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_phase1" },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

async function waitForIdle(service: ReturnType<typeof createGatewayServer>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await service.supervisor.waitForIdle();
}

test("Room mention schedules bounded Bot work and publishes the result back into the Room and Thread", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue);
  const rooms = new RoomCoordinator(store, gateway);
  gateway.createBot(bot("bot_research-lead", "Research Lead"));
  gateway.createBot(bot("bot_finance", "Finance Analyst"));

  const runner = new BotRunner(
    store,
    gateway,
    queue,
    new RuntimeRegistry().register(new DeterministicRuntimeAdapter())
  );
  const supervisor = new ExecutionSupervisor(gateway, queue, runner);
  supervisor.start();

  try {
    const room = rooms.createRoom({
      id: "room_product",
      name: "Product Council",
      workspaceId: "ws_room",
      memberIds: ["bot_research-lead", "bot_finance"],
      leaderId: "bot_research-lead",
      speakerPolicy: "selective",
      maxBotMessagesPerUserTurn: 3
    });

    const first = rooms.sendMessage({
      roomId: room.id,
      senderId: "operator_local",
      text: "@research-lead verify competitor pricing."
    });
    assert.deepEqual(first.mentions, ["bot_research-lead"]);
    assert.equal(first.scheduledTaskIds.length, 1);
    assert.match(first.correlationId, /^corr_/);

    await supervisor.waitForIdle();
    const roomMessages = store.listObjects("message", "ws_room")
      .filter((message) => message.payload.room_id === room.id && !message.payload.thread_id);
    assert.equal(roomMessages.length, 2);
    const botReply = roomMessages.find((message) => message.payload.sender_id === "bot_research-lead");
    assert.ok(botReply);
    assert.equal(Array.isArray(botReply?.payload.artifact_refs), true);
    assert.equal((botReply?.payload.artifact_refs as string[]).length, 1);

    const thread = rooms.createThread(room.id, first.message.id, "operator_local");
    const threadMessage = rooms.sendMessage({
      roomId: room.id,
      threadId: thread.id,
      senderId: "operator_local",
      text: "@finance review the pricing implication."
    });
    assert.deepEqual(threadMessage.mentions, ["bot_finance"]);
    await supervisor.waitForIdle();

    const threadMessages = store.listObjects("message", "ws_room")
      .filter((message) => message.payload.thread_id === thread.id);
    assert.equal(threadMessages.length, 2);
    assert.ok(threadMessages.some((message) => message.payload.sender_id === "bot_finance"));

    const pass = rooms.pass(room.id, "bot_finance", "NO_ADDITIONAL_VALUE", thread.id);
    assert.equal(pass.event.type, "room.pass");

    const owned = rooms.setWorkOwner({
      roomId: room.id,
      actorId: "operator_local",
      workItemId: first.scheduledTaskIds[0] as string,
      ownerId: "bot_research-lead",
      collaboratorIds: ["bot_finance"]
    });
    assert.equal((owned.payload.active_work as any).owner_id, "bot_research-lead");
  } finally {
    await supervisor.stop();
    queue.close();
    store.close();
  }
});

test("Room membership and mention failures are visible and do not silently route work", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  const rooms = new RoomCoordinator(store, gateway);
  try {
    gateway.createBot(bot("bot_research-lead", "Research Lead"));
    const room = rooms.createRoom({
      id: "room_guarded",
      name: "Guarded Room",
      workspaceId: "ws_room",
      memberIds: ["bot_research-lead"]
    });

    assert.throws(() => rooms.sendMessage({
      roomId: room.id,
      senderId: "operator_local",
      text: "@missing-bot do this."
    }), /Unresolved Room mention/);

    assert.throws(() => gateway.publishRoomMessage({
      senderId: "bot_outsider",
      roomId: room.id,
      workspaceId: "ws_room",
      text: "I should not be here."
    }), /not a member/);

    const types = store.listEventsAfter(0, 100).map((entry) => entry.event.type);
    assert.ok(types.includes("room.unresolved_mention"));
  } finally {
    store.close();
  }
});

test("Room max_messages budget is enforced across repeated scheduling calls in one correlation turn", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  const rooms = new RoomCoordinator(store, gateway);
  try {
    gateway.createBot(bot("bot_budget-a", "Budget A"));
    gateway.createBot(bot("bot_budget-b", "Budget B"));
    gateway.createBot(bot("bot_budget-c", "Budget C"));
    const room = rooms.createRoom({
      id: "room_message_budget",
      name: "Message Budget Room",
      workspaceId: "ws_room",
      memberIds: ["bot_budget-a", "bot_budget-b", "bot_budget-c"],
      speakerPolicy: "all_members",
      maxBotMessagesPerUserTurn: 2,
      maxRoundsPerUserTurn: 3
    });

    const first = rooms.sendMessage({
      roomId: room.id,
      senderId: "operator_local",
      text: "First bounded dispatch",
      correlationId: "corr_message_budget"
    });
    assert.equal(first.scheduledTaskIds.length, 2);
    assert.equal(first.budgetExhausted, undefined);

    const second = rooms.sendMessage({
      roomId: room.id,
      senderId: "operator_local",
      text: "Try to schedule more in the same turn",
      correlationId: "corr_message_budget"
    });
    assert.equal(second.scheduledTaskIds.length, 0);
    assert.equal(second.budgetExhausted, "max_messages");
    assert.equal(
      store.listObjects("task", "ws_room").filter((task) => task.payload.root_objective_id === "corr_message_budget").length,
      2
    );
    const exhausted = store.listRoomEvents(room.id, 0, 100)
      .filter((entry) => entry.event.type === "room.budget_exhausted");
    assert.equal(exhausted.length, 1);
  } finally {
    store.close();
  }
});

test("Room max_rounds budget prevents another scheduling round for the same correlation turn", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  const rooms = new RoomCoordinator(store, gateway);
  try {
    gateway.createBot(bot("bot_round-lead", "Round Lead"));
    const room = rooms.createRoom({
      id: "room_round_budget",
      name: "Round Budget Room",
      workspaceId: "ws_room",
      memberIds: ["bot_round-lead"],
      leaderId: "bot_round-lead",
      speakerPolicy: "selective",
      maxBotMessagesPerUserTurn: 5,
      maxRoundsPerUserTurn: 1
    });

    const first = rooms.sendMessage({
      roomId: room.id,
      senderId: "operator_local",
      text: "Round one",
      correlationId: "corr_round_budget"
    });
    assert.equal(first.scheduledTaskIds.length, 1);

    const second = rooms.sendMessage({
      roomId: room.id,
      senderId: "operator_local",
      text: "Round two should be blocked",
      correlationId: "corr_round_budget"
    });
    assert.equal(second.scheduledTaskIds.length, 0);
    assert.equal(second.budgetExhausted, "max_rounds");
    const rounds = store.listRoomEvents(room.id, 0, 100)
      .filter((entry) => entry.event.type === "room.round_scheduled" && entry.event.correlation_id === "corr_round_budget");
    assert.equal(rounds.length, 1);
  } finally {
    store.close();
  }
});

test("Phase 1 release gate survives restart across messaging, Room/Thread, Handoff, Approval, real runtime and cancellation integrity", async () => {
  let modelRequests = 0;
  const modelServer = createServer(async (req: any, res: any) => {
    const chunks: string[] = [];
    for await (const chunk of req) chunks.push(String(chunk));
    const body = JSON.parse(chunks.join("") || "{}") as any;
    modelRequests += 1;
    const taskInput = JSON.parse(String(body.messages?.[1]?.content ?? "{}")) as any;
    const answer = String(taskInput.objective ?? "").includes("Respond in Room")
      ? "PHASE1_ROOM_RESULT: restart-safe Room collaboration completed."
      : "PHASE1_APPROVED_RESULT: approved responsibility transfer executed successfully.";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `phase1_req_${modelRequests}`,
      model: "phase1-model-v1",
      choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 14, completion_tokens: 8, total_tokens: 22 }
    }));
  });

  const modelAddress = await new Promise<{ port: number }>((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", () => {
      const address = modelServer.address();
      resolve({ port: typeof address === "object" && address ? address.port : 0 });
    });
  });

  const priorKey = process.env.AI_VERSE_PHASE1_ACCEPTANCE_KEY;
  process.env.AI_VERSE_PHASE1_ACCEPTANCE_KEY = "phase1-secret-never-persist";
  const endpoint = `http://127.0.0.1:${modelAddress.port}/v1/chat/completions`;
  const dbPath = `/tmp/ai-verse-phase1-acceptance-${randomUUID()}.db`;
  let firstService: ReturnType<typeof createGatewayServer> | null = createGatewayServer({ dbPath, port: 0 });
  let secondService: ReturnType<typeof createGatewayServer> | null = null;
  await firstService.listen();

  try {
    firstService.gateway.createBot(phaseBot("bot_phase-lead", "Phase Lead", endpoint));
    firstService.gateway.createBot(phaseBot("bot_phase-reviewer", "Phase Reviewer", endpoint));
    const directMessage = firstService.gateway.sendMessage({
      senderId: "bot_phase-lead", targetKind: "bot", targetId: "bot_phase-reviewer",
      workspaceId: "ws_phase1", text: "Persist this peer message across the Gateway restart.",
      correlationId: "corr_phase1_direct"
    });
    const room = firstService.rooms.createRoom({
      id: "room_phase1_release", name: "Phase 1 Release Room", workspaceId: "ws_phase1",
      memberIds: ["bot_phase-lead", "bot_phase-reviewer"], leaderId: "bot_phase-lead",
      speakerPolicy: "selective", maxBotMessagesPerUserTurn: 3, maxRoundsPerUserTurn: 1
    });
    const seed = firstService.rooms.sendMessage({
      roomId: room.id, senderId: "operator_local", text: "Persistent Room seed before restart.", activateSpeakers: false
    });
    const thread = firstService.rooms.createThread(room.id, seed.message.id, "operator_local");

    const delegated = firstService.gateway.delegate({
      createdBy: "operator_local", assigneeId: "bot_phase-lead", workspaceId: "ws_phase1",
      rootObjectiveId: "obj_phase1_release",
      objective: "Perform one approved model-backed task after responsibility transfers to the reviewer.",
      reason: "Phase 1 release conformance", requiredConstraints: ["Do not publish externally"],
      budget: { token_limit: 200, wall_clock_seconds: 30 },
      approval: { required: true, reason: "Release gate proves approval survives restart" }
    });
    assert.equal(delegated.task.payload.status, "waiting_approval");
    assert.ok(delegated.approval);
    assert.equal(firstService.executionQueue.getByItem(delegated.task.id), null);
    const requestedHandoff = firstService.gateway.requestHandoff({
      sourceOwnerId: "bot_phase-lead", targetOwnerId: "bot_phase-reviewer", workspaceId: "ws_phase1",
      workItemId: delegated.task.id, rootObjectiveId: "obj_phase1_release",
      reason: "Reviewer must own final execution after restart", returnPolicy: "return_on_completion"
    });

    await firstService.close();
    firstService = null;
    secondService = createGatewayServer({ dbPath, port: 0 });
    await secondService.listen();

    assert.equal(secondService.store.doctor().ok, true);
    assert.equal(secondService.gateway.getBot("bot_phase-lead")?.payload.status, "active");
    assert.equal(secondService.rooms.getRoom(room.id)?.id, room.id);
    assert.equal(secondService.store.getObject(thread.id)?.kind, "thread");
    assert.ok(secondService.store.listMailbox("bot_phase-reviewer").some((d) => d.messageId === directMessage.message.id));
    assert.equal(secondService.store.getObject(delegated.task.id)?.payload.status, "waiting_approval");
    assert.equal(secondService.store.getObject(requestedHandoff.handoff.id)?.payload.status, "requested");

    const accepted = secondService.gateway.acceptHandoff(requestedHandoff.handoff.id, "bot_phase-reviewer");
    assert.equal(accepted.workItem.payload.owner_id, "bot_phase-reviewer");
    assert.equal(accepted.workItem.payload.status, "waiting_approval");
    assert.equal(secondService.executionQueue.getByItem(delegated.task.id), null);
    const approvalId = delegated.approval?.id as string;
    assert.equal(secondService.store.getObject(approvalId)?.payload.actor_id, "bot_phase-reviewer");

    secondService.gateway.approve(approvalId, "operator_local");
    await waitForIdle(secondService);
    const completedTask = secondService.store.getObject(delegated.task.id);
    assert.equal(completedTask?.payload.status, "completed");
    assert.equal(completedTask?.payload.assignee_id, "bot_phase-reviewer");
    assert.equal(completedTask?.payload.owner_id, "bot_phase-lead");
    assert.equal(secondService.store.getObject(requestedHandoff.handoff.id)?.payload.status, "completed");
    const artifactId = (completedTask?.payload.output_artifact_refs as string[])[0] as string;
    const artifact = secondService.store.getObject(artifactId);
    assert.match(String((artifact?.payload.inline_content as any)?.text), /PHASE1_APPROVED_RESULT/);
    assert.equal((artifact?.payload.runtime_receipts as any[])?.[0]?.adapter, "openai-compatible");

    const roomTurn = secondService.rooms.sendMessage({
      roomId: room.id, threadId: thread.id, senderId: "operator_local",
      text: "@phase-reviewer verify the restarted Room and Thread path.", correlationId: "corr_phase1_room"
    });
    assert.equal(roomTurn.scheduledTaskIds.length, 1);
    await waitForIdle(secondService);
    const threadMessages = secondService.store.listObjects("message", "ws_phase1")
      .filter((message) => message.payload.thread_id === thread.id);
    assert.ok(threadMessages.some((message) => message.payload.sender_id === "bot_phase-reviewer"));
    const blockedRound = secondService.rooms.sendMessage({
      roomId: room.id, threadId: thread.id, senderId: "operator_local",
      text: "@phase-reviewer attempt a second round in the same bounded turn.", correlationId: "corr_phase1_room"
    });
    assert.equal(blockedRound.scheduledTaskIds.length, 0);
    assert.equal(blockedRound.budgetExhausted, "max_rounds");

    const denied = secondService.gateway.delegate({
      createdBy: "operator_local", assigneeId: "bot_phase-reviewer", workspaceId: "ws_phase1",
      rootObjectiveId: "obj_phase1_denied", objective: "This denied Task must never execute.",
      reason: "Cancellation integrity release check", approval: { required: true, reason: "Must be denied" }
    });
    secondService.gateway.rejectApproval(denied.approval?.id as string, "operator_local", "Release gate denial");
    assert.equal(secondService.store.getObject(denied.task.id)?.payload.status, "canceled");
    assert.equal(secondService.store.listObjects("artifact", "ws_phase1").some((a) => a.payload.task_id === denied.task.id), false);

    const events = secondService.store.listEventsAfter(0, 2000).map((entry) => entry.event.type);
    for (const required of [
      "handoff.requested", "handoff.accepted", "approval.retargeted", "approval.approved",
      "artifact.published", "task.completed", "handoff.completed", "room.round_scheduled",
      "room.budget_exhausted", "approval.denied", "task.canceled"
    ]) assert.ok(events.includes(required), `Missing Phase 1 acceptance event ${required}`);

    const persisted = JSON.stringify({
      bots: secondService.gateway.listBots("ws_phase1"), tasks: secondService.store.listObjects("task", "ws_phase1"),
      artifacts: secondService.store.listObjects("artifact", "ws_phase1"), events: secondService.store.listEventsAfter(0, 2000)
    });
    assert.equal(persisted.includes("phase1-secret-never-persist"), false);
    assert.ok(modelRequests >= 2);
  } finally {
    if (firstService) await firstService.close();
    if (secondService) await secondService.close();
    await new Promise<void>((resolve, reject) => modelServer.close((error: Error | undefined) => error ? reject(error) : resolve()));
    if (priorKey === undefined) delete process.env.AI_VERSE_PHASE1_ACCEPTANCE_KEY;
    else process.env.AI_VERSE_PHASE1_ACCEPTANCE_KEY = priorKey;
  }
});
