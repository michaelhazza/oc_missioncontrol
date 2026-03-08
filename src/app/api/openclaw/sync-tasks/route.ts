/**
 * GET /api/openclaw/sync-tasks
 *
 * Polling fallback for deployments where WebSocket events are unreliable.
 * Queries OpenClaw session history and checks for completion markers in
 * agent messages, then updates local task state accordingly.
 *
 * POST /api/openclaw/sync-tasks
 * Manual trigger for a full sync sweep.
 */

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import type { Task, OpenClawSession } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface SyncResult {
  checked: number;
  updated: number;
  errors: string[];
}

async function syncActiveTasks(workspaceId?: string): Promise<SyncResult> {
  const result: SyncResult = { checked: 0, updated: 0, errors: [] };

  // Find active tasks that are dispatched but not yet completed
  let sql = `
    SELECT t.*, os.openclaw_session_id
    FROM tasks t
    JOIN openclaw_sessions os ON os.agent_id = t.assigned_agent_id AND os.status = 'active'
    WHERE t.status IN ('assigned', 'in_progress') AND t.sync_status IN ('synced', 'local')
  `;
  const params: unknown[] = [];

  if (workspaceId) {
    sql += ' AND t.workspace_id = ?';
    params.push(workspaceId);
  }

  const tasks = queryAll<Task & { openclaw_session_id: string }>(sql, params);

  if (tasks.length === 0) return result;

  const client = getOpenClawClient();
  if (!client.isConnected()) {
    try {
      await client.connect();
    } catch (err) {
      result.errors.push('Failed to connect to OpenClaw Gateway');
      return result;
    }
  }

  for (const task of tasks) {
    result.checked++;

    try {
      // Get session history and check for completion messages
      const history = await client.getSessionHistory(task.openclaw_session_id) as Array<{
        role?: string;
        content?: string;
      }>;

      if (!Array.isArray(history)) continue;

      // Look for TASK_COMPLETE messages in recent assistant messages
      for (const msg of history) {
        if (msg.role !== 'assistant' || !msg.content) continue;

        // Check for correlationId-based completion
        const correlationMatch = msg.content.match(/TASK_COMPLETE\[([a-f0-9-]{36})\]:\s*(.+)/i);
        if (correlationMatch) {
          const [, correlationId, summary] = correlationMatch;
          if (correlationId === task.gateway_task_id) {
            updateTaskFromSync(task, summary.trim());
            result.updated++;
            break;
          }
        }

        // Fallback: legacy TASK_COMPLETE
        const legacyMatch = msg.content.match(/TASK_COMPLETE:\s*(.+)/i);
        if (legacyMatch) {
          updateTaskFromSync(task, legacyMatch[1].trim());
          result.updated++;
          break;
        }
      }
    } catch (err) {
      result.errors.push(`Task ${task.id}: ${(err as Error).message}`);
    }
  }

  return result;
}

function updateTaskFromSync(task: Task, summary: string): void {
  const now = new Date().toISOString();

  run(
    `UPDATE tasks SET status = 'review', sync_status = 'synced',
     gateway_completion_notes = ?, updated_at = ? WHERE id = ?`,
    [summary, now, task.id],
  );

  if (task.assigned_agent_id) {
    run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['standby', now, task.assigned_agent_id]);
  }

  run(
    `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), 'task_completed', task.assigned_agent_id || null, task.id, `Polling sync: ${summary}`, now],
  );

  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
  if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });
}

export async function GET(request: NextRequest) {
  try {
    const workspaceId = request.nextUrl.searchParams.get('workspace_id') || undefined;
    const result = await syncActiveTasks(workspaceId);

    return NextResponse.json({
      message: `Sync complete: ${result.updated}/${result.checked} tasks updated`,
      ...result,
    });
  } catch (error) {
    console.error('[sync-tasks] Error:', error);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const workspaceId = body.workspace_id || undefined;
    const result = await syncActiveTasks(workspaceId);

    return NextResponse.json({
      message: `Manual sync complete: ${result.updated}/${result.checked} tasks updated`,
      ...result,
    });
  } catch (error) {
    console.error('[sync-tasks] Error:', error);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
