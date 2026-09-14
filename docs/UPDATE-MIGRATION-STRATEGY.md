# Update and Migration Strategy

**Status:** Phase 5.7 complete

**Updated:** 2026-09-13

## Purpose

Phase 5.7 makes software update explicit and keeps it separate from canonical coordination-state migration.

The public product commands are:

```bash
ai-verse-multiple-bots update-plan
ai-verse-multiple-bots update
```

Mode-specific forms are also available:

```bash
ai-verse-multiple-bots standalone update-plan --root /path/to/project
ai-verse-multiple-bots standalone update --root /path/to/project

ai-verse-multiple-bots os update-plan --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os update --root /path/to/AI-Verse-OS
```

The older expert aliases remain valid:

```bash
ai-verse-multiple-bots os upgrade-plan --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os upgrade --root /path/to/AI-Verse-OS
```

They now route through the same full product update lifecycle instead of only changing the registry version.

## Core law

```text
software/runtime update
  != canonical coordination-state migration
  != rollback/downgrade
```

An update may refresh package-owned runtime files and installation metadata.

It must not silently rewrite user-owned coordination history merely because a newer package is installed.

A coordination schema transition requires an explicit supported migration path.

Rollback/downgrade of a compatible multi-component release set belongs to the AI-Verse Distribution layer.

## Current coordination schema

The current canonical coordination schema is:

```text
1
```

Phase 5.7 introduces a read-only migration assessment before any product update.

For the current package:

- schema `1` requires no state migration;
- an unknown, missing or unsupported schema is reported as `migration-required`;
- no fake/no-op migration is invented;
- update fails closed before package-owned files or installation metadata are committed.

When a future schema bump requires a real migration, that migration must be explicitly registered, tested, state-preserving and independently auditable before update may cross it.

## Public update planning

`update-plan` is read-only.

It reports at minimum:

- selected mode;
- installed/current version evidence;
- target package version;
- whether software update is required;
- whether state migration is required;
- whether such a migration is supported;
- whether update can proceed;
- coordination schema state;
- preservation guarantees;
- blocking reasons.

Update never creates a fresh installation. If no existing installation is discoverable, setup/install remains the correct lifecycle.

If standalone and AI-Verse OS installations are both discoverable, update requires an explicit mode.

## Standalone version receipt

New standalone installations now include:

```text
.ai-verse-bots/
├── config.json
├── install.json
└── runtime/
    └── coordination.db
```

The package-owned `install.json` receipt records:

```json
{
  "schema_version": "1.0",
  "component_id": "ai-verse-multiple-bots",
  "component_version": "0.1.0-beta.1",
  "coordination_schema": "1",
  "mode": "standalone"
}
```

The receipt is installation/version metadata. It is not a second coordination source of truth.

Unknown receipt fields are preserved during metadata update.

## Legacy standalone adoption

Standalone installations created before the receipt existed remain valid.

They are reported as:

```text
legacy-unversioned
```

Running update explicitly adopts the existing installation by writing the current package receipt only after:

- standalone configuration is valid;
- coordination database exists as a safe regular file;
- SQLite integrity check passes;
- coordination schema is compatible.

Legacy adoption does not rewrite:

- `config.json`;
- `coordination.db`;
- user-created files under the standalone home.

After adoption, repeated update is idempotent and returns `unchanged`.

## Standalone update

For a versioned standalone installation:

- same package version + compatible schema -> `unchanged`;
- older receipt + compatible schema -> update receipt metadata only;
- missing receipt + compatible schema -> explicit legacy adoption;
- newer installed receipt -> fail with downgrade/rollback required;
- unsupported coordination schema -> `migration-required`.

The standalone config and coordination database remain untouched by a normal software update.

## AI-Verse OS update

AI-Verse OS already had a lower-level registry lifecycle. Phase 5.7 adds the missing full product update above it.

The sequence is:

```text
verify owned registration
  -> compare installed and target versions
  -> verify registered adapter paths
  -> inspect coordination schema read-only
  -> inspect package-owned extension files
  -> replace/create only known package-owned payload
  -> atomically upgrade owned registry entry
  -> re-plan and verify convergence
```

Known package-owned payload is currently:

```text
.aiverse/extensions/ai-verse-multiple-bots/INSTRUCTIONS.md
.aiverse/extensions/ai-verse-multiple-bots/engine.mjs
```

Update does not recursively replace the extension directory.

Unknown extension files remain untouched.

Registered adapter paths are verified rather than silently removed.

## Disabled-state preservation

An AI-Verse OS extension that was disabled before update remains disabled after update.

Update never treats a new package version as permission to reactivate the component.

Unknown fields in the owned extension registry entry and unrelated registry entries are preserved.

## Canonical-state preservation

Normal update preserves:

- Multiple Bots coordination objects/history;
- Tasks, Rooms, Handoffs, Artifacts and durable Bot state;
- execution/recovery state;
- AI-Verse OS operator truth;
- workspace truth;
- Brain state;
- Memory state;
- Skills state;
- Automations state;
- unrelated extension registrations.

The Phase 5.7 acceptance suite hashes the coordination database across current-schema updates and verifies it remains unchanged.

## AI-Verse OS update rollback boundary

Known package-owned extension files are snapshotted before replacement.

If the registry update cannot complete, for example because another lifecycle operation owns the registry lock, the update attempts to restore exactly those known files to their previous contents.

It does not broaden rollback into unknown paths.

The registry remains unchanged when its atomic commit cannot proceed.

This rollback is an **in-operation safety rollback** for one update attempt. It is not the same as user-requested release downgrade.

## Downgrade and release rollback

If the installed component version is newer than the package attempting the update, the operation fails closed.

Multiple Bots does not independently guess whether an older package is compatible with the rest of AI-Verse.

Release rollback belongs to the Distribution layer, which owns the exact compatible component set/lock.

## Status and doctor integration

Production status now distinguishes:

```text
setup-required
migration-required
update-required
disabled
unhealthy
ready
```

Relevant meanings:

- `update-required`: the installation exists and coordination state is compatible, but package-owned installation metadata/payload needs update;
- `migration-required`: canonical coordination state cannot be crossed by ordinary software update;
- `disabled`: the current compatible OS installation is intentionally disabled.

Doctor remains read-only. It reports lifecycle evidence but never runs update or migration.

## npm/package boundary

npm package installation itself still has no hidden host mutation.

The intended sequence is:

```text
install newer package/runtime
  -> owner-controlled update-plan
  -> owner-controlled update
  -> doctor
```

This keeps package distribution separate from canonical state mutation.

## Uninstall

Existing AI-Verse OS uninstall behavior remains non-destructive with respect to coordination state and canonical host state.

Phase 5.7 does not add a destructive purge.

Standalone package update likewise never deletes the standalone home or coordination database.

## Acceptance evidence

The hardened installed-package implementation gate passed GitHub Actions CI run 538 (`34778976513`) at head `34ff85fa4e9546237a00ef81b1e37ced71eef1b1`:

- full repository suite: **467/467 tests passed**;
- Phase 4 compatibility suite: **5/5 passed**;
- packed artifact: **206 files**;
- normal package install smoke: passed;
- standalone install smoke: passed;
- AI-Verse OS install smoke: passed;
- materialized OS engine smoke: passed;
- setup/onboarding smoke: passed;
- starter-template smoke: passed;
- production-doctor smoke: passed;
- installed-package update/migration smoke: passed;
- **0 failures, 0 canceled, 0 skipped**.

The installed-package update smoke proves:

- a legacy standalone installation can be adopted through the packed CLI;
- standalone config and coordination DB are preserved;
- an older AI-Verse OS registration/payload can be updated through the packed CLI;
- the OS coordination DB is preserved;
- canonical OS files remain unchanged;
- old `os upgrade` remains a valid idempotent alias.

## Phase boundary

Phase 5.7 does not implement:

- a fictitious migration when no schema transition exists;
- cross-component release rollback;
- destructive state purge;
- secure remote/public Gateway exposure;
- Dashboard/channel UX.

Secure remote Gateway is Phase 5.8.
