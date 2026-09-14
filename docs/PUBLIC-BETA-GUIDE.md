# AI-Verse Multiple Bots Public-Beta Guide

**Release stage:** public-beta candidate

**Package:** `@ai-verse/multiple-bots`

**Command:** `ai-verse-multiple-bots`

## What this component is

AI-Verse Multiple Bots is the persistent-teammate and coordination layer.

It canonically owns:

- durable Bot coordination identity;
- Rooms and Threads;
- Messages and delivery state;
- Tasks and Handoffs;
- Team Runs and temporary Workers;
- package Approvals;
- coordination Artifacts and Events;
- execution queue/recovery state;
- coordination budgets and runtime settlement evidence.

It does not replace AI-Verse OS, Brain, Memory, Skills, Data, Connections, Automations, Dashboard or Token.

## Requirements

- Node.js 22.5 or newer
- a packed or published `@ai-verse/multiple-bots` package
- one selected installation mode:
  - standalone
  - AI-Verse OS

npm installation itself performs no host mutation.

## Install

From a packed artifact:

```bash
npm install -g ./ai-verse-multiple-bots-0.1.0-alpha.1.tgz
```

After npm publication, the intended equivalent is:

```bash
npm install -g @ai-verse/multiple-bots
```

## First setup

### Standalone

```bash
mkdir my-ai-team
cd my-ai-team
ai-verse-multiple-bots setup --mode standalone
ai-verse-multiple-bots doctor
```

Start the local Gateway:

```bash
ai-verse-multiple-bots standalone serve
```

Standalone state is confined to `.ai-verse-bots/`.

### AI-Verse OS

```bash
ai-verse-multiple-bots setup --mode os --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os doctor --root /path/to/AI-Verse-OS
```

The setup path materializes only Multiple Bots-owned extension/runtime files and the local extension registration. It does not rewrite canonical OS/operator/workspace state.

## Create a starter Bot or durable team

List templates:

```bash
ai-verse-multiple-bots template list
```

Inspect:

```bash
ai-verse-multiple-bots template show --id research-team
```

Plan:

```bash
ai-verse-multiple-bots template plan \
  --id research-team \
  --workspace my-workspace \
  --runtime deterministic \
  --db /path/to/coordination.db
```

Apply:

```bash
ai-verse-multiple-bots template apply \
  --id research-team \
  --workspace my-workspace \
  --runtime deterministic \
  --db /path/to/coordination.db
```

Starter teams create durable Bots and a bounded Room. They do not automatically create a Team Run or temporary Workers.

The deterministic runtime is appropriate for examples and verification. Production installations should select a real supported runtime and use `doctor` to verify its dependencies.

## Core operator surfaces

### Production health

```text
GET /v1/health/readiness
GET /v1/health/4cs?workspace=<workspace>
```

### Dashboard projection

```text
GET /v1/dashboard/capabilities?workspace=<workspace>
GET /v1/dashboard/snapshot?workspace=<workspace>
GET /v1/dashboard/events?workspace=<workspace>&after=<cursor>
GET /v1/dashboard/events/stream?workspace=<workspace>&after=<cursor>
POST /v1/dashboard/control
```

Dashboard does not own coordination truth.

### Operator attention and Approvals

```text
GET /v1/operator/capabilities?workspace=<workspace>
GET /v1/operator/attention?workspace=<workspace>&after=<cursor>
GET /v1/operator/approvals?workspace=<workspace>&status=pending
POST /v1/operator/approvals/:id/decision
```

Attention priority is:

```text
needs_approval
needs_input
blocked
failed
handoff_waiting
unread_result
```

Approval decisions require an explicit `operator_*` actor and exact workspace match.

### Observability

```text
GET /v1/observability/capabilities?workspace=<workspace>
GET /v1/observability/snapshot?workspace=<workspace>&after=<cursor>&limit=<n>
GET /v1/observability/usage?workspace=<workspace>
GET /v1/observability/timeline?workspace=<workspace>&after=<cursor>&limit=<n>
```

Multiple Bots observability is operational and projection-only.

It may expose Task/Worker/Team Run execution-local token/action counters and `runtime_reported_cost_evidence` because coordination budgets need them.

It does not own canonical telemetry or pricing.

The ownership rule is:

```text
AI-Verse Multiple Bots
  -> execution-local usage for coordination, limits, budgets and runtime settlement

AI-Verse Token
  -> immutable normalized telemetry
  -> historical/global usage accounting
  -> pricing evidence
  -> ACTUAL / CALCULATED / UNKNOWN cost truth
```

When canonical historical/global telemetry or cost truth is needed, consume the supported Token read interface:

```text
@ai-verse/token/gateway
```

## Channels

Channel bridges support verified Telegram, Discord and generic adapter ingress.

```text
GET  /v1/channels/capabilities
POST /v1/channels/ingress
POST /v1/channels/telegram/ingress
POST /v1/channels/discord/ingress
POST /v1/channels/egress
POST /v1/channels/egress/receipt
```

The public provider webhook/socket terminates in an external adapter first.

That adapter owns:

- provider credentials;
- webhook/signature/socket verification;
- public network lifecycle;
- actual network delivery.

Multiple Bots owns canonical routing after verified admission.

## Secure remote access

Direct non-loopback HTTP binding is forbidden.

For tailnet-only HTTPS access:

```bash
export AI_VERSE_GATEWAY_TOKEN="$(openssl rand -hex 32)"

ai-verse-multiple-bots remote plan \
  --mode standalone \
  --root /path/to/project

ai-verse-multiple-bots remote serve \
  --mode standalone \
  --root /path/to/project
```

The managed provider is Tailscale Serve.

The origin Gateway remains on loopback and every route still requires the bearer secret.

Public Tailscale Funnel exposure is not enabled by this product path.

## Updates

Preview:

```bash
ai-verse-multiple-bots update-plan
```

Apply:

```bash
ai-verse-multiple-bots update
```

Software update and coordination-state migration are separate.

Unknown/unsupported schema transitions fail closed as `migration-required`.

Rollback of a composed AI-Verse release set remains Distribution-owned.

## AI-Verse OS uninstall

```bash
ai-verse-multiple-bots os uninstall-plan --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os uninstall --root /path/to/AI-Verse-OS
```

Uninstall removes Multiple Bots integration/runtime files according to its owner contract and preserves canonical coordination/host state as documented by the lifecycle contract.

## What setup never grants

Setup does not grant:

- workspace membership or broader OS authority;
- Connection credentials;
- external action permission;
- Brain direction ownership;
- reusable Skill trust;
- Memory write authority;
- Token telemetry authority;
- public network exposure.

Installation state is not authorization.

## Packaged runnable examples

```bash
node examples/standalone-quickstart.mjs
node examples/operator-observability.mjs
node examples/channel-bridge.mjs
```

See `examples/README.md`.

## Before reporting a bug

Run:

```bash
ai-verse-multiple-bots status
ai-verse-multiple-bots doctor
```

Then capture:

- installation mode;
- component version;
- readiness state;
- exact error code;
- relevant canonical event/task/run IDs;
- whether the issue reproduces with loopback access.

Do not include raw credentials or provider secrets.

See `docs/TROUBLESHOOTING.md`.


## Phase 5.13 release-document acceptance

The packaged member-facing documentation and examples passed GitHub Actions **CI run 603 (`34811761570`)** on implementation head `2a6d35d8b971bd46207e06d87db27acd90f974c4`:

- **497/497** repository tests
- **5/5** Phase 4 compatibility tests
- clean packed install
- all prior product smokes
- all three packaged examples executed from the clean installed tarball
- **234-file** package artifact
- **0 failures, 0 canceled, 0 skipped**

Phase 5.14 remains the final whole-release acceptance gate.
