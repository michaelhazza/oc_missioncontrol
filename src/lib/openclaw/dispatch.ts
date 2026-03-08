/**
 * Task Dispatch Service — Mission Control → OpenClaw Gateway
 *
 * Dispatches tasks to the OpenClaw gateway via WebSocket RPC (chat.send).
 * Generates a correlationId (UUID) for round-trip tracking, stores it as
 * gateway_task_id in the local SQLite task record. If the gateway is
 * unreachable, saves the task with sync_status='pending_sync' for later
 * retry via the /api/openclaw/retry-sync endpoint.
 *
 * This module is the single source of truth for gateway dispatch logic.
 * API routes should call dispatchTaskToGateway() instead of inlining
 * dispatch code.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import type { Task, Agent, OpenClawSession } from '@/lib/types';

export interface DispatchResult {
  success: boolean;
  correlationId: string;
  error?: string;
}

/**
 * Dispatch a task to the OpenClaw gateway via chat.send.
 *
 * @param taskId - The Mission Control task ID
 * @returns DispatchResult with success status and correlationId
 */
export async function dispatchTaskToGateway(taskId: string): Promise<DispatchResult> {
  const correlationId = uuidv4();
  const now = new Date().toISOString();

  // Fetch task with assigned agent info
  const task = queryOne<Task & { assigned_agent_name?: string }>(
    `SELECT t.*, a.name as assigned_agent_name
     FROM tasks t
     LEFT JOIN agents a ON t.assigned_agent_id = a.id
     WHERE t.id = ?`,
    [taskId],
  );

  if (!task) {
    return { success: false, correlationId, error: 'Task not found' };
  }

  if (!task.assigned_agent_id) {
    return { success: false, correlationId, error: 'Task has no assigned agent' };
  }

  const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [task.assigned_agent_id]);
  if (!agent) {
    return { success: false, correlationId, error: 'Assigned agent not found' };
  }

  // Store the correlationId before attempting dispatch.
  // correlation_id is stable across retries; gateway_task_id may be updated
  // by OpenClaw on each dispatch attempt.
  const existingCorrelationId = task.correlation_id;
  const finalCorrelationId = existingCorrelationId || correlationId;
  run(
    'UPDATE tasks SET correlation_id = COALESCE(correlation_id, ?), gateway_task_id = ?, last_sync_attempt = ?, updated_at = ? WHERE id = ?',
    [finalCorrelationId, correlationId, now, now, taskId],
  );

  // Attempt gateway dispatch
  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    // Get or create OpenClaw session for the agent
    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [agent.id, 'active'],
    );

    if (!session) {
      const sessionId = uuidv4();
      const openclawSessionId = `mission-control-${agent.name.toLowerCase().replace(/\s+/g, '-')}`;
      run(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, agent.id, openclawSessionId, 'mission-control', 'active', taskId, now, now],
      );
      session = queryOne<OpenClawSession>('SELECT * FROM openclaw_sessions WHERE id = ?', [sessionId]);
    }

    if (!session) {
      throw new Error('Failed to create agent session');
    }

    // Build the structured task message with correlationId
    const priorityEmoji: Record<string, string> = { low: '🔵', normal: '⚪', high: '🟡', urgent: '🔴' };
    const taskMessage = buildTaskMessage(task, agent, finalCorrelationId, priorityEmoji[task.priority] || '⚪');

    // Send via chat.send RPC
    const prefix = agent.session_key_prefix || 'agent:main:';
    const sessionKey = `${prefix}${session.openclaw_session_id}`;
    await client.call('chat.send', {
      sessionKey,
      message: taskMessage,
      idempotencyKey: `dispatch-${correlationId}`,
    });

    // Mark as synced
    run(
      'UPDATE tasks SET sync_status = ?, updated_at = ? WHERE id = ?',
      ['synced', now, taskId],
    );

    // Log event
    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(), 'task_dispatched', agent.id, taskId,
        `Task "${task.title}" dispatched to ${agent.name} via gateway`,
        JSON.stringify({ correlationId: finalCorrelationId, sessionKey }),
        now,
      ],
    );

    // Broadcast update
    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });

    return { success: true, correlationId: finalCorrelationId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown dispatch error';
    console.error(`[Dispatch] Failed to dispatch task ${taskId}:`, errorMsg);

    // Save as pending_sync for retry
    run(
      `UPDATE tasks SET sync_status = ?, retry_count = COALESCE(retry_count, 0),
       last_sync_attempt = ?, planning_dispatch_error = ?, updated_at = ? WHERE id = ?`,
      ['pending_sync', now, `Gateway dispatch failed: ${errorMsg}`, now, taskId],
    );

    // Log integration error to events and broadcast
    run(
      `INSERT INTO events (id, type, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(), 'system', taskId,
        `Gateway dispatch failed for "${task.title}": ${errorMsg}`,
        JSON.stringify({ correlationId, error: errorMsg }),
        now,
      ],
    );

    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });
    broadcast({
      type: 'integration_error',
      payload: { taskId, sessionId: '', agentName: agent.name, summary: `Dispatch failed: ${errorMsg}` },
    });

    return { success: false, correlationId: finalCorrelationId, error: errorMsg };
  }
}

/**
 * Retry dispatch for a single task that is in pending_sync state.
 */
export async function retryDispatch(taskId: string, maxRetries: number): Promise<DispatchResult> {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) return { success: false, correlationId: '', error: 'Task not found' };

  if ((task.retry_count ?? 0) >= maxRetries) {
    const now = new Date().toISOString();
    run(
      'UPDATE tasks SET sync_status = ?, updated_at = ? WHERE id = ?',
      ['sync_failed', now, taskId],
    );
    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });
    return { success: false, correlationId: task.gateway_task_id || '', error: 'Max retries exceeded' };
  }

  // Increment retry count
  run(
    'UPDATE tasks SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?',
    [taskId],
  );

  return dispatchTaskToGateway(taskId);
}

/**
 * Build the structured message sent to the agent via chat.send.
 *
 * The message is intentionally lean — the full brief lives in MC and the
 * agent must fetch it via GET /api/tasks/{id} before starting work. This
 * keeps LLM context tight and MC as the single source of truth.
 */
function buildTaskMessage(
  task: Task & { assigned_agent_name?: string },
  agent: Agent,
  correlationId: string,
  priorityEmoji: string,
): string {
  const mcUrl = (process.env.MISSION_CONTROL_URL || 'http://localhost:4000').replace(/\/$/, '');

  const mattermostLine = agent.mattermost_channel
    ? `\n**Output channel:** Post final output to Mattermost \`#${agent.mattermost_channel}\`, then log the post URL as a deliverable (step 3 below).`
    : '';

  const masterDelegationNote = agent.is_master
    ? `\n**As orchestrator:** When you delegate this task to a specialist, first update the task status to \`assigned\` and set \`assigned_agent_id\` to the specialist's MC agent ID (step 1a below), then move it to \`in_progress\` once they begin.`
    : '';

  return `${priorityEmoji} **TASK ASSIGNED**

**Task:** ${task.title}
**Task ID:** \`${task.id}\`
**Full brief:** ${mcUrl}/api/tasks/${task.id}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
Fetch the full brief via \`GET ${mcUrl}/api/tasks/${task.id}\` before starting work. The \`description\` and \`brief\` fields contain all context and acceptance criteria.${mattermostLine}${masterDelegationNote}

---

**MANDATORY API CALLS — execute in this order:**

1. **Mark as in progress** immediately when you begin (before any work):
\`\`\`
PATCH ${mcUrl}/api/tasks/${task.id}
Content-Type: application/json
{ "status": "in_progress" }
\`\`\`
${agent.is_master ? `\n1a. **When delegating to a specialist**, set assigned agent first:\n\`\`\`\nPATCH ${mcUrl}/api/tasks/${task.id}\nContent-Type: application/json\n{ "status": "assigned", "assigned_agent_id": "<specialist_mc_agent_id>" }\n\`\`\`\n` : ''}
2. **Log deliverables** for each output (file path, URL, or artifact):
\`\`\`
POST ${mcUrl}/api/tasks/${task.id}/deliverables
Content-Type: application/json
{ "deliverable_type": "url", "title": "<output title>", "path": "<url or file path>", "description": "<optional>" }
\`\`\`
${agent.mattermost_channel ? `Use \`deliverable_type: "url"\` to record the Mattermost post URL from \`#${agent.mattermost_channel}\`.` : ''}

3. **Signal completion** — end your final response with this exact line:
\`TASK_COMPLETE[${correlationId}]: [one-line summary of what you did]\`

The correlationId \`${correlationId}\` is required for Mission Control to detect completion. Do not omit or alter it.
Do not send any other messages after completion. Do not report back to any agent or ask for confirmation.`;
}
