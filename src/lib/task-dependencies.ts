import { v4 as uuidv4 } from 'uuid';
import { queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';

/**
 * Release downstream tasks whose prerequisites are all done.
 *
 * The conditional UPDATE makes release idempotent: concurrent prerequisite
 * completions can observe the same dependent, but only one can move it from
 * pending_dispatch to assigned.
 */
export function releaseReadyDependentTasks(completedTaskId: string): Task[] {
  const candidates = queryAll<Task>(
    `SELECT DISTINCT t.*
       FROM tasks t
       JOIN task_dependencies td ON td.task_id = t.id
      WHERE td.depends_on_task_id = ?
        AND t.status = 'pending_dispatch'
        AND NOT EXISTS (
          SELECT 1
            FROM task_dependencies remaining
            JOIN tasks prerequisite ON prerequisite.id = remaining.depends_on_task_id
           WHERE remaining.task_id = t.id
             AND prerequisite.status != 'done'
        )`,
    [completedTaskId],
  );

  const released: Task[] = [];
  const now = new Date().toISOString();

  for (const candidate of candidates) {
    const result = run(
      `UPDATE tasks
          SET status = 'assigned', updated_at = ?
        WHERE id = ? AND status = 'pending_dispatch'`,
      [now, candidate.id],
    );

    if (result.changes !== 1) continue;

    run(
      `INSERT INTO events (id, type, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        'task_dependencies_satisfied',
        candidate.id,
        `All prerequisites complete; "${candidate.title}" released for dispatch`,
        JSON.stringify({ completedTaskId }),
        now,
      ],
    );

    const updated = queryAll<Task>('SELECT * FROM tasks WHERE id = ?', [candidate.id])[0];
    if (updated) {
      broadcast({ type: 'task_updated', payload: updated });
      released.push(updated);
    }
  }

  return released;
}
