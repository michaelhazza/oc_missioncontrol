# Agent control-plane hardening

## Outcome

Mission Control now has a fail-closed reference contract for long-running agent work that crosses a tool boundary. Existing fenced execution leases remain the durable owner. The reference workflow adds optimistic event versions, idempotent event keys, explicit `waiting_input`, restart-safe checkpoints, and an independent evaluator who cannot be the workflow owner.

Tool calls are admitted only through a versioned contract and an unrevoked, unexpired agent grant. Contracts declare required input fields, risk and a database-enforced rate window. External and destructive actions always pause for confirmation by a different principal. Every request, confirmation, completion digest or failure is retained as an audit row. No default grants are seeded, so migration cannot widen an existing agent.

## Reference lifecycle

1. Start a workflow bound to one durable `task_execution_run`.
2. Request a typed tool invocation with an idempotency key and payload digest.
3. For external/destructive risk, transition to `waiting_input` and persist the invocation ID in the checkpoint.
4. A distinct confirmer authorizes the invocation; the caller records only a result digest.
5. An idempotent event resumes execution and later submits verification evidence.
6. A different agent evaluates the evidence. Only a passed independent evaluation completes the reference workflow.

Duplicate event keys return the existing state. Reused invocation keys with different payloads fail. Stale workflow versions, missing grants, malformed inputs, self-confirmation, premature resume and rate excess all fail closed.

## Memory boundaries

- `session_context` is transient and requires an explicit retention deadline.
- `curated_fact` contains deliberate, source-linked facts and preferences.
- `semantic_memory` contains derived long-term recall and remains distinguishable from curated truth.
- Corrections must stay in the same workspace, subject and plane. The superseded content is tombstoned while its hash remains for integrity.
- Deletion removes content, retains the non-content hash/source audit, and requires a reason.

No automatic promotion between planes is implemented. Retrieval must select a plane explicitly. Retention purge scheduling remains an operational activation concern and must use the same audited deletion operation.

## Orchestration decision

Use one agent when the work has one authority domain, one bounded deliverable and deterministic verification. Add agents only for genuinely independent roles: parallel domain work with non-overlapping mutations, or evaluation where the builder must not verify itself. More agents are not a substitute for durable state, typed permissions or evidence gates.

## Safety and rollout

Migration `040` is additive and seeds no contracts or grants. Production activation requires security-owned contract registration and grants, an authenticated human confirmation principal, retention-owner approval, and monitoring for denied/rate-limited invocations. This change does not deploy infrastructure, alter credentials or enable any external action by itself.
