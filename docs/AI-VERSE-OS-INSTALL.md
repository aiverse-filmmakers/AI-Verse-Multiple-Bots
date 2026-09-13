# AI-Verse OS Install Contract

**Status:** Phase 5.3 complete

**Updated:** 2026-09-13

## Purpose

Phase 5.3 turns the existing AI-Verse OS registration contract into a real package-owned installation flow.

The member-facing install path is:

```bash
ai-verse-multiple-bots os install --root /path/to/AI-Verse-OS
```

The read-only preview is:

```bash
ai-verse-multiple-bots os install-plan --root /path/to/AI-Verse-OS
```

The earlier `os plan` and `os register` commands remain lower-level registration operations. They do not materialize package files.

## Installation result

A successful OS install creates or verifies only Multiple Bots-owned local extension/runtime state:

```text
AI-Verse-OS/
├── .aiverse/
│   └── extensions/
│       ├── registry.json
│       └── ai-verse-multiple-bots/
│           ├── INSTRUCTIONS.md
│           └── engine.mjs
└── runtime/
    └── ai-verse-bots/
        └── coordination.db
```

Normal SQLite sidecars may appear next to the coordination database.

The installer does not create or rewrite:

- `AI-VERSE.yaml`
- `AGENTS.md`
- `agents/registry.yaml`
- `skills/registry.yaml`
- `operator/` canonical content
- `workspaces/` canonical content
- Brain state
- Memory state
- Skills generations
- Automations
- apps
- connection declarations

## Install sequence

The install flow is:

```text
verify compatible AI-Verse OS
  -> inspect existing Multiple Bots registration
  -> reject foreign ownership / upgrade-required versions
  -> verify extension/runtime path safety
  -> inspect extension file conflicts
  -> materialize missing INSTRUCTIONS.md + engine.mjs
  -> initialize/verify runtime coordination.db
  -> register through the existing locked atomic registry contract
  -> re-plan and report final state
```

Registration happens only after the coordination database has passed its health check.

If registration fails after this invocation created extension files, the installer attempts bounded cleanup of only those files it just created. It never recursively deletes the extension root or canonical host state.

## Ownership law

A same-key registry entry is installable only when it is already provably owned by AI-Verse Multiple Bots and bound to the current package version.

A foreign same-key entry fails closed with an ownership error.

A same-package entry from a different version is not silently converted by install. It is routed to the Phase 5.7 update lifecycle instead.

The full product update commands are:

```bash
ai-verse-multiple-bots os update-plan --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os update --root /path/to/AI-Verse-OS
```

The older `os upgrade-plan` / `os upgrade` commands remain aliases. Update refreshes only known package-owned extension payload plus owned registration metadata, preserves disabled state and coordination DB state, and fails closed when canonical state migration is required.

See `UPDATE-MIGRATION-STRATEGY.md`.

## Existing-file law

For fresh installation:

- missing known extension files may be created;
- byte-identical known files may be reused;
- different content at a known extension-owned path is treated as a conflict and is not overwritten;
- unknown files inside the extension root are ignored and preserved;
- symlinked path chains are rejected.

This prevents install from claiming or replacing ambiguous local files.

## Materialized engine

`engine.mjs` is a thin extension-owned bridge back to the installed npm package.

It exports:

- `aiVerseOsRoot`
- `packageVersion`
- `createGateway(options)`
- `startGateway(options)`

The engine resolves its AI-Verse OS root from its own installed location and starts the normal Coordination Gateway with:

- `aiVerseOsRoot` set to the host root;
- the canonical Multiple Bots coordination DB under `runtime/ai-verse-bots/`;
- loopback host `127.0.0.1` by default;
- port `8787` by default unless explicitly overridden by the caller.

Because the real package Gateway is used, all completed Phase 3 native adapters remain available through the existing runtime boundary rather than being reimplemented inside the extension wrapper.

## Registration vs health vs authorization

Installation still does not mean every runtime dependency is healthy or authorized.

The states remain distinct:

```text
package installed
  != extension materialized
  != registered
  != enabled
  != Gateway running
  != healthy
  != workspace-authorized
  != connection-authorized
  != action-approved
```

Production health is implemented by Phase 5.6 and now reports Phase 5.7 `update-required` / `migration-required` lifecycle states.

## Idempotence

Re-running `os install` against a current healthy installation:

- does not rewrite current extension files;
- does not rewrite a byte-equivalent registry entry;
- does not recreate the coordination database;
- returns `status: "unchanged"`.

## Phase boundary

Phase 5.3 does not implement:

- setup/onboarding wizard UX;
- starter Bot/team creation;
- production service-manager installation;
- public/remote Gateway exposure;
- cross-component release rollback;
- secure remote/public Gateway exposure;
- Dashboard or channel clients.

Component update/migration strategy is implemented by Phase 5.7; release-set rollback remains owned by AI-Verse Distribution.
