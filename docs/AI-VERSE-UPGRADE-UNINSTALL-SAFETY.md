# AI-Verse Upgrade and Uninstall Safety

**Phase:** 3.10

**Status:** COMPLETE

## Purpose

Phase 3.10 defines safe AI-Verse OS lifecycle operations for AI-Verse Multiple Bots without allowing upgrade or uninstall to damage canonical or user-owned state.

This slice is deliberately narrower than Phase 5 packaging. It does not build the final installer or package materializer. It defines what may be changed after extension files have already been materialized.

## Ownership boundary

Lifecycle operations may mutate only:

- the `ai-verse-multiple-bots` entry inside `.aiverse/extensions/registry.json`
- registered regular files that are both:
  - explicitly referenced by the owned Multiple Bots registry entry
  - located under `.aiverse/extensions/ai-verse-multiple-bots/`

Lifecycle operations must not mutate or delete:

- `AI-VERSE.yaml`
- `AGENTS.md`
- operator state
- workspace manifests or workspace content
- current context
- knowledge
- decisions
- connection state
- Brain state
- Memory state or indexes
- Skills packages or generations
- Automations definitions or history
- apps
- unrelated extension entries
- unknown registry fields
- the Multiple Bots coordination database
- registered adapter files outside the Multiple Bots extension root
- unknown/unregistered files left inside the extension root

## Upgrade

Upgrade is not installation.

`planAiVerseOsUpgrade()` and `upgradeAiVerseOsExtension()` require an existing registration that is provably owned by this package.

Ownership requires the existing entry to bind:

- id: `ai-verse-multiple-bots`
- source: `AI-Verse-Multiple-Bots`
- canonical instruction path
- canonical engine path
- a valid existing version
- a valid adapters array

A missing registration fails with `EXTENSION_NOT_REGISTERED`.

A same-key registry entry owned by another source fails with `EXTENSION_OWNERSHIP_MISMATCH`.

Upgrade then reuses the existing registration safety contract:

- compatible AI-Verse OS v2 host required
- extension registry lock required
- current registry reread inside the lock
- installed target files verified before mutation
- unknown registry fields preserved
- unrelated extensions preserved
- user-disabled `enabled: false` state preserved
- atomic registry replacement
- no tracked OS file mutation

Phase 3.10 upgrade only reconciles lifecycle registration metadata against already-materialized extension files. Final package download/materialization/version distribution remains Phase 5.

## Uninstall

Uninstall has two stages:

```text
prove owned registration
  -> build bounded removal plan
  -> atomically remove only own registry entry
  -> remove only known registered regular files inside own extension root
  -> preserve everything else
```

The registry entry is removed before file cleanup. This ordering favors host safety: if file cleanup is incomplete, the extension is no longer registered and leftover files remain inert rather than risking broad deletion.

### File removal rule

A registered path is eligible for automatic removal only when all of these are true:

1. it is a safe repository-relative path
2. it is inside `.aiverse/extensions/ai-verse-multiple-bots/`
3. its path chain contains no symlink
4. if present, it is a regular file

Registered paths outside the extension root are preserved and reported as residual registered paths.

Unknown files are never discovered and scavenged recursively.

The extension root itself is not recursively deleted.

A second uninstall after the registry entry is already absent is a no-op. It does not search for or delete leftovers.

## Coordination state

The canonical Multiple Bots coordination database is deliberately preserved.

Default CLI state remains:

```text
runtime/ai-verse-bots/coordination.db
```

Upgrade and uninstall do not open, migrate, truncate, move or delete that database.

Deleting coordination history is a different explicit destructive operation and is not part of Phase 3.10.

## Registry preservation

Both lifecycle operations reuse the Phase 3.1 registry lock and atomic compare-before-replace behavior.

They preserve:

- unknown top-level registry fields
- unrelated extension entries
- unknown fields owned by unrelated extensions

Upgrade also preserves unknown fields on the Multiple Bots entry and its user-disabled state.

Uninstall removes the complete owned Multiple Bots registry entry because the extension is no longer registered.

## Concurrency

Upgrade and uninstall use the same exclusive registry lock as registration.

They never steal or delete another process's lock.

If another lifecycle operation owns the lock, the operation fails with `EXTENSION_REGISTRY_BUSY` and applies no registry mutation.

## Symlink and ownership failure law

Lifecycle mutation fails closed before registry change when:

- the same-key registry entry is not provably owned by Multiple Bots
- registered lifecycle metadata is malformed
- a removal path traverses a symlink
- the host is incompatible
- the registry is malformed or unsupported
- the registry is already locked

A symlinked extension path is never followed during uninstall.

## CLI

The additive lifecycle commands are:

```bash
ai-verse-bots os upgrade-plan --root /path/to/AI-Verse-OS
ai-verse-bots os upgrade --root /path/to/AI-Verse-OS
ai-verse-bots os uninstall-plan --root /path/to/AI-Verse-OS
ai-verse-bots os uninstall --root /path/to/AI-Verse-OS
```

Planning commands are read-only.

## Acceptance gate

Phase 3.10 is complete only when tests prove at minimum:

1. upgrade requires an existing owned registration
2. upgrade rejects a foreign same-key registration
3. upgrade preserves unknown registry fields and unrelated extensions
4. upgrade preserves user-disabled state
5. upgrade changes no canonical OS/workspace/Brain/Memory/Skills/Automation state
6. uninstall removes only the owned registry entry
7. uninstall removes only known registered regular files inside the extension root
8. registered files outside the extension root are preserved
9. unknown extension-root files are preserved
10. the coordination database is preserved
11. canonical OS/workspace/knowledge/automation/capability fixtures remain byte-identical
12. uninstall is idempotent and does not scavenge leftovers when no registration exists
13. ownership mismatch and symlink paths fail before registry mutation
14. upgrade and uninstall respect the existing registry lock
15. the full pre-existing coordination and Phase 3 suite remains green

**Verified gate:** GitHub Actions CI run 384 (`34709530708`) passed **287/287 tests**, with 0 failures, 0 canceled and 0 skipped, on exact implementation head `eb41d3f690590dd0e2cefd739109058ee5a3eae6`.

## Non-goals

Phase 3.10 does not:

- build the final clean-machine installer
- download or materialize package releases
- publish npm packages
- recursively purge extension directories
- purge coordination history
- migrate canonical AI-Verse domain state
- begin Phase 4 runtime interoperability
- begin Phase 5 product packaging
