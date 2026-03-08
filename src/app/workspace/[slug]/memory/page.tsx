'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { Brain, Search, Star, Calendar, RefreshCw, FileText } from 'lucide-react';
import { Header } from '@/components/Header';
import { format } from 'date-fns';

interface MemoryFile {
  filename: string;
  path: string;
  content: string;
  modified_at: string;
  is_longterm: boolean;
}

function renderMarkdown(text: string): string {
  return text
    .replace(/^### (.+)$/gm, '<h3 class="text-sm font-bold text-mc-accent mt-4 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-base font-bold text-mc-text mt-5 mb-2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-lg font-bold text-mc-text mt-5 mb-2">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-mc-text font-semibold">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="bg-mc-bg-tertiary px-1 rounded text-mc-accent-cyan text-xs">$1</code>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-mc-text-secondary">$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li class="ml-4 list-decimal text-mc-text-secondary">$2</li>')
    .replace(/\n{2,}/g, '<br/><br/>')
    .replace(/\n/g, '<br/>');
}

export default function MemoryPage() {
  const params = useParams();
  const slug = params?.slug as string;

  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/memory');
        if (res.ok) {
          const data = await res.json();
          setFiles(data);
          if (data.length > 0) setSelectedFile(data[0].filename);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files;
    const q = searchQuery.toLowerCase();
    return files.filter(f =>
      f.filename.toLowerCase().includes(q) ||
      f.content.toLowerCase().includes(q)
    );
  }, [files, searchQuery]);

  const activeFile = selectedFile ? files.find(f => f.filename === selectedFile) : null;

  return (
    <div className="h-full flex flex-col bg-mc-bg overflow-hidden">
      <Header workspace={{ id: 'default', name: slug, slug, icon: '🧠', created_at: '', updated_at: '' }} />

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-56 border-r border-mc-border bg-mc-bg-secondary flex flex-col shrink-0">
          <div className="p-3 border-b border-mc-border">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mc-text-secondary" />
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search memory..."
                className="w-full bg-mc-bg border border-mc-border rounded pl-7 pr-3 py-1.5 text-xs focus:outline-none focus:border-mc-accent"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="w-4 h-4 animate-spin text-mc-text-secondary" />
              </div>
            ) : filteredFiles.length === 0 ? (
              <p className="text-xs text-mc-text-secondary text-center py-4">No files found</p>
            ) : (
              filteredFiles.map(file => (
                <button
                  key={file.filename}
                  onClick={() => setSelectedFile(file.filename)}
                  className={`w-full text-left px-2 py-2 rounded text-xs transition-colors ${
                    selectedFile === file.filename
                      ? 'bg-mc-accent/10 text-mc-accent border border-mc-accent/30'
                      : 'text-mc-text-secondary hover:bg-mc-bg-tertiary hover:text-mc-text'
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {file.is_longterm ? (
                      <Star className="w-3 h-3 text-mc-accent-yellow shrink-0" />
                    ) : (
                      <FileText className="w-3 h-3 shrink-0" />
                    )}
                    <span className="font-medium truncate">{file.filename}</span>
                  </div>
                  <div className="text-mc-text-secondary/60 text-[10px] pl-4">
                    {format(new Date(file.modified_at), 'MMM d, yyyy')}
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="p-3 border-t border-mc-border text-xs text-mc-text-secondary">
            {files.length} file{files.length !== 1 ? 's' : ''}
          </div>
        </div>

        {/* Main content area */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <RefreshCw className="w-6 h-6 animate-spin text-mc-text-secondary" />
            </div>
          ) : !activeFile ? (
            <div className="flex flex-col items-center justify-center h-64 text-mc-text-secondary">
              <Brain className="w-12 h-12 mb-4 opacity-30" />
              <p className="text-sm">Select a memory file to view</p>
            </div>
          ) : searchQuery && filteredFiles.length > 1 ? (
            // Search results: show all matching files
            <div className="space-y-6">
              <div className="flex items-center gap-2 mb-2">
                <Search className="w-4 h-4 text-mc-text-secondary" />
                <span className="text-sm text-mc-text-secondary">
                  {filteredFiles.length} files matching &ldquo;{searchQuery}&rdquo;
                </span>
              </div>
              {filteredFiles.map(file => (
                <div key={file.filename} id={`file-${file.filename}`} className="bg-mc-bg-secondary border border-mc-border rounded-xl p-5">
                  <div className="flex items-center gap-2 mb-4 pb-3 border-b border-mc-border">
                    {file.is_longterm ? (
                      <Star className="w-4 h-4 text-mc-accent-yellow" />
                    ) : (
                      <Calendar className="w-4 h-4 text-mc-text-secondary" />
                    )}
                    <h2 className="font-bold text-mc-text">{file.filename}</h2>
                    <span className="text-xs text-mc-text-secondary ml-auto">
                      {format(new Date(file.modified_at), 'MMM d, yyyy HH:mm')}
                    </span>
                  </div>
                  <div
                    className="text-sm text-mc-text-secondary leading-relaxed prose-sm"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(file.content) }}
                  />
                </div>
              ))}
            </div>
          ) : (
            // Single file view
            <div className="bg-mc-bg-secondary border border-mc-border rounded-xl p-5 max-w-3xl">
              <div className="flex items-center gap-2 mb-4 pb-3 border-b border-mc-border">
                {activeFile.is_longterm ? (
                  <Star className="w-4 h-4 text-mc-accent-yellow" />
                ) : (
                  <Calendar className="w-4 h-4 text-mc-text-secondary" />
                )}
                <h2 className="font-bold text-mc-text">{activeFile.filename}</h2>
                {activeFile.is_longterm && (
                  <span className="text-xs bg-mc-accent-yellow/10 text-mc-accent-yellow border border-mc-accent-yellow/30 px-2 py-0.5 rounded-full">
                    Long-term Memory
                  </span>
                )}
                <span className="text-xs text-mc-text-secondary ml-auto">
                  {format(new Date(activeFile.modified_at), 'MMM d, yyyy HH:mm')}
                </span>
              </div>
              {activeFile.content.trim() === '' ? (
                <p className="text-sm text-mc-text-secondary italic">This file is empty.</p>
              ) : (
                <div
                  className="text-sm text-mc-text-secondary leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(activeFile.content) }}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
