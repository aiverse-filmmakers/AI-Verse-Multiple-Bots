# AI-Verse OS Registration Contract

**Status:** Phase 3.1 contract

**Host:** AI-Verse OS v2 (`schema_version` major 2, `architecture: unified-workspace`)

## Purpose

This contract defines how AI-Verse Multiple Bots attaches to AI-Verse OS without becoming a second owner of OS state.

Phase 3.1 is deliberately limited to compatibility detection, installation metadata, and safe local extension registration. It does not claim that the Multiple Bots engine is healthy, that a workspace is authorized, that tools are available, or that canonical AI-Verse state may be written.

## Host contract used

AI-Verse OS exposes optional local extensions through:

```text
.aiverse/extensions/registry.json
```

The Multiple Bots integration targets only that local runtime registry. Normal registration does not modify tracked OS files such as:

- `AI-VERSE.yaml`
- `AGENTS.md`
- `agents/registry.yaml`
- `skills/registry.yaml`
- `system/capabilities/`
- workspace canonical Markdown/state

The OS remains authoritative for its own tracked and user-owned state.

## Compatibility detection

A host is compatible only when all of these are true:

1. `AI-VERSE.yaml` is a regular, non-symlink file.
2. `schema_version` has major version `2`.
3. `architecture` is exactly `unified-workspace`.
4. `AGENTS.md` and `system/extensions/README.md` are regular, non-symlink files.
5. `operator/` and `workspaces/` exist as real directories.
6. The runtime and extension contracts both expose `.aiverse/extensions/registry.json` as the local extension hook.

Absence is reported as `no-os`. Unsupported, malformed, incomplete, or unsafe layouts are reported as `incompatible`. Registration fails closed in both cases.

## Registration envelope

The local OS registry uses schema `1.0`. Multiple Bots owns only the entry keyed by:

```text
ai-verse-multiple-bots
```

Its canonical fields are:

```json
{
  "id": "ai-verse-multiple-bots",
  "supported": true,
  "installed": true,
  "enabled": true,
  "version": "<package version>",
  "source": "AI-Verse-Multiple-Bots",
  "instructions": ".aiverse/extensions/ai-verse-multiple-bots/INSTRUCTIONS.md",
  "engine": ".aiverse/extensions/ai-verse-multiple-bots/engine.mjs",
  "adapters": []
}
```

Existing `enabled: false` is preserved across reinstall/update unless an explicit caller intentionally overrides it. Unknown top-level registry fields, unknown extension entries, and unknown fields on the Multiple Bots entry are preserved.

## Safe mutation contract

Registration follows this sequence:

```text
Detect compatible AI-Verse OS host
  -> validate the current registry
  -> acquire .aiverse/extensions/registry.json.lock exclusively
  -> reread the latest registry inside the lock
  -> verify installed extension-owned instruction/engine/adapter files
  -> merge only the Multiple Bots entry
  -> recheck the registry did not change unexpectedly
  -> atomic temp-file + rename replacement
  -> release the lock
```

A competing lock produces `EXTENSION_REGISTRY_BUSY`; it is never stolen or deleted by a process that did not acquire it. If the registry changes unexpectedly during the operation, registration produces `EXTENSION_REGISTRY_CHANGED` and applies no replacement.

A crash may leave a stale lock file. The implementation intentionally does not guess whether a lock is stale and does not steal it automatically. That condition is operator-visible and must be resolved deliberately.

## Path safety

Every extension-owned path must be repository-relative. Registration rejects:

- absolute POSIX paths
- Windows drive-prefixed absolute paths
- UNC/rooted Windows paths
- `..` traversal
- `.` or empty path segments
- NUL characters
- paths that resolve outside the OS root
- symlinked installed files or symlink traversal in the checked host/extension path chain

The registry itself must be a regular JSON file if already present. Unsupported registry schema or malformed registry state is never silently replaced.

## Installation vs registration vs health

These are separate states:

```text
materialized files != registered != enabled != healthy != authorized
```

`registerAiVerseOsExtension()` verifies that the paths it records as installed actually exist, but it does not create the production engine payload and does not assert live engine health. Final one-command packaging/materialization belongs to Phase 5.

The Phase 3.1 CLI therefore exposes host-registration operations for an installer or operator that already materialized the extension-owned files:

```bash
ai-verse-bots os detect --root /path/to/AI-Verse-OS
ai-verse-bots os plan --root /path/to/AI-Verse-OS
ai-verse-bots os register --root /path/to/AI-Verse-OS
```

The programmatic adapter is also exported as `aiVerseOsRegistrationAdapter`.

## Identity boundary

Extension registration must not create or rewrite AI-Verse OS `agents/registry.yaml` entries.

A durable Multiple Bots `Bot` is a coordination teammate identity owned by this package. It becomes an OS-visible agent only through a future explicit mapping/adapter contract if one is justified.

A temporary `Worker` is Team-Run-scoped and must never become an OS durable agent implicitly.

## State ownership boundary

| State | Canonical owner |
| --- | --- |
| Bot/Worker coordination identity | Multiple Bots |
| Messages, Rooms, Threads, Tasks, Handoffs, Team Runs | Multiple Bots |
| Coordination Artifacts/events/leases/budgets | Multiple Bots |
| Operator profile/preferences | AI-Verse OS |
| Workspace identity and canonical workspace state | AI-Verse OS |
| Durable knowledge/decisions/current context | AI-Verse OS |
| Capability and connection declarations | AI-Verse OS / owning capability layer |
| Automations/apps/routing policy | AI-Verse OS / owning layer |

Later Phase 3 adapters may project OS state into bounded execution context, but projections are derived views and must not become competing editable truth.

## Phase boundary

Phase 3.1 establishes the safe attachment point only. It intentionally does not implement:

- workspace-scoped state projection
- Brain goal/initiative ingress
- Memory recall/context integration
- Skills capability resolution
- Automations wake/schedule integration
- canonical OS write commands
- candidate knowledge/decision write-back
- 4Cs health projection
- upgrade/uninstall state-preservation mechanics

Those are Phase 3.2 through 3.10 and must build on this contract rather than bypass it.

Phase 3.10 now defines the lifecycle completion of this registration contract. Upgrade requires an existing owned registration and preserves disabled/unknown metadata. Uninstall removes only the owned registry entry and known registered regular files inside the extension root, preserves coordination state and canonical host state, and never recursively scavenges unknown files. See `AI-VERSE-UPGRADE-UNINSTALL-SAFETY.md`.
