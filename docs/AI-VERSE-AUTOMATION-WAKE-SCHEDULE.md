# AI-Verse Automations Wake/Schedule Integration

**Phase:** 3.6

**Status:** COMPLETE

**Contract:** host-owned cadence invoking the Multiple Bots coordination boundary

## 1. Purpose

Phase 3.6 lets AI-Verse OS Automations wake a durable Bot or open a bounded Team Run without turning Multiple Bots into a scheduler.

The ownership split is:

```text
AI-Verse OS Automations
  owns schedules, triggers, routines, retry/failure policy,
  automation approval policy, kill switches and automation-run history

AI-Verse Multiple Bots
  owns the coordination work created after one automation invocation:
  Tasks, Team Runs, Workers, leases, Approvals, execution, cancellation,
  recovery and coordination evidence
```

Multiple Bots does not parse cron, RRULEs, timers, filesystem watches, recurring schedules or event-source subscriptions in Phase 3.6.

## 2. Receive-side invocation contract

The host automation layer invokes the native endpoint:

```text
POST /v1/automations/invoke
```

The invocation carries:

- `automationId`: canonical automation identity
- `invocationId`: unique identity for this fired occurrence
- `workspaceId`: exact target workspace
- `firedAt`: host fire timestamp
- `source.kind`: `job` or `trigger`
- `source.path`: canonical AI-Verse OS automation definition path
- `source.digest`: SHA-256 of the exact UTF-8 source text at fire time
- one target: durable Bot wake or bounded Team Run start
- the bounded coordination request for that target

The host owns generation of `invocationId`. Re-delivery of the same invocation is safe and idempotent.

## 3. Canonical automation source binding

Native AI-Verse OS mode accepts only sources under the canonical Cadence locations:

```text
automations/jobs/...
automations/triggers/...
workspaces/<exact-workspace>/automations/...
```

The adapter:

1. revalidates the exact AI-Verse OS workspace through the existing workspace projector;
2. requires the workspace to be active;
3. rejects absolute, traversal, malformed and symlinked source paths;
4. requires a bounded regular file inside the AI-Verse OS root;
5. re-hashes the current exact UTF-8 source text;
6. requires that digest to equal the digest bound to the fired invocation.

A changed, removed, moved or unsafe automation definition therefore blocks replay. This is the Phase 3.6 kill fence.

Multiple Bots persists source provenance and digests only. It never copies the automation definition into coordination state.

## 4. Deterministic invocation identity

One automation occurrence has one coordination identity:

```text
provider
+ automation_id
+ invocation_id
+ workspace_id
-> identity digest
```

That identity deterministically derives either:

- one automated Bot Task identity, or
- one automated Team Run identity.

The same invocation cannot become both.

A replay with the same identity but a different target, objective, source digest, policy-relevant field or bounded request fails with `AUTOMATION_INGRESS_CONFLICT`.

This prevents duplicate trigger delivery from creating duplicate work while refusing silent semantic drift.

## 5. Durable Bot wake

A Bot wake becomes a normal Multiple Bots Task.

The target must be:

- a registered durable Bot;
- active;
- in the exact invocation workspace.

The wake path uses the existing `CoordinationPolicy.prepareDelegation` boundary. It therefore preserves the normal enforcement of:

- workspace isolation;
- Bot tool grants;
- Bot connection grants;
- declared skill capabilities;
- Task constraints;
- hop limits;
- deadlines;
- root-objective budgets;
- duplicate/loop protection.

The created `capability_lease` contains only execution authority already allowed by the target Bot and Task request.

Skills remain method references and do not become permission.

Historical Memory recall remains an explicit Task request and uses the existing Phase 3.4 runtime boundary.

## 6. Approval behavior for Bot wakes

An automated Bot Task may require a normal Multiple Bots Approval.

When approval is required:

- the Task enters `waiting_approval`;
- no execution queue item is created;
- the existing Approval object is created;
- only the existing operator Approval command can release the Task;
- rejection follows the existing Task cancellation path.

The automation invocation therefore does not bypass or manufacture approval.

## 7. Recovery behavior for Bot wakes

A Bot wake may choose the existing Task recovery policy:

- `manual`
- `retry_safe`

The queue and recovery coordinator remain the source of execution-attempt state.

The automation layer does not own Task execution retries after successful ingress. It may safely redeliver the same invocation if delivery acknowledgement is uncertain because deterministic ingress is idempotent.

## 8. Team Run start

A Team Run invocation opens coordination state only.

It does **not** create:

- a Task;
- a capability lease;
- an Approval;
- a queue item;
- a Worker.

The durable leader must be active in the exact workspace and allowed to create temporary Workers.

Automated Team Run creation requires explicit hard bounds for:

- `max_workers`
- `max_tasks`
- `max_actions`
- `wall_clock_seconds`
- `max_hops`

Supported Team Run topologies are bounded squad topologies. `single` is not accepted as a Team Run target because a single-agent automated action should use the Bot wake path.

## 9. Task fields are forbidden on Team Run creation

The Team Run start endpoint deliberately rejects Task-only execution fields such as:

- Task constraints
- Memory recall
- skill refs
- tools
- connections
- expected output
- Task deadlines
- lease expiry
- Task recovery policy
- Task max attempts

Those fields would be misleading on a Team Run because later Worker Tasks have their own explicit leases and execution contracts.

A later Worker, verifier, discussion turn or synthesis Task must receive its execution requirements through the existing Team Run Task creation surfaces where those requirements are actually enforced.

This keeps run creation as coordination state instead of a shadow authority store.

## 10. Team Run start approval

Phase 3.6 does not invent a new run-level Approval object.

If the owning AI-Verse OS automation policy requires human approval before starting a Team Run, that approval must be resolved by the host automation layer before it calls Multiple Bots.

An invocation that still declares unresolved run-start approval fails closed with `AUTOMATION_APPROVAL_REQUIRED`.

Any later executable Task inside the Team Run continues to use normal Multiple Bots Task Approval and capability-lease enforcement.

## 11. Provenance retained by Multiple Bots

For an accepted invocation, Multiple Bots retains bounded provenance such as:

- provider/schema
- automation ID
- invocation ID
- fired timestamp
- source kind/ref/path/scope
- source SHA-256
- projection digest
- deterministic invocation identity digest
- exact request-contract digest
- target kind

The full automation source body, cron expression ownership, trigger state and automation history remain outside Multiple Bots.

## 12. Standalone behavior

Standalone Multiple Bots does not expose implicit automation ownership.

Without native AI-Verse OS mode:

- ordinary coordination works normally;
- `POST /v1/automations/invoke` fails closed;
- no scheduler, watcher or network automation service is started.

## 13. Failure semantics

Phase 3.6 fails closed for conditions including:

- incompatible or inactive workspace
- missing automation definition
- stale source digest
- source path traversal or symlink
- source outside the permitted automation roots
- malformed projection or forged projection digest
- inactive/unregistered/cross-workspace Bot target
- requested Bot authority above durable grants
- undeclared Bot skill
- unresolved Bot Task Approval
- unbounded Team Run
- leader unable to create Workers
- unresolved Team Run start approval
- Task-only fields supplied to Team Run creation
- same invocation replayed with a different contract
- same invocation changed from Bot wake to Team Run or vice versa

## 14. Acceptance proof

Implementation gate:

- exact code head: `f94daaa9cc98f5356d8a77d90905867ac0034528`
- GitHub Actions CI run 34518046084: **254/254 tests passed**
- 0 failures
- 0 canceled
- 0 skipped
- 0 unresolved PR review threads

Dedicated Phase 3.6 coverage proves:

1. shared jobs, shared triggers and exact-workspace automation sources are source-bound;
2. paused workspace state blocks automation ingress;
3. source digest drift, traversal and symlink sources fail closed;
4. Bot wake creates exactly one deterministic Task/lease with no source-body persistence;
5. duplicate delivery is idempotent;
6. one invocation cannot drift its request contract;
7. one invocation cannot switch target mode;
8. Bot Task Approval remains mandatory and prevents queueing until approved;
9. Bot wake cannot expand tool/connection/skill authority;
10. Bot target must be an active durable Bot in the exact workspace;
11. Team Run start creates coordination state only, not executable authority;
12. Team Run start requires explicit hard budget bounds;
13. Team Run start requires a leader allowed to create Workers;
14. unresolved run-start approval fails closed;
15. Team Run start rejects Task-only execution fields;
16. changed canonical automation source blocks replay as a kill fence;
17. the HTTP surface exists only in native AI-Verse OS mode;
18. the full pre-existing coordination, recovery, squad, workspace, Brain, Memory and Skills suite remains green.

## 15. Non-goals

Phase 3.6 does not implement:

- cron parsing
- RRULE parsing
- timers
- polling
- filesystem watchers
- external event subscriptions
- automation definition authoring
- automation-run history
- automation retry scheduling
- notification routing
- host automation approval storage
- a second cadence database

Those remain AI-Verse OS Automations responsibilities.
