'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import {
  Plus, X, Loader2, Wand2, Youtube, Instagram, Linkedin, Globe, Trash2, ChevronRight
} from 'lucide-react';
import { Header } from '@/components/Header';

const STAGES = [
  { id: 'idea', label: '💡 Idea', color: 'text-mc-accent-yellow border-mc-accent-yellow/30' },
  { id: 'script', label: '📝 Script', color: 'text-mc-accent border-mc-accent/30' },
  { id: 'thumbnail', label: '🖼️ Thumbnail', color: 'text-mc-accent-purple border-mc-accent-purple/30' },
  { id: 'filming', label: '🎬 Filming', color: 'text-mc-accent-cyan border-mc-accent-cyan/30' },
  { id: 'published', label: '✅ Published', color: 'text-mc-accent-green border-mc-accent-green/30' },
];

const PLATFORMS = [
  { id: 'youtube', label: 'YouTube', icon: Youtube },
  { id: 'instagram', label: 'Instagram', icon: Instagram },
  { id: 'linkedin', label: 'LinkedIn', icon: Linkedin },
  { id: 'other', label: 'Other', icon: Globe },
];

interface ContentItem {
  id: string;
  title: string;
  description?: string;
  platform: string;
  stage: string;
  script?: string;
  thumbnail_url?: string;
  notes?: string;
  workspace_id: string;
  created_at: string;
  updated_at: string;
}

export default function ContentPage() {
  const params = useParams();
  const slug = params?.slug as string;
  const [workspaceId, setWorkspaceId] = useState<string>('default');

  // Resolve workspace_id from URL slug
  useEffect(() => {
    async function resolveWorkspace() {
      try {
        const res = await fetch(`/api/workspaces/${slug}`);
        if (res.ok) {
          const workspace = await res.json();
          setWorkspaceId(workspace.id);
        }
      } catch (e) {
        console.error('Failed to resolve workspace from slug:', e);
      }
    }
    if (slug) resolveWorkspace();
  }, [slug]);

  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editItem, setEditItem] = useState<ContentItem | null>(null);
  const [generatingScript, setGeneratingScript] = useState(false);

  // Create form state
  const [form, setForm] = useState({
    title: '', description: '', platform: 'youtube', notes: '', stage: 'idea'
  });

  const loadItems = useCallback(async () => {
    try {
      const res = await fetch(`/api/content?workspace_id=${workspaceId}`);
      if (res.ok) setItems(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { loadItems(); }, [loadItems]);

  const itemsByStage = (stage: string) => items.filter(i => i.stage === stage);

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    const { draggableId, destination } = result;
    const newStage = destination.droppableId;

    setItems(prev => prev.map(i => i.id === draggableId ? { ...i, stage: newStage } : i));

    await fetch(`/api/content/${draggableId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: newStage }),
    });
  };

  const handleCreate = async () => {
    if (!form.title.trim()) return;
    const res = await fetch('/api/content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, workspace_id: workspaceId }),
    });
    if (res.ok) {
      const item = await res.json();
      setItems(prev => [item, ...prev]);
      setForm({ title: '', description: '', platform: 'youtube', notes: '', stage: 'idea' });
      setShowCreateModal(false);
    }
  };

  const handleUpdate = async (id: string, updates: Partial<ContentItem>) => {
    const res = await fetch(`/api/content/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      const updated = await res.json();
      setItems(prev => prev.map(i => i.id === id ? updated : i));
      if (editItem?.id === id) setEditItem(updated);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/content/${id}`, { method: 'DELETE' });
    setItems(prev => prev.filter(i => i.id !== id));
    if (editItem?.id === id) setEditItem(null);
  };

  const handleGenerateScript = async () => {
    if (!editItem) return;
    setGeneratingScript(true);
    try {
      const res = await fetch('/api/content/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editItem.title,
          description: editItem.description,
          platform: editItem.platform,
          notes: editItem.notes,
          content_id: editItem.id,
          workspace_id: workspaceId,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        // Task dispatched to agent — UI shows generating state via SSE
        if (data.status === 'generating') {
          setEditItem(prev => prev ? { ...prev, generation_status: 'generating' } : null);
          setItems(prev => prev.map(i => i.id === editItem.id ? { ...i, generation_status: 'generating' } : i));
        }
      } else {
        setGeneratingScript(false);
      }
    } catch (e) {
      console.error(e);
      setGeneratingScript(false);
    }
  };

  // Listen for SSE content updates (script generation completion)
  useEffect(() => {
    const eventSource = new EventSource('/api/events/stream');
    eventSource.onmessage = (event) => {
      try {
        if (event.data.startsWith(':')) return;
        const sseEvent = JSON.parse(event.data);
        if (sseEvent.type === 'content_updated' && sseEvent.payload?.id) {
          const updated = sseEvent.payload;
          setItems(prev => prev.map(i => i.id === updated.id ? { ...updated, ...i, ...updated } : i));
          if (editItem?.id === updated.id) {
            setEditItem(prev => prev ? { ...prev, ...updated } : null);
            if (updated.generation_status === 'completed' || updated.script) {
              setGeneratingScript(false);
            }
          }
        }
      } catch { /* ignore parse errors */ }
    };
    return () => eventSource.close();
  }, [editItem?.id]);

  const PlatformIcon = ({ platform }: { platform: string }) => {
    const p = PLATFORMS.find(p => p.id === platform);
    const Icon = p?.icon || Globe;
    return <Icon className="w-3 h-3" />;
  };

  return (
    <div className="h-full flex flex-col bg-mc-bg overflow-hidden">
      <Header workspace={{ id: workspaceId, name: slug, slug, icon: '🎬', created_at: '', updated_at: '' }} />
      
      <div className="flex-1 overflow-hidden flex flex-col p-4 gap-4">
        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-lg font-bold text-mc-text">Content Pipeline</h1>
            <p className="text-xs text-mc-text-secondary">{items.length} items across {STAGES.length} stages</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90"
          >
            <Plus className="w-4 h-4" />
            New Idea
          </button>
        </div>

        {/* Kanban Board */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-mc-text-secondary" />
          </div>
        ) : (
          <DragDropContext onDragEnd={handleDragEnd}>
            <div className="flex-1 flex gap-4 overflow-x-auto pb-2">
              {STAGES.map(stage => (
                <div key={stage.id} className="flex-shrink-0 w-64 flex flex-col">
                  <div className={`flex items-center justify-between mb-3 pb-2 border-b ${stage.color}`}>
                    <span className="text-sm font-semibold">{stage.label}</span>
                    <span className="text-xs bg-mc-bg-secondary px-2 py-0.5 rounded-full">
                      {itemsByStage(stage.id).length}
                    </span>
                  </div>
                  <Droppable droppableId={stage.id}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.droppableProps}
                        className={`flex-1 min-h-24 rounded-lg p-2 space-y-2 transition-colors ${
                          snapshot.isDraggingOver ? 'bg-mc-bg-tertiary' : 'bg-mc-bg-secondary/30'
                        }`}
                      >
                        {itemsByStage(stage.id).map((item, index) => (
                          <Draggable key={item.id} draggableId={item.id} index={index}>
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                {...provided.dragHandleProps}
                                onClick={() => setEditItem(item)}
                                className={`bg-mc-bg-secondary border border-mc-border rounded-lg p-3 cursor-pointer hover:border-mc-accent/50 transition-all ${
                                  snapshot.isDragging ? 'shadow-lg border-mc-accent/50 rotate-1' : ''
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2 mb-1">
                                  <p className="text-sm font-medium text-mc-text leading-tight line-clamp-2">
                                    {item.title}
                                  </p>
                                  <ChevronRight className="w-3 h-3 text-mc-text-secondary shrink-0 mt-0.5" />
                                </div>
                                <div className="flex items-center gap-2 mt-2">
                                  <div className="flex items-center gap-1 text-mc-text-secondary">
                                    <PlatformIcon platform={item.platform} />
                                    <span className="text-xs capitalize">{item.platform}</span>
                                  </div>
                                  {item.script && (
                                    <span className="text-xs text-mc-accent-green bg-mc-accent-green/10 px-1.5 py-0.5 rounded">
                                      has script
                                    </span>
                                  )}
                                </div>
                              </div>
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}
                      </div>
                    )}
                  </Droppable>
                </div>
              ))}
            </div>
          </DragDropContext>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-mc-bg-secondary border border-mc-border rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold">New Content Idea</h2>
              <button onClick={() => setShowCreateModal(false)} className="text-mc-text-secondary hover:text-mc-text">
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Title *"
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              autoFocus
            />
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Description"
              rows={2}
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent resize-none"
            />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-mc-text-secondary mb-1 block">Platform</label>
                <select
                  value={form.platform}
                  onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}
                  className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                >
                  {PLATFORMS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-mc-text-secondary mb-1 block">Start Stage</label>
                <select
                  value={form.stage}
                  onChange={e => setForm(f => ({ ...f, stage: e.target.value }))}
                  className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                >
                  {STAGES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
            </div>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Notes"
              rows={2}
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent resize-none"
            />
            <div className="flex gap-3">
              <button
                onClick={() => setShowCreateModal(false)}
                className="flex-1 py-2 border border-mc-border rounded text-sm text-mc-text-secondary hover:bg-mc-bg-tertiary"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!form.title.trim()}
                className="flex-1 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editItem && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-mc-bg-secondary border border-mc-border rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold">Edit Content</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDelete(editItem.id)}
                  className="p-2 text-mc-accent-red hover:bg-mc-accent-red/10 rounded"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <button onClick={() => setEditItem(null)} className="text-mc-text-secondary hover:text-mc-text">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <input
              value={editItem.title}
              onChange={e => setEditItem(i => i ? { ...i, title: e.target.value } : null)}
              onBlur={() => handleUpdate(editItem.id, { title: editItem.title })}
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm font-medium focus:outline-none focus:border-mc-accent"
            />

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-mc-text-secondary mb-1 block">Platform</label>
                <select
                  value={editItem.platform}
                  onChange={e => { const v = e.target.value; setEditItem(i => i ? { ...i, platform: v } : null); handleUpdate(editItem.id, { platform: v }); }}
                  className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                >
                  {PLATFORMS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-mc-text-secondary mb-1 block">Stage</label>
                <select
                  value={editItem.stage}
                  onChange={e => { const v = e.target.value; setEditItem(i => i ? { ...i, stage: v } : null); handleUpdate(editItem.id, { stage: v }); }}
                  className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                >
                  {STAGES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
            </div>

            <textarea
              value={editItem.description || ''}
              onChange={e => setEditItem(i => i ? { ...i, description: e.target.value } : null)}
              onBlur={() => handleUpdate(editItem.id, { description: editItem.description })}
              placeholder="Description"
              rows={2}
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent resize-none"
            />

            <textarea
              value={editItem.notes || ''}
              onChange={e => setEditItem(i => i ? { ...i, notes: e.target.value } : null)}
              onBlur={() => handleUpdate(editItem.id, { notes: editItem.notes })}
              placeholder="Notes"
              rows={2}
              className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent resize-none"
            />

            {/* Script Section */}
            <div className="border-t border-mc-border pt-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">Script</label>
                  {(editItem as ContentItem & { generation_status?: string }).generation_status === 'generating' && (
                    <span className="text-xs text-mc-accent-yellow bg-mc-accent-yellow/10 px-2 py-0.5 rounded animate-pulse">
                      Agent generating...
                    </span>
                  )}
                  {(editItem as ContentItem & { generation_status?: string }).generation_status === 'failed' && (
                    <span className="text-xs text-mc-accent-red bg-mc-accent-red/10 px-2 py-0.5 rounded">
                      Generation failed
                    </span>
                  )}
                </div>
                <button
                  onClick={handleGenerateScript}
                  disabled={generatingScript || (editItem as ContentItem & { generation_status?: string }).generation_status === 'generating'}
                  className="flex items-center gap-2 px-3 py-1.5 bg-mc-accent-purple/20 border border-mc-accent-purple/30 text-mc-accent-purple rounded text-xs font-medium hover:bg-mc-accent-purple/30 disabled:opacity-50"
                >
                  {generatingScript || (editItem as ContentItem & { generation_status?: string }).generation_status === 'generating' ? (
                    <><Loader2 className="w-3 h-3 animate-spin" /> Generating via Agent...</>
                  ) : (
                    <><Wand2 className="w-3 h-3" /> Generate Script</>
                  )}
                </button>
              </div>
              <textarea
                value={editItem.script || ''}
                onChange={e => setEditItem(i => i ? { ...i, script: e.target.value } : null)}
                onBlur={() => handleUpdate(editItem.id, { script: editItem.script })}
                placeholder="Script will appear here after generation, or type manually..."
                rows={10}
                className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-xs font-mono focus:outline-none focus:border-mc-accent resize-none"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
