/**
 * Monitor Cron — Stale Task Detection
 *
 * Runs on a configurable interval (default 15 minutes). Queries for tasks
 * that have been in_progress longer than the stale threshold, formats a
 * structured message, and dispatches it to the monitor agent.
 *
 * Initialised once in instrumentation.ts via startMonitorCron().
 * Uses setInterval — not node-cron.
 */

import { queryAll, queryOne, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { getOpenClawClient } from './client';
import { getWorkspaceSettings } from './workspace-settings';
import { broadcast } from '@/lib/events';
import type { Agent, Task } from '@/lib/types';

let monitorInterval: NodeJS.Timeout | null = null;

export function startMonitorCron(): void {
  if (monitorInterval) return; // Already running

  void (async () => {
    const settings = getWorkspaceSettings('default');
    const intervalMinutes = settings.monitor_cron_interval_minutes;
    const intervalMs = intervalMinutes * 60 * 1000;

    console.log(`[MonitorCron] Starting stale task check every ${intervalMinutes} minutes`);

    monitorInterval = setInterval(async () => {
      try {
        await runStaleTaskCheck();
      } catch (err) {
        console.error('[MonitorCron] Error during stale task check:', err);
      }
    }, intervalMs);
  })();
}

interface StaleTaskRow {
  id: string;
  title: string;
  correlation_id: string | null;
  last_sync_attempt: string;
  agent_name: string | null;
  minutes_overdue: number;
}

async function runStaleTaskCheck(): Promise<void> {
  const settings = getWorkspaceSettings('default');
  const thresholdMinutes = settings.stale_task_threshold_minutes;

  // Find the monitor agent
  const monitorAgent = queryOne<Agent>(
    `SELECT * FROM agents WHERE mc_role = 'monitor' LIMIT 1`,
  );

  if (!monitorAgent) return; // No monitor configured — do nothing

  // Query for stale tasks
  const staleTasks = queryAll<StaleTaskRow>(
    `SELECT
      t.id,
      t.title,
      t.correlation_id,
      t.last_sync_attempt,
      a.name as agent_name,
      CAST(ROUND((julianday('now') - julianday(t.last_sync_attempt)) * 24 * 60) AS INTEGER) as minutes_overdue
    FROM tasks t
    LEFT JOIN agents a ON t.assigned_agent_id = a.id
    WHERE
      t.status = 'in_progress'
      AND t.last_sync_attempt IS NOT NULL
      AND t.last_sync_attempt < datetime('now', '-${thresholdMinutes} minutes')
    ORDER BY minutes_overdue DESC`,
  );

  if (staleTasks.length === 0) return; // Nothing stale

  const now = new Date().toISOString();

  // Split into two buckets:
  // - 1x–2x threshold overdue: nudge via monitor agent (one message, no LLM escalation)
  // - >2x threshold overdue: auto-fail directly in MC — no LLM call needed
  const nudgeTasks: StaleTaskRow[] = [];
  const autoFailTasks: StaleTaskRow[] = [];

  for (const t of staleTasks) {
    if (t.minutes_overdue > thresholdMinutes * 2) {
      autoFailTasks.push(t);
    } else {
      nudgeTasks.push(t);
    }
  }

  // Auto-fail tasks that have been stale for >2× threshold — no LLM needed
  for (const t of autoFailTasks) {
    const reason = `Auto-failed: agent unresponsive for ${Math.round(t.minutes_overdue)} minutes (threshold: ${thresholdMinutes * 2} min)`;
    console.log(`[MonitorCron] Auto-failing stale task ${t.id}: ${reason}`);
    run(
      'UPDATE tasks SET status = ?, status_reason = ?, sync_status = ?, updated_at = ? WHERE id = ?',
      ['review', reason, 'failed', now, t.id],
    );
    // Free the agent back to standby
    const task = queryOne<Task>('SELECT assigned_agent_id FROM tasks WHERE id = ?', [t.id]);
    if (task?.assigned_agent_id) {
      run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['standby', now, task.assigned_agent_id]);
    }
    // Log the auto-fail event
    run(
      `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'task_auto_failed', t.id, reason, now],
    );
    // Broadcast so the UI updates immediately
    const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [t.id]);
    if (updated) broadcast({ type: 'task_updated', payload: updated });
  }

  // Only nudge the first-cycle stale tasks (1x–2x threshold) via the monitor agent
  if (nudgeTasks.length === 0) return;

  console.log(`[MonitorCron] Nudging ${nudgeTasks.length} stale task(s) via monitor agent`);

  const message = formatStaleTaskMessage(nudgeTasks);

  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      console.warn('[MonitorCron] Gateway not connected, skipping monitor nudge');
      return;
    }

    const prefix = monitorAgent.session_key_prefix || 'agent:main:';
    const sessionKey = `${prefix}mission-control-monitor`;

    await client.call('chat.send', {
      sessionKey,
      message,
    });
  } catch (err) {
    console.error('[MonitorCron] Failed to dispatch to monitor agent:', err);
  }
}

function formatStaleTaskMessage(tasks: StaleTaskRow[]): string {
  const lines = ['Stale tasks detected — please review and nudge:', ''];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const hours = Math.floor(t.minutes_overdue / 60);
    const mins = t.minutes_overdue % 60;
    const overdueStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    lines.push(`${i + 1}. Task: ${t.title}`);
    lines.push(
      `   Agent: ${t.agent_name || 'Unassigned'} | Overdue: ${overdueStr}${t.correlation_id ? ` | correlationId: ${t.correlation_id}` : ''}`,
    );
    lines.push('');
  }

  lines.push('Send one nudge to each stale agent and stop. Do not escalate further or send any follow-up messages.');

  return lines.join('\n');
}

export function stopMonitorCron(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}
