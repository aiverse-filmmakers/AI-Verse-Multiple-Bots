# Phase 4 Status - Runtime and Agent Interoperability

**Updated:** 2026-09-12

**Phase:** 4

**Overall status:** IN PROGRESS

**Directional phase progress:** approximately 60%

This file is the implementation ledger for Phase 4. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 4 goal

Make durable Bots and temporary Workers portable across supported local and remote runtimes while preserving Multiple Bots protocol identity, authority, cancellation, provenance and recovery boundaries.

## Slice status

1. A2A adapter - **COMPLETE**
2. Hermes adapter - **COMPLETE**
3. OpenClaw adapter - **COMPLETE**
4. Codex/Claude Code process adapters where appropriate - **COMPLETE**
5. external managed Bot runtime - **COMPLETE**
6. remote-machine identity/authentication - **COMPLETE**
7. remote capability/environment leases - **NEXT**
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

## Slice 4.4 - Codex/Claude Code process adapters

**Implementation status:** COMPLETE

Phase 4.4 adds bounded local process execution for Codex and Claude Code while preserving Multiple Bots as the owner of identity, Task authority, budgets, cancellation and local Artifact publication.

Implemented:

- shared bounded `shell: false` child-process transport
- local cancellation, outer process deadlines and bounded TERM/KILL cleanup
- stdout-overflow kill escalation
- public `CodexExecRuntimeAdapter`
- temporary Codex harness cwd and ignored project/user instruction surfaces
- exact provider-scoped Codex workspace/web capabilities
- custom Codex filesystem permission profile and network denial
- explicit Codex feature narrowing
- MCP inventory preflight plus explicit server/orchestrator disable
- Codex JSONL result/usage parsing and post-run authority checks
- public `ClaudeCodePrintRuntimeAdapter`
- Claude Code safe + restricted print harness
- exact built-in Claude tool mapping
- no interactive permission widening
- strict empty MCP config plus MCP deny
- no Claude session persistence
- explicit host-managed-policy ownership marker
- durable Bot and temporary Worker identity preservation
- explicit rejection of later remote/auth/resume scope
- ordinary Gateway runtime registration

See `CODEX-CLAUDE-CODE-PROCESS-ADAPTERS.md`.

### 4.4 acceptance proof

The hardened implementation head `9783dca791881ca53265e116ec835e2552e0f43a` passed GitHub Actions **CI run 410 (`34715059115`) with 337/337 tests**, **0 failures, 0 canceled and 0 skipped**.

Phase 4.4 acceptance coverage proves:

1. Codex executes through one-shot JSONL `exec`
2. Codex project/user instruction/config surfaces are isolated for delegated work
3. Codex workspace access follows an explicit provider-scoped read/write lease
4. Codex network/web authority remains denied unless explicitly supported and leased
5. Codex MCP inventory is preflighted and every discovered server is explicitly disabled
6. Codex MCP/collaboration events fail closed after execution
7. Codex hidden reasoning is not published as the local result
8. Codex durable Bot and temporary Worker identity remain local
9. Claude Code executes through native print mode with safe + restricted boundaries
10. Claude Code receives only the exact leased built-in tool set
11. Claude Code zero-tool execution remains explicitly tool-less
12. Claude Code cannot widen delegated authority through permission prompts
13. Claude Code MCP is blocked through safe mode, strict empty config and explicit deny
14. Claude Code session persistence is disabled
15. Claude Code host-managed policy remains upstream rather than being misrepresented as Task authority
16. Claude Code usage/cost maps into the existing local usage contract
17. Claude Code durable Bot and temporary Worker identity remain local
18. remote/auth/resume fields are rejected rather than stealing later Phase 4 ownership
19. both adapters support exact local cancellation
20. shared process execution uses `shell: false`
21. process deadlines are bounded
22. stdout overflow cannot leave a SIGTERM-resistant child running
23. Gateway exposes `codex` and `claude-code` through the ordinary runtime registry
24. the complete pre-existing Phase 0-4.3 suite remains green

## Slice 4.5 - external managed Bot runtime

**Implementation status:** COMPLETE

Phase 4.5 adds a generic durable-Bot binding layer for long-lived externally managed runtime profiles without moving canonical Bot identity, Task authority, budgets, cancellation or Artifact ownership out of Multiple Bots.

Implemented:

- public `ExternalManagedBotRuntimeAdapter`
- explicit host-injected managed provider registry
- one-to-one durable local Bot -> external provider/profile binding
- stable binding fingerprint verification before and after execution
- global external binding uniqueness and archived binding reservation
- exact Task-scoped tool/connection authority
- mandatory provider authority audit after execution
- bounded structured execution envelope and output
- deterministic local-Task idempotency identity
- normalized provider failure boundary
- provider-independent local cancellation authority
- operator-only disabled-Bot rebind preserving canonical Bot identity
- manifest/runtime policy validation
- explicit durable-Bot-only boundary
- explicit rejection of Phase 4.6 remote auth fields
- explicit rejection of Phase 4.7 external environment leases
- ordinary Gateway runtime/provider registration

See `EXTERNAL-MANAGED-BOT-RUNTIME.md`.

### 4.5 acceptance proof

The hardened implementation head `c88082c677e291baf359b37acb21316b2be2f0a5` passed GitHub Actions **CI run 421 (`34716643438`) with 355/355 tests**, **0 failures, 0 canceled and 0 skipped**.

Phase 4.5 acceptance coverage proves:

1. durable Bots can execute through an injected long-lived managed provider
2. Multiple Bots Bot identity remains canonical
3. live external profile identity/fingerprint is checked before execution
4. fingerprint is checked again after execution
5. provider identity/authority/output/cancellation contract drift fails closed
6. exact local tool/connection authority is supplied to the provider
7. broad wildcard/group/glob authority fails closed
8. provider-observed authority must be explicitly reported
9. observed authority outside the local lease fails closed
10. local Task identity becomes the provider idempotency key
11. provider output/usage maps into the existing local result/budget contract
12. receipts exclude managed refs/fingerprints, authority names and copied host context
13. arbitrary provider errors are normalized instead of leaking opaque provider state
14. provider registration is explicit and duplicate-safe
15. one external provider/ref or provider/fingerprint cannot back multiple canonical Bots
16. binding uniqueness spans workspaces and archived bindings remain reserved
17. operator rebind preserves local Bot identity and requires the Bot to be disabled
18. rebind cannot steal another Bot binding and rechecks live work
19. external-managed manifest and execution policy are structurally validated
20. temporary Workers cannot masquerade as persistent external managed Bots
21. external environment leases are rejected until Phase 4.7
22. provider cancel is issued at most once
23. provider cancel failure cannot reverse local cancellation
24. local cancellation settles even when a provider ignores AbortSignal
25. the Gateway exposes `external-managed` and the provider registry
26. the operator rebind HTTP boundary is functional
27. the complete pre-existing Phase 0-4.4 suite remains green

## Slice 4.6 - remote-machine identity/authentication

**Implementation status:** COMPLETE

Phase 4.6 adds a host-neutral remote trust/authentication boundary and integrates it with A2A without moving local coordination identity, Task authority, secrets or remote lease ownership.

Implemented:

- stable HTTPS remote-machine identity registry
- pinned peer identity with stronger host-attested modes
- no-TOFU duplicate/ambiguity guards
- host-injected authenticator registry
- opaque credential references
- built-in Bearer and header API-key authenticator
- public-discovery credential separation
- exact-origin and redirect protection
- normalized A2A security requirements
- required-scheme and required-scope verification
- authenticated A2A RPCs through one pinned trust boundary
- custom OAuth2/OIDC/mTLS/SPIFFE transport surface
- strict authentication evidence validation
- sanitized provider failures
- cancellation independent of authenticator compliance
- bounded non-secret auth provenance
- Gateway trust/auth registry injection

See `REMOTE-MACHINE-IDENTITY-AUTH.md`.

### 4.6 acceptance proof

The hardened implementation head `a2fcd4736f37d832c9240476c5b77efa01e462d4` passed GitHub Actions **CI run 438 (`34717863491`) with 375/375 tests**, **0 failures, 0 canceled and 0 skipped**.

Phase 4.6 acceptance coverage proves:

1. remote machine ids bind to exact HTTPS origins and peer identities
2. duplicate/ambiguous machine identities fail closed
3. raw inline credentials remain forbidden
4. opaque credential handles remain host-owned
5. public Agent Card discovery does not leak built-in Bearer/API-key credentials
6. authenticated requests cannot redirect
7. Agent Card interfaces cannot move credentials cross-origin
8. undeclared auth schemes fail before credential use
9. Bearer and header API-key schemes work through declared A2A requirements
10. protected header takeover fails
11. stronger SPIFFE/mTLS-style peer identities are host-attestable
12. plain fetch cannot falsely claim stronger identity verification
13. machine, origin, peer, TLS and client-auth evidence are verified
14. OAuth-style required scopes must be explicitly proven
15. malformed evidence fails with controlled errors
16. opaque provider failures cannot leak raw provider error details
17. cancellation settles even if an authenticator ignores AbortSignal
18. authenticated A2A preserves local durable Bot/temporary Worker identity
19. authenticated A2A cancellation uses the same pinned machine/auth boundary
20. A2A receipts contain bounded auth provenance and no credential material/reference
21. Gateway exposes host-injected remote trust/auth registries
22. the complete pre-existing Phase 0-4.5 suite remains green

## Next gate

**Phase 4.7 - remote capability/environment leases.**

Phase 4.6 is complete. Phase 4.7 has not started.
