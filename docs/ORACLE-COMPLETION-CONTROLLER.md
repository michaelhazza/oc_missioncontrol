# Oracle Mission Control completion controller

## Purpose and boundary

The controller deterministically advances task/workflow governance while the execution supervisor exclusively owns run liveness and recovery. Mission Control remains authoritative. The controller does nothing to healthy leased work and never treats agent prose as objective completion evidence.

It scans every 90 seconds when enabled, protected by a 75-second singleton lease. Each scan persists a classification and evidence fingerprint. Material actions use globally unique action keys and a durable, fenced outbox with 60-second claims, cooldowns, and at most two delivery attempts. Expired claims are recovered after process restart. Repeated scans therefore do not redispatch, reverify, renotify, or reclose unchanged work.

Oracle review actions are serialized. One delivered review remains the queue head until Oracle records `passed`, `rework`, or `cancelled`; later Oracle actions stay pending and are not delivered. A pass writes objective verification evidence and permits the next scan to close the task. Rework writes a verification failure and routes the task back to its assigned specialist. Delivery and resolution are separate durable timestamps, so a process restart cannot mistake a sent review for a resolved review. Other authority notifications are terminal once gateway delivery succeeds because they use their existing task/run lifecycle rather than this Oracle-only resolution endpoint.

## Modes and rollout

The controller is disabled by default.

1. Leave `MISSION_CONTROL_COMPLETION_CONTROLLER` unset or `disabled` during code deployment and migration 031.
2. Set it to `dry_run`. Review `GET /api/oracle/completion-controller` and the scan/action inventory for at least one full backlog cycle.
3. Resolve legacy workflow/evidence gaps. In particular, add explicit `verification_passed`, `completion_contract_passed`, or `test_passed` activity only when supported by real evidence.
4. After Switch review, set it to `active` for one workflow/agent cohort, then expand progressively.

Dry-run decisions are promoted in place when the identical fingerprint is first observed in active mode; they are not duplicated or stranded by the action-key uniqueness fence. Active scans drain both newly promoted work and eligible pending retries. Oracle, Tank, and independent-verifier actions are sent to their OpenClaw sessions with the action ID as the gateway idempotency key. Michael-only actions are routed through Switch with an explicit originating Mattermost thread constraint when the task contains thread identity.

`POST /api/oracle/completion-controller` triggers a scan. Active requests fail closed unless the process environment is explicitly active. `PATCH /api/oracle/completion-controller/:actionId` lets the registered Oracle agent acknowledge and resolve queued authority actions with an auditable note.

Rollback: set the environment value to `disabled` and restart the service. Keep migrations 031 and 033 tables/columns as immutable audit evidence. No task deletion or schema downgrade is required.

## Completion contract

Automatic close requires all three: at least one deliverable, a completed activity, and objective verification activity. Independent verifier/reviewer/tester task roles prevent self-verification. Verification failures route to Tank for rework. Michael-only gates are detected from explicit authority/approval language and remain queued for human action. Dependencies and intentional blocked/waiting states are no-ops until their material fingerprint changes.

## Observability

The queue endpoint exposes controller mode, recent scans, classification totals, authority owner, action state, attempts, age, and last error. Alert on failed actions, scan errors, lease contention across consecutive intervals, actionable backlog age, verification backlog age, Oracle/Michael queue age, and tasks without workflow or valid execution ownership.
