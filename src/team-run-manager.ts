import { inheritBudget, type BudgetEnvelope } from "./budget.js";
import { constraintsDigest, normalizeConstraints } from "./constraints.js";
import { createId } from "./id.js";
import type { RecoveryPolicy } from "./execution-queue.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { parseTaskMemoryRecallRequest } from "./memory-recall-runtime.js";
import type { HistoricalRecallRequest } from "./runtime.js";
import { parseTaskSkillRefs } from "./skills-capability-runtime.js";
import { BotRunner } from "./runner.js";
import { TeamRunCleanup, type TeamRunCleanupResult } from "./team-run-cleanup.js";
import { TeamRunCoordinator, type RuntimeTeamLeader, type TeamRunStatus } from "./team-runs.js";
import type { JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);

export interface ManagedWorkerTaskInput {
  runId: string;
  createdBy: string;
  roleTitle: string;
  objective: string;
  reason: string;
  workerId?: string;
  runtime?: JsonObject;
  execution?: JsonObject;
  requiredConstraints?: string[];
  expectedOutput?: JsonObject;
  inputArtifactRefs?: string[];
  memoryRecall?: HistoricalRecallRequest;
  skillRefs?: string[];
  tools?: string[];
  connections?: string[];
  parentTaskId?: string;
  maxHops?: number;
  deadlineAt?: string;
  leaseExpiresAt?: string;
  budget?: BudgetEnvelope;
  recoveryPolicy?: RecoveryPolicy;
  maxAttempts?: number;
}

export interface ManagedWorkerTaskResult {
  run: StoredObject;
  worker: StoredObject;
  task: StoredObject;
  lease: StoredObject;
}

export interface RunScopedTemporaryWorkerInput {
  leaderId: string;
  workspaceId: string;
  rootObjectiveId: string;
  objective: string;
  roleTitle: string;
  reason: string;
  runtimeLeader: RuntimeTeamLeader;
  workerRuntime?: JsonObject;
  execution?: JsonObject;
  requiredConstraints?: string[];
  expectedOutput?: JsonObject;
  inputArtifactRefs?: string[];
  memoryRecall?: HistoricalRecallRequest;
  skillRefs?: string[];
  tools?: string[];
  connections?: string[];
  maxHops?: number;
  deadlineAt?: string;
  leaseExpiresAt?: string;
  runBudget?: BudgetEnvelope;
  workerBudget?: BudgetEnvelope;
  recoveryPolicy?: RecoveryPolicy;
  maxAttempts?: number;
}

export interface RunScopedTemporaryWorkerResult {
  run: StoredObject;
  worker: StoredObject;
  task: StoredObject;
  lease: StoredObject;
  artifact: StoredObject | null;
  cleanup: TeamRunCleanupResult;
  executionStatus: "completed" | "failed" | "canceled";
}

/**
 * Host-neutral manager/supervisor topology for a durable or run-scoped Team Run leader.
 *
 * Manager topology deliberately permits only one live Worker Task at a time.
 * Parallel execution is reserved for the dedicated fan-out topology so its
 * concurrency, aggregate budgets and join semantics can be enforced centrally.
 */
export class TeamRunManager {
  constructor(
    readonly teams: TeamRunCoordinator,
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly runner: BotRunner
  ) {}

  async runScopedTemporaryWorker(input: RunScopedTemporaryWorkerInput): Promise<RunScopedTemporaryWorkerResult> {
    const created = this.teams.createRun({
      leaderId: input.leaderId,
      workspaceId: input.workspaceId,
      rootObjectiveId: input.rootObjectiveId,
      objective: input.objective,
      topology: "manager",
      budget: input.runBudget,
      runtimeLeader: input.runtimeLeader
    });

    let managed: ManagedWorkerTaskResult;
    try {
      managed = this.createWorkerTask({
        runId: created.run.id,
        createdBy: input.leaderId,
        roleTitle: input.roleTitle,
        objective: input.objective,
        reason: input.reason,
        runtime: input.workerRuntime,
        execution: input.execution,
        requiredConstraints: input.requiredConstraints,
        expectedOutput: input.expectedOutput,
        inputArtifactRefs: input.inputArtifactRefs,
        memoryRecall: input.memoryRecall,
        skillRefs: input.skillRefs,
        tools: input.tools,
        connections: input.connections,
        maxHops: input.maxHops,
        deadlineAt: input.deadlineAt,
        leaseExpiresAt: input.leaseExpiresAt,
        budget: input.workerBudget,
        recoveryPolicy: input.recoveryPolicy,
        maxAttempts: input.maxAttempts
      });
    } catch (error) {
      const current = this.teams.getRun(created.run.id);
      if (current && !["completed", "failed", "canceled", "budget_exhausted"].includes(String(current.payload.status))) {
        try {
          this.teams.transitionRun(
            current.id,
            "failed",
            input.leaderId,
            "Temporary Worker setup failed: " + (error instanceof Error ? error.message : String(error))
          );
        } catch {
          // Preserve the original owner error; recovery/cleanup can inspect the run.
        }
      }
      throw error;
    }

    const execution = await this.runner.runNext(managed.worker.id);
    if (!execution) throw new Error("Temporary Worker " + managed.worker.id + " had no queued execution");

    let run = this.teams.getRun(managed.run.id);
    if (!run) throw new Error("Team Run " + managed.run.id + " disappeared during temporary Worker execution");
    const status = String(run.payload.status) as TeamRunStatus;

    if (!["completed", "failed", "canceled", "budget_exhausted"].includes(status)) {
      if (execution.status === "completed") {
        run = this.teams.transitionRun(run.id, "synthesizing", input.leaderId, "One-shot temporary Worker result is ready").run;
        run = this.teams.transitionRun(run.id, "completed", input.leaderId, "One-shot temporary Worker completed").run;
      } else if (execution.status === "canceled") {
        run = this.teams.transitionRun(run.id, "canceled", input.leaderId, "One-shot temporary Worker was canceled").run;
      } else {
        run = this.teams.transitionRun(run.id, "failed", input.leaderId, "One-shot temporary Worker failed").run;
      }
    }

    const cleanup = new TeamRunCleanup(this.teams, this.gateway, this.queue).cleanupRun(run.id, input.leaderId);
    const finalWorker = this.teams.getWorker(managed.worker.id);
    const finalTask = this.gateway.store.getObject(managed.task.id);
    const finalLease = this.gateway.store.getObject(managed.lease.id);
    if (!finalWorker || !finalTask || !finalLease) {
      throw new Error("One-shot temporary Worker " + managed.worker.id + " lost canonical coordination records during cleanup");
    }
    return {
      run: cleanup.run,
      worker: finalWorker,
      task: finalTask,
      lease: finalLease,
      artifact: execution.artifact,
      cleanup,
      executionStatus: execution.status
    };
  }

  createWorkerTask(input: ManagedWorkerTaskInput): ManagedWorkerTaskResult {
    const memoryRecall = parseTaskMemoryRecallRequest(input.memoryRecall);
    const run = this.ensureRunning(input.runId, input.createdBy);
    const leaderId = String(run.payload.leader_id ?? "");
    if (leaderId !== input.createdBy) throw new Error(`Only Team Run leader ${leaderId} can create managed Worker Tasks`);
    const leader = this.resolveLeaderAuthority(run);
    const workspaceId = String(run.payload.workspace_id);
    const skillRefs = parseTaskSkillRefs(input.skillRefs, workspaceId);

    this.assertNoLiveManagedWorker(run.id);
    this.assertLeaderAuthority(leader, input.tools ?? [], input.connections ?? [], skillRefs);
    const effectiveBudget = inheritBudget(run.payload.budget, input.budget);
    const workerCreated = this.teams.createWorker({
      runId: run.id,
      createdBy: leaderId,
      workerId: input.workerId,
      roleTitle: input.roleTitle,
      objective: input.objective,
      runtime: input.runtime,
      execution: input.execution,
      skillRefs,
      budget: effectiveBudget
    });
    const worker = workerCreated.worker;

    try {
      const prepared = this.gateway.policy?.prepareDelegation({
        createdBy: leaderId,
        assigneeId: worker.id,
        workspaceId: String(run.payload.workspace_id),
        rootObjectiveId: String(run.payload.root_objective_id),
        objective: input.objective,
        requiredConstraints: input.requiredConstraints,
        tools: input.tools,
        connections: input.connections,
        skillRefs,
        parentTaskId: input.parentTaskId,
        maxHops: input.maxHops,
        deadlineAt: input.deadlineAt,
        budget: effectiveBudget
      }) ?? {
        parentTaskId: input.parentTaskId ?? null,
        requiredConstraints: input.requiredConstraints ?? [],
        hop: 0,
        maxHops: input.maxHops ?? 6,
        deadlineAt: input.deadlineAt ?? null,
        budget: effectiveBudget
      };

      const artifactRefs = this.validateInputArtifacts(input.inputArtifactRefs ?? [], String(run.payload.workspace_id));
      const taskId = createId("task");
      const leaseId = createId("lease");
      const requiredConstraints = normalizeConstraints(prepared.requiredConstraints);
      const timestamp = new Date().toISOString();
      const leasePayload = validateProtocolObject({
        schema_version: "1.0",
        id: leaseId,
        type: "capability_lease",
        principal: leaderId,
        issued_to: worker.id,
        workspace_id: String(run.payload.workspace_id),
        task_id: taskId,
        tools: input.tools ?? [],
        connections: input.connections ?? [],
        destructive_actions: "deny",
        expires_at: input.leaseExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()
      }, "capability_lease");
      const taskPayload = validateProtocolObject({
        schema_version: "1.0",
        id: taskId,
        type: "task.delegate",
        created_by: leaderId,
        assignee_id: worker.id,
        owner_id: worker.id,
        workspace_id: String(run.payload.workspace_id),
        run_id: run.id,
        root_objective_id: String(run.payload.root_objective_id),
        parent_task_id: prepared.parentTaskId,
        reason: input.reason,
        objective: input.objective,
        required_constraints: requiredConstraints,
        constraints_digest: constraintsDigest(requiredConstraints),
        expected_output: input.expectedOutput ?? { contract: "artifact-or-structured-result" },
        input_artifact_refs: artifactRefs,
        ...(memoryRecall ? { memory_recall: memoryRecall } : {}),
        ...(skillRefs.length > 0 ? { skill_refs: skillRefs } : {}),
        lease_id: leaseId,
        environment_lease_id: null,
        response_target: leader.kind === "bot"
          ? { kind: "bot", id: leaderId }
          : { kind: "operator", id: leaderId },
        deadline_at: prepared.deadlineAt,
        budget: prepared.budget,
        hop: prepared.hop,
        max_hops: prepared.maxHops,
        recovery_policy: input.recoveryPolicy ?? "manual",
        max_attempts: Math.max(1, Math.floor(input.maxAttempts ?? (input.recoveryPolicy === "retry_safe" ? 3 : 1))),
        status: "assigned",
        created_at: timestamp
      }, "task");
      const workerPayload = validateProtocolObject({
        ...worker.payload,
        task_id: taskId,
        capability_lease_id: leaseId,
        status: "ready",
        updated_at: timestamp
      }, "worker");

      const mutation = this.gateway.store.atomicMutation({
        preconditions: [
          { id: run.id, kind: "team_run", status: String(run.payload.status) },
          { id: worker.id, kind: "worker", status: "created" }
        ],
        objects: [
          { kind: "capability_lease", payload: leasePayload },
          { kind: "task", payload: taskPayload },
          { kind: "worker", payload: workerPayload }
        ],
        events: []
      });
      const lease = mutation.objects.find((object) => object.id === leaseId);
      const task = mutation.objects.find((object) => object.id === taskId);
      const boundWorker = mutation.objects.find((object) => object.id === worker.id);
      if (!lease || !task || !boundWorker) throw new Error(`Managed Worker Task ${taskId} did not persist all protocol records`);

      try {
        this.queue.enqueueTask(task.id, worker.id, String(run.payload.workspace_id), {
          recoveryPolicy: input.recoveryPolicy,
          maxAttempts: input.maxAttempts
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.failUnqueuedWorker(task, boundWorker, message);
        throw error;
      }

      this.gateway.emit({
        type: "worker.task_bound",
        actorId: leaderId,
        workspaceId: String(run.payload.workspace_id),
        runId: run.id,
        taskId: task.id,
        correlationId: String(run.payload.root_objective_id),
        summary: `Bound temporary Worker ${worker.id} to managed Task ${task.id}`
      });
      this.gateway.emit({
        type: "task.assigned",
        actorId: leaderId,
        workspaceId: String(run.payload.workspace_id),
        runId: run.id,
        taskId: task.id,
        correlationId: String(run.payload.root_objective_id),
        summary: `Manager ${leaderId} assigned Team Run Task ${task.id} to ${worker.id}`
      });
      return { run: this.teams.getRun(run.id) ?? run, worker: boundWorker, task, lease };
    } catch (error) {
      const latestWorker = this.teams.getWorker(worker.id);
      if (latestWorker?.payload.status === "created") {
        this.teams.transitionWorker(worker.id, "failed", leaderId, `Managed Worker setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  async cancelRun(runId: string, actorId: string, reason = "Team Run canceled by leader"): Promise<StoredObject> {
    return (await this.runner.teamRunControl.cancelRun(runId, actorId, reason)).run;
  }

  private ensureRunning(runId: string, actorId: string): StoredObject {
    let run = this.teams.getRun(runId);
    if (!run) throw new Error(`Team Run ${runId} not found`);
    if (String(run.payload.leader_id ?? "") !== actorId) throw new Error(`Only Team Run leader ${String(run.payload.leader_id)} can start managed work`);
    const status = String(run.payload.status) as TeamRunStatus;
    if (status === "created") {
      run = this.teams.transitionRun(runId, "planning", actorId, "Manager topology planning started").run;
      run = this.teams.transitionRun(runId, "running", actorId, "Manager topology execution started").run;
    } else if (status === "planning" || status === "waiting_input" || status === "waiting_approval") {
      run = this.teams.transitionRun(runId, "running", actorId, "Manager topology execution resumed").run;
    } else if (status !== "running") {
      throw new Error(`Team Run ${runId} cannot create managed Worker work from status ${status}`);
    }
    return run;
  }

  private assertNoLiveManagedWorker(runId: string): void {
    for (const worker of this.teams.listWorkers(runId)) {
      const taskId = typeof worker.payload.task_id === "string" ? worker.payload.task_id : null;
      if (!taskId) continue;
      const task = this.gateway.store.getObject(taskId);
      if (task?.kind === "task" && !TERMINAL_TASK_STATES.has(String(task.payload.status))) {
        throw new Error(`Manager topology permits one active Worker Task at a time; ${task.id} is still ${String(task.payload.status)}`);
      }
    }
  }

  private resolveLeaderAuthority(run: StoredObject): {
    id: string;
    kind: "bot" | "runtime";
    permissions: JsonObject;
    capabilities: JsonObject;
  } {
    const leaderId = String(run.payload.leader_id ?? "");
    if (run.payload.leader_kind === "runtime") {
      if (!leaderId.startsWith("runtime_") || run.payload.leader_lifecycle !== "run_scoped") {
        throw new Error(`Team Run ${run.id} has invalid run-scoped runtime leader metadata`);
      }
      return {
        id: leaderId,
        kind: "runtime",
        permissions: asObject(run.payload.leader_permissions),
        capabilities: asObject(run.payload.leader_capabilities)
      };
    }
    const leader = this.gateway.getBot(leaderId);
    if (!leader || leader.payload.status !== "active") throw new Error(`Team Run leader ${leaderId} is not active`);
    if (leader.workspaceId !== run.workspaceId) throw new Error(`Team Run leader ${leaderId} is outside workspace ${String(run.workspaceId)}`);
    return {
      id: leaderId,
      kind: "bot",
      permissions: asObject(leader.payload.permissions),
      capabilities: asObject(leader.payload.capabilities)
    };
  }

  private assertLeaderAuthority(
    leader: { id: string; kind: "bot" | "runtime"; permissions: JsonObject; capabilities: JsonObject },
    tools: string[],
    connections: string[],
    skillRefs: string[] = []
  ): void {
    const permissions = leader.permissions;
    const allowedTools = Array.isArray(permissions.allowed_tools) ? stringArray(permissions.allowed_tools) : null;
    const allowedConnections = Array.isArray(permissions.allowed_connections) ? stringArray(permissions.allowed_connections) : null;
    if (allowedTools && !allowedTools.includes("*")) {
      for (const tool of tools) if (!allowedTools.includes(tool)) throw new Error(`Managed Worker cannot expand leader tool authority to ${tool}`);
    }
    if (allowedConnections && !allowedConnections.includes("*")) {
      for (const connection of connections) if (!allowedConnections.includes(connection)) throw new Error(`Managed Worker cannot expand leader connection authority to ${connection}`);
    }
    const declaredSkills = new Set(stringArray(leader.capabilities.skill_refs));
    for (const skillRef of skillRefs) if (!declaredSkills.has(skillRef)) throw new Error(`Managed Worker cannot use undeclared leader skill capability ${skillRef}`);
  }

  private validateInputArtifacts(refs: string[], workspaceId: string): string[] {
    const unique = [...new Set(refs)];
    for (const ref of unique) {
      const artifact = this.gateway.store.getObject(ref);
      if (!artifact || artifact.kind !== "artifact") throw new Error(`Input Artifact ${ref} not found`);
      if (artifact.workspaceId !== workspaceId) throw new Error(`Input Artifact ${ref} is outside workspace ${workspaceId}`);
    }
    return unique;
  }

  private failUnqueuedWorker(task: StoredObject, worker: StoredObject, reason: string): void {
    const timestamp = new Date().toISOString();
    this.gateway.store.atomicMutation({
      preconditions: [
        { id: task.id, kind: "task", status: String(task.payload.status), ownerId: worker.id },
        { id: worker.id, kind: "worker", status: String(worker.payload.status) }
      ],
      objects: [
        { kind: "task", payload: validateProtocolObject({ ...task.payload, status: "failed", failed_at: timestamp, failure_reason: `Execution queue enqueue failed: ${reason}` }, "task") },
        { kind: "worker", payload: validateProtocolObject({ ...worker.payload, status: "failed", failed_at: timestamp, terminal_at: timestamp, status_reason: reason, updated_at: timestamp }, "worker") }
      ],
      events: []
    });
    this.gateway.emit({
      type: "task.failed",
      actorId: String(task.payload.created_by),
      workspaceId: task.workspaceId,
      runId: typeof task.payload.run_id === "string" ? task.payload.run_id : null,
      taskId: task.id,
      correlationId: String(task.payload.root_objective_id),
      summary: `Execution queue enqueue failed: ${reason}`,
      attentionState: "failed"
    });
  }
}
