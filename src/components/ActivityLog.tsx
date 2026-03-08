/**
 * ActivityLog Component
 * Displays chronological activity log for a task.
 * Uses SSE for live updates with polling fallback.
 */

'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';
import type { TaskActivity } from '@/lib/types';

interface ActivityLogProps {
  taskId: string;
}

export function ActivityLog({ taskId }: ActivityLogProps) {
  const [activities, setActivities] = useState<TaskActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const loadActivities = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoading(true);

      const res = await fetch(`/api/tasks/${taskId}/activities`);
      const data = await res.json();

      if (res.ok) {
        setActivities(data);
      }
    } catch (error) {
      console.error('Failed to load activities:', error);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // Initial load
  useEffect(() => {
    loadActivities(true);
  }, [taskId, loadActivities]);

  // SSE subscription with polling fallback
  useEffect(() => {
    let cancelled = false;

    const connectSSE = () => {
      const es = new EventSource('/api/events/stream');
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        if (cancelled) return;
        // Skip keep-alive comments
        if (event.data.startsWith(':')) return;

        try {
          const sseEvent = JSON.parse(event.data);

          // Live activity append for this task
          if (sseEvent.type === 'activity_logged' || sseEvent.type === 'task_activity_added') {
            const activity = sseEvent.payload as TaskActivity;
            if (activity.task_id === taskId) {
              setActivities((prev) => {
                // Dedupe by id
                if (prev.some((a) => a.id === activity.id)) return prev;
                // Prepend (newest first)
                return [activity, ...prev];
              });
            }
          }
        } catch {
          // Ignore parse errors (keep-alive pings, etc.)
        }
      };

      es.onerror = () => {
        // SSE failed — close and fall back to polling
        es.close();
        eventSourceRef.current = null;
        if (!cancelled) {
          startPolling();
        }
      };

      // Stop polling if SSE connects successfully
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };

    const startPolling = () => {
      if (pollingRef.current) return;
      pollingRef.current = setInterval(async () => {
        if (cancelled) return;
        try {
          const res = await fetch(`/api/tasks/${taskId}/activities`);
          if (res.ok) {
            const data = await res.json();
            setActivities(data);
          }
        } catch {
          // Ignore polling errors
        }
      }, 5000);
    };

    connectSSE();

    return () => {
      cancelled = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [taskId]);

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'spawned':
        return '🚀';
      case 'updated':
        return '✏️';
      case 'completed':
        return '✅';
      case 'file_created':
        return '📄';
      case 'status_changed':
        return '🔄';
      case 'created':
        return '📋';
      case 'assigned':
        return '👤';
      case 'progress':
        return '⏳';
      case 'blocked':
        return '🚫';
      case 'note':
        return '📝';
      default:
        return '📝';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-mc-text-secondary">Loading activities...</div>
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-mc-text-secondary">
        <div className="text-4xl mb-2">📝</div>
        <p>No activity yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {activities.map((activity) => (
        <div
          key={activity.id}
          className="flex gap-3 p-3 bg-mc-bg rounded-lg border border-mc-border"
        >
          {/* Icon */}
          <div className="text-2xl flex-shrink-0">
            {getActivityIcon(activity.activity_type)}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Agent info */}
            {activity.agent && (
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm">{activity.agent.avatar_emoji}</span>
                <span className="text-sm font-medium text-mc-text">
                  {activity.agent.name}
                </span>
              </div>
            )}

            {/* Message */}
            <p className="text-sm text-mc-text break-words">
              {activity.message}
            </p>

            {/* Metadata */}
            {activity.metadata && (
              <div className="mt-2 p-2 bg-mc-bg-tertiary rounded text-xs text-mc-text-secondary font-mono">
                {typeof activity.metadata === 'string'
                  ? activity.metadata
                  : JSON.stringify(JSON.parse(activity.metadata), null, 2)}
              </div>
            )}

            {/* Timestamp */}
            <div className="text-xs text-mc-text-secondary mt-2">
              {formatDistanceToNow(new Date(activity.created_at), { addSuffix: true })}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
