# Specification change log

## 2026-08-21 — independent review closure

- Bound completion-review currency to `tasks.current_completion_review_id` with digest CAS semantics.
- Defined canonical exception fingerprints, `authority_scope`, `decision_version`, partial-index predicate and decision-schema validation ownership.
- Scoped intake uniqueness by workspace/account and made exception supersession atomic.
- Reused the existing admin incident stream for projection failures; no parallel sender.
- Closed both independent review gates and advanced the verdict to ready for implementation decision only.

## 2026-08-21 — review candidate

- Added an explicit reuse/gap map to prevent parallel task, sender, classifier, supervisor and completion systems.
- Made Mattermost account identity part of the canonical root key and defined direct-channel, sender, signature and replay checks.
- Defined terminal-thread and manual-link conflict behavior, immutable post-dispatch identity and canonical task lineages.
- Bound CEO exceptions to existing controller facts, specified material-change/cooldown rules and isolated alerts to a new exception-only event family.
- Added stale projection and stale decision-version behavior.
- Defined completion digest canonicalization, snapshot consistency, compare-and-swap currency and citation requirements.
- Added retention defaults, migration phases, rollout gates, success measures, accessibility and explicit activation approvals.

This log records specification evolution only. No implementation, deployment or configuration change is included.
