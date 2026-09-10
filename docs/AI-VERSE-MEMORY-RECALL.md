# AI-Verse Memory Recall Adapter

**Phase:** 3.4 — Memory context/recall adapter

**Status:** implementation contract

## Purpose

Phase 3.4 lets a durable Bot or temporary Worker request a small, relevant historical recall from AI-Verse Memory while preserving the ownership boundary between repositories.

AI-Verse Memory remains canonical for historical memory and its rebuildable search index. AI-Verse Multiple Bots remains canonical only for coordination state. Multiple Bots must not copy Memory's canonical Markdown store or treat the Memory SQLite index as its own source of truth.

## Integration rule

Multiple Bots integrates through the installed AI-Verse Memory engine under:

```text
scripts/ai-verse-memory/memory.py
```

The adapter invokes the Memory engine rather than reading `runtime/indexes/ai-verse-memory/memory.db` directly.

This preserves Memory's own rules for source validation, current-source refresh, supersession, ranking, workspace isolation and rebuildability.

## Explicit recall only

Historical recall is never injected into every Task automatically.

A Task must carry an explicit bounded request:

```json
{
  "memory_recall": {
    "query": "what did we learn about supervised testing?",
    "limit": 6,
    "include_history": false
  }
}
```

No `memory_recall` request means no Memory process is invoked and no historical recall is added to the runtime context.

## Scope and authority

For Phase 3.4, a Task-scoped recall is always bound to the Task's exact workspace.

The adapter calls native Memory recall with the equivalent of:

```text
recall <query> --workspace <workspace-id>
```

AI-Verse Memory therefore searches:

1. the selected workspace; and
2. operator-level context allowed by Memory's native workspace contract.

It does not search unrelated workspaces.

Cross-workspace recall is deliberately not exposed by the Phase 3.4 runtime request contract. A later explicit product boundary may add it only with separate operator-authorized scope expansion.

The Task and execution principal must share one explicit workspace before recall can run.

## Current truth outranks history

Memory recall is lower-authority historical/contextual evidence.

When both are present at runtime:

1. Task instructions, immutable constraints, capability leases and approvals remain hard execution authority.
2. AI-Verse OS workspace/current-context projection remains current canonical state.
3. AI-Verse Brain strategic intent remains canonical direction for Brain-rooted work.
4. AI-Verse Memory recall provides historical evidence and prior context only.

Historical recall must never silently override current workspace context, current decisions or explicit Task constraints.

## Runtime-only content

The actual recalled text is ephemeral execution context.

Multiple Bots may pass the bounded recall set to the runtime so the Bot or Worker can use it, but coordination persistence may keep only provenance required to explain what informed the output:

- provider and schema version;
- workspace id;
- query digest;
- recall-set digest;
- result count;
- bounded source refs/paths, kinds, scopes and source versions/digests where available.

The receipt must not persist recalled memory text or `why` content.

## Availability and fail-closed behavior

AI-Verse native mode may exist without AI-Verse Memory being installed.

Therefore:

- a Task with no recall request runs normally when Memory is absent;
- a Task that explicitly requests recall fails closed if the Memory engine is unavailable, malformed, incompatible or returns invalid/out-of-scope data;
- standalone Multiple Bots remains unchanged when no host Memory source is configured;
- an explicit recall request must never be silently ignored.

## Bounds

The adapter enforces independent host-side ceilings even if a caller supplies larger values:

- non-empty query with bounded length;
- small result-count ceiling;
- subprocess timeout;
- stdout/stderr buffer ceiling;
- maximum recalled text per item;
- maximum total recalled text;
- exact workspace/operator scope validation on every returned result.

The adapter uses argument-vector process execution, never a shell command string.

## Durable Bots and temporary Workers

Recall is attached to the common runtime execution context, not to a Bot-only path.

Temporary Workers therefore receive the same explicit, workspace-scoped recall contract as durable Bots without gaining durable identity, Memory write authority or broader workspace visibility.

Worker creation, handoff, fan-out, discussion and verification do not implicitly widen Memory scope.

## Writes are out of scope

Phase 3.4 is recall-only.

It does not allow Bots or Workers to write, supersede, forget or directly mutate AI-Verse Memory. Candidate write-back belongs to later explicit OS/Memory write boundaries and must preserve approval and canonical ownership rules.

## Acceptance gate

Phase 3.4 is complete only when tests prove at minimum:

1. explicit workspace recall reaches a durable Bot runtime;
2. no request means no Memory invocation;
3. unrelated workspace recall is impossible;
4. operator context may be returned only through Memory's native workspace recall contract;
5. recalled text is never persisted in coordination Artifacts/receipts;
6. source provenance and recall digests are persisted;
7. missing or invalid Memory installation fails only recall-requesting Tasks and does not break ordinary native execution;
8. malformed, oversized or out-of-scope Memory output fails closed;
9. a temporary Team Run Worker receives the same recall contract;
10. current workspace projection remains explicitly higher authority than historical recall in model prompting.
