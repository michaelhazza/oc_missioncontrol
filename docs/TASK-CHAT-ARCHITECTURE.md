# Task chat architecture

Task chat is a durable Mission Control feature, not a view over an ephemeral model session.

## Data and ordering

- `task_messages` is the canonical audit record. Every row is bound to one task and records a monotonic task-local sequence, sender identity, content, timestamps, live execution session evidence, delivery attempts/status, and a task-scoped client idempotency key.
- `task_message_reads` stores the durable human read cursor. The API returns messages in `seq` order and supports `after_seq` catch-up. The Chat tab merges messages with existing task activities to produce one chronological operational view.
- Human messages move through `queued → delivered` or `queued → failed`. Agent and system messages enter as `received`. A failed message is retried using its original idempotency key, preventing duplicate rows and duplicate gateway calls.

## Realtime and reconnect

- The existing server-sent-events channel emits `task_message_updated` after persistence and after every delivery-state change.
- The browser reconnects through `EventSource`; if SSE fails it refreshes both messages and activities every five seconds. Initial reload always reads the persisted history, so missed events do not lose data.

## Agent routing

- A human message is routed only to the task's currently assigned agent and the live fenced `task_execution_runs.session_key` for that exact task and agent. There is deliberately no generic-agent-session fallback.
- `chat.send` uses `task-chat-<message-id>` as the gateway idempotency key and includes the task ID plus a callback contract for the assigned agent to persist its response in the same task chat.
- The UI remains decoupled from transient runs; server-side routing resolves the live execution at delivery time. The stored gateway session key/run ID are delivery evidence only.

## Mattermost continuity

Task chat does not weaken the existing single-speaker Mattermost policy. The originating account/channel/root identity and fenced exception/completion outbox remain intact; routine chat is not duplicated into Mattermost. Agents receive the message in their exact task execution context and are instructed to persist the concise reply in Mission Control. Existing Mattermost exception and completion notifications continue unchanged.

## Access and safety

- Existing Mission Control middleware protects the API with same-origin browser checks and `MC_API_TOKEN` bearer authentication for non-browser clients. Demo mode remains read-only.
- Agent replies are accepted only when `sender_agent_id` matches the task's current assignment. Message length is bounded, and detailed/raw tool output remains in the task activity system rather than chat.
- Delivery errors are persisted and visible, and retries are explicit. Messages are never silently discarded.

## UI

- Existing-task dialogs default to Chat and use up to 96% of viewport width, 94–96% of viewport height, and a 1600px maximum width.
- Header, tabs, and composer remain fixed while only the timeline scrolls. Mobile uses a full-height bottom sheet with safe-area padding.
