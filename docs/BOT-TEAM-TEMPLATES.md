# Starter Bot and Team Templates

**Status:** Phase 5.5 complete

**Updated:** 2026-09-13

## Purpose

Phase 5.5 adds reusable starter templates without making setup silently create durable identities.

The template flow is explicit:

```text
list
  -> show
  -> plan against a real workspace/database
  -> apply
```

Templates create Multiple Bots-owned coordination objects only.

They never create or rewrite AI-Verse OS canonical workspace/operator truth.

## Public commands

List available templates:

```bash
ai-verse-multiple-bots template list
```

Inspect one template:

```bash
ai-verse-multiple-bots template show --id research-team
```

Preview exact IDs and mutations before creation:

```bash
ai-verse-multiple-bots template plan \
  --id research-team \
  --workspace my-workspace \
  --runtime deterministic \
  --db /path/to/coordination.db
```

Apply explicitly:

```bash
ai-verse-multiple-bots template apply \
  --id research-team \
  --workspace my-workspace \
  --runtime deterministic \
  --db /path/to/coordination.db
```

Required runtime selection:

```bash
--runtime ADAPTER
```

Optional identity control:

```bash
--prefix PREFIX
```

## Built-in starter catalog

The machine-readable catalog lives at:

```text
templates/starter-catalog.json
```

Current templates:

| ID | Kind | Creates |
| --- | --- | --- |
| `research-lead` | Bot | one durable Research Lead |
| `reviewer` | Bot | one durable Independent Reviewer |
| `coordinator` | Bot | one durable Work Coordinator |
| `research-team` | Team | Research Lead + Source Auditor + Independent Reviewer + one bounded Room |
| `delivery-team` | Team | Work Coordinator + Delivery Analyst + Independent Reviewer + one bounded Room |

The older `templates/bot.yaml` and `templates/room.yaml` remain protocol examples. The starter catalog is the reusable product surface.

## Durable team vs Team Run

A **team template** creates a durable roster plus one durable Room.

It does **not** create a Team Run.

That distinction is intentional:

```text
starter team
  -> durable named coworkers + Room

Team Run
  -> runtime-selected bounded execution for one objective
  -> may create temporary Workers
  -> collaboration gate decides if extra agents are justified
```

A reusable template must not turn every request into a swarm.

## Workspace requirement

Every application requires an explicit real workspace ID.

Templates never invent an AI-Verse workspace and never move a Bot across workspace scope.

Generated Bot IDs are deterministic and workspace-scoped.

By default the prefix is derived from:

```text
<workspace-id>-<template-id>
```

For example:

```text
workspace: ws_research
template: research-team

bot_ws_research_research_team_lead
bot_ws_research_research_team_auditor
bot_ws_research_research_team_reviewer
room_ws_research_research_team
```

An explicit `--prefix` can change the generated identity prefix, but never the workspace scope.

## Permission defaults

Starter templates intentionally avoid broad implicit authority.

Generated Bots:

- cannot create durable Bots;
- use explicit peer Bot IDs instead of `allowed_peers: ["*"]`;
- can create temporary Workers only when that role actually owns decomposition/synthesis;
- may hand off only where the template declares it;
- start with no declared tools, connections or Skills;
- use the existing `default-bot` policy floor;
- use candidate-only Memory writes;
- preserve workspace scope.

Template application does not grant connections, tools, external accounts, approvals or broader AI-Verse authority.

## Runtime selection

Phase 5.6 readiness hardening requires an explicit runtime adapter for template planning/application.

There is no silent runtime default.

This matters because older examples used `native`, while the current stock Gateway does not register a `native` execution adapter. Automatically creating an active durable Bot with that value would create a teammate that cannot execute.

Example:

```bash
--runtime codex
```

The `deterministic` adapter is useful for deterministic evaluation/smoke workflows, not as a claim of a production model runtime.

Template application records the requested adapter but does not claim the adapter's external dependencies are healthy. Phase 5.6 `doctor` verifies active runtime/dependency readiness separately.

`external-managed` is intentionally rejected by the starter template path.

A persistent external-managed Bot requires explicit provider, managed Bot reference and binding fingerprint ownership. A generic starter must never fabricate those bindings.

## Plan semantics

`template plan` is read-only.

Each planned object is reported as:

```text
missing  -> create
current  -> none
conflict -> none
```

The plan also reports:

- template identity;
- real workspace ID;
- resolved deterministic prefix;
- runtime adapter;
- every Bot/Room payload;
- whether application is safe;
- all conflicts;
- `creates_team_run: false`;
- `mutates_ai_verse_os_truth: false`.

## Collision law

Template application never overwrites a durable identity or Room.

A conflict is raised when a generated ID already exists with different content.

Existing exact template state is accepted as current.

Bot registry address collisions are checked before mutation, including names and generated addresses.

A conflicting object blocks the whole apply before new template objects are committed.

## Atomic team creation

A multi-Bot team is written through one coordination-store atomic mutation.

Creation uses explicit absent-object preconditions so a same-ID object appearing before commit causes failure instead of replacement.

Already-current template objects are protected with version/update preconditions while missing objects are created.

This supports safe completion of exact partial state without rewriting current objects.

## Idempotence

Applying the same template again to the same workspace/runtime/prefix returns:

```json
{
  "status": "unchanged",
  "created_ids": []
}
```

No duplicate creation events are emitted.

If the operator has changed one of the template-owned coordination objects, reapply reports a conflict instead of reverting the operator's durable identity/state.

## Room defaults

Current team templates use bounded manager-style Rooms:

- explicit leader;
- leader-first speaker policy;
- bounded rounds;
- bounded Bot messages per user turn;
- Threads enabled;
- one workspace scope;
- explicit work ownership policy.

The Room coordinates durable teammates. It does not replace the bounded Team Run control plane.

## Setup integration

Phase 5.4 setup still does not create a Bot or team.

Its third onboarding step now points to:

```bash
ai-verse-multiple-bots template list
```

The operator remains responsible for choosing whether a starter actually fits the real workspace before running `template apply`, including choosing an explicit runtime adapter.

## Phase boundary

Phase 5.5 does not implement:

- automated health repair (Phase 5.6 adds read-only production health/doctor);
- public enable/disable/update lifecycle;
- migration strategy;
- secure remote Gateway exposure;
- Dashboard/channel UI.

Those remain later Phase 5 slices.
