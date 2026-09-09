import { CoordinationStore } from "./store.js";
import type { StoredObject } from "./types.js";

function normalizeObjective(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("::");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export class CoordinationLoopError extends Error {
  constructor(readonly code: "LOOP_DETECTED" | "PING_PONG_DETECTED" | "NO_PROGRESS_DETECTED", message: string) {
    super(message);
    this.name = "CoordinationLoopError";
  }
}

export interface LoopGuardOptions {
  maxAncestryDepth?: number;
  maxPairTransitions?: number;
  maxRepeatedResults?: number;
}

export class CoordinationLoopGuard {
  readonly maxAncestryDepth: number;
  readonly maxPairTransitions: number;
  readonly maxRepeatedResults: number;

  constructor(readonly store: CoordinationStore, options: LoopGuardOptions = {}) {
    this.maxAncestryDepth = options.maxAncestryDepth ?? 64;
    this.maxPairTransitions = options.maxPairTransitions ?? 3;
    this.maxRepeatedResults = options.maxRepeatedResults ?? 2;
  }

  assertDelegation(input: {
    parentTaskId?: string | null;
    createdBy: string;
    assigneeId: string;
    rootObjectiveId: string;
    objective: string;
  }): void {
    const lineage = this.lineage(input.parentTaskId ?? null);
    const objective = normalizeObjective(input.objective);

    for (const ancestor of lineage) {
      if (String(ancestor.payload.root_objective_id) !== input.rootObjectiveId) continue;
      if (String(ancestor.payload.assignee_id) !== input.assigneeId) continue;
      if (normalizeObjective(ancestor.payload.objective) === objective) {
        throw new CoordinationLoopError(
          "LOOP_DETECTED",
          `Delegation would repeat objective for ${input.assigneeId} already present at Task ${ancestor.id}`
        );
      }
    }

    const transitions = new Map<string, number>();
    for (const ancestor of [...lineage].reverse()) {
      const creator = String(ancestor.payload.created_by ?? "");
      const assignee = String(ancestor.payload.assignee_id ?? "");
      if (!creator || !assignee || creator === assignee) continue;
      const key = pairKey(creator, assignee);
      transitions.set(key, (transitions.get(key) ?? 0) + 1);
    }
    if (input.createdBy !== input.assigneeId) {
      const key = pairKey(input.createdBy, input.assigneeId);
      const count = (transitions.get(key) ?? 0) + 1;
      if (count >= this.maxPairTransitions) {
        throw new CoordinationLoopError(
          "PING_PONG_DETECTED",
          `Delegation would create ${count} transitions between ${input.createdBy} and ${input.assigneeId} in one lineage`
        );
      }
    }
  }

  assertProgress(input: {
    task: StoredObject;
    fingerprint: string;
  }): void {
    const objective = normalizeObjective(input.task.payload.objective);
    const assigneeId = String(input.task.payload.assignee_id ?? "");
    const rootObjectiveId = String(input.task.payload.root_objective_id ?? "");
    let repeats = 0;

    for (const candidate of this.store.listObjects("task", input.task.workspaceId ?? undefined)) {
      if (candidate.id === input.task.id) continue;
      if (candidate.payload.status !== "completed") continue;
      if (String(candidate.payload.root_objective_id ?? "") !== rootObjectiveId) continue;
      if (String(candidate.payload.assignee_id ?? "") !== assigneeId) continue;
      if (normalizeObjective(candidate.payload.objective) !== objective) continue;
      if (String(candidate.payload.progress_fingerprint ?? "") !== input.fingerprint) continue;
      repeats += 1;
    }

    if (repeats >= this.maxRepeatedResults) {
      throw new CoordinationLoopError(
        "NO_PROGRESS_DETECTED",
        `Task ${input.task.id} repeated the same result after ${repeats} prior equivalent completions`
      );
    }
  }

  private lineage(parentTaskId: string | null): StoredObject[] {
    const tasks: StoredObject[] = [];
    const seen = new Set<string>();
    let currentId = parentTaskId;
    while (currentId) {
      if (seen.has(currentId)) {
        throw new CoordinationLoopError("LOOP_DETECTED", `Existing Task lineage already contains a cycle at ${currentId}`);
      }
      if (tasks.length >= this.maxAncestryDepth) {
        throw new CoordinationLoopError("LOOP_DETECTED", `Task lineage exceeds ${this.maxAncestryDepth} ancestors`);
      }
      seen.add(currentId);
      const task = this.store.getObject(currentId);
      if (!task || task.kind !== "task") break;
      tasks.push(task);
      currentId = typeof task.payload.parent_task_id === "string" ? task.payload.parent_task_id : null;
    }
    return tasks;
  }
}

export function progressFingerprint(value: unknown): string {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
