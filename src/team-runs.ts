import { inheritBudget, normalizeBudget, type BudgetEnvelope } from "./budget.js";
import { constraintsDigest, normalizeConstraints } from "./constraints.js";
import { createId } from "./id.js";
import type { CoordinationGateway } from "./gateway.js";
import type { CoordinationPolicy } from "./policy.js";
import type { CoordinationStore } from "./store.js";
import type { AppendedEvent, BotManifest, CoordinationEvent, JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export type TeamRunStatus =
  | "created"
  | "planning"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "synthesizing"
  | "verifying"
  | "completed"
  | "failed"
  | "canceled"
  | "budget_exhausted";

export type TeamRunTopology =
  | "single"
  | "manager"
  | "handoff"
  | "parallel_panel"
  | "group_room"
  | "pipeline"
  | "review"
  | "dynamic_squad"
  | "hybrid";

export type WorkerStatus = "created" | "ready" | "running" | "waiting" | "completed" | "failed" | "canceled" | "expired";

const TEAM_RUN_TOPOLOGIES = new Set<TeamRunTopology>([
  "single",
  "manager",
  "handoff",
  "parallel_panel",
  "group_room",
  "pipeline",
  "review",
  "dynamic_squad",
  "hybrid"
]);

const TERMINAL_RUN_STATES = new Set<TeamRunStatus>(["completed", "failed", "canceled", "budget_exhausted"]);
const ACTIVE_WORKER_STATES = new Set<WorkerStatus>(["created", "ready", "running", "waiting"]);
const TERMINAL_WORKER_STATES = new Set<WorkerStatus>(["completed", "failed", "canceled", "expired"]);

const RUN_TRANSITIONS: Record<TeamRunStatus, ReadonlySet<TeamRunStatus>> = {
  created: new Set(["planning", "canceled", "failed"]),
  planning: new Set(["running", "waiting_input", "waiting_approval", "canceled", "failed", "budget_exhausted"]),
  running: new Set(["waiting_input", "waiting_approval", "synthesizing", "verifying", "completed", "failed", "canceled", "budget_exhausted"]),
  waiting_input: new Set(["planning", "running", "canceled", "failed", "budget_exhausted"]),
  waiting_approval: new Set(["planning", "running", "canceled", "failed", "budget_exhausted"]),
  synthesizing: new Set(["verifying", "completed", "failed", "canceled", "budget_exhausted"]),
  verifying: new Set(["completed", "failed", "canceled", "budget_exhausted"]),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set(),
  budget_exhausted: new Set()
};

const WORKER_TRANSITIONS: Record<WorkerStatus, ReadonlySet<WorkerStatus>> = {
  created: new Set(["ready", "failed", "canceled", "expired"]),
  ready: new Set(["running", "waiting", "failed", "canceled", "expired"]),
  running: new Set(["waiting", "completed", "failed", "canceled", "expired"]),
  waiting: new Set(["ready", "running", "completed", "failed", "canceled", "expired"]),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set(),
  expired: new Set()
};

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} cannot be empty`);
  return normalized;
}

export interface CreateTeamRunInput {
  createdBy: string;
  leaderId: string;
  workspaceId: string;
  rootObjectiveId: string;
  topology?: TeamRunTopology;
  budget?: BudgetEnvelope;
  parentTaskId?: string;
  reason?: string;
}

export interface SpawnWorkerInput {
  runId: string;
  createdBy: string;
  role: {
    title: string;
    objective: string;
  };
  requiredConstraints?: string[];
  expectedOutput?: JsonObject;
  tools?: string[];
  connections?: string[];
  budget?: BudgetEnvelope;
  deadlineAt?: string;
  leaseExpiresAt?: string;
  runtimeAdapter?: string;
  runtimeProfileRef?: string | null;
  environmentPolicy?: "shared_workspace" | "isolated_run" | "external_managed";
  environmentRef?: string;
}

export interface TeamRunCreationResult {
  run: StoredObject;
  event: AppendedEvent;
}

export interface SpawnWorkerResult {
  run: StoredObject;
  worker: StoredObject;
  task: StoredObject;
  capabilityLease: StoredObject;
  environmentLease: StoredObject;
  events: AppendedEvent[];
}

export interface LifecycleTransitionResult {
  object: StoredObject;
  events: AppendedEvent[];
}

export class TeamRunCoordinator {
  constructor(
    readonly store: CoordinationStore,
    readonly gateway: CoordinationGateway,
    readonly policy: CoordinationPolicy
  ) {}

  createRun(input: CreateTeamRunInput): TeamRunCreationResult {
    const workspaceId = nonEmpty(input.workspaceId, "workspaceId");
    const rootObjectiveId = nonEmpty(input.rootObjectiveId, "rootObjectiveId");
    const leaderId = nonEmpty(input.leaderId, "leaderId");
    this.assertRunCreator(input.createdBy, leaderId);
    const leader = this.requireActiveWorkspaceBot(leaderId, workspaceId);
    const topology = input.topology ?? "dynamic_squad";
    if (!TEAM_RUN_TOPOLOGIES.has(topology)) throw new Error(`Unsupported Team Run topology ${String(topology)}`);
    const budget = normalizeBudget(input.budget);

    let parentTask: StoredObject | null = null;
    if (input.parentTaskId) {
      parentTask = this.requireTask(input.parentTaskId);
      if (parentTask.workspaceId !== workspaceId) throw new Error(`Parent Task ${parentTask.id} is outside workspace ${workspaceId}`);
      if (String(parentTask.payload.root_objective_id) !== rootObjectiveId) {
        throw new Error(`Parent Task ${parentTask.id} does not belong to root objective ${rootObjectiveId}`);
      }
      const ownerIds = new Set([
        String(parentTask.payload.owner_id ?? ""),
        String(parentTask.payload.root_owner_id ?? ""),
        String(parentTask.payload.created_by ?? "")
      ]);
      if (!ownerIds.has(leaderId)) throw new Error(`Leader ${leaderId} does not own or originate parent Task ${parentTask.id}`);
      if (new Set(["completed", "failed", "canceled", "timeout", "budget_exhausted", "rejected_policy"]).has(String(parentTask.payload.status))) {
        throw new Error(`Parent Task ${parentTask.id} is terminal`);
      }
    }

    const runId = createId("run");
    const payload = validateProtocolObject({
      schema_version: "1.0",
      id: runId,
      type: "team_run",
      created_by: input.createdBy,
      workspace_id: workspaceId,
      root_objective_id: rootObjectiveId,
      parent_task_id: parentTask?.id ?? null,
      leader_id: leader.id,
      participant_ids: [leader.id],
      worker_ids: [],
      task_ids: parentTask ? [parentTask.id] : [],
      artifact_refs: [],
      topology,
      status: "created",
      budget,
      reason: input.reason?.trim() || "Temporary multi-agent collaboration",
      created_at: nowIso()
    }, "team_run");
    const event = this.prepareEvent({
      type: "run.created",
      actorId: input.createdBy,
      runId,
      workspaceId,
      correlationId: rootObjectiveId,
      summary: `Created Team Run ${runId} led by ${leader.id}`,
      attentionState: "working"
    });
    const mutation = this.store.atomicMutation({
      objects: [{ kind: "team_run", payload }],
      events: [event]
    });
    this.gateway.events.publishCommitted(mutation.events);
    const run = mutation.objects[0];
    const appended = mutation.events[0];
    if (!run || !appended) throw new Error(`Team Run ${runId} creation did not persist expected records`);
    return { run, event: appended };
  }

  getRun(runId: string): StoredObject | null {
    const object = this.store.getObject(runId);
    return object?.kind === "team_run" ? object : null;
  }

  listRuns(workspaceId?: string): StoredObject[] {
    return this.store.listObjects("team_run", workspaceId);
  }

  listWorkers(runId: string): StoredObject[] {
    const run = this.requireRun(runId);
    return this.store.listObjects("worker", String(run.workspaceId))
      .filter((worker) => String(worker.payload.run_id) === run.id);
  }

  transitionRun(runId: string, targetStatus: TeamRunStatus, actorId: string, reason?: string): LifecycleTransitionResult {
    const run = this.requireRun(runId);
    const current = String(run.payload.status) as TeamRunStatus;
    if (!(current in RUN_TRANSITIONS)) throw new Error(`Team Run ${run.id} has unsupported status ${current}`);
    if (!RUN_TRANSITIONS[current].has(targetStatus)) {
      throw new Error(`Team Run ${run.id} cannot transition from ${current} to ${targetStatus}`);
    }
    this.assertRunActor(run, actorId);

    if (TERMINAL_RUN_STATES.has(targetStatus)) {
      const activeWorkers = this.listWorkers(run.id).filter((worker) => ACTIVE_WORKER_STATES.has(String(worker.payload.status) as WorkerStatus));
      if (activeWorkers.length > 0) {
        throw new Error(`Team Run ${run.id} cannot become ${targetStatus} while ${activeWorkers.length} Workers are active`);
      }
    }

    const timestamp = nowIso();
    const payload = validateProtocolObject({
      ...run.payload,
      status: targetStatus,
      ...(targetStatus === "running" && typeof run.payload.started_at !== "string" ? { started_at: timestamp } : {}),
      ...(TERMINAL_RUN_STATES.has(targetStatus) ? { ended_at: timestamp } : {}),
      ...(reason?.trim() ? { transition_reason: reason.trim() } : {})
    }, "team_run");
    const event = this.prepareEvent({
      type: `run.${targetStatus}`,
      actorId,
      runId: run.id,
      workspaceId: String(run.workspaceId),
      correlationId: String(run.payload.root_objective_id),
      summary: reason?.trim() || `Team Run ${run.id} transitioned from ${current} to ${targetStatus}`,
      attentionState: targetStatus === "waiting_input"
        ? "needs_input"
        : targetStatus === "waiting_approval"
          ? "needs_approval"
          : targetStatus === "failed" || targetStatus === "budget_exhausted"
            ? "failed"
            : TERMINAL_RUN_STATES.has(targetStatus)
              ? "none"
              : "working"
    });
    const mutation = this.store.atomicMutation({
      preconditions: [{ id: run.id, kind: "team_run", status: current }],
      objects: [{ kind: "team_run", payload }],
      events: [event]
    });
    this.gateway.events.publishCommitted(mutation.events);
    const object = mutation.objects[0];
    if (!object) throw new Error(`Team Run ${run.id} transition did not persist`);
    return { object, events: mutation.events };
  }

  spawnWorker(input: SpawnWorkerInput): SpawnWorkerResult {
    const run = this.requireRun(input.runId);
    const runStatus = String(run.payload.status) as TeamRunStatus;
    if (!new Set<TeamRunStatus>(["planning", "running"]).has(runStatus)) {
      throw new Error(`Team Run ${run.id} cannot create Workers from status ${runStatus}`);
    }
    const workspaceId = String(run.workspaceId);
    const leaderId = String(run.payload.leader_id);
    if (input.createdBy !== leaderId) {
      throw new Error(`Only Team Run leader ${leaderId} can create temporary Workers in this lifecycle slice`);
    }
    const leader = this.requireActiveWorkspaceBot(leaderId, workspaceId);
    this.assertWorkerCreationAuthority(leader, input.tools ?? [], input.connections ?? []);

    const runBudget = normalizeBudget(run.payload.budget);
    const leaderCoordination = asObject(leader.payload.coordination);
    const leaderMaxWorkers = typeof leaderCoordination.max_parallel_workers === "number"
      ? leaderCoordination.max_parallel_workers
      : null;
    const capacityBudget = inheritBudget(runBudget, leaderMaxWorkers === null ? {} : { max_workers: leaderMaxWorkers });
    this.policy.assertWorkerCapacity({ workspaceId, runId: run.id, budget: capacityBudget, additionalWorkers: 1 });

    const workerId = createId("worker");
    const taskId = createId("task");
    const leaseId = createId("lease");
    const environmentLeaseId = createId("envlease");
    const roleTitle = nonEmpty(input.role.title, "Worker role title");
    const objective = nonEmpty(input.role.objective, "Worker objective");
    const requestedBudget = inheritBudget(runBudget, input.budget);
    const parentTaskId = typeof run.payload.parent_task_id === "string" && run.payload.parent_task_id.length > 0
      ? run.payload.parent_task_id
      : undefined;
    const prepared = this.policy.prepareDelegation({
      createdBy: leaderId,
      assigneeId: workerId,
      workspaceId,
      rootObjectiveId: String(run.payload.root_objective_id),
      objective,
      requiredConstraints: input.requiredConstraints,
      tools: input.tools,
      connections: input.connections,
      parentTaskId,
      deadlineAt: input.deadlineAt,
      budget: requestedBudget
    });
    const taskBudget = inheritBudget(runBudget, prepared.budget);
    const requiredConstraints = normalizeConstraints(prepared.requiredConstraints);
    const leaseExpiresAt = this.resolveLeaseExpiry(input.leaseExpiresAt);
    const runtime = this.resolveWorkerRuntime(leader, input);
    const execution = this.resolveWorkerExecution(leader, workspaceId, input);

    const capabilityLease = validateProtocolObject({
      schema_version: "1.0",
      id: leaseId,
      type: "capability_lease",
      principal: leaderId,
      issued_to: workerId,
      workspace_id: workspaceId,
      task_id: taskId,
      tools: [...new Set(input.tools ?? [])],
      connections: [...new Set(input.connections ?? [])],
      destructive_actions: "deny",
      expires_at: leaseExpiresAt
    }, "capability_lease");
    const environmentLease = validateProtocolObject({
      schema_version: "1.0",
      id: environmentLeaseId,
      type: "environment_lease",
      issued_to: workerId,
      workspace_id: workspaceId,
      task_id: taskId,
      environment_policy: execution.environment_policy,
      environment_ref: execution.environment_ref,
      expires_at: leaseExpiresAt
    }, "environment_lease");
    const task = validateProtocolObject({
      schema_version: "1.0",
      id: taskId,
      type: "task.delegate",
      created_by: leaderId,
      assignee_id: workerId,
      owner_id: workerId,
      root_owner_id: leaderId,
      workspace_id: workspaceId,
      run_id: run.id,
      root_objective_id: String(run.payload.root_objective_id),
      parent_task_id: prepared.parentTaskId,
      reason: `Temporary Worker ${roleTitle} created for Team Run ${run.id}`,
      objective,
      required_constraints: requiredConstraints,
      constraints_digest: constraintsDigest(requiredConstraints),
      expected_output: input.expectedOutput ?? { contract: "artifact-or-structured-result" },
      input_artifact_refs: [],
      lease_id: leaseId,
      environment_lease_id: environmentLeaseId,
      response_target: { kind: "bot", id: leaderId },
      deadline_at: prepared.deadlineAt,
      budget: taskBudget,
      approval_id: null,
      hop: prepared.hop,
      max_hops: prepared.maxHops,
      execution_state: "not_scheduled",
      status: "created"
    }, "task");
    const worker = validateProtocolObject({
      schema_version: "1.0",
      id: workerId,
      type: "worker",
      kind: "temporary",
      run_id: run.id,
      task_id: taskId,
      created_by: leaderId,
      parent_owner_id: leaderId,
      workspace_id: workspaceId,
      role: { title: roleTitle, objective },
      runtime,
      execution,
      capability_lease_id: leaseId,
      environment_lease_id: environmentLeaseId,
      budget: taskBudget,
      output_contract: input.expectedOutput ?? { contract: "artifact-or-structured-result" },
      required_constraints: requiredConstraints,
      status: "created",
      created_at: nowIso()
    }, "worker");

    const updatedRun = validateProtocolObject({
      ...run.payload,
      participant_ids: [...new Set([...stringArray(run.payload.participant_ids), workerId])],
      worker_ids: [...new Set([...stringArray(run.payload.worker_ids), workerId])],
      task_ids: [...new Set([...stringArray(run.payload.task_ids), taskId])],
      updated_at: nowIso()
    }, "team_run");

    const events = [
      this.prepareEvent({
        type: "worker.created",
        actorId: leaderId,
        runId: run.id,
        taskId,
        workspaceId,
        correlationId: String(run.payload.root_objective_id),
        summary: `Created temporary Worker ${workerId} as ${roleTitle}`,
        attentionState: "working"
      }),
      this.prepareEvent({
        type: "task.created",
        actorId: leaderId,
        runId: run.id,
        taskId,
        workspaceId,
        correlationId: String(run.payload.root_objective_id),
        summary: `Created unscheduled Worker Task ${taskId}`
      }),
      this.prepareEvent({
        type: "run.participant_added",
        actorId: leaderId,
        runId: run.id,
        taskId,
        workspaceId,
        correlationId: String(run.payload.root_objective_id),
        summary: `Added ${workerId} to Team Run ${run.id}`
      })
    ];

    const mutation = this.store.atomicMutation({
      preconditions: [{ id: run.id, kind: "team_run", status: runStatus }],
      objects: [
        { kind: "team_run", payload: updatedRun },
        { kind: "capability_lease", payload: capabilityLease },
        { kind: "environment_lease", payload: environmentLease },
        { kind: "task", payload: task },
        { kind: "worker", payload: worker }
      ],
      events
    });
    this.gateway.events.publishCommitted(mutation.events);

    const byId = new Map(mutation.objects.map((object) => [object.id, object]));
    const storedRun = byId.get(run.id);
    const storedWorker = byId.get(workerId);
    const storedTask = byId.get(taskId);
    const storedLease = byId.get(leaseId);
    const storedEnvironmentLease = byId.get(environmentLeaseId);
    if (!storedRun || !storedWorker || !storedTask || !storedLease || !storedEnvironmentLease) {
      throw new Error(`Worker ${workerId} creation committed without all expected records`);
    }
    return {
      run: storedRun,
      worker: storedWorker,
      task: storedTask,
      capabilityLease: storedLease,
      environmentLease: storedEnvironmentLease,
      events: mutation.events
    };
  }

  transitionWorker(workerId: string, targetStatus: WorkerStatus, actorId: string, reason?: string): LifecycleTransitionResult {
    const worker = this.requireWorker(workerId);
    const current = String(worker.payload.status) as WorkerStatus;
    if (!(current in WORKER_TRANSITIONS)) throw new Error(`Worker ${worker.id} has unsupported status ${current}`);
    if (!WORKER_TRANSITIONS[current].has(targetStatus)) {
      throw new Error(`Worker ${worker.id} cannot transition from ${current} to ${targetStatus}`);
    }
    const run = this.requireRun(String(worker.payload.run_id));
    this.assertWorkerActor(run, worker, actorId);
    if (TERMINAL_RUN_STATES.has(String(run.payload.status) as TeamRunStatus)) {
      throw new Error(`Worker ${worker.id} cannot transition because Team Run ${run.id} is terminal`);
    }
    const task = this.requireTask(String(worker.payload.task_id));
    if (task.workspaceId !== worker.workspaceId || String(task.payload.run_id) !== run.id) {
      throw new Error(`Worker ${worker.id} Task ${task.id} is outside its Team Run scope`);
    }

    const taskStatus = String(task.payload.status);
    if (targetStatus === "running" && !new Set(["assigned", "running"]).has(taskStatus)) {
      throw new Error(`Worker ${worker.id} cannot run while Task ${task.id} is ${taskStatus}`);
    }
    if (targetStatus === "completed" && taskStatus !== "completed") {
      throw new Error(`Worker ${worker.id} cannot complete before Task ${task.id} completes`);
    }
    if (targetStatus === "failed" && taskStatus !== "failed" && taskStatus !== "created") {
      throw new Error(`Worker ${worker.id} failure must be settled through active Task ${task.id}`);
    }
    if ((targetStatus === "canceled" || targetStatus === "expired") && taskStatus !== "canceled" && taskStatus !== "created") {
      throw new Error(`Worker ${worker.id} ${targetStatus} must be settled through active Task ${task.id}`);
    }

    const timestamp = nowIso();
    const workerPayload = validateProtocolObject({
      ...worker.payload,
      status: targetStatus,
      ...(targetStatus === "running" && typeof worker.payload.started_at !== "string" ? { started_at: timestamp } : {}),
      ...(TERMINAL_WORKER_STATES.has(targetStatus) ? { ended_at: timestamp } : {}),
      ...(reason?.trim() ? { transition_reason: reason.trim() } : {})
    }, "worker");
    const objects: Array<{ kind: "worker" | "task"; payload: JsonObject }> = [{ kind: "worker", payload: workerPayload }];
    const preconditions: Array<{ id: string; kind: "worker" | "task"; status?: string }> = [
      { id: worker.id, kind: "worker", status: current }
    ];
    const events: CoordinationEvent[] = [];

    if (taskStatus === "created" && new Set<WorkerStatus>(["failed", "canceled", "expired"]).has(targetStatus)) {
      const mappedTaskStatus = targetStatus === "failed" ? "failed" : "canceled";
      objects.push({
        kind: "task",
        payload: validateProtocolObject({
          ...task.payload,
          status: mappedTaskStatus,
          ended_at: timestamp,
          failure_code: targetStatus === "expired" ? "WORKER_EXPIRED_BEFORE_EXECUTION" : targetStatus === "failed" ? "WORKER_FAILED_BEFORE_EXECUTION" : "WORKER_CANCELED_BEFORE_EXECUTION"
        }, "task")
      });
      preconditions.push({ id: task.id, kind: "task", status: "created" });
      events.push(this.prepareEvent({
        type: mappedTaskStatus === "failed" ? "task.failed" : "task.canceled",
        actorId,
        runId: run.id,
        taskId: task.id,
        workspaceId: String(run.workspaceId),
        correlationId: String(run.payload.root_objective_id),
        summary: `Task ${task.id} settled because Worker ${worker.id} became ${targetStatus}`,
        attentionState: mappedTaskStatus === "failed" ? "failed" : "none"
      }));
    }

    events.unshift(this.prepareEvent({
      type: `worker.${targetStatus}`,
      actorId,
      runId: run.id,
      taskId: task.id,
      workspaceId: String(run.workspaceId),
      correlationId: String(run.payload.root_objective_id),
      summary: reason?.trim() || `Worker ${worker.id} transitioned from ${current} to ${targetStatus}`,
      attentionState: targetStatus === "waiting" ? "needs_input" : targetStatus === "failed" ? "failed" : TERMINAL_WORKER_STATES.has(targetStatus) ? "none" : "working"
    }));

    const mutation = this.store.atomicMutation({ preconditions, objects, events });
    this.gateway.events.publishCommitted(mutation.events);
    const object = mutation.objects.find((candidate) => candidate.id === worker.id);
    if (!object) throw new Error(`Worker ${worker.id} transition did not persist`);
    return { object, events: mutation.events };
  }

  private requireRun(runId: string): StoredObject {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Team Run ${runId} not found`);
    return run;
  }

  private requireWorker(workerId: string): StoredObject {
    const worker = this.store.getObject(workerId);
    if (!worker || worker.kind !== "worker") throw new Error(`Worker ${workerId} not found`);
    return worker;
  }

  private requireTask(taskId: string): StoredObject {
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task") throw new Error(`Task ${taskId} not found`);
    return task;
  }

  private requireActiveWorkspaceBot(botId: string, workspaceId: string): StoredObject<BotManifest> {
    const bot = this.gateway.getBot(botId);
    if (!bot) throw new Error(`Bot ${botId} not found`);
    if (bot.payload.status !== "active") throw new Error(`Bot ${botId} is not active`);
    if (bot.workspaceId !== workspaceId) throw new Error(`Bot ${botId} is outside workspace ${workspaceId}`);
    return bot;
  }

  private assertRunCreator(actorId: string, leaderId: string): void {
    if (actorId === leaderId || actorId.startsWith("operator_")) return;
    throw new Error(`Only leader ${leaderId} or an operator can create its Team Run`);
  }

  private assertRunActor(run: StoredObject, actorId: string): void {
    const leaderId = String(run.payload.leader_id);
    if (actorId === leaderId || actorId.startsWith("operator_")) return;
    throw new Error(`Only Team Run leader ${leaderId} or an operator can transition ${run.id}`);
  }

  private assertWorkerActor(run: StoredObject, worker: StoredObject, actorId: string): void {
    if (actorId === worker.id || actorId === String(run.payload.leader_id) || actorId.startsWith("operator_")) return;
    throw new Error(`${actorId} cannot transition Worker ${worker.id}`);
  }

  private assertWorkerCreationAuthority(leader: StoredObject<BotManifest>, tools: string[], connections: string[]): void {
    const permissions = asObject(leader.payload.permissions);
    if (permissions.can_create_workers !== true) throw new Error(`Bot ${leader.id} is not explicitly allowed to create Workers`);
    this.assertSubset(tools, permissions.allowed_tools, `tool`, leader.id);
    this.assertSubset(connections, permissions.allowed_connections, `connection`, leader.id);
  }

  private assertSubset(requested: string[], allowedValue: unknown, kind: string, leaderId: string): void {
    if (!Array.isArray(allowedValue)) return;
    const allowed = new Set(allowedValue.map(String));
    for (const item of requested) {
      if (!allowed.has("*") && !allowed.has(item)) {
        throw new Error(`Worker cannot receive ${kind} ${item}; leader ${leaderId} does not hold that authority`);
      }
    }
  }

  private resolveLeaseExpiry(value?: string): string {
    const expiresAt = value ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const timestamp = Date.parse(expiresAt);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new Error(`Worker lease expiry must be a future timestamp`);
    return new Date(timestamp).toISOString();
  }

  private resolveWorkerRuntime(leader: StoredObject<BotManifest>, input: SpawnWorkerInput): JsonObject {
    const leaderRuntime = asObject(leader.payload.runtime);
    const adapter = input.runtimeAdapter?.trim() || (typeof leaderRuntime.adapter === "string" ? leaderRuntime.adapter : "");
    if (!adapter) throw new Error(`Worker runtime adapter is required`);
    const leaderProfile = typeof leaderRuntime.profile_ref === "string" ? leaderRuntime.profile_ref : null;
    const profileRef = input.runtimeProfileRef === undefined ? leaderProfile : input.runtimeProfileRef;
    return { adapter, profile_ref: profileRef };
  }

  private resolveWorkerExecution(leader: StoredObject<BotManifest>, workspaceId: string, input: SpawnWorkerInput): JsonObject {
    const leaderExecution = asObject(leader.payload.execution);
    const leaderPolicy = typeof leaderExecution.environment_policy === "string" ? leaderExecution.environment_policy : null;
    const environmentPolicy = input.environmentPolicy ?? (leaderPolicy === "shared_workspace" ? "shared_workspace" : "isolated_run");
    if (!["shared_workspace", "isolated_run", "external_managed"].includes(environmentPolicy)) {
      throw new Error(`Unsupported Worker environment policy ${String(environmentPolicy)}`);
    }
    if (environmentPolicy === "shared_workspace") {
      return {
        environment_policy: "shared_workspace",
        environment_ref: `workspace:${workspaceId}`,
        persistence: "run_scoped"
      };
    }
    const environmentRef = input.environmentRef?.trim();
    if (!environmentRef) {
      throw new Error(`${environmentPolicy} Worker execution requires a trusted environmentRef from runtime infrastructure`);
    }
    return {
      environment_policy: environmentPolicy,
      environment_ref: environmentRef,
      persistence: "run_scoped"
    };
  }

  private prepareEvent(input: {
    type: string;
    actorId: string;
    runId: string;
    workspaceId: string;
    correlationId: string;
    summary: string;
    taskId?: string;
    attentionState?: string;
  }): CoordinationEvent {
    return this.gateway.events.prepare({
      schema_version: "1.0",
      id: createId("evt"),
      type: input.type,
      timestamp: nowIso(),
      actor_id: input.actorId,
      workspace_id: input.workspaceId,
      run_id: input.runId,
      task_id: input.taskId ?? null,
      room_id: null,
      thread_id: null,
      correlation_id: input.correlationId,
      causation_id: null,
      trace_id: null,
      summary: input.summary,
      ...(input.attentionState ? { attention_state: input.attentionState } : {})
    });
  }
}
