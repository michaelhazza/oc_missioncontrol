'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Bot, Check, Clock3, RefreshCw, Send, User } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

import { parseDatabaseDate } from '@/lib/dates';
import type { TaskActivity, TaskMessage } from '@/lib/types';

interface TaskChatProps {
  taskId: string;
  agentName?: string;
  onUnreadChange?: (count: number) => void;
}

type TimelineItem =
  | { kind: 'message'; at: string; value: TaskMessage }
  | { kind: 'activity'; at: string; value: TaskActivity };

export function TaskChat({ taskId, agentName, onUnreadChange }: TaskChatProps) {
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [activities, setActivities] = useState<TaskActivity[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [connection, setConnection] = useState<'live' | 'polling'>('live');
  const [lastSeq, setLastSeq] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const idempotencyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const [messagesRes, activitiesRes] = await Promise.all([
      fetch(`/api/tasks/${taskId}/messages`, { cache: 'no-store' }),
      fetch(`/api/tasks/${taskId}/activities`, { cache: 'no-store' }),
    ]);
    if (messagesRes.ok) {
      const data = await messagesRes.json();
      setMessages(data.messages || []);
      setLastSeq(data.lastSeq || 0);
      setUnreadCount(data.unreadCount || 0);
      onUnreadChange?.(data.unreadCount || 0);
    }
    if (activitiesRes.ok) setActivities(await activitiesRes.json());
    setLoading(false);
  }, [onUnreadChange, taskId]);

  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  useEffect(() => {
    const source = new EventSource('/api/events/stream');
    let polling: ReturnType<typeof setInterval> | undefined;
    source.onopen = () => setConnection('live');
    source.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data);
        if (update.type === 'task_message_updated' && update.payload.task_id === taskId) {
          const incoming = update.payload as TaskMessage;
          setMessages((current) => {
            const without = current.filter((item) => item.id !== incoming.id);
            return [...without, incoming].sort((a, b) => a.created_at.localeCompare(b.created_at));
          });
          setLastSeq((current) => Math.max(current, incoming.seq || 0));
          if (incoming.sender_type !== 'human') {
            setUnreadCount((current) => current + 1);
          }
        }
        if ((update.type === 'activity_logged' || update.type === 'task_activity_added') && update.payload.task_id === taskId) {
          const incoming = update.payload as TaskActivity;
          setActivities((current) => current.some((item) => item.id === incoming.id) ? current : [incoming, ...current]);
        }
      } catch { /* keep-alive or malformed event */ }
    };
    source.onerror = () => {
      source.close();
      setConnection('polling');
      polling = setInterval(() => load().catch(() => undefined), 5000);
    };
    return () => {
      source.close();
      if (polling) clearInterval(polling);
    };
  }, [load, taskId]);

  useEffect(() => {
    if (!lastSeq) return;
    const timer = setTimeout(() => {
      fetch(`/api/tasks/${taskId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_read', through_seq: lastSeq }),
      }).then((response) => response.ok ? response.json() : null).then((state) => {
        if (!state) return;
        setUnreadCount(state.unreadCount || 0);
        onUnreadChange?.(state.unreadCount || 0);
      }).catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [lastSeq, onUnreadChange, taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, activities.length]);

  const timeline = useMemo<TimelineItem[]>(() => [
    ...messages.map((value) => ({ kind: 'message' as const, at: value.created_at, value })),
    ...activities.map((value) => ({ kind: 'activity' as const, at: value.created_at, value })),
  ].sort((a, b) => a.at.localeCompare(b.at)), [activities, messages]);

  const send = async (retryMessage?: TaskMessage) => {
    const content = retryMessage?.content || draft.trim();
    if (!content || sending) return;
    const idempotencyKey = retryMessage?.client_idempotency_key
      || idempotencyRef.current
      || crypto.randomUUID();
    idempotencyRef.current = idempotencyKey;
    setSending(true);
    try {
      const response = await fetch(`/api/tasks/${taskId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          sender_type: 'human',
          idempotency_key: idempotencyKey,
          retry: Boolean(retryMessage),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Message failed');
      setMessages((current) => [...current.filter((item) => item.id !== result.id), result]
        .sort((a, b) => a.created_at.localeCompare(b.created_at)));
      if (!retryMessage) setDraft('');
      idempotencyRef.current = null;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Message failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="h-full min-h-[420px] flex flex-col -m-4">
      <div className="px-4 py-2 border-b border-mc-border flex items-center justify-between text-xs text-mc-text-secondary">
        <span>Task conversation with {agentName || 'assigned agent'} · activity is included chronologically</span>
        <span className="flex items-center gap-1.5">
          {unreadCount > 0 && <span className="rounded-full bg-mc-accent px-1.5 py-0.5 text-mc-bg font-semibold">{unreadCount} unread</span>}
          <span className={`w-2 h-2 rounded-full ${connection === 'live' ? 'bg-green-400' : 'bg-amber-400'}`} />
          {connection === 'live' ? 'Live' : 'Polling fallback'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-3">
        {loading && <div className="text-center text-sm text-mc-text-secondary py-10">Loading conversation…</div>}
        {!loading && timeline.length === 0 && (
          <div className="text-center text-sm text-mc-text-secondary py-10">
            No messages yet. Start a task-scoped conversation below.
          </div>
        )}
        {timeline.map((item) => {
          if (item.kind === 'activity') {
            return (
              <div key={`activity-${item.value.id}`} className="mx-auto max-w-3xl flex items-start gap-2 text-xs text-mc-text-secondary">
                <Clock3 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span><strong className="text-mc-text">{item.value.agent?.name || 'System'}:</strong> {item.value.message}</span>
                <span className="ml-auto whitespace-nowrap">{formatDistanceToNow(parseDatabaseDate(item.at), { addSuffix: true })}</span>
              </div>
            );
          }
          const message = item.value;
          const human = message.sender_type === 'human';
          return (
            <div key={message.id} className={`flex ${human ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[88%] sm:max-w-[72%] rounded-xl border px-3.5 py-3 ${human ? 'bg-mc-accent/10 border-mc-accent/30' : 'bg-mc-bg border-mc-border'}`}>
                <div className="flex items-center gap-2 text-xs font-medium mb-1.5">
                  {human ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                  <span>{message.sender_name}</span>
                  <span className="font-normal text-mc-text-secondary">{formatDistanceToNow(parseDatabaseDate(message.created_at), { addSuffix: true })}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                {human && (
                  <div className={`mt-2 flex items-center justify-end gap-1 text-[11px] ${message.delivery_status === 'failed' ? 'text-red-400' : 'text-mc-text-secondary'}`}>
                    {message.delivery_status === 'delivered' && <><Check className="w-3 h-3" /> Delivered</>}
                    {message.delivery_status === 'queued' && <><Clock3 className="w-3 h-3" /> Sending</>}
                    {message.delivery_status === 'failed' && (
                      <><AlertCircle className="w-3 h-3" /> {message.delivery_error || 'Delivery failed'}
                        <button onClick={() => send(message)} disabled={sending} className="ml-2 inline-flex items-center gap-1 underline hover:text-red-300">
                          <RefreshCw className="w-3 h-3" /> Retry
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-mc-border bg-mc-bg-secondary p-3 sm:p-4">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            rows={2}
            maxLength={8000}
            placeholder={`Message ${agentName || 'the assigned agent'}… (Shift+Enter for a new line)`}
            className="flex-1 min-h-[52px] max-h-36 resize-y bg-mc-bg border border-mc-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
          />
          <button
            type="button"
            onClick={() => send()}
            disabled={sending || !draft.trim()}
            className="min-h-[52px] px-4 rounded-lg bg-mc-accent text-mc-bg disabled:opacity-40 flex items-center gap-2 font-medium"
          >
            <Send className="w-4 h-4" />
            <span className="hidden sm:inline">{sending ? 'Sending…' : 'Send'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
