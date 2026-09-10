#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";
import {
  AiVerseOsRegistrationError,
  detectAiVerseOsCompatibility,
  findAiVerseOsRoot,
  planAiVerseOsRegistration,
  registerAiVerseOsExtension
} from "./ai-verse-os-registration.js";
import { CoordinationGateway } from "./gateway.js";
import { CoordinationStore } from "./store.js";
import { createGatewayServer } from "./server.js";
import type { BotManifest } from "./types.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  console.error(`AI-Verse Multiple Bots CLI\n\nCommands:\n  init [--db PATH]\n  doctor [--db PATH]\n  bot create --id ID --name NAME --workspace ID --role TITLE --mission TEXT [--db PATH]\n  bot list [--workspace ID] [--db PATH]\n  events [--after N] [--limit N] [--db PATH]\n  serve [--host HOST] [--port N] [--db PATH]\n  os detect [--root PATH]\n  os plan [--root PATH]\n  os register [--root PATH]\n`);
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
  console.error(JSON.stringify({
    ok: false,
    code: registrationError?.code ?? "AI_VERSE_OS_REGISTRATION_ERROR",
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
}

const args = process.argv.slice(2);
const dbPath = flag("db") ?? "runtime/ai-verse-bots/coordination.db";
if (args[0] === "serve") {
  const host = flag("host") ?? "127.0.0.1";
  const port = Number(flag("port") ?? "8787");
  const service = createGatewayServer({ host, port, dbPath: resolve(dbPath) });
  const address = await service.listen();
  console.log(JSON.stringify({ ok: true, gateway: `http://${address.host}:${address.port}`, db: service.store.dbPath }, null, 2));
  process.on("SIGINT", async () => { await service.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await service.close(); process.exit(0); });
} else if (args[0] === "os") {
  const root = requestedOsRoot();
  try {
    if (args[1] === "detect") {
      const compatibility = detectAiVerseOsCompatibility(root);
      console.log(JSON.stringify({ ok: compatibility.status === "compatible", compatibility }, null, 2));
      if (compatibility.status === "incompatible") process.exitCode = 1;
    } else if (args[1] === "plan") {
      console.log(JSON.stringify({ ok: true, plan: planAiVerseOsRegistration(root) }, null, 2));
    } else if (args[1] === "register") {
      console.log(JSON.stringify({ ok: true, registration: registerAiVerseOsExtension(root) }, null, 2));
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
      if (!id || !name || !workspace || !role || !mission) usage();
      const manifest: BotManifest = {
        schema_version: "1.0",
        id,
        name,
        kind: "durable",
        status: "active",
        role: { title: role, mission },
        runtime: { adapter: "native" },
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
