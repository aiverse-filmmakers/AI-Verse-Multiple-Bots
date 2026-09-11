# AI-Verse OS Write Command Boundary

**Phase:** 3.7

**Status:** COMPLETE

**Multiple Bots contract:** request canonical-owner writes through the AI-Verse OS write-command boundary without directly mutating OS-owned truth.

## 1. Ownership rule

Phase 3.7 establishes transport and authority separation only.

```text
AI-Verse Multiple Bots
  owns coordination state
  may request an owner-controlled write
  does not write OS canonical files directly

AI-Verse OS
  owns the write-command boundary
  validates scope, request binding, permission and idempotency
  queues the request under disposable OS runtime state

Later owner handlers
  perform any actual canonical mutation
  must re-check authority at the effect boundary
```

The host contract was added and merged in AI-Verse OS PR #16 as:

```text
28162ea386708b09d565101f902acc3b5b88d150
```

Its post-merge OS gates passed the write-command workflow, Direction Ownership, OS/Brain permission contract, Repository QC and Four Repo Acceptance.

## 2. Native owner boundary

The OS-owned module is:

```text
scripts/write-command.mjs
```

Provider identity:

```text
ai-verse-os/write-command-v1
```

Multiple Bots discovers this capability additively in native AI-Verse OS mode.

An older otherwise-compatible OS host without this script still supports all pre-3.7 native Multiple Bots features. Only the new write-command endpoint is unavailable.

## 3. Multiple Bots command surface

Native Multiple Bots exposes:

```text
POST /v1/os/write-commands
```

The request includes:

- requesting durable Bot or temporary Worker
- exact scope
- symbolic operation
- bounded structured parameters
- idempotency key
- reason
- creation timestamp
- optional bounded Task, Team Run and Artifact provenance references

The API accepts symbolic owner requests, not arbitrary filesystem paths.

## 4. Principal scope

A write-command request must come from a registered coordination principal.

### Durable Bot

A durable Bot must be active.

For a workspace-scoped command:

- Bot scope must be that exact workspace;
- stored Bot workspace identity must match;
- the command scope cannot widen beyond it.

For an operator-scoped command:

- the durable Bot itself must be operator-scoped.

### Temporary Worker

A Worker must be active in the exact workspace.

A temporary Worker cannot request an operator-scoped OS write.

This prevents temporary run identity from escaping its run/workspace authority boundary.

## 5. Immutable request binding

Multiple Bots creates a deterministic request from:

- schema
- request ID
- exact scope
- symbolic operation
- canonicalized parameters
- idempotency key
- requesting principal
- reason
- creation timestamp
- provenance

The exact request is bound by SHA-256.

The serialized request envelope is bounded to 128 KiB before host dispatch.

The same principal + scope + idempotency identity derives one local receipt Artifact identity.

## 6. Host dispatch

The native adapter:

1. revalidates AI-Verse OS compatibility;
2. validates the exact OS write-command module path;
3. rejects symlinked or out-of-root host modules;
4. invokes the OS-owned module shell-free;
5. sends the immutable request over child stdin;
6. bounds subprocess output/time;
7. validates the returned host receipt.

Multiple Bots never opens or edits an OS canonical user-state file during this path.

## 7. Host receipt requirements

A valid host receipt must prove:

- provider: `ai-verse-os/write-command-v1`
- schema: `1.0`
- status: `queued`
- exact request ID/fingerprint
- exact idempotency key
- exact scope
- exact operation
- exact requesting principal
- host permission decision `allow`
- permission binding to the same request fingerprint/scope
- action class `write_local_reversible`
- `effect_occurred: false`
- `canonical_effect_occurred: false`
- queue state `pending_handler`
- `canonical_handler_dispatched: false`

The boundary validates these semantics even for non-native/custom `OsWriteCommandSink` implementations.

A host cannot claim a canonical mutation occurred through Phase 3.7 and still be accepted.

## 8. Why enqueue is write_local_reversible

The Phase 3.7 OS write-command operation writes only disposable OS runtime state:

```text
runtime/write-commands/
  queue/
  receipts/
```

It does not perform the requested canonical mutation.

Therefore enqueue is evaluated as `write_local_reversible`.

This is not a durable authorization grant.

A later canonical owner handler must separately re-check:

- current scope state
- current owner
- applicable permission policy
- Approval requirements
- durable idempotency
- candidate validity
- any domain-specific promotion rules

immediately before a canonical effect.

## 9. Local Multiple Bots receipt

After the OS accepts a command, Multiple Bots stores one coordination Artifact of kind:

```text
os_write_command_receipt
```

It stores bounded provenance only:

- request ID/fingerprint
- request-contract digest
- scope
- operation
- idempotency key
- parameter digest
- OS command ID/provider/status
- OS queue timestamp/replay status
- source Task/Run/Artifact references
- `canonical_effect_occurred: false`

The actual parameter content is not copied into the local receipt Artifact.

This prevents the coordination layer from becoming a second canonical knowledge/decision store.

## 10. Replay semantics

The OS runtime queue is disposable by architecture.

Therefore an exact repeated Multiple Bots request:

- retains one local receipt Artifact;
- recontacts the OS owner boundary;
- lets the host re-establish its runtime queue if needed;
- remains bound to the same immutable request fingerprint.

A changed operation, parameter payload or other bound contract under the same local idempotency identity fails before another host request is sent.

## 11. Provenance safety

Task, Team Run and Artifact provenance references are optional.

When supplied:

- the object must exist;
- its protocol kind must match;
- its workspace must match the command scope;
- workspace provenance cannot cross workspace boundaries;
- operator-scoped requests cannot cite workspace-owned coordination records as operator truth.

Up to 32 Artifact references are accepted per command.

## 12. Standalone and older-host behavior

Standalone Multiple Bots has no implicit OS write authority.

Without an installed native OS write-command contract:

- all ordinary coordination remains available;
- the write-command endpoint fails closed;
- no direct fallback filesystem write is attempted.

This is deliberate. Missing owner infrastructure must not cause the coordination layer to invent ownership.

## 13. Failure semantics

Phase 3.7 fails closed for conditions including:

- incompatible host
- absent write-command module
- unsafe/symlinked host module
- invalid scope
- inactive or unregistered principal
- Worker operator-scope escalation
- cross-workspace provenance
- malformed or oversized request
- semantic drift under an existing idempotency identity
- subprocess timeout/failure
- malformed host JSON
- receipt/request mismatch
- forged permission binding
- receipt claiming a canonical effect occurred

## 14. Phase boundary

Phase 3.7 intentionally does **not** decide whether a candidate should become:

- current context
- durable knowledge
- a settled decision
- Memory
- a capability/skill candidate
- any other canonical owner state

It only creates the safe owner-controlled transport boundary.

Candidate knowledge/decision routing and canonical promotion are Phase 3.8.

## 15. Acceptance proof

Host-side AI-Verse OS contract:

- OS PR #16 merged as `28162ea386708b09d565101f902acc3b5b88d150`
- post-merge OS Write Command Boundary: PASS
- post-merge Direction Ownership: PASS
- post-merge OS Brain Permission Contract: PASS
- post-merge Repository QC: PASS
- post-merge Four Repo Acceptance: PASS

Multiple Bots hardened implementation gate:

- exact head: `1a823c0f0885c455d8e5a44c2ede29f45fac1864`
- CI run 34655489289
- **263/263 tests passed**
- 0 failures
- 0 canceled
- 0 skipped
- 0 unresolved review threads

Dedicated acceptance coverage proves:

1. request identity/fingerprint are deterministic and exact;
2. parameters are sent to the owner but not copied into the local receipt;
3. exact replay refreshes disposable host runtime state;
4. semantic drift conflicts before a second host command;
5. Bot and Worker scope cannot widen;
6. operator scope requires an operator-scoped durable Bot;
7. provenance cannot cross scope;
8. native module paths are containment/symlink checked;
9. older hosts remain usable without implicit write fallback;
10. native HTTP write-command routing is additive;
11. all host receipts are independently validated;
12. forged canonical-effect receipts are rejected;
13. request envelopes are bounded before dispatch;
14. the full pre-existing coordination/Brain/Memory/Skills/Automations suite remains green.
