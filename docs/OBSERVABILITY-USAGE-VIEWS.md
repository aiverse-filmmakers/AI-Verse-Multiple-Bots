# Observability and Usage Views

**Phase:** 5.12

**Status:** COMPLETE

## Purpose

Phase 5.12 exposes read-only operational and usage views from the coordination data Multiple Bots already owns.

The core rule is:

```text
Observability
  = projection of canonical coordination state + persisted usage + structured events

Observability
  != telemetry source of truth
  != billing system
  != execution authority
  != private model reasoning
  != second metrics database
```

Multiple Bots does not create a new analytics store for this slice.

## Public Gateway surfaces

### Capabilities

```text
GET /v1/observability/capabilities?workspace=<workspace-id>
```

Reports:

- provider/schema;
- available observability queries;
- usage dimensions and units;
- canonical event timeline source;
- explicit `projection_only: true`;
- explicit `observability_owns_truth: false`;
- explicit `private_reasoning_exposed: false`.

### Snapshot

```text
GET /v1/observability/snapshot?workspace=<workspace-id>&after=<cursor>&limit=<n>
```

Returns one workspace-scoped operational view containing:

- Bot, Team Run, Worker and Task counts;
- active/completed/failed Task counts;
- Task outcome/status distribution;
- execution queue state distribution;
- dead-letter and retryable-dead-letter counts;
- stale execution count;
- persisted runtime usage totals;
- per-principal usage;
- per-Team-Run usage and budget utilization;
- terminal Task latency statistics;
- compact error/attention counts;
- recent structured coordination timeline;
- current canonical event cursor.

The event limit is bounded to 1 through 500.

### Usage

```text
GET /v1/observability/usage?workspace=<workspace-id>
```

Returns the usage, latency, outcome and execution portions without returning the timeline.

Current execution-local usage units:

```text
input_tokens
output_tokens
total_tokens
runtime_reported_cost_evidence
actions
```

`runtime_reported_cost_evidence` is intentionally not called canonical cost. It is the normalized monetary value returned by the runtime execution result and persisted on the Multiple Bots Task for operational budget enforcement and settlement.

Current dimensions:

```text
workspace
principal
team_run
```

### Timeline

```text
GET /v1/observability/timeline?workspace=<workspace-id>&after=<cursor>&limit=<n>
```

Returns compact canonical coordination events with:

- sequence;
- timestamp;
- event type;
- actor;
- Task/Run/Room/Thread references;
- attention state;
- human-facing summary.

The timeline never includes private model chain-of-thought.

## Verified AI-Verse Token ownership boundary

Phase 5.12 was explicitly cross-checked against the live `aiverse-filmmakers/AI-Verse-Token` public-beta contract (`@ai-verse/token@0.1.0-beta.3`).

The verified ownership split is:

| Concern | Canonical owner |
|---|---|
| Task/Worker execution-local counters needed for coordination | Multiple Bots |
| Team Run budget enforcement and runtime settlement | Multiple Bots |
| operational token/action/cost evidence attached to a Task | Multiple Bots, as execution evidence only |
| immutable normalized telemetry ledger | AI-Verse Token |
| canonical historical/global token telemetry | AI-Verse Token |
| pricing evidence and tariff history | AI-Verse Token |
| ACTUAL / CALCULATED / UNKNOWN monetary truth | AI-Verse Token |
| model pricing calculation | AI-Verse Token |
| Bot/Worker/Run/Task telemetry attribution | Token evidence labels only, never coordination authority |

The live Token repository exposes the owner-backed read path through:

```text
@ai-verse/token/gateway
```

and its Multiple Bots helper through:

```text
@ai-verse/token/bots
```

The Token Bots helper only attaches exact Bot/Worker/Team Run/Task/workspace attribution to Token telemetry. It does not move Bot authority into Token.

Therefore Phase 5.12 obeys these laws:

1. Multiple Bots does not open or write Token's ledger.
2. Multiple Bots does not create pricing snapshots.
3. Multiple Bots does not apply tariffs.
4. Multiple Bots does not emit `ACTUAL`, `CALCULATED` or `UNKNOWN` monetary truth.
5. Multiple Bots does not reinterpret runtime-reported cost evidence as canonical AI spend.
6. Canonical historical/global telemetry or cost truth must be read from the supported Token projection, not reconstructed here.
7. Multiple Bots retains its existing budget and limit enforcement because safe coordination requires execution-local ceilings before and during work.

The public observability contract makes this machine-readable:

```text
canonical_telemetry_owner = ai-verse-token
canonical_cost_truth_owner = ai-verse-token
token_projection_interface = @ai-verse/token/gateway
runtime_usage_is_canonical_token_truth = false
prices_model_usage_here = false
writes_token_telemetry_here = false
```

Phase 5.12 does not currently request canonical historical/global Token telemetry because its scope is execution-local operational observability. If a future Multiple Bots view needs canonical historical/global usage or AI cost truth, it must consume the authorized `@ai-verse/token/gateway` projection rather than calculating the answer independently.

## Usage truth

Runtime adapters already return normalized execution usage:

```json
{
  "input_tokens": 0,
  "output_tokens": 0,
  "cost": 0,
  "actions": 0
}
```

Successful Task execution persists normalized usage on the canonical Task and Artifact.

Team Runs persist aggregate usage as work completes.

Phase 5.12 reads those values instead of inventing a separate usage ledger.

The internal runtime contract retains the field name `cost` because it is already part of Multiple Bots budget enforcement. The public observability projection renames that value to `runtime_reported_cost_evidence` so it cannot be mistaken for Token's canonical cost truth.

## Coverage honesty

The usage view explicitly reports:

- total Tasks;
- completed Tasks;
- Tasks carrying persisted usage.

It also states:

> Usage totals include only usage persisted on canonical Tasks; provider-side charges from failed calls are not inferred.

This matters because a provider may bill for a failed or interrupted call even when no trustworthy normalized usage receipt was persisted locally.

Phase 5.12 does not fabricate those charges.

## Per-principal usage

Task usage is grouped by the Task execution principal identity.

The projection includes:

- principal ID;
- runtime adapter when the canonical Bot/Worker still exists;
- Task count;
- completed Task count;
- failed Task count;
- active Task count;
- token/cost/action totals.

This is a view only. It does not create accounting ownership.

## Team Run usage and budgets

For every Team Run, the projection exposes:

- status;
- leader;
- topology;
- Task count;
- Worker count;
- usage recomputed from persisted child Task usage;
- canonical aggregate Team Run usage;
- whether the two agree;
- configured token/cost/action limits;
- utilization percentages.

A mismatch is surfaced as `usage_consistent: false`.

It is not silently repaired by the observability layer.

## Execution health

The snapshot derives execution health from the existing execution queue:

- queued;
- claimed;
- running;
- completed;
- failed;
- canceled;
- dead letter;
- Task with no queue record.

It also reports:

- dead-letter count;
- retryable dead-letter count;
- stale execution count.

Retryable means the existing recovery contract says:

- state is `dead_letter`;
- recovery policy is `retry_safe`;
- attempt ceiling has not been exhausted.

Observability itself cannot trigger a retry.

## Outcomes

Task outcome views include:

- status counts;
- terminal Task count;
- completed-terminal success rate.

Terminal status currently includes:

- completed;
- failed;
- canceled;
- timeout;
- budget exhausted;
- rejected policy.

The success rate is not presented when there are no terminal Tasks.

## Latency

For terminal Tasks with valid timestamps, the projection computes:

- sample count;
- average duration;
- minimum duration;
- maximum duration.

This is derived from canonical stored timestamps.

No timing state is written back.

## Structured timeline

The architecture requires meaningful structured progress without exposing hidden reasoning.

Phase 5.12 therefore projects the existing coordination event stream.

Examples include:

```text
task.started
worker.created
artifact.published
task.completed
approval.requested
handoff.requested
team_run.canceled
channel.egress.delivered
```

Only canonical event metadata and the existing human-facing event summary are returned.

## Workspace isolation

Every view requires one explicit workspace ID.

Tasks, Bots, Workers, Team Runs and events are filtered to that workspace.

Timeline replay uses the existing monotonic canonical event cursor and exact workspace filter.

A caller cannot request an aggregate across unrelated workspaces through this Phase 5.12 surface.

## Security and privacy

These endpoints inherit the existing Gateway transport boundary.

If the Gateway is exposed through the Phase 5.8 managed remote path, the same bearer authentication protects observability.

The views intentionally exclude:

- raw credentials;
- provider authentication material;
- arbitrary runtime receipts;
- complete Artifact contents;
- model chain-of-thought;
- hidden prompts;
- cross-workspace data.

## No Prometheus/billing claim

Phase 5.12 does not claim to be:

- a Prometheus exporter;
- a tracing backend;
- an OpenTelemetry collector;
- an invoice-grade provider billing ledger.

Those can be added later as adapters over these canonical projections if needed.

The public-beta goal is a truthful product-facing operational/usage view.

## Acceptance target

Phase 5.12 is accepted when:

- reads create no coordination mutation;
- workspace usage totals are deterministic;
- per-principal usage is deterministic;
- Team Run computed/canonical usage consistency is visible;
- budget utilization is visible;
- dead-letter/retry/stale execution health is visible;
- outcomes and terminal latency are visible;
- timeline replay is cursor-based and workspace-scoped;
- no private model reasoning is exposed;
- Token remains the explicit canonical telemetry/pricing/cost-truth owner;
- no pricing/tariff calculation exists in Multiple Bots observability;
- public monetary values are labeled runtime-reported execution evidence;
- canonical historical/global telemetry is delegated to `@ai-verse/token/gateway`;
- invalid cursor/limit inputs fail closed;
- installed-package observability smoke passes;
- full repository and Phase 4 compatibility suites remain green.


## Acceptance evidence

GitHub Actions **CI run 597 (`34810524402`)** on Token-boundary-hardened implementation head `490868288a23a43323eefe1a1707e1a086eddfd8` passed:

- **492/492** repository tests
- **5/5** Phase 4 runtime compatibility tests
- all package/install/setup/doctor/update/remote/Dashboard/channel/operator smokes
- installed-package observability/usage smoke
- explicit AI-Verse Token ownership/non-ownership assertions
- **227-file** packed artifact
- **0 failures, 0 canceled, 0 skipped**

The acceptance suite verifies that the public observability projection labels runtime monetary data as `runtime_reported_cost_evidence`, names `ai-verse-token` as canonical telemetry and cost-truth owner, points canonical historical/global reads to `@ai-verse/token/gateway`, does not expose a canonical-looking `cost` field, and contains no pricing/tariff calculation path.
