import { createServer } from "node:http";
import { URL } from "node:url";
import type { BotManifest, JsonObject } from "./types.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { CoordinationPolicy } from "./policy.js";
import { RoomCoordinator } from "./rooms.js";
import { BotRunner } from "./runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "./runtime.js";
import { CoordinationStore } from "./store.js";
import { ExecutionSupervisor } from "./supervisor.js";

export interface GatewayServerOptions {
  host?: string;
  port?: number;
  dbPath?: string;
}

async function readJson(req: any): Promise<JsonObject> {
  const chunks: string[] = [];
  for await (const chunk of req) chunks.push(String(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(chunks.join("")) as JsonObject;
}

function json(res: any, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function errorResponse(res: any, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  json(res, 400, { error: "BAD_REQUEST", message });
}

function requiredString(body: JsonObject, key: string): string {
  if (typeof body[key] !== "string" || String(body[key]).length === 0) throw new Error(`${key} is required`);
  return String(body[key]);
}

export function createGatewayServer(options: GatewayServerOptions = {}) {
  const store = new CoordinationStore(options.dbPath ?? "runtime/ai-verse-bots/coordination.db");
  const executionQueue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, executionQueue, policy);
  const rooms = new RoomCoordinator(store, gateway);
  const runtimes = new RuntimeRegistry().register(new DeterministicRuntimeAdapter());
  const runner = new BotRunner(store, gateway, executionQueue, runtimes);
  const supervisor = new ExecutionSupervisor(gateway, executionQueue, runner);
  supervisor.start();

  const server = createServer(async (req: any, res: any) => {
    const url = new URL(req.url ?? "/", `http://${req.headers?.host ?? "127.0.0.1"}`);
    const method = String(req.method ?? "GET").toUpperCase();

    try {
      if (method === "GET" && url.pathname === "/health") {
        json(res, 200, store.doctor());
        return;
      }

      if (method === "GET" && url.pathname === "/v1/bots") {
        json(res, 200, { bots: gateway.listBots(url.searchParams.get("workspace") ?? undefined) });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/bots") {
        const body = await readJson(req);
        json(res, 201, gateway.createBot(body as BotManifest));
        return;
      }

      const runNextMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/run-next$/);
      if (method === "POST" && runNextMatch) {
        const result = await runner.runNext(decodeURIComponent(runNextMatch[1] as string));
        json(res, result ? 200 : 204, result ?? {});
        return;
      }

      const executionMatch = url.pathname.match(/^\/v1\/execution\/([^/]+)$/);
      if (method === "GET" && executionMatch) {
        const targetId = decodeURIComponent(executionMatch[1] as string);
        json(res, 200, { executions: executionQueue.list(targetId) });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/rooms") {
        json(res, 200, { rooms: rooms.listRooms(url.searchParams.get("workspace") ?? undefined) });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/rooms") {
        const body = await readJson(req);
        const name = requiredString(body, "name");
        const workspaceId = requiredString(body, "workspaceId");
        if (!Array.isArray(body.memberIds) || body.memberIds.length === 0) throw new Error("memberIds must be a non-empty array");
        const room = rooms.createRoom({
          id: typeof body.id === "string" ? body.id : undefined,
          name,
          workspaceId,
          memberIds: body.memberIds.map(String),
          leaderId: body.leaderId === null ? null : typeof body.leaderId === "string" ? body.leaderId : undefined,
          mode: typeof body.mode === "string" ? body.mode as any : undefined,
          speakerPolicy: typeof body.speakerPolicy === "string" ? body.speakerPolicy : undefined,
          workOwnerPolicy: typeof body.workOwnerPolicy === "string" ? body.workOwnerPolicy as any : undefined,
          maxRoundsPerUserTurn: typeof body.maxRoundsPerUserTurn === "number" ? body.maxRoundsPerUserTurn : undefined,
          maxBotMessagesPerUserTurn: typeof body.maxBotMessagesPerUserTurn === "number" ? body.maxBotMessagesPerUserTurn : undefined
        });
        json(res, 201, room);
        return;
      }

      const roomEventsMatch = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/events$/);
      if (method === "GET" && roomEventsMatch) {
        const roomId = decodeURIComponent(roomEventsMatch[1] as string);
        const after = Number(url.searchParams.get("after") ?? "0");
        const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 1000);
        const threadId = url.searchParams.get("thread") ?? undefined;
        json(res, 200, { events: store.listRoomEvents(roomId, after, limit, threadId) });
        return;
      }

      const roomMessageMatch = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/messages$/);
      if (method === "POST" && roomMessageMatch) {
        const body = await readJson(req);
        const result = rooms.sendMessage({
          roomId: decodeURIComponent(roomMessageMatch[1] as string),
          senderId: requiredString(body, "senderId"),
          text: requiredString(body, "text"),
          threadId: typeof body.threadId === "string" ? body.threadId : undefined,
          replyToMessageId: typeof body.replyToMessageId === "string" ? body.replyToMessageId : undefined,
          correlationId: typeof body.correlationId === "string" ? body.correlationId : undefined,
          activateSpeakers: typeof body.activateSpeakers === "boolean" ? body.activateSpeakers : undefined
        });
        json(res, 202, result);
        return;
      }

      const roomThreadMatch = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/threads$/);
      if (method === "POST" && roomThreadMatch) {
        const body = await readJson(req);
        const thread = rooms.createThread(
          decodeURIComponent(roomThreadMatch[1] as string),
          requiredString(body, "parentMessageId"),
          requiredString(body, "createdBy")
        );
        json(res, 201, thread);
        return;
      }

      const roomPassMatch = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/pass$/);
      if (method === "POST" && roomPassMatch) {
        const body = await readJson(req);
        const event = rooms.pass(
          decodeURIComponent(roomPassMatch[1] as string),
          requiredString(body, "botId"),
          typeof body.reasonCode === "string" ? body.reasonCode : "NO_ADDITIONAL_VALUE",
          typeof body.threadId === "string" ? body.threadId : undefined
        );
        json(res, 200, event);
        return;
      }

      const roomOwnerMatch = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/work-owner$/);
      if (method === "POST" && roomOwnerMatch) {
        const body = await readJson(req);
        const room = rooms.setWorkOwner({
          roomId: decodeURIComponent(roomOwnerMatch[1] as string),
          actorId: requiredString(body, "actorId"),
          workItemId: requiredString(body, "workItemId"),
          ownerId: requiredString(body, "ownerId"),
          collaboratorIds: Array.isArray(body.collaboratorIds) ? body.collaboratorIds.map(String) : []
        });
        json(res, 200, room);
        return;
      }

      const roomGetMatch = url.pathname.match(/^\/v1\/rooms\/([^/]+)$/);
      if (method === "GET" && roomGetMatch) {
        const room = rooms.getRoom(decodeURIComponent(roomGetMatch[1] as string));
        if (!room) {
          json(res, 404, { error: "NOT_FOUND" });
          return;
        }
        json(res, 200, room);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/delegations") {
        const body = await readJson(req);
        json(res, 201, gateway.delegate({
          createdBy: requiredString(body, "createdBy"),
          assigneeId: requiredString(body, "assigneeId"),
          workspaceId: requiredString(body, "workspaceId"),
          rootObjectiveId: requiredString(body, "rootObjectiveId"),
          objective: requiredString(body, "objective"),
          reason: requiredString(body, "reason"),
          requiredConstraints: Array.isArray(body.requiredConstraints) ? body.requiredConstraints.map(String) : [],
          expectedOutput: typeof body.expectedOutput === "object" && body.expectedOutput !== null ? body.expectedOutput as JsonObject : undefined,
          tools: Array.isArray(body.tools) ? body.tools.map(String) : [],
          connections: Array.isArray(body.connections) ? body.connections.map(String) : [],
          parentTaskId: typeof body.parentTaskId === "string" ? body.parentTaskId : undefined,
          hop: typeof body.hop === "number" ? body.hop : undefined,
          maxHops: typeof body.maxHops === "number" ? body.maxHops : undefined,
          leaseExpiresAt: typeof body.leaseExpiresAt === "string" ? body.leaseExpiresAt : undefined
        }));
        return;
      }

      if (method === "POST" && url.pathname === "/v1/handoffs") {
        const body = await readJson(req);
        json(res, 201, gateway.requestHandoff({
          sourceOwnerId: requiredString(body, "sourceOwnerId"),
          targetOwnerId: requiredString(body, "targetOwnerId"),
          workspaceId: requiredString(body, "workspaceId"),
          workItemId: requiredString(body, "workItemId"),
          rootObjectiveId: requiredString(body, "rootObjectiveId"),
          reason: requiredString(body, "reason"),
          requiredConstraints: Array.isArray(body.requiredConstraints) ? body.requiredConstraints.map(String) : [],
          artifactRefs: Array.isArray(body.artifactRefs) ? body.artifactRefs.map(String) : [],
          returnPolicy: typeof body.returnPolicy === "string" ? body.returnPolicy : undefined
        }));
        return;
      }

      const handoffAcceptMatch = url.pathname.match(/^\/v1\/handoffs\/([^/]+)\/accept$/);
      if (method === "POST" && handoffAcceptMatch) {
        const body = await readJson(req);
        json(res, 200, gateway.acceptHandoff(
          decodeURIComponent(handoffAcceptMatch[1] as string),
          requiredString(body, "actorId")
        ));
        return;
      }

      if (method === "POST" && url.pathname === "/v1/messages") {
        const body = await readJson(req);
        const result = gateway.sendMessage({
          senderId: requiredString(body, "senderId"),
          targetKind: requiredString(body, "targetKind") as any,
          targetId: requiredString(body, "targetId"),
          workspaceId: requiredString(body, "workspaceId"),
          text: requiredString(body, "text"),
          correlationId: typeof body.correlationId === "string" ? body.correlationId : undefined,
          roomId: typeof body.roomId === "string" ? body.roomId : undefined,
          threadId: typeof body.threadId === "string" ? body.threadId : undefined,
          idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined
        });
        json(res, 202, result);
        return;
      }

      const mailboxMatch = url.pathname.match(/^\/v1\/mailbox\/([^/]+)$/);
      if (method === "GET" && mailboxMatch) {
        json(res, 200, { deliveries: store.listMailbox(decodeURIComponent(mailboxMatch[1] as string)) });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/events") {
        const after = Number(url.searchParams.get("after") ?? "0");
        const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 1000);
        json(res, 200, { events: store.listEventsAfter(after, limit) });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/events/stream") {
        const after = Number(url.searchParams.get("after") ?? "0");
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive"
        });
        for (const event of store.listEventsAfter(after, 1000)) {
          res.write(`id: ${event.sequence}\nevent: coordination\ndata: ${JSON.stringify(event)}\n\n`);
        }
        const unsubscribe = gateway.subscribeEvents((event) => {
          res.write(`id: ${event.sequence}\nevent: coordination\ndata: ${JSON.stringify(event)}\n\n`);
        });
        req.on("close", unsubscribe);
        return;
      }

      json(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  return {
    store,
    executionQueue,
    policy,
    gateway,
    rooms,
    runtimes,
    runner,
    supervisor,
    server,
    listen(): Promise<{ host: string; port: number }> {
      const host = options.host ?? "127.0.0.1";
      const port = options.port ?? 0;
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve({ host, port: typeof address === "object" && address ? address.port : port });
        });
      });
    },
    async close(): Promise<void> {
      await supervisor.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => {
          if (error) reject(error);
          else resolve();
        });
      });
      executionQueue.close();
      store.close();
    }
  };
}
