# AI-Verse Brain Objective Ingress Contract

**Status:** Phase 3.3 canonical integration contract

**Updated:** 2026-09-10

## Purpose

This contract lets AI-Verse Brain supply strategic objectives to AI-Verse Multiple Bots without making Multiple Bots a second Brain state store.

AI-Verse Brain remains canonical for strategic intent, initiatives, objectives, criteria, progress and lifecycle. Multiple Bots owns only the coordination records needed to execute approved work: Bots, Workers, Tasks, Team Runs, leases, Approvals, coordination Artifacts and events.

## Authority boundary

Brain objective ingress is allowed only when all of the following are true:

1. the host is a compatible AI-Verse OS v2 `unified-workspace` installation;
2. `AI-VERSE.yaml` explicitly marks the Brain extension as supported and enabled;
3. `operator/brain/installation.json` is a supported AI-Verse OS v2 Brain installation marker;
4. `.aiverse/direction/ownership.json` explicitly assigns `owner: "brain"` to the exact `workspace:<id>` scope;
5. the requested Brain objective belongs to that exact workspace;
6. the objective is `READY` for fresh ingress;
7. its strategic parent is still executable;
8. the selected durable Bot leader is active, belongs to the same workspace and already has every requested tool/connection authority.

Absence of explicit Brain ownership is not treated as permission. The adapter fails closed.

## What may enter coordination

A Brain objective is projected into a bounded execution view containing only the strategic fields needed to do the work, including:

- objective/outcome;
- verification criteria and verification level;
- constraints;
- boundaries;
- stop conditions;
- dependencies and risks;
- bounded Brain retry budget metadata;
- the serving initiative or intent summary;
- source references, revisions and SHA-256 digests.

The source files remain canonical in the AI-Verse OS workspace.

## Semantic root objective

Every accepted Brain objective is bound to a deterministic semantic root:

```text
brain:objective:<objective-id>@sha256:<intent-digest>
```

The digest is computed from the bounded strategic meaning of the objective, not from lifecycle-only fields.

Therefore:

- `READY -> RUNNING` with unchanged intent keeps the same root objective;
- a material objective/criteria/constraint/parent-intent edit produces a different semantic root;
- every descendant Task, Worker and Team Run can preserve the Brain lineage without copying the full Brain object.

## Fresh-ingress rule

Only a Brain objective in `READY` state may create new coordination work.

Ingress creates one deterministic Task identity and its associated capability lease. If approval is required, the Approval is created in the same bounded contract and the Task remains non-executable until approved.

The operation is idempotent only when the requested execution contract is exactly the same.

The request-contract digest binds:

- durable leader;
- workspace;
- requested tools and connections;
- budget;
- hop ceiling;
- deadline;
- lease expiry request;
- execution reason;
- approval requirement, reason and action.

A later call cannot reuse the same Brain Task while silently changing any of those terms. A conflicting repeat fails with `BRAIN_INGRESS_CONFLICT` and creates no duplicate work.

## Execution-time freshness rule

Ingress approval does not grant permanent permission to execute stale Brain intent.

Immediately before a Brain-rooted Task reaches its runtime, the native Brain runtime adapter re-reads the current canonical Brain state and requires:

- the same workspace;
- the same Brain objective identity;
- the same semantic intent digest;
- current Brain direction ownership of the workspace;
- a currently executable objective lifecycle (`READY` or `RUNNING`);
- a currently executable parent initiative/intent;
- a valid enabled Brain installation/registration.

If the objective is edited materially, canceled, superseded, loses its executable parent, Brain is disabled, or workspace direction ownership changes, execution fails before a successful Artifact can be published.

This rule applies to both durable Bots and temporary Team Run Workers because descendants preserve the same semantic root objective.

## Runtime context vs persisted state

The current bounded strategic projection may be supplied to the runtime so the model understands why the Task exists and what success means.

That projection is runtime-only context. Multiple Bots persists only bounded coordination data and provenance needed for audit, such as:

- Brain provider/schema;
- objective/parent references;
- source revisions;
- source digests;
- semantic intent digest;
- exact request-contract digest;
- immutable derived Task constraints;
- runtime provenance receipts.

It does not persist a second copy of Brain's canonical initiative/objective JSON merely because the model saw it.

## Native Gateway surface

When the Gateway is started in AI-Verse native mode with an OS root, the Brain ingress adapter is available through the native HTTP boundary.

The Gateway performs the same source, ownership, policy, authority, idempotency and freshness checks as the programmatic adapter. Standalone mode does not invent or require Brain state.

## Failure law

Brain integration is fail-closed. Invalid/missing host state, path escape, symlinked canonical state, oversized source data, scope mismatch, unsupported registration/install metadata, stale semantic intent, revoked ownership or a changed re-ingress contract must stop execution rather than guess.

No failure may silently promote Brain state into Multiple Bots ownership.

## Phase 3.3 acceptance

The hardened Phase 3.3 PR-head package gate passed **202/202 tests** with **0 failures, 0 canceled and 0 skipped** on GitHub Actions run **285**.

The Phase 3.3 coverage proves:

- explicit workspace-level Brain direction ownership;
- semantic-root stability across lifecycle-only revision;
- deterministic/idempotent ingress with provenance-only persistence;
- runtime re-read and stale-intent rejection;
- cancellation and ownership-revocation fencing;
- authority ceilings against the durable leader;
- native Gateway ingress behavior;
- temporary Worker inheritance and execution-time Brain revalidation;
- exact re-ingress contract binding across deadline, hop, lease and Approval terms.

## Non-goals

Phase 3.3 does not:

- make Brain a durable Bot;
- let Multiple Bots edit Brain canonical objects directly;
- make initiatives themselves executable Tasks;
- create a second strategic planner inside the coordination database;
- implement Memory recall, Skills resolution or Automation scheduling;
- implement final Brain result/write-back semantics.

Those remain explicit later Phase 3 boundaries.
