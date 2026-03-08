'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Loader2, X, Plus, RefreshCw, Zap } from 'lucide-react';
import { Header } from '@/components/Header';
import type { Agent, Task } from '@/lib/types';

interface DeskAgent extends Agent {
  currentTask?: string;
  currentTaskId?: string;
}

interface PingModal {
  agentId: string;
  agentName: string;
  agentEmoji: string;
}

export default function OfficePage() {
  const params = useParams();
  const slug = params?.slug as string;
  const workspaceId = 'default';

  const [agents, setAgents] = useState<DeskAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [pingModal, setPingModal] = useState<PingModal | null>(null);
  const [pingTitle, setPingTitle] = useState('');
  const [savingPing, setSavingPing] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<DeskAgent | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [agentsRes, tasksRes] = await Promise.all([
        fetch(`/api/agents?workspace_id=${workspaceId}`),
        fetch(`/api/tasks?workspace_id=${workspaceId}`),
      ]);

      const agentsData: Agent[] = agentsRes.ok ? await agentsRes.json() : [];
      const tasksData: Task[] = tasksRes.ok ? await tasksRes.json() : [];

      const activeTasks = tasksData.filter(t => t.status === 'in_progress');

      const enriched: DeskAgent[] = agentsData.map(agent => {
        const active = activeTasks.find(t => t.assigned_agent_id === agent.id);
        return {
          ...agent,
          currentTask: active?.title,
          currentTaskId: active?.id,
        };
      });

      setAgents(enriched);
      setLastRefresh(new Date());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handlePing = async () => {
    if (!pingModal || !pingTitle.trim()) return;
    setSavingPing(true);
    try {
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: pingTitle,
          assigned_agent_id: pingModal.agentId,
          workspace_id: workspaceId,
          status: 'assigned',
        }),
      });
      await loadData();
      setPingModal(null);
      setPingTitle('');
    } finally {
      setSavingPing(false);
    }
  };

  const StatusIndicator = ({ agent }: { agent: DeskAgent }) => {
    if (agent.status === 'working') {
      return (
        <div className="flex items-center gap-1.5">
          <div className="relative w-3 h-3">
            <div className="absolute inset-0 rounded-full bg-mc-accent-green animate-ping opacity-75" />
            <div className="relative rounded-full bg-mc-accent-green w-3 h-3" />
          </div>
          <span className="text-xs font-medium text-mc-accent-green">At Desk</span>
        </div>
      );
    }
    if (agent.status === 'offline') {
      return (
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-mc-accent-red" />
          <span className="text-xs text-mc-accent-red">Offline</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-mc-text-secondary/50" />
        <span className="text-xs text-mc-text-secondary">Idle</span>
      </div>
    );
  };

  const Desk = ({ agent }: { agent: DeskAgent }) => (
    <div
      className={`bg-mc-bg-secondary border rounded-xl p-5 flex flex-col gap-3 cursor-pointer hover:border-mc-accent/50 transition-all ${
        agent.status === 'working'
          ? 'border-mc-accent-green/40 shadow-md shadow-mc-accent-green/5'
          : 'border-mc-border'
      }`}
      onClick={() => setSelectedAgent(agent)}
    >
      {/* Avatar */}
      <div className={`text-5xl text-center transition-transform ${agent.status === 'working' ? 'animate-bounce' : ''}`} style={{ animationDuration: '2s' }}>
        {agent.avatar_emoji}
      </div>

      {/* Name & role */}
      <div className="text-center">
        <p className="font-bold text-mc-text text-sm">{agent.name}</p>
        <p className="text-xs text-mc-text-secondary truncate">{agent.role}</p>
      </div>

      {/* Status */}
      <div className="flex justify-center">
        <StatusIndicator agent={agent} />
      </div>

      {/* Current task */}
      {agent.currentTask && (
        <div className="bg-mc-bg-tertiary rounded p-2 text-xs text-mc-accent border border-mc-accent/20 line-clamp-2 text-center">
          {agent.currentTask}
        </div>
      )}

      {/* Ping button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setPingModal({ agentId: agent.id, agentName: agent.name, agentEmoji: agent.avatar_emoji });
        }}
        className="flex items-center justify-center gap-1.5 py-1.5 border border-mc-border rounded text-xs text-mc-text-secondary hover:border-mc-accent hover:text-mc-accent transition-colors"
      >
        <Zap className="w-3 h-3" />
        Ping Agent
      </button>
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-mc-bg overflow-hidden">
      <Header workspace={{ id: workspaceId, name: slug, slug, icon: '🏢', created_at: '', updated_at: '' }} />

      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-bold text-mc-text">The Office</h1>
            <p className="text-xs text-mc-text-secondary">
              {agents.filter(a => a.status === 'working').length} agents active ·{' '}
              Last updated {lastRefresh.toLocaleTimeString()}
            </p>
          </div>
          <button
            onClick={loadData}
            className="flex items-center gap-2 px-3 py-2 border border-mc-border rounded text-xs text-mc-text-secondary hover:bg-mc-bg-secondary"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-6 h-6 animate-spin text-mc-text-secondary" />
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {/* Michael's desk — always first */}
            <div className="bg-mc-bg-secondary border-2 border-mc-accent rounded-xl p-5 flex flex-col gap-3">
              <div className="text-5xl text-center">👤</div>
              <div className="text-center">
                <p className="font-bold text-mc-text text-sm">Michael</p>
                <p className="text-xs text-mc-text-secondary">CEO / Human</p>
              </div>
              <div className="flex justify-center">
                <div className="flex items-center gap-1.5">
                  <div className="relative w-3 h-3">
                    <div className="absolute inset-0 rounded-full bg-mc-accent animate-ping opacity-75" />
                    <div className="relative rounded-full bg-mc-accent w-3 h-3" />
                  </div>
                  <span className="text-xs font-medium text-mc-accent">Available</span>
                </div>
              </div>
            </div>

            {/* Agent desks */}
            {agents.map(agent => <Desk key={agent.id} agent={agent} />)}
          </div>
        )}
      </div>

      {/* Agent detail modal */}
      {selectedAgent && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-mc-bg-secondary border border-mc-border rounded-xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-3xl">{selectedAgent.avatar_emoji}</span>
                <div>
                  <h2 className="font-bold">{selectedAgent.name}</h2>
                  <p className="text-xs text-mc-accent">{selectedAgent.role}</p>
                </div>
              </div>
              <button onClick={() => setSelectedAgent(null)}><X className="w-5 h-5 text-mc-text-secondary" /></button>
            </div>

            <StatusIndicator agent={selectedAgent} />

            {selectedAgent.description && (
              <p className="text-sm text-mc-text-secondary">{selectedAgent.description}</p>
            )}

            {selectedAgent.currentTask && (
              <div className="bg-mc-bg-tertiary rounded p-3 border border-mc-accent/20">
                <p className="text-xs text-mc-text-secondary mb-1">Current task</p>
                <p className="text-sm text-mc-accent">{selectedAgent.currentTask}</p>
              </div>
            )}

            {selectedAgent.model && (
              <p className="text-xs text-mc-text-secondary font-mono">Model: {selectedAgent.model}</p>
            )}

            <button
              onClick={() => {
                setPingModal({ agentId: selectedAgent.id, agentName: selectedAgent.name, agentEmoji: selectedAgent.avatar_emoji });
                setSelectedAgent(null);
              }}
              className="w-full flex items-center justify-center gap-2 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90"
            >
              <Plus className="w-4 h-4" />
              Assign Task
            </button>
          </div>
        </div>
      )}

      {/* Ping modal */}
      {pingModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-mc-bg-secondary border border-mc-border rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold flex items-center gap-2">
                <span>{pingModal.agentEmoji}</span>
                Ping {pingModal.agentName}
              </h2>
              <button onClick={() => setPingModal(null)}><X className="w-5 h-5 text-mc-text-secondary" /></button>
            </div>
            <input
              value={pingTitle}
              onChange={e => setPingTitle(e.target.value)}
              placeholder="Task for this agent..."
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handlePing()}
            />
            <div className="flex gap-3">
              <button onClick={() => setPingModal(null)} className="flex-1 py-2 border border-mc-border rounded text-sm text-mc-text-secondary hover:bg-mc-bg-tertiary">Cancel</button>
              <button
                onClick={handlePing}
                disabled={!pingTitle.trim() || savingPing}
                className="flex-1 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium disabled:opacity-50"
              >
                {savingPing ? 'Sending...' : 'Send Task'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
