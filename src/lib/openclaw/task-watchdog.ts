import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, queryOne, run } from '@/lib/db';
import { getOpenClawClient } from './client';
import type { Task } from '@/lib/types';

const INTERVAL_MS = 30 * 60 * 1000;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const LEASE_MS = 25 * 60 * 1000;
const WATCHDOG_AGENT_ID = process.env.MISSION_CONTROL_WATCHDOG_AGENT_ID || 'tank';

let watchdogInterval: NodeJS.Timeout | null = null;

interface WatchdogTask extends Task {
  agent_name: string;
  gateway_agent_id: string;
  session_key_prefix: string | null;
}

function hasRecentAgentActivity(gatewayAgentId: string, nowMs = Date.now()): boolean {
  const sessionsDir = path.join(os.homedir(), '.openclaw', 'agents', gatewayAgentId, 'sessions');
  try {
    return fs.readdirSync(sessionsDir)
      .filter(file => file.endsWith('.jsonl'))
      .some(file => nowMs - fs.statSync(path.join(sessionsDir, file)).mtimeMs <= ACTIVE_WINDOW_MS);
  } catch {
    return false;
  }
}

function ensureLeaseTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS task_watchdog_leases (
      task_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      epoch INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
  `);
}

function acquireLease(taskId: string, ownerId: string, now: Date): boolean {
  const expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  return getDb().transaction(() => {
    const existing = queryOne<{ owner_id: string; lease_expires_at: string }>(
      'SELECT owner_id, lease_expires_at FROM task_watchdog_leases WHERE task_id = ?',
      [taskId],
    );
    if (existing && Date.parse(existing.lease_expires_at) > now.getTime()) return false;

    run(
      `INSERT INTO task_watchdog_leases (task_id, owner_id, lease_expires_at, epoch, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         owner_id = excluded.owner_id,
         lease_expires_at = excluded.lease_expires_at,
         epoch = task_watchdog_leases.epoch + 1,
         updated_at = excluded.updated_at
       WHERE task_watchdog_leases.lease_expires_at <= excluded.updated_at`,
      [taskId, ownerId, expiresAt, now.toISOString()],
    );
    const claimed = queryOne<{ owner_id: string }>(
      'SELECT owner_id FROM task_watchdog_leases WHERE task_id = ?',
      [taskId],
    );
    return claimed?.owner_id === ownerId;
  })();
}

function releaseLease(taskId: string, ownerId: string): void {
  run('DELETE FROM task_watchdog_leases WHERE task_id = ? AND owner_id = ?', [taskId, ownerId]);
}

export async function runTaskWatchdogCheck(now = new Date()): Promise<'no-task' | 'active' | 'leased' | 'resumed' | 'unavailable'> {
  ensureLeaseTable();

  const task = queryOne<WatchdogTask>(
    `SELECT t.*, a.name AS agent_name, a.gateway_agent_id, a.session_key_prefix
     FROM tasks t
     JOIN agents a ON a.id = t.assigned_agent_id
     WHERE a.gateway_agent_id = ? AND t.status = 'in_progress'
     ORDER BY COALESCE(t.updated_at, t.created_at) ASC
     LIMIT 1`,
    [WATCHDOG_AGENT_ID],
  );
  if (!task) return 'no-task';
  if (hasRecentAgentActivity(task.gateway_agent_id, now.getTime())) return 'active';

  const ownerId = uuidv4();
  if (!acquireLease(task.id, ownerId, now)) return 'leased';

  const client = getOpenClawClient();
  if (!client.isConnected()) {
    try {
      await client.connect();
    } catch {
      releaseLease(task.id, ownerId);
      return 'unavailable';
    }
  }

  const mcUrl = (process.env.MISSION_CONTROL_URL || 'http://localhost:3000').replace(/\/$/, '');
  const sessionKey = `${task.session_key_prefix || `agent:${task.gateway_agent_id}:`}mission-control-watchdog`;
  try {
    await client.call('chat.send', {
      sessionKey,
      idempotencyKey: `watchdog-${task.id}-${ownerId}`,
      message: `Mission Control recovery check: resume your assigned in-progress task \"${task.title}\" (${task.id}). Fetch the current task record at ${mcUrl}/api/tasks/${task.id}, inspect existing artifacts and activity, and continue from the last verified checkpoint. Do not restart completed work. If another live execution already owns this task, exit without doing work. Log meaningful progress to Mission Control and only move to review when all acceptance criteria, tests, deliverables, and the completion summary are present.`,
    });
  } catch (err) {
    releaseLease(task.id, ownerId);
    throw err;
  }

  run(
    `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
     VALUES (?, ?, (SELECT id FROM agents WHERE gateway_agent_id = ? LIMIT 1), ?, ?, ?, ?)`,
    [
      uuidv4(),
      'task_watchdog_resumed',
      task.gateway_agent_id,
      task.id,
      `30-minute watchdog resumed stale task \"${task.title}\" for ${task.agent_name}`,
      JSON.stringify({ ownerId, sessionKey }),
      now.toISOString(),
    ],
  );
  return 'resumed';
}

export function startTaskWatchdog(): void {
  if (watchdogInterval || process.env.MISSION_CONTROL_TASK_WATCHDOG === 'disabled') return;
  ensureLeaseTable();
  console.log(`[TaskWatchdog] Checking ${WATCHDOG_AGENT_ID} every 30 minutes`);
  void runTaskWatchdogCheck().catch(err => console.error('[TaskWatchdog] Initial check failed:', err));
  watchdogInterval = setInterval(() => {
    void runTaskWatchdogCheck().catch(err => console.error('[TaskWatchdog] Check failed:', err));
  }, INTERVAL_MS);
}

export function stopTaskWatchdog(): void {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = null;
}
