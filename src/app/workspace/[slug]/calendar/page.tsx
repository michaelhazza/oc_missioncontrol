'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import {
  format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachDayOfInterval, isSameMonth, isSameDay, isToday, addMonths, subMonths
} from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, X, Loader2, Clock, CheckSquare } from 'lucide-react';
import { Header } from '@/components/Header';
import type { Task } from '@/lib/types';

interface CalendarEvent {
  id: string;
  title: string;
  date: Date;
  type: 'task' | 'cron';
  status?: string;
  color: string;
}

export default function CalendarPage() {
  const params = useParams();
  const slug = params?.slug as string;
  const workspaceId = 'default';

  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTask, setNewTask] = useState({ title: '', description: '', due_date: '' });
  const [saving, setSaving] = useState(false);

  const STATUS_COLORS: Record<string, string> = {
    done: 'bg-mc-accent-green/70',
    in_progress: 'bg-mc-accent/70',
    review: 'bg-mc-accent-purple/70',
    testing: 'bg-mc-accent-yellow/70',
    inbox: 'bg-mc-text-secondary/50',
    assigned: 'bg-mc-accent-cyan/70',
    planning: 'bg-mc-accent-pink/50',
    pending_dispatch: 'bg-mc-text-secondary/30',
    verification: 'bg-mc-accent-purple/50',
    cron: 'bg-orange-400/70',
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [tasksRes] = await Promise.all([
        fetch(`/api/tasks?workspace_id=${workspaceId}`),
      ]);

      const allEvents: CalendarEvent[] = [];

      if (tasksRes.ok) {
        const tasks: Task[] = await tasksRes.json();
        for (const task of tasks) {
          if (task.due_date) {
            allEvents.push({
              id: task.id,
              title: task.title,
              date: new Date(task.due_date),
              type: 'task',
              status: task.status,
              color: STATUS_COLORS[task.status] || STATUS_COLORS['inbox'],
            });
          }
        }
      }

      setEvents(allEvents);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { loadData(); }, [loadData]);

  const calendarDays = eachDayOfInterval({
    start: startOfWeek(startOfMonth(currentMonth), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(currentMonth), { weekStartsOn: 1 }),
  });

  const eventsForDay = (day: Date) => events.filter(e => isSameDay(e.date, day));
  const selectedDayEvents = selectedDay ? eventsForDay(selectedDay) : [];

  const handleCreateTask = async () => {
    if (!newTask.title.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTask.title,
          description: newTask.description,
          due_date: newTask.due_date || (selectedDay ? format(selectedDay, 'yyyy-MM-dd') : undefined),
          workspace_id: workspaceId,
        }),
      });
      if (res.ok) {
        await loadData();
        setShowCreateModal(false);
        setNewTask({ title: '', description: '', due_date: '' });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-mc-bg overflow-hidden">
      <Header workspace={{ id: workspaceId, name: slug, slug, icon: '📅', created_at: '', updated_at: '' }} />

      <div className="flex-1 overflow-hidden flex flex-col p-4 gap-4">
        {/* Header row */}
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <button onClick={() => setCurrentMonth(m => subMonths(m, 1))} className="p-2 hover:bg-mc-bg-secondary rounded text-mc-text-secondary">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <h1 className="text-lg font-bold text-mc-text min-w-[160px] text-center">
              {format(currentMonth, 'MMMM yyyy')}
            </h1>
            <button onClick={() => setCurrentMonth(m => addMonths(m, 1))} className="p-2 hover:bg-mc-bg-secondary rounded text-mc-text-secondary">
              <ChevronRight className="w-4 h-4" />
            </button>
            <button onClick={() => setCurrentMonth(new Date())} className="px-3 py-1 text-xs border border-mc-border rounded hover:bg-mc-bg-secondary text-mc-text-secondary">
              Today
            </button>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90"
          >
            <Plus className="w-4 h-4" />
            Add Task
          </button>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 shrink-0">
          {Object.entries(STATUS_COLORS).slice(0, 6).map(([status, color]) => (
            <div key={status} className="flex items-center gap-1.5">
              <div className={`w-2.5 h-2.5 rounded-full ${color}`} />
              <span className="text-xs text-mc-text-secondary capitalize">{status.replace('_', ' ')}</span>
            </div>
          ))}
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-mc-text-secondary" />
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            {/* Day headers */}
            <div className="grid grid-cols-7 mb-1">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
                <div key={d} className="text-center text-xs font-medium text-mc-text-secondary py-1">
                  {d}
                </div>
              ))}
            </div>
            {/* Calendar grid */}
            <div className="grid grid-cols-7 gap-px bg-mc-border rounded-lg overflow-hidden">
              {calendarDays.map(day => {
                const dayEvents = eventsForDay(day);
                const isSelected = selectedDay && isSameDay(day, selectedDay);
                return (
                  <div
                    key={day.toISOString()}
                    onClick={() => setSelectedDay(isSameDay(day, selectedDay || new Date(0)) ? null : day)}
                    className={`bg-mc-bg min-h-[80px] p-1.5 cursor-pointer hover:bg-mc-bg-secondary/50 transition-colors ${
                      !isSameMonth(day, currentMonth) ? 'opacity-40' : ''
                    } ${isSelected ? 'ring-1 ring-mc-accent ring-inset' : ''}`}
                  >
                    <div className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full ${
                      isToday(day) ? 'bg-mc-accent text-mc-bg' : 'text-mc-text-secondary'
                    }`}>
                      {format(day, 'd')}
                    </div>
                    <div className="space-y-0.5">
                      {dayEvents.slice(0, 3).map(event => (
                        <div key={event.id} className={`text-xs px-1 py-0.5 rounded truncate text-white ${event.color}`}>
                          {event.title}
                        </div>
                      ))}
                      {dayEvents.length > 3 && (
                        <div className="text-xs text-mc-text-secondary px-1">+{dayEvents.length - 3} more</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Selected day panel */}
        {selectedDay && (
          <div className="shrink-0 bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium text-sm">{format(selectedDay, 'EEEE, MMMM d')}</h3>
              <button onClick={() => setSelectedDay(null)} className="text-mc-text-secondary hover:text-mc-text">
                <X className="w-4 h-4" />
              </button>
            </div>
            {selectedDayEvents.length === 0 ? (
              <p className="text-xs text-mc-text-secondary">No events on this day.</p>
            ) : (
              <div className="space-y-2">
                {selectedDayEvents.map(event => (
                  <div key={event.id} className="flex items-center gap-3 text-sm">
                    {event.type === 'task' ? (
                      <CheckSquare className="w-4 h-4 text-mc-accent shrink-0" />
                    ) : (
                      <Clock className="w-4 h-4 text-orange-400 shrink-0" />
                    )}
                    <span className="text-mc-text">{event.title}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full text-white ${event.color}`}>
                      {event.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => setShowCreateModal(true)}
              className="mt-3 text-xs text-mc-accent hover:text-mc-accent/80 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" />
              Add task on this day
            </button>
          </div>
        )}
      </div>

      {/* Create Task Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-mc-bg-secondary border border-mc-border rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold">Add Task</h2>
              <button onClick={() => setShowCreateModal(false)}><X className="w-5 h-5 text-mc-text-secondary" /></button>
            </div>
            <input
              value={newTask.title}
              onChange={e => setNewTask(t => ({ ...t, title: e.target.value }))}
              placeholder="Task title *"
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              autoFocus
            />
            <textarea
              value={newTask.description}
              onChange={e => setNewTask(t => ({ ...t, description: e.target.value }))}
              placeholder="Description"
              rows={2}
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent resize-none"
            />
            <div>
              <label className="text-xs text-mc-text-secondary mb-1 block">Due Date</label>
              <input
                type="date"
                value={newTask.due_date || (selectedDay ? format(selectedDay, 'yyyy-MM-dd') : '')}
                onChange={e => setNewTask(t => ({ ...t, due_date: e.target.value }))}
                className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowCreateModal(false)} className="flex-1 py-2 border border-mc-border rounded text-sm text-mc-text-secondary hover:bg-mc-bg-tertiary">Cancel</button>
              <button
                onClick={handleCreateTask}
                disabled={!newTask.title.trim() || saving}
                className="flex-1 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
