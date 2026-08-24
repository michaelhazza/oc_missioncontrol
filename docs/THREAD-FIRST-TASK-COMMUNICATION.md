# Thread-first task communication

Each top-level Mattermost DM request owns one originating thread and one Mission Control lineage. All task discussion and completion delivery stays in that thread; follow-up posts update its current task, while a new top-level post creates a distinct workstream.

## Identity and safety

- Canonical identity is workspace, Mattermost account, channel, and root post. Mission Control stores the latest source post, thread URL, deterministic lineage ID, and dispatch correlation ID.
- Mattermost task creation fails closed unless channel, root, source, and thread URL arrive together. Non-Mattermost tasks may omit the entire identity.
- Provider event IDs make duplicate intake idempotent. The database permits one current task per canonical thread; terminal-thread follow-ups require classification rather than silently reopening work.
- Recorded thread identity is immutable. User-visible outbox delivery always supplies both channel and root post and suppresses routine heartbeats/lifecycle chatter.

## Upgrade and recovery

OpenClaw must keep `channels.mattermost.accounts.switch.replyToMode = "all"`. Run `node scripts/ensure-mattermost-dm-threading.mjs` after every OpenClaw upgrade and at gateway startup. It verifies configuration, accepts the already-correct upstream implementation, reapplies the known compatibility patch when required, and stops safely if upstream code changes unexpectedly.

Mission Control migrations are additive and preserve existing non-Mattermost and legacy tasks. Intake delivery is replay-safe across restarts; the unique provider event and canonical-thread indexes prevent duplicate tasks. Thread outbox retries are bounded and retain diagnostics on terminal failure.

Rollback: stop the intake plugin, revert the Mission Control commit, and restart Mission Control. Existing thread identity columns and rows may remain safely unused; do not delete them. If an OpenClaw upgrade introduces native DM threading, the compatibility verifier becomes a no-op after recognizing the corrected implementation.
