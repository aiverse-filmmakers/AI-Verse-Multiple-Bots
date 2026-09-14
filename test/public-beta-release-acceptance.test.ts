import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function json(path: string): any {
  return JSON.parse(read(path));
}


test("Phase 5.14 release manifest is complete, component-scoped, and version-aligned", () => {
  const manifest = json("evals/public-beta-release-acceptance.json");
  const pkg = json("package.json");
  const extension = json("integrations/ai-verse-os/extension.json");
  const registration = read("src/ai-verse-os-registration.ts");

  assert.equal(manifest.schema_version, "1.0");
  assert.equal(manifest.component, "ai-verse-multiple-bots");
  assert.equal(manifest.package, "@ai-verse/multiple-bots");
  assert.equal(manifest.release_stage, "public-beta");
  assert.equal(manifest.candidate_version, "0.1.0-beta.1");
  assert.equal(pkg.version, manifest.candidate_version);
  assert.equal(extension.package_version, manifest.candidate_version);
  assert.equal(
    registration.includes(`AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION = "${manifest.candidate_version}"`),
    true
  );

  assert.equal(manifest.acceptance_scope.component_release_gate, "owned");
  assert.equal(manifest.acceptance_scope.composed_agent_profile_gate, "delegated");
  assert.match(manifest.acceptance_scope.composed_agent_profile_owner, /System/i);
  assert.match(manifest.acceptance_scope.composed_agent_profile_owner, /distribution/i);

  assert.equal(manifest.phase_5_slices.length, 14);
  assert.equal(new Set(manifest.phase_5_slices).size, 14);
  assert.equal(manifest.phase_5_slices[0], "5.1-install-package");
  assert.equal(manifest.phase_5_slices.at(-1), "5.14-full-release-acceptance");
});

test("Phase 5.14 ownership manifest preserves every sibling canonical owner", () => {
  const manifest = json("evals/public-beta-release-acceptance.json");
  const delegates = new Map(
    manifest.canonical_ownership.delegates.map((entry: any) => [entry.owner, entry.concern])
  );

  for (const owner of [
    "AI-Verse OS",
    "AI-Verse Brain",
    "AI-Verse Memory",
    "AI-Verse Skills",
    "AI-Verse Data",
    "AI-Verse Connections",
    "AI-Verse Automations",
    "AI-Verse Dashboard",
    "AI-Verse Token"
  ]) {
    assert.equal(delegates.has(owner), true, `Missing delegated canonical owner: ${owner}`);
  }

  const token = manifest.canonical_ownership.token_boundary;
  assert.equal(token.canonical_telemetry_owner, "ai-verse-token");
  assert.equal(token.canonical_cost_truth_owner, "ai-verse-token");
  assert.equal(token.projection_interface, "@ai-verse/token/gateway");
  assert.equal(token.multiple_bots_prices_model_usage, false);
  assert.equal(token.runtime_usage_is_canonical_token_truth, false);

  const observability = read("src/observability.ts");
  assert.match(observability, /CANONICAL_TELEMETRY_OWNER = "ai-verse-token"/);
  assert.match(observability, /CANONICAL_TOKEN_PROJECTION = "@ai-verse\/token\/gateway"/);
  assert.match(observability, /prices_model_usage_here: false/);
  assert.match(observability, /runtime_usage_is_canonical_token_truth: false/);
});

test("Phase 5.14 whole-message idempotency is an executable release law", () => {
  const manifest = json("evals/public-beta-release-acceptance.json");
  const laws = manifest.release_laws.join("\n");
  assert.match(laws, /whole logical message mutation is idempotent/i);
  assert.match(laws, /semantic drift under one idempotency key fails closed/i);

  const store = read("src/store.ts");
  const gateway = read("src/gateway.ts");
  const rooms = read("src/rooms.ts");

  assert.match(store, /commitMessageMutation/);
  assert.match(store, /BEGIN IMMEDIATE/);
  assert.match(store, /reused with different message semantics/);
  assert.match(gateway, /operation: "sendMessage"/);
  assert.match(gateway, /operation: "publishRoomMessage"/);
  assert.match(rooms, /published\.replayed/);
  assert.match(rooms, /corr_idem_/);

  assert.equal(
    manifest.required_evidence_tests.includes("test/message-idempotency.test.ts"),
    true
  );
});

test("Phase 5.14 release evidence inventory exists and does not rely on sibling source checkouts", () => {
  const manifest = json("evals/public-beta-release-acceptance.json");

  for (const path of manifest.required_evidence_tests) {
    assert.equal(existsSync(resolve(root, path)), true, `Missing release evidence test: ${path}`);
  }

  const packageVerifier = read("scripts/verify-package.mjs");
  for (const path of manifest.required_package_files) {
    assert.equal(packageVerifier.includes(path), true, `Package verifier does not require ${path}`);
  }

  const integrationSource = [
    "src/server.ts",
    "src/runtime.ts",
    "src/ai-verse-os-workspace-projection.ts",
    "src/brain-objective-ingress.ts",
    "src/ai-verse-memory-recall.ts",
    "src/ai-verse-skills-capability-resolution.ts",
    "src/automation-wake-ingress.ts",
    "src/os-write-command.ts",
    "src/observability.ts"
  ].map(read).join("\n");

  assert.equal(integrationSource.includes("../AI-Verse-Data"), false);
  assert.equal(integrationSource.includes("../AI-Verse-Token"), false);
  assert.equal(integrationSource.includes("../AI-Verse-Automations"), false);
  assert.equal(integrationSource.includes("../AI-Verse-Brain"), false);
  assert.equal(integrationSource.includes("../AI-Verse-Memory"), false);
  assert.equal(integrationSource.includes("../AI-Verse-Skills"), false);
});

test("Phase 5.14 release security and projection boundaries remain fail-closed", () => {
  const manifest = json("evals/public-beta-release-acceptance.json");
  const laws = manifest.release_laws.join("\n");
  const security = read("src/gateway-security.ts");
  const dashboard = read("src/dashboard-projection.ts");
  const attention = read("src/operator-attention.ts");
  const channels = read("src/channel-bridge.ts");
  const doctor = read("docs/PRODUCTION-HEALTH-DOCTOR.md");

  assert.match(laws, /direct non-loopback Gateway HTTP exposure is forbidden/i);
  assert.match(laws, /managed remote exposure requires bearer authentication/i);
  assert.match(laws, /channel ingress requires an already-verified external adapter/i);
  assert.match(security, /DIRECT_REMOTE_BIND_FORBIDDEN/);
  assert.match(security, /authorizeGatewayRequest|Bearer/);
  assert.match(dashboard, /dashboard_owns_truth/);
  assert.match(attention, /operator_ux_owns_truth/);
  assert.match(channels, /adapterVerified/);
  assert.match(doctor, /system\/composed.*delegated|delegated.*system\/composed/is);
});

test("Phase 5.14 package and CI expose one explicit release gate with no install-time mutation", () => {
  const manifest = json("evals/public-beta-release-acceptance.json");
  const pkg = json("package.json");
  const workflow = read(".github/workflows/ci.yml");

  assert.equal(pkg.scripts?.preinstall, undefined);
  assert.equal(pkg.scripts?.install, undefined);
  assert.equal(pkg.scripts?.postinstall, undefined);
  assert.equal(pkg.scripts?.["eval:release"], "npm run build && node --test dist/test/public-beta-release-acceptance.test.js");
  assert.equal(
    pkg.scripts?.["release:check"],
    "npm test && npm run eval:phase4 && npm run pack:check && npm run eval:release"
  );

  for (const step of manifest.ci_gate.required_steps) {
    assert.equal(workflow.includes(step), true, `CI is missing release step: ${step}`);
  }
  assert.equal(manifest.ci_gate.local_composite_command, "npm run release:check");
});

test("Phase 5.14 release claims stop at evidence actually owned by this repository", () => {
  const manifest = json("evals/public-beta-release-acceptance.json");
  const guide = read("docs/PUBLIC-BETA-GUIDE.md");
  const readme = read("README.md");

  for (const unclaimed of [
    "npm registry publication",
    "immutable Git release tag",
    "Agent profile composed acceptance",
    "Distribution Agent release-set promotion"
  ]) {
    assert.equal(manifest.release_operations_not_claimed.includes(unclaimed), true);
  }

  assert.match(readme, /does not claim.*published/is);
  assert.match(guide, /public-beta|beta/i);
  assert.match(
    manifest.acceptance_scope.statement,
    /does not claim the whole Agent profile|does not claim.*Distribution/i
  );
});
