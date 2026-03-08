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
import { getWorkspaceSettings } from './workspace-settings';
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

  // Store the correlationId before attempting dispatch
  run(
    'UPDATE tasks SET gateway_task_id = ?, last_sync_attempt = ?, updated_at = ? WHERE id = ?',
    [correlationId, now, now, taskId],
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
    const taskMessage = buildTaskMessage(task, agent, correlationId, priorityEmoji[task.priority] || '⚪');

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
        JSON.stringify({ correlationId, sessionKey }),
        now,
      ],
    );

    // Broadcast update
    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });

    return { success: true, correlationId };
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

    return { success: false, correlationId, error: errorMsg };
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
 */
function buildTaskMessage(
  task: Task & { assigned_agent_name?: string },
  agent: Agent,
  correlationId: string,
  priorityEmoji: string,
): string {
  const settings = getWorkspaceSettings(task.workspace_id);

  return `${priorityEmoji} **NEW TASK DISPATCHED**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}**Task ID:** ${task.id}
**Correlation ID:** ${correlationId}

---

**IMPORTANT:** When you complete this task, include the following in your response:
\`TASK_COMPLETE[${correlationId}]: [brief summary of what you did]\`

This correlation ID is required for Mission Control to track your work.`;
}
