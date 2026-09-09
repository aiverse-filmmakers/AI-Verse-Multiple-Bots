import { createServer } from "node:http";
import { URL } from "node:url";
import type { BotManifest, JsonObject } from "./types.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { BotRunner } from "./runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "./runtime.js";
import { CoordinationStore } from "./store.js";

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

export function createGatewayServer(options: GatewayServerOptions = {}) {
  const store = new CoordinationStore(options.dbPath ?? "runtime/ai-verse-bots/coordination.db");
  const executionQueue = new ExecutionQueue(store.dbPath);
  const gateway = new CoordinationGateway(store, executionQueue);
  const runtimes = new RuntimeRegistry().register(new DeterministicRuntimeAdapter());
  const runner = new BotRunner(store, gateway, executionQueue, runtimes);
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

      if (method === "POST" && url.pathname === "/v1/delegations") {
        const body = await readJson(req);
        const required = ["createdBy", "assigneeId", "workspaceId", "rootObjectiveId", "objective", "reason"];
        for (const key of required) {
          if (typeof body[key] !== "string" || String(body[key]).length === 0) throw new Error(`${key} is required`);
        }
        json(res, 201, gateway.delegate({
          createdBy: String(body.createdBy),
          assigneeId: String(body.assigneeId),
          workspaceId: String(body.workspaceId),
          rootObjectiveId: String(body.rootObjectiveId),
          objective: String(body.objective),
          reason: String(body.reason),
          requiredConstraints: Array.isArray(body.requiredConstraints) ? body.requiredConstraints.map(String) : [],
          expectedOutput: typeof body.expectedOutput === "object" && body.expectedOutput !== null ? body.expectedOutput as JsonObject : undefined,
          tools: Array.isArray(body.tools) ? body.tools.map(String) : [],
          connections: Array.isArray(body.connections) ? body.connections.map(String) : [],
          leaseExpiresAt: typeof body.leaseExpiresAt === "string" ? body.leaseExpiresAt : undefined
        }));
        return;
      }

      if (method === "POST" && url.pathname === "/v1/handoffs") {
        const body = await readJson(req);
        const required = ["sourceOwnerId", "targetOwnerId", "workspaceId", "workItemId", "rootObjectiveId", "reason"];
        for (const key of required) {
          if (typeof body[key] !== "string" || String(body[key]).length === 0) throw new Error(`${key} is required`);
        }
        json(res, 201, gateway.requestHandoff({
          sourceOwnerId: String(body.sourceOwnerId),
          targetOwnerId: String(body.targetOwnerId),
          workspaceId: String(body.workspaceId),
          workItemId: String(body.workItemId),
          rootObjectiveId: String(body.rootObjectiveId),
          reason: String(body.reason),
          requiredConstraints: Array.isArray(body.requiredConstraints) ? body.requiredConstraints.map(String) : [],
          artifactRefs: Array.isArray(body.artifactRefs) ? body.artifactRefs.map(String) : [],
          returnPolicy: typeof body.returnPolicy === "string" ? body.returnPolicy : undefined
        }));
        return;
      }

      const handoffAcceptMatch = url.pathname.match(/^\/v1\/handoffs\/([^/]+)\/accept$/);
      if (method === "POST" && handoffAcceptMatch) {
        const body = await readJson(req);
        if (typeof body.actorId !== "string" || body.actorId.length === 0) throw new Error("actorId is required");
        json(res, 200, gateway.acceptHandoff(decodeURIComponent(handoffAcceptMatch[1] as string), body.actorId));
        return;
      }

      if (method === "POST" && url.pathname === "/v1/messages") {
        const body = await readJson(req);
        const required = ["senderId", "targetKind", "targetId", "workspaceId", "text"];
        for (const key of required) {
          if (typeof body[key] !== "string" || String(body[key]).length === 0) throw new Error(`${key} is required`);
        }
        const result = gateway.sendMessage({
          senderId: String(body.senderId),
          targetKind: String(body.targetKind) as any,
          targetId: String(body.targetId),
          workspaceId: String(body.workspaceId),
          text: String(body.text),
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
    gateway,
    runtimes,
    runner,
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
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error: Error | undefined) => {
          executionQueue.close();
          store.close();
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}
