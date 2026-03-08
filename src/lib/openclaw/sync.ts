/**
 * WebSocket Event Listener for Agent Completion Sync
 *
 * Listens to WebSocket events from the OpenClaw gateway client and
 * processes agent completion responses. Matches responses to tasks
 * using correlationId (primary) or content-based matching (fallback).
 *
 * This is the PRIMARY sync mechanism for OpenClaw → Mission Control.
 * The HTTP webhook endpoint at /api/webhooks/openclaw-task-update is
 * built as a secondary/future-ready path.
 *
 * NOTE: correlationId matching requires agents to echo it back in
 * their completion responses. This is NOT currently enforced in agent
 * prompt templates — see INTEGRATION.md for the known gap.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { mapGatewayState } from './workspace-settings';
import type { Task, Agent } from '@/lib/types';

let listenerRegistered = false;

/**
 * Register the WebSocket event listener for agent completions.
 * Safe to call multiple times — only registers once.
 */
export function registerCompletionListener(): void {
  if (listenerRegistered) return;

  const client = getOpenClawClient();

  // Listen for notification events from the gateway
  client.on('notification', (data: Record<string, unknown>) => {
    try {
      processGatewayEvent(data);
    } catch (err) {
      console.error('[Sync] Error processing gateway event:', err);
    }
  });

  // Also listen for specific chat events that may contain completion messages
  client.on('chat.message', (data: Record<string, unknown>) => {
    try {
      processChatMessage(data);
    } catch (err) {
      console.error('[Sync] Error processing chat message:', err);
    }
  });

  listenerRegistered = true;
  console.log('[Sync] WebSocket completion listener registered');
}

/**
 * Process a generic gateway event for task state changes.
 */
function processGatewayEvent(data: Record<string, unknown>): void {
  const event = data.event as string | undefined;
  const payload = data.payload as Record<string, unknown> | undefined;

  if (!event || !payload) return;

  // Look for task completion events
  if (event === 'task.completed' || event === 'agent.completed') {
    const correlationId = payload.correlationId as string | undefined;
    const summary = (payload.summary ?? payload.message) as string | undefined;

    if (correlationId) {
      handleCompletionByCorrelationId(correlationId, summary || 'Task completed');
    }
  }
}

/**
 * Process a chat message that may contain a TASK_COMPLETE marker.
 */
function processChatMessage(data: Record<string, unknown>): void {
  const content = (data.content ?? data.message) as string | undefined;
  if (!content || typeof content !== 'string') return;

  // Try correlationId-based matching first: TASK_COMPLETE[uuid]: summary
  const correlationMatch = content.match(/TASK_COMPLETE\[([a-f0-9-]{36})\]:\s*(.+)/i);
  if (correlationMatch) {
    const [, correlationId, summary] = correlationMatch;
    handleCompletionByCorrelationId(correlationId, summary.trim());
    return;
  }

  // Fallback: content-based matching for TASK_COMPLETE: summary
  const legacyMatch = content.match(/TASK_COMPLETE:\s*(.+)/i);
  if (legacyMatch) {
    const summary = legacyMatch[1].trim();
    handleCompletionByContentMatch(data, summary);
  }
}

/**
 * Handle task completion matched by correlationId (primary path).
 */
function handleCompletionByCorrelationId(correlationId: string, summary: string): void {
  const now = new Date().toISOString();

  // Try matching tasks by correlation_id first, fall back to gateway_task_id
  const task = queryOne<Task>(
    'SELECT * FROM tasks WHERE correlation_id = ?',
    [correlationId],
  ) ?? queryOne<Task>(
    'SELECT * FROM tasks WHERE gateway_task_id = ?',
    [correlationId],
  );

  if (task) {
    // Don't overwrite if already in a later state
    if (['done', 'review', 'verification'].includes(task.status)) {
      console.log(`[Sync] Task ${task.id} already in ${task.status}, skipping completion`);
    } else {
      completeTask(task, summary, now);
    }
  }

  // Also check content_items — a Generate Script dispatch stores correlation_id
  const contentItem = queryOne<{ id: string; generation_status: string }>(
    'SELECT id, generation_status FROM content_items WHERE correlation_id = ?',
    [correlationId],
  );

  if (contentItem) {
    if (contentItem.generation_status === 'generating') {
      run(
        `UPDATE content_items SET generation_status = ?, script = ?, updated_at = ? WHERE id = ?`,
        ['completed', summary, now, contentItem.id],
      );
      broadcast({ type: 'content_updated', payload: { id: contentItem.id, generation_status: 'completed' } as unknown as import('@/lib/types').ContentItem });
      console.log(`[Sync] Content item ${contentItem.id} generation completed`);
    }
    return;
  }

  if (!task && !contentItem) {
    console.warn(`[Sync] No task or content item found for correlationId: ${correlationId}`);
  }
}

/**
 * Fallback: handle completion by matching session/agent to active task.
 */
function handleCompletionByContentMatch(data: Record<string, unknown>, summary: string): void {
  const now = new Date().toISOString();
  const sessionId = (data.sessionKey ?? data.session_id) as string | undefined;

  if (!sessionId) {
    console.warn('[Sync] Content-based match but no session info available');
    return;
  }

  // Find the agent's active task
  const tasks = queryAll<Task>(
    `SELECT t.* FROM tasks t
     JOIN openclaw_sessions os ON os.agent_id = t.assigned_agent_id
     WHERE os.openclaw_session_id = ? AND os.status = 'active'
     AND t.status IN ('assigned', 'in_progress')
     ORDER BY t.updated_at DESC LIMIT 1`,
    [sessionId],
  );

  if (tasks.length === 0) {
    console.warn(`[Sync] No active task found for session: ${sessionId}`);
    return;
  }

  completeTask(tasks[0], summary, now);
}

/**
 * Mark a task as completed (moves to testing stage).
 */
function completeTask(task: Task, summary: string, now: string): void {
  // Move to testing (workflow engine will handle further transitions)
  run(
    `UPDATE tasks SET status = ?, sync_status = ?, gateway_completion_notes = ?, updated_at = ? WHERE id = ?`,
    ['testing', 'synced', summary, now, task.id],
  );

  // Set agent back to standby
  if (task.assigned_agent_id) {
    run(
      'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
      ['standby', now, task.assigned_agent_id],
    );
  }

  // Log completion event
  const agent = task.assigned_agent_id
    ? queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [task.assigned_agent_id])
    : undefined;

  run(
    `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(), 'task_completed', task.assigned_agent_id || null, task.id,
      `${agent?.name || 'Agent'} completed: ${summary}`,
      JSON.stringify({ correlationId: task.gateway_task_id, summary }),
      now,
    ],
  );

  // Log activity
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(), task.id, task.assigned_agent_id || null,
      'completed', `Task completed: ${summary}`, now,
    ],
  );

  // Broadcast via SSE
  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }

  console.log(`[Sync] Task ${task.id} completed by agent: ${summary}`);
}
