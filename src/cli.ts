#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";
import {
  AiVerseOsRegistrationError,
  detectAiVerseOsCompatibility,
  findAiVerseOsRoot,
  planAiVerseOsRegistration,
  planAiVerseOsUninstall,
  planAiVerseOsUpgrade,
  registerAiVerseOsExtension,
  uninstallAiVerseOsExtension,
  upgradeAiVerseOsExtension
} from "./ai-verse-os-registration.js";
import {
  AiVerseOsInstallError,
  installAiVerseOsExtension,
  planAiVerseOsInstall
} from "./ai-verse-os-install.js";
import { CoordinationGateway } from "./gateway.js";
import { CoordinationStore } from "./store.js";
import {
  doctorProduction,
  statusProduction
} from "./production-health.js";
import {
  MultipleBotsSetupError,
  setupModeHelp,
  setupMultipleBots
} from "./setup.js";
import { createGatewayServer } from "./server.js";
import {
  StandaloneInstallError,
  findStandaloneRoot,
  initializeStandalone,
  standaloneGatewayOptions
} from "./standalone-install.js";
import {
  StarterTemplateError,
  applyStarterTemplate,
  getStarterTemplate,
  listStarterTemplates,
  planStarterTemplate
} from "./template-catalog.js";
import type { BotManifest } from "./types.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  console.error(`AI-Verse Multiple Bots CLI\n\nCommands:\n  status [--mode standalone|os] [--root PATH] [--db PATH]\n  doctor [--mode standalone|os] [--root PATH] [--db PATH]\n  setup [--mode standalone|os] [--root PATH] [--host HOST] [--port N]\n  setup modes\n  template list\n  template show --id ID\n  template plan --id ID --workspace ID --runtime ADAPTER [--prefix PREFIX] [--db PATH]\n  template apply --id ID --workspace ID --runtime ADAPTER [--prefix PREFIX] [--db PATH]\n  standalone init [--root PATH] [--host HOST] [--port N]\n  standalone doctor [--root PATH]\n  standalone serve [--root PATH]\n  init [--db PATH]\n  doctor [--db PATH]\n  bot create --id ID --name NAME --workspace ID --role TITLE --mission TEXT --runtime ADAPTER [--db PATH]\n  bot list [--workspace ID] [--db PATH]\n  events [--after N] [--limit N] [--db PATH]\n  serve [--host HOST] [--port N] [--db PATH] [--os-root PATH]\n  os doctor [--root PATH]\n  os detect [--root PATH]\n  os install-plan [--root PATH]\n  os install [--root PATH]\n  os plan [--root PATH]\n  os register [--root PATH]\n  os upgrade-plan [--root PATH]\n  os upgrade [--root PATH]\n  os uninstall-plan [--root PATH]\n  os uninstall [--root PATH]\n`);
  process.exit(2);
  throw new Error("unreachable");
}

function requestedOsRoot(): string {
  const explicit = flag("root");
  if (explicit) return resolve(explicit);
  return findAiVerseOsRoot(process.cwd()) ?? resolve(process.cwd());
}

function reportOsError(error: unknown): void {
  const registrationError = error instanceof AiVerseOsRegistrationError ? error : null;
  const installError = error instanceof AiVerseOsInstallError ? error : null;
  console.error(JSON.stringify({
    ok: false,
    code: installError?.code ?? registrationError?.code ?? "AI_VERSE_OS_REGISTRATION_ERROR",
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
}

function requestedStandaloneRoot(requireExisting: boolean): string {
  const explicit = flag("root");
  if (explicit) return resolve(explicit);
  const discovered = findStandaloneRoot(process.cwd());
  if (discovered) return discovered;
  if (!requireExisting) return resolve(process.cwd());
  throw new StandaloneInstallError(
    "STANDALONE_INSTALL_NOT_FOUND",
    "No .ai-verse-bots/config.json was found in the current directory or its ancestors; pass --root PATH"
  );
}

function reportStandaloneError(error: unknown): void {
  const standaloneError = error instanceof StandaloneInstallError ? error : null;
  console.error(JSON.stringify({
    ok: false,
    mode: "standalone",
    code: standaloneError?.code ?? "STANDALONE_INSTALL_ERROR",
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
}

function reportSetupError(error: unknown): void {
  const setupError = error instanceof MultipleBotsSetupError ? error : null;
  const standaloneError = error instanceof StandaloneInstallError ? error : null;
  const osInstallError = error instanceof AiVerseOsInstallError ? error : null;
  const osRegistrationError = error instanceof AiVerseOsRegistrationError ? error : null;
  console.error(JSON.stringify({
    ok: false,
    code: setupError?.code
      ?? standaloneError?.code
      ?? osInstallError?.code
      ?? osRegistrationError?.code
      ?? "SETUP_ERROR",
    error: error instanceof Error ? error.message : String(error),
    setup_help: setupModeHelp()
  }, null, 2));
  process.exitCode = 1;
}

function reportTemplateError(error: unknown): void {
  const templateError = error instanceof StarterTemplateError ? error : null;
  console.error(JSON.stringify({
    ok: false,
    code: templateError?.code ?? "TEMPLATE_ERROR",
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
}

const args = process.argv.slice(2);
const dbPath = flag("db") ?? "runtime/ai-verse-bots/coordination.db";
if (args[0] === "status" || args[0] === "doctor") {
  try {
    const explicitMode = flag("mode");
    const explicitRoot = flag("root");
    const explicitDb = flag("db");
    if (args[0] === "doctor" && explicitDb !== undefined && explicitMode === undefined && explicitRoot === undefined) {
      // Backward-compatible expert raw-database doctor. The public product doctor
      // is selected by omitting --db or by supplying an installation mode/root.
      const legacyStore = new CoordinationStore(resolve(explicitDb));
      try {
        console.log(JSON.stringify(legacyStore.doctor(), null, 2));
      } finally {
        legacyStore.close();
      }
    } else {
      const options = {
        ...(explicitMode !== undefined ? { mode: explicitMode } : {}),
        ...(explicitRoot !== undefined ? { root: explicitRoot } : {}),
        ...(explicitDb !== undefined ? { dbPath: explicitDb } : {}),
        cwd: process.cwd()
      };
      if (args[0] === "status") {
        const result = statusProduction(options);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ready) process.exitCode = 1;
      } else {
        const result = doctorProduction(options);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ready) process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: "HEALTH_CHECK_ERROR",
      error: error instanceof Error ? error.message : String(error)
    }, null, 2));
    process.exitCode = 1;
  }
} else if (args[0] === "template") {
  try {
    if (args[1] === "list") {
      console.log(JSON.stringify({ ok: true, templates: listStarterTemplates() }, null, 2));
    } else if (args[1] === "show") {
      const id = flag("id");
      if (!id) usage();
      console.log(JSON.stringify({ ok: true, template: getStarterTemplate(id) }, null, 2));
    } else if (args[1] === "plan" || args[1] === "apply") {
      const id = flag("id");
      const workspace = flag("workspace");
      if (!id || !workspace) usage();
      const templateStore = new CoordinationStore(resolve(dbPath));
      try {
        const options = {
          templateId: id,
          workspaceId: workspace,
          ...(flag("prefix") !== undefined ? { prefix: flag("prefix") } : {}),
          ...(flag("runtime") !== undefined ? { runtimeAdapter: flag("runtime") } : {})
        };
        const result = args[1] === "plan"
          ? planStarterTemplate(templateStore, options)
          : applyStarterTemplate(templateStore, options);
        console.log(JSON.stringify({
          ok: args[1] === "plan" ? result.can_apply : true,
          [args[1] === "plan" ? "plan" : "application"]: result
        }, null, 2));
        if (args[1] === "plan" && !result.can_apply) process.exitCode = 1;
      } finally {
        templateStore.close();
      }
    } else {
      usage();
    }
  } catch (error) {
    reportTemplateError(error);
  }
} else if (args[0] === "setup") {
  try {
    if (args[1] === "modes") {
      console.log(JSON.stringify({ ok: true, setup_help: setupModeHelp() }, null, 2));
    } else {
      const portFlag = flag("port");
      const result = setupMultipleBots({
        ...(flag("mode") !== undefined ? { mode: flag("mode") } : {}),
        ...(flag("root") !== undefined ? { root: flag("root") } : {}),
        ...(flag("host") !== undefined ? { host: flag("host") } : {}),
        ...(portFlag !== undefined ? { port: Number(portFlag) } : {}),
        cwd: process.cwd()
      });
      console.log(JSON.stringify({ ok: result.ready, setup: result }, null, 2));
      if (!result.ready) process.exitCode = 1;
    }
  } catch (error) {
    reportSetupError(error);
  }
} else if (args[0] === "standalone") {
  try {
    if (args[1] === "init") {
      const root = requestedStandaloneRoot(false);
      const host = flag("host");
      const portFlag = flag("port");
      const result = initializeStandalone(root, {
        ...(host !== undefined ? { host } : {}),
        ...(portFlag !== undefined ? { port: Number(portFlag) } : {})
      });
      console.log(JSON.stringify({ ok: true, mode: "standalone", installation: result }, null, 2));
    } else if (args[1] === "doctor") {
      const root = requestedStandaloneRoot(true);
      const result = doctorProduction({
        mode: "standalone",
        root,
        cwd: process.cwd()
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ready) process.exitCode = 1;
    } else if (args[1] === "serve") {
      const root = requestedStandaloneRoot(true);
      const options = standaloneGatewayOptions(root);
      const service = createGatewayServer({
        host: options.host,
        port: options.port,
        dbPath: options.dbPath,
        standaloneRoot: options.root
      });
      const address = await service.listen();
      console.log(JSON.stringify({
        ok: true,
        mode: "standalone",
        root: options.root,
        home: options.home,
        gateway: `http://${address.host}:${address.port}`,
        db: service.store.dbPath,
        ai_verse_os_root: null
      }, null, 2));
      process.on("SIGINT", async () => { await service.close(); process.exit(0); });
      process.on("SIGTERM", async () => { await service.close(); process.exit(0); });
    } else {
      usage();
    }
  } catch (error) {
    reportStandaloneError(error);
  }
} else if (args[0] === "serve") {
  const host = flag("host") ?? "127.0.0.1";
  const port = Number(flag("port") ?? "8787");
  const osRoot = flag("os-root");
  const service = createGatewayServer({
    host,
    port,
    dbPath: resolve(dbPath),
    ...(osRoot ? { aiVerseOsRoot: resolve(osRoot) } : {})
  });
  const address = await service.listen();
  console.log(JSON.stringify({
    ok: true,
    gateway: `http://${address.host}:${address.port}`,
    db: service.store.dbPath,
    ai_verse_os_root: osRoot ? resolve(osRoot) : null
  }, null, 2));
  process.on("SIGINT", async () => { await service.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await service.close(); process.exit(0); });
} else if (args[0] === "os") {
  const root = requestedOsRoot();
  try {
    if (args[1] === "doctor") {
      const result = doctorProduction({
        mode: "os",
        root,
        cwd: process.cwd()
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ready) process.exitCode = 1;
    } else if (args[1] === "detect") {
      const compatibility = detectAiVerseOsCompatibility(root);
      console.log(JSON.stringify({ ok: compatibility.status === "compatible", compatibility }, null, 2));
      if (compatibility.status !== "compatible") process.exitCode = 1;
    } else if (args[1] === "install-plan") {
      const plan = planAiVerseOsInstall(root);
      console.log(JSON.stringify({ ok: plan.can_install, install: plan }, null, 2));
      if (!plan.can_install) process.exitCode = 1;
    } else if (args[1] === "install") {
      console.log(JSON.stringify({ ok: true, install: installAiVerseOsExtension(root) }, null, 2));
    } else if (args[1] === "plan") {
      console.log(JSON.stringify({ ok: true, plan: planAiVerseOsRegistration(root) }, null, 2));
    } else if (args[1] === "register") {
      console.log(JSON.stringify({ ok: true, registration: registerAiVerseOsExtension(root) }, null, 2));
    } else if (args[1] === "upgrade-plan") {
      console.log(JSON.stringify({ ok: true, upgrade: planAiVerseOsUpgrade(root) }, null, 2));
    } else if (args[1] === "upgrade") {
      console.log(JSON.stringify({ ok: true, upgrade: upgradeAiVerseOsExtension(root) }, null, 2));
    } else if (args[1] === "uninstall-plan") {
      console.log(JSON.stringify({ ok: true, uninstall: planAiVerseOsUninstall(root) }, null, 2));
    } else if (args[1] === "uninstall") {
      console.log(JSON.stringify({ ok: true, uninstall: uninstallAiVerseOsExtension(root) }, null, 2));
    } else {
      usage();
    }
  } catch (error) {
    reportOsError(error);
  }
} else {
  const store = new CoordinationStore(resolve(dbPath));
  const gateway = new CoordinationGateway(store);

  try {
    const command = args[0];
    if (command === "init") {
      console.log(JSON.stringify({ ok: true, db: store.dbPath, schemaVersion: store.schemaVersion() }, null, 2));
    } else if (command === "doctor") {
      console.log(JSON.stringify(store.doctor(), null, 2));
    } else if (command === "bot" && args[1] === "create") {
      const id = flag("id");
      const name = flag("name");
      const workspace = flag("workspace");
      const role = flag("role");
      const mission = flag("mission");
      const runtimeAdapter = flag("runtime");
      if (!id || !name || !workspace || !role || !mission || !runtimeAdapter) usage();
      const manifest: BotManifest = {
        schema_version: "1.0",
        id,
        name,
        kind: "durable",
        status: "active",
        role: { title: role, mission },
        runtime: { adapter: runtimeAdapter },
        execution: { environment_policy: "shared_workspace", environment_ref: "host-default" },
        scope: { type: "workspace", workspace_id: workspace },
        capabilities: { role_refs: [], skill_refs: [], operator_refs: [], tool_refs: [] },
        permissions: {
          policy_ref: "default-bot",
          allowed_peers: ["*"],
          can_create_workers: true,
          can_create_bots: false,
          can_handoff: true
        },
        memory: { adapter: "host", view_policy: "role_scoped", write_policy: "candidate_only" },
        coordination: { manager_id: null, default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
      };
      console.log(JSON.stringify(gateway.createBot(manifest), null, 2));
    } else if (command === "bot" && args[1] === "list") {
      console.log(JSON.stringify(gateway.listBots(flag("workspace")), null, 2));
    } else if (command === "events") {
      const after = Number(flag("after") ?? 0);
      const limit = Number(flag("limit") ?? 100);
      console.log(JSON.stringify(store.listEventsAfter(after, limit), null, 2));
    } else {
      usage();
    }
  } finally {
    store.close();
  }
}
