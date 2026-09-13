import { resolve } from "node:path";
import { findAiVerseOsRoot } from "./ai-verse-os-registration.js";
import {
  planAiVerseOsProductUpdate,
  updateAiVerseOsProduct,
  type AiVerseOsProductUpdatePlan,
  type AiVerseOsProductUpdateResult
} from "./ai-verse-os-update.js";
import { findStandaloneRoot } from "./standalone-install.js";
import {
  planStandaloneUpdate,
  updateStandaloneInstallation,
  type StandaloneUpdatePlan,
  type StandaloneUpdateResult
} from "./standalone-update.js";

export type MultipleBotsUpdateMode = "standalone" | "ai-verse-os";
export type MultipleBotsUpdateSelection = "explicit" | "detected";

export interface MultipleBotsUpdateOptions {
  mode?: string;
  root?: string;
  cwd?: string;
}

export interface MultipleBotsUpdatePlan {
  mode: MultipleBotsUpdateMode;
  selected_by: MultipleBotsUpdateSelection;
  root: string;
  update_required: boolean;
  migration_required: boolean;
  migration_supported: boolean;
  can_update: boolean;
  plan: StandaloneUpdatePlan | AiVerseOsProductUpdatePlan;
}

export interface MultipleBotsUpdateResult {
  mode: MultipleBotsUpdateMode;
  selected_by: MultipleBotsUpdateSelection;
  root: string;
  status: "unchanged" | "adopted" | "updated";
  migration_performed: false;
  result: StandaloneUpdateResult | AiVerseOsProductUpdateResult;
}

export class MultipleBotsUpdateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MultipleBotsUpdateError";
  }
}

function normalizeMode(input: string | undefined): MultipleBotsUpdateMode | null {
  if (input === undefined) return null;
  const normalized = input.trim().toLowerCase();
  if (normalized === "standalone") return "standalone";
  if (normalized === "os" || normalized === "ai-verse-os" || normalized === "aiverse-os") return "ai-verse-os";
  throw new MultipleBotsUpdateError(
    "INVALID_UPDATE_MODE",
    `Unsupported update mode '${input}'. Use --mode standalone or --mode os.`
  );
}

function selectUpdate(options: MultipleBotsUpdateOptions): {
  mode: MultipleBotsUpdateMode;
  root: string;
  selectedBy: MultipleBotsUpdateSelection;
} {
  const cwd = resolve(options.cwd ?? ".");
  const explicitMode = normalizeMode(options.mode);
  if (explicitMode) {
    if (options.root) return { mode: explicitMode, root: resolve(options.root), selectedBy: "explicit" };
    if (explicitMode === "standalone") {
      return {
        mode: explicitMode,
        root: findStandaloneRoot(cwd) ?? cwd,
        selectedBy: "explicit"
      };
    }
    return {
      mode: explicitMode,
      root: findAiVerseOsRoot(cwd) ?? cwd,
      selectedBy: "explicit"
    };
  }

  const start = options.root ? resolve(options.root) : cwd;
  const standalone = findStandaloneRoot(start);
  const os = findAiVerseOsRoot(start);
  if (standalone && os) {
    throw new MultipleBotsUpdateError(
      "UPDATE_MODE_AMBIGUOUS",
      `Both standalone and AI-Verse OS installations are discoverable from ${start}. Pass --mode explicitly.`
    );
  }
  if (standalone) return { mode: "standalone", root: standalone, selectedBy: "detected" };
  if (os) return { mode: "ai-verse-os", root: os, selectedBy: "detected" };
  throw new MultipleBotsUpdateError(
    "UPDATE_INSTALLATION_NOT_FOUND",
    "No existing Multiple Bots installation was detected. Update never creates a fresh installation; run setup first."
  );
}

export function planMultipleBotsUpdate(options: MultipleBotsUpdateOptions = {}): MultipleBotsUpdatePlan {
  const selection = selectUpdate(options);
  const plan = selection.mode === "standalone"
    ? planStandaloneUpdate(selection.root)
    : planAiVerseOsProductUpdate(selection.root);
  return {
    mode: selection.mode,
    selected_by: selection.selectedBy,
    root: selection.root,
    update_required: plan.update_required,
    migration_required: plan.migration_required,
    migration_supported: plan.migration_supported,
    can_update: plan.can_update,
    plan
  };
}

export function updateMultipleBots(options: MultipleBotsUpdateOptions = {}): MultipleBotsUpdateResult {
  const selection = selectUpdate(options);
  const result = selection.mode === "standalone"
    ? updateStandaloneInstallation(selection.root)
    : updateAiVerseOsProduct(selection.root);
  return {
    mode: selection.mode,
    selected_by: selection.selectedBy,
    root: selection.root,
    status: result.status,
    migration_performed: false,
    result
  };
}
