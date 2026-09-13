# Production Health and Doctor

**Status:** Phase 5.6 complete

**Updated:** 2026-09-13

## Purpose

Phase 5.6 replaces shallow "database opened" readiness claims with one truthful, read-only component health model.

Public surfaces:

```bash
ai-verse-multiple-bots status
ai-verse-multiple-bots doctor
```

Mode-specific aliases remain available:

```bash
ai-verse-multiple-bots standalone doctor --root /path/to/project
ai-verse-multiple-bots os doctor --root /path/to/AI-Verse-OS
```

A running Gateway also exposes:

```text
GET /v1/health/readiness
```

Legacy `GET /health` remains the narrow coordination-store health surface for backward compatibility.

## Readiness states

Production status reports one of:

```text
setup-required
migration-required
update-required
disabled
unhealthy
ready
```

Meanings:

- `setup-required`: the selected installation is absent or incomplete.
- `migration-required`: canonical coordination state is on an unsupported schema transition and ordinary software update must not cross it.
- `update-required`: setup/state is compatible, but package-owned installation metadata/payload is older than the current package.
- `disabled`: the AI-Verse OS extension is installed/current but explicitly disabled.
- `unhealthy`: setup exists, but one or more required component checks fail.
- `ready`: every required check performed by Multiple Bots passes. Warnings may remain for dependencies that were intentionally not contacted.

A component-level `ready` result is not a claim that the entire AI-Verse system is ready.

## Verification depth

The deep doctor reports exactly which depths it checked:

1. **structural**
2. **attachment**
3. **runtime**
4. **dependency**
5. **operational**
6. **system/composed**

Multiple Bots directly checks the first five when an installation is available.

In AI-Verse OS mode, `system/composed` is explicitly reported as `delegated` to AI-Verse OS/distribution. Multiple Bots does not manufacture a whole-system readiness claim.

In standalone mode, system/composed readiness is not applicable.

## Structural checks

Current structural checks include:

- Node.js satisfies the package runtime floor `>=22.5.0`;
- required installed package assets are present as regular files;
- coordination database exists as a regular file;
- SQLite `PRAGMA quick_check` returns `ok`;
- coordination schema version is `1`;
- required core tables are present.

The production doctor opens the coordination database in SQLite read-only mode.

It does not initialize a missing database, run migrations, or create the execution queue.

A fresh valid standalone installation can therefore remain byte/schema-state equivalent after doctor.

## Attachment checks

### Standalone

Doctor verifies the existing Phase 5.2 installation contract:

- real standalone root/home;
- safe config path;
- schema-`1.0` config;
- internally contained coordination DB path.

### AI-Verse OS

Doctor reuses the Phase 5.3 read-only install plan and checks:

- compatible host;
- extension-owned files are current;
- package-owned registration is present;
- registration is supported/installed;
- coordination database exists;
- explicit enabled/disabled state.

Doctor never silently enables a disabled registration.

Phase 5.7 adds read-only version/migration assessment to attachment verification. An older compatible installation is reported as `update-required`; an unsupported coordination schema is reported as `migration-required`. Doctor does not run either operation.

## Runtime checks

Only runtimes actually assigned to **active durable Bots** are required.

Unused optional adapters do not make the component unhealthy.

For every active Bot, doctor verifies that its declared adapter is executable by the stock Gateway runtime registry.

Current stock registrations:

- `deterministic`
- `openai-compatible`
- `a2a`
- `hermes`
- `openclaw`
- `codex`
- `claude-code`
- `external-managed`

### Important native-runtime finding

The protocol/older examples used:

```json
{ "adapter": "native" }
```

But the current stock Gateway does **not** register an execution adapter named `native`.

Phase 5.6 therefore does two things:

1. existing active Bots declaring `native` are reported **unhealthy**;
2. public starter-template and direct `bot create` flows no longer silently default to `native`. They require an explicit runtime selection.

This does not invent a replacement native runtime and does not hide legacy state.

## Dependency checks

Dependency checks are adapter-aware.

### Local process runtimes

For Hermes, OpenClaw, Codex and Claude Code, doctor checks the configured/default local executable and applicable local paths.

Examples:

- Hermes Python executable plus optional Hermes root;
- `openclaw`;
- `codex`;
- `claude`;
- configured working directory.

### OpenAI-compatible

Doctor verifies:

- valid HTTP(S) endpoint;
- model configured;
- optional credential environment handle resolves.

It does **not** send a model request during ordinary doctor. A structurally complete configuration therefore produces an explicit warning that live reachability was not probed.

### A2A

Doctor validates the Agent Card HTTP(S) URL.

A simple endpoint configuration receives an explicit warning because doctor does not contact the peer.

Pinned remote-machine/auth configurations currently require injected host providers. The stock CLI doctor reports those dependencies as unavailable rather than pretending they are configured.

### External managed

External-managed persistent Bots require a host-injected provider registry.

The stock CLI serve path cannot prove that injection, so such an active Bot is non-ready under the stock doctor.

## Operational checks

Doctor inspects current coordination execution state for:

- unresolved dead letters;
- stale claimed/running execution leases;
- executable queue entries whose target principal is missing or non-executable;
- executable Tasks missing an executable queue record;
- executable Tasks whose queue state contradicts the Task state.

Any unresolved operational failure makes the component `unhealthy`.

The execution queue table itself is lazily materialized by Gateway runtime startup. Its absence on a never-started fresh installation is a warning, not a false failure.

## Warnings vs failures

A **failure** means Multiple Bots has evidence that required current behavior cannot run correctly.

A **warning** means the checked local contract is valid but doctor intentionally did not prove a stronger fact.

Examples of warnings:

- configured model endpoint was not contacted;
- configured A2A peer was not contacted;
- fresh installation has not materialized the runtime execution queue yet;
- OS extension is explicitly disabled.

Warnings do not turn an otherwise valid installation into `unhealthy`.

An explicitly disabled OS registration is still not `ready`.

## Read-only guarantee

Public production doctor is observational.

It does not:

- install;
- run setup;
- create Bots/Rooms/Team Runs;
- enable an extension;
- migrate schema;
- create execution queue state;
- retry dead letters;
- reconcile stale work;
- contact model/A2A endpoints;
- grant tools/connections/approvals;
- mutate AI-Verse OS canonical truth.

Recovery and repair remain explicit lifecycle operations.

## Status

`status` is the concise automation-friendly projection of the same production doctor model.

It reports:

- mode;
- root;
- database;
- lifecycle/readiness state;
- ready boolean;
- failed check count;
- warning count;
- resolved doctor command.

## Backward compatibility

The explicit expert form:

```bash
ai-verse-multiple-bots doctor --db /path/to/coordination.db
```

retains the older raw coordination-store doctor behavior.

The public production doctor is selected by:

- omitting `--db`; or
- specifying an installation `--mode` / `--root`.

This preserves existing raw-database automation while making the normal product path truthful.

## Gateway readiness

A mode-aware running Gateway exposes:

```text
GET /v1/health/readiness
```

Response behavior:

- HTTP 200 when component state is `ready`;
- HTTP 503 for setup-required, migration-required, update-required, disabled or unhealthy state.

The endpoint returns the same structured production report used by the CLI.

## Phase boundary

Phase 5.6 does not implement:

- automated repair;
- update/migration execution (doctor only reports the Phase 5.7 lifecycle state);
- standardized public enable/disable lifecycle;
- Dashboard/channel UI.

Secure remote Gateway exposure is implemented separately by Phase 5.8. `remote plan` uses this doctor as one of its read-only preflight inputs and then additionally verifies bearer-auth configuration plus the Tailscale transport.

Update/migration strategy is implemented by Phase 5.7. Phase 5.8 secure remote preflight composes this production doctor read-only and refuses remote startup unless component state is `ready`.
