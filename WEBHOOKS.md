# Webhook Setup — OpenClaw → Mission Control

This document describes how to configure OpenClaw to send task state change events to Mission Control.

## Endpoints

### Primary Sync: WebSocket Event Listeners
Mission Control's primary sync mechanism uses WebSocket event listeners on the existing OpenClaw client connection. No additional configuration is required — this works automatically when Mission Control is connected to the OpenClaw gateway.

### Secondary Sync: HTTP Webhook
For deployments where WebSocket events are unreliable or where a separate system needs to push updates, Mission Control provides an HTTP webhook endpoint.

**Endpoint:** `POST /api/webhooks/openclaw-task-update`

### Polling Fallback
For environments where neither WebSocket nor HTTP webhooks are available:

**Endpoint:** `GET /api/openclaw/sync-tasks?workspace_id=<id>`

Can also be triggered manually: `POST /api/openclaw/sync-tasks`

## HTTP Webhook Configuration

### 1. Set the Webhook Secret

In Mission Control's `.env.local`:

```bash
OPENCLAW_WEBHOOK_SECRET=<your-secret-here>
# Generate with: openssl rand -hex 32
```

This same secret must be configured in OpenClaw to sign outbound webhook payloads.

### 2. Configure OpenClaw to Send Webhooks

In your OpenClaw configuration, add a webhook target pointing to Mission Control:

```
Webhook URL: http://<mission-control-host>:4000/api/webhooks/openclaw-task-update
Secret: <same-secret-as-OPENCLAW_WEBHOOK_SECRET>
Events: task.completed, task.updated, task.failed
```

> **Note:** OpenClaw does not currently support outbound HTTP webhooks natively. This endpoint is built as a future-ready integration point. The primary sync path uses WebSocket events.

### 3. Webhook Payload Format

```json
{
  "event": "task.completed",
  "correlation_id": "uuid-generated-by-mission-control",
  "workspace_id": "workspace-id",
  "status": "completed",
  "agent_id": "gateway-agent-id",
  "summary": "What the agent did",
  "notes": "Optional completion notes",
  "title": "Task title (for new tasks)",
  "description": "Task description (for new tasks)"
}
```

### 4. Signature Verification

Webhook requests must include an `x-webhook-signature` header containing the HMAC-SHA256 hex digest of the raw request body, signed with the shared secret.

```
x-webhook-signature: <hmac-sha256-hex-digest>
```

If `OPENCLAW_WEBHOOK_SECRET` is not set, signature verification is disabled (development mode only). A startup warning is logged when this variable is missing.

### 5. Multi-Workspace Routing

The webhook endpoint supports multiple workspaces. Include `workspace_id` in the payload body or as a URL query parameter:

```
POST /api/webhooks/openclaw-task-update?workspace_id=my-workspace
```

If no workspace_id is provided, it defaults to `'default'`.

## Retry Sync Endpoint

For tasks that failed to dispatch to the gateway:

**Endpoint:** `POST /api/openclaw/retry-sync?workspace_id=<id>`

This sweeps all tasks with `sync_status='pending_sync'` and retries dispatch. Tasks exceeding the configured `max_retry_count` are marked as `sync_failed`.

Can be triggered:
- Manually from the Settings page (Retry Failed Syncs button)
- Via cron job or external scheduler
- Via API call

## Correlation ID Pattern

Mission Control generates a UUID (`correlationId`) for each task dispatch and includes it in the structured message sent to the agent via `chat.send`. The agent is instructed to echo this ID back in their completion response:

```
TASK_COMPLETE[<correlationId>]: <summary>
```

The sync listener matches on this correlationId to close the round-trip. If the correlationId is not present, a content-based fallback match is attempted using session/agent information.

> **Known Gap:** correlationId echoing is not currently enforced in agent prompt templates. This is a follow-up task.
