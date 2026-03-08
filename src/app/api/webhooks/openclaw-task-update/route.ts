/**
 * POST /api/webhooks/openclaw-task-update
 *
 * HTTP webhook endpoint for receiving task state change events from the
 * OpenClaw gateway. This is a SECONDARY/FUTURE-READY sync path — the
 * primary sync uses WebSocket event listeners on the existing client.
 *
 * Supports multi-workspace routing via workspace_id in the payload or
 * URL query parameter.
 *
 * Expected payload:
 * {
 *   "event": "task.completed" | "task.updated" | "task.failed",
 *   "correlation_id": "uuid",
 *   "workspace_id": "workspace-id",
 *   "status": "completed",
 *   "agent_id": "gateway-agent-id",
 *   "summary": "What the agent did",
 *   "notes": "Optional completion notes"
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { createHmac, timingSafeEqual } from 'crypto';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { mapGatewayState } from '@/lib/openclaw/workspace-settings';
import type { Task, Agent } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Verify HMAC-SHA256 signature of webhook request.
 */
function verifySignature(signature: string, rawBody: string): boolean {
  const secret = process.env.OPENCLAW_WEBHOOK_SECRET;

  if (!secret) {
    // Dev mode — log warning but allow
    console.warn('[Webhook] OPENCLAW_WEBHOOK_SECRET not set — skipping signature verification');
    return true;
  }

  if (!signature) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature, 'utf-8'), Buffer.from(expected, 'utf-8'));
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();

    // Verify webhook signature
    const signature = request.headers.get('x-webhook-signature') || '';
    if (!verifySignature(signature, rawBody)) {
      console.warn('[Webhook] Invalid signature on openclaw-task-update');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const now = new Date().toISOString();

    const {
      event: eventType,
      correlation_id: correlationId,
      workspace_id: workspaceId,
      status: gatewayStatus,
      agent_id: gatewayAgentId,
      summary,
      notes,
    } = body;

    // Resolve workspace from query param or payload
    const resolvedWorkspaceId =
      request.nextUrl.searchParams.get('workspace_id') || workspaceId || 'default';

    // Try to find the task by correlation_id
    let task: Task | undefined;
    if (correlationId) {
      task = queryOne<Task>(
        'SELECT * FROM tasks WHERE gateway_task_id = ? AND workspace_id = ?',
        [correlationId, resolvedWorkspaceId],
      );
    }

    // If no matching task found, create a new local task from the webhook payload
    if (!task && correlationId) {
      const taskId = uuidv4();
      run(
        `INSERT INTO tasks (id, title, description, status, workspace_id, gateway_task_id, sync_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          taskId,
          body.title || `Gateway task ${correlationId.slice(0, 8)}`,
          body.description || summary || null,
          'inbox',
          resolvedWorkspaceId,
          correlationId,
          'synced',
          now,
          now,
        ],
      );
      task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);

      if (task) {
        broadcast({ type: 'task_created', payload: task });
        console.log(`[Webhook] Created new local task ${taskId} from gateway event`);
      }
    }

    if (!task) {
      return NextResponse.json(
        { error: 'No matching task found and could not create one' },
        { status: 404 },
      );
    }

    // Map gateway status to MC status
    let newStatus = task.status;
    if (gatewayStatus) {
      const mapped = mapGatewayState(resolvedWorkspaceId, gatewayStatus);
      if (mapped) newStatus = mapped as Task['status'];
    }

    // Handle specific event types
    if (eventType === 'task.completed' || eventType === 'task.failed') {
      newStatus = eventType === 'task.completed' ? 'review' : 'inbox';
    }

    // Find the local agent by gateway_agent_id
    let agent: Agent | undefined;
    if (gatewayAgentId) {
      agent = queryOne<Agent>(
        'SELECT * FROM agents WHERE gateway_agent_id = ? AND workspace_id = ?',
        [gatewayAgentId, resolvedWorkspaceId],
      );
    }

    // Update the task
    run(
      `UPDATE tasks SET status = ?, sync_status = ?, gateway_completion_notes = ?,
       ${agent ? 'assigned_agent_id = ?,' : ''} updated_at = ? WHERE id = ?`,
      [
        newStatus, 'synced', notes || summary || null,
        ...(agent ? [agent.id] : []),
        now, task.id,
      ],
    );

    // Log event
    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        eventType === 'task.completed' ? 'task_completed' : 'task_status_changed',
        agent?.id || null,
        task.id,
        `Webhook: ${summary || eventType || 'status update'}`,
        JSON.stringify({ correlationId, gatewayStatus, eventType }),
        now,
      ],
    );

    // Broadcast via SSE
    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });

    return NextResponse.json({
      success: true,
      task_id: task.id,
      new_status: newStatus,
      message: 'Task updated from webhook',
    });
  } catch (error) {
    console.error('[Webhook] openclaw-task-update error:', error);

    // Log malformed webhook to events
    const now = new Date().toISOString();
    run(
      `INSERT INTO events (id, type, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        uuidv4(), 'system',
        `Malformed webhook received at /api/webhooks/openclaw-task-update`,
        JSON.stringify({ error: String(error) }),
        now,
      ],
    );

    broadcast({
      type: 'integration_error',
      payload: { taskId: '', sessionId: '', summary: `Malformed webhook: ${String(error)}` },
    });

    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'active',
    endpoint: '/api/webhooks/openclaw-task-update',
    description: 'HTTP webhook for OpenClaw task state change events (future-ready)',
    primary_sync: 'WebSocket event listeners on the existing OpenClaw client connection',
  });
}
