import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDb, queryOne, transaction } from '@/lib/db';
import { createCompletionContract } from '@/lib/completion-contract';

export interface MattermostInboundEvent {
  workspace_id: string;
  mattermost_account_id: string;
  provider_event_id: string;
  sender_id: string;
  channel_id: string;
  channel_type: string;
  root_post_id?: string;
  source_post_id: string;
  message: string;
  provider_created_at: string;
  provider_revision?: string;
  event_kind?: 'created' | 'edited';
  thread_url?: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const lineageId = (event: MattermostInboundEvent, root: string) => sha256(`${event.workspace_id}\0${event.mattermost_account_id}\0${event.channel_id}\0${root}`);

export function verifyMattermostSignature(rawBody: string, signature: string | null, timestamp: string | null, now = Date.now()) {
  const secret = process.env.MC_MATTERMOST_INTAKE_SECRET;
  if (!secret) return { ok: false, reason: 'intake signing secret is not configured' };
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return { ok: false, reason: 'missing signature or timestamp' };
  if (Math.abs(now - Number(timestamp) * 1000) > 5 * 60_000) return { ok: false, reason: 'signature timestamp is outside the replay window' };
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const supplied = signature.replace(/^sha256=/, '');
  if (expected.length !== supplied.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return { ok: false, reason: 'invalid signature' };
  return { ok: true as const };
}

function validateAllowlist(event: MattermostInboundEvent) {
  const configured = {
    account: process.env.MC_MATTERMOST_ACCOUNT_ID,
    sender: process.env.MC_MATTERMOST_SENDER_ID,
    channel: process.env.MC_MATTERMOST_CHANNEL_ID,
  };
  if (!configured.account || !configured.sender || !configured.channel) throw new Error('Mattermost intake allowlist is incomplete');
  if (event.channel_type !== 'D') throw new Error('Only direct Mattermost channels are accepted');
  if (event.mattermost_account_id !== configured.account || event.sender_id !== configured.sender || event.channel_id !== configured.channel) throw new Error('Mattermost identity is not allowlisted');
}

function titleFrom(message: string) {
  const firstLine = message.trim().split(/\r?\n/)[0].replace(/^#+\s*/, '');
  return (firstLine || 'Mattermost task').slice(0, 180);
}

export function processMattermostInbound(event: MattermostInboundEvent, now = new Date()) {
  validateAllowlist(event);
  if (!event.workspace_id || !event.provider_event_id || !event.source_post_id || !event.message.trim()) throw new Error('Inbound event is missing required fields');
  if (!Number.isFinite(Date.parse(event.provider_created_at))) throw new Error('provider_created_at must be ISO-8601');
  const root = event.root_post_id || event.source_post_id;
  const payloadHash = sha256(JSON.stringify({ message: event.message.trim(), revision: event.provider_revision || '', kind: event.event_kind || 'created' }));
  const stamp = now.toISOString();
  const existingEvent = queryOne<{ disposition: string; task_id: string | null }>(
    'SELECT disposition,task_id FROM task_intake_events WHERE workspace_id=? AND mattermost_account_id=? AND provider_event_id=?',
    [event.workspace_id, event.mattermost_account_id, event.provider_event_id],
  );
  if (existingEvent) return { disposition: 'duplicate', task_id: existingEvent.task_id, prior_disposition: existingEvent.disposition };

  const result = transaction(() => {
    const db = getDb();
    const task = db.prepare(`SELECT id,status FROM tasks WHERE workspace_id=? AND mattermost_account_id=? AND mattermost_channel_id=?
      AND mattermost_root_post_id=? AND deleted_at IS NULL AND is_current_lineage_member=1`).get(
      event.workspace_id, event.mattermost_account_id, event.channel_id, root,
    ) as { id: string; status: string } | undefined;
    const eventId = randomUUID();
    if (task) {
      if (task.status === 'done') {
        db.prepare(`INSERT INTO task_intake_events(id,workspace_id,mattermost_account_id,provider_event_id,sender_id,channel_id,channel_type,root_post_id,source_post_id,provider_created_at,provider_revision,event_kind,payload_hash,received_at,candidate_state,candidate_reason,disposition,task_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open','terminal_follow_on','needs_classification',?)`).run(
          eventId,event.workspace_id,event.mattermost_account_id,event.provider_event_id,event.sender_id,event.channel_id,event.channel_type,root,event.source_post_id,event.provider_created_at,event.provider_revision||null,event.event_kind||'created',payloadHash,stamp,task.id,
        );
        return { disposition: 'needs_classification', task_id: task.id, candidate_reason: 'terminal_follow_on' };
      }
      const next = (db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM task_brief_revisions WHERE task_id=?').get(task.id) as { revision: number }).revision;
      db.prepare(`INSERT OR IGNORE INTO task_brief_revisions(id,task_id,revision,source_post_id,provider_created_at,provider_revision,payload_hash,brief,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(),task.id,next,event.source_post_id,event.provider_created_at,event.provider_revision||null,payloadHash,event.message.trim(),stamp,
      );
      db.prepare(`UPDATE tasks SET brief=CASE WHEN brief IS NULL OR brief='' THEN ? ELSE brief || '\n\n--- Thread update ---\n' || ? END,
        mattermost_source_post_id=?,evidence_version=evidence_version+1,current_completion_review_id=NULL,updated_at=? WHERE id=?`).run(event.message.trim(),event.message.trim(),event.source_post_id,stamp,task.id);
      db.prepare(`INSERT INTO task_intake_events(id,workspace_id,mattermost_account_id,provider_event_id,sender_id,channel_id,channel_type,root_post_id,source_post_id,provider_created_at,provider_revision,event_kind,payload_hash,received_at,candidate_state,disposition,task_id,processed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'resolved','corrected',?,?)`).run(
        eventId,event.workspace_id,event.mattermost_account_id,event.provider_event_id,event.sender_id,event.channel_id,event.channel_type,root,event.source_post_id,event.provider_created_at,event.provider_revision||null,event.event_kind||'created',payloadHash,stamp,task.id,stamp,
      );
      return { disposition: 'corrected', task_id: task.id, revision: next };
    }

    const taskId = randomUUID();
    db.prepare(`INSERT INTO tasks(id,title,description,status,priority,workspace_id,brief,trigger_type,trigger_source,mattermost_account_id,mattermost_channel_id,mattermost_root_post_id,mattermost_source_post_id,mattermost_thread_url,lineage_id,is_current_lineage_member,evidence_version,created_at,updated_at)
      VALUES(?,?,?,'inbox','normal',?,?, 'webhook','mattermost_dm',?,?,?,?,?,?,1,1,?,?)`).run(
      taskId,titleFrom(event.message),event.message.trim(),event.workspace_id,event.message.trim(),event.mattermost_account_id,event.channel_id,root,event.source_post_id,event.thread_url||null,lineageId(event,root),stamp,stamp,
    );
    db.prepare(`INSERT INTO task_brief_revisions(id,task_id,revision,source_post_id,provider_created_at,provider_revision,payload_hash,brief,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(),taskId,1,event.source_post_id,event.provider_created_at,event.provider_revision||null,payloadHash,event.message.trim(),stamp,
    );
    db.prepare(`INSERT INTO task_intake_events(id,workspace_id,mattermost_account_id,provider_event_id,sender_id,channel_id,channel_type,root_post_id,source_post_id,provider_created_at,provider_revision,event_kind,payload_hash,received_at,candidate_state,disposition,task_id,processed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'resolved','captured',?,?)`).run(
      eventId,event.workspace_id,event.mattermost_account_id,event.provider_event_id,event.sender_id,event.channel_id,event.channel_type,root,event.source_post_id,event.provider_created_at,event.provider_revision||null,event.event_kind||'created',payloadHash,stamp,taskId,stamp,
    );
    return { disposition: 'captured', task_id: taskId };
  });
  if (result.disposition === 'captured') createCompletionContract(result.task_id, { acceptance_criteria: ['Complete the requested outcome and provide verifiable evidence.'] }, now);
  return result;
}

