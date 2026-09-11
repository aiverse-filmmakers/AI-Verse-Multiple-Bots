# Telegram Managed Team Contract

**Status:** implementation guidance for future Hermes/Telegram integration  
**Scope:** AI-Verse Multiple Bots Phase 4 runtime interoperability and Phase 5 channel/onboarding work  
**Purpose:** preserve the routing and safety rules proven during a real multi-profile Hermes + Telegram deployment so they can be implemented correctly later without changing the current core roadmap.

## Why this document exists

AI-Verse Multiple Bots already owns the core coordination model: durable Bots, manager topology, Tasks, Handoffs, Rooms, Workers, approvals, budgets, loop protection and canonical leader synthesis.

What still needs a future implementation is the channel/runtime behavior that makes a Telegram team feel like one coordinated assistant instead of several bots competing for the same message.

This document records that behavior. It is **not** the Telegram bridge, Hermes adapter or member installer.

## Target user experience

A Telegram group contains one permanent Leader and several permanent specialist Bots.

Normal human conversation belongs to the Leader.

```text
Human
  |
  v
Leader
  |
  +--> Researcher
  +--> Strategist
  +--> Builder
  +--> Reviewer
  +--> Finisher
  |
  v
Leader synthesis
  |
  v
Human
```

The default managed-team rule is:

- an ordinary group message activates the Leader only
- specialists observe shared group context but remain silent unless deliberately activated
- an explicit specialist mention activates only that specialist
- the Leader remains accountable for the final user-facing answer unless a deliberate direct-specialist interaction is requested
- specialists should return delegated work to the Leader, not independently compete for the final response

## Reference permanent roster

A default template may use six durable roles:

| Role | Responsibility |
|---|---|
| Leader / Orchestrator | owns routing, delegation, synthesis and the final result |
| Researcher | investigates, gathers evidence and verifies sources |
| Strategist / Architect | turns evidence into plans, system design and implementation direction |
| Builder / Executor | implements, edits, automates and produces working outputs |
| Reviewer / Auditor | independently checks assumptions, bugs, risks and regressions |
| Finisher / Delivery | integrates remaining gaps, validates delivery and packages the result |

Names are user-configurable. Roles and routing semantics are the important part.

## Routing law

### Ordinary human messages

The Leader may receive unmentioned group messages.

Every specialist must require deliberate activation.

Conceptually:

```text
Leader      require_mention = false
Researcher  require_mention = true
Strategist  require_mention = true
Builder     require_mention = true
Reviewer    require_mention = true
Finisher    require_mention = true
```

### Exclusive mention routing

If a human explicitly mentions one specialist, unrelated Bots must not also wake because the message exists in the same Room.

Explicit mention routing must therefore be exclusive.

### Bot-authored activation

Bot-to-bot activation must require an explicit routing action. A bot-authored reply, quote reply, acknowledgement or ordinary prose must not be enough to wake another Bot.

## Critical safety rule: a Telegram username is executable routing

A teammate Telegram `@username` is not harmless descriptive text. In a bot-to-bot enabled group it can activate that Bot.

Therefore:

```text
"Dave is the Researcher."            SAFE descriptive prose

"@dave_bot research these sources."  DELIBERATE activation

"Dave is @dave_bot."                 UNSAFE in ordinary prose
```

Managed-team prompts, templates and channel adapters must treat teammate usernames as routing primitives.

### Required behavior

- do not print teammate usernames in normal rosters, summaries, status messages or examples
- use display names and roles in ordinary prose
- do not mention several teammate usernames merely to describe the team
- only emit a teammate username when intentionally activating that exact teammate
- a delegation message should normally activate exactly one intended specialist unless a deliberate parallel topology was selected
- no acknowledgement-only mentions
- no casually quoting a teammate username back to the group
- the Leader's final synthesis should contain no teammate username unless another work round is intentionally required

## Leader delegation protocol

For ordinary managed-team work:

1. Human sends a normal request.
2. Leader decides whether it can solve the request alone.
3. If specialist work is justified, Leader creates or maps the work to one bounded coordination Task.
4. Leader activates the selected specialist through the channel/runtime bridge.
5. Specialist completes only the delegated scope.
6. Specialist returns one bounded handback to the Leader.
7. Leader evaluates the result, optionally opens another bounded step, then synthesizes the final answer.
8. Final user-facing response does not re-activate specialists accidentally.

The preferred production implementation should route delegation through AI-Verse Multiple Bots coordination state rather than depending on free-form Telegram conversation as the source of truth.

## One final responder principle

Parallel intelligence must not create parallel user ownership.

For a managed team:

- one stage has one owner
- the Leader normally owns the final response
- specialists contribute evidence, plans, implementation or review
- specialist output is not automatically a competing final answer
- direct specialist conversations are allowed when the human explicitly addresses that specialist, but this does not silently transfer global team leadership

## Shared observation

Specialists may observe ordinary group conversation without responding.

This allows them to receive useful current context while preserving one-speaker behavior.

Observation must not imply activation.

The implementation must keep these concepts distinct:

```text
visible to Bot != scheduled to respond
```

## Profile-scoped configuration

In a multiplex runtime, routing policy must be bound to the individual profile/Bot, not inferred only from process-global environment variables.

A real Hermes deployment demonstrated that process-global Telegram booleans can leak behavior across profiles when a shared gateway reads common environment state.

Future Hermes integration should therefore:

- write or inject routing policy per profile
- make per-profile policy take precedence over shared process defaults
- verify the effective policy for every profile before declaring the team healthy
- treat process-wide environment settings as fallback only when safe

## Persistent-session identity hazard

Long-lived gateway sessions can retain an earlier system prompt or identity even after the underlying Bot SOUL/profile is updated.

A runtime adapter must not assume changing an identity file instantly changes an already-persisted group session.

Future integration should provide a safe session refresh/migration path when identity or core routing instructions materially change.

### Setup ordering

Preferred first-run order:

```text
create profiles
  -> configure profile routing
  -> write permanent identities
  -> validate runtime credentials
  -> configure channel credentials
  -> start multiplex gateway
  -> create/enter group sessions
  -> run acceptance tests
```

Do not deliberately create long-lived group sessions before permanent Bot identity and routing policy are settled.

## Bot-to-bot loop prevention

Mention gating alone is insufficient if Bots can emit real teammate usernames in ordinary text.

Loop protection needs both protocol and runtime controls.

Required protections:

- explicit activation semantics
- exclusive recipient routing
- one-owner rule
- hop/depth limits
- duplicate Task detection
- repeated handoff detection
- pair/cycle ping-pong detection
- no-progress detection
- bounded Room turns/messages
- cancellation propagation
- cooldown/rate protection at the channel boundary where available

AI-Verse Multiple Bots already owns the core coordination protections. Channel/runtime adapters must preserve them rather than creating an uncontrolled second coordination path.

## Stop and cancellation behavior

A user-visible stop must target the actual active coordination work, not merely the Telegram Bot whose username appears in the command.

Future channel integration should map stop/cancel requests to:

- current Task
- active Team Run
- active specialist delegation
- relevant runtime execution

Cancellation should then propagate through the normal Multiple Bots hierarchy.

The Telegram bridge should not become a separate source of cancellation truth.

## Hermes multiplex deployment requirements

When Hermes is used as an external managed runtime:

- keep the team runtime separate from a user's unrelated personal Hermes state unless intentionally attached
- one multiplex gateway may serve multiple isolated Hermes profiles
- every Telegram profile requires unique bot credentials
- duplicate Telegram bot tokens must fail setup
- permanent profile identity/state must remain isolated
- local filesystem execution still shares the underlying operating-system user unless stronger isolation is configured
- one profile should not silently inherit another profile's Telegram activation policy

The future Hermes adapter in Phase 4 should turn these into explicit checks rather than relying on manual operator knowledge.

## Telegram onboarding requirements

A future Phase 5 setup flow should guide the operator through the Telegram-only steps that cannot be automated safely.

For every bot used in the managed team, onboarding should verify or instruct:

- unique bot token
- bot added to the intended group
- required group visibility/privacy setting
- bot-to-bot communication setting when public bot delegation is enabled
- allowed human/operator identity
- allowed group/chat identity
- one successful direct or group identity check

Secrets must not be written into tracked repository files.

## Health checks

A future `doctor` or setup acceptance gate should verify at least:

- gateway is running
- all intended durable Bots are registered
- one and only one Leader is configured for ordinary group messages
- every specialist requires deliberate activation
- exclusive mention routing is enabled
- bot-authored activation requires deliberate routing
- shared observation is enabled only as configured
- no Telegram bot token is duplicated
- each Bot resolves to the expected runtime profile
- identities are current, not stale-session copies
- cancellation path is available
- no configuration source unexpectedly overrides the profile-level routing policy

## Acceptance tests for the managed-team preset

### Test 1: ordinary message

Human sends an ordinary group message with no bot mention.

Expected:

- Leader responds
- no specialist responds
- group remains quiet after the Leader completes

### Test 2: direct specialist mention

Human explicitly addresses one specialist.

Expected:

- only that specialist responds
- unrelated Bots remain silent

### Test 3: safe roster answer

Human asks who is on the team.

Expected:

- Leader lists display names and roles
- response contains no teammate Telegram usernames
- no specialist wakes

### Test 4: bounded delegation

Human gives the Leader a request that genuinely requires one specialist.

Expected:

- Leader intentionally delegates one bounded Task
- only the selected specialist activates
- specialist returns the result to Leader
- Leader produces the final answer
- final answer does not accidentally reactivate the specialist

### Test 5: no ping-pong

A specialist handback reaches the Leader.

Expected:

- exactly one intended handback
- no acknowledgement loop
- no quote-reply loop
- no repeated Leader-specialist ping-pong

### Test 6: restart

Restart the managed runtime/gateway.

Expected:

- durable identities remain correct
- routing policy remains correct
- ordinary messages still go to Leader only
- no obsolete system prompt becomes active

### Test 7: cancellation

Start delegated work and cancel it.

Expected:

- active coordination work stops
- downstream work is canceled according to normal hierarchy
- the Telegram room does not continue generating Bot responses after cancellation settles

## Implementation ownership

This contract does not move ownership between repositories.

```text
AI-Verse Multiple Bots
  owns Bot identity, Rooms, routing, Tasks, Handoffs,
  Team Runs, coordination policy and cancellation

Hermes adapter
  executes Bots/Workers through Hermes while preserving
  Multiple Bots identity and coordination contracts

Telegram bridge
  translates Telegram events to/from Multiple Bots
  without becoming a second coordination engine

AI-Verse OS
  remains canonical for OS-owned workspace and operator state
```

## Roadmap placement

This document is intentionally implementation guidance for later roadmap work:

- **Phase 4:** Hermes runtime adapter and external managed Bot runtime
- **Phase 5:** Telegram channel bridge, setup/onboarding, team templates, health/doctor and member-facing installer

It does not require building those components early.

## Non-goals of this document

This document does not:

- implement a Hermes adapter
- implement a Telegram bridge
- implement a member installer
- add Telegram-specific behavior to the coordination core
- change AI-Verse OS ownership boundaries
- require the default six-role roster for every deployment
- make free-form bot-to-bot Telegram chat the canonical coordination protocol

Its purpose is to preserve a proven managed-team behavior so later implementation can make it automatic, testable and safe from first setup.
