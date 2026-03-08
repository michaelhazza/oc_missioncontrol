/**
 * Settings Page
 * Configure Mission Control paths, URLs, and preferences
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, Save, RotateCcw, Home, FolderOpen, Link as LinkIcon, Wifi, WifiOff, RefreshCw, Loader2 } from 'lucide-react';
import { getConfig, updateConfig, resetConfig, type MissionControlConfig } from '@/lib/config';

export default function SettingsPage() {
  const router = useRouter();
  const [config, setConfig] = useState<MissionControlConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Integration state
  const [gatewayConnected, setGatewayConnected] = useState<boolean | null>(null);
  const [gatewayChecking, setGatewayChecking] = useState(false);
  const [integrationSettings, setIntegrationSettings] = useState<{
    gateway_url: string;
    webhook_secret: string;
    polling_interval_seconds: number;
    state_mapping: string;
    max_retry_count: number;
    stale_task_threshold_minutes: number;
    monitor_cron_interval_minutes: number;
  }>({
    gateway_url: '',
    webhook_secret: '',
    polling_interval_seconds: 60,
    state_mapping: '{"queued":"inbox","assigned":"in_progress","running":"in_progress","completed":"done","failed":"blocked"}',
    max_retry_count: 5,
    stale_task_threshold_minutes: 60,
    monitor_cron_interval_minutes: 15,
  });
  const [retryingSyncCount, setRetryingSyncCount] = useState<number | null>(null);
  const [retrySyncResult, setRetrySyncResult] = useState<string | null>(null);
  const [discoveryWarnings, setDiscoveryWarnings] = useState<string[]>([]);

  const checkGatewayStatus = useCallback(async () => {
    setGatewayChecking(true);
    try {
      const res = await fetch('/api/openclaw/status');
      const data = await res.json();
      setGatewayConnected(data.connected === true);
    } catch {
      setGatewayConnected(false);
    } finally {
      setGatewayChecking(false);
    }
  }, []);

  const loadIntegrationSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/workspace-settings?workspace_id=default');
      if (res.ok) {
        const data = await res.json();
        setIntegrationSettings({
          gateway_url: data.gateway_url || '',
          webhook_secret: data.webhook_secret || '',
          polling_interval_seconds: data.polling_interval_seconds || 60,
          state_mapping: typeof data.state_mapping === 'object'
            ? JSON.stringify(data.state_mapping, null, 2)
            : data.state_mapping || '{}',
          max_retry_count: data.max_retry_count || 5,
          stale_task_threshold_minutes: data.stale_task_threshold_minutes || 60,
          monitor_cron_interval_minutes: data.monitor_cron_interval_minutes || 15,
        });
      }
    } catch (e) {
      console.error('Failed to load integration settings:', e);
    }
  }, []);

  useEffect(() => {
    setConfig(getConfig());
    checkGatewayStatus();
    loadIntegrationSettings();
  }, [checkGatewayStatus, loadIntegrationSettings]);

  const handleSave = async () => {
    if (!config) return;

    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      updateConfig(config);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    if (confirm('Reset all settings to defaults? This cannot be undone.')) {
      resetConfig();
      setConfig(getConfig());
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    }
  };

  const handleChange = (field: keyof MissionControlConfig, value: string) => {
    if (!config) return;
    setConfig({ ...config, [field]: value });
  };

  const handleSaveIntegration = async () => {
    setIsSaving(true);
    setError(null);
    try {
      let parsedMapping: Record<string, string>;
      try {
        parsedMapping = JSON.parse(integrationSettings.state_mapping);
      } catch {
        setError('Invalid JSON in state mapping');
        setIsSaving(false);
        return;
      }

      const res = await fetch('/api/workspace-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: 'default',
          gateway_url: integrationSettings.gateway_url || undefined,
          webhook_secret: integrationSettings.webhook_secret || undefined,
          polling_interval_seconds: integrationSettings.polling_interval_seconds,
          state_mapping: parsedMapping,
          max_retry_count: integrationSettings.max_retry_count,
          stale_task_threshold_minutes: integrationSettings.stale_task_threshold_minutes,
          monitor_cron_interval_minutes: integrationSettings.monitor_cron_interval_minutes,
        }),
      });

      if (res.ok) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        setError('Failed to save integration settings');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRetrySync = async () => {
    setRetryingSyncCount(0);
    setRetrySyncResult(null);
    try {
      const res = await fetch('/api/openclaw/retry-sync?workspace_id=default', { method: 'POST' });
      const data = await res.json();
      setRetryingSyncCount(null);
      setRetrySyncResult(data.message || `${data.succeeded}/${data.retried} succeeded`);
      setTimeout(() => setRetrySyncResult(null), 5000);
    } catch {
      setRetryingSyncCount(null);
      setRetrySyncResult('Retry sync failed');
    }
  };

  if (!config) {
    return (
      <div className="min-h-screen bg-mc-bg flex items-center justify-center">
        <div className="text-mc-text-secondary">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-mc-bg">
      {/* Header */}
      <div className="border-b border-mc-border bg-mc-bg-secondary">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/')}
              className="p-2 hover:bg-mc-bg-tertiary rounded text-mc-text-secondary"
              title="Back to Mission Control"
            >
              ← Back
            </button>
            <Settings className="w-6 h-6 text-mc-accent" />
            <h1 className="text-2xl font-bold text-mc-text">Settings</h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              className="px-4 py-2 border border-mc-border rounded hover:bg-mc-bg-tertiary text-mc-text-secondary flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Reset to Defaults
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-2 bg-mc-accent text-mc-bg rounded hover:bg-mc-accent/90 flex items-center gap-2 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Success Message */}
        {saveSuccess && (
          <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded text-green-400">
            ✓ Settings saved successfully
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded text-red-400">
            ✗ {error}
          </div>
        )}

        {/* Workspace Paths */}
        <section className="mb-8 p-6 bg-mc-bg-secondary border border-mc-border rounded-lg">
          <div className="flex items-center gap-2 mb-4">
            <FolderOpen className="w-5 h-5 text-mc-accent" />
            <h2 className="text-xl font-semibold text-mc-text">Workspace Paths</h2>
          </div>
          <p className="text-sm text-mc-text-secondary mb-4">
            Configure where Mission Control stores projects and deliverables.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Workspace Base Path
              </label>
              <input
                type="text"
                value={config.workspaceBasePath}
                onChange={(e) => handleChange('workspaceBasePath', e.target.value)}
                placeholder="~/Documents/Shared"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                Base directory for all Mission Control files. Use ~ for home directory.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Projects Path
              </label>
              <input
                type="text"
                value={config.projectsPath}
                onChange={(e) => handleChange('projectsPath', e.target.value)}
                placeholder="~/Documents/Shared/projects"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                Directory where project folders are created. Each project gets its own folder.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Default Project Name
              </label>
              <input
                type="text"
                value={config.defaultProjectName}
                onChange={(e) => handleChange('defaultProjectName', e.target.value)}
                placeholder="mission-control"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                Default name for new projects. Can be changed per project.
              </p>
            </div>
          </div>
        </section>

        {/* API Configuration */}
        <section className="mb-8 p-6 bg-mc-bg-secondary border border-mc-border rounded-lg">
          <div className="flex items-center gap-2 mb-4">
            <LinkIcon className="w-5 h-5 text-mc-accent" />
            <h2 className="text-xl font-semibold text-mc-text">API Configuration</h2>
          </div>
          <p className="text-sm text-mc-text-secondary mb-4">
            Configure Mission Control API URL for agent orchestration.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Mission Control URL
              </label>
              <input
                type="text"
                value={config.missionControlUrl}
                onChange={(e) => handleChange('missionControlUrl', e.target.value)}
                placeholder="http://localhost:4000"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                URL where Mission Control is running. Auto-detected by default. Change for remote access.
              </p>
            </div>
          </div>
        </section>

        {/* OpenClaw Integration */}
        <section className="mb-8 p-6 bg-mc-bg-secondary border border-mc-border rounded-lg">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              {gatewayConnected === true ? (
                <Wifi className="w-5 h-5 text-green-400" />
              ) : gatewayConnected === false ? (
                <WifiOff className="w-5 h-5 text-red-400" />
              ) : (
                <Loader2 className="w-5 h-5 text-mc-text-secondary animate-spin" />
              )}
              <h2 className="text-xl font-semibold text-mc-text">OpenClaw Integration</h2>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-1 rounded ${
                gatewayConnected === true ? 'bg-green-500/10 text-green-400' :
                gatewayConnected === false ? 'bg-red-500/10 text-red-400' :
                'bg-mc-bg-tertiary text-mc-text-secondary'
              }`}>
                {gatewayChecking ? 'Checking...' :
                 gatewayConnected === true ? 'Connected' :
                 gatewayConnected === false ? 'Disconnected' : 'Unknown'}
              </span>
              <button
                onClick={checkGatewayStatus}
                disabled={gatewayChecking}
                className="p-1.5 hover:bg-mc-bg-tertiary rounded text-mc-text-secondary"
                title="Check connection"
              >
                <RefreshCw className={`w-4 h-4 ${gatewayChecking ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
          <p className="text-sm text-mc-text-secondary mb-4">
            Configure the OpenClaw gateway connection and task sync settings. These settings are workspace-scoped.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">Gateway URL</label>
              <input
                type="text"
                value={integrationSettings.gateway_url}
                onChange={(e) => setIntegrationSettings(s => ({ ...s, gateway_url: e.target.value }))}
                placeholder="ws://127.0.0.1:18789 (uses env default if empty)"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">Webhook Secret (masked)</label>
              <input
                type="password"
                value={integrationSettings.webhook_secret}
                onChange={(e) => setIntegrationSettings(s => ({ ...s, webhook_secret: e.target.value }))}
                placeholder="Shared secret for webhook signature verification"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Polling Interval (seconds)</label>
                <input
                  type="number"
                  min={10}
                  max={600}
                  value={integrationSettings.polling_interval_seconds}
                  onChange={(e) => setIntegrationSettings(s => ({ ...s, polling_interval_seconds: parseInt(e.target.value) || 60 }))}
                  className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Max Retry Count</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={integrationSettings.max_retry_count}
                  onChange={(e) => setIntegrationSettings(s => ({ ...s, max_retry_count: parseInt(e.target.value) || 5 }))}
                  className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Stale Task Threshold (minutes)</label>
                <input
                  type="number"
                  min={5}
                  max={1440}
                  value={integrationSettings.stale_task_threshold_minutes}
                  onChange={(e) => setIntegrationSettings(s => ({ ...s, stale_task_threshold_minutes: parseInt(e.target.value) || 60 }))}
                  className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
                />
                <p className="text-xs text-mc-text-secondary mt-1">
                  Tasks in_progress longer than this are flagged as stale.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-mc-text mb-2">Monitor Interval (minutes)</label>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={integrationSettings.monitor_cron_interval_minutes}
                  onChange={(e) => setIntegrationSettings(s => ({ ...s, monitor_cron_interval_minutes: parseInt(e.target.value) || 15 }))}
                  className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
                />
                <p className="text-xs text-mc-text-secondary mt-1">
                  How often to check for stale tasks. Requires server restart.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                State Mapping (OpenClaw → Mission Control)
              </label>
              <textarea
                value={integrationSettings.state_mapping}
                onChange={(e) => setIntegrationSettings(s => ({ ...s, state_mapping: e.target.value }))}
                rows={6}
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text text-xs font-mono focus:border-mc-accent focus:outline-none resize-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                Maps OpenClaw task states to Mission Control statuses. Edit as JSON.
              </p>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handleSaveIntegration}
                disabled={isSaving}
                className="px-4 py-2 bg-mc-accent text-mc-bg rounded hover:bg-mc-accent/90 flex items-center gap-2 disabled:opacity-50 text-sm"
              >
                <Save className="w-4 h-4" />
                Save Integration Settings
              </button>
              <button
                onClick={handleRetrySync}
                disabled={retryingSyncCount !== null}
                className="px-4 py-2 border border-mc-border rounded hover:bg-mc-bg-tertiary text-mc-text-secondary flex items-center gap-2 text-sm"
              >
                <RefreshCw className={`w-4 h-4 ${retryingSyncCount !== null ? 'animate-spin' : ''}`} />
                Retry Failed Syncs
              </button>
              <button
                onClick={async () => {
                  try {
                    const res = await fetch('/api/agents/sync-frontmatter', { method: 'POST' });
                    const data = await res.json();
                    setDiscoveryWarnings(data.warnings || []);
                    setRetrySyncResult(`Frontmatter synced for ${data.synced} agents`);
                    setTimeout(() => setRetrySyncResult(null), 5000);
                  } catch {
                    setRetrySyncResult('Frontmatter sync failed');
                  }
                }}
                className="px-4 py-2 border border-mc-border rounded hover:bg-mc-bg-tertiary text-mc-text-secondary flex items-center gap-2 text-sm"
              >
                <RefreshCw className="w-4 h-4" />
                Sync Frontmatter
              </button>
              {retrySyncResult && (
                <span className="text-xs text-mc-text-secondary">{retrySyncResult}</span>
              )}
            </div>

            {discoveryWarnings.length > 0 && (
              <div className="mt-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded">
                <p className="text-sm font-medium text-yellow-400 mb-1">Agent Topology Warnings</p>
                <ul className="text-xs text-yellow-300 space-y-1 ml-4 list-disc">
                  {discoveryWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        {/* Environment Variables Note */}
        <section className="p-6 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <h3 className="text-lg font-semibold text-blue-400 mb-2">
            📝 Environment Variables
          </h3>
          <p className="text-sm text-blue-300 mb-3">
            Some settings are also configurable via environment variables in <code className="px-2 py-1 bg-mc-bg rounded">.env.local</code>:
          </p>
          <ul className="text-sm text-blue-300 space-y-1 ml-4 list-disc">
            <li><code>MISSION_CONTROL_URL</code> - API URL override</li>
            <li><code>WORKSPACE_BASE_PATH</code> - Base workspace directory</li>
            <li><code>PROJECTS_PATH</code> - Projects directory</li>
            <li><code>OPENCLAW_GATEWAY_URL</code> - Gateway WebSocket URL</li>
            <li><code>OPENCLAW_GATEWAY_TOKEN</code> - Gateway auth token</li>
            <li><code>OPENCLAW_WEBHOOK_SECRET</code> - Webhook signature secret</li>
          </ul>
          <p className="text-xs text-blue-400 mt-3">
            Environment variables take precedence over UI settings for server-side operations.
          </p>
        </section>
      </div>
    </div>
  );
}
