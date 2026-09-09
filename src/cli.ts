#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";
import { CoordinationGateway } from "./gateway.js";
import { CoordinationStore } from "./store.js";
import { createGatewayServer } from "./server.js";
import type { BotManifest } from "./types.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  console.error(`AI-Verse Multiple Bots CLI\n\nCommands:\n  init [--db PATH]\n  doctor [--db PATH]\n  bot create --id ID --name NAME --workspace ID --role TITLE --mission TEXT [--db PATH]\n  bot list [--workspace ID] [--db PATH]\n  events [--after N] [--limit N] [--db PATH]\n  serve [--host HOST] [--port N] [--db PATH]\n`);
  process.exit(2);
  throw new Error("unreachable");
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
