# Mission Control completion contracts

Mission Control is the authoritative task state plane. Completion contracts add
criteria-level qualification without introducing a second plan or state system.

Every newly created task receives a required contract. Callers may supply explicit
`completion_contract.acceptance_criteria` and `protected_boundaries`; otherwise MC
creates one objective criterion and one authority/safety boundary from the intake.
Tasks created before migration 036 remain on the legacy closure path until a
contract is explicitly attached.

## Lifecycle

1. `GET /api/tasks/:id/completion-contract` returns the contract and evaluation.
2. Before execution, `PUT` replaces the contract. Contracts lock once work starts.
3. Before completion, `POST` submits one result for every criterion and boundary,
   plan-versus-actual reconciliation, deviations, deferred work, fresh verification
   commands/results, and one next action.
4. Both direct task transitions and the Oracle completion controller fail closed
   while a required contract is incomplete, violated, failed, or stale.

Verification must be no older than the configured maximum (24 hours by default),
must not predate the latest deliverable, and every command must report exit code 0
with an output summary. Waivers remain explicit and evidenced; they are never
inferred from silence.

## Rollout and rollback

Migration 036 is additive. Rollback the application code without dropping the
tables; they are durable audit evidence. Existing tasks are not backfilled, so
deployment cannot strand an active legacy campaign. Disable automatic `close` in
`MISSION_CONTROL_COMPLETION_ACTIONS` for a controller-only rollback.
