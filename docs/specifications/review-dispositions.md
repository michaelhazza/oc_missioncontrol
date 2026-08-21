# Review dispositions

Status: complete. Both independent reviews are preserved and all material findings are dispositioned.

## Author quality pass

| Finding | Disposition | Specification change |
|---|---|---|
| The draft could be read as creating duplicate intake, notification and completion systems. | Accepted | Added the reuse/gap map and a prohibition on parallel stores, senders, classifiers, supervisors and completion authorities. |
| Task identity omitted the Mattermost connection/account dimension. | Accepted | Added `mattermost_account_id` and made account/channel/root the immutable canonical key. |
| Replies after terminal completion could accidentally reopen or duplicate work. | Accepted | Defined canonical lineages and an explicit follow-on action; terminal replies fail closed to operator decision. |
| Existing suppression of automated milestones conflicts with exception alerts. | Accepted | Added one `task_exception` event family and prohibited re-enabling legacy milestones. |
| Exception actions were unsafe against stale cards. | Accepted | Added projection watermarks, expected versions and `409` on stale decisions. |
| Evidence hashing and review concurrency were underspecified. | Accepted | Defined versioned canonical JSON, component hashes, a single database snapshot and compare-and-swap currency. |
| Retention and rollout success were not decision-ready. | Accepted | Added a conservative excerpt-retention default, phased migration, quantitative rollout gates and operational success targets. |

## Claude Code review

The repaired tool-free background gate initially returned `CHANGES_REQUIRED`. All material findings were accepted and remediated: lineage uniqueness/schema, deterministic provider-event and brief-revision identity, lease-fenced intake recovery, workspace scoping, exception recurrence/concurrency/routing/authority, evidence freshness, invalidation and guarded currency, synthesis versioning, and explicit human-decision routing. The final independent re-review returned `VERDICT: READY` with no material blockers; its four non-blocking clarifications were also incorporated.

## ChatGPT review

The managed authenticated profile's existing `Automation V1` Project was the authoritative project for this repository. ChatGPT returned four material findings; all were accepted: workspace-scoped intake uniqueness, atomic exception supersession, task-bound completion digest uniqueness, and reuse of the existing admin incident stream rather than a new sender.
