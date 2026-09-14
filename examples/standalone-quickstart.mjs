import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "src", "cli.js");
const rootFlagIndex = process.argv.indexOf("--root");
const explicitRoot = rootFlagIndex >= 0 ? process.argv[rootFlagIndex + 1] : null;
const root = explicitRoot || mkdtempSync(join(tmpdir(), "ai-verse-bots-example-"));
const cleanup = !explicitRoot;

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Command failed: ${args.join(" ")}`);
  }
  return JSON.parse(result.stdout);
}

try {
  const setup = run(["setup", "--mode", "standalone", "--root", root, "--port", "0"]);
  const db = join(root, ".ai-verse-bots", "runtime", "coordination.db");
  const team = run([
    "template", "apply",
    "--id", "research-team",
    "--workspace", "example-workspace",
    "--runtime", "deterministic",
    "--db", db
  ]);
  const doctor = run(["standalone", "doctor", "--root", root]);

  console.log(JSON.stringify({
    example: "standalone-quickstart",
    root,
    setup_status: setup.setup.status,
    ready: doctor.ready,
    template_id: team.application.template_id,
    created_ids: team.application.created_ids,
    object_ids: team.application.objects.map((item) => item.id),
    cleanup_after_example: cleanup
  }, null, 2));
} finally {
  if (cleanup) rmSync(root, { recursive: true, force: true });
}
