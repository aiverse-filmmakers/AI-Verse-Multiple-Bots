import { createServer } from "node:http";
import { URL } from "node:url";
import { delegateWithArtifacts } from "./artifact-delegation.js";
import type { BudgetEnvelope } from "./budget.js";
import type { BotManifest, DeliveryState, JsonObject } from "./types.js";
import { ExecutionQueue, type RecoveryPolicy } from "./execution-queue.js";
import { CoordinationGateway, type ApprovalRequirement } from "./gateway.js";
import { ManagerTopologyCoordinator } from "./manager-topology.js";
import { OpenAICompatibleRuntimeAdapter } from "./openai-compatible-runtime.js";
import { CoordinationPolicy } from "./policy.js";
import { RoomCoordinator } from "./rooms.js";
import { BotRunner } from "./runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "./runtime.js";
import { CoordinationStore } from "./store.js";
import { ExecutionSupervisor } from "./supervisor.js";
import { TeamRunFanout } from "./team-run-fanout.js";
import { TeamRunHandoff } from "./team-run-handoff.js";
import { TeamRunDiscussion } from "./team-run-discussion.js";
import { TeamRunDisagreementDetector } from "./team-run-disagreement.js";
import { TeamRunVerifier } from "./team-run-verifier.js";
import { TeamRunSynthesis } from "./team-run-synthesis.js";
import { TeamRunCoordinator, type TeamRunStatus, type TeamRunTopology, type WorkerStatus } from "./team-runs.js";

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

function optionalApproval(value: unknown): ApprovalRequirement | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const approval = value as JsonObject;
  return {
    required: approval.required === true,
    reason: typeof approval.reason === "string" ? approval.reason : undefined,
    action: typeof approval.action === "object" && approval.action !== null && !Array.isArray(approval.action)
      ? approval.action as JsonObject
      : undefined
  };
}

function optionalReturnPolicy(value: unknown): "stay_with_target" | "return_on_completion" | "return_on_block" | "explicit_only" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "stay_with_target" || value === "return_on_completion" || value === "return_on_block" || value === "explicit_only") return value;
  throw new Error(`Invalid returnPolicy ${String(value)}`);
}

function optionalRecoveryPolicy(value: unknown): RecoveryPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "manual" || value === "retry_safe") return value;
  throw new Error(`Invalid recoveryPolicy ${String(value)}`);
}

function optionalMaxAttempts(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("maxAttempts must be a positive integer");
  return value;
}

export function createGatewayServer(options: GatewayServerOptions = {}) {
  const store = new CoordinationStore(options.dbPath ?? "runtime/ai-verse-bots/coordination.db");
  const executionQueue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, executionQueue, policy);
  const rooms = new RoomCoordinator(store, gateway);
  const teamRuns = new TeamRunCoordinator(store, gateway, policy);
  const managerTopology = new ManagerTopologyCoordinator(store, gateway, teamRuns, executionQueue);
  const runtimes = new RuntimeRegistry()
    .register(new DeterministicRuntimeAdapter())
    .register(new OpenAICompatibleRuntimeAdapter());
  const runner = new BotRunner(store, gateway, executionQueue, runtimes);
  const fanout = new TeamRunFanout(teamRuns, gateway, executionQueue, runner);
  const handoffs = new TeamRunHandoff(teamRuns, gateway, executionQueue, runner);
  const discussion = new TeamRunDiscussion(teamRuns, gateway, executionQueue, runner);
  const disagreement = new TeamRunDisagreementDetector(teamRuns, gateway);
  const verifier = new TeamRunVerifier(teamRuns, gateway, executionQueue, runner);
  const synthesis = new TeamRunSynthesis(teamRuns, gateway, executionQueue, runner);
  const supervisor = new ExecutionSupervisor(gateway, executionQueue, runner, 5000, managerTopology, fanout, handoffs, discussion, verifier, synthesis);
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

      if (method === "GET" && url.pathname === "/v1/bots/resolve") {
        const address = url.searchParams.get("address");
        if (!address) throw new Error("address is required");
        const workspaceId = url.searchParams.get("workspace");
        const scope = url.searchParams.get("scope");
        const bot = scope === "operator"
          ? gateway.resolveOperatorBotAddress(address, true)
          : workspaceId
            ? gateway.resolveBotAddress(workspaceId, address, true)
            : null;
        if (!bot) {
          json(res, 404, { error: "NOT_FOUND" });
          return;
        }
        json(res, 200, bot);
        return;
      }

      const botLifecycleMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/(activate|disable|archive)$/);
      if (method === "POST" && botLifecycleMatch) {
        const body = await readJson(req);
        const botId = decodeURIComponent(botLifecycleMatch[1] as string);
        const action = botLifecycleMatch[2] as "activate" | "disable" | "archive";
        const targetStatus = action === "activate" ? "active" : action === "disable" ? "disabled" : "archived";
        json(res, 200, gateway.transitionBot(botId, targetStatus, requiredString(body, "actorId")));
        return;
      }

      const botGetMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)$/);
      if (method === "GET" && botGetMatch) {
        const bot = gateway.getBot(decodeURIComponent(botGetMatch[1] as string));
        if (!bot) {
          json(res, 404, { error: "NOT_FOUND" });
          return;
        }
        json(res, 200, bot);
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

      if (method === "GET" && url.pathname === "/v1/recovery/dead-letters") {
        json(res, 200, { executions: supervisor.recovery.listDeadLetters(url.searchParams.get("workspace") ?? undefined) });
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

      if (method === "GET" && url.pathname === "/v1/team-runs") {
        json(res, 200, { runs: teamRuns.listRuns(url.searchParams.get("workspace") ?? undefined) });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/team-runs") {
        const body = await readJson(req);
        json(res, 201, teamRuns.createRun({
          createdBy: requiredString(body, "createdBy"),
          leaderId: requiredString(body, "leaderId"),
          workspaceId: requiredString(body, "workspaceId"),
          rootObjectiveId: requiredString(body, "rootObjectiveId"),
          topology: typeof body.topology === "string" ? body.topology as TeamRunTopology : undefined,
          budget: typeof body.budget === "object" && body.budget !== null && !Array.isArray(body.budget) ? body.budget as BudgetEnvelope : undefined,
          parentTaskId: typeof body.parentTaskId === "string" ? body.parentTaskId : undefined,
          reason: typeof body.reason === "string" ? body.reason : undefined
        }));
        return;
      }

      const teamRunEventsMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/events$/);
      if (method === "GET" && teamRunEventsMatch) {
        const runId = decodeURIComponent(teamRunEventsMatch[1] as string);
        const after = Number(url.searchParams.get("after") ?? "0");
        const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 1000);
        json(res, 200, { events: store.listRunEvents(runId, after, limit) });
        return;
      }

      const teamRunWorkersMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/workers$/);
      if (method === "GET" && teamRunWorkersMatch) {
        json(res, 200, { workers: teamRuns.listWorkers(decodeURIComponent(teamRunWorkersMatch[1] as string)) });
        return;
      }
      if (method === "POST" && teamRunWorkersMatch) {
        const body = await readJson(req);
        const role = typeof body.role === "object" && body.role !== null && !Array.isArray(body.role) ? body.role as JsonObject : {};
        json(res, 201, teamRuns.spawnWorker({
          runId: decodeURIComponent(teamRunWorkersMatch[1] as string),
          createdBy: requiredString(body, "createdBy"),
          role: {
            title: requiredString(role, "title"),
            objective: requiredString(role, "objective")
          },
          requiredConstraints: Array.isArray(body.requiredConstraints) ? body.requiredConstraints.map(String) : [],
          expectedOutput: typeof body.expectedOutput === "object" && body.expectedOutput !== null && !Array.isArray(body.expectedOutput)
            ? body.expectedOutput as JsonObject
            : undefined,
          tools: Array.isArray(body.tools) ? body.tools.map(String) : [],
          connections: Array.isArray(body.connections) ? body.connections.map(String) : [],
          budget: typeof body.budget === "object" && body.budget !== null && !Array.isArray(body.budget) ? body.budget as BudgetEnvelope : undefined,
          deadlineAt: typeof body.deadlineAt === "string" ? body.deadlineAt : undefined,
          leaseExpiresAt: typeof body.leaseExpiresAt === "string" ? body.leaseExpiresAt : undefined,
          runtimeAdapter: typeof body.runtimeAdapter === "string" ? body.runtimeAdapter : undefined,
          runtimeProfileRef: body.runtimeProfileRef === null || typeof body.runtimeProfileRef === "string" ? body.runtimeProfileRef as string | null : undefined,
          environmentPolicy: typeof body.environmentPolicy === "string" ? body.environmentPolicy as any : undefined,
          environmentRef: typeof body.environmentRef === "string" ? body.environmentRef : undefined
        }));
        return;
      }

      const discussionRunMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/discussions$/);
      if (method === "GET" && discussionRunMatch) {
        json(res, 200, { discussions: discussion.list(decodeURIComponent(discussionRunMatch[1] as string)) });
        return;
      }
      if (method === "POST" && discussionRunMatch) {
        const body = await readJson(req);
        if (!Array.isArray(body.speakers)) throw new Error("speakers must be an array");
        json(res, 201, discussion.open({
          runId: decodeURIComponent(discussionRunMatch[1] as string),
          createdBy: requiredString(body, "createdBy"),
          topic: requiredString(body, "topic"),
          speakers: body.speakers.map((value) => {
            const speaker = typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
            return { key: requiredString(speaker, "key"), roleTitle: requiredString(speaker, "roleTitle"), objective: requiredString(speaker, "objective"), tools: Array.isArray(speaker.tools) ? speaker.tools.map(String) : [], connections: Array.isArray(speaker.connections) ? speaker.connections.map(String) : [], budget: typeof speaker.budget === "object" && speaker.budget !== null && !Array.isArray(speaker.budget) ? speaker.budget as BudgetEnvelope : undefined, runtimeAdapter: typeof speaker.runtimeAdapter === "string" ? speaker.runtimeAdapter : undefined, runtimeProfileRef: speaker.runtimeProfileRef === null || typeof speaker.runtimeProfileRef === "string" ? speaker.runtimeProfileRef as string | null : undefined, environmentPolicy: typeof speaker.environmentPolicy === "string" ? speaker.environmentPolicy as any : undefined, environmentRef: typeof speaker.environmentRef === "string" ? speaker.environmentRef : undefined };
          }),
          rounds: typeof body.rounds === "number" ? body.rounds : undefined,
          maxMessages: typeof body.maxMessages === "number" ? body.maxMessages : undefined,
          requiredConstraints: Array.isArray(body.requiredConstraints) ? body.requiredConstraints.map(String) : [],
          recoveryPolicy: optionalRecoveryPolicy(body.recoveryPolicy),
          maxAttempts: optionalMaxAttempts(body.maxAttempts)
        }));
        return;
      }

      const discussionGetMatch = url.pathname.match(/^\/v1\/discussions\/([^/]+)$/);
      if (method === "GET" && discussionGetMatch) {
        const found = discussion.get(decodeURIComponent(discussionGetMatch[1] as string));
        if (!found) { json(res, 404, { error: "NOT_FOUND" }); return; }
        json(res, 200, { discussion: found, candidateArtifacts: discussion.candidateArtifacts(found.id) });
        return;
      }

      const discussionCancelMatch = url.pathname.match(/^\/v1\/discussions\/([^/]+)\/cancel$/);
      if (method === "POST" && discussionCancelMatch) {
        const body = await readJson(req);
        json(res, 200, await discussion.cancel(decodeURIComponent(discussionCancelMatch[1] as string), requiredString(body, "actorId"), typeof body.reason === "string" ? body.reason : undefined));
        return;
      }

      const disagreementRunMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/disagreement$/);
      if (method === "GET" && disagreementRunMatch) {
        const runId = decodeURIComponent(disagreementRunMatch[1] as string);
        json(res, 200, {
          latest: disagreement.latest(runId),
          reports: disagreement.list(runId),
          verificationDebt: disagreement.verificationDebt(runId)
        });
        return;
      }
      if (method === "POST" && disagreementRunMatch) {
        const body = await readJson(req);
        json(res, 201, disagreement.analyze({
          runId: decodeURIComponent(disagreementRunMatch[1] as string),
          actorId: requiredString(body, "actorId"),
          artifactRefs: Array.isArray(body.artifactRefs) ? body.artifactRefs.map(String) : undefined,
          confidenceGapThreshold: typeof body.confidenceGapThreshold === "number" ? body.confidenceGapThreshold : undefined,
          maxArtifacts: typeof body.maxArtifacts === "number" ? body.maxArtifacts : undefined
        }));
        return;
      }

      const verificationCancelMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/verification\/cancel$/);
      if (method === "POST" && verificationCancelMatch) {
        const body = await readJson(req);
        json(res, 200, await verifier.cancel(
          decodeURIComponent(verificationCancelMatch[1] as string),
          requiredString(body, "actorId"),
          typeof body.reason === "string" ? body.reason : undefined
        ));
        return;
      }

      const verificationRunMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/verification$/);
      if (method === "GET" && verificationRunMatch) {
        const runId = decodeURIComponent(verificationRunMatch[1] as string);
        const run = teamRuns.getRun(runId);
        if (!run) { json(res, 404, { error: "NOT_FOUND" }); return; }
        json(res, 200, {
          latest: verifier.latest(runId),
          verdicts: verifier.list(runId),
          pendingReportRefs: Array.isArray(run.payload.verification_required_report_refs) ? run.payload.verification_required_report_refs : [],
          activeTaskId: typeof run.payload.active_verification_task_id === "string" ? run.payload.active_verification_task_id : null,
          readyForSynthesis: run.payload.verification_ready_for_synthesis === true
        });
        return;
      }
      if (method === "POST" && verificationRunMatch) {
        const body = await readJson(req);
        json(res, 202, verifier.schedule({
          runId: decodeURIComponent(verificationRunMatch[1] as string),
          createdBy: requiredString(body, "createdBy"),
          reportRefs: Array.isArray(body.reportRefs) ? body.reportRefs.map(String) : undefined,
          runtimeAdapter: typeof body.runtimeAdapter === "string" ? body.runtimeAdapter : undefined,
          runtimeProfileRef: body.runtimeProfileRef === null || typeof body.runtimeProfileRef === "string" ? body.runtimeProfileRef as string | null : undefined,
          environmentPolicy: typeof body.environmentPolicy === "string" ? body.environmentPolicy as any : undefined,
          environmentRef: typeof body.environmentRef === "string" ? body.environmentRef : undefined,
          tools: Array.isArray(body.tools) ? body.tools.map(String) : [],
          connections: Array.isArray(body.connections) ? body.connections.map(String) : [],
          budget: typeof body.budget === "object" && body.budget !== null && !Array.isArray(body.budget) ? body.budget as BudgetEnvelope : undefined,
          deadlineAt: typeof body.deadlineAt === "string" ? body.deadlineAt : undefined,
          leaseExpiresAt: typeof body.leaseExpiresAt === "string" ? body.leaseExpiresAt : undefined,
          recoveryPolicy: optionalRecoveryPolicy(body.recoveryPolicy),
          maxAttempts: optionalMaxAttempts(body.maxAttempts)
        }));
        return;
      }

      const synthesisCancelMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/synthesis\/cancel$/);
      if (method === "POST" && synthesisCancelMatch) {
        const body = await readJson(req);
        json(res, 200, await synthesis.cancel(
          decodeURIComponent(synthesisCancelMatch[1] as string),
          requiredString(body, "actorId"),
          typeof body.reason === "string" ? body.reason : undefined
        ));
        return;
      }

      const synthesisRunMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/synthesis$/);
      if (method === "GET" && synthesisRunMatch) {
        const runId = decodeURIComponent(synthesisRunMatch[1] as string);
        if (!teamRuns.getRun(runId)) { json(res, 404, { error: "NOT_FOUND" }); return; }
        json(res, 200, synthesis.state(runId));
        return;
      }
      if (method === "POST" && synthesisRunMatch) {
        const body = await readJson(req);
        const result = synthesis.schedule({
          runId: decodeURIComponent(synthesisRunMatch[1] as string),
          createdBy: requiredString(body, "createdBy"),
          artifactRefs: Array.isArray(body.artifactRefs) ? body.artifactRefs.map(String) : undefined,
          tools: Array.isArray(body.tools) ? body.tools.map(String) : [],
          connections: Array.isArray(body.connections) ? body.connections.map(String) : [],
          budget: typeof body.budget === "object" && body.budget !== null && !Array.isArray(body.budget) ? body.budget as BudgetEnvelope : undefined,
          deadlineAt: typeof body.deadlineAt === "string" ? body.deadlineAt : undefined,
          leaseExpiresAt: typeof body.leaseExpiresAt === "string" ? body.leaseExpiresAt : undefined,
          recoveryPolicy: optionalRecoveryPolicy(body.recoveryPolicy),
          maxAttempts: optionalMaxAttempts(body.maxAttempts)
        });
        json(res, result.status === "scheduled" ? 202 : 200, result);
        return;
      }

      const directScheduleMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/handoff\/schedule$/);
      if (method === "POST" && directScheduleMatch) {
        const body = await readJson(req);
        json(res, 202, handoffs.scheduleInitialWorker({
          runId: decodeURIComponent(directScheduleMatch[1] as string),
          workerId: requiredString(body, "workerId"),
          actorId: requiredString(body, "actorId"),
          recoveryPolicy: optionalRecoveryPolicy(body.recoveryPolicy),
          maxAttempts: optionalMaxAttempts(body.maxAttempts)
        }));
        return;
      }

      const directRequestMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/handoffs$/);
      if (method === "POST" && directRequestMatch) {
        const body = await readJson(req);
        json(res, 201, handoffs.request({
          runId: decodeURIComponent(directRequestMatch[1] as string),
          sourceOwnerId: requiredString(body, "sourceOwnerId"),
          targetOwnerId: requiredString(body, "targetOwnerId"),
          taskId: requiredString(body, "taskId"),
          reason: requiredString(body, "reason"),
          requiredConstraints: Array.isArray(body.requiredConstraints) ? body.requiredConstraints.map(String) : [],
          artifactRefs: Array.isArray(body.artifactRefs) ? body.artifactRefs.map(String) : [],
          returnPolicy: optionalReturnPolicy(body.returnPolicy)
        }));
        return;
      }

      const directAcceptMatch = url.pathname.match(/^\/v1\/team-run-handoffs\/([^/]+)\/accept$/);
      if (method === "POST" && directAcceptMatch) {
        const body = await readJson(req);
        json(res, 200, handoffs.accept(decodeURIComponent(directAcceptMatch[1] as string), requiredString(body, "actorId")));
        return;
      }

      const directRejectMatch = url.pathname.match(/^\/v1\/team-run-handoffs\/([^/]+)\/reject$/);
      if (method === "POST" && directRejectMatch) {
        const body = await readJson(req);
        json(res, 200, handoffs.reject(decodeURIComponent(directRejectMatch[1] as string), requiredString(body, "actorId"), typeof body.reason === "string" ? body.reason : undefined));
        return;
      }

      const directCancelMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/handoff\/cancel$/);
      if (method === "POST" && directCancelMatch) {
        const body = await readJson(req);
        json(res, 200, await handoffs.cancelRun(decodeURIComponent(directCancelMatch[1] as string), requiredString(body, "actorId"), typeof body.reason === "string" ? body.reason : undefined));
        return;
      }

      const managerScheduleMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/manager\/schedule$/);
      if (method === "POST" && managerScheduleMatch) {
        const body = await readJson(req);
        json(res, 202, managerTopology.schedule({
          runId: decodeURIComponent(managerScheduleMatch[1] as string),
          workerId: requiredString(body, "workerId"),
          actorId: requiredString(body, "actorId")
        }));
        return;
      }

      const managerStateMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/manager$/);
      if (method === "GET" && managerStateMatch) {
        json(res, 200, { state: managerTopology.getState(decodeURIComponent(managerStateMatch[1] as string)) });
        return;
      }

      const teamRunTransitionMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)\/transition$/);
      if (method === "POST" && teamRunTransitionMatch) {
        const body = await readJson(req);
        json(res, 200, teamRuns.transitionRun(
          decodeURIComponent(teamRunTransitionMatch[1] as string),
          requiredString(body, "status") as TeamRunStatus,
          requiredString(body, "actorId"),
          typeof body.reason === "string" ? body.reason : undefined
        ));
        return;
      }

      const workerTransitionMatch = url.pathname.match(/^\/v1\/workers\/([^/]+)\/transition$/);
      if (method === "POST" && workerTransitionMatch) {
        const body = await readJson(req);
        json(res, 200, teamRuns.transitionWorker(
          decodeURIComponent(workerTransitionMatch[1] as string),
          requiredString(body, "status") as WorkerStatus,
          requiredString(body, "actorId"),
          typeof body.reason === "string" ? body.reason : undefined
        ));
        return;
      }

      const teamRunGetMatch = url.pathname.match(/^\/v1\/team-runs\/([^/]+)$/);
      if (method === "GET" && teamRunGetMatch) {
        const run = teamRuns.getRun(decodeURIComponent(teamRunGetMatch[1] as string));
        if (!run) {
          json(res, 404, { error: "NOT_FOUND" });
          return;
        }
        json(res, 200, run);
        return;
      }

      if (method === "GET" && url.pathname === "/v1/approvals") {
        json(res, 200, {
          approvals: gateway.listApprovals(
            url.searchParams.get("workspace") ?? undefined,
            url.searchParams.get("status") ?? undefined
          )
        });
        return;
      }

      const approvalApproveMatch = url.pathname.match(/^\/v1\/approvals\/([^/]+)\/approve$/);
      if (method === "POST" && approvalApproveMatch) {
        const body = await readJson(req);
        json(res, 200, gateway.approve(
          decodeURIComponent(approvalApproveMatch[1] as string),
          requiredString(body, "actorId")
        ));
        return;
      }

      const approvalDenyMatch = url.pathname.match(/^\/v1\/approvals\/([^/]+)\/deny$/);
      if (method === "POST" && approvalDenyMatch) {
        const body = await readJson(req);
        json(res, 200, gateway.rejectApproval(
          decodeURIComponent(approvalDenyMatch[1] as string),
          requiredString(body, "actorId"),
          typeof body.reason === "string" ? body.reason : "Denied by operator"
        ));
        return;
      }

      const taskEscalateMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/escalate$/);
      if (method === "POST" && taskEscalateMatch) {
        const body = await readJson(req);
        json(res, 202, gateway.requestUserEscalation({
          taskId: decodeURIComponent(taskEscalateMatch[1] as string),
          actorId: requiredString(body, "actorId"),
          reason: requiredString(body, "reason")
        }));
        return;
      }

      const taskCancelMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
      if (method === "POST" && taskCancelMatch) {
        const body = await readJson(req);
        const result = await runner.cancelTask(
          decodeURIComponent(taskCancelMatch[1] as string),
          requiredString(body, "actorId"),
          typeof body.reason === "string" ? body.reason : "Canceled by operator or owner"
        );
        json(res, 200, result);
        return;
      }

      const taskRetryMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/retry$/);
      if (method === "POST" && taskRetryMatch) {
        const body = await readJson(req);
        const result = supervisor.retryDeadLetter(
          decodeURIComponent(taskRetryMatch[1] as string),
          requiredString(body, "actorId"),
          typeof body.reason === "string" ? body.reason : undefined
        );
        json(res, 200, result);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/delegations") {
        const body = await readJson(req);
        const result = delegateWithArtifacts(gateway, {
          createdBy: requiredString(body, "createdBy"),
          assigneeId: requiredString(body, "assigneeId"),
          workspaceId: requiredString(body, "workspaceId"),
          rootObjectiveId: requiredString(body, "rootObjectiveId"),
          objective: requiredString(body, "objective"),
          reason: requiredString(body, "reason"),
          requiredConstraints: Array.isArray(body.requiredConstraints) ? body.requiredConstraints.map(String) : [],
          expectedOutput: typeof body.expectedOutput === "object" && body.expectedOutput !== null ? body.expectedOutput as JsonObject : undefined,
          inputArtifactRefs: Array.isArray(body.inputArtifactRefs) ? body.inputArtifactRefs.map(String) : [],
          tools: Array.isArray(body.tools) ? body.tools.map(String) : [],
          connections: Array.isArray(body.connections) ? body.connections.map(String) : [],
          parentTaskId: typeof body.parentTaskId === "string" ? body.parentTaskId : undefined,
          hop: typeof body.hop === "number" ? body.hop : undefined,
          maxHops: typeof body.maxHops === "number" ? body.maxHops : undefined,
          leaseExpiresAt: typeof body.leaseExpiresAt === "string" ? body.leaseExpiresAt : undefined,
          deadlineAt: typeof body.deadlineAt === "string" ? body.deadlineAt : undefined,
          budget: typeof body.budget === "object" && body.budget !== null && !Array.isArray(body.budget)
            ? body.budget as BudgetEnvelope
            : undefined,
          approval: optionalApproval(body.approval)
        });
        const recoveryPolicy = optionalRecoveryPolicy(body.recoveryPolicy);
        const maxAttempts = optionalMaxAttempts(body.maxAttempts);
        if (recoveryPolicy !== undefined || maxAttempts !== undefined) {
          executionQueue.setRecoveryPolicy(result.task.id, recoveryPolicy ?? "manual", maxAttempts);
        }
        json(res, 201, result);
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
          returnPolicy: optionalReturnPolicy(body.returnPolicy)
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

      const handoffRejectMatch = url.pathname.match(/^\/v1\/handoffs\/([^/]+)\/reject$/);
      if (method === "POST" && handoffRejectMatch) {
        const body = await readJson(req);
        json(res, 200, gateway.rejectHandoff(
          decodeURIComponent(handoffRejectMatch[1] as string),
          requiredString(body, "actorId"),
          typeof body.reason === "string" ? body.reason : "Handoff rejected"
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
          idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
          expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined
        });
        json(res, 202, result);
        return;
      }

      const messageDeliveryMatch = url.pathname.match(/^\/v1\/messages\/([^/]+)\/delivery$/);
      if (messageDeliveryMatch && method === "GET") {
        const delivery = gateway.mailbox.getDelivery(decodeURIComponent(messageDeliveryMatch[1] as string));
        if (!delivery) {
          json(res, 404, { error: "NOT_FOUND" });
          return;
        }
        json(res, 200, delivery);
        return;
      }
      if (messageDeliveryMatch && method === "POST") {
        const body = await readJson(req);
        json(res, 200, gateway.transitionMessageDelivery(
          decodeURIComponent(messageDeliveryMatch[1] as string),
          {
            state: requiredString(body, "state") as DeliveryState,
            actorId: requiredString(body, "actorId"),
            reason: typeof body.reason === "string" ? body.reason : undefined,
            replyMessageId: typeof body.replyMessageId === "string" ? body.replyMessageId : undefined
          }
        ));
        return;
      }

      const mailboxMatch = url.pathname.match(/^\/v1\/mailbox\/([^/]+)$/);
      if (method === "GET" && mailboxMatch) {
        const requestedStates = url.searchParams.get("states");
        const states = requestedStates
          ? requestedStates.split(",").map((item) => item.trim()).filter(Boolean) as DeliveryState[]
          : undefined;
        json(res, 200, { deliveries: gateway.mailbox.list(decodeURIComponent(mailboxMatch[1] as string), states) });
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
    teamRuns,
    managerTopology,
    fanout,
    handoffs,
    discussion,
    disagreement,
    verifier,
    synthesis,
    runtimes,
    runner,
    supervisor,
    recovery: supervisor.recovery,
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