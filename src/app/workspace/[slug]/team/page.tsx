'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Loader2, Edit2, Save, X, Plus, ChevronRight } from 'lucide-react';
import { Header } from '@/components/Header';
import type { Agent } from '@/lib/types';

const ROSTER: Array<{
  name: string;
  avatar_emoji: string;
  role: string;
  description: string;
  model: string;
}> = [
  { name: 'Coder', avatar_emoji: '🛠️', role: 'Technical Builder', description: 'Technical builds, architecture, code review, debugging, infrastructure', model: 'anthropic/claude-opus-4-6' },
  { name: 'Researcher', avatar_emoji: '🔬', role: 'Research Analyst', description: 'Market intel, due diligence, fact-finding, competitive analysis, deep dives', model: 'anthropic/claude-sonnet-4-6' },
  { name: 'Marketer', avatar_emoji: '📣', role: 'Content & Brand', description: 'Content creation, brand strategy, social media, community, campaigns', model: 'anthropic/claude-sonnet-4-6' },
  { name: 'Ops', avatar_emoji: '⚙️', role: 'Operations Manager', description: 'Execution tracking, scheduling, admin, follow-ups, process management', model: 'anthropic/claude-haiku-4-5' },
  { name: 'Analyst', avatar_emoji: '📊', role: 'Financial Analyst', description: 'Financial analysis, portfolio review, numbers, reporting, investment thesis', model: 'anthropic/claude-sonnet-4-6' },
];

interface AgentWithDetails extends Agent {
  currentTask?: string;
}

interface CreateTaskModal {
  agentId: string;
  agentName: string;
}

export default function TeamPage() {
  const params = useParams();
  const slug = params?.slug as string;
  const workspaceId = 'default';

  const [agents, setAgents] = useState<AgentWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<AgentWithDetails | null>(null);
  const [editingModel, setEditingModel] = useState('');
  const [savingModel, setSavingModel] = useState(false);
  const [createTaskModal, setCreateTaskModal] = useState<CreateTaskModal | null>(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [savingTask, setSavingTask] = useState(false);

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents?workspace_id=${workspaceId}`);
      if (!res.ok) return;
      const data: Agent[] = await res.json();

      // Ensure sub-agents exist
      for (const member of ROSTER) {
        const exists = data.find(a => a.name === member.name);
        if (!exists) {
          await fetch('/api/agents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...member,
              workspace_id: workspaceId,
              status: 'standby',
              is_master: false,
            }),
          });
        }
      }

      // Reload after potential inserts
      const res2 = await fetch(`/api/agents?workspace_id=${workspaceId}`);
      const refreshed: Agent[] = await res2.json();

      // Fetch active tasks to show on desks
      const tasksRes = await fetch(`/api/tasks?workspace_id=${workspaceId}`);
      const tasks = tasksRes.ok ? await tasksRes.json() : [];
      const inProgressTasks = tasks.filter((t: { status: string }) => t.status === 'in_progress');

      const enriched: AgentWithDetails[] = refreshed.map((a: Agent) => ({
        ...a,
        currentTask: inProgressTasks.find((t: { assigned_agent_id: string; title: string }) => t.assigned_agent_id === a.id)?.title,
      }));

      setAgents(enriched);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  const masterAgent = agents.find(a => a.is_master);
  const subAgents = agents.filter(a => !a.is_master);

  const handleSaveModel = async () => {
    if (!selectedAgent) return;
    setSavingModel(true);
    try {
      const res = await fetch(`/api/agents/${selectedAgent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: editingModel }),
      });
      if (res.ok) {
        const updated = await res.json();
        setAgents(prev => prev.map(a => a.id === updated.id ? { ...a, model: updated.model } : a));
        setSelectedAgent(a => a ? { ...a, model: updated.model } : null);
      }
    } finally {
      setSavingModel(false);
    }
  };

  const handleCreateTask = async () => {
    if (!createTaskModal || !taskTitle.trim()) return;
    setSavingTask(true);
    try {
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: taskTitle,
          assigned_agent_id: createTaskModal.agentId,
          workspace_id: workspaceId,
        }),
      });
      setCreateTaskModal(null);
      setTaskTitle('');
    } finally {
      setSavingTask(false);
    }
  };

  const StatusDot = ({ status }: { status: Agent['status'] }) => (
    <span className={`inline-block w-2 h-2 rounded-full ${
      status === 'working' ? 'bg-mc-accent-green animate-pulse' :
      status === 'standby' ? 'bg-mc-text-secondary' : 'bg-mc-accent-red'
    }`} />
  );

  const AgentCard = ({ agent }: { agent: AgentWithDetails }) => (
    <div
      onClick={() => { setSelectedAgent(agent); setEditingModel(agent.model || ''); }}
      className="bg-mc-bg-secondary border border-mc-border rounded-xl p-4 cursor-pointer hover:border-mc-accent/50 transition-all hover:shadow-lg group"
    >
      <div className="flex items-start justify-between mb-3">
        <span className="text-3xl">{agent.avatar_emoji}</span>
        <div className="flex items-center gap-1.5">
          <StatusDot status={agent.status} />
          <span className="text-xs text-mc-text-secondary capitalize">{agent.status}</span>
        </div>
      </div>
      <h3 className="font-bold text-mc-text mb-0.5">{agent.name}</h3>
      <p className="text-xs text-mc-accent mb-2">{agent.role}</p>
      {agent.model && (
        <p className="text-xs text-mc-text-secondary/70 mb-2 font-mono truncate">{agent.model.split('/').pop()}</p>
      )}
      <p className="text-xs text-mc-text-secondary line-clamp-2">{agent.description}</p>
      <div className="mt-3 pt-2 border-t border-mc-border flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="text-xs text-mc-text-secondary">Click to configure</span>
        <ChevronRight className="w-3.5 h-3.5 text-mc-text-secondary" />
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-mc-bg overflow-hidden">
      <Header workspace={{ id: workspaceId, name: slug, slug, icon: '👥', created_at: '', updated_at: '' }} />

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-6 h-6 animate-spin text-mc-text-secondary" />
          </div>
        ) : (
          <div className="max-w-5xl mx-auto space-y-8">
            {/* Michael — top */}
            <div className="flex flex-col items-center">
              <div className="bg-mc-bg-secondary border-2 border-mc-accent rounded-xl px-8 py-5 text-center inline-block">
                <div className="text-4xl mb-2">👤</div>
                <div className="font-bold text-mc-text text-lg">Michael Hazilias</div>
                <div className="text-xs text-mc-accent mt-1">CEO / Human</div>
                <div className="mt-2 flex items-center justify-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-mc-accent-green animate-pulse" />
                  <span className="text-xs text-mc-text-secondary">Available</span>
                </div>
              </div>
              {/* Connector */}
              <div className="w-px h-8 bg-mc-border" />
            </div>

            {/* Switch — master agent */}
            {masterAgent && (
              <div className="flex flex-col items-center">
                <div
                  onClick={() => { setSelectedAgent(masterAgent); setEditingModel(masterAgent.model || ''); }}
                  className="bg-mc-bg-secondary border-2 border-mc-accent-purple rounded-xl px-8 py-5 text-center cursor-pointer hover:border-mc-accent-purple/80 transition-all inline-block"
                >
                  <div className="text-4xl mb-2">{masterAgent.avatar_emoji}</div>
                  <div className="font-bold text-mc-text text-lg">{masterAgent.name}</div>
                  <div className="text-xs text-mc-accent-purple mt-1">Strategist / Chief of Staff</div>
                  <div className="mt-2 flex items-center justify-center gap-1.5">
                    <StatusDot status={masterAgent.status} />
                    <span className="text-xs text-mc-text-secondary capitalize">{masterAgent.status}</span>
                  </div>
                </div>
                <div className="w-px h-8 bg-mc-border" />
              </div>
            )}

            {/* Sub-agents grid */}
            {subAgents.length > 0 && (
              <div>
                <h2 className="text-xs font-semibold text-mc-text-secondary uppercase tracking-widest mb-4 text-center">Sub-Agents</h2>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                  {subAgents.map(agent => <AgentCard key={agent.id} agent={agent} />)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Agent detail modal */}
      {selectedAgent && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-mc-bg-secondary border border-mc-border rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-3xl">{selectedAgent.avatar_emoji}</span>
                <div>
                  <h2 className="font-bold text-mc-text">{selectedAgent.name}</h2>
                  <p className="text-xs text-mc-accent">{selectedAgent.role}</p>
                </div>
              </div>
              <button onClick={() => setSelectedAgent(null)}>
                <X className="w-5 h-5 text-mc-text-secondary" />
              </button>
            </div>

            <p className="text-sm text-mc-text-secondary">{selectedAgent.description}</p>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-mc-text-secondary">Model Override</label>
                <button
                  onClick={handleSaveModel}
                  disabled={savingModel || editingModel === selectedAgent.model}
                  className="flex items-center gap-1 text-xs text-mc-accent disabled:opacity-40 hover:text-mc-accent/80"
                >
                  <Save className="w-3 h-3" />
                  {savingModel ? 'Saving...' : 'Save'}
                </button>
              </div>
              <input
                value={editingModel}
                onChange={e => setEditingModel(e.target.value)}
                placeholder="e.g. anthropic/claude-sonnet-4-6"
                className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-xs font-mono focus:outline-none focus:border-mc-accent"
              />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${
                  selectedAgent.status === 'working' ? 'bg-mc-accent-green animate-pulse' :
                  selectedAgent.status === 'standby' ? 'bg-mc-text-secondary' : 'bg-mc-accent-red'
                }`} />
                <span className="text-xs capitalize text-mc-text-secondary">{selectedAgent.status}</span>
              </div>
              <button
                onClick={() => { setCreateTaskModal({ agentId: selectedAgent.id, agentName: selectedAgent.name }); setSelectedAgent(null); }}
                className="flex items-center gap-1.5 px-3 py-2 bg-mc-accent text-mc-bg rounded text-xs font-medium hover:bg-mc-accent/90 ml-auto"
              >
                <Plus className="w-3.5 h-3.5" />
                Assign Task
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create task modal */}
      {createTaskModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-mc-bg-secondary border border-mc-border rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold">Assign Task to {createTaskModal.agentName}</h2>
              <button onClick={() => setCreateTaskModal(null)}><X className="w-5 h-5 text-mc-text-secondary" /></button>
            </div>
            <input
              value={taskTitle}
              onChange={e => setTaskTitle(e.target.value)}
              placeholder="Task title *"
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handleCreateTask()}
            />
            <div className="flex gap-3">
              <button onClick={() => setCreateTaskModal(null)} className="flex-1 py-2 border border-mc-border rounded text-sm text-mc-text-secondary hover:bg-mc-bg-tertiary">Cancel</button>
              <button
                onClick={handleCreateTask}
                disabled={!taskTitle.trim() || savingTask}
                className="flex-1 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium disabled:opacity-50"
              >
                {savingTask ? 'Creating...' : 'Create & Assign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
