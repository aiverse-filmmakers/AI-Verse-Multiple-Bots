# Hermes Runtime Adapter

**Phase:** 4.2

**Status:** COMPLETE

## Purpose

Phase 4.2 lets a durable Multiple Bots Bot or temporary Worker execute an already-authorized Task through a locally installed Hermes Agent runtime without making Hermes the owner of Multiple Bots coordination state.

The adapter targets Hermes Agent's documented TUI Gateway JSON-RPC protocol over stdio.

Multiple Bots remains authoritative for:

- Bot / Worker identity
- workspace scope
- Task ownership and constraints
- capability and environment leases
- Approval state
- budgets and deadlines
- cancellation
- local Artifact publication
- recovery bookkeeping

Hermes remains the execution runtime.

## Why stdio instead of the Hermes remote API

Current Hermes Agent exposes several programmatic surfaces, including:

- ACP
- TUI Gateway JSON-RPC over stdio or WebSocket
- HTTP API server / durable runs

Phase 4.2 deliberately uses the local stdio TUI Gateway:

```text
python -m tui_gateway.entry
```

The HTTP peer/run API normally introduces bearer authentication and remote-host identity. Those concerns belong to Phase 4.6.

The WebSocket surface also introduces connection/reconnect ownership that belongs to later Phase 4 work.

Using stdio therefore gives Phase 4.2 a real Hermes integration while preserving the canonical roadmap boundaries.

## Runtime configuration

A Bot or Worker may use:

```json
{
  "adapter": "hermes",
  "profile": "worker",
  "python": "python3",
  "hermes_root": "/path/to/hermes-agent",
  "hermes_home": "/home/user/.hermes",
  "cwd": "/path/to/task/workspace",
  "startup_timeout_ms": 60000,
  "rpc_timeout_ms": 30000
}
```

Only `adapter` is structurally required by Multiple Bots.

The runtime process resolves Python in this order:

1. explicit `runtime.python`
2. `HERMES_PYTHON`
3. `PYTHON`
4. `python3`

`profile` is optional and must be a simple Hermes profile name.

`hermes_root`, `hermes_home`, and `cwd` are optional local runtime configuration.

No shell is used to spawn Hermes.

## Process lifecycle

Phase 4.2 uses one isolated TUI Gateway subprocess per local Task.

Execution flow:

```text
spawn tui_gateway.entry
  -> wait for gateway.ready
  -> session.create
  -> wait for built session.info
  -> verify live authority
  -> prompt.submit
  -> consume gateway events
  -> message.complete
  -> session.close
  -> terminate local gateway process
```

The Hermes session is created with:

- source `ai-verse-multiple-bots`
- hidden `true`
- close-on-disconnect `true`
- a bounded Task-derived title
- optional explicit Hermes profile

Hermes may persist its own runtime/session history according to its own session semantics. That history remains Hermes-owned runtime state and is never promoted to canonical Multiple Bots state.

## Live capability verification

Prompt text is not treated as a permission boundary.

Before the delegated Task is submitted, the adapter waits for Hermes's real built `session.info` event.

The adapter then inspects the live resolved Hermes tool functions.

Every live Hermes tool function must be explicitly present in the local Multiple Bots capability lease.

The lease may name a Hermes tool either as:

```text
read_file
```

or:

```text
hermes:read_file
```

If Hermes exposes even one live tool function outside the local lease, execution fails with:

```text
HERMES_CAPABILITY_LEASE_VIOLATION
```

The prompt is never submitted.

This check is against the built live session rather than profile configuration files, so it also sees dynamically resolved tool surfaces.

## No Hermes profile mutation

Hermes exposes `tools.configure`, but that operation persists profile configuration and rebuilds the session agent.

Phase 4.2 does not use it.

The adapter never silently disables/enables Hermes profile toolsets to make a Task fit its lease.

Instead:

- Hermes profile remains user-owned
- Multiple Bots capability lease remains coordination-owned
- incompatible authority fails closed

This avoids surprising persistent changes to the user's Hermes installation.

## Approval boundary

The Hermes session must report:

```text
yolo = false
approval_mode = manual
```

Any YOLO or non-manual approval mode fails before `prompt.submit`.

During execution, these Hermes events are never auto-answered:

- `approval.request`
- `clarify.request`
- `sudo.request`
- `secret.request`
- `vault.unlock.request`

If one occurs, the adapter requests `session.interrupt` and fails the local runtime call with `HERMES_INTERACTION_REQUIRED`.

This prevents the runtime adapter from inventing approval, secret, sudo, or clarification authority.

A later product/operator UX may surface these interactions, but Phase 4.2 does not.

## Execution envelope

The Hermes prompt is a bounded JSON execution envelope:

```text
ai-verse-multiple-bots/hermes-runtime-envelope-v1
```

It carries:

- local principal id and kind
- workspace id
- local Task id
- Team Run id when present
- root objective id
- objective
- required constraints
- expected output
- capability lease id
- already-granted tools and connections
- destructive-action policy
- environment lease id
- runtime-only workspace projection
- runtime-only strategic intent
- explicit historical recall
- explicitly resolved task Skills
- bounded input Artifacts

The envelope explicitly states that returned Hermes content cannot expand authority.

## Bot and Worker identity

Hermes is an execution host, not an identity replacement.

A durable Bot remains the local principal when Hermes performs its Task.

A temporary Worker remains a temporary Worker.

The returned local Artifact records the original execution principal kind.

No Hermes session/profile is automatically registered as a durable Multiple Bots Bot.

## Completion

Phase 4.2 accepts only the documented `message.complete` terminal event for the exact runtime session.

The event must report:

```text
status = complete
```

The final visible `text` becomes the local runtime result.

Hermes reasoning payloads are deliberately not copied into the Multiple Bots Artifact or runtime receipt.

A successful Hermes Task produces local Artifact kind:

```text
hermes_task_result
```

## Usage and budgets

Hermes `message.complete.usage` is mapped into the existing Multiple Bots usage contract:

- `input` -> input tokens
- `output` -> output tokens
- `cost_usd` -> cost
- model-call count plus observed Hermes tool-start events -> actions

The existing Multiple Bots runner remains responsible for enforcing Task and Team Run budgets.

Invalid negative/non-finite usage fails closed.

## Cancellation

Local cancellation remains authoritative.

Once a Hermes session exists, `cancel(taskId)` best-effort requests:

```text
session.interrupt
```

for that exact session.

The local AbortController and stdio process are then stopped without waiting for Hermes to decide whether cancellation should be allowed.

Remote/runtime latency therefore cannot block local Task cancellation.

## Provenance

The runtime receipt stores bounded execution metadata only:

- adapter id
- stdio TUI Gateway transport
- JSON-RPC protocol
- Hermes stored session id
- selected profile name
- model/provider
- Hermes version
- observed live tool count
- tool event count
- manual approval mode
- local principal kind
- local Task id
- remote-auth support state

It does not copy:

- workspace projection text
- Brain intent text
- Memory recall text
- Skill instructions
- input Artifact content
- Hermes tool names
- secrets
- hidden reasoning

## Stdio protocol safety

The default transport:

- spawns with `shell: false`
- reads newline-delimited JSON-RPC frames
- uses numeric request ids
- maps JSON-RPC errors to explicit runtime errors
- bounds each protocol line to 4 MiB
- bounds stderr retention
- applies bounded startup and RPC timeouts
- fails pending requests/event waits if the Hermes process exits unexpectedly

The Task payload sent to Hermes is limited to 512 KiB.

## Remote boundary

Phase 4.2 explicitly rejects runtime fields that would turn the local adapter into an ad hoc remote client, including:

- endpoint / URL / host / port
- API key / token / Authorization
- API-key environment handles
- custom headers
- SSH
- WebSocket URLs

Remote Hermes identity/authentication remains Phase 4.6.

Remote capability/environment lease enforcement remains Phase 4.7.

Disconnect/reconnect/retry semantics remain Phase 4.8.

## Acceptance proof

The implementation head `9bfbbcb2b8ea022310bd1d6695742e8d9613bea4` passed GitHub Actions **CI run 394 (`34710676926`) with 304/304 tests**, **0 failures, 0 canceled and 0 skipped**.

Acceptance coverage proves:

1. the documented Hermes TUI Gateway stdio RPC contract executes a Task
2. durable Bot identity remains local and canonical
3. temporary Worker identity is preserved without promotion
4. live Hermes tool functions must fit inside the local capability lease before prompt submission
5. prefixed `hermes:<tool>` lease references work without widening authority
6. YOLO/non-manual Hermes approval modes fail before execution
7. runtime approval/clarification/sudo/secret/vault prompts are never auto-approved
8. Hermes remote error events cannot become successful local Artifacts
9. remote/auth configuration fails closed because it belongs to later Phase 4 slices
10. local cancellation targets the exact Hermes session
11. the real stdio parser handles newline JSON-RPC and spawns with `shell: false`
12. bounded provenance excludes projected context, Artifact content and tool names
13. Hermes usage is mapped into existing budget accounting
14. the Gateway registers `hermes` as a normal host-neutral runtime
15. all pre-existing Phase 0-4.1 tests remain green

## Non-goals

Phase 4.2 does not:

- implement OpenClaw
- implement Codex/Claude Code process adapters
- create external managed Bot identity semantics
- implement remote Hermes identity/authentication
- implement remote capability/environment leases
- implement reconnect/disconnect/retry recovery
- mutate Hermes profile tool configuration
- auto-answer Hermes runtime approvals or secret prompts
- begin Phase 5
