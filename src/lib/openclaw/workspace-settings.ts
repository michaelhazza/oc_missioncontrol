/**
 * Workspace Settings Service
 *
 * CRUD helpers for the workspace_settings table. Provides per-workspace
 * integration configuration (gateway URL, webhook secret, state mapping,
 * polling interval, max retry count). Returns application-layer defaults
 * when no row exists for a given workspace so new workspaces work out of
 * the box without requiring a settings save first.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import type { WorkspaceSettings } from '@/lib/types';

/** Application-layer defaults applied when no workspace_settings row exists. */
export const DEFAULT_STATE_MAPPING: Record<string, string> = {
  queued: 'inbox',
  assigned: 'in_progress',
  running: 'in_progress',
  completed: 'done',
  failed: 'blocked',
};

const DEFAULT_POLLING_INTERVAL = 60;
const DEFAULT_MAX_RETRY = 5;

interface WorkspaceSettingsRow {
  id: string;
  workspace_id: string;
  gateway_url: string | null;
  webhook_secret: string | null;
  polling_interval_seconds: number;
  state_mapping: string;
  max_retry_count: number;
  created_at: string;
  updated_at: string;
}

function rowToSettings(row: WorkspaceSettingsRow): WorkspaceSettings {
  let mapping: Record<string, string>;
  try {
    mapping = JSON.parse(row.state_mapping);
  } catch {
    mapping = { ...DEFAULT_STATE_MAPPING };
  }

  return {
    id: row.id,
    workspace_id: row.workspace_id,
    gateway_url: row.gateway_url ?? undefined,
    webhook_secret: row.webhook_secret ?? undefined,
    polling_interval_seconds: row.polling_interval_seconds,
    state_mapping: mapping,
    max_retry_count: row.max_retry_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Get workspace settings. Returns defaults if no row exists.
 */
export function getWorkspaceSettings(workspaceId: string): WorkspaceSettings {
  const row = queryOne<WorkspaceSettingsRow>(
    'SELECT * FROM workspace_settings WHERE workspace_id = ?',
    [workspaceId],
  );

  if (row) return rowToSettings(row);

  // Return application-layer defaults
  const now = new Date().toISOString();
  return {
    id: '',
    workspace_id: workspaceId,
    gateway_url: undefined,
    webhook_secret: undefined,
    polling_interval_seconds: DEFAULT_POLLING_INTERVAL,
    state_mapping: { ...DEFAULT_STATE_MAPPING },
    max_retry_count: DEFAULT_MAX_RETRY,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Upsert workspace settings. Creates a new row or updates the existing one.
 */
export function upsertWorkspaceSettings(
  workspaceId: string,
  updates: Partial<Omit<WorkspaceSettings, 'id' | 'workspace_id' | 'created_at' | 'updated_at'>>,
): WorkspaceSettings {
  const now = new Date().toISOString();
  const existing = queryOne<WorkspaceSettingsRow>(
    'SELECT * FROM workspace_settings WHERE workspace_id = ?',
    [workspaceId],
  );

  const stateMapping = updates.state_mapping
    ? JSON.stringify(updates.state_mapping)
    : existing?.state_mapping ?? JSON.stringify(DEFAULT_STATE_MAPPING);

  if (existing) {
    run(
      `UPDATE workspace_settings
       SET gateway_url = ?, webhook_secret = ?, polling_interval_seconds = ?,
           state_mapping = ?, max_retry_count = ?, updated_at = ?
       WHERE workspace_id = ?`,
      [
        updates.gateway_url ?? existing.gateway_url,
        updates.webhook_secret ?? existing.webhook_secret,
        updates.polling_interval_seconds ?? existing.polling_interval_seconds,
        stateMapping,
        updates.max_retry_count ?? existing.max_retry_count,
        now,
        workspaceId,
      ],
    );
  } else {
    const id = uuidv4();
    run(
      `INSERT INTO workspace_settings
       (id, workspace_id, gateway_url, webhook_secret, polling_interval_seconds, state_mapping, max_retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        updates.gateway_url ?? null,
        updates.webhook_secret ?? null,
        updates.polling_interval_seconds ?? DEFAULT_POLLING_INTERVAL,
        stateMapping,
        updates.max_retry_count ?? DEFAULT_MAX_RETRY,
        now,
        now,
      ],
    );
  }

  return getWorkspaceSettings(workspaceId);
}

/**
 * Map an OpenClaw gateway state to a Mission Control task status using the
 * workspace's configured state mapping. Returns undefined if no mapping exists.
 */
export function mapGatewayState(workspaceId: string, gatewayState: string): string | undefined {
  const settings = getWorkspaceSettings(workspaceId);
  return settings.state_mapping[gatewayState];
}
