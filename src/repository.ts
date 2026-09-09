import { CoordinationStore } from "./store.js";
import type { JsonObject, ProtocolKind, StoredObject } from "./types.js";

export type RepositoryKind = Exclude<ProtocolKind, "event">;

export class ProtocolRepository<K extends RepositoryKind> {
  constructor(
    private readonly store: CoordinationStore,
    readonly kind: K
  ) {}

  put(payload: JsonObject): StoredObject {
    return this.store.putObject(this.kind, payload);
  }

  get(id: string): StoredObject | null {
    const stored = this.store.getObject(id);
    return stored?.kind === this.kind ? stored : null;
  }

  list(workspaceId?: string): StoredObject[] {
    return this.store.listObjects(this.kind, workspaceId);
  }
}

export interface CoordinationRepositories {
  bots: ProtocolRepository<"bot">;
  workers: ProtocolRepository<"worker">;
  rooms: ProtocolRepository<"room">;
  threads: ProtocolRepository<"thread">;
  messages: ProtocolRepository<"message">;
  tasks: ProtocolRepository<"task">;
  handoffs: ProtocolRepository<"handoff">;
  teamRuns: ProtocolRepository<"team_run">;
  artifacts: ProtocolRepository<"artifact">;
  approvals: ProtocolRepository<"approval">;
  capabilityLeases: ProtocolRepository<"capability_lease">;
  environmentLeases: ProtocolRepository<"environment_lease">;
}

export function createCoordinationRepositories(store: CoordinationStore): CoordinationRepositories {
  return {
    bots: new ProtocolRepository(store, "bot"),
    workers: new ProtocolRepository(store, "worker"),
    rooms: new ProtocolRepository(store, "room"),
    threads: new ProtocolRepository(store, "thread"),
    messages: new ProtocolRepository(store, "message"),
    tasks: new ProtocolRepository(store, "task"),
    handoffs: new ProtocolRepository(store, "handoff"),
    teamRuns: new ProtocolRepository(store, "team_run"),
    artifacts: new ProtocolRepository(store, "artifact"),
    approvals: new ProtocolRepository(store, "approval"),
    capabilityLeases: new ProtocolRepository(store, "capability_lease"),
    environmentLeases: new ProtocolRepository(store, "environment_lease")
  };
}
