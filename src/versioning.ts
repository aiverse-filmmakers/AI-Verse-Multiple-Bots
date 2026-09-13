export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

export type VersionOrder = "older" | "same" | "newer";

export class VersionParseError extends Error {
  constructor(readonly version: string) {
    super(`Unsupported semantic version '${version}'`);
    this.name = "VersionParseError";
  }
}

export function parseVersion(input: string): ParsedVersion {
  const value = input.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) throw new VersionParseError(input);
  const prerelease = match[4]
    ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part)
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease
  };
}

function comparePart(left: string | number, right: string | number): number {
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
  if (typeof left === "number") return -1;
  if (typeof right === "number") return 1;
  return left < right ? -1 : 1;
}

export function compareVersions(leftInput: string, rightInput: string): number {
  const left = parseVersion(leftInput);
  const right = parseVersion(rightInput);
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const compared = comparePart(leftPart, rightPart);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function versionOrder(installed: string, target: string): VersionOrder {
  const compared = compareVersions(installed, target);
  return compared < 0 ? "older" : compared > 0 ? "newer" : "same";
}
