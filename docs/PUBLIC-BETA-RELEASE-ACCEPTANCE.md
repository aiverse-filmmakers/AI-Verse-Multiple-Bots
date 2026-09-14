# Public-Beta Release Acceptance

**Phase:** 5.14

**Component:** AI-Verse Multiple Bots

**Candidate package:** `@ai-verse/multiple-bots@0.1.0-beta.1`

**Status:** IMPLEMENTATION COMPLETE, HOSTED ACCEPTANCE PENDING

## Purpose

Phase 5.14 is the final component release gate.

It does not add another product subsystem. It proves that the completed coordination engine, runtime interoperability layer and all Phase 5 product surfaces remain compatible together as one installable public-beta component.

The machine-readable contract is:

```text
evals/public-beta-release-acceptance.json
```

The dedicated executable evaluation is:

```bash
npm run eval:release
```

The complete local release gate is:

```bash
npm run release:check
```

which runs:

```text
npm test
npm run eval:phase4
npm run pack:check
npm run eval:release
```

Hosted CI runs the same four gates as explicit steps.

## What this gate certifies

The Multiple Bots component gate certifies:

- coordination-core behavior;
- durable Bot and temporary Worker separation;
- delegation, Handoff, Approval and ownership semantics;
- workspace isolation and authority non-expansion;
- execution queue, cancellation and recovery;
- supported runtime-adapter compatibility;
- standalone installation;
- AI-Verse OS installation/attachment;
- setup/onboarding;
- starter Bot/team templates;
- production status/doctor;
- update/migration preservation;
- secure remote Gateway behavior;
- Dashboard projection/control;
- Telegram/Discord/generic channel bridge contracts;
- operator attention and Approval UX;
- operational observability and usage projection;
- AI-Verse Token telemetry/pricing ownership boundary;
- packaged public-beta documentation and runnable examples;
- whole logical message idempotency;
- clean packed installation.

## What this gate does not certify

This repository must not overclaim a whole-system release.

The following remain separate release operations/gates:

- npm registry publication;
- immutable Git release tagging;
- whole Agent profile composed acceptance;
- Distribution Agent release-set promotion.

The full Agent profile is owned by AI-Verse System + Distribution acceptance because it composes Multiple Bots with OS, Brain, Memory, Skills, Data, Connections, Automations, Gateway and Token.

A green Multiple Bots 5.14 result means:

> The Multiple Bots component is ready to be included in that composed Agent release set.

It does not mean the composed Agent release set has already passed.

## Canonical ownership frozen by this gate

Multiple Bots canonically owns coordination, including:

- Bot coordination identity;
- Rooms and Threads;
- Messages and delivery state;
- Tasks;
- Handoffs;
- Team Runs;
- temporary Workers;
- coordination Approval lifecycle;
- coordination Artifact references;
- coordination Events;
- execution queue/recovery state;
- execution-local budgets and settlement evidence.

It does not become canonical owner of:

| Concern | Canonical owner |
| --- | --- |
| workspace state / outer policy | AI-Verse OS |
| intent / goals / strategy | AI-Verse Brain |
| durable historical memory | AI-Verse Memory |
| reusable capabilities / trust | AI-Verse Skills |
| structured data / schemas / transactions | AI-Verse Data |
| credentials / external connection authority | AI-Verse Connections |
| schedules / triggers / recurring policy | AI-Verse Automations |
| visual presentation | AI-Verse Dashboard |
| normalized telemetry / pricing / AI cost truth | AI-Verse Token |

### Data boundary

The component release gate does not invent a second structured-data engine or open AI-Verse Data storage directly.

Whole-Agent acceptance is responsible for proving that Data structured truth works in the complete Agent profile.

If Multiple Bots requires Data-backed information in a composed system, the integration must use the supported owner/host boundary. A future direct convenience adapter must remain a projection/query boundary and may not move canonical Data ownership into this repository.

This resolves the old audit concern without solving it by duplication.

### Token boundary

Multiple Bots keeps only execution-local usage needed for:

- coordination limits;
- Team Run budgets;
- runtime settlement;
- operational observability.

Public observability labels runtime monetary data:

```text
runtime_reported_cost_evidence
```

It explicitly reports:

```text
canonical_telemetry_owner = ai-verse-token
canonical_cost_truth_owner = ai-verse-token
token_projection_interface = @ai-verse/token/gateway
runtime_usage_is_canonical_token_truth = false
prices_model_usage_here = false
```

AI-Verse Token remains canonical for immutable normalized telemetry, pricing evidence and `ACTUAL / CALCULATED / UNKNOWN` cost truth.

## Final idempotency repair

The final release audit found one genuine old defect that could not be waived:

> Reusing a direct-message idempotency key could deduplicate only the Event while allowing a second Message identity.

Phase 5.14 repairs this at the coordination-store transaction boundary.

For an idempotent Message mutation, one SQLite `BEGIN IMMEDIATE` transaction now covers:

- Message identity/content;
- direct-message delivery when applicable;
- coordination Event;
- idempotency fingerprint/result.

Exact replay returns the original logical result.

Semantic drift under the same idempotency key fails closed.

Room/Thread replay also stops before Bot speaker scheduling, so one retried channel or Room input cannot create a second Task fan-out.

The release suite tests this across a database restart.

## Control-plane security interpretation

The historical audit also identified unauthenticated caller identity as unsafe for remote exposure.

Current public-beta behavior closes the declared remote threat-model gap by enforcing:

- loopback-only direct Gateway listeners;
- rejection of direct non-loopback HTTP binds;
- Tailscale Serve for managed remote transport;
- bearer authentication on the entire managed remote Gateway;
- no unauthenticated health/control bypass;
- external channel adapter verification before channel admission.

Local loopback access is still a local-process trust boundary.

The component does not claim hosted multi-user identity/RBAC.

## Version promotion

The repository package/extension version is promoted from alpha to:

```text
0.1.0-beta.1
```

This version promotion means the source tree is a public-beta **component candidate**.

It does not claim:

- npm publication;
- an immutable Git tag;
- Agent Distribution promotion.

Those require separate external release evidence.

## Acceptance manifest

The machine-readable manifest freezes:

- all 14 Phase 5 slices;
- component vs composed-system scope;
- canonical ownership boundaries;
- security/release laws;
- required evidence tests;
- required package files;
- required CI steps;
- intentionally unclaimed external release operations.

The dedicated release evaluation fails if these drift.

## Stop rule

After Phase 5.14 passes on the final merged `main` commit, this repository should not reopen the first public-beta architecture for ordinary new ideas.

New work belongs to the next release unless it demonstrates:

- a security vulnerability inside the declared threat model;
- data loss or corruption;
- authority/isolation failure;
- broken install/setup/update path;
- current-generation sibling incompatibility;
- failed acceptance evidence.

This is the component-level application of the AI-Verse public-beta stop rule.
