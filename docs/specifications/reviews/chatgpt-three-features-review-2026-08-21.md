# ChatGPT independent review — raw terminal response

- Project: `Automation V1`
- Conversation: https://chatgpt.com/g/g-p-6a87ce86ce488191a8c1813b2b127404-automation-v1/c/6a87f33f-a018-83ec-b6dc-c540eadb1d6c
- Source: `three-high-leverage-operating-features.md` before the remediation recorded below

VERDICT: CHANGES_REQUIRED

Tenant-safe uniqueness is not fully specified for Mattermost intake. `provider_event_id UNIQUE` is global, while the system is multi-workspace and supports configured Mattermost accounts. Unless provider event IDs are formally guaranteed globally unique across every Mattermost installation, one workspace can collide with another. Likewise, the canonical root uniqueness requires either `workspace_id` in the key or an explicit invariant that `mattermost_account_id` is globally unique and immutably bound to exactly one workspace. This must be pinned before schema implementation.

Exception versioning can create multiple simultaneous “current” cards for one logical exception. The fingerprint deliberately changes when decision options, deadline, evidence, or severity materially changes, and `fingerprint UNIQUE` therefore permits a new `task_exceptions` row. The spec does not define an atomic supersession/current-row invariant that retires the previous version. Define a stable logical exception identity plus version/supersession semantics and enforce at most one current open projection per logical exception.

`completion_reviews.evidence_digest UNIQUE` is unsafe unless task identity is part of the digest. The canonicalization requirements bind content components but do not explicitly bind `task_id`/workspace identity. Two tasks with byte-identical briefs, criteria, deliverables and evidence can therefore legitimately produce the same digest and collide globally. Either include immutable task identity in the canonical digest contract or make uniqueness `(task_id, evidence_digest)`.

The “operator alert outside the CEO exception channel” has no defined delivery authority. The architecture explicitly prohibits a second sender or generic notification stream, yet failed exception rebuilds must emit an operator alert outside the CEO exception channel. The specification must name the existing approved delivery mechanism, recipient/root semantics, deduplication key and failure behavior so implementation does not invent a parallel notification path.

## Disposition

All four findings were accepted and incorporated into the canonical specification: workspace/account-scoped intake uniqueness; stable logical exception identity with atomic supersession; task/workspace-bound completion digests and uniqueness; and a deduplicated Mission Control admin incident record with no new sender.
