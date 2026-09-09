import { createHash } from "node:crypto";

export function normalizeConstraints(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
}

export function constraintsDigest(values: unknown): string {
  const canonical = JSON.stringify(normalizeConstraints(values));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
