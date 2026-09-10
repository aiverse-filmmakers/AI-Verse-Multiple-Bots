# Phase 3 Status - AI-Verse Native Integration

**Updated:** 2026-09-10

**Phase:** 3

**Overall status:** IN PROGRESS

**Directional phase progress:** approximately 30%

This file is the implementation ledger for Phase 3. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 3 goal

Attach the completed host-neutral persistent-teammate and squad package to AI-Verse OS through explicit adapters while preserving the ownership boundary: AI-Verse OS remains canonical for operator/workspace/domain state, and Multiple Bots remains canonical only for coordination state.

## Slice status

1. AI-Verse OS installer/registration contract — **COMPLETE**
2. workspace-scoped state projection — **COMPLETE**
3. Brain initiative/goal ingress — **COMPLETE**
4. Memory context/recall adapter — **NEXT**
5. Skills capability resolution — **NOT STARTED**
6. Automations wake/schedule integration — **NOT STARTED**
7. OS write-command boundary — **NOT STARTED**
8. candidate knowledge/decision write-back — **NOT STARTED**
9. 4Cs health integration — **NOT STARTED**
10. uninstall/upgrade without canonical-state damage — **NOT STARTED**

## Slice 3.1 - AI-Verse OS installer/registration contract

**Implementation status:** COMPLETE

Phase 3.1 establishes the first explicit host adapter without merging this repository into AI-Verse OS and without modifying tracked OS files.

Implemented:

- public `aiVerseOsRegistrationAdapter`
- AI-Verse OS root discovery and compatibility detection
- fail-closed support for AI-Verse OS schema major 2 + `unified-workspace`
- verification that the OS exposes its stable local extension registry hook
- canonical Multiple Bots extension manifest and task-relevant host instructions
- registration only through `.aiverse/extensions/registry.json`
- no implicit mutation of `agents/registry.yaml` or other tracked/canonical OS files
- preservation of unknown registry fields, unrelated extensions and unknown own-entry fields
- preservation of an operator-disabled extension across reinstall/update
- repository-relative path validation and out-of-root/traversal/absolute/NUL rejection
- non-symlink host/registry/installed-file checks
- installed instruction/engine/adapter file verification before `installed: true` is written
- atomic registry replacement
- exclusive registry lock with visible `EXTENSION_REGISTRY_BUSY` conflict instead of lost update
- unexpected concurrent registry-change detection before replacement
- byte-stable/idempotent repeated registration
- CLI surfaces: `os detect`, `os plan`, `os register`
- explicit separation of registration, enablement, health, permission and workspace authorization

### 3.1 acceptance proof

GitHub Actions run 258 passed **184/184 tests** with **0 failures, 0 canceled, and 0 skipped** on the hardened 3.1 implementation.

The 9 Phase 3.1 acceptance tests prove:

1. exact AI-Verse OS v2 compatibility detection and ancestor root discovery
2. absent, malformed, unsupported, or incomplete hosts fail closed
3. registration preserves unrelated/unknown registry state and a user-disabled Multiple Bots entry
4. reinstall is byte-stable and idempotent
5. missing installed extension files block registration without changing the registry
6. absolute/traversal/unsafe/symlinked extension paths fail closed
7. malformed or unsupported registry state is never silently replaced
8. an existing registry lock blocks a competing installer without deleting or overwriting its state
9. source extension metadata stays aligned with package/host contract constants

## Slice 3.2 - workspace-scoped state projection

**Implementation status:** COMPLETE

Phase 3.2 adds a read-only execution projection from AI-Verse OS into Multiple Bots without creating a second source of workspace truth.

Implemented:

- public `AiVerseOsWorkspaceProjector` implementing the host-neutral `WorkspaceStateProjector` contract
- AI-Verse OS v2 compatibility revalidation at projector construction and every execution-time projection
- canonical workspace resolution through `AI-VERSE.yaml` `paths.workspaces`
- exact workspace-directory / `WORKSPACE.yaml` identity match
- active-workspace requirement by default
- bounded projection of workspace identity, purpose, domains, owners, success criteria, declared canonical sources, connections, privacy and approval policy
- bounded projection of the declared current-context file using only canonical AI-Verse OS v2 sections
- strict relative-path, traversal, NUL, absolute-path and symlink rejection
- manifest/context file-size ceilings plus per-section and list-item ceilings
- stable SHA-256 source digests and deterministic projection digest
- no projection caching: canonical host edits are visible to the next execution
- common runtime injection for both durable Bots and temporary Workers through the public `BotRunner`
- OpenAI-compatible runtime receives the projection explicitly as read-only host context
- deterministic runtime can consume the projection digest without owning the host data
- Artifact runtime receipts persist only provider/schema/workspace/source references and digests; projected workspace text is not persisted
- `serve --os-root PATH` enables native projection explicitly
- standalone mode remains unchanged when no projector is supplied
- invalid explicit host configuration fails before coordination SQLite/queue state is allocated

### 3.2 acceptance proof

GitHub Actions run 271 passed the full **192/192 test suite** with **0 failures** on the hardened Phase 3.2 branch.

The 8 Phase 3.2 acceptance tests prove:

1. only bounded canonical workspace identity, boundary and current-context fields are projected
2. projections are live and uncached; host edits change the next projection digest
3. workspace identity mismatch and inactive workspace state fail closed
4. traversal, symlink and oversized host sources fail closed
5. durable Bot model execution receives host context while persisted Multiple Bots state contains only projection provenance/digests
6. cross-workspace data is not mixed and standalone execution does not project host state implicitly
7. a real temporary TeamRun Worker receives the same scoped projection contract without durable promotion or host-text persistence
8. an invalid explicit AI-Verse OS root fails before the Gateway allocates coordination state

## Slice 3.3 - Brain initiative/goal ingress

**Implementation status:** COMPLETE

Phase 3.3 lets AI-Verse Brain supply bounded strategic objectives to the coordination layer while Brain remains the canonical owner of strategic state.

Implemented:

- public `AiVerseBrainObjectiveSource` and `BrainObjectiveIngress`
- compatible AI-Verse OS v2 + enabled Brain installation requirement
- exact workspace-level direction ownership requirement through `.aiverse/direction/ownership.json`
- bounded canonical projection of objective, criteria, constraints, boundaries, stop conditions, dependencies, risks and serving initiative/intent context
- path-safe, non-symlink, size-bounded Brain object reads with exact workspace identity/scope checks
- fresh ingress only from `READY` Brain objectives
- executable continuation only while objective/parent lifecycle remains valid
- deterministic semantic root objective `brain:objective:<id>@sha256:<intent-digest>`
- lifecycle-only `READY -> RUNNING` revisions preserve the semantic root when strategic meaning is unchanged
- semantic edits produce a new intent digest/root and stale queued work fails closed
- Brain constraints/boundaries/stop conditions become immutable Task constraints
- deterministic Task/capability-lease/Approval identities and atomic ingress settlement
- requested tools/connections cannot exceed durable leader authority
- exact request-contract digest binds leader, workspace, tools/connections, budget, hops, deadline, lease expiry, reason and Approval details
- repeated identical ingress is idempotent; changed execution/Approval terms fail with `BRAIN_INGRESS_CONFLICT`
- runtime-only `BrainObjectiveRuntimeRegistry` re-reads current Brain state immediately before execution
- direction-owner revocation, Brain disable/install invalidation, objective cancellation/supersession, parent invalidation or semantic drift blocks execution before successful Artifact publication
- durable Bots and temporary Team Run Workers share the same Brain-root freshness fence
- OpenAI-compatible runtime receives strategic intent explicitly as lower-authority read-only context
- persisted coordination state retains only bounded provenance/digests and derived Task constraints rather than a second copy of Brain canonical objects
- native Gateway exposes one Brain objective ingress command in AI-Verse mode
- standalone mode remains independent of Brain state

### 3.3 acceptance proof

Final PR-head GitHub Actions run **289** passed the full **202/202 test suite** with **0 failures, 0 canceled, and 0 skipped** on exact head `328de54dc0506437d725f2a90dd1f35efe0c0d8a`.

Phase 3.3 acceptance coverage proves:

1. Brain requires explicit direction ownership for the exact workspace
2. lifecycle-only READY-to-RUNNING revision preserves semantic root when intent is unchanged
3. fresh ingress is deterministic/idempotent and persists provenance rather than full Brain state
4. runtime execution re-reads current Brain intent and publishes only strategic provenance
5. semantic objective edits fail before runtime Artifact creation
6. objective cancellation or direction-owner revocation prevents execution
7. only READY objectives may enter and requested authority cannot exceed durable leader grants
8. native Gateway ingress remains idempotent
9. temporary Team Run Workers inherit the Brain root and revalidate current strategic intent before execution
10. repeated ingress is idempotent only for the exact requested execution and Approval contract

See `AI-VERSE-BRAIN-OBJECTIVE-INGRESS.md` for the canonical Phase 3.3 boundary.

## Ownership boundary

Phase 3.1 through 3.3 do not make Multiple Bots the source of truth for any AI-Verse OS or Brain domain state.

```text
AI-Verse OS
  owns operator/workspace/current-context/knowledge/decision/routing state

AI-Verse Brain
  owns strategic intent, initiatives, objectives, criteria and strategic lifecycle

AI-Verse Multiple Bots
  owns Bot/Worker coordination identity, Messages, Tasks, Rooms, Handoffs,
  Team Runs, coordination Artifacts/events/leases/budgets/cancellation/recovery

Phase 3 adapters
  project only the minimum scoped host/Brain data needed for execution
  and route candidate writes back through OS-owned boundaries
```

Workspace projection and current Brain strategic projection are ephemeral execution context. Multiple Bots may retain only bounded provenance needed to explain which host/Brain sources and digests informed an Artifact; it does not retain copied canonical workspace or Brain objects.

Registration also does not auto-create AI-Verse OS durable agents. Durable Multiple Bots Bots and temporary Workers remain package identities unless a later explicit adapter maps them.

## Packaging boundary

Phase 3.1 defines and implements safe registration after extension-owned files have been materialized. It deliberately does not claim the final one-command product installer. Production package materialization, clean-machine install and member-facing setup remain Phase 5 responsibilities.

## Next gate

**Phase 3.4 - Memory context/recall adapter.**

The next slice must let durable Bots and temporary Workers request bounded, workspace-correct historical recall from AI-Verse Memory without moving Memory ownership into the coordination database. Retrieval must be explicit, provenance-bearing, authority-scoped and safe for both standalone/no-Memory mode and AI-Verse native mode.
