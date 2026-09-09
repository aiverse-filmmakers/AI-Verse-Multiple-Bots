import type { RuntimeUsage } from "./budget.js";
import type { BotManifest, JsonObject, StoredObject } from "./types.js";

export interface RuntimeExecutionContext {
  bot: StoredObject<BotManifest>;
  task: StoredObject;
  capabilityLease: StoredObject;
  environmentLease: StoredObject | null;
  inputArtifacts: StoredObject[];
  signal: AbortSignal;
}

export interface RuntimeExecutionResult {
  summary: string;
  artifactKind: string;
  output: JsonObject;
  usage?: RuntimeUsage;
  receipts?: JsonObject[];
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
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Task canceled");
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
        environment_lease_id: context.environmentLease?.id ?? null,
        result: `Completed: ${objective}`
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cost: 0,
        actions: 1
      },
      receipts: [{ kind: "deterministic_execution", adapter: this.id }]
    };
  }
}
