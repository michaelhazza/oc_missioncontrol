import { notFound, redirect } from 'next/navigation';
import { queryOne } from '@/lib/db';

interface TaskLocation {
  id: string;
  workspace_id: string;
}

export default function TaskDeepLinkPage({ params }: { params: { id: string } }) {
  const task = queryOne<TaskLocation>('SELECT id, workspace_id FROM tasks WHERE id = ?', [params.id]);

  if (!task) {
    notFound();
  }

  redirect(`/workspace/${encodeURIComponent(task.workspace_id)}?task=${encodeURIComponent(task.id)}`);
}
