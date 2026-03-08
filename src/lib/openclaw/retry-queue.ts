/**
 * Retry Queue — Automatic Dispatch Retry
 *
 * Sweeps tasks with sync_status='pending_sync' every 60 seconds and
 * retries gateway dispatch. DB-backed — survives server restarts.
 *
 * Initialised once in instrumentation.ts via startRetryQueue().
 */

import { queryAll } from '@/lib/db';
import { retryDispatch } from './dispatch';
import { getWorkspaceSettings } from './workspace-settings';
import type { Task } from '@/lib/types';

let retryInterval: NodeJS.Timeout | null = null;

export function startRetryQueue(): void {
  if (retryInterval) return; // Already running

  console.log('[RetryQueue] Starting 60s sweep for pending_sync tasks');

  retryInterval = setInterval(async () => {
    try {
      await sweepPendingTasks();
    } catch (err) {
      console.error('[RetryQueue] Sweep error:', err);
    }
  }, 60_000);
}

async function sweepPendingTasks(): Promise<void> {
  const pending = queryAll<Task>(
    `SELECT * FROM tasks WHERE sync_status IN ('pending_sync') AND assigned_agent_id IS NOT NULL`,
  );

  if (pending.length === 0) return;

  console.log(`[RetryQueue] Found ${pending.length} pending_sync tasks`);

  for (const task of pending) {
    const settings = getWorkspaceSettings(task.workspace_id);
    const maxRetries = settings.max_retry_count;

    await retryDispatch(task.id, maxRetries);
  }
}

export function stopRetryQueue(): void {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
  }
}
