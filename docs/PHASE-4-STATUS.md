# Phase 4 Status - Runtime and Agent Interoperability

**Updated:** 2026-09-12

**Phase:** 4

**Overall status:** IN PROGRESS

**Directional phase progress:** implementation gate pending for first slice

This file is the implementation ledger for Phase 4. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 4 goal

Make durable Bots and temporary Workers portable across supported local and remote runtimes while preserving Multiple Bots protocol identity, authority, cancellation, provenance and recovery boundaries.

## Slice status

1. A2A adapter - **IN PROGRESS**
2. Hermes adapter - **NOT STARTED**
3. OpenClaw adapter - **NOT STARTED**
4. Codex/Claude Code process adapters where appropriate - **NOT STARTED**
5. external managed Bot runtime - **NOT STARTED**
6. remote-machine identity/authentication - **NOT STARTED**
7. remote capability/environment leases - **NOT STARTED**
8. retry/disconnect/reconnect semantics - **NOT STARTED**
9. compatibility/evaluation suite - **NOT STARTED**

## Slice 4.1 - A2A adapter

**Implementation status:** acceptance gate pending

The first Phase 4 slice adds an A2A v1.0 JSON-RPC runtime adapter without changing the local Task, identity, authority, Artifact or recovery ownership model.

Current branch implementation includes:

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

## Next gate

The Phase 4.1 full repository test gate must pass before this slice can be marked complete or Phase 4.2 can begin.
