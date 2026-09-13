# Channel Bridge Contracts

**Phase:** 5.10

**Status:** COMPLETE

AI-Verse Multiple Bots exposes one provider-neutral channel boundary for Telegram, Discord and future channel adapters.

The channel layer does not own Bot identity, workspace truth, scheduling, coordination state or external network delivery.

## Ownership

```text
Telegram / Discord / future channel
        |
        v
external channel adapter
  - terminates public webhook / socket transport
  - verifies provider authenticity
  - holds provider credentials
        |
        v
Channel Bridge Boundary
  - maps verified provider messages to configured bindings
  - preserves external-message provenance
  - assigns deterministic canonical message IDs
  - routes into the existing Coordination Gateway / Rooms
  - formats canonical outbound messages for the adapter
  - records idempotent delivery receipts
        |
        v
Coordination Gateway
```

The bridge has no scheduler, no durable external-identity database and no second coordination store.

## Binding contract

Bindings are supplied by the host when the Gateway starts.

A binding contains:

- binding ID
- provider
- provider account ID
- provider conversation/channel ID
- canonical workspace ID
- canonical target kind: Bot, Room or Thread
- canonical target ID
- Room ID for Thread bindings
- optional external sender allow-list

Bindings are in-memory host configuration. They do not become a competing canonical identity registry.

Only one enabled binding may own the same provider/account/conversation route.

## Ingress

Supported adapter entry points:

- `POST /v1/channels/ingress`
- `POST /v1/channels/telegram/ingress`
- `POST /v1/channels/discord/ingress`

The public provider webhook or Discord Gateway connection must terminate in an external adapter first.

The adapter must verify the provider transport before calling Multiple Bots. Ingress fails closed unless `adapterVerified: true`.

If the Gateway itself is remotely reachable, the existing Gateway bearer-auth boundary still applies.

### Canonical ingress behavior

Every admitted message receives:

- deterministic canonical message ID derived from provider/account/external message ID
- stable channel actor identity derived from provider/account/external sender
- `external_message` provenance
- `trusted_instruction: false`
- deterministic conversation correlation ID
- deterministic idempotency key
- normalized attachment references
- preserved reply relationship when available

Duplicate provider delivery does not create a duplicate canonical message or mailbox delivery.

Attachments remain external references. The channel bridge does not silently fetch untrusted remote media or promote it into a canonical Artifact.

## Telegram adapter contract

The built-in normalizer accepts Telegram message-shaped updates:

- `message`
- `edited_message`
- `channel_post`
- `edited_channel_post`

It normalizes:

- chat ID
- sender ID
- update/message IDs
- text/caption
- reply-to message
- photo
- document
- audio
- voice
- video
- animation
- sticker

Network calls to the Telegram Bot API remain adapter-owned.

## Discord adapter contract

The built-in Discord normalizer accepts a verified message event supplied by an adapter.

It normalizes:

- message ID
- channel ID
- author ID
- content
- timestamp
- referenced message
- attachments

Discord Gateway/WebSocket lifecycle, signature verification, OAuth and REST credentials remain adapter-owned.

## Bot, Room and Thread routing

### Bot binding

Ingress becomes a normal Gateway message to the bound durable Bot.

The existing Bot policy remains authoritative.

### Room binding

Ingress goes through `RoomCoordinator.sendMessage`.

The existing Room speaker policy, budgets, mentions and bounded orchestration remain authoritative.

### Thread binding

Ingress goes through the same Room coordinator with the existing canonical Thread.

The bridge cannot manufacture a Thread or move a message across Room/workspace boundaries.

## Egress

`POST /v1/channels/egress` formats an existing canonical message for the selected binding.

It does not perform the network send.

The result includes:

- canonical message ID
- provider/binding/workspace
- external conversation ID
- external recipient when applicable
- external reply target when recoverable
- text
- attachment references
- deterministic egress dedupe key
- provider-specific transport command
- `delivery_receipt_required: true`

Provider command shapes currently cover:

- Telegram Bot API style
- Discord REST style
- generic channel-send style

Inbound external messages cannot be reflected directly back out through the formatter.

## Delivery receipts

Adapters report send outcomes through:

`POST /v1/channels/egress/receipt`

Supported states:

- `sent`
- `delivered`
- `failed`

Receipts emit canonical coordination events:

- `channel.egress.sent`
- `channel.egress.delivered`
- `channel.egress.failed`

Receipt writes are idempotent and reuse the canonical event store.

## Security rules

1. Public provider transport is terminated and authenticated by the adapter.
2. Raw provider secrets never enter ordinary Bot context.
3. External messages are always untrusted instructions.
4. Bindings cannot cross workspace scope.
5. Disabled or unavailable canonical targets fail closed.
6. Optional external sender allow-lists are enforced before canonical mutation.
7. Duplicate provider delivery is idempotent.
8. Inbound external messages cannot be echoed out as canonical Bot output.
9. Channel delivery never grants new Bot capabilities.
10. Channels never become a second scheduler or source of truth.

## Capability discovery

`GET /v1/channels/capabilities` exposes:

- supported adapter classes
- ingress endpoints
- egress/receipt endpoints
- non-secret binding projections
- explicit ownership boundaries

## Acceptance target

Phase 5.10 is accepted when:

- Telegram normalization is tested
- Discord normalization is tested
- generic normalized ingress is available
- workspace/binding isolation is deterministic
- sender admission fails closed
- duplicate ingress is idempotent
- attachment references preserve external provenance
- Bot routing reuses the Gateway
- Room/Thread routing reuses Room coordination
- outbound formatting is canonical-message based
- delivery receipts are idempotent
- installed-package smoke covers ingress and egress
- the full repository suite and Phase 4 compatibility suite remain green


## Acceptance evidence

GitHub Actions **CI run 577 (`34782846365`)** on implementation head `bde706770aba08a14150af51732c8e578460fca4` passed:

- **482/482** repository tests
- **5/5** Phase 4 runtime compatibility tests
- all package/install/setup/doctor/update/remote/Dashboard smokes
- installed-package channel ingress/egress smoke
- **221-file** packed artifact
- **0 failures, 0 canceled, 0 skipped**
