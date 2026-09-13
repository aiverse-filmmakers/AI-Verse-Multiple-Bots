import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
  findAiVerseOsRoot
} from "./ai-verse-os-registration.js";
import {
  installAiVerseOsExtension,
  planAiVerseOsInstall
} from "./ai-verse-os-install.js";
import {
  STANDALONE_DEFAULT_HOST,
  STANDALONE_DEFAULT_PORT,
  doctorStandalone,
  findStandaloneRoot,
  initializeStandalone,
  standalonePaths
} from "./standalone-install.js";
import { CoordinationStore } from "./store.js";

export type SetupMode = "standalone" | "ai-verse-os";
export type SetupSelectionSource = "explicit" | "detected";

export interface MultipleBotsSetupOptions {
  mode?: string;
  root?: string;
  host?: string;
  port?: number;
  cwd?: string;
}

export interface SetupNextStep {
  id: "verify" | "start" | "create-bot";
  description: string;
  command: string;
}

export interface MultipleBotsSetupResult {
  mode: SetupMode;
  selected_by: SetupSelectionSource;
  root: string;
  status: "ready" | "disabled";
  ready: boolean;
  changed: boolean;
  verification_depth: Array<"structural" | "attachment">;
  setup: Record<string, unknown>;
  verification: Record<string, unknown>;
  next_steps: SetupNextStep[];
  setup_does_not_grant: string[];
}

export class MultipleBotsSetupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MultipleBotsSetupError";
  }
}

const DOES_NOT_GRANT = [
  "AI-Verse OS workspace access",
  "connection permission",
  "external action approval",
  "Brain authority",
  "remote/public-network exposure"
];

function shellQuote(value: string): string {
  return `"${value.replace(/["\\$\`]/g, "\\$&")}"`;
}

function normalizeMode(input: string | undefined): SetupMode | null {
  if (input === undefined) return null;
  const normalized = input.trim().toLowerCase();
  if (normalized === "standalone") return "standalone";
  if (normalized === "os" || normalized === "ai-verse-os" || normalized === "aiverse-os") return "ai-verse-os";
  throw new MultipleBotsSetupError(
    "INVALID_SETUP_MODE",
    `Unsupported setup mode '${input}'. Use --mode standalone or --mode os.`
  );
}

function discoveredSelection(start: string): { mode: SetupMode; root: string } | null {
  const osRoot = findAiVerseOsRoot(start);
  const standaloneRoot = findStandaloneRoot(start);

  if (osRoot && standaloneRoot) {
    throw new MultipleBotsSetupError(
      "SETUP_MODE_AMBIGUOUS",
      `Both AI-Verse OS and standalone installations are discoverable from ${resolve(start)}. Pass --mode standalone or --mode os explicitly.`
    );
  }
  if (osRoot) return { mode: "ai-verse-os", root: osRoot };
  if (standaloneRoot) return { mode: "standalone", root: standaloneRoot };
  return null;
}

function selectSetup(options: MultipleBotsSetupOptions): {
  mode: SetupMode;
  root: string;
  selectedBy: SetupSelectionSource;
} {
  const cwd = resolve(options.cwd ?? ".");
  const explicitMode = normalizeMode(options.mode);

  if (explicitMode) {
    if (explicitMode === "ai-verse-os" && (options.host !== undefined || options.port !== undefined)) {
      throw new MultipleBotsSetupError(
        "SETUP_OPTION_NOT_APPLICABLE",
        "--host and --port are standalone setup options; AI-Verse OS setup uses its existing local extension runtime defaults."
      );
    }

    if (options.root) {
      return { mode: explicitMode, root: resolve(options.root), selectedBy: "explicit" };
    }

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

  const detectionStart = options.root ? resolve(options.root) : cwd;
  const detected = discoveredSelection(detectionStart);
  if (!detected) {
    throw new MultipleBotsSetupError(
      "SETUP_MODE_REQUIRED",
      "No existing Multiple Bots or AI-Verse OS installation was detected. Choose a mode explicitly with --mode standalone or --mode os."
    );
  }
  return { mode: detected.mode, root: detected.root, selectedBy: "detected" };
}

function standaloneNextSteps(root: string, dbPath: string): SetupNextStep[] {
  return [
    {
      id: "verify",
      description: "Verify the standalone installation without changing it.",
      command: `ai-verse-multiple-bots standalone doctor --root ${shellQuote(root)}`
    },
    {
      id: "start",
      description: "Start the local Coordination Gateway.",
      command: `ai-verse-multiple-bots standalone serve --root ${shellQuote(root)}`
    },
    {
      id: "create-bot",
      description: "Create a durable Bot when you are ready to define its real role. Phase 5.5 adds reusable starter templates.",
      command: `ai-verse-multiple-bots bot create --id <bot-id> --name <name> --workspace <workspace-id> --role <role> --mission <mission> --db ${shellQuote(dbPath)}`
    }
  ];
}

function osNextSteps(root: string, dbPath: string): SetupNextStep[] {
  return [
    {
      id: "verify",
      description: "Re-run the read-only OS install plan to verify materialization/attachment remains conflict-free.",
      command: `ai-verse-multiple-bots os install-plan --root ${shellQuote(root)}`
    },
    {
      id: "start",
      description: "Start the Coordination Gateway attached to this AI-Verse OS host.",
      command: `ai-verse-multiple-bots serve --os-root ${shellQuote(root)} --db ${shellQuote(dbPath)}`
    },
    {
      id: "create-bot",
      description: "Create a durable Bot only after choosing its real AI-Verse workspace and role. Phase 5.5 adds reusable starter templates.",
      command: `ai-verse-multiple-bots bot create --id <bot-id> --name <name> --workspace <workspace-id> --role <role> --mission <mission> --db ${shellQuote(dbPath)}`
    }
  ];
}

function verifyOsSetup(root: string): {
  ok: boolean;
  enabled: boolean;
  database_ok: boolean;
  schema_version: string | null;
  registration_ok: boolean;
  files_current: boolean;
} {
  const plan = planAiVerseOsInstall(root);
  const entry = plan.current_registration;
  const registrationOk = Boolean(
    entry
    && entry.id === AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID
    && entry.supported === true
    && entry.installed === true
  );
  const enabled = Boolean(entry?.enabled === true);
  const filesCurrent = plan.files.every((item) => item.state === "current");
  let databaseOk = false;
  let schemaVersion: string | null = null;

  if (existsSync(plan.coordination_db_path)) {
    const store = new CoordinationStore(plan.coordination_db_path);
    try {
      const doctor = store.doctor();
      schemaVersion = store.schemaVersion();
      databaseOk = doctor.ok && schemaVersion === "1";
    } finally {
      store.close();
    }
  }

  return {
    ok: registrationOk && enabled && filesCurrent && databaseOk,
    enabled,
    database_ok: databaseOk,
    schema_version: schemaVersion,
    registration_ok: registrationOk,
    files_current: filesCurrent
  };
}

export function setupMultipleBots(options: MultipleBotsSetupOptions = {}): MultipleBotsSetupResult {
  const selection = selectSetup(options);

  if (selection.mode === "standalone") {
    const before = standalonePaths(selection.root);
    const existedBefore = existsSync(before.configPath) && existsSync(before.dbPath);
    const initialized = initializeStandalone(selection.root, {
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {})
    });
    const verification = doctorStandalone(selection.root);
    if (!verification.ok) {
      throw new MultipleBotsSetupError(
        "SETUP_VERIFICATION_FAILED",
        `Standalone setup completed but verification failed: ${verification.error ?? "unknown verification failure"}`
      );
    }

    return {
      mode: "standalone",
      selected_by: selection.selectedBy,
      root: initialized.root,
      status: "ready",
      ready: true,
      changed: !existedBefore || initialized.status !== "unchanged",
      verification_depth: ["structural", "attachment"],
      setup: {
        home: initialized.home,
        config: initialized.configPath,
        database: initialized.dbPath,
        gateway: {
          host: initialized.config.gateway.host,
          port: initialized.config.gateway.port
        },
        state: initialized.status
      },
      verification: {
        ok: verification.ok,
        schema_version: verification.schemaVersion,
        checks: verification.checks
      },
      next_steps: standaloneNextSteps(initialized.root, initialized.dbPath),
      setup_does_not_grant: [...DOES_NOT_GRANT]
    };
  }

  const installed = installAiVerseOsExtension(selection.root);
  const verification = verifyOsSetup(selection.root);
  const ready = verification.ok;
  return {
    mode: "ai-verse-os",
    selected_by: selection.selectedBy,
    root: installed.root,
    status: ready ? "ready" : "disabled",
    ready,
    changed: installed.status !== "unchanged",
    verification_depth: ["structural", "attachment"],
    setup: {
      extension_root: installed.extension_root,
      instructions: installed.instructions_path,
      engine: installed.engine_path,
      database: installed.coordination_db_path,
      registry: installed.registry_path,
      install_state: installed.status,
      registration_state: installed.registration_status
    },
    verification,
    next_steps: osNextSteps(installed.root, installed.coordination_db_path),
    setup_does_not_grant: [...DOES_NOT_GRANT]
  };
}

export function setupModeHelp(): {
  modes: Array<{ mode: SetupMode; description: string; command: string }>;
  detection: string;
} {
  return {
    modes: [
      {
        mode: "standalone",
        description: "Use Multiple Bots without AI-Verse OS. State stays under .ai-verse-bots/.",
        command: "ai-verse-multiple-bots setup --mode standalone"
      },
      {
        mode: "ai-verse-os",
        description: "Attach Multiple Bots to an existing compatible AI-Verse OS v2 host.",
        command: "ai-verse-multiple-bots setup --mode os --root /path/to/AI-Verse-OS"
      }
    ],
    detection: "When setup is rerun inside an existing standalone or AI-Verse OS installation, --mode may be omitted and the existing mode is detected."
  };
}
