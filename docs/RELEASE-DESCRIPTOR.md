# Release Descriptor Maintainer Handoff

`release/component-release.json` is the owner-local release metadata record for AI-Verse Multiple Bots. The owner-local gate is `.github/workflows/release-descriptor.yml`, and its designated native workflow is `.github/workflows/ci.yml` (`CI`).

The descriptor is pinned to the exact T2 candidate revision `ddf70ac19736f6ca7f8d604901c20af9e46614fe`, whose native CI run `37240126310` passed. The descriptor remains `candidate`: native CI success proves owner-local candidate fitness only and does not replace the immutable Distribution-accepted Agent baseline.

The gate must find a successful native workflow run whose `head_sha` equals `descriptor.revision` exactly. Do not substitute current branch health, a later commit, or a latest-success result. Missing, inaccessible, malformed, mismatched, or unsuccessful evidence fails closed.

A pinned candidate revision remains valid after later metadata-only maintainer commits unless component code or the designated native workflow contract changes.

This record has owner-local metadata authority only. It cannot qualify or modify the AI-Verse Distribution component set, admit an Agent or Full release, publish a member feature-release record, grant permissions, change scope/direction ownership, enable a disabled component, expose a remote listener, or report live-health truth.
