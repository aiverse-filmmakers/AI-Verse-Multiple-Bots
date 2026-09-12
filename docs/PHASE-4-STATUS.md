# Phase 4 Status - Runtime and Agent Interoperability

**Updated:** 2026-09-12

**Phase:** 4

**Overall status:** IN PROGRESS

**Directional phase progress:** approximately 10%

This file is the implementation ledger for Phase 4. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 4 goal

Make durable Bots and temporary Workers portable across supported local and remote runtimes while preserving Multiple Bots protocol identity, authority, cancellation, provenance and recovery boundaries.

## Slice status

1. A2A adapter - **COMPLETE**
2. Hermes adapter - **NEXT**
3. OpenClaw adapter - **NOT STARTED**
4. Codex/Claude Code process adapters where appropriate - **NOT STARTED**
5. external managed Bot runtime - **NOT STARTED**
6. remote-machine identity/authentication - **NOT STARTED**
7. remote capability/environment leases - **NOT STARTED**
8. retry/disconnect/reconnect semantics - **NOT STARTED**
9. compatibility/evaluation suite - **NOT STARTED**

## Slice 4.1 - A2A adapter

**Implementation status:** COMPLETE

The first Phase 4 slice adds an A2A v1.0 JSON-RPC runtime adapter without changing the local Task, identity, authority, Artifact or recovery ownership model.

Implemented:

- fresh Agent Card discovery
- ordered JSON-RPC v1.0 interface selection
- deterministic local-task-derived A2A message identity
- structured local execution envelope
- direct Message response support
- remote Task polling with `GetTask`
- completed remote Artifact translation
- local cancellation -> remote `CancelTask`
- durable Bot and temporary Worker identity preservation
- bounded A2A request/response sizes
- JSON-RPC envelope validation
- explicit authentication and required-extension fail-closed boundaries
- no Phase 4.2+ behavior

See `A2A-RUNTIME-ADAPTER.md`.

### 4.1 acceptance proof

The exact implementation head `29f220ef8e6318bf5dfed835e8a0d966c0c51586` passed GitHub Actions **CI run 389 (`34710078152`) with 294/294 tests**, **0 failures, 0 canceled and 0 skipped**.

Phase 4.1 acceptance coverage proves:

1. Agent Card discovery selects the ordered JSON-RPC A2A v1.0 interface
2. deterministic local Task identity becomes the A2A message id
3. durable Bot identity remains the local execution principal
4. temporary Worker identity remains temporary through remote execution
5. JSON and text input modes preserve the same structured local execution contract
6. direct Message responses become normal local runtime results
7. non-terminal remote Tasks poll through `GetTask`
8. completed remote Task Artifacts become normal local runtime results
9. interrupted/failed/rejected/canceled remote states never become successful local Artifacts
10. auth requirements fail closed rather than bypassing the future remote-auth slice
11. required unsupported A2A extensions fail closed
12. unsupported protocol bindings and versions fail closed
13. JSON-RPC response identity is checked
14. local cancellation attempts `CancelTask` while remaining locally authoritative
15. persisted runtime receipts contain bounded provenance rather than copied execution context
16. the Gateway exposes `a2a` through the ordinary runtime registry
17. the complete pre-existing Phase 0-3 and coordination suite remains green


## Next gate

**Phase 4.2 - Hermes adapter.**

Phase 4.1 is complete. Phase 4.2 has not started.
