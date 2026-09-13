# Setup and Onboarding Contract

**Status:** Phase 5.4 complete

**Updated:** 2026-09-13

## Purpose

Phase 5.4 adds the standard AI-Verse public setup vocabulary on top of the completed package, standalone and AI-Verse OS installation modes.

The public command is:

```bash
ai-verse-multiple-bots setup
```

Setup selects or detects one of two modes:

- `standalone`
- `ai-verse-os`

It then initializes/attaches the already-installed package through the owner-defined safe path and performs structural + attachment verification.

Setup does not create a starter Bot or Team. Reusable Bot/team templates belong to Phase 5.5.

## Fresh setup

### Standalone

From the folder that should own the standalone installation:

```bash
ai-verse-multiple-bots setup --mode standalone
```

Optional initial local bind settings:

```bash
ai-verse-multiple-bots setup --mode standalone --host 127.0.0.1 --port 8787
```

Or target another root explicitly:

```bash
ai-verse-multiple-bots setup --mode standalone --root /path/to/project
```

Standalone setup uses the Phase 5.2 contract and creates only:

```text
.ai-verse-bots/
├── config.json
└── runtime/
    └── coordination.db
```

### AI-Verse OS

For an existing compatible AI-Verse OS v2 host:

```bash
ai-verse-multiple-bots setup --mode os --root /path/to/AI-Verse-OS
```

OS setup uses the Phase 5.3 installer. It materializes only Multiple Bots-owned local extension/runtime state and attaches through the OS-owned local extension registry.

It does not modify canonical OS/operator/workspace truth.

## Mode discovery

List the two supported choices:

```bash
ai-verse-multiple-bots setup modes
```

On the first setup in an empty location, mode selection is explicit. Multiple Bots does not silently guess standalone mode.

On a rerun, `setup` may omit `--mode` when exactly one existing mode is discoverable from the current directory or its ancestors:

```bash
ai-verse-multiple-bots setup
```

If both standalone and AI-Verse OS installations are discoverable, setup fails with `SETUP_MODE_AMBIGUOUS` and requires an explicit mode.

## Setup result

Successful setup returns structured JSON containing:

- selected mode;
- whether the mode was explicit or detected;
- canonical root;
- `ready` / `disabled` status;
- whether setup changed anything;
- structural/attachment verification;
- resolved paths;
- mode-specific next steps;
- explicit capabilities that setup does not grant.

The current verification depth is intentionally:

```text
structural
attachment
```

Production runtime/dependency/operational/composed health belongs to Phase 5.6.

## Idempotence

Re-running setup on an already-current healthy installation is non-destructive.

Standalone:

- existing compatible config is not rewritten;
- existing coordination DB is reused;
- result reports no setup change.

AI-Verse OS:

- current extension files are reused;
- current coordination DB is reused;
- byte-equivalent registration is not rewritten;
- existing registered adapter paths are preserved;
- an operator-disabled registration remains disabled.

Setup never silently re-enables a disabled AI-Verse OS registration.

## Onboarding guidance

Setup returns three next-step categories:

1. **verify** - recheck the selected installation without hidden mutation;
2. **start** - start the local Coordination Gateway using the selected mode;
3. **create-bot** - point to the existing explicit Bot creation surface.

The Bot step deliberately requires the operator to choose a real Bot ID, name, workspace, role and mission.

Phase 5.5 adds reusable starter Bot/team templates. Phase 5.4 does not guess roles, create generic teammates, or insert durable Bot identities automatically.

## What setup does not grant

Setup does not grant:

- AI-Verse OS workspace access;
- connection permission;
- external action approval;
- Brain authority;
- remote/public-network exposure.

Registration/install/setup state is not equivalent to authorization.

## Disabled AI-Verse OS state

If Multiple Bots is already registered but explicitly disabled, setup preserves that state and reports:

```json
{
  "status": "disabled",
  "ready": false
}
```

The CLI exits non-zero because the component is not ready for use.

A standardized public enable/disable lifecycle is a later Phase 5 lifecycle slice. Setup does not bypass it.

## Phase boundary

Phase 5.4 does not implement:

- reusable Bot/team templates;
- production doctor/readiness depth;
- standardized enable/disable/update lifecycle;
- secure remote Gateway exposure;
- Dashboard or channel clients.

Those remain later Phase 5 slices.
