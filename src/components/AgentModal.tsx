'use client';

import { useState, useEffect } from 'react';
import { X, Save, Trash2, RefreshCw, FolderOpen, AlertCircle } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Agent, AgentStatus } from '@/lib/types';

interface AgentModalProps {
  agent?: Agent;
  onClose: () => void;
  workspaceId?: string;
  onAgentCreated?: (agentId: string) => void;
}

interface AgentProfile {
  gateway_agent_id: string;
  agent_dir: string;
  dir_exists: boolean;
  soul_md: string | null;
  soul_exists: boolean;
  user_md: string | null;
  user_exists: boolean;
  agents_md: string | null;
  agents_exists: boolean;
  identity_md: string | null;
  identity_exists: boolean;
  error?: string;
}

const EMOJI_OPTIONS = ['🤖', '🦞', '💻', '🔍', '✍️', '🎨', '📊', '🧠', '⚡', '🚀', '🎯', '🔧', '🦾', '🛠️', '🔬', '📣', '⚙️', '📊'];

export function AgentModal({ agent, onClose, workspaceId, onAgentCreated }: AgentModalProps) {
  const { addAgent, updateAgent } = useMissionControl();
  const [activeTab, setActiveTab] = useState<'info' | 'soul' | 'user' | 'agents'>('info');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>('');
  const [modelsLoading, setModelsLoading] = useState(true);

  // Live profile state — loaded fresh from filesystem each time modal opens
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: agent?.name || '',
    role: agent?.role || '',
    description: agent?.description || '',
    avatar_emoji: agent?.avatar_emoji || '🤖',
    status: (agent?.status || 'standby') as AgentStatus,
    is_master: agent?.is_master || false,
    model: agent?.model || '',
  });

  // Load available models
  useEffect(() => {
    const loadModels = async () => {
      try {
        const res = await fetch('/api/openclaw/models');
        if (res.ok) {
          const data = await res.json();
          setAvailableModels(data.availableModels || []);
          setDefaultModel(data.defaultModel || '');
          if (!agent?.model && data.defaultModel) {
            setForm(prev => ({ ...prev, model: data.defaultModel }));
          }
        }
      } catch (error) {
        console.error('Failed to load models:', error);
      } finally {
        setModelsLoading(false);
      }
    };
    loadModels();
  }, [agent]);

  // Load live profile from filesystem whenever modal opens for an existing agent
  const loadProfile = async () => {
    if (!agent) return;
    setProfileLoading(true);
    setProfileError(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/profile`);
      if (res.ok) {
        setProfile(await res.json());
      } else {
        setProfileError('Failed to load profile files');
      }
    } catch (e) {
      setProfileError('Could not reach profile endpoint');
    } finally {
      setProfileLoading(false);
    }
  };

  useEffect(() => {
    if (agent) loadProfile();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const url = agent ? `/api/agents/${agent.id}` : '/api/agents';
      const method = agent ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          // Never send md fields to DB — they live on the filesystem only
          soul_md: null,
          user_md: null,
          agents_md: null,
          workspace_id: workspaceId || agent?.workspace_id || 'default',
        }),
      });
      if (res.ok) {
        const savedAgent = await res.json();
        if (agent) {
          updateAgent(savedAgent);
        } else {
          addAgent(savedAgent);
          if (onAgentCreated) onAgentCreated(savedAgent.id);
        }
        onClose();
      }
    } catch (error) {
      console.error('Failed to save agent:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!agent || !confirm(`Delete ${agent.name}?`)) return;
    try {
      const res = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
      if (res.ok) {
        useMissionControl.setState((state) => ({
          agents: state.agents.filter((a) => a.id !== agent.id),
          selectedAgent: state.selectedAgent?.id === agent.id ? null : state.selectedAgent,
        }));
        onClose();
      }
    } catch (error) {
      console.error('Failed to delete agent:', error);
    }
  };

  const tabs = [
    { id: 'info',   label: 'Info' },
    { id: 'soul',   label: 'SOUL.md' },
    { id: 'user',   label: 'USER.md' },
    { id: 'agents', label: 'AGENTS.md' },
  ] as const;

  // Renders a live read-only file tab with refresh button
  const FileTab = ({
    content,
    exists,
    filename,
  }: {
    content: string | null;
    exists: boolean;
    filename: string;
  }) => {
    if (profileLoading) {
      return (
        <div className="flex items-center justify-center py-16 text-mc-text-secondary gap-2">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span className="text-sm">Reading from filesystem...</span>
        </div>
      );
    }
    if (profileError) {
      return (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="w-8 h-8 text-mc-accent-red/60" />
          <p className="text-sm text-mc-text-secondary">{profileError}</p>
          <button onClick={loadProfile} className="text-xs text-mc-accent hover:underline">Retry</button>
        </div>
      );
    }
    if (!exists || content === null) {
      return (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-mc-text-secondary">
          <FolderOpen className="w-8 h-8 opacity-40" />
          <p className="text-sm">No {filename} found for this agent</p>
          {profile && (
            <p className="text-xs opacity-60 font-mono text-center px-4">{profile.agent_dir}/{filename}</p>
          )}
        </div>
      );
    }
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-xs text-mc-text-secondary font-mono">
            <FolderOpen className="w-3.5 h-3.5" />
            {profile?.agent_dir}/{filename}
          </div>
          <button
            onClick={loadProfile}
            className="flex items-center gap-1 text-xs text-mc-accent hover:text-mc-accent/80"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        </div>
        <pre className="w-full bg-mc-bg border border-mc-border rounded px-3 py-3 text-xs font-mono text-mc-text-secondary overflow-auto max-h-[52vh] whitespace-pre-wrap">
          {content}
        </pre>
        <p className="text-xs text-mc-text-secondary/50 mt-2">
          Read-only — edit this file directly in your OpenClaw workspace to make changes.
        </p>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-3 sm:p-4">
      <div className="bg-mc-bg-secondary border border-mc-border rounded-t-xl sm:rounded-lg w-full max-w-2xl max-h-[92vh] sm:max-h-[90vh] flex flex-col pb-[env(safe-area-inset-bottom)] sm:pb-0">

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-mc-border">
          <h2 className="text-lg font-semibold">
            {agent ? `${agent.avatar_emoji} ${agent.name}` : 'Create New Agent'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-mc-bg-tertiary rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-mc-border overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 min-h-11 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-mc-accent text-mc-accent'
                  : 'border-transparent text-mc-text-secondary hover:text-mc-text'
              }`}
            >
              {tab.label}
              {/* Show dot indicator if file exists */}
              {tab.id !== 'info' && profile && (() => {
                const key = `${tab.id === 'soul' ? 'soul' : tab.id === 'user' ? 'user' : 'agents'}_exists` as keyof AgentProfile;
                return profile[key]
                  ? <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-mc-accent-green inline-block" />
                  : <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-mc-border inline-block" />;
              })()}
            </button>
          ))}
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4">
          {activeTab === 'info' && (
            <div className="space-y-4">
              {/* Avatar */}
              <div>
                <label className="block text-sm font-medium mb-2">Avatar</label>
                <div className="flex flex-wrap gap-2">
                  {EMOJI_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setForm({ ...form, avatar_emoji: emoji })}
                      className={`text-2xl p-2 rounded hover:bg-mc-bg-tertiary ${
                        form.avatar_emoji === emoji ? 'bg-mc-accent/20 ring-2 ring-mc-accent' : ''
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Name */}
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                />
              </div>

              {/* Role */}
              <div>
                <label className="block text-sm font-medium mb-1">Role</label>
                <input
                  type="text"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  required
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                  className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent resize-none"
                />
              </div>

              {/* Status */}
              <div>
                <label className="block text-sm font-medium mb-1">Status</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as AgentStatus })}
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                >
                  <option value="standby">Standby</option>
                  <option value="working">Working</option>
                  <option value="offline">Offline</option>
                </select>
              </div>

              {/* Master */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_master"
                  checked={form.is_master}
                  onChange={(e) => setForm({ ...form, is_master: e.target.checked })}
                  className="w-4 h-4"
                />
                <label htmlFor="is_master" className="text-sm">Master Orchestrator</label>
              </div>

              {/* Model */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  Model
                  {defaultModel && form.model === defaultModel && (
                    <span className="ml-2 text-xs text-mc-text-secondary">(Default)</span>
                  )}
                </label>
                {modelsLoading ? (
                  <div className="text-sm text-mc-text-secondary">Loading models...</div>
                ) : (
                  <select
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                  >
                    <option value="">-- Use Default --</option>
                    {availableModels.map((m) => (
                      <option key={m} value={m}>{m}{defaultModel === m ? ' (Default)' : ''}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Gateway link */}
              {agent?.gateway_agent_id && (
                <div className="text-xs text-mc-text-secondary bg-mc-bg-tertiary rounded px-3 py-2 font-mono">
                  Gateway ID: {agent.gateway_agent_id}
                </div>
              )}
            </div>
          )}

          {activeTab === 'soul' && (
            <FileTab content={profile?.soul_md ?? null} exists={profile?.soul_exists ?? false} filename="SOUL.md" />
          )}
          {activeTab === 'user' && (
            <FileTab content={profile?.user_md ?? null} exists={profile?.user_exists ?? false} filename="USER.md" />
          )}
          {activeTab === 'agents' && (
            <FileTab content={profile?.agents_md ?? null} exists={profile?.agents_exists ?? false} filename="AGENTS.md" />
          )}
        </form>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-mc-border">
          <div>
            {agent && (
              <button
                type="button"
                onClick={handleDelete}
                className="min-h-11 flex items-center gap-2 px-3 py-2 text-mc-accent-red hover:bg-mc-accent-red/10 rounded text-sm"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="min-h-11 px-4 py-2 text-sm text-mc-text-secondary hover:text-mc-text">
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="min-h-11 flex items-center gap-2 px-4 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {isSubmitting ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
