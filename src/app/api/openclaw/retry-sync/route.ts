/**
 * POST /api/openclaw/retry-sync
 *
 * Sweeps tasks with sync_status='pending_sync' and retries gateway dispatch.
 * Designed to be called on a schedule (cron) or manually from the Settings page.
 * Respects the per-workspace max_retry_count configuration.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';
import { retryDispatch } from '@/lib/openclaw/dispatch';
import { getWorkspaceSettings } from '@/lib/openclaw/workspace-settings';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id');

    // Find all pending_sync tasks, optionally scoped to a workspace
    let sql = `SELECT * FROM tasks WHERE sync_status = 'pending_sync'`;
    const params: unknown[] = [];

    if (workspaceId) {
      sql += ' AND workspace_id = ?';
      params.push(workspaceId);
    }

    sql += ' ORDER BY last_sync_attempt ASC';
    const pendingTasks = queryAll<Task>(sql, params);

    if (pendingTasks.length === 0) {
      return NextResponse.json({ message: 'No pending sync tasks', retried: 0, succeeded: 0, failed: 0 });
    }

    const results = { retried: 0, succeeded: 0, failed: 0, errors: [] as string[] };

    for (const task of pendingTasks) {
      const settings = getWorkspaceSettings(task.workspace_id);
      const maxRetries = settings.max_retry_count;

      results.retried++;
      const result = await retryDispatch(task.id, maxRetries);

      if (result.success) {
        results.succeeded++;
      } else {
        results.failed++;
        results.errors.push(`Task ${task.id}: ${result.error}`);
      }
    }

    return NextResponse.json({
      message: `Retry sync complete: ${results.succeeded}/${results.retried} succeeded`,
      ...results,
    });
  } catch (error) {
    console.error('[retry-sync] Error:', error);
    return NextResponse.json({ error: 'Retry sync failed' }, { status: 500 });
  }
}
