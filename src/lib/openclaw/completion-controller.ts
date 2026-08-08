import { createHash, randomUUID } from 'crypto';
import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { dispatchTaskToGateway } from './dispatch';
import { getOpenClawClient } from './client';
import { releaseReadyDependentTasks } from '@/lib/task-dependencies';
import { drainMattermostOutbox,queueMattermostMilestone } from './mattermost-task-updates';

export const CONTROLLER_INTERVAL_MS=90_000;
const LEASE_MS=75_000;
const MAX_ACTION_ATTEMPTS=2;
const ACTION_LEASE_MS=60_000;

function activeActionAllowlist(){
  return new Set((process.env.MISSION_CONTROL_COMPLETION_ACTIONS||'dispatch,request_verification')
    .split(',').map(value=>value.trim()).filter(Boolean));
}

export type CompletionClassification='healthy_running'|'awaiting_dependency'|'awaiting_agent'|'awaiting_verification'|'awaiting_human_authority'|'blocked'|'failed'|'stalled'|'abandoned'|'ready_to_close';
type Authority='specialist'|'verifier'|'oracle'|'tank'|'michael'|'controller';
interface TaskRow{ id:string;title:string;status:string;brief:string|null;status_reason:string|null;assigned_agent_id:string|null;workflow_template_id:string|null;updated_at:string; }
export interface Decision{taskId:string;classification:CompletionClassification;reason:string;action?:string;authority:Authority;evidence:Record<string,unknown>;fingerprint:string}

export function buildAuthoritySessionKey(agent:{name:string;session_key_prefix:string|null;gateway_agent_id:string|null},sessionId?:string|null){
  const prefix=agent.session_key_prefix||`agent:${agent.gateway_agent_id||agent.name.toLowerCase()}:`;
  return `${prefix}${sessionId||'main'}`;
}

export function actionRequiresResolution(authority:Authority){return authority==='oracle'}
export function isSupersededDispatchError(decision:Decision,message:string){return decision.action==='dispatch'&&/Task state .* cannot execute/i.test(message)}

function stable(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24)}

function acquire(owner:string,now:Date){
  const expires=new Date(now.getTime()+LEASE_MS).toISOString();
  return transaction(()=>{
    const current=queryOne<{owner_id:string;lease_expires_at:string}>('SELECT owner_id,lease_expires_at FROM completion_controller_lease WHERE singleton=1');
    if(current&&Date.parse(current.lease_expires_at)>now.getTime())return false;
    run(`INSERT INTO completion_controller_lease(singleton,owner_id,lease_expires_at,epoch,updated_at) VALUES(1,?,?,1,?)
      ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,lease_expires_at=excluded.lease_expires_at,epoch=completion_controller_lease.epoch+1,updated_at=excluded.updated_at
      WHERE completion_controller_lease.lease_expires_at<=excluded.updated_at`,[owner,expires,now.toISOString()]);
    return queryOne<{owner_id:string}>('SELECT owner_id FROM completion_controller_lease WHERE singleton=1')?.owner_id===owner;
  });
}

export function classifyTask(task:TaskRow,now=new Date()):Decision{
  const dependencies=queryAll<{status:string}>('SELECT prerequisite.status FROM task_dependencies d JOIN tasks prerequisite ON prerequisite.id=d.depends_on_task_id WHERE d.task_id=?',[task.id]);
  const execution=queryOne<{state:string;lease_expires_at:string|null;heartbeat_at:string|null;oracle_status:string;updated_at:string}>('SELECT state,lease_expires_at,heartbeat_at,oracle_status,updated_at FROM task_execution_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 1',[task.id]);
  const deliverables=queryOne<{count:number}>('SELECT COUNT(*) AS count FROM task_deliverables WHERE task_id=?',[task.id])?.count||0;
  const completionEvidence=queryOne<{count:number}>("SELECT COUNT(*) AS count FROM task_activities WHERE task_id=? AND activity_type='completed'",[task.id])?.count||0;
  const objectiveEvidence=queryOne<{count:number}>("SELECT COUNT(*) AS count FROM task_activities WHERE task_id=? AND activity_type IN ('verification_passed','completion_contract_passed','test_passed')",[task.id])?.count||0;
  const latestVerification=queryOne<{activity_type:string;message:string}>("SELECT activity_type,message FROM task_activities WHERE task_id=? AND activity_type IN ('verification_failed','verification_passed','completion_contract_passed','test_passed') ORDER BY created_at DESC,id DESC LIMIT 1",[task.id]);
  const independentVerifier=queryOne<{agent_id:string;role:string}>("SELECT agent_id,role FROM task_roles WHERE task_id=? AND role IN ('tester','reviewer','verifier') AND agent_id!=COALESCE(?, '') LIMIT 1",[task.id,task.assigned_agent_id]);
  const ageMs=now.getTime()-Date.parse(task.updated_at);
  let classification:CompletionClassification,reason:string,action:string|undefined,authority:Authority='controller';
  if(dependencies.some(dep=>dep.status!=='done')){classification='awaiting_dependency';reason='One or more prerequisite tasks are non-terminal';}
  else if(task.status==='in_progress'&&execution?.state==='stalled'&&['acknowledged','resolved'].includes(execution.oracle_status)&&Date.parse(task.updated_at)>Date.parse(execution.updated_at)){classification='awaiting_agent';reason='Task was explicitly reactivated after its prior stall was acknowledged; fresh durable dispatch required';action='dispatch';authority='controller';}
  else if(task.status==='in_progress'&&(execution?.state==='stalled'||!execution||!execution.lease_expires_at||Date.parse(execution.lease_expires_at)<=now.getTime())){classification='stalled';reason='Execution supervision owns stale-run recovery';authority='oracle';}
  else if(task.status==='in_progress'&&execution&&execution.lease_expires_at&&Date.parse(execution.lease_expires_at)>now.getTime()){classification='healthy_running';reason='Valid fenced execution lease; no controller action';authority='specialist';}
  else if(task.status==='assigned'&&!execution){classification='awaiting_agent';reason='Assigned task has not been dispatched through durable execution';action='dispatch';authority='controller';}
  else if(task.status==='pending_dispatch'){classification='awaiting_agent';reason='Task is ready for assignment or dispatch';action=task.assigned_agent_id?'dispatch':'oracle_assignment';authority=task.assigned_agent_id?'controller':'oracle';}
  else if(task.status==='inbox'){classification='awaiting_agent';reason='Inbox task requires explicit release before dispatch';authority='oracle';}
  else if(task.status==='blocked'&&/michael|approval|authority|spend|production/i.test(task.status_reason||task.brief||'')){classification='awaiting_human_authority';reason='Explicit Michael-only authority gate';action='escalate_michael';authority='michael';}
  else if(task.status==='blocked'){classification='blocked';reason=task.status_reason||'Task is intentionally blocked';action='oracle_review';authority='oracle';}
  else if(['testing','verification','review'].includes(task.status)&&latestVerification?.activity_type==='verification_failed'){classification='failed';reason=`Verification failed: ${latestVerification.message}`;action='return_rework';authority='specialist';}
  else if(['testing','verification','review'].includes(task.status)&&independentVerifier&&objectiveEvidence===0){classification='awaiting_verification';reason=`Independent ${independentVerifier.role} is required by task roles`;action='request_verification';authority='verifier';}
  else if(['testing','verification','review'].includes(task.status)&&deliverables>0&&completionEvidence>0&&objectiveEvidence>0){classification='ready_to_close';reason='Objective completion contract, completion activity, and deliverable evidence all exist';action='close';authority='controller';}
  else if(['testing','verification','review'].includes(task.status)){classification='awaiting_verification';reason='Completion contract lacks deliverable or completion evidence';action='oracle_review';authority='oracle';}
  else if(ageMs>7*24*3600_000&&!task.assigned_agent_id){classification='abandoned';reason='Unowned non-terminal task has not changed for seven days';action='oracle_review';authority='oracle';}
  else {classification='awaiting_agent';reason='No valid automatic transition is available';action='oracle_review';authority='oracle';}
  const evidence={status:task.status,executionState:execution?.state||null,leaseExpiresAt:execution?.lease_expires_at||null,deliverables,completionEvidence,objectiveEvidence,dependencies:dependencies.length,independentVerifier:independentVerifier?.agent_id||null,updatedAt:task.updated_at};
  return{taskId:task.id,classification,reason,action,authority,evidence,fingerprint:stable({classification,reason,action,authority,evidence})};
}

async function deliverAuthorityAction(decision:Decision,actionId:string){
  const task=queryOne<TaskRow & {mattermost_channel_id:string|null;mattermost_root_post_id:string|null;mattermost_thread_url:string|null}>('SELECT id,title,status,brief,status_reason,assigned_agent_id,workflow_template_id,updated_at,mattermost_channel_id,mattermost_root_post_id,mattermost_thread_url FROM tasks WHERE id=?',[decision.taskId]);
  if(!task)throw new Error('Task not found for controller delivery');
  let agent=queryOne<{id:string;name:string;session_key_prefix:string|null;gateway_agent_id:string|null}>('SELECT id,name,session_key_prefix,gateway_agent_id FROM agents WHERE lower(name)=? LIMIT 1',[decision.authority==='tank'?'tank':decision.authority==='oracle'?'oracle':'']);
  if(decision.authority==='specialist')agent=queryOne<{id:string;name:string;session_key_prefix:string|null;gateway_agent_id:string|null}>('SELECT id,name,session_key_prefix,gateway_agent_id FROM agents WHERE id=? LIMIT 1',[task.assigned_agent_id]);
  if(decision.authority==='verifier')agent=queryOne<{id:string;name:string;session_key_prefix:string|null;gateway_agent_id:string|null}>("SELECT a.id,a.name,a.session_key_prefix,a.gateway_agent_id FROM task_roles r JOIN agents a ON a.id=r.agent_id WHERE r.task_id=? AND r.role IN ('tester','reviewer','verifier') AND a.id!=COALESCE(?, '') LIMIT 1",[decision.taskId,task.assigned_agent_id]);
  if(decision.authority==='michael')agent=queryOne<{id:string;name:string;session_key_prefix:string|null;gateway_agent_id:string|null}>("SELECT id,name,session_key_prefix,gateway_agent_id FROM agents WHERE is_master=1 OR lower(name)='switch' ORDER BY is_master DESC LIMIT 1");
  if(!agent)throw new Error(`No delivery owner configured for ${decision.authority}`);
  const session=queryOne<{openclaw_session_id:string}>('SELECT openclaw_session_id FROM openclaw_sessions WHERE agent_id=? AND status=? ORDER BY updated_at DESC LIMIT 1',[agent.id,'active']);
  const sessionKey=buildAuthoritySessionKey(agent,session?.openclaw_session_id);
  const thread=decision.authority==='michael'&&task.mattermost_root_post_id?` Deliver the decision request in Mattermost channel ${task.mattermost_channel_id||'(originating channel)'}, replying to root post ${task.mattermost_root_post_id}${task.mattermost_thread_url?` (${task.mattermost_thread_url})`:''}; never create a top-level message.`:'';
  const client=getOpenClawClient();if(!client.isConnected())await client.connect();
  const resolution=decision.authority==='oracle'?` Review the task brief, completion notes, and every linked deliverable. Resolve action ${actionId} through PATCH /api/oracle/completion-controller/${actionId} with resolution passed, rework, or cancelled and a specific evidence-based note. Process only this action; Mission Control will release the next review after resolution.`:' Resolve through Mission Control with evidence; do not create duplicate work.';
  await client.call('chat.send',{sessionKey,idempotencyKey:`completion-controller-${actionId}`,message:`Mission Control completion action ${actionId} for task ${task.id} (${task.title}). Classification: ${decision.classification}. Required action: ${decision.action}. Reason: ${decision.reason}.${thread}${resolution}`});
}

export function hasUnresolvedAuthorityAction(authority:Authority,excludeActionId?:string){
  return Boolean(queryOne<{id:string}>(`SELECT id FROM completion_controller_actions
    WHERE authority=? AND delivered_at IS NOT NULL AND resolution_status IS NULL
      AND (? IS NULL OR id!=?) LIMIT 1`,[authority,excludeActionId||null,excludeActionId||null]));
}

async function executeAction(decision:Decision,actionId:string,owner:string,now:Date){
  const external=!['dispatch','close'].includes(decision.action||'');
  const requiresResolution=actionRequiresResolution(decision.authority);
  if(requiresResolution&&hasUnresolvedAuthorityAction(decision.authority,actionId))return false;
  const claimed=run(`UPDATE completion_controller_actions SET state='executing',claim_owner=?,claim_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='pending' AND attempts<? AND (not_before IS NULL OR not_before<=?)`,[owner,new Date(now.getTime()+ACTION_LEASE_MS).toISOString(),now.toISOString(),actionId,MAX_ACTION_ATTEMPTS,now.toISOString()]);
  if(!claimed.changes)return false;
  try{
    if(decision.action==='dispatch'){
      const result=await dispatchTaskToGateway(decision.taskId); if(!result.success)throw new Error(result.error||'Dispatch failed');
      queueMattermostMilestone(decision.taskId,'dispatched','The assigned specialist has been dispatched through the durable execution path.',`controller:${actionId}:dispatched`,now);
    }else if(decision.action==='close'){
      run("UPDATE tasks SET status='done',updated_at=? WHERE id=? AND status IN ('review','verification','testing')",[now.toISOString(),decision.taskId]);
      releaseReadyDependentTasks(decision.taskId);
      queueMattermostMilestone(decision.taskId,'completed','Objective completion evidence passed and Mission Control closed the task. Deliverables remain attached to the task record.',`controller:${actionId}:completed`,now);
    }else{
      await deliverAuthorityAction(decision,actionId);
      if(decision.action==='return_rework'){
        run("UPDATE tasks SET status='pending_dispatch',status_reason=?,updated_at=? WHERE id=? AND status IN ('review','verification','testing')",[`Rework required: ${decision.reason}`,now.toISOString(),decision.taskId]);
        run(`INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,metadata,created_at) VALUES(?,?,NULL,'status_changed',?,?,?)`,[randomUUID(),decision.taskId,'Queued specialist rework for automatic durable dispatch',JSON.stringify({controllerActionId:actionId,from:decision.evidence.status,to:'pending_dispatch'}),now.toISOString()]);
      }
      const milestone=decision.action==='request_verification'?'verification':decision.action==='return_rework'?'rework':decision.authority==='michael'?'decision':decision.classification==='blocked'?'blocked':decision.classification==='failed'?'failed':null;
      if(milestone)queueMattermostMilestone(decision.taskId,milestone,'Mission Control recorded this material workflow transition. Further updates will be posted only when the state changes.',`controller:${actionId}:${milestone}`,now);
    }
    run("UPDATE completion_controller_actions SET state='completed',completed_at=?,delivered_at=CASE WHEN ? THEN ? ELSE delivered_at END,resolution_status=CASE WHEN ? THEN resolution_status WHEN ? THEN 'delivery_complete' ELSE resolution_status END,resolved_at=CASE WHEN ? THEN resolved_at WHEN ? THEN ? ELSE resolved_at END,claim_owner=NULL,claim_expires_at=NULL,updated_at=? WHERE id=? AND claim_owner=?",[now.toISOString(),external?1:0,now.toISOString(),requiresResolution?1:0,external?1:0,requiresResolution?1:0,external?1:0,now.toISOString(),now.toISOString(),actionId,owner]);
    run(`INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,metadata,created_at) VALUES(?,?,NULL,'completion_action_delivered',?,?,?)`,[randomUUID(),decision.taskId,`Completion action delivered to ${decision.authority}`,JSON.stringify({controllerActionId:actionId,action:decision.action,authority:decision.authority}),now.toISOString()]);
    return true;
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    if(isSupersededDispatchError(decision,message)){
      run("UPDATE completion_controller_actions SET state='cancelled',resolution_status='superseded_state',resolution_note=?,resolved_at=?,last_error=NULL,claim_owner=NULL,claim_expires_at=NULL,updated_at=? WHERE id=? AND claim_owner=?",[message,now.toISOString(),now.toISOString(),actionId,owner]);
      return true;
    }
    run(`UPDATE completion_controller_actions SET state=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,last_error=?,not_before=?,claim_owner=NULL,claim_expires_at=NULL,updated_at=? WHERE id=? AND claim_owner=?`,[MAX_ACTION_ATTEMPTS,message,new Date(now.getTime()+60_000).toISOString(),now.toISOString(),actionId,owner]);
    return false;
  }
}

async function drainOutbox(owner:string,now:Date){
  run("UPDATE completion_controller_actions SET state='pending',claim_owner=NULL,claim_expires_at=NULL WHERE state='executing' AND claim_expires_at<=?",[now.toISOString()]);
  const allowed=Array.from(activeActionAllowlist());
  if(allowed.length===0)return 0;
  const placeholders=allowed.map(()=>'?').join(',');
  const queued=queryAll<{id:string;payload:string}>(`SELECT id,payload FROM completion_controller_actions WHERE state='pending' AND action_type IN (${placeholders}) AND attempts<? AND (not_before IS NULL OR not_before<=?) ORDER BY created_at`,[...allowed,MAX_ACTION_ATTEMPTS,now.toISOString()]);
  let errors=0;for(const item of queued){const decision=JSON.parse(item.payload) as Decision;if(actionRequiresResolution(decision.authority)&&hasUnresolvedAuthorityAction(decision.authority,item.id))continue;const ok=await executeAction(decision,item.id,owner,now);if(!ok)errors++;}return errors;
}

export async function runCompletionScan(mode:'dry_run'|'active'='dry_run',now=new Date()){
  const owner=randomUUID(); if(!acquire(owner,now))return{status:'leased' as const};
  const scanId=randomUUID(); const tasks=queryAll<TaskRow>("SELECT id,title,status,brief,status_reason,assigned_agent_id,workflow_template_id,updated_at FROM tasks WHERE status!='done' ORDER BY updated_at");
  run('INSERT INTO completion_controller_scans(id,mode,owner_id,started_at) VALUES(?,?,?,?)',[scanId,mode,owner,now.toISOString()]);
  let actionable=0,errors=0; const decisions:Decision[]=[];
  for(const task of tasks){
    const decision=classifyTask(task,now);decisions.push(decision);if(decision.action)actionable++;
    run(`INSERT INTO task_reconciliations(id,scan_id,task_id,classification,fingerprint,proposed_action,reason,evidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,[randomUUID(),scanId,task.id,decision.classification,decision.fingerprint,decision.action||null,decision.reason,JSON.stringify(decision.evidence),now.toISOString()]);
    if(!decision.action)continue;
    const actionKey=`${task.id}:${decision.action}:${decision.fingerprint}`; const actionId=randomUUID();
    const actionEnabled=mode==='active'&&activeActionAllowlist().has(decision.action);
    run(`INSERT INTO completion_controller_actions(id,task_id,action_key,action_type,authority,state,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(action_key) DO UPDATE SET state=CASE WHEN completion_controller_actions.state='proposed' AND excluded.state='pending' THEN 'pending' ELSE completion_controller_actions.state END,payload=excluded.payload,updated_at=excluded.updated_at`,[actionId,task.id,actionKey,decision.action,decision.authority,actionEnabled?'pending':'proposed',JSON.stringify(decision),now.toISOString(),now.toISOString()]);
  }
  if(mode==='active'){
    errors+=await drainOutbox(owner,now);
    const messageResult=await drainMattermostOutbox(now);
    errors+=messageResult.failed;
  }
  const summary={byClassification:Object.fromEntries(Array.from(new Set(decisions.map(d=>d.classification))).map(key=>[key,decisions.filter(d=>d.classification===key).length])),actionable,errors};
  run('UPDATE completion_controller_scans SET completed_at=?,task_count=?,actionable_count=?,error_count=?,summary=? WHERE id=?',[new Date().toISOString(),tasks.length,actionable,errors,JSON.stringify(summary),scanId]);
  return{status:'completed' as const,scanId,mode,taskCount:tasks.length,decisions,summary};
}

export function getControllerQueue(){return queryAll(`SELECT a.*,t.title,t.status AS task_status FROM completion_controller_actions a JOIN tasks t ON t.id=a.task_id WHERE a.state IN ('proposed','pending','failed') OR (a.delivered_at IS NOT NULL AND a.resolution_status IS NULL) ORDER BY CASE WHEN a.delivered_at IS NOT NULL AND a.resolution_status IS NULL THEN 0 ELSE 1 END,CASE a.authority WHEN 'michael' THEN 0 WHEN 'oracle' THEN 1 WHEN 'tank' THEN 2 ELSE 3 END,a.created_at`)}

let interval:NodeJS.Timeout|null=null;
export function startCompletionController(){
  const mode=process.env.MISSION_CONTROL_COMPLETION_CONTROLLER;
  if(interval||!mode||mode==='disabled')return;
  const run=()=>void runCompletionScan(mode==='active'?'active':'dry_run').catch(error=>console.error('[CompletionController]',error));
  run();interval=setInterval(run,CONTROLLER_INTERVAL_MS);
  console.log(`[CompletionController] started in ${mode==='active'?'active':'dry_run'} mode`);
}
export function stopCompletionController(){if(interval)clearInterval(interval);interval=null;}
