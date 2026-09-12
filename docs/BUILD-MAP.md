# AI-Verse Multiple Bots - Build Map

**Updated:** 2026-09-13

This is the canonical progress map for the project. Update it whenever a meaningful implementation slice lands so repository state alone shows where the build is, what is complete, and what remains.

## Definition of finished

The first complete product release is reached when Phases 0 through 5 below are complete and the release acceptance suite passes.

The target is an installable persistent-teammate layer that can run standalone or attach to AI-Verse OS, host durable Bots, let them communicate and collaborate safely, create temporary multi-agent squads when useful, interoperate with external runtimes, and expose the system to Dashboard/omnichannel clients without becoming a second source of domain truth.

## Current position

```text
Phase 0  Research + Architecture        [COMPLETE]    100%
Phase 1  Runnable Coordination Core     [COMPLETE]    100%
Phase 2  Dynamic Multi-Agent Squads     [COMPLETE]    100%
Phase 3  AI-Verse Native Integration    [COMPLETE]    100%
Phase 4  Runtime / A2A Interoperability [IN PROGRESS] ~80%
Phase 5  Product + Install + Dashboard  [NOT STARTED]
```

**Directional overall first-release progress:** roughly 95% complete.

That overall figure is intentionally approximate because later phases contain different amounts of work. Passed phase gates, not percentages, are authoritative.

## Phase 0 - Research + Architecture

**Status:** COMPLETE

Completed:

- Grok Bot and Grok Multi-Agent architecture research
- Hermes Bot Mode study
- Microsoft Agent Framework orchestration patterns
- A2A / OpenAI Agents / OpenClaw / AgentScope / Pydantic AI and related benchmark research
- canonical persistent-teammate architecture
- Coordination Protocol v1.1
- AI-Verse layer boundaries
- schemas and Bot/Room templates
- implementation roadmap

## Phase 1 - Runnable Coordination Core

**Status:** COMPLETE

**Completion evidence:** GitHub Actions run 102 on 2026-09-09 passed **54/54 tests** at commit `73706c40ddc6249a755655b889aff68240d016aa`.

Completed foundation:

- Node.js + TypeScript package, CLI, localhost Gateway, build/test CI
- SQLite coordination/object store and append-only ordered event substrate
- persistent Bots, Messages, Tasks, Handoffs, Artifacts, Approvals and leases
- asynchronous mailbox and persistent execution queue
- atomic multi-object/event/queue mutations and idempotency
- durable Bot registry, address resolution and lifecycle guards
- runtime-neutral adapter registry plus zero-dependency OpenAI-compatible HTTP adapter
- environment-handle credentials; raw manifest secrets rejected
- Task -> runtime -> Artifact execution with capability/environment validation
- execution leases, heartbeats, cancellation, deadlines, budgets, dead letters and restart recovery
- explicit delegation, inherited immutable constraints, root-objective lineage and hop/task ceilings
- accepted Handoff ownership/lease/approval/queue mutation with fail-closed claimed execution
- Rooms, Threads, mentions, bounded scheduling and result publication
- workspace isolation, loop/no-progress protection and approval enforcement

### Phase 1 completion gate

**PASSED.**

Two persistent Bots independently exist, communicate asynchronously, delegate actual work, transfer responsibility safely, collaborate in a Room/Thread, execute through a real runtime adapter, respect policy/limits/approvals, recover from Gateway restart, and cancel/fail without losing coordination integrity.

## Phase 2 - Dynamic Multi-Agent Squads

**Status:** COMPLETE

**Current phase progress:** 100%.

**Completion verification:** the hardened Phase 2.12 PR-head package suite passed **175/175 tests** with **0 failures, 0 canceled, and 0 skipped** on GitHub Actions run 248. Post-merge `main` CI run 251 also passed the full 175-test suite.

Goal achieved: a durable Bot decides whether to work alone or create bounded temporary Workers, coordinates them through the topology justified by the work, detects/verifies material disagreement, returns one canonical result, and enforces a shared run-wide safety contract without turning temporary helpers into durable identities.

### Phase 2 slices

1. Team Run object and lifecycle - **COMPLETE**
2. temporary Worker identities and bounded lifecycle - **COMPLETE**
3. Worker execution + manager/supervisor topology - **COMPLETE**
4. bounded parallel fan-out - **COMPLETE**
5. direct handoff topology - **COMPLETE**
6. bounded group/discussion topology - **COMPLETE**
7. structured disagreement detection - **COMPLETE**
8. verifier/critic role - **COMPLETE**
9. canonical synthesis - **COMPLETE**
10. Worker cleanup hardening - **COMPLETE**
11. adaptive `single Bot vs squad` decision policy - **COMPLETE**
12. squad-wide budget/cancellation consolidation - **COMPLETE**

### Phase 2 capabilities

#### Team Run + temporary identity

- canonical Team Run records and explicit lifecycle
- active durable Bot leader and same-workspace enforcement
- run-scoped `worker_*` identities that never enter the durable Bot registry
- no default Worker Room membership or long-term memory authority
- leader-only Worker lifecycle control and `can_create_workers` enforcement
- Worker Task binding and bounded identity capacity
- restart-persistent Team Run/Worker state and retained audit records

#### Worker execution + manager topology

- common Bot/Worker execution-principal contract
- Worker-aware event-driven supervisor
- Worker runtime inheritance with bounded run overrides
- capability/environment lease validation
- `worker_generated` Artifact provenance
- race-safe Worker + lease + Task preparation
- no authority expansion through Worker grants
- aggregate Team Run usage enforcement
- cancellation, deadlines and retry-safe recovery

#### Parallel fan-out

- bounded `parallel_panel`, `dynamic_squad`, and `hybrid` fan-out
- central concurrency ceiling and scheduling-time Worker/Task limits
- reservation-safe token/cost/action allocation before parallel execution
- independent Tasks, leases, contexts and Artifacts
- `all`, `first_success`, and bounded quorum joins
- partial-failure evidence preservation and remainder cancellation
- durable activation/recovery and cross-process compare-and-swap hardening

#### Direct handoff

- canonical Handoff-based Worker -> Worker and Worker -> durable Bot transfer
- no Worker promotion
- root/workspace/constraint preservation
- capability/environment authority reissue and Approval retargeting
- claimed/running fail-closed behavior
- mixed-principal hop and ownership-loop limits
- run-wide cancellation reaches durable-Bot-owned transferred work
- accepted transfer survives restart
- explicit return/stay ownership settlement

#### Bounded group/discussion

- temporary Room/Thread discussion without durable Worker membership
- explicit speaker/round plan and reusable nonterminal Worker participants
- Worker/message/round/Task ceilings
- turn-scoped capability leases
- prior candidate Artifact context with actual Worker provenance
- exact temporary-room publication authorization
- deterministic setup/thread/message settlement and restart-safe reconciliation

#### Structured disagreement + verifier

- deterministic structured-claim comparison without storing hidden reasoning
- evidence/constraint/recommendation/estimate/confidence conflict detection
- deterministic `disagreement_report` Artifacts and persistent verification debt
- bounded temporary verifier work only when debt warrants it
- canonical `verification_verdict` Artifacts
- scoped evidence, inherited authority/environment policy and no cross-run clearance
- cancellation/failure preserves unresolved debt; restart settlement is idempotent

#### Canonical synthesis

- durable Team Run leader performs final synthesis without another Worker identity
- unresolved verification debt/live temporary work blocks finalization
- bounded same-run canonical evidence set
- untrusted runtime draft must pass `synthesis-final-v1`
- deterministic immutable `synthesis_final` Artifact
- atomic `final_artifact_ref` + run completion
- late work, cancellation and aggregate budget exhaustion cannot be hidden by final settlement
- completed-but-unreconciled synthesis survives restart

#### Worker cleanup

- host-neutral `TeamRunCleanup`
- terminal temporary identity expiry without durable registry mutation
- transient capability/run-exclusive environment authority revocation
- genuinely shared environment preservation
- residual queue/Approval/mailbox cleanup while preserving audit objects
- temporary Room/Thread closure without deleting Messages/Artifacts/provenance
- stale discussion-opening reaping through explicit lifecycle tags
- idempotent startup/recovery cleanup

#### Adaptive collaboration decision policy

- host-neutral `TeamRunDecisionPolicy`
- simple linear work remains single-Bot
- minimum justified supported topology selected from structured work signals
- cumulative Worker/Task/concurrency/message/round/verifier/handoff capacity planning
- tool/connection authority cannot exceed leader permissions
- root objective, workspace, constraints, approval requirement and budget preserved
- deterministic decision Artifact/run IDs
- compatible run reuse and duplicate-root-objective loop prevention
- atomic/restart-safe decision settlement

#### Squad-wide budget/cancellation control

- public host-neutral `TeamRunControl`
- one aggregate Team Run budget snapshot across every supported topology
- token, cost, action, Task, Worker, hop, message and round ceilings
- absolute run wall-clock deadline from Team Run creation
- pre-claim queued-work guard and runtime deadline propagation
- running-work abort at the run deadline
- durable Team Run leader can hierarchically cancel any same-run participant-owned Task
- cancellation/budget exhaustion fences the Team Run before execution drain
- pending Approvals, active Handoffs and queue work become non-actionable
- active capability and run-exclusive environment authority are revoked without overwriting prior independent revocation attribution
- shared environments are preserved only while referenced outside the run
- temporary Rooms/Threads close and active topology pointers clear
- terminal dead-letter retry/topology reconciliation cannot resurrect execution
- startup recovers pending termination before topology recovery or queue drain
- termination audit summaries are idempotent and preserve already-applied evidence

### Phase 2 completion gate

**PASSED.**

The package proves the complete host-neutral squad lifecycle: adaptive single-vs-squad selection, manager/fan-out/handoff/discussion coordination, structured disagreement, selective verification, canonical synthesis, shared run-wide budget/cancellation control, restart recovery and evidence-preserving cleanup.

**Final code gate:** 175 tests passed, 0 failed, 0 canceled, 0 skipped.

### Phase 2 remaining work

None.

## Phase 3 - AI-Verse Native Integration

**Status:** COMPLETE

**Directional phase progress:** 100%.

Goal: attach the finished host-neutral teammate/squad package to AI-Verse OS without moving or duplicating canonical OS/Brain/Memory/Skills state into this repository.

### Phase 3 slices

1. AI-Verse OS installer/registration contract - **COMPLETE**
2. workspace-scoped state projection - **COMPLETE**
3. Brain initiative/goal ingress - **COMPLETE**
4. Memory context/recall adapter - **COMPLETE**
5. Skills capability resolution - **COMPLETE**
6. Automations wake/schedule integration - **COMPLETE**
7. OS write-command boundary - **COMPLETE**
8. candidate knowledge/decision write-back - **COMPLETE**
9. 4Cs health integration - **COMPLETE**
10. uninstall/upgrade without canonical-state damage - **COMPLETE**

### Phase 3.1 - AI-Verse OS installer/registration contract

Implemented:

- public `aiVerseOsRegistrationAdapter`
- fail-closed AI-Verse OS v2 + `unified-workspace` compatibility detection
- stable local extension-hook verification
- canonical extension manifest and AI-Verse OS task instructions
- registration through `.aiverse/extensions/registry.json` only
- no tracked AI-Verse OS file mutation and no implicit `agents/registry.yaml` changes
- unknown registry/extension/entry-field preservation
- user-disabled-state preservation across reinstall
- relative-path, traversal, absolute-path, NUL and symlink safety
- installed instruction/engine/adapter verification before registration
- exclusive registry lock and unexpected-change detection to prevent silent lost updates
- atomic, byte-stable, idempotent registration
- CLI `os detect`, `os plan`, `os register`
- explicit separation of registration from health, permission, approval and workspace authorization

**Verified code gate:** GitHub Actions run 258 passed **184/184 tests**, with 0 failures, 0 canceled and 0 skipped.

See `docs/PHASE-3-STATUS.md` and `docs/AI-VERSE-OS-REGISTRATION-CONTRACT.md`.

### Phase 3.2 - workspace-scoped state projection

Implemented:

- host-neutral `WorkspaceStateProjector` runtime contract plus public `AiVerseOsWorkspaceProjector`
- live AI-Verse OS v2 workspace resolution through `AI-VERSE.yaml` and `WORKSPACE.yaml`
- exact workspace identity and active-state enforcement
- bounded projection of workspace identity, boundaries and declared current-context sections only
- strict relative-path, traversal, absolute-path, NUL, symlink, source-size, list and section ceilings
- execution-time compatibility revalidation so host drift fails closed
- no projection cache; canonical host edits are visible on the next execution
- common runtime projection path for durable Bots and temporary Workers
- OpenAI-compatible runtime receives host context as explicit read-only input
- Artifact receipts persist only provider/schema/workspace/source refs and SHA-256 digests, never copied workspace text
- explicit `serve --os-root PATH` native mode; standalone mode remains unchanged when omitted
- invalid explicit host configuration is rejected before coordination-state allocation

**Verified code gate:** GitHub Actions run 271 passed the full **192/192 tests** with 0 failures.

See `docs/PHASE-3-STATUS.md` for the detailed acceptance proof.

### Phase 3.3 - Brain initiative/goal ingress

Implemented:

- public `AiVerseBrainObjectiveSource`, `BrainObjectiveIngress` and runtime freshness adapter
- explicit AI-Verse Brain registration/install validation and exact workspace direction-owner gate
- bounded objective/initiative/intent projection with strict path/scope/source limits
- fresh ingress from `READY` objectives only
- deterministic semantic Brain root objective encoded with SHA-256 intent digest
- lifecycle-only revisions preserve root identity; material strategic edits invalidate old execution
- immutable Brain constraints/boundaries/stop conditions carried into Task execution
- deterministic idempotent Task/capability-lease/Approval settlement
- requested execution authority cannot exceed durable leader grants
- exact request-contract digest prevents deadline/hop/lease/reason/Approval drift on re-ingress
- execution-time Brain re-read before durable-Bot or temporary-Worker runtime execution
- revoked ownership, Brain disablement, canceled/superseded objective, invalid parent or semantic drift fails before successful Artifact publication
- runtime-only strategic intent injection with provenance-only persistence
- native Gateway Brain-objective ingress command; standalone mode remains independent

**Final PR-head verification:** GitHub Actions run 295 passed the full **202/202 tests** with 0 failures, 0 canceled and 0 skipped on exact head `1fef1af59a167ce413899cc3e2b81bc692e86e05`. Phase 3.3 was squash-merged as `1945b45c99fc4ce10060156d3f4ebff912bfcbf4`, and post-merge `main` CI run 296 also passed **202/202**.

See `docs/AI-VERSE-BRAIN-OBJECTIVE-INGRESS.md` and `docs/PHASE-3-STATUS.md`.

### Phase 3.4 - Memory context/recall adapter

Implemented:

- host-neutral explicit historical-recall runtime contracts for durable Bots and temporary Workers
- public `AiVerseMemoryRecallSource` native adapter and `MemoryRecallRuntimeRegistry`
- lazy AI-Verse Memory v0.2+ native-install compatibility gate
- shell-free structured Python bridge into the installed Memory engine rather than direct SQLite ownership
- exact workspace-scoped recall: selected workspace plus operator context only
- no cross-workspace recall surface in the Phase 3.4 Task contract
- bounded query/result/subprocess/item/aggregate output limits
- strict canonical Memory source-root ownership validation, including path-kind-scope matching
- symlink/escape-safe Memory installation and source-path validation
- source identity/version/freshness validation plus post-recall canonical source revalidation
- historical recall injected only when a Task explicitly requests it
- recalled text remains ephemeral runtime context; persisted receipts contain provenance and digests only
- current OS/Brain context and hard Task/lease/Approval authority explicitly outrank historical recall
- no Memory write/supersede/forget/promotion authority introduced
- normalized HTTP delegation and managed-Worker propagation through the same common runtime path
- explicit recall fails closed when Memory is unavailable/incompatible; ordinary no-recall work remains standalone-safe

**Verified hardening gate:** GitHub Actions run 345 passed the full **221/221 tests** with 0 failures, 0 canceled and 0 skipped on exact branch head `f2112055bd1771d75dbe5c720ffac70d83604590`. Platform Smoke run 8 also passed on the same head. This gate includes the dedicated canonical-source ownership, path-kind and symlinked-install hardening tests.

See `docs/AI-VERSE-MEMORY-RECALL.md` and `docs/PHASE-3-STATUS.md`.

### Phase 3.5 - Skills capability resolution

Implemented:

- host-neutral `SkillsCapabilitySource` / `SkillsCapabilityProjection` runtime contracts
- public `AiVerseSkillsCapabilitySource` using the AI-Verse OS-owned capability resolver rather than reading the Skills registry directly
- explicit bounded Task `skill_refs` with bare, qualified-provider and exact-workspace references
- durable Bot declaration checks at Task creation and again immediately before runtime resolution
- temporary Worker explicit-subset propagation for manager, fan-out, discussion and verifier flows with no automatic leader-skill inheritance
- explicit synthesis skill requirements on the durable Team Run leader
- AI-Verse Brain ingress skill requirements bound into the exact ingress contract digest
- progressive disclosure of selected `SKILL.md` instructions only when a Task explicitly requests them
- exact workspace-scope and qualified-ID binding
- package digest verification before and after instruction load, plus resolver/package symlink and containment safety
- runtime-only skill instructions with persisted provider/generation/package/instruction provenance digests only
- handoff preservation of Task skill requirements without widening capability leases or Approval state
- explicit unavailable/degraded/integrity failure semantics
- standalone ordinary Tasks remain independent; explicit skill dependency fails closed without a resolver source
- model-runtime authority ordering that treats skills as method instructions, never permission grants

**Verified implementation gate:** GitHub Actions run 34515699163 passed the full **242/242 tests** with 0 failures, 0 canceled and 0 skipped on exact code head `348cb30b16da5d5145e4599241702fd01b135648`.

See `docs/AI-VERSE-SKILLS-CAPABILITY-RESOLUTION.md` and `docs/PHASE-3-STATUS.md`.

### Phase 3.6 - Automations wake/schedule integration

Implemented:

- host-neutral automation invocation projection/source contract plus native `AiVerseOsAutomationInvocationSource`
- receive-side `AutomationWakeIngress` rather than a competing scheduler
- native `POST /v1/automations/invoke` command boundary
- exact active-workspace validation through the canonical workspace projector
- canonical shared job/trigger and exact-workspace automation source containment
- exact source SHA-256 binding with source-change/removal retry kill fencing
- deterministic invocation identity and exact request-contract digest
- idempotent duplicate delivery with cross-mode and semantic-drift conflict detection
- durable Bot wakes through the existing Task, policy, capability-lease, Approval, queue and recovery boundaries
- explicit Bot target activity/workspace/authority enforcement
- bounded Team Run creation with no automatic Task/lease/Approval/Worker authority
- mandatory Team Run worker/task/action/wall-clock/hop bounds
- explicit rejection of Task-only execution fields on Team Run creation
- unresolved Team Run start approval fails closed to the owning OS automation layer
- provenance-only persistence; automation definition text and cadence state remain OS-owned
- standalone coordination remains unchanged and exposes no implicit scheduler

**Verified implementation gate:** GitHub Actions run 34518046084 passed the full **254/254 tests** with 0 failures, 0 canceled and 0 skipped on exact code head `f94daaa9cc98f5356d8a77d90905867ac0034528`.

See `docs/AI-VERSE-AUTOMATION-WAKE-SCHEDULE.md` and `docs/PHASE-3-STATUS.md`.

### Phase 3.7 - OS write-command boundary

Implemented:

- AI-Verse OS owner-side write-command contract merged through OS PR #16
- public Multiple Bots `OsWriteCommandBoundary` and `OsWriteCommandSink`
- native `AiVerseOsWriteCommandSink` consuming the OS-owned module rather than writing canonical files
- additive host capability detection so older compatible OS hosts retain existing behavior
- native `POST /v1/os/write-commands` surface
- exact Bot/Worker and operator/workspace scope enforcement
- temporary Workers cannot widen into operator-scoped writes
- bounded Task/Run/Artifact provenance validation
- deterministic command identity and SHA-256 immutable request binding
- 128 KiB request-envelope ceiling
- shell-free host invocation with request body over stdin
- strict host receipt validation at the generic boundary
- exact replay recontacts the OS owner because OS runtime queues are disposable
- semantic drift under the same idempotency identity fails before host dispatch
- local Multiple Bots receipt Artifact persists provenance/digests only, never the write payload
- accepted host receipt must prove no canonical effect occurred
- no direct operator/workspace/knowledge/decision/Memory/Skills canonical write path introduced
- calendar-drift hardening for an older Brain ingress acceptance fixture

**Verified implementation gate:** GitHub Actions run 34655489289 passed the full **263/263 tests** with 0 failures, 0 canceled and 0 skipped on exact hardened head `1a823c0f0885c455d8e5a44c2ede29f45fac1864`.

See `docs/AI-VERSE-OS-WRITE-COMMAND-BOUNDARY.md` and `docs/PHASE-3-STATUS.md`.

### Phase 3.8 - candidate knowledge/decision write-back

Implemented:

- public host-neutral `CandidateWritebackRouter` for explicit `knowledge` and `decision` candidates
- exact workspace-scoped source Artifact requirement plus bounded same-workspace evidence references
- candidate routing through the existing Phase 3.7 `candidate.route` OS owner boundary
- explicit `canonical_effect_requested: false` and owner-side `evaluate_for_promotion` semantics
- no direct workspace knowledge/decision mutation and no local duplicate candidate-content record
- durable persistence remains the Phase 3.7 digest/provenance-only `os_write_command_receipt`
- exact replay recontacts the owner queue while semantic drift fails before changed owner dispatch
- active durable Bots and temporary Workers can nominate without authority expansion
- native `POST /v1/candidates/write-back` only when the Phase 3.7 OS owner contract exists
- Memory, Skills, Brain and current-context write-back remain outside this slice

**Verified implementation gate:** GitHub Actions CI run 375 (`34708621932`) passed **270/270 tests** with 0 failures, 0 canceled and 0 skipped on exact implementation head `70ab433f73831ead8d9b43d0f4efc8a99938c7b8`.

See `docs/AI-VERSE-CANDIDATE-WRITEBACK.md` and `docs/PHASE-3-STATUS.md`.

### Phase 3.9 - 4Cs health integration

Implemented:

- public read-only `FourCsHealthProjector` using the canonical AI-Verse OS Four Cs terminology: Context, Connections, Capabilities and Cadence
- explicit evidence states `verified`, `degraded`, `unknown` and `not_applicable`
- native workspace Context health probes through the existing Phase 3.2 canonical workspace projector
- health output exposes bounded metrics and evidence only, never projected workspace text, Memory recall text, Brain intent, Skill instructions, automation definitions or Artifact content
- prior workspace, Brain, Memory and Skills runtime receipts are counted as bounded execution evidence without copying their payload content
- connection grants are never treated as proof of live external access
- Skill-dependent work without an available resolver is degraded rather than falsely healthy
- configured integrations without successful operation remain unknown rather than verified
- Phase 3.6 automation-ingressed Tasks and Team Runs provide bounded Cadence evidence while AI-Verse OS remains the scheduler owner
- deterministic coordination-core evidence includes store doctor state, dead letters, Bots, Workers, Team Runs, Tasks, Artifacts and pending Approvals
- integration availability is projected separately from operational evidence
- AI-Verse OS `/audit` remains the canonical health/scoring/finding-lifecycle authority
- Multiple Bots assigns no Four Cs score and writes no OS health state
- additive `GET /v1/health/4cs` endpoint with optional exact workspace scope
- existing `GET /health` contract remains unchanged
- invalid workspace health scopes fail without coordination mutation

**Verified implementation gate:** GitHub Actions CI run 380 (`34709083183`) passed the full **281/281 tests** with 0 failures, 0 canceled and 0 skipped on exact implementation head `d7a44a19dfb5741509692e41b2ded14566f4c898`.

See `docs/AI-VERSE-FOUR-CS-HEALTH.md` and `docs/PHASE-3-STATUS.md`.

### Phase 3.10 - uninstall/upgrade without canonical-state damage

Implemented:

- public `planAiVerseOsUpgrade()` and `upgradeAiVerseOsExtension()`
- public `planAiVerseOsUninstall()` and `uninstallAiVerseOsExtension()`
- upgrade requires an existing registry entry provably owned by Multiple Bots
- foreign same-key registrations fail closed instead of being converted or deleted
- upgrade preserves user-disabled state, unrelated extension entries, unknown registry fields and unknown own-entry metadata
- upgrade reuses the existing compatibility, installed-file verification, registry lock and atomic replace contract
- uninstall removes the owned Multiple Bots registry entry before bounded file cleanup
- automatic file removal is limited to registered regular files inside `.aiverse/extensions/ai-verse-multiple-bots/`
- registered paths outside the extension root are preserved and reported
- unknown/unregistered extension-root files are never recursively scavenged
- symlinked lifecycle paths fail before registry mutation
- repeated uninstall after registration removal is a no-op and does not search for leftovers
- `runtime/ai-verse-bots/coordination.db` is preserved
- canonical OS/operator/workspace/knowledge/decision/Brain/Memory/Skills/Automation state remains untouched
- additive CLI `os upgrade-plan`, `os upgrade`, `os uninstall-plan`, and `os uninstall`
- Phase 5 remains responsible for final package download/materialization and clean-machine installer behavior

**Verified implementation gate:** GitHub Actions CI run 384 (`34709530708`) passed the full **287/287 tests** with 0 failures, 0 canceled and 0 skipped on exact implementation head `eb41d3f690590dd0e2cefd739109058ee5a3eae6`.

See `docs/AI-VERSE-UPGRADE-UNINSTALL-SAFETY.md` and `docs/PHASE-3-STATUS.md`.

### Phase 3 boundary

Phase 3 work is additive through explicit host adapters. AI-Verse OS remains canonical for operator/workspace/domain state, capability-provider resolution and automation cadence. AI-Verse Brain remains canonical for strategic intent and objective lifecycle. AI-Verse Memory remains canonical for historical memory and its rebuildable derived index. AI-Verse Skills remains canonical for reusable capability packages and immutable generations. Multiple Bots remains canonical for coordination state created after a bounded host invocation. Host, Brain, Memory, selected Skills and automation invocation projections are scoped views, not competing truth.

Production one-command package materialization is still a Phase 5 product responsibility; Phase 3.1 defines safe host registration after extension-owned files exist, and Phase 3.10 defines safe lifecycle mutation after materialization.

### Phase 3 completion gate

**PASSED.**

AI-Verse native integration now covers safe registration, exact workspace projection, Brain ingress, Memory recall, Skills capability resolution, Automations invocation ingress, owner-controlled OS write requests, candidate write-back, read-only Four Cs health evidence, and bounded upgrade/uninstall behavior without moving canonical domain ownership into Multiple Bots.

**Final Phase 3 code gate:** 287 tests passed, 0 failed, 0 canceled, 0 skipped.

## Phase 4 - Runtime and Agent Interoperability

**Status:** IN PROGRESS

**Directional phase progress:** approximately 70%.

Goal: make durable Bots/temporary Workers portable across supported local and remote runtimes while preserving protocol identity, authority, cancellation, provenance and recovery.

### Phase 4 slices

1. A2A adapter - **COMPLETE**
2. Hermes adapter - **COMPLETE**
3. OpenClaw adapter - **COMPLETE**
4. Codex/Claude Code process adapters where appropriate - **COMPLETE**
5. external managed Bot runtime - **COMPLETE**
6. remote-machine identity/authentication - **COMPLETE**
7. remote capability/environment leases - **COMPLETE**
8. retry/disconnect/reconnect semantics - **NEXT**
9. compatibility/evaluation suite - **NOT STARTED**

### Phase 4.1 - A2A adapter

Implemented:

- public host-neutral `A2AJsonRpcRuntimeAdapter` with runtime id `a2a`
- fresh A2A v1.0 Agent Card discovery on each execution
- ordered selection of a `JSONRPC` interface with `protocolVersion: "1.0"`
- deterministic A2A `messageId` derived from the local Task id
- structured execution envelope preserving local Bot/Worker identity, workspace, Task constraints, expected output, capability/environment lease authority, host context, selected Skills and input Artifacts
- `SendMessage` execution with early remote Task return, bounded `GetTask` polling and completed Task Artifact translation
- direct A2A Message response translation into a normal local runtime result
- local cancellation that best-effort sends remote `CancelTask` without letting remote latency or failure block local cancellation
- explicit handling of completed, failed, canceled, rejected, input-required and auth-required remote Task states
- required A2A authentication, required protocol extensions and unsupported protocol bindings/versions fail closed
- application/json input preferred with text/plain structured-envelope fallback
- JSON-RPC request/response id validation and bounded Agent Card/request/response sizes
- bounded provenance receipts that do not copy runtime workspace/Brain/Memory/Skills/input-Artifact context
- Gateway registration as a normal host-neutral runtime for durable Bots and temporary Workers
- no Hermes, OpenClaw, remote auth, remote leases, reconnect/retry or Phase 5 behavior introduced

**Verified implementation gate:** GitHub Actions CI run 389 (`34710078152`) passed the full **294/294 tests** with 0 failures, 0 canceled and 0 skipped on exact implementation head `29f220ef8e6318bf5dfed835e8a0d966c0c51586`.

See `docs/A2A-RUNTIME-ADAPTER.md` and `docs/PHASE-4-STATUS.md`.

### Phase 4.2 - Hermes adapter

Implemented:

- public host-neutral `HermesStdioRuntimeAdapter` with runtime id `hermes`
- current Hermes Agent TUI Gateway JSON-RPC stdio protocol through `python -m tui_gateway.entry`
- isolated local Hermes gateway/session lifecycle per delegated Task
- optional explicit Hermes profile, Python executable, Hermes root/home, working directory and bounded startup/RPC timeouts
- live built `session.info` verification before prompt submission
- exact live Hermes tool-function containment within the existing Multiple Bots capability lease
- support for exact tool names or explicit `hermes:<tool>` lease references without wildcard authority
- Hermes YOLO and non-manual approval modes rejected before delegated execution
- approval, clarification, sudo, secret and vault-unlock runtime prompts fail closed and are never auto-answered
- structured execution envelope preserving local Bot/Worker identity, workspace scope, Task constraints, expected output, leases, host context, resolved Skills and input Artifacts
- `prompt.submit` and exact-session `message.complete` execution path
- visible final text only; Hermes reasoning payloads are not persisted
- Hermes token/cost/model-call/tool-event usage mapped into the existing Multiple Bots budget contract
- local cancellation best-effort sends exact-session `session.interrupt` while immediately preserving local cancellation authority
- bounded provenance receipt without copied workspace/Brain/Memory/Skills/Artifact/tool-name content
- newline JSON-RPC stdio parser with bounded frames, stderr tail, RPC/startup timeouts and `shell: false`
- no persistent Hermes profile tool mutation: incompatible live authority fails instead of invoking `tools.configure`
- remote endpoint/auth/WebSocket fields explicitly rejected so Phase 4.6 remains the remote identity/authentication owner
- Gateway registration as a normal runtime for durable Bots and temporary Workers
- no OpenClaw, process-adapter, remote-lease, reconnect/retry or Phase 5 behavior introduced

**Verified implementation gate:** GitHub Actions CI run 394 (`34710676926`) passed the full **304/304 tests** with 0 failures, 0 canceled and 0 skipped on exact implementation head `9bfbbcb2b8ea022310bd1d6695742e8d9613bea4`.

See `docs/HERMES-RUNTIME-ADAPTER.md` and `docs/PHASE-4-STATUS.md`.

### Phase 4.3 - OpenClaw adapter

Implemented:

- public host-neutral `OpenClawAgentExecRuntimeAdapter` with runtime id `openclaw`
- current OpenClaw one-shot `openclaw agent exec` headless execution contract instead of the long-running Gateway
- active config discovery through the documented `openclaw config file --json` command or an explicit local config path
- regular-file/non-symlink validation for the selected operator config
- per-Task temporary root-`$include` overlay preserving the operator's config while applying a sibling global `tools.allow` cap
- `OPENCLAW_CONFIG_READONLY=1` plus preserved/extended `OPENCLAW_INCLUDE_ROOTS` so execution can read but not rewrite the operator config
- exact capability-lease tool mapping with optional `openclaw:<tool>` namespace prefix
- groups, globs and wildcard authority rejected rather than widened
- zero-tool leases converted to a non-empty impossible-tool sentinel so an empty allowlist cannot accidentally become unrestricted
- post-run `toolSummary.tools` containment verification as defense in depth
- structured execution envelope preserving local Bot/Worker identity, workspace scope, Task constraints, expected output, leases, host context, resolved Skills and input Artifacts
- stable `agent exec --json` success/error/timeout translation
- visible `final` result only; OpenClaw reasoning/commentary payloads are not persisted
- token/cost/assistant-turn/tool-call usage mapped into the existing Multiple Bots budget contract
- exact one-shot process cancellation with bounded TERM/KILL lifecycle
- bounded outer process deadline in addition to OpenClaw's own `--timeout`
- bounded provenance receipt without copied config paths, tool names, workspace/Brain/Memory/Skills/Artifact content or hidden reasoning
- child execution with `shell: false`
- remote/Gateway auth fields explicitly rejected so Phase 4.6 remains the remote identity/authentication owner
- Gateway registration as a normal runtime for durable Bots and temporary Workers
- no Codex/Claude Code, external-managed-Bot, remote-lease, reconnect/retry or Phase 5 behavior introduced

**Verified implementation gate:** GitHub Actions CI run 401 (`34711466346`) passed the full **318/318 tests** with 0 failures, 0 canceled and 0 skipped on hardened implementation head `51d06d08b0c7e053c750dbfa3c2fc49be62eae02`.

See `docs/OPENCLAW-RUNTIME-ADAPTER.md` and `docs/PHASE-4-STATUS.md`.

### Phase 4.4 - Codex/Claude Code process adapters

Implemented:

- shared bounded local CLI process transport with stdin delivery, `shell: false`, stdout/stderr limits, AbortSignal cancellation, outer process deadlines and SIGTERM -> SIGKILL escalation
- stdout-overflow cleanup that preserves kill escalation even after the local promise fails
- public `CodexExecRuntimeAdapter` with runtime id `codex`
- one-shot `codex exec --json` execution through a temporary harness working directory
- project-rule/config isolation plus ignored user config while preserving normal Codex authentication ownership
- exact provider-scoped Codex capability vocabulary for workspace read, workspace write and web search
- custom Codex filesystem permission profile that exposes only platform-minimal reads plus the explicitly leased workspace
- Codex process-level network denial and web search disabled unless explicitly leased
- Codex plugin/hook/memory/multi-agent/Skills/request-permission surfaces disabled for delegated process execution
- Codex MCP inventory preflight through `codex mcp list --json`, explicit disable of every discovered server, and orchestrator MCP disable
- Codex JSONL result parsing with visible assistant result only and post-run MCP/collaboration/workspace/write/web authority checks
- public `ClaudeCodePrintRuntimeAdapter` with runtime id `claude-code`
- one-shot Claude Code `-p --output-format json` execution in native `--safe-mode --restricted` harness mode
- exact Claude built-in `--tools` mapping from provider-scoped workspace/shell/web capabilities
- Claude `dontAsk` plus `--permission-prompts none` so delegated work cannot widen authority interactively
- Claude safe-mode MCP suppression plus strict empty MCP config and explicit `mcp__*` deny
- Claude session persistence, slash commands and Chrome integration disabled
- explicit host-managed-policy marker acknowledging upstream administrator policy remains authoritative
- durable Bot and temporary Worker identity/Team Run lineage preserved locally for both runtimes
- remote/auth/resume configuration rejected so later Phase 4 slices retain ownership
- Gateway registration of `codex` and `claude-code` as ordinary host-neutral runtimes
- no external-managed-Bot, remote-auth, remote-lease, reconnect/retry or Phase 5 behavior introduced

**Verified implementation gate:** GitHub Actions CI run 410 (`34715059115`) passed the full **337/337 tests** with 0 failures, 0 canceled and 0 skipped on hardened implementation head `9783dca791881ca53265e116ec835e2552e0f43a`.

See `docs/CODEX-CLAUDE-CODE-PROCESS-ADAPTERS.md` and `docs/PHASE-4-STATUS.md`.

### Phase 4.5 - external managed Bot runtime

Implemented:

- public host-neutral `ExternalManagedBotRuntimeAdapter` with runtime id `external-managed`
- host-injected `ExternalManagedBotProvider` / provider registry rather than credentials or remote transport embedded in Bot manifests
- durable one-to-one binding from canonical Multiple Bots Bot identity to provider + managed profile ref + stable binding fingerprint
- global uniqueness enforcement for provider/ref and provider/fingerprint so one external persistent identity cannot back multiple canonical Bots
- archived binding reservation to prevent accidental identity/history reassignment
- external-managed Bot manifest validation requiring a pinned provider/ref/fingerprint and `execution.environment_policy=external_managed`
- live provider inspection before every Task requiring persistent-profile identity, exact Task-lease authority, visible-result-only output and cancellation support
- binding fingerprint verification both before and after execution
- bounded external-managed execution envelope carrying local identity, Task constraints, exact authority and already-resolved host context
- deterministic provider idempotency key derived from the local Task id
- exact tool/connection lease references with wildcard/group/glob rejection
- mandatory post-run provider audit of observed tools/connections with local subset verification
- bounded result/usage translation into the normal local Artifact and budget contract
- bounded provenance receipt without managed profile ref/fingerprint, authority names, copied context or credentials
- normalized provider failures that do not copy arbitrary provider error text into local Task failures
- cancellation that targets the pinned managed identity at most once and settles locally even when a provider ignores AbortSignal or cancel fails
- operator-only disabled-Bot rebind flow preserving the canonical Bot id while requiring no live work and a collision-free new binding
- `bot.runtime_rebound` coordination event plus narrow HTTP rebind boundary
- durable-Bot-only scope for the persistent managed-profile runtime; temporary Workers remain on existing runtime/Team Run paths
- explicit rejection of inline remote auth/transport fields so Phase 4.6 remains the remote-machine identity/authentication owner
- explicit rejection of external environment leases so Phase 4.7 remains the remote lease owner
- no retry/reconnect/reconciliation or Phase 5 channel/onboarding behavior introduced

**Verified implementation gate:** GitHub Actions CI run 421 (`34716643438`) passed the full **355/355 tests** with 0 failures, 0 canceled and 0 skipped on hardened implementation head `c88082c677e291baf359b37acb21316b2be2f0a5`.

See `docs/EXTERNAL-MANAGED-BOT-RUNTIME.md` and `docs/PHASE-4-STATUS.md`.

### Phase 4.6 - remote-machine identity/authentication

Implemented:

- public host-neutral remote-machine trust/authentication contracts with stable machine id, exact HTTPS origin and pinned peer identity
- peer identity modes for HTTPS origin, TLS SPKI digest, TLS certificate digest, SPIFFE ID and custom host-attested identities
- immutable in-process `RemoteMachineIdentityRegistry` with duplicate/ambiguous remote identity rejection
- explicit `RemoteHttpAuthenticatorRegistry` for host-injected credential/transport providers
- `RemoteHttpAccessBroker` enforcing exact registered origin, HTTPS, redirect denial and verified authentication evidence
- opaque `remote_credential_ref` handles rather than raw credentials in Bot/runtime configuration
- built-in `HeaderRemoteHttpAuthenticator` for A2A HTTP Bearer and header API-key security schemes
- public discovery separation so built-in application credentials are never resolved/sent for an unauthenticated Agent Card request
- explicit rejection of raw credential-like A2A runtime fields
- normalized A2A v1 security requirements with OR/AND scheme semantics
- verification that declared security schemes exist before credentials are resolved
- exact required-scope proof through authentication evidence
- custom authenticator surface for OAuth2/OIDC, mTLS, SPIFFE and stronger certificate/workload-identity implementations
- authenticated A2A `SendMessage`, `GetTask` and `CancelTask` through the same pinned machine/auth boundary
- cross-origin Agent Card interface rejection before credential resolution/transmission
- bounded A2A auth provenance without token/API-key/credential-ref/certificate/private-key material
- sanitized third-party authenticator failure boundary
- local abort racing so auth cancellation does not depend on provider AbortSignal compliance
- Gateway injection/exposure of remote machine, authenticator and access-broker registries
- no remote capability/environment lease, reconnect/retry or Phase 5 behavior introduced

**Verified implementation gate:** GitHub Actions CI run 438 (`34717863491`) passed the full **375/375 tests** with 0 failures, 0 canceled and 0 skipped on hardened implementation head `a2fcd4736f37d832c9240476c5b77efa01e462d4`.

See `docs/REMOTE-MACHINE-IDENTITY-AUTH.md` and `docs/PHASE-4-STATUS.md`.

### Phase 4.7 - remote capability/environment leases

Implemented:

- public host-neutral `RemoteLeaseProvider`, registry and `RemoteLeaseBroker`
- local capability/environment leases remain canonical parent authority
- deterministic Task/principal/workspace/target-bound remote lease request digest
- exact tool/connection references only; group/glob/wildcard authority fails closed
- remote providers may narrow tools/connections/destructive-action policy/expiry but can never widen them
- effective remote expiry capped by capability lease, environment lease and Task deadline
- revoked/expired local leases rejected before provider execution, while explicit null revocation markers remain active
- trusted host environment refs mapped by the provider to opaque remote environment refs without model invention
- exact environment policy preservation and no remote environment authority without a local environment lease
- provider identity verification, sanitized provider failures and local AbortSignal authority
- required post-run remote lease receipt bound to lease id/request digest/grant fingerprint
- post-run observed tool/connection containment and exact environment verification
- result rejection when the grant expired before completion
- bounded persisted provenance containing verification/count state rather than authority names, remote lease ids or environment refs
- pinned A2A remote authority now requires `remote_lease_provider` and the AI-Verse remote Task lease extension
- A2A `A2A-Extensions` activation plus namespaced grant/receipt metadata
- meaningful A2A authority cannot be projected to an unpinned remote endpoint
- A2A execution envelope rewritten to the effective narrowed remote grant
- A2A completion/cancellation verifies/revokes the exact grant
- Phase 4.5 external-managed environment-lease path completed through the same generic broker
- external-managed execution receives only narrowed effective authority and a mapped remote environment
- existing managed-runtime observed-authority audit must agree with the remote lease receipt
- Gateway host injection/exposure of remote lease providers/broker
- no reconnect/retry/lease renewal/reconciliation or Phase 5 behavior introduced

**Verified implementation gate:** GitHub Actions CI run 456 (`34719783568`) passed the full **397/397 tests** with 0 failures, 0 canceled and 0 skipped on hardened implementation head `736fe5103a3e7224c202923e7d7240a3b97d53ad`.

See `docs/REMOTE-CAPABILITY-ENVIRONMENT-LEASES.md` and `docs/PHASE-4-STATUS.md`.

### Phase 4.8 - retry/disconnect/reconnect semantics

Implemented:

- durable SQLite recovery journal for remote execution checkpoints and failed lease revocations
- deterministic adapter/Task/target-bound remote operation identity
- restart-safe `submitting`, `remote_active` and `completed` recovery states
- verified remote-result caching until local Task/Artifact settlement commits
- runtime settlement hook forwarded through all existing context/runtime wrappers
- A2A resume by exact server-issued Task id through `GetTask`
- bounded retry of idempotent A2A operations and transient HTTP failures
- explicit fail-closed ambiguous `SendMessage` behavior
- negotiated AI-Verse A2A remote Task recovery extension for safe exactly-once logical replay
- stable A2A message ids and deterministic operation keys across recovery
- restart-aware A2A `CancelTask`
- external-managed provider declaration `idempotency_mode=exact_task_key`
- managed-provider execution retry/replay only when exact Task-key semantics are declared
- restart-aware external-managed provider cancellation
- recovered remote grant validation against current capability/environment/deadline authority
- exact-authority and exact-environment replacement constraints for recovery grants
- recovery-aware A2A lease reacquisition/renewal
- deterministic durable failed-revocation queue with startup/periodic/shutdown reconciliation
- stale dead-letter remote cleanup without changing local recovery authority
- bounded recovery provenance and no raw credential persistence

**Verified implementation gate:** GitHub Actions CI run 478 (`34721177823`) passed the full **412/412 tests** with 0 failures, 0 canceled and 0 skipped on hardened implementation head `08b4c03151a5096960cc33c588357a3294f22998`.

See `docs/REMOTE-EXECUTION-RECOVERY.md` and `docs/PHASE-4-STATUS.md`.

## Phase 5 - Product, Installer, Omnichannel and Dashboard

**Status:** NOT STARTED

Goal: turn the completed coordination/integration/interoperability layers into a member-installable product with health, onboarding, remote/channel access and observability.

Remaining major slices:

1. simple install command/package
2. standalone install mode
3. AI-Verse OS install mode
4. setup/onboarding flow
5. Bot/team templates
6. production health/doctor
7. upgrade/migration strategy
8. secure remote Gateway option
9. Dashboard projections/control endpoints
10. Telegram/Discord/other channel bridge contracts
11. operator approvals/attention UX
12. observability/usage views
13. release docs/examples
14. full release acceptance suite

## Release acceptance

The first finished release must prove at minimum:

- install from a clean machine
- standalone mode works
- AI-Verse OS mode works without duplicating canonical state
- two durable Bots can collaborate end-to-end
- a Bot can form a temporary squad and synthesize its work
- work survives restart
- cancellation works
- budgets/limits stop runaway coordination
- approval-required actions cannot bypass approval boundary
- workspace isolation cannot be bypassed through Bot-to-Bot routing
- external runtime failure does not corrupt coordination state
- Dashboard/channel clients can observe/control without owning truth
- upgrade/uninstall preserves user-owned state

## Next gate

**Phase 4.9 - compatibility/evaluation suite.**

Phase 4.8 is complete. The next canonical slice is the Phase 4 compatibility/evaluation suite. Phase 4.9 has not started.

## How to report progress

For future implementation updates, report:

```text
Overall: Phase X of 5
Current phase: approximately N%
Current slice: X.Y
Just completed: ...
Next gate: ...
Major phases remaining: ...
```

Percentages are directional planning indicators only. Passed completion gates are authoritative.