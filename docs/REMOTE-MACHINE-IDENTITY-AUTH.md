# Remote Machine Identity and Authentication

**Phase:** 4.6

**Status:** COMPLETE

## Purpose

Phase 4.6 adds a host-neutral trust and authentication boundary for agent runtimes that execute across a network boundary.

The central rule is:

> A remote endpoint is not a teammate identity merely because a URL responds, and a credential is never part of a Bot prompt or ordinary runtime manifest.

Multiple Bots pins the remote machine identity separately from application credentials, resolves credentials through host-injected providers, verifies authenticated transport evidence, and keeps local Bot/Worker/Task identity canonical.

The first concrete integration is A2A because A2A is the project's preferred remote-agent boundary.

## Ownership

Multiple Bots owns:

- the local durable Bot or temporary Worker identity
- the local Task
- workspace scope
- authority and approvals
- budgets/deadlines
- cancellation
- coordination provenance
- the trusted reference to a remote machine identity

The host owns:

- secret persistence
- credential acquisition/rotation
- OAuth interaction where required
- mTLS certificate material
- SPIFFE Workload API integration
- OS keychain / vault integration
- provider-specific transport setup

A remote runtime never receives broad local authority merely because it authenticated successfully.

Authentication proves who is on the other side and how the request was authenticated. Phase 4.7 separately owns what remote capability/environment authority may be leased.

## Public contracts

Phase 4.6 adds:

```text
RemoteMachineIdentity
RemotePeerIdentity
RemoteMachineIdentityRegistry
RemoteAuthBinding
RemoteSecurityRequirement
RemoteAuthenticationEvidence
RemoteHttpAuthenticator
RemoteHttpAuthenticatorRegistry
RemoteHttpAccessBroker
RemoteCredentialResolver
HeaderRemoteHttpAuthenticator
RemoteMachineAuthError
```

## Remote machine identity

A machine is registered with:

```json
{
  "id": "machine_research",
  "origin": "https://agent.example",
  "expected_peer_identity": {
    "kind": "https_origin",
    "value": "https://agent.example"
  }
}
```

Supported peer identity kinds are:

```text
https_origin
tls_spki_sha256
tls_cert_sha256
spiffe_id
custom
```

The registry requires HTTPS.

It rejects:

- HTTP origins
- URL-embedded credentials
- duplicate machine IDs
- the same pinned remote peer under multiple local machine IDs
- one HTTPS origin being ambiguously pinned to conflicting peer identities

This is deliberate no-TOFU behavior. The machine identity must already be trusted by host configuration.

## HTTPS origin identity

The built-in HTTP path supports normal CA-verified HTTPS origin identity.

For this identity mode:

```text
expected_peer_identity.kind = https_origin
```

the platform HTTPS stack supplies certificate/hostname validation and redirects are disabled.

This is not represented as certificate pinning.

If a deployment requires stronger proof such as:

- pinned TLS SPKI
- pinned certificate digest
- SPIFFE ID
- custom workload identity

the host must inject an authenticator/transport capable of producing that evidence.

The core never pretends ordinary `fetch()` can inspect a peer certificate or prove SPIFFE identity.

## Authentication binding

A runtime may refer to remote trust/authentication using only opaque references:

```json
{
  "remote_machine_ref": "machine_research",
  "remote_auth_provider": "header-auth",
  "remote_credential_ref": "secret://a2a/research"
}
```

The credential reference is not the credential.

It is an opaque host-owned handle.

Provider and credential reference must be configured together.

## Raw credential prohibition

The A2A runtime rejects inline credential-like fields including:

```text
api_key
token
bearer_token
authorization
api_key_env
bearer_token_env
headers
remote_headers
cookie
password
client_secret
secret
```

This prevents Bot/runtime configuration from becoming a secret store.

## Authenticator registry

Authenticators are registered explicitly by the host.

```text
RemoteHttpAuthenticatorRegistry
```

Each authenticator has a stable provider id.

Duplicate provider ids fail.

The core does not discover arbitrary credential providers from model text or remote responses.

## Credential resolver

The built-in header authenticator accepts a host-injected:

```text
RemoteCredentialResolver
```

It resolves an opaque credential handle at request time.

Supported built-in credential material:

```text
bearer
api_key
```

Credential values are never persisted into Multiple Bots receipts.

## Public discovery vs authenticated requests

Agent discovery and application authentication are deliberately separated.

For an A2A Agent Card:

1. the pinned machine/origin is verified
2. the public Agent Card is fetched
3. the Agent Card's declared security requirements are inspected
4. only then is an application credential resolved for an authenticated RPC

The built-in Bearer/API-key authenticator therefore does **not** resolve or send an application credential during public Agent Card discovery.

This prevents pre-auth discovery from becoming a credential exfiltration path.

A stronger custom transport may still use host-owned workload identity during discovery when required for TLS/SPIFFE attestation, but application security requirements remain explicit.

## Redirect and origin policy

Authenticated/pinned requests use:

```text
redirect: error
```

Every request URL must match the exact registered HTTPS origin.

Therefore an authenticated Agent Card cannot advertise:

```text
https://evil.example/rpc
```

and cause a Bearer token/API key to be sent there.

The origin mismatch is rejected before the credential is resolved or transmitted.

## A2A 1.0 security requirements

Phase 4.6 consumes A2A Agent Card:

```text
securitySchemes
securityRequirements
```

Security requirements retain OR/AND semantics:

- entries in the requirements array are alternatives
- schemes within one requirement must all be satisfied

The core validates that every referenced security scheme is declared.

It never guesses an undeclared auth scheme.

## Built-in Bearer authentication

The built-in header authenticator can satisfy an A2A HTTP authentication scheme whose HTTP scheme is Bearer.

It emits:

```text
Authorization: Bearer <resolved-host-secret>
```

only for the authenticated request.

The value comes from the host credential resolver.

## Built-in API-key authentication

Header API keys are supported when the Agent Card declares a header API-key scheme.

The remote Agent Card may not use the API-key mechanism to control protected transport headers such as:

```text
Authorization
Host
Content-Length
Content-Type
Accept
A2A-Version
Cookie
Set-Cookie
```

This avoids turning a remote security declaration into arbitrary header injection.

## OAuth2, OIDC, mTLS and SPIFFE

The core does not hard-code interactive OAuth, OIDC or certificate management.

Instead, a custom `RemoteHttpAuthenticator` can implement:

- OAuth2 token acquisition
- OIDC flows
- OAuth mTLS/certificate-bound tokens
- SPIFFE X.509 SVIDs
- custom enterprise workload identity
- TLS certificate/SPKI pinning

The authenticator returns evidence rather than raw credential material.

This keeps Multiple Bots runtime-neutral while allowing stronger production deployments.

## Authentication evidence

Every authenticated transport returns bounded evidence:

```text
machine_id
origin
tls_verified
peer_identity
client_authenticated
satisfied_schemes
satisfied_scopes
mechanism
```

The broker verifies all of it.

The evidence must match:

- the registered machine id
- the exact pinned origin
- the exact pinned peer identity
- TLS verification
- client-authentication requirement
- at least one declared security requirement
- every required scope within the selected requirement

Malformed evidence fails with:

```text
REMOTE_AUTH_INVALID_EVIDENCE
```

## Scope proof

A security scheme is not considered satisfied merely because an authenticator names it.

If an A2A requirement declares:

```text
oauth -> agent.execute
```

the authenticator must prove `agent.execute` in `satisfied_scopes.oauth`.

A token that proves only `agent.read` does not satisfy the requirement.

This matters for OAuth2/OIDC integrations where authentication without scope verification can silently widen or misrepresent authority.

## Authentication is not capability authority

Phase 4.6 proves remote identity/authentication only.

It does **not** turn remote auth scopes into Multiple Bots capability leases.

The normal local Task capability lease remains canonical.

Phase 4.7 will add the explicit remote capability/environment lease projection and verification layer.

## A2A integration

The existing `A2AJsonRpcRuntimeAdapter` now optionally accepts:

```text
RemoteHttpAccessBroker
```

When `remote_machine_ref` is configured:

- Agent Card discovery uses the pinned remote machine
- the Agent Card's security declarations are normalized
- authenticated RPCs go through the broker
- `SendMessage`, `GetTask` and `CancelTask` use the same pinned machine/auth contract
- cross-origin interfaces fail
- required auth without an opaque binding fails
- raw credential fields fail
- local Bot/Worker identity remains unchanged

Unauthenticated A2A remains supported through the original local adapter path.

## A2A receipt

A2A provenance now records bounded authentication state:

```text
authentication
remote_machine_ref
authentication_mechanism
peer_identity_kind
```

It deliberately does not record:

- bearer token
- API key
- credential reference
- certificate bytes
- private keys
- OAuth refresh/access tokens
- SPIFFE SVID material
- full peer identity value

## Provider failure boundary

Host-injected authenticators may call vaults, identity providers or remote TLS libraries.

Their arbitrary exceptions may contain:

- tokens
- internal URLs
- machine details
- vault paths
- provider-specific state

Opaque authenticator failures are therefore normalized as:

```text
REMOTE_AUTH_PROVIDER_FAILED
```

without copying the provider error message.

Known structured `RemoteMachineAuthError` failures remain intact.

## Cancellation

The broker races host authenticator work against the local AbortSignal.

Local cancellation therefore settles even if a custom authenticator ignores the signal.

This preserves the existing Multiple Bots cancellation law without introducing Phase 4.8 reconnect/retry behavior.

## Gateway integration

The Gateway can receive host-injected:

```text
remoteMachines
remoteAuthenticators
```

and exposes internally:

```text
remoteMachines
remoteAuthenticators
remoteAccess
```

There is intentionally no public onboarding/secret-registration UI in Phase 4.6.

That belongs to later product/setup work.

## External managed runtime relationship

Phase 4.5's `ExternalManagedBotProvider` remains provider-owned.

Phase 4.6 does not force every external managed runtime through A2A.

Provider authors can compose `RemoteHttpAccessBroker` when their external managed runtime uses an HTTP remote-machine boundary.

This preserves the 4.5 abstraction and avoids embedding provider-specific auth logic into the generic managed-Bot adapter.

## Acceptance proof

The hardened implementation head `a2fcd4736f37d832c9240476c5b77efa01e462d4` passed GitHub Actions **CI run 438 (`34717863491`) with 375/375 tests**, **0 failures, 0 canceled and 0 skipped**.

Phase 4.6 acceptance coverage proves:

1. remote machines are pinned to HTTPS origins and explicit peer identities
2. duplicate machine IDs fail
3. the same peer cannot be aliased under multiple local machine IDs
4. one origin cannot be pinned ambiguously to a conflicting peer identity
5. plain HTTP fails
6. URL-embedded credentials fail
7. runtime auth configuration uses opaque credential handles
8. incomplete auth bindings fail
9. raw inline A2A credential-like fields fail
10. normal CA-verified HTTPS origin identity works
11. stronger peer identity requires an attesting transport
12. public A2A discovery does not resolve/send built-in Bearer/API-key credentials
13. redirects are disabled
14. cross-origin Agent Card interfaces fail before credentials are resolved
15. Bearer authentication follows declared A2A security requirements
16. header API-key authentication follows declared A2A security requirements
17. protected header takeover fails
18. undeclared security schemes fail
19. OR/AND security requirement structure is preserved
20. custom transports can attest SPIFFE/mTLS-style identities
21. machine/origin/peer identity evidence is verified
22. unverified TLS fails
23. missing client authentication fails when required
24. required OAuth scopes must be explicitly proven
25. incomplete scheme/scope evidence fails
26. malformed authentication evidence fails closed
27. opaque provider errors are sanitized
28. broker cancellation is independent of provider AbortSignal compliance
29. authenticated A2A execution still preserves local Bot identity
30. authenticated A2A receipts contain no credential value or credential reference
31. Gateway exposes host-injected remote-machine/auth registries
32. all pre-existing Phase 0-4.5 behavior remains green

## Non-goals

Phase 4.6 does not implement:

- secret persistence
- keychain/vault storage
- interactive OAuth UI
- certificate issuance
- SPIFFE server/agent installation
- SSH execution
- remote capability/environment leases
- remote environment handles
- retry/disconnect/reconnect reconciliation
- remote exactly-once execution
- Phase 5 onboarding
- Dashboard settings
- Telegram/Discord/channel setup

Those remain with their canonical later roadmap slices.
