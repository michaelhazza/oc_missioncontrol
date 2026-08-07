import { randomUUID } from 'crypto';
import { getDb, queryAll, queryOne, run, transaction } from '@/lib/db';

export const HEARTBEAT_TARGET_MS = 90_000;
export const LEASE_TTL_MS = 3 * 60_000;
export const STALE_AFTER_MS = 4 * 60_000;
export const RECONCILE_INTERVAL_MS = 60_000;
export const MAX_AUTOMATIC_RESUMES = 1;
export const MAX_TRANSIENT_RETRIES = 2;
export const RETRY_BASE_MS = 30_000;

export type ExecutionState =
  | 'running' | 'waiting_input' | 'blocked' | 'stalled' | 'recovering'
  | 'failed' | 'cancelled' | 'complete';

export interface ExecutionRun {
  id: string; task_id: string; agent_id: string; session_key: string;
  run_identity: string; state: ExecutionState; lease_owner: string | null;
  lease_epoch: number; lease_expires_at: string | null; heartbeat_at: string | null;
  checkpoint: string | null; checkpoint_at: string | null; resume_count: number;
  retry_count: number; recovery_not_before: string | null; last_failure_code: string | null;
  last_failure_detail: string | null; oracle_status: 'none'|'pending'|'acknowledged'|'resolved';
  created_at: string; updated_at: string; terminal_at: string | null;
}

export class ExecutionConflictError extends Error {}
export class StaleLeaseError extends Error {}

function activity(taskId: string, agentId: string | null, type: string, message: string, metadata: object, now: string) {
  run(`INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), taskId, agentId, type, message, JSON.stringify(metadata), now]);
}

function event(runId: string, taskId: string, key: string, type: string, epoch: number | null, payload: object, now: string): boolean {
  const result = run(`INSERT OR IGNORE INTO task_execution_events
    (id, run_id, task_id, event_key, event_type, lease_epoch, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), runId, taskId, key, type, epoch, JSON.stringify(payload), now]);
  return result.changes === 1;
}

export function startExecution(input: {taskId:string; agentId:string; sessionKey:string; runIdentity:string; leaseOwner:string}, now = new Date()): ExecutionRun {
  return transaction(() => {
    const task = queryOne<{status:string; assigned_agent_id:string|null}>('SELECT status, assigned_agent_id FROM tasks WHERE id = ?', [input.taskId]);
    if (!task) throw new Error('Task not found');
    if (task.assigned_agent_id !== input.agentId) throw new ExecutionConflictError('Agent is not assigned to task');
    if (!['assigned','in_progress'].includes(task.status)) throw new ExecutionConflictError(`Task state ${task.status} cannot execute`);
    const existing = queryOne<ExecutionRun>(`SELECT * FROM task_execution_runs WHERE task_id = ? AND state IN ('running','waiting_input','blocked','stalled','recovering')`, [input.taskId]);
    if (existing) {
      if (existing.run_identity === input.runIdentity) return existing;
      throw new ExecutionConflictError('Task already has a live execution run');
    }
    const iso = now.toISOString();
    const id = randomUUID();
    const expires = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
    run(`INSERT INTO task_execution_runs
      (id,task_id,agent_id,session_key,run_identity,state,lease_owner,lease_epoch,lease_expires_at,heartbeat_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'running',?,1,?,?,?,?)`,
      [id,input.taskId,input.agentId,input.sessionKey,input.runIdentity,input.leaseOwner,expires,iso,iso,iso]);
    run(`UPDATE tasks SET status='in_progress', updated_at=? WHERE id=?`, [iso,input.taskId]);
    event(id,input.taskId,'lease:1','lease_acquired',1,{owner:input.leaseOwner,expiresAt:expires},iso);
    activity(input.taskId,input.agentId,'execution_lease','Execution lease acquired', {runId:id,runIdentity:input.runIdentity,epoch:1,expiresAt:expires}, iso);
    return queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[id])!;
  });
}

export function heartbeat(input:{runId:string; leaseOwner:string; leaseEpoch:number; eventKey:string; checkpoint?:object}, now=new Date()): ExecutionRun {
  return transaction(() => {
    const current=queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[input.runId]);
    if(!current) throw new Error('Execution run not found');
    if(current.lease_owner!==input.leaseOwner || current.lease_epoch!==input.leaseEpoch) throw new StaleLeaseError('Stale lease owner or epoch');
    if(!['running','waiting_input','blocked','recovering'].includes(current.state)) throw new ExecutionConflictError(`Cannot heartbeat ${current.state} run`);
    const iso=now.toISOString(); const expires=new Date(now.getTime()+LEASE_TTL_MS).toISOString();
    const inserted=event(current.id,current.task_id,input.eventKey,'heartbeat',current.lease_epoch,{expiresAt:expires,hasCheckpoint:!!input.checkpoint},iso);
    if(inserted) {
      run(`UPDATE task_execution_runs SET heartbeat_at=?, lease_expires_at=?, checkpoint=COALESCE(?,checkpoint),
        checkpoint_at=CASE WHEN ? IS NULL THEN checkpoint_at ELSE ? END, state=CASE WHEN state='recovering' THEN 'running' ELSE state END, updated_at=? WHERE id=?`,
        [iso,expires,input.checkpoint?JSON.stringify(input.checkpoint):null,input.checkpoint?JSON.stringify(input.checkpoint):null,iso,iso,current.id]);
      activity(current.task_id,current.agent_id,'execution_heartbeat','Execution heartbeat renewed',{runId:current.id,epoch:current.lease_epoch,checkpoint:!!input.checkpoint},iso);
    }
    return queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[current.id])!;
  });
}

export function heartbeatFromActivity(taskId:string,agentId:string,eventKey:string,checkpoint?:object,now=new Date()):ExecutionRun|undefined {
  const current=queryOne<ExecutionRun>(`SELECT * FROM task_execution_runs WHERE task_id=? AND agent_id=? AND state IN ('running','waiting_input','blocked','recovering') ORDER BY created_at DESC LIMIT 1`,[taskId,agentId]);
  if(!current?.lease_owner)return undefined;
  return heartbeat({runId:current.id,leaseOwner:current.lease_owner,leaseEpoch:current.lease_epoch,eventKey,checkpoint},now);
}

export function transitionFromActivity(taskId:string,agentId:string,eventKey:string,state:ExecutionState,reason?:string,now=new Date()):ExecutionRun|undefined {
  const current=queryOne<ExecutionRun>(`SELECT * FROM task_execution_runs WHERE task_id=? AND agent_id=? AND state IN ('running','waiting_input','blocked','recovering') ORDER BY created_at DESC LIMIT 1`,[taskId,agentId]);
  if(!current?.lease_owner)return undefined;
  return transitionExecution({runId:current.id,leaseOwner:current.lease_owner,leaseEpoch:current.lease_epoch,eventKey,state,reason},now);
}

export function abandonDispatchExecution(runId:string,reason:string,taskStatus:string,now=new Date()):void {
  transaction(()=>{
    const current=queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[runId]);
    if(!current)return;
    const iso=now.toISOString();
    run(`UPDATE task_execution_runs SET state='failed',last_failure_code='dispatch_failed',last_failure_detail=?,lease_expires_at=NULL,terminal_at=?,updated_at=? WHERE id=?`,[reason,iso,iso,runId]);
    run('UPDATE tasks SET status=?,updated_at=? WHERE id=?',[taskStatus,iso,current.task_id]);
    event(runId,current.task_id,`dispatch-failed:${current.lease_epoch}`,'dispatch_failed',current.lease_epoch,{reason},iso);
    activity(current.task_id,current.agent_id,'execution_failed','Execution dispatch failed before worker acknowledgement',{runId,reason},iso);
  });
}

export function transitionExecution(input:{runId:string; leaseOwner:string; leaseEpoch:number; eventKey:string; state:ExecutionState; reason?:string; checkpoint?:object}, now=new Date()): ExecutionRun {
  return transaction(()=>{
    const current=queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[input.runId]);
    if(!current) throw new Error('Execution run not found');
    if(current.lease_owner!==input.leaseOwner || current.lease_epoch!==input.leaseEpoch) throw new StaleLeaseError('Stale lease owner or epoch');
    const terminal=['complete','failed','cancelled'].includes(input.state); const iso=now.toISOString();
    if(!event(current.id,current.task_id,input.eventKey,`transition.${input.state}`,current.lease_epoch,{reason:input.reason},iso)) return current;
    run(`UPDATE task_execution_runs SET state=?, checkpoint=COALESCE(?,checkpoint), checkpoint_at=CASE WHEN ? IS NULL THEN checkpoint_at ELSE ? END,
      last_failure_detail=CASE WHEN ?='failed' THEN ? ELSE last_failure_detail END, terminal_at=CASE WHEN ? THEN ? ELSE terminal_at END,
      lease_expires_at=CASE WHEN ? THEN NULL ELSE lease_expires_at END, updated_at=? WHERE id=?`,
      [input.state,input.checkpoint?JSON.stringify(input.checkpoint):null,input.checkpoint?JSON.stringify(input.checkpoint):null,iso,input.state,input.reason||null,terminal?1:0,iso,terminal?1:0,iso,current.id]);
    const taskStatus=input.state==='complete'?'review':['failed','cancelled','blocked','waiting_input'].includes(input.state)?'blocked':'in_progress';
    run('UPDATE tasks SET status=?,status_reason=?,updated_at=? WHERE id=?',[taskStatus,input.reason||null,iso,current.task_id]);
    activity(current.task_id,current.agent_id,`execution_${input.state}`,`Execution transitioned to ${input.state}${input.reason?`: ${input.reason}`:''}`,{runId:current.id,epoch:current.lease_epoch},iso);
    return queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[current.id])!;
  });
}

export function recordTransientFailure(input:{runId:string; leaseOwner:string; leaseEpoch:number; eventKey:string; code:string; detail?:string},now=new Date()):ExecutionRun {
  return transaction(()=>{
    const current=queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[input.runId]);
    if(!current) throw new Error('Execution run not found');
    if(current.lease_owner!==input.leaseOwner || current.lease_epoch!==input.leaseEpoch) throw new StaleLeaseError('Stale lease owner or epoch');
    if(!event(current.id,current.task_id,input.eventKey,'transient_failure',current.lease_epoch,{code:input.code,detail:input.detail},now.toISOString())) return current;
    const retryCount=current.retry_count+1; const exhausted=retryCount>MAX_TRANSIENT_RETRIES;
    const retryAt=new Date(now.getTime()+RETRY_BASE_MS*Math.pow(2,Math.max(0,retryCount-1))).toISOString();
    run(`UPDATE task_execution_runs SET retry_count=?, last_failure_code=?, last_failure_detail=?,
      recovery_not_before=?, state=?, oracle_status=CASE WHEN ? THEN 'pending' ELSE oracle_status END, updated_at=? WHERE id=?`,
      [retryCount,input.code,input.detail||null,exhausted?null:retryAt,exhausted?'stalled':'recovering',exhausted?1:0,now.toISOString(),current.id]);
    activity(current.task_id,current.agent_id,exhausted?'execution_stalled':'execution_retry',exhausted?'Bounded retry policy exhausted; Oracle recovery required':`Transient failure scheduled for retry ${retryCount}/${MAX_TRANSIENT_RETRIES}`,{runId:current.id,code:input.code,retryAt:exhausted?null:retryAt},now.toISOString());
    return queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[current.id])!;
  });
}

export function acknowledgeOracle(runId:string,oracleAgentId:string,note:string,now=new Date()):ExecutionRun {
  return transaction(()=>{
    const current=queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[runId]);
    if(!current) throw new Error('Execution run not found');
    if(current.oracle_status!=='pending') throw new ExecutionConflictError('Oracle escalation is not pending');
    const iso=now.toISOString();
    run(`UPDATE task_execution_runs SET oracle_status='acknowledged',updated_at=? WHERE id=?`,[iso,runId]);
    event(runId,current.task_id,`oracle-ack:${current.lease_epoch}`,'oracle_acknowledged',current.lease_epoch,{oracleAgentId,note},iso);
    activity(current.task_id,oracleAgentId,'oracle_acknowledged','Oracle acknowledged stalled execution',{runId,note},iso);
    return queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[runId])!;
  });
}

export function reassignExecution(runId:string,oracleAgentId:string,newAgentId:string,newSessionKey:string,reason:string,now=new Date()):ExecutionRun {
  return transaction(()=>{
    const current=queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[runId]);
    if(!current) throw new Error('Execution run not found');
    if(current.state!=='stalled'||!['pending','acknowledged'].includes(current.oracle_status)) throw new ExecutionConflictError('Only an Oracle-owned stalled run can be reassigned');
    const agent=queryOne<{id:string}>('SELECT id FROM agents WHERE id=?',[newAgentId]);
    if(!agent) throw new Error('Replacement agent not found');
    const iso=now.toISOString(); const epoch=current.lease_epoch+1; const owner=`reassignment:${randomUUID()}`; const expires=new Date(now.getTime()+LEASE_TTL_MS).toISOString();
    run(`UPDATE task_execution_runs SET agent_id=?,session_key=?,state='recovering',lease_owner=?,lease_epoch=?,lease_expires_at=?,oracle_status='resolved',updated_at=? WHERE id=?`,[newAgentId,newSessionKey,owner,epoch,expires,iso,runId]);
    run(`UPDATE tasks SET assigned_agent_id=?,status='in_progress',updated_at=? WHERE id=?`,[newAgentId,iso,current.task_id]);
    event(runId,current.task_id,`reassigned:${epoch}`,'execution_reassigned',epoch,{oracleAgentId,fromAgentId:current.agent_id,toAgentId:newAgentId,reason},iso);
    activity(current.task_id,oracleAgentId,'execution_reassigned','Oracle reassigned stalled execution',{runId,fromAgentId:current.agent_id,toAgentId:newAgentId,reason,epoch},iso);
    return queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE id=?',[runId])!;
  });
}

export interface RecoveryAction { kind:'resume'|'oracle'; run:ExecutionRun; reason:string; recoveryKey:string }

export function markRecoveryDelivered(action:RecoveryAction,now=new Date()):void {
  transaction(()=>{
    const iso=now.toISOString();
    if(event(action.run.id,action.run.task_id,`delivered:${action.recoveryKey}`,'recovery_delivery_succeeded',action.run.lease_epoch,{kind:action.kind},iso))
      activity(action.run.task_id,action.run.agent_id,'execution_recovery_delivered',`${action.kind==='resume'?'Automatic resume':'Oracle escalation'} delivered`,{runId:action.run.id,recoveryKey:action.recoveryKey},iso);
  });
}

export function markRecoveryDeliveryFailed(action:RecoveryAction,error:unknown,now=new Date()):void {
  transaction(()=>{
    const iso=now.toISOString(); const detail=error instanceof Error?error.message:String(error);
    event(action.run.id,action.run.task_id,`delivery-failed:${action.recoveryKey}:${randomUUID()}`,'recovery_delivery_failed',action.run.lease_epoch,{kind:action.kind,detail},iso);
    activity(action.run.task_id,action.run.agent_id,'execution_recovery_delivery_failed',`${action.kind==='resume'?'Automatic resume':'Oracle escalation'} delivery failed`,{runId:action.run.id,recoveryKey:action.recoveryKey,detail},iso);
  });
}

export function reconcileExecutions(now=new Date()): RecoveryAction[] {
  return transaction(()=>{
    const iso=now.toISOString();
    const missing=queryAll<{task_id:string;agent_id:string;session_id:string|null;session_key_prefix:string|null;gateway_agent_id:string|null}>(`SELECT t.id AS task_id,t.assigned_agent_id AS agent_id,os.openclaw_session_id AS session_id,a.session_key_prefix,a.gateway_agent_id
      FROM tasks t JOIN agents a ON a.id=t.assigned_agent_id
      LEFT JOIN openclaw_sessions os ON os.agent_id=t.assigned_agent_id AND os.status='active'
      LEFT JOIN task_execution_runs r ON r.task_id=t.id AND r.state IN ('running','waiting_input','blocked','stalled','recovering')
      WHERE t.status='in_progress' AND r.id IS NULL`);
    for(const item of missing){
      const id=randomUUID(); const sessionKey=`${item.session_key_prefix||`agent:${item.gateway_agent_id||'unknown'}:`}${item.session_id||'mission-control-recovery'}`;
      run(`INSERT INTO task_execution_runs(id,task_id,agent_id,session_key,run_identity,state,lease_epoch,oracle_status,created_at,updated_at)
        VALUES(?,?,?,?,?,'stalled',0,'pending',?,?)`,[id,item.task_id,item.agent_id,sessionKey,`legacy:${item.task_id}`,iso,iso]);
      event(id,item.task_id,'missing-lease','execution_stalled',0,{reason:'in_progress task has no execution lease'},iso);
      event(id,item.task_id,'oracle:0','oracle_escalation_requested',0,{reason:'missing execution lease; automatic resume is unsafe without checkpoint ownership'},iso);
      activity(item.task_id,item.agent_id,'execution_stalled','Execution is unhealthy: in_progress task has no durable lease',{runId:id,reason:'missing execution lease'},iso);
    }
    const pending=queryAll<ExecutionRun & {scheduled_type:string;scheduled_epoch:number}>(`SELECT r.*,e.event_type AS scheduled_type,e.lease_epoch AS scheduled_epoch
      FROM task_execution_runs r JOIN task_execution_events e ON e.run_id=r.id
      LEFT JOIN task_execution_events d ON d.run_id=r.id AND d.event_key='delivered:' ||
        CASE WHEN e.event_type='automatic_resume_scheduled' THEN 'resume:' || r.id || ':' || e.lease_epoch ELSE 'oracle:' || r.id || ':' || e.lease_epoch END
      WHERE e.event_type IN ('automatic_resume_scheduled','oracle_escalation_requested') AND d.id IS NULL`);
    const actions:RecoveryAction[]=pending.map(item=>({kind:item.scheduled_type==='automatic_resume_scheduled'?'resume':'oracle',run:item,reason:'recovery delivery pending',recoveryKey:`${item.scheduled_type==='automatic_resume_scheduled'?'resume':'oracle'}:${item.id}:${item.scheduled_epoch}`}));
    const candidates=queryAll<ExecutionRun>(`SELECT r.* FROM task_execution_runs r JOIN tasks t ON t.id=r.task_id
      WHERE t.status='in_progress' AND r.state IN ('running','recovering')`);
    const nowMs=now.getTime();
    for(const item of candidates){
      const freshness=Math.max(Date.parse(item.heartbeat_at||'1970-01-01'),Date.parse(item.lease_expires_at||'1970-01-01')-LEASE_TTL_MS);
      const leaseValid=!!item.lease_expires_at && Date.parse(item.lease_expires_at)>nowMs;
      if(leaseValid && nowMs-freshness<=STALE_AFTER_MS) continue;
      const recoveryKey=`stale:${item.lease_epoch}`;
      if(!event(item.id,item.task_id,recoveryKey,'execution_stalled',item.lease_epoch,{leaseExpiresAt:item.lease_expires_at,heartbeatAt:item.heartbeat_at},iso)) continue;
      activity(item.task_id,item.agent_id,'execution_stalled','Execution is unhealthy: in_progress task has no valid recent lease',{runId:item.id,epoch:item.lease_epoch},iso);
      if(item.resume_count<MAX_AUTOMATIC_RESUMES){
        const epoch=item.lease_epoch+1; const owner=`recovery:${randomUUID()}`; const expires=new Date(nowMs+LEASE_TTL_MS).toISOString();
        run(`UPDATE task_execution_runs SET state='recovering', lease_owner=?, lease_epoch=?, lease_expires_at=?, resume_count=resume_count+1, updated_at=? WHERE id=?`,[owner,epoch,expires,iso,item.id]);
        event(item.id,item.task_id,`recovery:${epoch}`,'automatic_resume_scheduled',epoch,{previousEpoch:item.lease_epoch,checkpointAt:item.checkpoint_at},iso);
        activity(item.task_id,item.agent_id,'execution_recovery','Single automatic resume scheduled',{runId:item.id,epoch,resumeCount:item.resume_count+1},iso);
        actions.push({kind:'resume',run:{...item,state:'recovering',lease_owner:owner,lease_epoch:epoch,lease_expires_at:expires,resume_count:item.resume_count+1},reason:'lease expired or heartbeat stale',recoveryKey:`resume:${item.id}:${epoch}`});
      } else {
        run(`UPDATE task_execution_runs SET state='stalled', oracle_status='pending', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,[iso,item.id]);
        event(item.id,item.task_id,`oracle:${item.lease_epoch}`,'oracle_escalation_requested',item.lease_epoch,{reason:'automatic resume exhausted'},iso);
        activity(item.task_id,item.agent_id,'oracle_escalation','Automatic recovery exhausted; Oracle review/reassignment required',{runId:item.id,resumeCount:item.resume_count},iso);
        actions.push({kind:'oracle',run:{...item,state:'stalled',oracle_status:'pending'},reason:'automatic resume exhausted',recoveryKey:`oracle:${item.id}:${item.lease_epoch}`});
      }
    }
    return actions;
  });
}

export function getExecution(taskId:string):ExecutionRun|undefined {
  return queryOne<ExecutionRun>('SELECT * FROM task_execution_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 1',[taskId]);
}

export function getExecutionEvents(taskId:string){
  return queryAll<{id:string;run_id:string;event_key:string;event_type:string;lease_epoch:number|null;payload:string|null;created_at:string}>('SELECT id,run_id,event_key,event_type,lease_epoch,payload,created_at FROM task_execution_events WHERE task_id=? ORDER BY created_at ASC',[taskId]);
}
