import type { ExecutionQueue } from "./execution-queue.js";
import type { WorkspaceStateProjector } from "./runtime.js";
import type { CoordinationStore } from "./store.js";
import type { JsonObject, StoredObject } from "./types.js";

export const FOUR_CS_HEALTH_SCHEMA = "1.0";
export const FOUR_CS_HEALTH_PROVIDER = "ai-verse-multiple-bots/4cs-health-v1";

const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

export type FourCsEvidenceStatus = "verified" | "degraded" | "unknown" | "not_applicable";

export interface FourCsEvidenceItem extends JsonObject {
  id: string;
  status: FourCsEvidenceStatus;
  summary: string;
  metrics?: JsonObject;
}

export interface FourCsDimension extends JsonObject {
  status: FourCsEvidenceStatus;
  evidence: FourCsEvidenceItem[];
}

export interface FourCsHealthIntegrations {
  nativeMode?: boolean;
  workspaceProjector?: WorkspaceStateProjector;
  brainIngressAvailable?: boolean;
  memoryRecallAvailable?: boolean;
  skillsResolutionAvailable?: boolean;
  automationIngressAvailable?: boolean;
  osWriteCommandAvailable?: boolean;
  candidateWritebackAvailable?: boolean;
}

export interface FourCsHealthProjection extends JsonObject {
  schema_version: "1.0";
  provider: typeof FOUR_CS_HEALTH_PROVIDER;
  projection_only: true;
  generated_at: string;
  scope: "coordination" | `workspace:${string}`;
  mode: "standalone" | "ai_verse_os";
  coordination_core: JsonObject;
  integration_contracts: JsonObject;
  four_cs: {
    context: FourCsDimension;
    connections: FourCsDimension;
    capabilities: FourCsDimension;
    cadence: FourCsDimension;
  };
  ownership: JsonObject;
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function receipts(artifact: StoredObject): JsonObject[] {
  const value = artifact.payload.runtime_receipts;
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function dimensionStatus(items: FourCsEvidenceItem[]): FourCsEvidenceStatus {
  if (items.some((item) => item.status === "degraded")) return "degraded";
  if (items.some((item) => item.status === "verified")) return "verified";
  if (items.length > 0 && items.every((item) => item.status === "not_applicable")) return "not_applicable";
  return "unknown";
}

function dimension(items: FourCsEvidenceItem[]): FourCsDimension {
  return { status: dimensionStatus(items), evidence: items };
}

function countReceiptKind(artifacts: StoredObject[], kind: string): number {
  let count = 0;
  for (const artifact of artifacts) {
    for (const receipt of receipts(artifact)) {
      if (receipt.kind === kind) count += 1;
    }
  }
  return count;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 512) || "unknown health probe failure";
}

/**
 * Read-only Four Cs evidence projection for AI-Verse OS /audit.
 *
 * This class does not score the OS, write health state, or promote derived
 * evidence into canonical truth. It exposes deterministic coordination evidence
 * so the host's existing Context / Connections / Capabilities / Cadence audit
 * can judge it alongside other system evidence.
 */
export class FourCsHealthProjector {
  constructor(
    readonly store: CoordinationStore,
    readonly queue: ExecutionQueue,
    readonly integrations: FourCsHealthIntegrations = {}
  ) {}

  project(workspaceId?: string): FourCsHealthProjection {
    if (workspaceId !== undefined && !WORKSPACE_ID.test(workspaceId)) {
      throw new Error(`workspace must be a canonical AI-Verse workspace id; received ${workspaceId}`);
    }

    const tasks = this.store.listObjects("task", workspaceId);
    const artifacts = this.store.listObjects("artifact", workspaceId);
    const bots = this.store.listObjects("bot", workspaceId);
    const workers = this.store.listObjects("worker", workspaceId);
    const runs = this.store.listObjects("team_run", workspaceId);
    const leases = this.store.listObjects("capability_lease", workspaceId);
    const approvals = this.store.listObjects("approval", workspaceId);
    const deadLetters = this.queue.listDeadLetters(workspaceId);
    const doctor = this.store.doctor();

    const completedTasks = tasks.filter((task) => task.payload.status === "completed").length;
    const failedTasks = tasks.filter((task) => task.payload.status === "failed").length;
    const activeTasks = tasks.filter((task) => ["assigned", "waiting_approval", "running"].includes(String(task.payload.status))).length;
    const activeBots = bots.filter((bot) => bot.payload.status === "active").length;
    const activeRuns = runs.filter((run) => ["planning", "running", "synthesizing", "verifying"].includes(String(run.payload.status))).length;
    const pendingApprovals = approvals.filter((approval) => approval.payload.status === "pending").length;

    let connectionGrantCount = 0;
    let connectionBearingLeaseCount = 0;
    for (const lease of leases) {
      const connections = stringArray(lease.payload.connections);
      if (connections.length > 0) connectionBearingLeaseCount += 1;
      connectionGrantCount += connections.length;
    }

    const skillRequestedTasks = tasks.filter((task) => stringArray(task.payload.skill_refs).length > 0).length;
    const skillReferenceCount = tasks.reduce((sum, task) => sum + stringArray(task.payload.skill_refs).length, 0);
    const automationTasks = tasks.filter((task) => Object.keys(asObject(task.payload.automation_ingress)).length > 0);
    const automationRuns = runs.filter((run) => Object.keys(asObject(run.payload.automation_ingress)).length > 0);
    const completedAutomationWork = automationTasks.filter((task) => task.payload.status === "completed").length
      + automationRuns.filter((run) => run.payload.status === "completed").length;
    const brainIngressTasks = tasks.filter((task) => Object.keys(asObject(task.payload.brain_ingress)).length > 0).length;

    const workspaceReceiptCount = countReceiptKind(artifacts, "workspace_state_projection");
    const brainReceiptCount = countReceiptKind(artifacts, "brain_strategic_intent");
    const memoryReceiptCount = countReceiptKind(artifacts, "historical_memory_recall");
    const skillsReceiptCount = countReceiptKind(artifacts, "skills_capability_resolution");

    const nativeMode = this.integrations.nativeMode === true;
    const contextEvidence: FourCsEvidenceItem[] = [];

    if (!nativeMode) {
      contextEvidence.push({
        id: "ai-verse-context-integration",
        status: "not_applicable",
        summary: "Standalone mode has no AI-Verse OS context projection contract."
      });
    } else if (!this.integrations.workspaceProjector) {
      contextEvidence.push({
        id: "workspace-context-projection",
        status: "degraded",
        summary: "AI-Verse OS native mode is active but no workspace projector is configured."
      });
    } else if (!workspaceId) {
      contextEvidence.push({
        id: "workspace-context-projection",
        status: "unknown",
        summary: "Workspace projection adapter is configured; live context health requires an explicit workspace scope."
      });
    } else {
      try {
        const projection = this.integrations.workspaceProjector.project(workspaceId);
        contextEvidence.push({
          id: "workspace-context-projection",
          status: "verified",
          summary: "Canonical workspace context projection resolved live without copying projected content into health output.",
          metrics: {
            workspace_id: projection.workspace_id,
            source_count: projection.sources.length,
            projection_digest_present: typeof projection.projection_digest === "string" && projection.projection_digest.length > 0
          }
        });
      } catch (error) {
        contextEvidence.push({
          id: "workspace-context-projection",
          status: "degraded",
          summary: `Live workspace context projection failed: ${safeError(error)}`
        });
      }
    }

    if (nativeMode) {
      contextEvidence.push({
        id: "brain-context-ingress",
        status: brainReceiptCount > 0 || brainIngressTasks > 0
          ? "verified"
          : this.integrations.brainIngressAvailable ? "unknown" : "degraded",
        summary: brainReceiptCount > 0 || brainIngressTasks > 0
          ? "Brain strategic context has coordination evidence."
          : this.integrations.brainIngressAvailable
            ? "Brain ingress contract is configured but no scoped execution evidence exists in this projection."
            : "Brain ingress contract is unavailable in native mode.",
        metrics: { ingress_task_count: brainIngressTasks, runtime_receipt_count: brainReceiptCount }
      });
      contextEvidence.push({
        id: "memory-context-recall",
        status: memoryReceiptCount > 0
          ? "verified"
          : this.integrations.memoryRecallAvailable ? "unknown" : "degraded",
        summary: memoryReceiptCount > 0
          ? "Historical Memory recall has runtime receipt evidence."
          : this.integrations.memoryRecallAvailable
            ? "Memory recall contract is configured but has no runtime receipt evidence in this projection."
            : "Memory recall contract is unavailable in native mode.",
        metrics: { runtime_receipt_count: memoryReceiptCount }
      });
    }

    if (workspaceReceiptCount > 0) {
      contextEvidence.push({
        id: "workspace-context-execution-evidence",
        status: "verified",
        summary: "Completed runtime Artifacts contain workspace projection receipts.",
        metrics: { runtime_receipt_count: workspaceReceiptCount }
      });
    }

    const connectionsEvidence: FourCsEvidenceItem[] = connectionGrantCount === 0
      ? [{
          id: "connection-grants",
          status: "not_applicable",
          summary: "No connection grants are present in the selected coordination scope.",
          metrics: { grant_count: 0, lease_count: 0 }
        }]
      : [{
          id: "connection-grants",
          status: "unknown",
          summary: "Connection grants exist, but Multiple Bots does not treat grants or completed Tasks as proof of live external access. AI-Verse OS must verify connection operation separately.",
          metrics: {
            grant_count: connectionGrantCount,
            lease_count: connectionBearingLeaseCount
          }
        }];

    const capabilityEvidence: FourCsEvidenceItem[] = [{
      id: "coordination-execution",
      status: completedTasks > 0 ? "verified" : activeBots > 0 ? "unknown" : "unknown",
      summary: completedTasks > 0
        ? "Coordination capability has completed Task evidence."
        : activeBots > 0
          ? "Durable Bots are active, but no completed Task evidence exists in this projection."
          : "No active durable Bot or completed Task evidence exists in this projection.",
      metrics: { active_bots: activeBots, completed_tasks: completedTasks, failed_tasks: failedTasks }
    }];

    if (skillRequestedTasks === 0 && skillsReceiptCount === 0) {
      capabilityEvidence.push({
        id: "skills-capability-resolution",
        status: this.integrations.skillsResolutionAvailable ? "unknown" : "not_applicable",
        summary: this.integrations.skillsResolutionAvailable
          ? "Skills resolution contract is configured, but no Task in this projection requested a Skill."
          : "No Skill-dependent work exists in this projection and no Skills resolver is configured.",
        metrics: { requested_task_count: 0, requested_ref_count: 0, runtime_receipt_count: 0 }
      });
    } else {
      capabilityEvidence.push({
        id: "skills-capability-resolution",
        status: skillsReceiptCount > 0
          ? "verified"
          : this.integrations.skillsResolutionAvailable ? "unknown" : "degraded",
        summary: skillsReceiptCount > 0
          ? "Skill-dependent execution has verified capability-resolution receipts."
          : this.integrations.skillsResolutionAvailable
            ? "Skill-dependent work is declared, but no successful capability-resolution receipt exists in this projection."
            : "Skill-dependent work exists without a configured Skills capability resolver.",
        metrics: {
          requested_task_count: skillRequestedTasks,
          requested_ref_count: skillReferenceCount,
          runtime_receipt_count: skillsReceiptCount
        }
      });
    }

    const cadenceEvidence: FourCsEvidenceItem[] = !nativeMode || !this.integrations.automationIngressAvailable
      ? [{
          id: "automation-cadence-ingress",
          status: "not_applicable",
          summary: nativeMode
            ? "No AI-Verse OS Automation ingress contract is configured."
            : "Standalone mode does not claim AI-Verse OS cadence integration."
        }]
      : [{
          id: "automation-cadence-ingress",
          status: automationTasks.length + automationRuns.length > 0 ? "verified" : "unknown",
          summary: automationTasks.length + automationRuns.length > 0
            ? "OS-owned automation invocations have durable coordination ingress evidence."
            : "Automation ingress contract is configured, but no invocation evidence exists in this projection.",
          metrics: {
            invocation_work_count: automationTasks.length + automationRuns.length,
            completed_invocation_work_count: completedAutomationWork
          }
        }];

    const coreStatus: FourCsEvidenceStatus = !doctor.ok || deadLetters.length > 0 ? "degraded" : "verified";

    return {
      schema_version: FOUR_CS_HEALTH_SCHEMA,
      provider: FOUR_CS_HEALTH_PROVIDER,
      projection_only: true,
      generated_at: new Date().toISOString(),
      scope: workspaceId ? `workspace:${workspaceId}` : "coordination",
      mode: nativeMode ? "ai_verse_os" : "standalone",
      coordination_core: {
        status: coreStatus,
        store_ok: doctor.ok,
        schema_version: doctor.schemaVersion,
        dead_letter_count: deadLetters.length,
        counts: {
          active_bots: activeBots,
          workers: workers.length,
          active_team_runs: activeRuns,
          tasks: tasks.length,
          active_tasks: activeTasks,
          completed_tasks: completedTasks,
          failed_tasks: failedTasks,
          artifacts: artifacts.length,
          pending_approvals: pendingApprovals
        }
      },
      integration_contracts: {
        workspace_projection: Boolean(this.integrations.workspaceProjector),
        brain_ingress: this.integrations.brainIngressAvailable === true,
        memory_recall: this.integrations.memoryRecallAvailable === true,
        skills_resolution: this.integrations.skillsResolutionAvailable === true,
        automation_ingress: this.integrations.automationIngressAvailable === true,
        os_write_command: this.integrations.osWriteCommandAvailable === true,
        candidate_writeback: this.integrations.candidateWritebackAvailable === true
      },
      four_cs: {
        context: dimension(contextEvidence),
        connections: dimension(connectionsEvidence),
        capabilities: dimension(capabilityEvidence),
        cadence: dimension(cadenceEvidence)
      },
      ownership: {
        canonical_health_owner: "ai-verse-os/audit",
        scoring_owner: "ai-verse-os/audit",
        coordination_evidence_owner: "ai-verse-multiple-bots",
        writes_os_health_state: false,
        assigns_four_cs_score: false,
        declared_connection_is_live_proof: false
      }
    };
  }
}
