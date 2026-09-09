import type { JsonObject } from "./types.js";

export interface BudgetEnvelope extends JsonObject {
  token_limit?: number | null;
  cost_limit?: number | null;
  wall_clock_seconds?: number | null;
  max_workers?: number | null;
  max_hops?: number | null;
  max_messages?: number | null;
  max_rounds?: number | null;
  max_tasks?: number | null;
  max_actions?: number | null;
}

export interface RuntimeUsage extends JsonObject {
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  actions?: number;
}

const BUDGET_KEYS = [
  "token_limit",
  "cost_limit",
  "wall_clock_seconds",
  "max_workers",
  "max_hops",
  "max_messages",
  "max_rounds",
  "max_tasks",
  "max_actions"
] as const;

type BudgetKey = typeof BUDGET_KEYS[number];

export class BudgetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

function asBudget(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

export function normalizeBudget(value: unknown): BudgetEnvelope {
  const source = asBudget(value);
  const budget: BudgetEnvelope = {};
  for (const key of BUDGET_KEYS) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      throw new BudgetError("INVALID_BUDGET", `${key} must be a non-negative finite number`);
    }
    if (key !== "cost_limit" && !Number.isInteger(raw)) {
      throw new BudgetError("INVALID_BUDGET", `${key} must be an integer`);
    }
    if (key === "wall_clock_seconds" && raw < 1) {
      throw new BudgetError("INVALID_BUDGET", "wall_clock_seconds must be at least 1");
    }
    budget[key] = raw;
  }
  return budget;
}

export function inheritBudget(parentValue: unknown, requestedValue: unknown): BudgetEnvelope {
  const parent = normalizeBudget(parentValue);
  const requested = normalizeBudget(requestedValue);
  const result: BudgetEnvelope = {};
  for (const key of BUDGET_KEYS) {
    const parentLimit = parent[key];
    const requestedLimit = requested[key];
    if (typeof parentLimit === "number" && typeof requestedLimit === "number") result[key] = Math.min(parentLimit, requestedLimit);
    else if (typeof parentLimit === "number") result[key] = parentLimit;
    else if (typeof requestedLimit === "number") result[key] = requestedLimit;
  }
  return result;
}

export function assertUsageWithinBudget(budgetValue: unknown, usageValue: unknown): RuntimeUsage {
  const budget = normalizeBudget(budgetValue);
  const usage = asBudget(usageValue) as RuntimeUsage;
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cost = Number(usage.cost ?? 0);
  const actions = Number(usage.actions ?? 0);
  for (const [name, value] of [["input_tokens", inputTokens], ["output_tokens", outputTokens], ["cost", cost], ["actions", actions]] as const) {
    if (!Number.isFinite(value) || value < 0) throw new BudgetError("INVALID_USAGE", `${name} must be a non-negative finite number`);
  }
  const totalTokens = inputTokens + outputTokens;
  if (typeof budget.token_limit === "number" && totalTokens > budget.token_limit) {
    throw new BudgetError("TOKEN_BUDGET_EXCEEDED", `Runtime used ${totalTokens} tokens with a limit of ${budget.token_limit}`);
  }
  if (typeof budget.cost_limit === "number" && cost > budget.cost_limit) {
    throw new BudgetError("COST_BUDGET_EXCEEDED", `Runtime cost ${cost} exceeds limit ${budget.cost_limit}`);
  }
  if (typeof budget.max_actions === "number" && actions > budget.max_actions) {
    throw new BudgetError("ACTION_BUDGET_EXCEEDED", `Runtime used ${actions} actions with a limit of ${budget.max_actions}`);
  }
  return { input_tokens: inputTokens, output_tokens: outputTokens, cost, actions };
}

export function effectiveDeadline(explicitDeadlineAt: string | null | undefined, startedAtMs: number, budgetValue: unknown): number | null {
  const budget = normalizeBudget(budgetValue);
  const explicit = explicitDeadlineAt ? Date.parse(explicitDeadlineAt) : null;
  const budgetDeadline = typeof budget.wall_clock_seconds === "number"
    ? startedAtMs + budget.wall_clock_seconds * 1000
    : null;
  if (explicit !== null && !Number.isFinite(explicit)) throw new BudgetError("INVALID_DEADLINE", "deadline_at must be a valid timestamp");
  if (explicit !== null && budgetDeadline !== null) return Math.min(explicit, budgetDeadline);
  return explicit ?? budgetDeadline;
}
