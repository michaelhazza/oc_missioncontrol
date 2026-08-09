# Oracle controller production runbook

## Production mode

The controller is enabled by the LaunchAgent with two independent controls:

```text
MISSION_CONTROL_COMPLETION_CONTROLLER=active
MISSION_CONTROL_COMPLETION_ACTIONS=dispatch,request_verification
```

The first value enables the deterministic 90-minute completion reconciler. The separate one-minute execution supervisor continues handling lease recovery. The second value is the production cohort allowlist. An action not in the allowlist remains `proposed`; it cannot be claimed by the outbox worker. This makes progressive activation explicit and reversible.

Recommended phases:

1. `dispatch,request_verification`
2. add `return_rework` after reviewing verification/rework evidence
3. add `close` only after objective completion-contract audits show no false positives

`oracle_review` and Michael-authority actions remain human-governed. Stale execution recovery remains owned by the execution supervisor and is never duplicated by this controller.

## Mattermost milestones

Tasks persist `mattermost_channel_id`, `mattermost_source_post_id`, `mattermost_root_post_id`, and `mattermost_thread_url`. Only semantic milestones are posted: dispatched, verification, rework, decision, blocked, failed, and objectively completed. Heartbeats and unchanged scans never produce posts.

Milestones use `mattermost_task_update_outbox` with a unique action key, 15-minute per-task/milestone cooldown, a 60-second claim fence, three bounded attempts, and one-minute retry delay. Delivery invokes the pinned OpenClaw Mattermost sender with both channel ID and `--reply-to <root_post_id>`. Queue and delivery evidence is mirrored into task activities.

## Health checks

- `GET /api/oracle/completion-controller` must report `enabled: active` and the intended `activeActions` cohort.
- Latest scan must have `error_count=0`.
- Alert on failed controller actions, failed Mattermost outbox rows, expired `delivering` claims, repeated action fingerprints, and controller lease age over 150 seconds.
- Compare non-terminal task classifications before/after activation; do not delete legacy tasks or manufacture evidence.

## Rollback

1. Remove actions from `MISSION_CONTROL_COMPLETION_ACTIONS` to freeze mutations while leaving scans/evidence active.
2. Set `MISSION_CONTROL_COMPLETION_CONTROLLER=dry_run` to stop all action delivery.
3. Use the mandatory LaunchAgent restart sequence.
4. Leave migrations 031–036 and outbox/contract records intact as audit evidence.
5. If application rollback is necessary, restore the pre-rollout binary/code; additive tables are backward compatible. The database backup is `backups/mission-control-before-oracle-productionise-2026-08-07.sqlite`.

Do not drop outbox or reconciliation tables during rollback.
