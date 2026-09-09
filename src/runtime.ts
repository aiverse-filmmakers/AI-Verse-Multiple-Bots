import type { BotManifest, JsonObject, StoredObject } from "./types.js";

export interface RuntimeExecutionContext {
  bot: StoredObject<BotManifest>;
  task: StoredObject;
  capabilityLease: StoredObject;
  environmentLease: StoredObject | null;
  inputArtifacts: StoredObject[];
}

export interface RuntimeExecutionResult {
  summary: string;
  artifactKind: string;
  output: JsonObject;
}

export interface RuntimeAdapter {
  readonly id: string;
  execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult>;
  cancel?(taskId: string): Promise<void>;
}

export class RuntimeRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): this {
    if (this.adapters.has(adapter.id)) throw new Error(`Runtime adapter ${adapter.id} already registered`);
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): RuntimeAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Runtime adapter ${id} is not registered`);
    return adapter;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }
}

export class DeterministicRuntimeAdapter implements RuntimeAdapter {
  readonly id = "deterministic";

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    const objective = String(context.task.payload.objective ?? "");
    const constraints = Array.isArray(context.task.payload.required_constraints)
      ? context.task.payload.required_constraints.map(String)
      : [];

    return {
      summary: `Completed deterministically: ${objective}`,
      artifactKind: "deterministic_task_result",
      output: {
        objective,
        required_constraints: constraints,
        executed_by: context.bot.id,
        runtime_adapter: this.id,
        lease_id: context.capabilityLease.id,
        result: `Completed: ${objective}`
      }
    };
  }
}
