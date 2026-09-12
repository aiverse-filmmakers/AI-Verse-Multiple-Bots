import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { URL } from "node:url";
import { A2AJsonRpcRuntimeAdapter } from "./a2a-runtime.js";
import { AiVerseBrainObjectiveSource, BrainObjectiveIngress } from "./brain-objective-ingress.js";
import { AiVerseOsAutomationInvocationSource, AutomationWakeIngress } from "./automation-wake-ingress.js";
import { BrainObjectiveRuntimeRegistry } from "./brain-objective-runtime.js";
import { AiVerseMemoryRecallSource } from "./ai-verse-memory-recall.js";
import { AiVerseSkillsCapabilitySource } from "./ai-verse-skills-capability-resolution.js";
import { AiVerseOsWorkspaceProjector } from "./ai-verse-os-workspace-projection.js";
import { delegateWithArtifacts } from "./artifact-delegation.js";
import type { BudgetEnvelope } from "./budget.js";
import { CandidateWritebackRouter } from "./candidate-writeback.js";
import type { BotManifest, JsonObject } from "./types.js";
import { ExecutionQueue, type RecoveryPolicy } from "./execution-queue.js";
import { FourCsHealthProjector } from "./four-cs-health.js";
import { HermesStdioRuntimeAdapter } from "./hermes-runtime.js";
import { CoordinationGateway, type ApprovalRequirement } from "./gateway.js";
import { MemoryRecallRuntimeRegistry } from "./memory-recall-runtime.js";
import { OpenAICompatibleRuntimeAdapter } from "./openai-compatible-runtime.js";
import { AiVerseOsWriteCommandSink, OsWriteCommandBoundary } from "./os-write-command.js";
import { CoordinationPolicy } from "./policy.js";
import { RoomCoordinator } from "./rooms.js";
import { BotRunner } from "./runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "./runtime.js";
import { SkillsCapabilityRuntimeRegistry } from "./skills-capability-runtime.js";
import { CoordinationStore } from "./store.js";
import { ExecutionSupervisor } from "./supervisor.js";

export interface GatewayServerOptions {
  host?: string;
  port?: number;
  dbPath?: string;
  aiVerseOsRoot?: string;
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

function optionalStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`${key}[${index}] must be a string`);
    return item;
  });
}

export function createGatewayServer(options: GatewayServerOptions = {}) {
  const workspaceProjector = options.aiVerseOsRoot ? new AiVerseOsWorkspaceProjector(options.aiVerseOsRoot) : undefined;
  const brainObjectiveSource = options.aiVerseOsRoot ? new AiVerseBrainObjectiveSource(options.aiVerseOsRoot) : undefined;
  const memoryRecallSource = options.aiVerseOsRoot ? new AiVerseMemoryRecallSource(options.aiVerseOsRoot) : undefined;
  const skillsCapabilitySource = options.aiVerseOsRoot ? new AiVerseSkillsCapabilitySource(options.aiVerseOsRoot) : undefined;
  const automationInvocationSource = options.aiVerseOsRoot ? new AiVerseOsAutomationInvocationSource(options.aiVerseOsRoot) : undefined;
  const osWriteCommandSink = options.aiVerseOsRoot && existsSync(resolve(options.aiVerseOsRoot, "scripts/write-command.mjs"))
    ? new AiVerseOsWriteCommandSink(options.aiVerseOsRoot)
    : undefined;
  const store = new CoordinationStore(options.dbPath ?? "runtime/ai-verse-bots/coordination.db");
  const executionQueue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, executionQueue, policy);
  const rooms = new RoomCoordinator(store, gateway);
  const baseRuntimes = new RuntimeRegistry()
    .register(new DeterministicRuntimeAdapter())
    .register(new OpenAICompatibleRuntimeAdapter())
    .register(new A2AJsonRpcRuntimeAdapter())
    .register(new HermesStdioRuntimeAdapter());
  const skillsRuntimes = new SkillsCapabilityRuntimeRegistry(baseRuntimes, skillsCapabilitySource);
  const memoryRuntimes = new MemoryRecallRuntimeRegistry(skillsRuntimes, memoryRecallSource);
  const runtimes = brainObjectiveSource
    ? new BrainObjectiveRuntimeRegistry(memoryRuntimes, brainObjectiveSource)
    : memoryRuntimes;
  const runner = new BotRunner(
    store,
    gateway,
    executionQueue,
    runtimes,
    workspaceProjector ? { workspaceProjector } : undefined
  );
  const brainIngress = brainObjectiveSource
    ? new BrainObjectiveIngress(store, gateway, executionQueue, brainObjectiveSource)
    : undefined;
  const automationIngress = automationInvocationSource
    ? new AutomationWakeIngress(store, gateway, executionQueue, automationInvocationSource)
    : undefined;
  const osWriteCommands = osWriteCommandSink
    ? new OsWriteCommandBoundary(store, gateway, osWriteCommandSink)
    : undefined;
  const candidateWritebacks = osWriteCommands
    ? new CandidateWritebackRouter(gateway, osWriteCommands)
    : undefined;
  const fourCsHealth = new FourCsHealthProjector(store, executionQueue, {
    nativeMode: Boolean(options.aiVerseOsRoot),
    workspaceProjector,
    brainIngressAvailable: Boolean(brainIngress),
    memoryRecallAvailable: Boolean(memoryRecallSource),
    skillsResolutionAvailable: Boolean(skillsCapabilitySource),
    automationIngressAvailable: Boolean(automationIngress),
    osWriteCommandAvailable: Boolean(osWriteCommands),
    candidateWritebackAvailable: Boolean(candidateWritebacks)
  });
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

      if (method === "GET" && url.pathname === "/v1/health/4cs") {
        const workspaceId = url.searchParams.get("workspace") ?? undefined;
        json(res, 200, fourCsHealth.project(workspaceId));
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

      if (method === "POST" && url.pathname === "/v1/brain/objectives/ingest") {
        if (!brainIngress) throw new Error("Brain objective ingress requires native AI-Verse OS mode via serve --os-root PATH");
        const body = await readJson(req);
        const result = brainIngress.ingest({
          leaderId: requiredString(body, "leaderId"),
          workspaceId: requiredString(body, "workspaceId"),
          objectiveId: requiredString(body, "objectiveId"),
          reason: typeof body.reason === "string" ? body.reason : undefined,
          tools: Array.isArray(body.tools) ? body.tools.map(String) : [],
          connections: Array.isArray(body.connections) ? body.connections.map(String) : [],
          skillRefs: optionalStringArray(body.skillRefs, "skillRefs"),
          maxHops: typeof body.maxHops === "number" ? body.maxHops : undefined,
          leaseExpiresAt: typeof body.leaseExpiresAt === "string" ? body.leaseExpiresAt : undefined,
          deadlineAt: typeof body.deadlineAt === "string" ? body.deadlineAt : undefined,
          budget: typeof body.budget === "object" && body.budget !== null && !Array.isArray(body.budget)
            ? body.budget as BudgetEnvelope
            : undefined,
          approval: optionalApproval(body.approval)
        });
        json(res, result.created ? 201 : 200, result);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/automations/invoke") {
        if (!automationIngress) throw new Error("Automation invocation ingress requires native AI-Verse OS mode via serve --os-root PATH");
        const body = await readJson(req);
        const source = typeof body.source === "object" && body.source !== null && !Array.isArray(body.source)
          ? body.source as JsonObject
          : {};
        const target = typeof body.target === "object" && body.target !== null && !Array.isArray(body.target)
          ? body.target as JsonObject
          : {};
        const targetKind = requiredString(target, "kind");
        const result = automationIngress.ingest({
          automationId: requiredString(body, "automationId"),
          invocationId: requiredString(body, "invocationId"),
          workspaceId: requiredString(body, "workspaceId"),
          firedAt: requiredString(body, "firedAt"),
          source: {
            kind: requiredString(source, "kind") as any,
            path: requiredString(source, "path"),
            digest: requiredString(source, "digest")
          },
          target: targetKind === "bot"
            ? { kind: "bot", botId: requiredString(target, "botId") }
            : targetKind === "team_run"
              ? {
                  kind: "team_run",
                  leaderId: requiredString(target, "leaderId"),
                  topology: typeof target.topology === "string" ? target.topology as any : undefined
                }
              : { kind: targetKind } as any,
          objective: requiredString(body, "objective"),
          reason: typeof body.reason === "string" ? body.reason : undefined,
          requiredConstraints: optionalStringArray(body.requiredConstraints, "requiredConstraints"),
          expectedOutput: typeof body.expectedOutput === "object" && body.expectedOutput !== null && !Array.isArray(body.expectedOutput)
            ? body.expectedOutput as JsonObject
            : undefined,
          memoryRecall: body.memoryRecall as any,
          skillRefs: optionalStringArray(body.skillRefs, "skillRefs"),
          tools: optionalStringArray(body.tools, "tools"),
          connections: optionalStringArray(body.connections, "connections"),
          budget: typeof body.budget === "object" && body.budget !== null && !Array.isArray(body.budget)
            ? body.budget as BudgetEnvelope
            : undefined,
          maxHops: typeof body.maxHops === "number" ? body.maxHops : undefined,
          deadlineAt: typeof body.deadlineAt === "string" ? body.deadlineAt : undefined,
          leaseExpiresAt: typeof body.leaseExpiresAt === "string" ? body.leaseExpiresAt : undefined,
          approval: optionalApproval(body.approval),
          recoveryPolicy: optionalRecoveryPolicy(body.recoveryPolicy),
          maxAttempts: optionalMaxAttempts(body.maxAttempts)
        });
        json(res, result.created ? 201 : 200, result);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/candidates/write-back") {
        if (!candidateWritebacks) throw new Error("Candidate write-back requires native AI-Verse OS mode via serve --os-root PATH");
        const body = await readJson(req);
        if (typeof body.content !== "object" || body.content === null || Array.isArray(body.content)) {
          throw new Error("content must be an object");
        }
        const result = await candidateWritebacks.route({
          requestedBy: requiredString(body, "requestedBy"),
          workspaceId: requiredString(body, "workspaceId"),
          candidateKind: requiredString(body, "candidateKind") as any,
          sourceArtifactRef: requiredString(body, "sourceArtifactRef"),
          title: requiredString(body, "title"),
          summary: requiredString(body, "summary"),
          content: body.content as JsonObject,
          confidence: typeof body.confidence === "number" ? body.confidence : undefined,
          evidenceArtifactRefs: optionalStringArray(body.evidenceArtifactRefs, "evidenceArtifactRefs"),
          taskId: typeof body.taskId === "string" ? body.taskId : undefined,
          runId: typeof body.runId === "string" ? body.runId : undefined,
          idempotencyKey: requiredString(body, "idempotencyKey"),
          reason: requiredString(body, "reason"),
          createdAt: requiredString(body, "createdAt")
        });
        json(res, result.created ? 201 : 200, result);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/os/write-commands") {
        if (!osWriteCommands) throw new Error("OS write-command boundary requires native AI-Verse OS mode via serve --os-root PATH");
        const body = await readJson(req);
        const provenance = typeof body.provenance === "object" && body.provenance !== null && !Array.isArray(body.provenance)
          ? body.provenance as JsonObject
          : undefined;
        const result = await osWriteCommands.request({
          requestedBy: requiredString(body, "requestedBy"),
          scope: requiredString(body, "scope"),
          operation: requiredString(body, "operation"),
          parameters: typeof body.parameters === "object" && body.parameters !== null && !Array.isArray(body.parameters)
            ? body.parameters as JsonObject
            : (() => { throw new Error("parameters must be an object"); })(),
          idempotencyKey: requiredString(body, "idempotencyKey"),
          reason: requiredString(body, "reason"),
          createdAt: requiredString(body, "createdAt"),
          provenance: provenance ? {
            taskId: typeof provenance.taskId === "string" ? provenance.taskId : undefined,
            runId: typeof provenance.runId === "string" ? provenance.runId : undefined,
            artifactRefs: optionalStringArray(provenance.artifactRefs, "provenance.artifactRefs")
          } : undefined
        });
        json(res, result.created ? 201 : 200, result);
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
          memoryRecall: body.memoryRecall,
          skillRefs: body.skillRefs,
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
    brainObjectiveSource,
    brainIngress,
    automationInvocationSource,
    automationIngress,
    osWriteCommandSink,
    osWriteCommands,
    candidateWritebacks,
    fourCsHealth,
    memoryRecallSource,
    skillsCapabilitySource,
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
