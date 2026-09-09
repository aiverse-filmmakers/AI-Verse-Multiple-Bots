import { randomUUID } from "node:crypto";

const PREFIXES = new Set([
  "bot", "worker", "room", "thread", "conv", "run", "task", "msg", "evt",
  "art", "obj", "lease", "envlease", "approval", "corr", "trace", "delivery"
]);

export function createId(prefix: string): string {
  if (!PREFIXES.has(prefix)) {
    throw new Error(`Unsupported ID prefix: ${prefix}`);
  }
  return `${prefix}_${randomUUID()}`;
}
