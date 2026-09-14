# Phase 5 Status - Product, Installer, Omnichannel and Dashboard

**Updated:** 2026-09-13

**Phase:** 5

**Overall status:** IN PROGRESS

**Directional phase progress:** approximately 80%

This file is the implementation ledger for Phase 5. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 5 goal

Turn the completed coordination, AI-Verse integration and runtime-interoperability layers into a member-installable product with safe setup, health, lifecycle, remote/channel access and observability.

## Slice status

1. simple install command/package - **COMPLETE**
2. standalone install mode - **COMPLETE**
3. AI-Verse OS install mode - **COMPLETE**
4. setup/onboarding flow - **COMPLETE**
5. Bot/team templates - **COMPLETE**
6. production health/doctor - **COMPLETE**
7. upgrade/migration strategy - **COMPLETE**
8. secure remote Gateway option - **COMPLETE**
9. Dashboard projections/control endpoints - **COMPLETE**
10. Telegram/Discord/other channel bridge contracts - **COMPLETE**
11. operator approvals/attention UX - **COMPLETE**
12. observability/usage views - **COMPLETE IMPLEMENTATION, ACCEPTANCE PENDING CI**
13. release docs/examples - **NEXT**
14. full release acceptance suite - **NOT STARTED**

## Slice 5.1 - simple install command/package

**Implementation status:** COMPLETE

Phase 5.1 makes the existing codebase a real npm-installable command package without silently configuring either standalone mode or AI-Verse OS mode.

Implemented:

- public scoped npm package metadata for `@ai-verse/multiple-bots`
- stable installed command: `ai-verse-multiple-bots`
- explicit package file allowlist
- compiled runtime code included in the package
- coordination schema, Bot/Room templates and AI-Verse OS integration assets included
- tests, temporary runtime state and development-only source surfaces excluded from the published artifact
- `prepack` build so publish/pack artifacts contain compiled runtime code
- explicit public scoped-package publish configuration
- repository/bugs/homepage metadata
- no `preinstall`, `install` or `postinstall` host mutation
- deterministic package-manifest acceptance tests
- real `npm pack` verification
- clean temporary-project tarball installation
- installed npm bin verification
- installed CLI `init` smoke test
- installed CLI `doctor` smoke test
- explicit `npm run pack:check` CI gate

### 5.1 acceptance proof

The hardened implementation head `9a71934528d90d9813dc527c6c2499b4d5abdeea` passed GitHub Actions **CI run 490 (`34765115030`)**:

- full repository suite: **420/420 tests passed**
- Phase 4 compatibility suite: **5/5 tests passed**
- package build/pack/install smoke: **passed**
- packed artifact: **172 files**
- installed command: `ai-verse-multiple-bots`
- installed `init`: passed
- installed `doctor`: passed
- **0 failures, 0 canceled and 0 skipped**

This proves the package artifact itself is installable. It does **not** claim that version `0.1.0-alpha.1` has already been published to the public npm registry. Registry publication is a release operation, not an implementation fact.

## Slice 5.2 - standalone install mode

**Implementation status:** COMPLETE

Phase 5.2 turns the package surface into a real host-neutral standalone installation without inventing AI-Verse OS state.

Implemented:

- canonical standalone home at `.ai-verse-bots/`
- standalone config schema `1.0`
- fixed internal coordination database at `.ai-verse-bots/runtime/coordination.db`
- loopback Gateway defaults at `127.0.0.1:8787`
- `standalone init`
- `standalone doctor`
- `standalone serve`
- explicit `--root`, initial `--host` and initial `--port` support
- ancestor discovery for existing standalone installations
- idempotent, byte-stable re-initialization
- explicit mismatch failure instead of silent config rewrite
- malformed/unsupported config rejection
- symlink/path traversal rejection for standalone-owned config/runtime state
- doctor behavior that reports missing installs without creating them
- standalone Gateway startup with no AI-Verse OS root
- verification that AI-Verse-native Brain, Memory, Skills, Automations, workspace projection and OS write-command sources remain detached
- installed-package standalone init/doctor smoke verification
- no AI-Verse OS manifests, operator/workspace folders or extension registry created

### 5.2 acceptance proof

The implementation head `d1baf0daee3bb03f5d4ead0d484c7145831e00fd` passed GitHub Actions **CI run 495 (`34766373647`)**:

- full repository suite: **426/426 tests passed**
- Phase 4 compatibility suite: **5/5 tests passed**
- package build/pack/install smoke: **passed**
- installed-package standalone smoke: **passed**
- packed artifact: **175 files**
- **0 failures, 0 canceled and 0 skipped**

See `docs/STANDALONE-INSTALL.md`.

## Slice 5.3 - AI-Verse OS install mode

**Implementation status:** COMPLETE

Phase 5.3 closes the gap between safe registration and a real member-facing AI-Verse OS installation.

Implemented:

- `os install-plan` read-only materialization preview
- `os install` package-owned installation
- compatible AI-Verse OS v2 / `unified-workspace` validation
- extension-owned `INSTRUCTIONS.md` materialization
- extension-owned executable `engine.mjs` materialization
- canonical OS-mode coordination database initialization under `runtime/ai-verse-bots/coordination.db`
- coordination DB health validation before registration
- registration through the existing exclusive-lock + atomic registry contract
- foreign same-key registry ownership rejection
- different-version install rejection in favor of the upgrade lifecycle
- conflicting known extension-file rejection
- symlink/path-chain fail-closed behavior
- unknown extension files preserved
- canonical OS/operator/workspace/Skills state preservation
- generated engine that loads the installed package and starts the normal native OS-attached Gateway
- idempotent reinstall returning `unchanged`
- installed-package OS install smoke
- installed-package generated-engine startup + health smoke

### 5.3 acceptance proof

The hardened implementation head `cabd7216c783b9bae61bcfa29cc22275a2a30dd3` passed GitHub Actions **CI run 506 (`34767263301`)**:

- full repository suite: **434/434 tests passed**
- Phase 4 compatibility suite: **5/5 tests passed**
- package install smoke: **passed**
- standalone install smoke: **passed**
- AI-Verse OS install/materialization smoke: **passed**
- materialized AI-Verse OS engine startup/health smoke: **passed**
- packed artifact: **178 files**
- **0 failures, 0 canceled and 0 skipped**

See `docs/AI-VERSE-OS-INSTALL.md`.

## Slice 5.4 - setup/onboarding flow

**Implementation status:** COMPLETE

Phase 5.4 adds the canonical AI-Verse public `setup` vocabulary over the completed standalone and AI-Verse OS installation modes.

Implemented:

- public `setup --mode standalone`
- public `setup --mode os --root ...`
- `setup modes` discovery/help surface
- safe rerun mode auto-detection from the current directory/ancestors
- fresh setup requires explicit mode instead of silently guessing standalone
- ambiguous dual-mode discovery fails with `SETUP_MODE_AMBIGUOUS`
- standalone setup uses the existing idempotent standalone initializer
- AI-Verse OS setup uses the existing package-owned OS materializer/attachment flow
- setup performs explicit structural + attachment verification
- standardized `ready` / `disabled` setup result
- disabled OS registrations remain disabled and return non-ready
- mode-inapplicable options fail closed
- structured next steps for verify, start and explicit Bot creation
- explicit setup non-grants for workspace access, connection permission, external approval, Brain authority and remote exposure
- setup creates no implicit Bot or team
- installed-package setup/onboarding smoke coverage
- README first-use path aligned to Install -> Setup -> Verify -> Use

### 5.4 acceptance proof

The implementation head `1472b9d9fe73ec6c95cbc51de24ff374a9485904` passed GitHub Actions **CI run 509 (`34769052535`)**:

- full repository suite: **441/441 tests passed**
- Phase 4 compatibility suite: **5/5 tests passed**
- package install smoke: **passed**
- standalone install smoke: **passed**
- AI-Verse OS install smoke: **passed**
- materialized AI-Verse OS engine startup/health smoke: **passed**
- public setup/onboarding smoke: **passed**
- packed artifact: **181 files**
- **0 failures, 0 canceled and 0 skipped**

See `docs/SETUP-ONBOARDING.md`.

## Slice 5.5 - Bot/team templates

**Implementation status:** COMPLETE

Phase 5.5 turns the earlier Bot/Room examples into a reusable explicit starter-template product surface without making setup silently create durable identities.

Implemented:

- machine-readable `templates/starter-catalog.json`
- public `template list`
- public `template show --id ...`
- read-only `template plan --id ... --workspace ...`
- explicit `template apply --id ... --workspace ...`
- three single-Bot starters: Research Lead, Independent Reviewer, Work Coordinator
- two durable team starters: Research Team and Delivery Team
- deterministic workspace-scoped Bot/Room IDs
- optional explicit prefix; runtime adapter is now required explicitly by the Phase 5.6 readiness hardening
- default explicit peer allow-lists instead of wildcard peer authority
- no starter Bot can create durable Bots
- temporary Worker creation enabled only for coordinator/leader roles that need it
- external-managed starter binding rejected because provider/ref/fingerprint ownership must be explicit
- team templates create durable Bots + one bounded Room, never a Team Run
- whole-team atomic apply
- absent-object preconditions preventing same-ID overwrite races
- exact-current partial-state completion without rewriting current objects
- collision refusal instead of overwrite
- idempotent reapply with no duplicate creation events
- setup onboarding now points to the starter catalog
- installed-package template list/plan/apply/idempotence smoke coverage

### 5.5 acceptance proof

The integrated implementation head `52a2efa569a2fd6f668199d04a15309a20262709` passed GitHub Actions **CI run 519 (`34770445984`)**:

- full repository suite: **449/449 tests passed**
- Phase 4 compatibility suite: **5/5 tests passed**
- package install smoke: **passed**
- standalone install smoke: **passed**
- AI-Verse OS install smoke: **passed**
- materialized AI-Verse OS engine startup/health smoke: **passed**
- setup/onboarding smoke: **passed**
- starter template smoke: **passed**
- packed artifact: **185 files**
- **0 failures, 0 canceled and 0 skipped**

See `docs/BOT-TEAM-TEMPLATES.md`.

## Slice 5.6 - production health/doctor

**Implementation status:** COMPLETE

Phase 5.6 replaces shallow storage health with one truthful, read-only component readiness model.

Implemented:

- public `status`
- public deep `doctor`
- `standalone doctor` upgraded to production depth
- `os doctor`
- live `GET /v1/health/readiness` while preserving legacy `GET /health`
- explicit readiness states: `setup-required`, `disabled`, `unhealthy`, `ready`
- explicit checked depths: structural, attachment, runtime, dependency, operational
- AI-Verse OS `system/composed` readiness explicitly delegated to OS/distribution
- SQLite opened read-only for production inspection
- `PRAGMA quick_check`, schema and required-table verification
- no runtime-table materialization during doctor
- dead-letter, stale-execution and queue/object consistency checks
- active-Bot runtime registry verification
- adapter-specific dependency checks for local process, OpenAI-compatible, A2A and external-managed runtimes
- warnings distinguish unprobed remote/model dependencies from proven failures
- stock Gateway `native` runtime gap is surfaced rather than hidden
- public starter-template and direct Bot creation no longer silently default to the unsupported `native` adapter; runtime selection is explicit
- explicit raw `doctor --db PATH` compatibility retained for prior automation
- installed-package status/doctor acceptance smoke

### 5.6 acceptance proof

The hardened implementation head `c3b5a25f0657e190c224b991f06ba66d827de54f` passed GitHub Actions **CI run 531 (`34777986116`)**:

- full repository suite: **459/459 tests passed**
- Phase 4 compatibility suite: **5/5 tests passed**
- package install smoke: **passed**
- standalone install smoke: **passed**
- AI-Verse OS install smoke: **passed**
- materialized AI-Verse OS engine startup/health smoke: **passed**
- setup/onboarding smoke: **passed**
- starter-template smoke: **passed**
- production doctor smoke: **passed**
- packed artifact: **188 files**
- **0 failures, 0 canceled and 0 skipped**

See `docs/PRODUCTION-HEALTH-DOCTOR.md`.

## Slice 5.7 - upgrade/migration strategy

**Implementation status:** COMPLETE

Phase 5.7 separates software/runtime update from canonical coordination-state migration and makes both installation modes fail closed around version/schema drift.

Implemented:

- public `update-plan` and `update`
- mode-aware automatic selection with ambiguity/no-installation failure
- `standalone update-plan` / `standalone update`
- `os update-plan` / `os update`
- existing `os upgrade-plan` / `os upgrade` retained as full-product update aliases
- deterministic semantic version ordering including prereleases
- canonical exported coordination schema version
- read-only coordination migration assessment before update
- explicit `migration-required` for unsupported schema transitions
- explicit downgrade refusal in favor of Distribution-owned rollback
- versioned standalone `.ai-verse-bots/install.json` receipt for new installs
- explicit legacy-unversioned standalone adoption
- standalone update changes receipt metadata only and preserves config/coordination state
- full AI-Verse OS update refreshes only package-owned `INSTRUCTIONS.md` + `engine.mjs` and the owned registry version
- disabled OS state preserved
- unknown registry metadata and unrelated registrations preserved
- registered adapter paths verified rather than discarded
- coordination DB and canonical host state preserved
- bounded package-owned file rollback when registry commit fails
- `status` / `doctor` distinguish `update-required` from `migration-required`
- installed tarball update/migration smoke

### 5.7 acceptance proof

The hardened implementation head `34ff85fa4e9546237a00ef81b1e37ced71eef1b1` passed GitHub Actions **CI run 538 (`34778976513`)**:

- full repository suite: **467/467 tests passed**
- Phase 4 compatibility suite: **5/5 tests passed**
- package install smoke: **passed**
- standalone install smoke: **passed**
- AI-Verse OS install smoke: **passed**
- materialized AI-Verse OS engine startup/health smoke: **passed**
- setup/onboarding smoke: **passed**
- starter-template smoke: **passed**
- production-doctor smoke: **passed**
- installed-package update/migration smoke: **passed**
- packed artifact: **206 files**
- **0 failures, 0 canceled and 0 skipped**

See `docs/UPDATE-MIGRATION-STRATEGY.md`.

## Slice 5.8 - secure remote Gateway option

**Implementation status:** COMPLETE

Phase 5.8 adds authenticated remote access without exposing the Coordination Gateway as a raw non-loopback HTTP service.

Implemented:

- direct non-loopback Gateway binding rejected with `DIRECT_REMOTE_BIND_FORBIDDEN`
- standalone Gateway configuration restricted to loopback hosts
- public `remote plan` read-only preflight
- public `remote serve` managed remote runtime
- one managed remote provider: Tailscale Serve
- tailnet-only HTTPS exposure; Tailscale Funnel/public ingress is not enabled
- Tailscale CLI presence + connected-tailnet `BackendState: Running` verification
- local Gateway remains on `127.0.0.1`
- bearer authentication for the entire managed remote Gateway surface
- bearer secret resolved only from an environment handle, default `AI_VERSE_GATEWAY_TOKEN`
- minimum 32-character, whitespace-free bearer secret validation
- no secret value in config, registry, plans or CLI output
- no unauthenticated remote health/readiness/event-stream bypass
- request routing independent of the untrusted Host header
- bounded JSON request body size
- response hardening headers
- foreground Tailscale Serve lifecycle tied to Gateway lifecycle
- unexpected transport exit closes the managed local Gateway
- both standalone and AI-Verse OS modes supported
- installed-package secure-remote acceptance smoke

### 5.8 acceptance proof

The hardened implementation head `96eef0e3ad65aa9b456dab18f679566d0c6eea69` passed GitHub Actions **CI run 553 (`34780581616`)**:

- full repository suite: **471/471 tests passed**
- Phase 4 compatibility suite: **5/5 tests passed**
- package install smoke: **passed**
- standalone install smoke: **passed**
- AI-Verse OS install smoke: **passed**
- materialized AI-Verse OS engine startup/health smoke: **passed**
- setup/onboarding smoke: **passed**
- starter-template smoke: **passed**
- production-doctor smoke: **passed**
- update/migration smoke: **passed**
- installed-package secure-remote Gateway smoke: **passed**
- packed artifact: **212 files**
- **0 failures, 0 canceled and 0 skipped**

See `docs/SECURE-REMOTE-GATEWAY.md`.

## Slice 5.9 - Dashboard projections/control endpoints

**Implementation status:** COMPLETE

Phase 5.9 adds a versioned workspace-scoped Dashboard backend contract without moving coordination truth into the Dashboard.

Implemented:

- `GET /v1/dashboard/capabilities?workspace=...`
- `GET /v1/dashboard/snapshot?workspace=...`
- `GET /v1/dashboard/events?workspace=...&after=...&limit=...`
- `GET /v1/dashboard/events/stream?workspace=...&after=...`
- `POST /v1/dashboard/control`
- compact Bot, Task, Team Run, Room, Approval, Artifact and attention projections
- exact workspace filtering for snapshots, replay and live SSE events
- monotonic canonical event cursor reuse
- explicit `projection_only: true`
- explicit `dashboard_owns_truth: false`
- operator-only Dashboard controls
- cross-workspace control rejection before canonical mutation
- Bot activate/disable/archive routed through `CoordinationGateway`
- Approval approve/deny routed through existing Approval ownership
- Task cancellation routed through `BotRunner.cancelTask`
- retry routed through `ExecutionSupervisor -> RecoveryCoordinator`
- retry advertised only when the canonical blocked/dead-letter/retry-safe contract is satisfiable
- Team Run cancellation routed through the runner's existing `TeamRunControl`
- no Dashboard-specific mutation store or control plane
- installed-package Dashboard snapshot/control smoke

### 5.9 acceptance proof

The implementation head `122616d2b9aff059a24d16c5f30944b441d3c897` passed GitHub Actions **CI run 570 (`34782101256`)**:

- full repository suite: **476/476 tests passed**
- Phase 4 compatibility suite: **5/5 tests passed**
- package install smoke: **passed**
- standalone install smoke: **passed**
- AI-Verse OS install smoke: **passed**
- materialized AI-Verse OS engine startup/health smoke: **passed**
- setup/onboarding smoke: **passed**
- starter-template smoke: **passed**
- production-doctor smoke: **passed**
- update/migration smoke: **passed**
- secure-remote Gateway smoke: **passed**
- installed-package Dashboard projection/control smoke: **passed**
- packed artifact: **218 files**
- **0 failures, 0 canceled and 0 skipped**

See `docs/DASHBOARD-PROJECTION-CONTROL.md`.

## Slice 5.10 - Telegram/Discord/other channel bridge contracts

**Implementation status:** COMPLETE

Phase 5.10 adds a provider-neutral omnichannel boundary without creating another scheduler, identity database or coordination authority.

Implemented:

- host-supplied, workspace-scoped channel bindings
- one enabled provider/account/conversation route per binding
- Telegram message/update normalization
- Discord message normalization
- generic normalized ingress contract
- explicit adapter-side transport verification requirement
- external sender allow-lists
- deterministic channel actor IDs without a second identity store
- deterministic canonical message IDs and ingress idempotency
- external-message provenance with `trusted_instruction: false`
- text plus external attachment-reference normalization
- canonical reply correlation
- Bot ingress routed through `CoordinationGateway`
- Room/Thread ingress routed through `RoomCoordinator`
- canonical message events now carry `message_id`
- outbound formatting from existing canonical messages
- Telegram, Discord and generic transport-command projections
- external reply-target recovery
- echo prevention for inbound external messages
- idempotent `sent` / `delivered` / `failed` egress receipts
- no provider secret storage
- no public webhook termination inside Multiple Bots
- no provider network delivery inside Multiple Bots
- installed-package channel ingress/egress smoke coverage

### 5.10 acceptance proof

The implementation head `bde706770aba08a14150af51732c8e578460fca4` passed GitHub Actions **CI run 577 (`34782846365`)**:

- full repository suite: **482/482 tests passed**
- Phase 4 compatibility suite: **5/5 tests passed**
- package install smoke: **passed**
- standalone install smoke: **passed**
- AI-Verse OS install smoke: **passed**
- materialized AI-Verse OS engine smoke: **passed**
- setup/onboarding smoke: **passed**
- starter-template smoke: **passed**
- production-doctor smoke: **passed**
- update/migration smoke: **passed**
- secure-remote Gateway smoke: **passed**
- Dashboard projection/control smoke: **passed**
- installed-package channel ingress/egress smoke: **passed**
- packed artifact: **221 files**
- **0 failures, 0 canceled and 0 skipped**

See `docs/CHANNEL-BRIDGE-CONTRACTS.md`.

## Slice 5.11 - operator approvals/attention UX

**Implementation status:** COMPLETE

Phase 5.11 turns canonical approval, Task, Handoff, execution and attention state into a compact operator-facing queue without creating a notification/read-state database.

Implemented:

- `GET /v1/operator/capabilities?workspace=...`
- `GET /v1/operator/attention?workspace=...&after=...`
- `GET /v1/operator/approvals?workspace=...&status=...`
- `POST /v1/operator/approvals/:id/decision`
- deterministic priority order: needs approval, needs input, blocked, failed, handoff waiting, unread result
- current-state attention from canonical Approval/Task/Handoff/execution state
- transient event attention through the canonical event cursor
- no durable read/unread or notification store
- rich Approval decision cards with Task/action context
- explicit workspace isolation before Approval mutation
- explicit `operator_*` decision identity
- Approval approve/deny routed through existing `CoordinationGateway` ownership
- blocked retry advertised only when existing recovery rules permit it
- existing Task retry/cancel control router reused rather than duplicated
- no private model reasoning exposed
- installed-package operator attention/Approval smoke coverage

### 5.11 acceptance proof

The implementation head `6028dca16f6ace413927918399dd746889a19b8a` passed GitHub Actions **CI run 584 (`34785373757`)**:

- full repository suite: **487/487 tests passed**
- Phase 4 compatibility suite: **5/5 tests passed**
- package install smoke: **passed**
- standalone install smoke: **passed**
- AI-Verse OS install smoke: **passed**
- materialized AI-Verse OS engine smoke: **passed**
- setup/onboarding smoke: **passed**
- starter-template smoke: **passed**
- production-doctor smoke: **passed**
- update/migration smoke: **passed**
- secure-remote Gateway smoke: **passed**
- Dashboard projection/control smoke: **passed**
- channel bridge smoke: **passed**
- installed-package operator attention/Approval smoke: **passed**
- packed artifact: **224 files**
- **0 failures, 0 canceled and 0 skipped**

See `docs/OPERATOR-ATTENTION-UX.md`.

## Slice 5.12 - observability/usage views

**Implementation status:** COMPLETE IMPLEMENTATION, ACCEPTANCE PENDING CI

Phase 5.12 exposes truthful workspace-scoped operational and usage views over canonical coordination state without introducing a second telemetry or billing store.

Implemented:

- `GET /v1/observability/capabilities?workspace=...`
- `GET /v1/observability/snapshot?workspace=...&after=...&limit=...`
- `GET /v1/observability/usage?workspace=...`
- `GET /v1/observability/timeline?workspace=...&after=...&limit=...`
- workspace Task/Bot/Worker/Team Run operational summary
- Task outcome/status distribution
- execution queue state distribution
- dead-letter, retryable-dead-letter and stale-execution counts
- persisted input/output/total token usage
- persisted runtime-reported monetary evidence and action usage for coordination budgets
- explicit `ai-verse-token` ownership of canonical telemetry and cost truth
- explicit `@ai-verse/token/gateway` canonical historical/global read path
- no pricing, tariff calculation or Token ledger duplication
- explicit usage coverage statement instead of inferred provider billing
- per-principal usage breakdown
- per-Team-Run usage recomputation vs canonical aggregate consistency
- Team Run token/cost/action budget utilization
- terminal Task latency samples/average/min/max
- compact structured coordination timeline
- event type and attention-state counts
- exact workspace isolation
- bounded cursor/limit validation
- explicit `private_reasoning_exposed: false`
- explicit `runtime_usage_is_canonical_token_truth: false`
- public runtime money renamed to `runtime_reported_cost_evidence`
- no telemetry mutation, Token ledger mutation, pricing authority, retry authority or billing claim
- installed-package observability/usage smoke coverage

Acceptance proof will be recorded after hosted CI passes on the PR head.

See `docs/OBSERVABILITY-USAGE-VIEWS.md`.

## Ownership boundary

Phase 5.1 intentionally does not choose or configure an operating mode during npm installation.

- standalone configuration is implemented by Phase 5.2
- AI-Verse OS installation/attachment is implemented by Phase 5.3
- setup/onboarding is implemented by Phase 5.4
- npm installation itself has no hidden host mutations

## Next gate

**Phase 5.13 - release docs/examples.**

Phase 5.12 implementation is complete pending hosted acceptance. The next product slice is the final member-facing release documentation and runnable examples before full release acceptance.
