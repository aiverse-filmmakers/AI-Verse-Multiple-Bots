# Phase 4 Status - Runtime and Agent Interoperability

**Updated:** 2026-09-12

**Phase:** 4

**Overall status:** IN PROGRESS

**Directional phase progress:** approximately 30%

This file is the implementation ledger for Phase 4. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 4 goal

Make durable Bots and temporary Workers portable across supported local and remote runtimes while preserving Multiple Bots protocol identity, authority, cancellation, provenance and recovery boundaries.

## Slice status

1. A2A adapter - **COMPLETE**
2. Hermes adapter - **COMPLETE**
3. OpenClaw adapter - **COMPLETE**
4. Codex/Claude Code process adapters where appropriate - **NEXT**
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


## Slice 4.2 - Hermes adapter

**Implementation status:** COMPLETE

Phase 4.2 adds local Hermes Agent execution through the documented TUI Gateway stdio JSON-RPC protocol without changing local coordination identity or pulling remote authentication/reconnect scope forward.

Implemented:

- public `HermesStdioRuntimeAdapter`
- isolated local TUI Gateway subprocess/session per Task
- live built-session capability inspection before prompt submission
- exact Hermes tool-function containment within the local capability lease
- no persistent Hermes profile tool mutation
- manual-approval + YOLO-off requirement
- fail-closed approval/clarification/sudo/secret/vault interaction handling
- structured Bot/Worker execution envelope
- exact-session completion and cancellation routing
- usage/budget mapping
- bounded content-free provenance
- tested newline JSON-RPC stdio process transport
- ordinary Gateway runtime registration
- explicit rejection of Phase 4.6 remote/auth configuration

See `HERMES-RUNTIME-ADAPTER.md`.

### 4.2 acceptance proof

The exact implementation head `9bfbbcb2b8ea022310bd1d6695742e8d9613bea4` passed GitHub Actions **CI run 394 (`34710676926`) with 304/304 tests**, **0 failures, 0 canceled and 0 skipped**.

Phase 4.2 acceptance coverage proves:

1. Hermes executes through its documented TUI Gateway JSON-RPC stdio contract
2. durable Bot identity remains the local execution principal
3. temporary Worker identity remains temporary and is never promoted
4. live Hermes tools must fit inside the local capability lease before prompt submission
5. exact and explicit `hermes:<tool>` capability references work without wildcard expansion
6. YOLO/non-manual approval modes fail before delegated work
7. runtime interaction requests are never auto-approved
8. Hermes runtime errors cannot become successful local Artifacts
9. remote/auth configuration is rejected rather than stealing Phase 4.6 ownership
10. local cancellation targets the exact Hermes session
11. the stdio parser uses newline JSON-RPC and `shell: false`
12. receipts exclude copied execution context and live tool names
13. usage is mapped into the existing budget contract
14. the Gateway exposes `hermes` through the ordinary runtime registry
15. the complete pre-existing Phase 0-4.1 suite remains green

## Slice 4.3 - OpenClaw adapter

**Implementation status:** COMPLETE

Phase 4.3 adds local OpenClaw execution through its documented one-shot `agent exec` interface while preserving Multiple Bots identity/authority ownership and leaving long-running Gateway authentication/reconnect concerns to later Phase 4 slices.

Implemented:

- public `OpenClawAgentExecRuntimeAdapter`
- one-shot `openclaw agent exec --json` process execution
- active config discovery or explicit pinned local config
- temporary read-only root-include config overlay
- exact global `tools.allow` derived from the local capability lease
- no operator config mutation
- exact tool names only; group/glob/wildcard grants rejected
- restrictive zero-tool sentinel
- post-run tool-summary containment verification
- durable Bot and temporary Worker identity preservation
- structured runtime execution envelope
- stable result and usage/budget translation
- bounded process cancellation and process deadline
- bounded content-free provenance
- `shell: false` child execution
- explicit rejection of Phase 4.6 remote/Gateway auth configuration
- ordinary Gateway runtime registration

See `OPENCLAW-RUNTIME-ADAPTER.md`.

### 4.3 acceptance proof

The hardened implementation head `51d06d08b0c7e053c750dbfa3c2fc49be62eae02` passed GitHub Actions **CI run 401 (`34711466346`) with 318/318 tests**, **0 failures, 0 canceled and 0 skipped**.

Phase 4.3 acceptance coverage proves:

1. OpenClaw executes through its documented one-shot `agent exec` contract
2. durable Bot identity remains the local execution principal
3. temporary Worker identity and Team Run lineage remain local/temporary
4. operator config is included but never rewritten
5. exact local lease tools become a restrictive global OpenClaw allowlist
6. explicit `openclaw:<tool>` names work without widening authority
7. groups, globs and wildcards fail closed
8. zero-tool leases remain restrictive
9. reported tool use is checked against the local lease after execution
10. error/timeout/malformed results cannot become successful local Artifacts
11. config symlinks are rejected
12. local cancellation aborts the exact child process
13. child execution uses `shell: false`
14. local process hangs have an explicit bounded deadline
15. config discovery uses the documented OpenClaw CLI surface
16. receipts exclude operator config paths, tool names and copied execution context
17. remote/Gateway auth configuration is rejected rather than stealing Phase 4.6 ownership
18. the Gateway exposes `openclaw` through the ordinary runtime registry
19. the complete pre-existing Phase 0-4.2 suite remains green

## Next gate

**Phase 4.4 - Codex/Claude Code process adapters where appropriate.**

Phase 4.3 is complete. Phase 4.4 has not started.
