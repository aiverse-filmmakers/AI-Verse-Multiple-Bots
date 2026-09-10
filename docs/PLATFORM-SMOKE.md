# Platform-Wide Smoke Acceptance

`AI-Verse-Multiple-Bots` owns the platform smoke entrypoint because it is the coordination layer that must compose cleanly with the rest of the AI-Verse stack rather than passing only in isolation.

Run it from this repository after installing the development dependency:

```bash
npm install --no-audit --no-fund
npm run platform:smoke
```

The command builds the Multiple Bots revision under test, creates an isolated temporary workspace, clones the exact external revisions recorded in `scripts/platform-smoke.lock.json`, creates an isolated Python environment, and then runs one bounded acceptance path across all five repositories.

## What it proves

The smoke fails unless all of these boundaries work together:

1. **Multiple Bots coordination contracts** — the OS registration, Brain objective ingress contract, Brain-backed Worker propagation, Worker execution, and Safety II tests pass on the Multiple Bots revision under test.
2. **OS + Memory installation** — Memory composes into a real audited OS checkout through the extension registry.
3. **OS + Brain installation and ownership** — Brain initializes through the supported OS contract and can receive an explicit direction handover.
4. **OS + Skills provider discovery** — the real immutable Skills generation is discovered through the OS capability resolver and a qualified capability is selected with its generation/digest binding intact.
5. **Brain + Memory + Skills runtime retrieval** — a real Brain tick receives task-relevant Memory history and the real Skills capability catalog through a composed host view.
6. **Frozen strategy boundary** — after Brain owns direction, the canonical OS current-context resolver excludes the old OS strategic priority while preserving permitted operational context.
7. **Memory workspace isolation** — one workspace cannot retrieve another workspace's scoped record under the composed installation.
8. **OS + Brain permissions** — the more restrictive OS decision still blocks an action even when Brain policy would otherwise allow it.
9. **Multiple Bots + real OS registration** — the built coordination package detects the composed OS, registers only through `.aiverse/extensions/registry.json`, preserves the Memory extension entry, and its installed engine can load.
10. **Tracked OS cleanliness** — Multiple Bots composition does not mutate tracked OS files. The only expected tracked modification during the smoke is the explicit Brain support registration used to construct the test host.

This is an integration smoke, not a replacement for each repository's exhaustive unit and compatibility suites.

## Revision locking

External repositories are never tested from floating `main` references. `scripts/platform-smoke.lock.json` records an exact 40-character commit SHA for OS, Memory, Brain, and Skills. The smoke validates the lock, checks out every revision detached, and verifies the resulting HEAD before running acceptance.

When an external contract intentionally advances, update the corresponding lock entry in the same PR that adapts the smoke to that contract. Do not silently fall back to another revision when checkout or acceptance fails.

## Failure behavior

The runner is fail-closed. A missing prerequisite, failed clone, wrong revision, failed subprocess, malformed JSON response, missing integration evidence, or failed assertion exits non-zero. The harness tests verify that child-process failures propagate to the top-level command.

Temporary smoke workspaces are deleted after a successful or failed normal run. For investigation, preserve the generated workspace with:

```bash
npm run platform:smoke -- --keep
```

Or use a caller-owned location:

```bash
npm run platform:smoke -- --workspace /path/to/platform-smoke-workspace
```

Set `PYTHON=/path/to/python` when the preferred Python 3 interpreter is not discoverable as `python3` or `python`.

## CI

`.github/workflows/platform-smoke.yml` runs the same `npm run platform:smoke` command on pull requests, pushes to `main`, and manual dispatch. The workflow only supplies Node, Python, and npm dependencies; the actual platform composition and acceptance logic remains owned by the repository scripts rather than being duplicated in workflow YAML.
