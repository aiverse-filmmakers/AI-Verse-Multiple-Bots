# AI-Verse Multiple Bots — AI-Verse OS Extension Instructions

This file is the task-relevant runtime instruction entrypoint for the AI-Verse Multiple Bots extension when it is installed inside AI-Verse OS.

## Authority boundary

AI-Verse Multiple Bots owns coordination state: durable Bot identity, Messages, Rooms, Threads, Tasks, Handoffs, Team Runs, temporary Workers, Approvals, coordination Artifacts, events, execution leases, budgets, cancellation, and recovery.

AI-Verse OS remains the source of truth for operator state, workspace identity and isolation, current context, durable knowledge, decisions, connection declarations, capabilities, automations, apps, and OS routing policy.

Never treat the Multiple Bots coordination database, a Bot conversation, a temporary Worker result, or a Team Run Artifact as canonical AI-Verse OS truth merely because it exists.

## Startup behavior

When Multiple Bots is relevant to the task:

1. Confirm the extension registration is `supported`, `installed`, and `enabled`.
2. Check extension health live through the Multiple Bots `GET /v1/health/4cs` evidence surface when the Gateway is available. Registration is not proof that the engine is running or usable.
3. Read the AI-Verse OS runtime contract and machine-readable architecture before resolving host state.
4. Identify the operator/workspace scope through AI-Verse OS before creating or routing Bot work.
5. Pass only the minimum scoped host context needed for the task.
6. Preserve the AI-Verse workspace ID and root objective lineage through every delegated Task, Handoff, Room, and Team Run.
7. Use the smallest collaboration topology that can reliably complete the work.
8. Require normal OS/connection/action approvals. Extension registration grants no authority.
9. Return discoveries as coordination evidence or candidate write-back; do not silently mutate canonical OS knowledge, memory, decisions, or context.
10. Fail visibly if the host adapter, required connection, capability, approval, or workspace scope cannot be verified.

## Four Cs health rules

- Treat the Multiple Bots Four Cs response as derived audit evidence, not canonical health truth.
- AI-Verse OS `/audit` remains the scoring and finding-lifecycle authority.
- `verified` requires deterministic or durable execution evidence; configured presence alone is not enough.
- A connection grant is never proof that the external source can currently be reached.
- Do not copy workspace context, Memory text, Brain intent, Skill instructions, automation definitions, or Artifact content into health state.
- Use an explicit workspace scope when evaluating workspace Context.
- Health reads must not create Tasks, Artifacts, events, approvals, schedules, write-backs, or canonical OS mutations.

## Identity rules

- A durable Multiple Bots `Bot` is a coordination teammate identity. It is not automatically a canonical AI-Verse OS `agents/registry.yaml` entry.
- A temporary `Worker` is Team-Run-scoped and must never be promoted into AI-Verse OS durable agent state implicitly.
- Registration of this extension must never create, rewrite, or delete unrelated OS agents.

## State rules

- Host state may be projected into Multiple Bots only as scoped references or derived execution context unless a later explicit adapter contract says otherwise.
- Derived projections are disposable and must never become a competing editable source of truth.
- Canonical OS writes must use the OS-owned write boundary once that Phase 3 adapter is available.
- Cross-workspace context sharing is denied by default unless the host explicitly authorizes it for the task.

## Installation rule

Normal installation, update, enable/disable, and uninstall flows must not edit tracked AI-Verse OS files. Local extension installation state belongs in `.aiverse/extensions/registry.json`, and this extension owns only its own registration entry and extension-owned local files.

Unknown registry fields and other extension entries must be preserved.

## Current integration maturity

Phase 3.1 through Phase 3.9 establish compatibility/registration, workspace projection, Brain ingress, Memory/Skills/Automations adapters, the OS write-command boundary, candidate write-back, and read-only Four Cs health evidence. Upgrade/uninstall behavior remains Phase 3.10.

Do not infer any integration is operational merely from extension registration; use its explicit runtime evidence and owner-controlled contract.
