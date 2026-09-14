import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function runExample(path: string): any {
  const result = spawnSync(process.execPath, [resolve(root, path)], {
    cwd: root,
    encoding: "utf8",
    shell: false
  });
  if (result.status !== 0) {
    throw new Error([
      `Example failed: ${path}`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  return JSON.parse(result.stdout);
}

test("Phase 5.13 ships the member-facing public-beta release documentation", () => {
  for (const path of [
    "docs/PUBLIC-BETA-GUIDE.md",
    "docs/API-QUICK-REFERENCE.md",
    "docs/TROUBLESHOOTING.md",
    "examples/README.md"
  ]) {
    assert.equal(existsSync(resolve(root, path)), true, `Missing release document ${path}`);
  }

  const guide = read("docs/PUBLIC-BETA-GUIDE.md");
  assert.match(guide, /setup --mode standalone/);
  assert.match(guide, /setup --mode os/);
  assert.match(guide, /template apply/);
  assert.match(guide, /\/v1\/operator\/attention/);
  assert.match(guide, /\/v1\/observability\/snapshot/);
  assert.match(guide, /\/v1\/channels\/telegram\/ingress/);
  assert.match(guide, /remote serve/);
  assert.match(guide, /@ai-verse\/token\/gateway/);
  assert.match(guide, /ACTUAL \/ CALCULATED \/ UNKNOWN/);

  const api = read("docs/API-QUICK-REFERENCE.md");
  assert.match(api, /runtime_reported_cost_evidence/);
  assert.match(api, /canonical_telemetry_owner: ai-verse-token/);
  assert.match(api, /direct non-loopback HTTP Gateway binds are rejected/);

  const troubleshooting = read("docs/TROUBLESHOOTING.md");
  for (const code of [
    "SETUP_MODE_AMBIGUOUS",
    "DIRECT_REMOTE_BIND_FORBIDDEN",
    "CHANNEL_ADAPTER_UNVERIFIED"
  ]) {
    assert.match(troubleshooting, new RegExp(code));
  }
  assert.match(troubleshooting, /Do not independently reprice runtime usage inside Multiple Bots/);
});

test("Phase 5.13 release examples are local-safe and preserve ownership boundaries", () => {
  const examples = [
    read("examples/standalone-quickstart.mjs"),
    read("examples/operator-observability.mjs"),
    read("examples/channel-bridge.mjs")
  ].join("\n");

  assert.doesNotMatch(examples, /0\.0\.0\.0/);
  assert.doesNotMatch(examples, /tailscale\s+funnel/i);
  assert.doesNotMatch(examples, /OPENAI_API_KEY|ANTHROPIC_API_KEY|API_KEY=/);
  assert.doesNotMatch(examples, /pricing_snapshot|tariff/i);
  assert.match(examples, /adapterVerified: true/);
});

test("Phase 5.13 standalone quickstart example executes end to end", () => {
  const output = runExample("examples/standalone-quickstart.mjs");
  assert.equal(output.example, "standalone-quickstart");
  assert.equal(output.setup_status, "ready");
  assert.equal(output.ready, true);
  assert.equal(output.template_id, "research-team");
  assert.equal(Array.isArray(output.created_ids), true);
  assert.equal(output.created_ids.length, 4);
  assert.equal(output.object_ids.length, 4);
  assert.equal(output.cleanup_after_example, true);
});

test("Phase 5.13 operator/observability example executes and proves Token ownership", () => {
  const output = runExample("examples/operator-observability.mjs");
  assert.equal(output.example, "operator-observability");
  assert.equal(output.attention_top, "needs_approval");
  assert.equal(output.decision, "approve");
  assert.equal(output.approval_status, "approved");
  assert.equal(output.observability_owns_truth, false);
  assert.equal(output.canonical_telemetry_owner, "ai-verse-token");
  assert.equal(output.canonical_cost_truth_owner, "ai-verse-token");
  assert.equal(output.token_projection_interface, "@ai-verse/token/gateway");
  assert.equal(output.runtime_usage_is_canonical_token_truth, false);
});

test("Phase 5.13 channel bridge example executes without performing provider network delivery", () => {
  const output = runExample("examples/channel-bridge.mjs");
  assert.equal(output.example, "channel-bridge");
  assert.equal(output.ingress_provider, "ai-verse-multiple-bots/channel-bridge-v1");
  assert.equal(output.target_id, "bot_channel");
  assert.equal(output.external_recipient_id, "7001");
  assert.equal(output.reply_to_external_message_id, "42");
  assert.equal(output.transport_method, "sendMessage");
  assert.equal(output.channel_owns_truth, false);
});
