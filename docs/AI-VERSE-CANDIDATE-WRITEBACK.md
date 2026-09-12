# AI-Verse Candidate Knowledge and Decision Write-Back

**Phase:** 3.8

**Status:** COMPLETE

## Purpose

Phase 3.8 lets AI-Verse Multiple Bots nominate bounded knowledge and decision candidates for AI-Verse OS to evaluate without allowing the coordination layer to promote its own output into canonical truth.

This slice implements only the roadmap item named **candidate knowledge/decision write-back**. Memory, Skills, Brain and current-context write-back remain outside this slice.

## Ownership rule

```text
Multiple Bots coordination output
  -> bounded knowledge/decision candidate
  -> existing Phase 3.7 OS write-command boundary
  -> AI-Verse OS owner queue
  -> owner decides whether/how promotion happens
```

Multiple Bots does not write directly to workspace knowledge or decision files. A queued candidate is not a canonical knowledge item or settled decision.

## Candidate contract

A candidate is explicit and must include:

- exact workspace
- requesting durable Bot or temporary Worker
- candidate kind: `knowledge` or `decision`
- one existing source Artifact
- bounded title, summary and structured content
- optional confidence from 0 to 1
- optional bounded evidence Artifact references
- optional Task and Team Run provenance
- idempotency key, reason and creation timestamp

The candidate is routed through the existing OS operation:

```text
candidate.route
```

The routed parameters carry `canonical_effect_requested: false` and `owner_action: evaluate_for_promotion`.

## Evidence and scope

The source Artifact must already exist in Multiple Bots coordination state and must belong to the exact candidate workspace.

Every optional evidence Artifact must also belong to that workspace. Cross-workspace evidence is rejected before the OS owner boundary is contacted.

An OS write-command receipt or candidate write-back receipt cannot be recycled as the source evidence for another candidate.

When source Task or Team Run provenance exists, an explicitly supplied Task or Run id cannot contradict it.

## Persistence rule

Candidate content is sent to the owner-controlled OS queue because the owner needs the candidate body to evaluate it.

Multiple Bots does not persist a second candidate-content record. Its durable local receipt is the existing Phase 3.7 `os_write_command_receipt`, which stores parameter/provenance digests and source references rather than the candidate body.

The candidate event also contains no candidate content.

This preserves the source-of-truth boundary while still leaving an auditable coordination receipt.

## Promotion semantics

Phase 3.8 never claims that promotion happened.

A valid owner receipt must still report:

```json
{
  "effect_occurred": false,
  "canonical_effect_occurred": false,
  "result": {
    "queue_state": "pending_handler",
    "canonical_handler_dispatched": false
  }
}
```

AI-Verse OS remains responsible for any later handler, approval, conflict check and canonical mutation.

## Idempotency

The caller supplies a bounded candidate idempotency key. Multiple Bots namespaces it by candidate kind and binds it to the exact immutable Phase 3.7 write request.

Exact replay:

- recontacts the OS owner queue
- reuses the existing local receipt Artifact
- creates no duplicate local candidate state

Semantic drift under the same identity fails before a second changed owner request can be dispatched.

## Durable Bots and temporary Workers

An active workspace-scoped durable Bot may nominate a candidate for its workspace.

An active temporary Worker may also nominate a candidate for its exact workspace. This does not grant it canonical write authority, operator scope, promotion authority or durable identity.

The Phase 3.7 principal and provenance checks remain authoritative.

## Native HTTP surface

Native AI-Verse OS mode exposes:

```text
POST /v1/candidates/write-back
```

The endpoint is additive. Hosts without the Phase 3.7 owner write-command contract remain usable, but candidate write-back is unavailable and fails closed.

The generic `POST /v1/os/write-commands` boundary remains unchanged.

## Failure law

Candidate routing fails closed for conditions including:

- unsupported candidate kind
- missing or empty structured content
- invalid confidence
- oversized candidate content
- missing source Artifact
- source or evidence workspace escape
- contradictory source Task/Run provenance
- invalid or oversized evidence sets
- inactive or out-of-scope principal
- missing owner write-command boundary
- invalid owner permission/receipt
- semantic drift under an existing idempotency identity

Failure must not silently create canonical knowledge or decisions.

## Acceptance gate

Phase 3.8 is complete only when tests prove at minimum:

1. knowledge candidates route through `candidate.route`
2. decision candidates use the same bounded owner route
3. no route claims canonical promotion
4. candidate body is absent from Multiple Bots durable receipt Artifacts
5. source and evidence references cannot cross workspace boundaries
6. malformed or unsupported candidates fail before owner dispatch
7. exact replay is idempotent and semantic drift fails closed
8. temporary Workers can nominate only within their workspace and gain no canonical authority
9. the native HTTP endpoint exists only when the Phase 3.7 owner contract exists
10. the complete pre-existing coordination, squad, Brain, Memory, Skills, Automations and OS write-command suite remains green

**Verified gate:** GitHub Actions CI run 375 (`34708621932`) passed **270/270 tests**, with 0 failures, 0 canceled and 0 skipped, on exact implementation head `70ab433f73831ead8d9b43d0f4efc8a99938c7b8`.

## Non-goals

Phase 3.8 does not:

- implement an OS canonical promotion handler
- mutate workspace knowledge files
- append settled decisions directly
- implement Memory candidate writes
- implement Skills candidate promotion
- implement Brain result/observation write-back
- implement current-context mutation
- change the Phase 3 roadmap or ownership boundaries
