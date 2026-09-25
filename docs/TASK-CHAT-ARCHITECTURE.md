# Task chat architecture

Task chat is a durable Mission Control feature, not a view over an ephemeral model session.

## Data and ordering

- `task_messages` is the canonical audit record. Every row is bound to one task and records sender identity, content, timestamps, gateway session/run identity, delivery status, and a task-scoped client idempotency key.
- The API returns messages ordered by `created_at, id`. The Chat tab merges them with existing task activities to produce one chronological operational view.
- Human messages move through `queued → delivered` or `queued → failed`. Agent and system messages enter as `received`. A failed message is retried using its original idempotency key, preventing duplicate rows and duplicate gateway calls.

## Realtime and reconnect

- The existing server-sent-events channel emits `task_message_updated` after persistence and after every delivery-state change.
- The browser reconnects through `EventSource`; if SSE fails it refreshes both messages and activities every five seconds. Initial reload always reads the persisted history, so missed events do not lose data.

## Agent routing

- A human message is routed only to the task's currently assigned agent and its active Mission Control OpenClaw session.
- `chat.send` uses `task-chat-<message-id>` as the gateway idempotency key and includes the task ID plus a callback contract for the assigned agent to persist its response in the same task chat.
- There is no UI coupling to a transient run. The stored gateway session key/run ID are delivery evidence only.

## Access and safety

- Existing Mission Control middleware protects the API with same-origin browser checks and `MC_API_TOKEN` bearer authentication for non-browser clients. Demo mode remains read-only.
- Agent replies are accepted only when `sender_agent_id` matches the task's current assignment. Message length is bounded, and detailed/raw tool output remains in the task activity system rather than chat.
- Delivery errors are persisted and visible, and retries are explicit. Messages are never silently discarded.

## UI

- Existing-task dialogs default to Chat and use up to 96% of viewport width, 94–96% of viewport height, and a 1600px maximum width.
- Header, tabs, and composer remain fixed while only the timeline scrolls. Mobile uses a full-height bottom sheet with safe-area padding.
