# Phase 2.11 Working Notes

This branch implements the adaptive single-Bot-vs-squad decision policy described by the canonical Phase 2 roadmap.

The policy is host-neutral and rule-based. It consumes explicit work-shape signals, uncertainty, verification need, parallel safety, discussion/ownership requirements, cost/latency sensitivity, capability authority, and bounded Team Run budgets. It records only inspectable reason codes and summaries; it does not persist hidden chain-of-thought.

A single-Bot decision creates no Team Run. A squad decision reserves a deterministic Team Run ID and opens at most one Team Run for the root objective. Existing Team Runs for that objective are reused instead of creating an orchestration loop. The decision itself is persisted as a deterministic `collaboration_decision` Artifact so both single and squad choices remain auditable across restart.

This file is temporary branch documentation and will be folded into the canonical Phase 2 status/build map before merge.
