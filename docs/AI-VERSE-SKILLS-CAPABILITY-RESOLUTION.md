# AI-Verse Skills Capability Resolution

**Phase:** 3.5

**Status:** COMPLETE

**Contract:** task-scoped capability resolution through the AI-Verse OS-owned resolver

## 1. Purpose

Phase 3.5 lets durable Bots and temporary Workers use explicitly requested reusable skill methods during execution while preserving the AI-Verse ownership boundary.

The coordination layer does not own the Skills registry, provider ranking, package lifecycle, runtime permission state, or approval policy.

The native chain is:

```text
Task declares skill_refs
  -> Multiple Bots validates task/principal scope and declared capability subset
  -> AI-Verse OS resolves the capability in the exact workspace scope
  -> selected package integrity is verified
  -> selected SKILL.md instructions are disclosed only for that execution
  -> runtime executes under the existing Task capability lease and Approval state
```

## 2. Canonical ownership

```text
AI-Verse Skills
  owns reusable skill packages, immutable generations, package metadata,
  distribution provenance and package lifecycle

AI-Verse OS
  owns capability-provider discovery, provider precedence, protected aliases,
  workspace scope, contextual availability and selection

AI-Verse Multiple Bots
  owns Bot/Worker capability declarations, Task requirements, coordination
  leases, approvals, handoffs, execution lineage and bounded receipts
```

Multiple Bots does not copy `registry/skills.json`, the Skills capability index, provider manifests, or package bodies into coordination state.

## 3. Skill references are not authority

A Bot may declare reusable methods:

```yaml
capabilities:
  skill_refs:
    - deep-research-synthesis
    - aiverse-skills:verification-harness
```

A Task may request a bounded subset:

```yaml
skill_refs:
  - deep-research-synthesis
```

These references describe the method the principal is allowed to load. They do not grant tools, connections, destructive actions, runtime readiness, or approval.

Execution authority remains the existing intersection enforced by AI-Verse OS/runtime policy and Multiple Bots capability leases.

The `capability_lease` continues to contain execution authority such as:

```yaml
tools: [...]
connections: [...]
destructive_actions: deny | approval_required | allow_by_policy
```

It does not gain `skill_refs`.

## 4. Task contract

`skill_refs` is optional and explicit.

Rules:

- maximum 12 skill references per Task;
- duplicates are normalized away;
- bare references such as `deep-research-synthesis` are permitted;
- qualified provider references such as `aiverse-skills:<id>`, `local:<id>`, and `os:<id>` are permitted;
- workspace references use `workspace:<workspace-id>:<id>`;
- a workspace-qualified reference cannot name a workspace other than the Task workspace;
- invalid, empty, oversized or NUL-containing references fail before Task creation;
- no `skill_refs` means no Skills resolution work.

Qualified requests must resolve to that exact canonical capability ID. A qualified request cannot be rebound to a different provider.

## 5. Durable Bot declaration contract

A durable Bot must declare every skill reference requested by a Task assigned to it.

This is checked when the Task is created and again immediately before runtime resolution.

The execution-time check is required because persisted coordination records may survive restarts or be modified independently of the original creation call. A Task cannot gain a new method merely because its stored `skill_refs` field changed.

## 6. Temporary Worker contract

Temporary Workers never inherit the leader's complete skill set.

Manager, fan-out, discussion, verifier and other Worker creation paths may give a Worker only an explicit run-scoped subset of the durable leader's declared skill references.

The subset is stored on the temporary Worker as:

```yaml
capabilities:
  skill_refs: [...]
```

and on the execution Task as `skill_refs`.

An omitted subset produces no Worker skill declaration.

Synthesis is executed by the durable Team Run leader rather than a Worker. Its Task may request an explicit declared skill subset under the same rules.

## 7. AI-Verse OS resolver boundary

Native mode uses the canonical AI-Verse OS capability resolver:

- `scripts/capability-resolver.mjs`
- `scripts/capability-resolver-core.mjs`

Multiple Bots calls the resolver with the exact Task workspace scope:

```text
workspace:<task-workspace-id>
```

The OS resolver remains responsible for:

- OS, distributed Skills, local and workspace provider discovery;
- provider health;
- workspace containment;
- provider precedence;
- protected OS aliases;
- qualified identity selection;
- active immutable Skills generation selection;
- package locator production.

Multiple Bots does not reproduce those algorithms.

## 8. Progressive disclosure and integrity

Only selected package instructions are loaded.

For each selected capability, the adapter:

1. receives the OS-selected package locator and `aiverse-package-sha256-v1` digest;
2. recomputes the package digest before loading instructions;
3. resolves `SKILL.md` physically inside the selected package;
4. reads that selected `SKILL.md` only;
5. recomputes the package digest after the read;
6. rejects package mutation during instruction loading;
7. applies per-skill and aggregate instruction-size ceilings;
8. computes an instruction digest and deterministic resolution digest.

Resolver files themselves must be regular non-symlink files inside the AI-Verse OS root.

## 9. Runtime and persistence

Selected skill instructions are ephemeral runtime context.

The model is told explicitly that resolved skills are method instructions and cannot override:

- the Task objective;
- immutable Task constraints;
- capability leases;
- Approval state;
- current OS workspace state;
- current Brain strategic state.

Persisted execution receipts retain bounded provenance only:

- resolver provider;
- workspace;
- request digest;
- resolution digest;
- requested and resolved capability IDs;
- provider;
- version;
- generation ID;
- package path;
- package digest;
- instruction digest.

The full `SKILL.md` text is not persisted in Multiple Bots Artifacts or receipts.

## 10. Handoff behavior

A Handoff preserves the Task's existing `skill_refs`.

Before a durable target may accept the work, the target must declare every required skill reference.

The Handoff reissues the existing capability lease authority only. It does not convert skill knowledge into tool/connection permission and does not widen Approval state.

## 11. Brain ingress

Brain objective ingress may request `skillRefs` as part of its exact execution contract.

The normalized skill set participates in the ingress request-contract digest and idempotency check.

Brain therefore cannot re-ingress the same semantic objective later with a different skill requirement and have it treated as the same execution contract.

Brain remains the owner of strategic intent. Skills resolution remains an execution method boundary.

## 12. Standalone behavior

Standalone Multiple Bots remains usable without AI-Verse OS or AI-Verse Skills.

- ordinary Tasks with no `skill_refs` execute normally;
- an explicit Task skill dependency fails closed when no capability-resolution source is configured;
- no implicit network access or package installation is attempted.

## 13. Failure semantics

Explicit capability requirements fail closed for conditions including:

- capability unavailable;
- provider degraded or unsupported for the requested capability;
- cross-workspace reference or resolved visibility;
- principal does not declare the requested skill;
- resolver missing, unsafe or incompatible;
- malformed resolver output;
- qualified-ID rebinding;
- invalid package/generation metadata;
- package digest mismatch;
- package mutation during instruction load;
- malformed or forged request/resolution digests;
- oversized instruction payload.

An absent optional Skills installation does not affect Tasks that did not request a skill.

## 14. Acceptance proof

Implementation gate:

- exact code head: `348cb30b16da5d5145e4599241702fd01b135648`
- GitHub Actions CI run 34515699163: **242/242 tests passed**
- 0 failures
- 0 canceled
- 0 skipped
- 0 unresolved PR review threads

Dedicated Phase 3.5 coverage proves:

1. explicit bounded Task skill references and workspace-qualified scope fencing;
2. no skill request invokes no capability source;
3. selected instructions reach runtime but not persisted receipts;
4. runtime resolution cannot change Task capability-lease authority;
5. durable Bot declarations are checked at creation and execution time;
6. explicit skill dependency fails closed when the source is unavailable;
7. cross-workspace resolver output is rejected before model execution;
8. request and resolution digest integrity is enforced;
9. qualified capability IDs cannot be rebound to another provider;
10. native resolution goes through the OS-owned resolver rather than the Skills registry;
11. package integrity is checked before and after instruction loading;
12. resolver and package-path symlink/escape conditions fail closed;
13. handoffs preserve skill requirements without expanding lease authority or Approval state;
14. temporary Workers receive only explicit leader-approved subsets and never auto-inherit all leader skills;
15. synthesis uses the same explicit method/authority separation;
16. standalone no-skill execution remains unchanged;
17. the complete pre-existing coordination, Memory, Brain, workspace, squad, recovery and safety suite remains green.

## 15. Non-goals

Phase 3.5 does not:

- install or update AI-Verse Skills;
- copy the Skills registry or provider index into coordination state;
- implement a second provider-ranking algorithm;
- certify live connection readiness from static Skills metadata;
- grant tools or connections from skill declarations;
- bypass approvals;
- automatically load every declared Bot skill into every turn;
- make Room chat dispatch infer a skill requirement when none was explicitly requested.

Those boundaries keep reusable knowledge separate from operational authority and keep progressive disclosure intact.
