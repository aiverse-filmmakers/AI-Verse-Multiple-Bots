# Standalone Installation Contract

**Status:** Phase 5.2 complete

**Updated:** 2026-09-13

## Purpose

Standalone mode runs AI-Verse Multiple Bots without pretending that an AI-Verse OS host exists.

The canonical standalone home is:

```text
.ai-verse-bots/
```

Standalone mode owns only its coordination configuration and runtime state. It does not create AI-Verse OS operator, workspace, registry, Brain, Memory, Skills or Automations state.

## Canonical layout

Given a standalone project root:

```text
project/
└── .ai-verse-bots/
    ├── config.json
    ├── install.json
    └── runtime/
        └── coordination.db
```

SQLite may create its normal transient sidecar files next to `coordination.db`.

New Phase 5.7 installations also write package-owned `install.json` version metadata. Older standalone installations without that receipt remain valid and are explicitly adopted by `standalone update`; initialization does not silently rewrite legacy installations just to add metadata.

The standalone installer does not create:

- `AI-VERSE.yaml`
- `.aiverse/`
- `operator/`
- `workspaces/`
- AI-Verse OS extension registry entries

## Configuration

The current standalone config schema is:

```json
{
  "schema_version": "1.0",
  "mode": "standalone",
  "storage": {
    "coordination_db": "runtime/coordination.db"
  },
  "gateway": {
    "host": "127.0.0.1",
    "port": 8787
  }
}
```

The coordination database path is intentionally fixed inside `.ai-verse-bots/` so a standalone config cannot redirect canonical coordination state outside its own home.

The default bind address is loopback-only. Secure remote exposure belongs to Phase 5.8 and is not implied by standalone installation.

## Commands

Initialize a standalone installation in the current directory:

```bash
ai-verse-multiple-bots standalone init
```

Initialize at an explicit root:

```bash
ai-verse-multiple-bots standalone init --root /path/to/project
```

Choose the initial local Gateway bind settings:

```bash
ai-verse-multiple-bots standalone init --host 127.0.0.1 --port 8787
```

Run standalone health validation:

```bash
ai-verse-multiple-bots standalone doctor
```

Preview and apply package-version update/adoption:

```bash
ai-verse-multiple-bots standalone update-plan
ai-verse-multiple-bots standalone update
```

Start the Gateway from the stored standalone config:

```bash
ai-verse-multiple-bots standalone serve
```

For `doctor` and `serve`, the CLI searches the current directory and its ancestors for `.ai-verse-bots/config.json` unless `--root` is supplied.

## Initialization law

Standalone initialization is explicit. Installing the npm package still performs no hidden host configuration.

`standalone init`:

1. creates the requested project root when absent;
2. creates `.ai-verse-bots/` when absent;
3. writes the standalone config only when absent;
4. initializes the coordination database through the normal schema migration path;
5. runs the coordination-store health check before reporting success;
6. writes a package-owned installation/version receipt for a new installation;
7. creates no AI-Verse OS state.

Re-running initialization against an already compatible installation is byte-stable and returns `unchanged`.

If an explicit host or port conflicts with an existing config, initialization fails instead of silently rewriting the installation.

## Safety law

Standalone config and state fail closed when:

- the standalone root is not a real directory;
- `.ai-verse-bots/` is a symlink;
- `config.json` is missing, malformed, symlinked or uses an unsupported schema;
- config mode is anything other than `standalone`;
- the coordination database path differs from the canonical internal path;
- the runtime path traverses a symlink;
- the stored Gateway host or port is invalid.

An incompatible existing config is never silently replaced.

## Runtime boundary

`standalone serve` starts the normal Coordination Gateway using only:

- the standalone database;
- the stored local Gateway host;
- the stored local Gateway port;
- runtime adapters that are independently usable without AI-Verse OS.

It does not supply an `aiVerseOsRoot`. Therefore the AI-Verse-native workspace projector, Brain objective source, Memory source, Skills source, Automation source and OS write-command sink are not attached.

Runtime-specific adapters may still require their own explicit configuration or external providers. Standalone mode does not invent those providers.

## Skills and other optional host services

The host-neutral laws from earlier phases remain unchanged.

For example:

- a Task without `skill_refs` requires no AI-Verse Skills provider;
- a Task that explicitly requires a missing capability source fails closed;
- standalone mode does not create substitute Memory, Brain, Skills or Automation canonical stores.

## Phase boundary

Phase 5.2 does not implement:

- AI-Verse OS engine materialization or extension attachment;
- onboarding/wizard UX;
- Bot/team starter templates;
- production service manager installation;
- remote authentication or public-network binding;
- Dashboard/channel integration;
- secure remote/public Gateway exposure.

Phase 5.7 now owns update/adoption and migration-required detection. See `UPDATE-MIGRATION-STRATEGY.md`.
