import type { BudgetEnvelope } from "./budget.js";
import { BotRegistryError, BotRegistryRules, type BotLifecycleStatus } from "./bot-registry.js";
import { constraintsDigest, normalizeConstraints } from "./constraints.js";
import { createId } from "./id.js";
import { MailboxCoordinator } from "./mailbox.js";
import type { MailboxTransitionInput, MailboxWakeListener, SendMessageInput } from "./mailbox.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CanonicalEventBus } from "./event-bus.js";
import { CoordinationPolicy } from "./policy.js";
import { CoordinationStore } from "./store.js";
import type { AppendedEvent, BotManifest, CoordinationEvent, DeliveryRecord, JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

function nowIso(): string {
  return new Date().toISOString();
}

function objectValue(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export type { MailboxTransitionInput, MailboxWake, MailboxWakeListener, SendMessageInput } from "./mailbox.js";

export interface ResponseTarget {
  kind: "bot" | "room" | "thread" | "operator";
  id: string;
  roomId?: string;
  threadId?: string;
}

export interface ApprovalRequirement {
  required: boolean;
  action?: JsonObject;
  reason?: string;
}

export interface DelegateInput {
  createdBy: string;
  assigneeId: string;
  workspaceId: string;
  rootObjectiveId: string;
  objective: string;
  reason: string;
  requiredConstraints?: string[];
  expectedOutput?: JsonObject;
  inputArtifactRefs?: string[];
  tools?: string[];
  connections?: string[];
  parentTaskId?: string;
  maxHops?: number;
  hop?: number;
  leaseExpiresAt?: string;
  deadlineAt?: string;
  budget?: BudgetEnvelope;
  approval?: ApprovalRequirement;
  responseTarget?: ResponseTarget;
}

export interface HandoffInput {
  sourceOwnerId: string;
  targetOwnerId: string;
  workspaceId: string;
  workItemId: string;
  rootObjectiveId: string;
  reason: string;
  requiredConstraints?: string[];
  artifactRefs?: string[];
  returnPolicy?: "stay_with_target" | "return_on_completion" | "return_on_block" | "explicit_only";
}

export interface PublishRoomMessageInput {
  senderId: string;
  roomId: string;
  workspaceId: string;
  text: string;
  threadId?: string;
  mentions?: string[];
  artifactRefs?: string[];
  correlationId?: string;
  replyToMessageId?: string;
}

interface EmitInput {
  type: string;
  actorId: string;
  workspaceId?: string | null;
  roomId?: string | null;
  threadId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  traceId?: string | null;
  summary?: string | null;
  attentionState?: string;
  idempotencyKey?: string;
}

export class CoordinationGateway {
  readonly registry: BotRegistryRules;
  readonly events: CanonicalEventBus;
  readonly mailbox: MailboxCoordinator;

  constructor(
    readonly store: CoordinationStore,
    readonly executionQueue?: ExecutionQueue,
    readonly policy?: CoordinationPolicy
  ) {
    this.events = new CanonicalEventBus(store);
    this.registry = new BotRegistryRules(store);
    this.mailbox = new MailboxCoordinator(store, this.events, policy);
  }

  subscribeEvents(listener: (event: AppendedEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  subscribeMailboxWake(targetId: string, listener: MailboxWakeListener, replayPending = true): () => void {
    return this.mailbox.subscribeWake(targetId, listener, replayPending);
  }

  createBot(manifest: BotManifest): StoredObject<BotManifest> {
    const bot = this.registry.prepareCreate(manifest);
    const stored = this.store.putObject("bot", bot) as StoredObject<BotManifest>;
    this.emit({
      type: "bot.created",
      actorId: bot.id,
      workspaceId: stored.workspaceId,
      summary: `Created Bot ${bot.name}`
    });
    return stored;
  }

  transitionBot(botId: string, targetStatus: BotLifecycleStatus, actorId: string): StoredObject<BotManifest> {
    this.assertOperatorDecision(actorId);
    const plan = this.registry.prepareTransition(botId, targetStatus);
    const stored = this.store.putObject("bot", plan.payload) as StoredObject<BotManifest>;
    const eventType = targetStatus === "active" ? "bot.activated" : targetStatus === "disabled" ? "bot.disabled" : "bot.archived";
    this.emit({
      type: eventType,
      actorId,
      workspaceId: stored.workspaceId,
      summary: `${actorId} changed ${botId} from ${plan.previousStatus} to ${targetStatus}`
    });
    return stored;
  }

  resolveBotAddress(workspaceId: string, address: string, includeDisabled = true): StoredObject<BotManifest> | null {
    return this.registry.resolveAddress(workspaceId, address, includeDisabled);
  }

  resolveOperatorBotAddress(address: string, includeDisabled = true): StoredObject<BotManifest> | null {
    return this.registry.resolveOperatorAddress(address, includeDisabled);
  }

  listBots(workspaceId?: string): StoredObject<BotManifest>[] {
    return this.store.listObjects("bot", workspaceId) as StoredObject<BotManifest>[];
  }

  getBot(id: string): StoredObject<BotManifest> | null {
    const object = this.store.getObject(id);
    return object?.kind === "bot" ? object as StoredObject<BotManifest> : null;
  }

  listApprovals(workspaceId?: string, status?: string): StoredObject[] {
    return this.store.listObjects("approval", workspaceId)
      .filter((approval) => !status || approval.payload.status === status);
  }

  record(kind: Parameters<CoordinationStore["putObject"]>[0], payload: JsonObject): StoredObject {
    if (kind === "bot") {
      throw new BotRegistryError(
        "BOT_REGISTRY_WRITE_REQUIRED",
        "Durable Bot writes must pass through the Bot Registry create/lifecycle boundary"
      );
    }
    return this.store.putObject(kind, validateProtocolObject(payload, kind));
  }

  delegate(input: DelegateInput): {
    task: StoredObject;
    lease: StoredObject;
    environmentLease: StoredObject | null;
    approval: StoredObject | null;
    event: AppendedEvent;
  } {
    const prepared = this.policy?.prepareDelegation({
      createdBy: input.createdBy,
      assigneeId: input.assigneeId,
      workspaceId: input.workspaceId,
      rootObjectiveId: input.rootObjectiveId,
      objective: input.objective,
      requiredConstraints: input.requiredConstraints,
      tools: input.tools,
      connections: input.connections,
      parentTaskId: input.parentTaskId,
      hop: input.hop,
      maxHops: input.maxHops,
      deadlineAt: input.deadlineAt,
      budget: input.budget
    }) ?? {
      parentTaskId: input.parentTaskId ?? null,
      requiredConstraints: input.requiredConstraints ?? [],
      hop: input.hop ?? 0,
      maxHops: input.maxHops ?? 6,
      deadlineAt: input.deadlineAt ?? null,
      budget: input.budget ?? {}
    };

    const inputArtifacts = this.validateDelegationInputArtifacts(input.workspaceId, input.inputArtifactRefs);
    const inputArtifactRefs = inputArtifacts.map((artifact) => artifact.id);
    const taskId = createId("task");
    const leaseId = createId("lease");
    const approvalRequired = input.approval?.required === true;
    const approvalId = approvalRequired ? createId("approval") : null;
    const normalizedConstraints = normalizeConstraints(prepared.requiredConstraints);
    const rootOwnerId = this.resolveDelegationRootOwner(prepared.parentTaskId, input.createdBy);
    const leaseExpiresAt = input.leaseExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const lease: JsonObject = validateProtocolObject({
      schema_version: "1.0",
      id: leaseId,
      type: "capability_lease",
      principal: input.createdBy,
      issued_to: input.assigneeId,
      workspace_id: input.workspaceId,
      task_id: taskId,
      tools: [...new Set(input.tools ?? [])],
      connections: [...new Set(input.connections ?? [])],
      destructive_actions: approvalRequired ? "approval_required" : "deny",
      expires_at: leaseExpiresAt
    }, "capability_lease");

    const environmentLeasePayload = this.prepareDelegationEnvironmentLease(
      input.assigneeId,
      input.workspaceId,
      taskId,
      leaseExpiresAt
    );

    const task: JsonObject = validateProtocolObject({
      schema_version: "1.0",
      id: taskId,
      type: "task.delegate",
      created_by: input.createdBy,
      assignee_id: input.assigneeId,
      owner_id: input.assigneeId,
      root_owner_id: rootOwnerId,
      workspace_id: input.workspaceId,
      root_objective_id: input.rootObjectiveId,
      parent_task_id: prepared.parentTaskId,
      reason: input.reason,
      objective: input.objective,
      required_constraints: normalizedConstraints,
      constraints_digest: constraintsDigest(normalizedConstraints),
      expected_output: input.expectedOutput ?? { contract: "artifact-or-structured-result" },
      input_artifact_refs: inputArtifactRefs,
      lease_id: leaseId,
      environment_lease_id: environmentLeasePayload?.id ?? null,
      response_target: input.responseTarget ?? null,
      deadline_at: prepared.deadlineAt,
      budget: prepared.budget,
      approval_id: approvalId,
      hop: prepared.hop,
      max_hops: prepared.maxHops,
      status: approvalRequired ? "waiting_approval" : "assigned"
    }, "task");

    let approvalPayload: JsonObject | null = null;
    if (approvalRequired && approvalId) {
      const requestedAction = objectValue(input.approval?.action);
      const approvalAction: JsonObject = {
        ...requestedAction,
        kind: typeof requestedAction.kind === "string" && requestedAction.kind.length > 0 ? requestedAction.kind : "task.execute",
        summary: typeof requestedAction.summary === "string" && requestedAction.summary.length > 0
          ? requestedAction.summary
          : `Execute Task ${taskId}: ${input.objective}`,
        task_id: taskId
      };
      approvalPayload = validateProtocolObject({
        schema_version: "1.0",
        id: approvalId,
        type: "approval",
        workspace_id: input.workspaceId,
        actor_id: input.assigneeId,
        task_id: taskId,
        requested_by: input.createdBy,
        requested_at: nowIso(),
        status: "pending",
        reason: input.approval?.reason ?? input.reason,
        action: approvalAction
      }, "approval");
    }

    // All references and protocol objects are validated before the first durable write.
    const storedLease = this.store.putObject("capability_lease", lease);
    const storedEnvironmentLease = environmentLeasePayload
      ? this.store.putObject("environment_lease", environmentLeasePayload)
      : null;
    const storedTask = this.store.putObject("task", task);

    if (approvalPayload) {
      const approval = this.store.putObject("approval", approvalPayload);
      const event = this.emit({
        type: "approval.requested",
        actorId: input.createdBy,
        workspaceId: input.workspaceId,
        taskId,
        roomId: input.responseTarget?.roomId ?? (input.responseTarget?.kind === "room" ? input.responseTarget.id : null),
        threadId: input.responseTarget?.threadId ?? (input.responseTarget?.kind === "thread" ? input.responseTarget.id : null),
        correlationId: input.rootObjectiveId,
        summary: `Approval required before ${input.assigneeId} can execute ${taskId}`,
        attentionState: "needs_approval"
      });
      return { task: storedTask, lease: storedLease, environmentLease: storedEnvironmentLease, approval, event };
    }

    if (inputArtifactRefs.length > 0) {
      this.emit({
        type: "task.inputs_attached",
        actorId: input.createdBy,
        workspaceId: input.workspaceId,
        taskId,
        correlationId: input.rootObjectiveId,
        summary: `Attached ${inputArtifactRefs.length} input Artifact${inputArtifactRefs.length === 1 ? "" : "s"} to ${taskId}`
      });
    }

    // Input Artifact refs are already on the durable Task before the execution queue can expose it.
    this.executionQueue?.enqueueTask(taskId, input.assigneeId, input.workspaceId);
    const event = this.emit({
      type: "task.assigned",
      actorId: input.createdBy,
      workspaceId: input.workspaceId,
      taskId,
      roomId: input.responseTarget?.roomId ?? (input.responseTarget?.kind === "room" ? input.responseTarget.id : null),
      threadId: input.responseTarget?.threadId ?? (input.responseTarget?.kind === "thread" ? input.responseTarget.id : null),
      correlationId: input.rootObjectiveId,
      summary: `Delegated task ${taskId} to ${input.assigneeId}`
    });
    return { task: storedTask, lease: storedLease, environmentLease: storedEnvironmentLease, approval: null, event };
  }

  approve(approvalId: string, actorId: string): { approval: StoredObject; task: StoredObject; events: AppendedEvent[] } {
    this.assertOperatorDecision(actorId);
    const storedApproval = this.requireApproval(approvalId);
    if (storedApproval.payload.status !== "pending") throw new Error(`Approval ${approvalId} is not pending`);
    const taskId = String(storedApproval.payload.task_id ?? "");
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task") throw new Error(`Approval Task ${taskId} not found`);
    if (task.payload.status !== "waiting_approval") throw new Error(`Task ${taskId} is not waiting for approval`);

    const approved = this.store.putObject("approval", validateProtocolObject({
      ...storedApproval.payload,
      status: "approved",
      decided_by: actorId,
      decided_at: nowIso()
    }, "approval"));
    const assignedTask = this.store.putObject("task", validateProtocolObject({
      ...task.payload,
      status: "assigned",
      approved_by: actorId,
      approved_at: nowIso()
    }, "task"));
    this.executionQueue?.enqueueTask(taskId, String(task.payload.assignee_id), String(task.payload.workspace_id));
    const events = [
      this.emit({
        type: "approval.approved",
        actorId,
        workspaceId: String(task.payload.workspace_id),
        taskId,
        correlationId: String(task.payload.root_objective_id),
        summary: `Approved ${approvalId}`
      }),
      this.emit({
        type: "task.assigned",
        actorId,
        workspaceId: String(task.payload.workspace_id),
        taskId,
        correlationId: String(task.payload.root_objective_id),
        summary: `Approved Task ${taskId} assigned to ${String(task.payload.assignee_id)}`
      })
    ];
    return { approval: approved, task: assignedTask, events };
  }

  rejectApproval(approvalId: string, actorId: string, reason = "Denied by operator"): { approval: StoredObject; task: StoredObject; events: AppendedEvent[] } {
    this.assertOperatorDecision(actorId);
    const storedApproval = this.requireApproval(approvalId);
    if (storedApproval.payload.status !== "pending") throw new Error(`Approval ${approvalId} is not pending`);
    const taskId = String(storedApproval.payload.task_id ?? "");
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task") throw new Error(`Approval Task ${taskId} not found`);

    const denied = this.store.putObject("approval", validateProtocolObject({
      ...storedApproval.payload,
      status: "denied",
      decided_by: actorId,
      decided_at: nowIso(),
      decision_reason: reason
    }, "approval"));
    const canceledTask = this.store.putObject("task", validateProtocolObject({
      ...task.payload,
      status: "canceled",
      canceled_at: nowIso(),
      canceled_by: actorId,
      cancellation_code: "APPROVAL_DENIED",
      cancellation_reason: reason
    }, "task"));
    this.executionQueue?.cancelByItem(taskId, reason);
    const events = [
      this.emit({
        type: "approval.denied",
        actorId,
        workspaceId: String(task.payload.workspace_id),
        taskId,
        correlationId: String(task.payload.root_objective_id),
        summary: reason,
        attentionState: "failed"
      }),
      this.emit({
        type: "task.canceled",
        actorId,
        workspaceId: String(task.payload.workspace_id),
        taskId,
        correlationId: String(task.payload.root_objective_id),
        summary: `Task canceled because approval was denied: ${reason}`,
        attentionState: "failed"
      })
    ];
    return { approval: denied, task: canceledTask, events };
  }

  requestHandoff(input: HandoffInput): { handoff: StoredObject; event: AppendedEvent } {
    const task = this.store.getObject(input.workItemId);
    if (!task || task.kind !== "task") throw new Error(`Handoff Task ${input.workItemId} not found`);
    if (task.workspaceId !== input.workspaceId) throw new Error(`Task ${task.id} is outside workspace ${input.workspaceId}`);
    if (String(task.payload.root_objective_id) !== input.rootObjectiveId) {
      throw new Error(`Task ${task.id} does not belong to root objective ${input.rootObjectiveId}`);
    }
    if (String(task.payload.owner_id) !== input.sourceOwnerId) {
      throw new Error(`Task ${task.id} is owned by ${String(task.payload.owner_id)}, not ${input.sourceOwnerId}`);
    }
    if (!new Set(["assigned", "waiting_approval"]).has(String(task.payload.status))) {
      throw new Error(`Task ${task.id} cannot be handed off from status ${String(task.payload.status)}`);
    }

    const rootOwnerId = this.taskRootOwner(task);
    const handoffArtifacts = this.validateHandoffArtifacts(input.workspaceId, input.artifactRefs);
    const artifactRefs = handoffArtifacts.map((artifact) => artifact.id);

    const activeHandoff = this.store.listObjects("handoff", input.workspaceId)
      .find((candidate) => {
        const candidateTaskId = String(candidate.payload.task_id ?? candidate.payload.work_item_id ?? "");
        return candidateTaskId === task.id && new Set(["requested", "accepted"]).has(String(candidate.payload.status));
      });
    if (activeHandoff) throw new Error(`Task ${task.id} already has active Handoff ${activeHandoff.id}`);

    const sourceLease = this.requireCapabilityLease(String(task.payload.lease_id));
    this.assertCapabilityLeaseForTask(sourceLease, task, input.sourceOwnerId);
    const environmentLease = this.optionalEnvironmentLease(task.payload.environment_lease_id);
    if (environmentLease) this.assertEnvironmentLeaseForTask(environmentLease, task, input.sourceOwnerId);
    const environmentPolicy = environmentLease ? String(environmentLease.payload.environment_policy) : null;

    this.policy?.prepareHandoff({
      sourceOwnerId: input.sourceOwnerId,
      targetOwnerId: input.targetOwnerId,
      workspaceId: input.workspaceId,
      tools: stringArray(sourceLease.payload.tools),
      connections: stringArray(sourceLease.payload.connections),
      environmentPolicy
    });

    if (environmentLease && environmentPolicy !== "shared_workspace") {
      throw new Error(`Environment ${environmentLease.id} uses ${environmentPolicy} and cannot be transferred by the shared-environment handoff path`);
    }

    const currentConstraints = normalizeConstraints(task.payload.required_constraints);
    const currentDigest = constraintsDigest(currentConstraints);
    if (typeof task.payload.constraints_digest === "string" && task.payload.constraints_digest !== currentDigest) {
      throw new Error(`Task ${task.id} immutable constraint digest does not match its current constraints`);
    }
    const handoffConstraints = normalizeConstraints([...currentConstraints, ...(input.requiredConstraints ?? [])]);
    const handoffId = createId("handoff");
    const handoff = validateProtocolObject({
      schema_version: "1.0",
      id: handoffId,
      type: "handoff",
      source_owner_id: input.sourceOwnerId,
      target_bot_id: input.targetOwnerId,
      target_owner_id: input.targetOwnerId,
      root_owner_id: rootOwnerId,
      workspace_id: input.workspaceId,
      task_id: task.id,
      work_item_id: task.id,
      root_objective_id: input.rootObjectiveId,
      reason: input.reason,
      required_constraints: handoffConstraints,
      constraints_digest: constraintsDigest(handoffConstraints),
      artifact_refs: artifactRefs,
      capability_lease_id: sourceLease.id,
      environment_lease_id: environmentLease?.id ?? null,
      return_policy: input.returnPolicy ?? "return_on_completion",
      status: "requested"
    }, "handoff");
    const stored = this.store.putObject("handoff", handoff);
    const event = this.emit({
      type: "handoff.requested",
      actorId: input.sourceOwnerId,
      workspaceId: input.workspaceId,
      taskId: task.id,
      correlationId: input.rootObjectiveId,
      summary: `Handoff requested from ${input.sourceOwnerId} to ${input.targetOwnerId}`,
      attentionState: "handoff_waiting"
    });
    return { handoff: stored, event };
  }

  acceptHandoff(handoffId: string, actorId: string): { handoff: StoredObject; workItem: StoredObject; events: AppendedEvent[] } {
    const storedHandoff = this.requireHandoff(handoffId);
    if (storedHandoff.payload.status !== "requested") throw new Error(`Handoff ${handoffId} is not requested`);
    const targetId = String(storedHandoff.payload.target_bot_id ?? storedHandoff.payload.target_owner_id ?? "");
    if (targetId !== actorId) throw new Error(`Only target Bot ${targetId} can accept this handoff`);

    const taskId = String(storedHandoff.payload.task_id ?? storedHandoff.payload.work_item_id ?? "");
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task") throw new Error(`Handoff Task ${taskId} not found`);
    const sourceOwnerId = String(storedHandoff.payload.source_owner_id);
    const workspaceId = String(storedHandoff.payload.workspace_id);
    const rootObjectiveId = String(storedHandoff.payload.root_objective_id);
    if (task.workspaceId !== workspaceId) throw new Error(`Task ${task.id} is outside Handoff workspace ${workspaceId}`);
    if (String(task.payload.owner_id) !== sourceOwnerId) {
      throw new Error(`Task ${task.id} owner changed before Handoff acceptance`);
    }
    if (!new Set(["assigned", "waiting_approval"]).has(String(task.payload.status))) {
      throw new Error(`Task ${task.id} cannot accept Handoff from status ${String(task.payload.status)}`);
    }

    const taskRootOwnerId = this.taskRootOwner(task);
    const handoffRootOwnerId = typeof storedHandoff.payload.root_owner_id === "string" && storedHandoff.payload.root_owner_id.length > 0
      ? storedHandoff.payload.root_owner_id
      : taskRootOwnerId;
    if (handoffRootOwnerId !== taskRootOwnerId) {
      throw new Error(`Task ${task.id} root ownership changed before Handoff acceptance`);
    }

    const handoffArtifacts = this.validateHandoffArtifacts(workspaceId, stringArray(storedHandoff.payload.artifact_refs));
    const existingInputRefs = stringArray(task.payload.input_artifact_refs);
    const existingInputSet = new Set(existingInputRefs);
    const newlyAttachedArtifactRefs = handoffArtifacts.map((artifact) => artifact.id).filter((id) => !existingInputSet.has(id));
    const mergedInputArtifactRefs = [...new Set([...existingInputRefs, ...handoffArtifacts.map((artifact) => artifact.id)])];

    const handoffConstraints = normalizeConstraints(storedHandoff.payload.required_constraints);
    const recordedDigest = String(storedHandoff.payload.constraints_digest ?? "");
    if (!recordedDigest || recordedDigest !== constraintsDigest(handoffConstraints)) {
      throw new Error(`Handoff ${handoffId} immutable constraint digest is invalid`);
    }
    const taskConstraints = normalizeConstraints(task.payload.required_constraints);
    for (const constraint of taskConstraints) {
      if (!handoffConstraints.includes(constraint)) {
        throw new Error(`Handoff ${handoffId} dropped immutable Task constraint: ${constraint}`);
      }
    }
    if (typeof task.payload.constraints_digest === "string" && task.payload.constraints_digest !== constraintsDigest(taskConstraints)) {
      throw new Error(`Task ${task.id} immutable constraint digest is invalid`);
    }

    const sourceLease = this.requireCapabilityLease(String(task.payload.lease_id));
    this.assertCapabilityLeaseForTask(sourceLease, task, sourceOwnerId);
    const sourceEnvironmentLease = this.optionalEnvironmentLease(task.payload.environment_lease_id);
    if (sourceEnvironmentLease) this.assertEnvironmentLeaseForTask(sourceEnvironmentLease, task, sourceOwnerId);
    const environmentPolicy = sourceEnvironmentLease ? String(sourceEnvironmentLease.payload.environment_policy) : null;
    if (sourceEnvironmentLease && environmentPolicy !== "shared_workspace") {
      throw new Error(`Environment ${sourceEnvironmentLease.id} requires adapter-specific transfer for policy ${environmentPolicy}`);
    }

    this.policy?.prepareHandoff({
      sourceOwnerId,
      targetOwnerId: targetId,
      workspaceId,
      tools: stringArray(sourceLease.payload.tools),
      connections: stringArray(sourceLease.payload.connections),
      environmentPolicy
    });

    const timestamp = nowIso();
    const newLeaseId = createId("lease");
    const newEnvironmentLeaseId = sourceEnvironmentLease ? createId("envlease") : null;
    const revokedLease = validateProtocolObject({
      ...sourceLease.payload,
      revoked_at: timestamp,
      revoked_reason: `Handoff ${handoffId} accepted by ${targetId}`,
      superseded_by: newLeaseId
    }, "capability_lease");
    const newLease = validateProtocolObject({
      ...sourceLease.payload,
      id: newLeaseId,
      issued_to: targetId,
      transferred_from: sourceLease.id,
      transferred_at: timestamp,
      revoked_at: null,
      revoked_reason: null,
      superseded_by: null
    }, "capability_lease");

    const objects: Array<{ kind: any; payload: JsonObject }> = [
      {
        kind: "handoff",
        payload: validateProtocolObject({
          ...storedHandoff.payload,
          target_bot_id: targetId,
          target_owner_id: targetId,
          root_owner_id: taskRootOwnerId,
          task_id: task.id,
          work_item_id: task.id,
          capability_lease_id: newLeaseId,
          environment_lease_id: newEnvironmentLeaseId,
          accepted_at: timestamp,
          accepted_by: actorId,
          status: "accepted"
        }, "handoff")
      },
      { kind: "capability_lease", payload: revokedLease },
      { kind: "capability_lease", payload: newLease }
    ];

    if (sourceEnvironmentLease && newEnvironmentLeaseId) {
      objects.push({
        kind: "environment_lease",
        payload: validateProtocolObject({
          ...sourceEnvironmentLease.payload,
          revoked_at: timestamp,
          revoked_reason: `Handoff ${handoffId} accepted by ${targetId}`,
          superseded_by: newEnvironmentLeaseId
        }, "environment_lease")
      });
      objects.push({
        kind: "environment_lease",
        payload: validateProtocolObject({
          ...sourceEnvironmentLease.payload,
          id: newEnvironmentLeaseId,
          issued_to: targetId,
          transferred_from: sourceEnvironmentLease.id,
          transferred_at: timestamp,
          revoked_at: null,
          revoked_reason: null,
          superseded_by: null
        }, "environment_lease")
      });
    }

    const updatedTaskPayload = validateProtocolObject({
      ...task.payload,
      owner_id: targetId,
      assignee_id: targetId,
      root_owner_id: taskRootOwnerId,
      required_constraints: handoffConstraints,
      constraints_digest: recordedDigest,
      input_artifact_refs: mergedInputArtifactRefs,
      lease_id: newLeaseId,
      environment_lease_id: newEnvironmentLeaseId,
      handoff_id: handoffId,
      handed_off_from: sourceOwnerId,
      handed_off_at: timestamp
    }, "task");
    objects.push({ kind: "task", payload: updatedTaskPayload });

    const preconditions: Array<{ id: string; kind: any; status?: string; ownerId?: string }> = [
      { id: storedHandoff.id, kind: "handoff", status: "requested" },
      { id: task.id, kind: "task", status: String(task.payload.status), ownerId: sourceOwnerId }
    ];

    if (task.payload.status === "waiting_approval") {
      const approvalId = typeof task.payload.approval_id === "string" ? task.payload.approval_id : null;
      if (!approvalId) throw new Error(`Task ${task.id} is waiting for approval but has no approval_id`);
      const approval = this.requireApproval(approvalId);
      if (approval.payload.status !== "pending") throw new Error(`Approval ${approvalId} is not pending`);
      objects.push({
        kind: "approval",
        payload: validateProtocolObject({
          ...approval.payload,
          actor_id: targetId,
          retargeted_at: timestamp,
          retargeted_by_handoff: handoffId
        }, "approval")
      });
      preconditions.push({ id: approval.id, kind: "approval", status: "pending" });
      const unexpectedQueue = this.executionQueue?.getByItem(task.id);
      if (unexpectedQueue && new Set(["queued", "claimed", "running"]).has(unexpectedQueue.state)) {
        throw new Error(`Approval-gated Task ${task.id} unexpectedly has executable queue state ${unexpectedQueue.state}`);
      }
    }

    let queueRetarget: { itemId: string; fromTargetId: string; toTargetId: string; required?: boolean } | undefined;
    if (task.payload.status === "assigned") {
      const queued = this.executionQueue?.getByItem(task.id);
      if (this.executionQueue && !queued) throw new Error(`Assigned Task ${task.id} has no execution queue item`);
      if (queued && queued.state !== "queued") {
        throw new Error(`Cannot accept Handoff ${handoffId} while Task ${task.id} execution is ${queued.state}`);
      }
      queueRetarget = this.executionQueue
        ? { itemId: task.id, fromTargetId: sourceOwnerId, toTargetId: targetId, required: true }
        : undefined;
    }

    const eventInputs: EmitInput[] = [
      {
        type: "handoff.accepted",
        actorId,
        workspaceId,
        taskId: task.id,
        correlationId: rootObjectiveId,
        summary: `Accepted handoff ${handoffId}`
      },
      {
        type: "ownership.changed",
        actorId,
        workspaceId,
        taskId: task.id,
        correlationId: rootObjectiveId,
        summary: `${targetId} now owns ${task.id}`
      },
      {
        type: "capability_lease.reissued",
        actorId,
        workspaceId,
        taskId: task.id,
        correlationId: rootObjectiveId,
        summary: `Reissued Task authority from ${sourceOwnerId} to ${targetId}`
      }
    ];
    if (sourceEnvironmentLease) {
      eventInputs.push({
        type: "environment_lease.reissued",
        actorId,
        workspaceId,
        taskId: task.id,
        correlationId: rootObjectiveId,
        summary: `Transferred shared execution environment to ${targetId}`
      });
    }
    if (newlyAttachedArtifactRefs.length > 0) {
      eventInputs.push({
        type: "task.inputs_attached",
        actorId,
        workspaceId,
        taskId: task.id,
        correlationId: rootObjectiveId,
        summary: `Attached ${newlyAttachedArtifactRefs.length} Handoff Artifact${newlyAttachedArtifactRefs.length === 1 ? "" : "s"} to ${task.id}`
      });
    }
    if (task.payload.status === "waiting_approval") {
      eventInputs.push({
        type: "approval.retargeted",
        actorId,
        workspaceId,
        taskId: task.id,
        correlationId: rootObjectiveId,
        summary: `Approval actor retargeted to ${targetId}`,
        attentionState: "needs_approval"
      });
    } else {
      eventInputs.push({
        type: "task.assigned",
        actorId,
        workspaceId,
        taskId: task.id,
        correlationId: rootObjectiveId,
        summary: `Handed-off Task ${task.id} assigned to ${targetId}`
      });
    }

    const mutation = this.store.atomicMutation({
      preconditions,
      objects,
      events: eventInputs.map((entry) => this.buildEvent(entry)),
      queueRetarget
    });
    this.publishCommitted(mutation.events);

    const accepted = mutation.objects.find((object) => object.id === storedHandoff.id);
    const workItem = mutation.objects.find((object) => object.id === task.id);
    if (!accepted || !workItem) throw new Error(`Atomic Handoff ${handoffId} committed without expected objects`);
    return { handoff: accepted, workItem, events: mutation.events };
  }

  rejectHandoff(handoffId: string, actorId: string, reason = "Handoff rejected"): { handoff: StoredObject; events: AppendedEvent[] } {
    const handoff = this.requireHandoff(handoffId);
    if (handoff.payload.status !== "requested") throw new Error(`Handoff ${handoffId} is not requested`);
    const targetId = String(handoff.payload.target_bot_id ?? handoff.payload.target_owner_id ?? "");
    if (actorId !== targetId && !actorId.startsWith("operator_")) {
      throw new Error(`Only target Bot ${targetId} or an operator can reject Handoff ${handoffId}`);
    }
    const taskId = String(handoff.payload.task_id ?? handoff.payload.work_item_id ?? "");
    const rejectedPayload: JsonObject = {
      ...handoff.payload,
      status: "rejected",
      rejected_by: actorId,
      rejected_at: nowIso(),
      rejection_reason: reason
    };
    const event = this.buildEvent({
      type: "handoff.rejected",
      actorId,
      workspaceId: String(handoff.payload.workspace_id),
      taskId,
      correlationId: String(handoff.payload.root_objective_id),
      summary: reason,
      attentionState: "unread_result"
    });
    const mutation = this.store.atomicMutation({
      preconditions: [{ id: handoff.id, kind: "handoff", status: "requested" }],
      objects: [{ kind: "handoff", payload: rejectedPayload }],
      events: [event]
    });
    this.publishCommitted(mutation.events);
    const rejected = mutation.objects[0];
    if (!rejected) throw new Error(`Rejected Handoff ${handoffId} was not persisted`);
    return { handoff: rejected, events: mutation.events };
  }

  settleHandoffForTask(taskId: string, outcome: "completed" | "blocked" | "failed" | "canceled", actorId: string): { handoff: StoredObject; task: StoredObject; events: AppendedEvent[] } | null {
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task") return null;
    const handoff = this.store.listObjects("handoff", task.workspaceId ?? undefined)
      .find((candidate) => {
        const candidateTaskId = String(candidate.payload.task_id ?? candidate.payload.work_item_id ?? "");
        return candidateTaskId === taskId && candidate.payload.status === "accepted";
      });
    if (!handoff) return null;

    const sourceOwnerId = String(handoff.payload.source_owner_id);
    const targetId = String(handoff.payload.target_bot_id ?? handoff.payload.target_owner_id ?? "");
    if (String(task.payload.owner_id) !== targetId) return null;
    const taskRootOwnerId = this.taskRootOwner(task);
    const handoffRootOwnerId = typeof handoff.payload.root_owner_id === "string" && handoff.payload.root_owner_id.length > 0
      ? handoff.payload.root_owner_id
      : taskRootOwnerId;
    if (handoffRootOwnerId !== taskRootOwnerId) {
      throw new Error(`Task ${task.id} root ownership changed before Handoff settlement`);
    }

    const returnPolicy = String(handoff.payload.return_policy ?? "return_on_completion");
    const shouldReturn = (outcome === "completed" && returnPolicy === "return_on_completion")
      || (outcome === "blocked" && returnPolicy === "return_on_block");
    const terminalHandoff = outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : outcome === "canceled" ? "canceled" : shouldReturn ? "completed" : "accepted";
    if (outcome === "blocked" && !shouldReturn) return null;

    const timestamp = nowIso();
    let updatedTaskPayload: JsonObject = shouldReturn
      ? {
          ...task.payload,
          owner_id: sourceOwnerId,
          root_owner_id: taskRootOwnerId,
          ownership_returned_at: timestamp,
          ownership_returned_from: targetId
        }
      : { ...task.payload, root_owner_id: taskRootOwnerId };
    const authorityObjects: Array<{ kind: any; payload: JsonObject }> = [];
    const eventInputs: EmitInput[] = [];
    let queueRetarget: { itemId: string; fromTargetId: string; toTargetId: string; required?: boolean } | undefined;

    // A blocked Task may become executable again. Returning responsibility must therefore return
    // the task-scoped authority and execution environment too, never ownership metadata alone.
    if (shouldReturn && outcome === "blocked") {
      const targetLease = this.requireCapabilityLease(String(task.payload.lease_id));
      this.assertCapabilityLeaseForTask(targetLease, task, targetId);
      const targetEnvironmentLease = this.optionalEnvironmentLease(task.payload.environment_lease_id);
      if (targetEnvironmentLease) this.assertEnvironmentLeaseForTask(targetEnvironmentLease, task, targetId);
      const environmentPolicy = targetEnvironmentLease ? String(targetEnvironmentLease.payload.environment_policy) : null;
      if (targetEnvironmentLease && environmentPolicy !== "shared_workspace") {
        throw new Error(`Environment ${targetEnvironmentLease.id} requires adapter-specific return for policy ${environmentPolicy}`);
      }

      this.policy?.prepareHandoff({
        sourceOwnerId: targetId,
        targetOwnerId: sourceOwnerId,
        workspaceId: String(task.workspaceId),
        tools: stringArray(targetLease.payload.tools),
        connections: stringArray(targetLease.payload.connections),
        environmentPolicy
      });

      const returnedLeaseId = createId("lease");
      const returnedEnvironmentLeaseId = targetEnvironmentLease ? createId("envlease") : null;
      authorityObjects.push({
        kind: "capability_lease",
        payload: validateProtocolObject({
          ...targetLease.payload,
          revoked_at: timestamp,
          revoked_reason: `Handoff ${handoff.id} returned blocked Task to ${sourceOwnerId}`,
          superseded_by: returnedLeaseId
        }, "capability_lease")
      });
      authorityObjects.push({
        kind: "capability_lease",
        payload: validateProtocolObject({
          ...targetLease.payload,
          id: returnedLeaseId,
          issued_to: sourceOwnerId,
          transferred_from: targetLease.id,
          transferred_at: timestamp,
          revoked_at: null,
          revoked_reason: null,
          superseded_by: null
        }, "capability_lease")
      });

      if (targetEnvironmentLease && returnedEnvironmentLeaseId) {
        authorityObjects.push({
          kind: "environment_lease",
          payload: validateProtocolObject({
            ...targetEnvironmentLease.payload,
            revoked_at: timestamp,
            revoked_reason: `Handoff ${handoff.id} returned blocked Task to ${sourceOwnerId}`,
            superseded_by: returnedEnvironmentLeaseId
          }, "environment_lease")
        });
        authorityObjects.push({
          kind: "environment_lease",
          payload: validateProtocolObject({
            ...targetEnvironmentLease.payload,
            id: returnedEnvironmentLeaseId,
            issued_to: sourceOwnerId,
            transferred_from: targetEnvironmentLease.id,
            transferred_at: timestamp,
            revoked_at: null,
            revoked_reason: null,
            superseded_by: null
          }, "environment_lease")
        });
      }

      updatedTaskPayload = {
        ...updatedTaskPayload,
        assignee_id: sourceOwnerId,
        lease_id: returnedLeaseId,
        environment_lease_id: returnedEnvironmentLeaseId
      };

      const queued = this.executionQueue?.getByItem(task.id);
      if (queued && new Set(["claimed", "running"]).has(queued.state)) {
        throw new Error(`Cannot return blocked Handoff ${handoff.id} while Task ${task.id} execution is ${queued.state}`);
      }
      if (queued?.state === "queued") {
        queueRetarget = { itemId: task.id, fromTargetId: targetId, toTargetId: sourceOwnerId, required: true };
      }

      eventInputs.push({
        type: "capability_lease.reissued",
        actorId,
        workspaceId: task.workspaceId,
        taskId,
        correlationId: String(task.payload.root_objective_id),
        summary: `Returned Task authority from ${targetId} to ${sourceOwnerId}`
      });
      if (targetEnvironmentLease) {
        eventInputs.push({
          type: "environment_lease.reissued",
          actorId,
          workspaceId: task.workspaceId,
          taskId,
          correlationId: String(task.payload.root_objective_id),
          summary: `Returned shared execution environment to ${sourceOwnerId}`
        });
      }
    }

    const updatedHandoffPayload = validateProtocolObject({
      ...handoff.payload,
      root_owner_id: taskRootOwnerId,
      status: terminalHandoff,
      settled_at: timestamp,
      outcome,
      ownership_returned: shouldReturn
    }, "handoff");
    const validatedTaskPayload = validateProtocolObject(updatedTaskPayload, "task");
    eventInputs.unshift({
      type: terminalHandoff === "completed" ? "handoff.completed" : `handoff.${terminalHandoff}`,
      actorId,
      workspaceId: task.workspaceId,
      taskId,
      correlationId: String(task.payload.root_objective_id),
      summary: `Handoff ${handoff.id} settled from Task outcome ${outcome}`
    });
    if (shouldReturn) {
      eventInputs.push({
        type: "ownership.changed",
        actorId,
        workspaceId: task.workspaceId,
        taskId,
        correlationId: String(task.payload.root_objective_id),
        summary: `${sourceOwnerId} regained ownership of ${taskId}`
      });
    }

    const mutation = this.store.atomicMutation({
      preconditions: [
        { id: handoff.id, kind: "handoff", status: "accepted" },
        { id: task.id, kind: "task", status: String(task.payload.status), ownerId: targetId }
      ],
      objects: [
        { kind: "handoff", payload: updatedHandoffPayload },
        ...authorityObjects,
        { kind: "task", payload: validatedTaskPayload }
      ],
      events: eventInputs.map((entry) => this.buildEvent(entry)),
      queueRetarget
    });
    this.publishCommitted(mutation.events);
    const settledHandoff = mutation.objects.find((object) => object.id === handoff.id);
    const settledTask = mutation.objects.find((object) => object.id === task.id);
    if (!settledHandoff || !settledTask) throw new Error(`Handoff settlement for ${taskId} committed without expected objects`);
    return { handoff: settledHandoff, task: settledTask, events: mutation.events };
  }

  sendMessage(input: SendMessageInput): { message: StoredObject; delivery: DeliveryRecord; event: AppendedEvent } {
    return this.mailbox.send(input);
  }

  transitionMessageDelivery(messageId: string, input: MailboxTransitionInput): { message: StoredObject; delivery: DeliveryRecord; event: AppendedEvent } {
    return this.mailbox.transition(messageId, input);
  }

  sweepExpiredMessages(now = Date.now()): Array<{ message: StoredObject; delivery: DeliveryRecord; event: AppendedEvent }> {
    return this.mailbox.sweepExpired(now);
  }

  publishRoomMessage(input: PublishRoomMessageInput): { message: StoredObject; event: AppendedEvent } {
    const room = this.store.getObject(input.roomId);
    if (!room || room.kind !== "room") throw new Error(`Room ${input.roomId} not found`);
    if (room.payload.status !== "active") throw new Error(`Room ${input.roomId} is not active`);
    if (room.workspaceId !== input.workspaceId) throw new Error(`Room ${input.roomId} is not in workspace ${input.workspaceId}`);

    const members = Array.isArray(room.payload.members) ? room.payload.members.map(String) : [];
    if (input.senderId.startsWith("bot_")) {
      if (!members.includes(input.senderId)) throw new Error(`Bot ${input.senderId} is not a member of Room ${input.roomId}`);
      const sender = this.getBot(input.senderId);
      if (!sender || sender.payload.status !== "active") throw new Error(`Bot ${input.senderId} is not active`);
    }
    for (const mentionId of input.mentions ?? []) {
      if (!members.includes(mentionId)) throw new Error(`Mentioned Bot ${mentionId} is not a member of Room ${input.roomId}`);
      const mentioned = this.getBot(mentionId);
      if (!mentioned || mentioned.payload.status !== "active") throw new Error(`Mentioned Bot ${mentionId} is not active`);
    }

    if (input.threadId) {
      const thread = this.store.getObject(input.threadId);
      if (!thread || thread.kind !== "thread") throw new Error(`Thread ${input.threadId} not found`);
      if (thread.payload.room_id !== input.roomId) throw new Error(`Thread ${input.threadId} does not belong to Room ${input.roomId}`);
    }

    const messageId = createId("msg");
    const message: JsonObject = {
      schema_version: "1.0",
      id: messageId,
      type: "message.chat",
      timestamp: nowIso(),
      sender_id: input.senderId,
      target: { kind: input.threadId ? "thread" : "room", id: input.threadId ?? input.roomId },
      workspace_id: input.workspaceId,
      room_id: input.roomId,
      thread_id: input.threadId ?? null,
      reply_to_message_id: input.replyToMessageId ?? null,
      correlation_id: input.correlationId ?? null,
      delivery_state: "delivered",
      content: [{ kind: "text", text: input.text }],
      mentions: input.mentions ?? [],
      artifact_refs: input.artifactRefs ?? [],
      provenance: {
        origin: input.senderId.startsWith("bot_") ? "bot_generated" : input.senderId.startsWith("worker_") ? "worker_generated" : "operator_input",
        trusted_instruction: !input.senderId.startsWith("bot_") && !input.senderId.startsWith("worker_")
      }
    };
    const stored = this.store.putObject("message", validateProtocolObject(message, "message"));
    const event = this.emit({
      type: "room.message",
      actorId: input.senderId,
      workspaceId: input.workspaceId,
      roomId: input.roomId,
      threadId: input.threadId,
      correlationId: input.correlationId,
      summary: input.text.length > 160 ? `${input.text.slice(0, 157)}...` : input.text
    });
    return { message: stored, event };
  }

  emit(input: EmitInput): AppendedEvent {
    return this.events.publish(this.buildEvent(input), { idempotencyKey: input.idempotencyKey });
  }

  private buildEvent(input: EmitInput): CoordinationEvent {
    return this.events.prepare({
      schema_version: "1.0",
      id: createId("evt"),
      type: input.type,
      timestamp: nowIso(),
      actor_id: input.actorId,
      workspace_id: input.workspaceId ?? null,
      room_id: input.roomId ?? null,
      thread_id: input.threadId ?? null,
      run_id: input.runId ?? null,
      task_id: input.taskId ?? null,
      correlation_id: input.correlationId ?? null,
      causation_id: input.causationId ?? null,
      trace_id: input.traceId ?? null,
      summary: input.summary ?? null,
      ...(input.attentionState ? { attention_state: input.attentionState } : {})
    });
  }

  private publishCommitted(events: AppendedEvent[]): void {
    this.events.publishCommitted(events);
  }


  private validateDelegationInputArtifacts(workspaceId: string, refs: string[] | undefined): StoredObject[] {
    const artifacts: StoredObject[] = [];
    for (const ref of [...new Set((refs ?? []).map((value) => value.trim()).filter(Boolean))]) {
      const artifact = this.store.getObject(ref);
      if (!artifact || artifact.kind !== "artifact") throw new Error(`Input Artifact ${ref} not found`);
      if (artifact.workspaceId !== workspaceId) throw new Error(`Input Artifact ${ref} is outside workspace ${workspaceId}`);
      artifacts.push(artifact);
    }
    return artifacts;
  }

  private resolveDelegationRootOwner(parentTaskId: string | null, createdBy: string): string {
    if (!parentTaskId) return createdBy;
    const visited = new Set<string>();
    let taskId: string | null = parentTaskId;
    let fallback = createdBy;
    while (taskId) {
      if (visited.has(taskId)) throw new Error(`Delegation parent lineage contains a cycle at ${taskId}`);
      visited.add(taskId);
      const task = this.store.getObject(taskId);
      if (!task || task.kind !== "task") throw new Error(`Parent Task ${taskId} not found`);
      if (typeof task.payload.root_owner_id === "string" && task.payload.root_owner_id.length > 0) {
        return task.payload.root_owner_id;
      }
      if (typeof task.payload.created_by === "string" && task.payload.created_by.length > 0) fallback = task.payload.created_by;
      taskId = typeof task.payload.parent_task_id === "string" && task.payload.parent_task_id.length > 0
        ? task.payload.parent_task_id
        : null;
    }
    return fallback;
  }

  private prepareDelegationEnvironmentLease(
    assigneeId: string,
    workspaceId: string,
    taskId: string,
    expiresAt: string
  ): JsonObject | null {
    const bot = this.getBot(assigneeId);
    if (!bot) return null;
    const execution = objectValue(bot.payload.execution);
    const environmentPolicy = typeof execution.environment_policy === "string" ? execution.environment_policy : null;
    if (!environmentPolicy) throw new Error(`Bot ${assigneeId} has no trusted execution environment policy`);
    if (!["shared_workspace", "isolated_bot", "isolated_run", "external_managed"].includes(environmentPolicy)) {
      throw new Error(`Bot ${assigneeId} has unsupported environment policy ${environmentPolicy}`);
    }

    let environmentRef = typeof execution.environment_ref === "string" && execution.environment_ref.length > 0
      ? execution.environment_ref
      : null;
    if (!environmentRef && environmentPolicy === "shared_workspace") environmentRef = `workspace:${workspaceId}`;
    if (!environmentRef && environmentPolicy === "isolated_bot") environmentRef = `bot:${assigneeId}`;
    if (!environmentRef) {
      throw new Error(
        `Bot ${assigneeId} requires trusted runtime infrastructure to resolve an environment_ref for ${environmentPolicy}`
      );
    }

    return validateProtocolObject({
      schema_version: "1.0",
      id: createId("envlease"),
      type: "environment_lease",
      issued_to: assigneeId,
      workspace_id: workspaceId,
      task_id: taskId,
      environment_policy: environmentPolicy,
      environment_ref: environmentRef,
      expires_at: expiresAt
    }, "environment_lease");
  }


  private taskRootOwner(task: StoredObject): string {
    if (typeof task.payload.root_owner_id === "string" && task.payload.root_owner_id.length > 0) return task.payload.root_owner_id;
    if (typeof task.payload.created_by === "string" && task.payload.created_by.length > 0) return task.payload.created_by;
    return String(task.payload.owner_id);
  }

  private validateHandoffArtifacts(workspaceId: string, refs: string[] | undefined): StoredObject[] {
    const artifacts: StoredObject[] = [];
    for (const ref of [...new Set((refs ?? []).map((value) => value.trim()).filter(Boolean))]) {
      const artifact = this.store.getObject(ref);
      if (!artifact || artifact.kind !== "artifact") throw new Error(`Handoff Artifact ${ref} not found`);
      if (artifact.workspaceId !== workspaceId) throw new Error(`Handoff Artifact ${ref} is outside workspace ${workspaceId}`);
      artifacts.push(artifact);
    }
    return artifacts;
  }

  private assertCapabilityLeaseForTask(lease: StoredObject, task: StoredObject, ownerId: string): void {
    if (String(lease.payload.issued_to) !== ownerId) {
      throw new Error(`Capability lease ${lease.id} is not issued to ${ownerId}`);
    }
    if (String(lease.payload.task_id) !== task.id) {
      throw new Error(`Capability lease ${lease.id} is not scoped to Task ${task.id}`);
    }
    if (lease.workspaceId !== task.workspaceId) {
      throw new Error(`Capability lease ${lease.id} is outside Task workspace ${String(task.workspaceId)}`);
    }
    if (typeof lease.payload.revoked_at === "string" && lease.payload.revoked_at.length > 0) {
      throw new Error(`Capability lease ${lease.id} is revoked`);
    }
    const expiresAt = Date.parse(String(lease.payload.expires_at));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error(`Capability lease ${lease.id} is expired`);
  }

  private assertEnvironmentLeaseForTask(lease: StoredObject, task: StoredObject, ownerId: string): void {
    if (String(lease.payload.issued_to) !== ownerId) {
      throw new Error(`Environment lease ${lease.id} is not issued to ${ownerId}`);
    }
    if (String(lease.payload.task_id) !== task.id) {
      throw new Error(`Environment lease ${lease.id} is not scoped to Task ${task.id}`);
    }
    if (lease.workspaceId !== task.workspaceId) {
      throw new Error(`Environment lease ${lease.id} is outside Task workspace ${String(task.workspaceId)}`);
    }
    if (typeof lease.payload.revoked_at === "string" && lease.payload.revoked_at.length > 0) {
      throw new Error(`Environment lease ${lease.id} is revoked`);
    }
    const expiresAt = Date.parse(String(lease.payload.expires_at));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error(`Environment lease ${lease.id} is expired`);
  }

  private requireApproval(approvalId: string): StoredObject {
    const approval = this.store.getObject(approvalId);
    if (!approval || approval.kind !== "approval") throw new Error(`Approval ${approvalId} not found`);
    return approval;
  }

  private requireHandoff(handoffId: string): StoredObject {
    const handoff = this.store.getObject(handoffId);
    if (!handoff || handoff.kind !== "handoff") throw new Error(`Handoff ${handoffId} not found`);
    return handoff;
  }

  private requireCapabilityLease(leaseId: string): StoredObject {
    const lease = this.store.getObject(leaseId);
    if (!lease || lease.kind !== "capability_lease") throw new Error(`Capability lease ${leaseId} not found`);
    return lease;
  }

  private optionalEnvironmentLease(value: unknown): StoredObject | null {
    if (typeof value !== "string" || value.length === 0) return null;
    const lease = this.store.getObject(value);
    if (!lease || lease.kind !== "environment_lease") throw new Error(`Environment lease ${value} not found`);
    return lease;
  }

  private assertOperatorDecision(actorId: string): void {
    if (!actorId.startsWith("operator_")) throw new Error(`Only an operator can decide approvals or Bot lifecycle changes; received ${actorId}`);
  }
}
