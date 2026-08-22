import { createHash, randomUUID } from 'node:crypto';
import { getDb, queryAll, queryOne, run, transaction } from '@/lib/db';
import { evaluateCompletionContract } from '@/lib/completion-contract';
import { queueMattermostMilestone } from '@/lib/openclaw/mattermost-task-updates';

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export type ExceptionSeverity = 'P0' | 'P1' | 'P2';
interface ExceptionFact { task_id: string; workspace_id: string; type: string; authority_scope: string; severity: ExceptionSeverity; impact: string; recommendation: string; due_at: string | null; evidence: unknown }

export function projectTaskExceptions(workspaceId: string, now = new Date()) {
  const tasks = queryAll<any>('SELECT * FROM tasks WHERE workspace_id=? AND status<>\'done\' AND deleted_at IS NULL', [workspaceId]);
  const facts: ExceptionFact[] = [];
  for (const task of tasks) {
    if (task.status === 'blocked') facts.push({ task_id:task.id,workspace_id:workspaceId,type:'blocked',authority_scope:'operator',severity:'P1',impact:task.status_reason||'Task cannot advance.',recommendation:'Resolve or delegate the recorded blocker.',due_at:null,evidence:{status:task.status,status_reason:task.status_reason,updated_at:task.updated_at} });
    if (task.commitment_due_at && Date.parse(task.commitment_due_at) < now.getTime()) facts.push({ task_id:task.id,workspace_id:workspaceId,type:'overdue',authority_scope:'operator',severity:'P1',impact:`Commitment passed at ${task.commitment_due_at}.`,recommendation:'Recommit, delegate, or explicitly defer.',due_at:task.commitment_due_at,evidence:{commitment_due_at:task.commitment_due_at,status:task.status} });
    const decision = queryOne<any>(`SELECT id,reason,evidence,created_at FROM task_reconciliations WHERE task_id=? AND classification='decision_required' ORDER BY created_at DESC LIMIT 1`,[task.id]);
    if (decision) facts.push({ task_id:task.id,workspace_id:workspaceId,type:'decision_required',authority_scope:'ceo',severity:'P0',impact:decision.reason,recommendation:'Choose the required path so execution can resume.',due_at:null,evidence:{reconciliation_id:decision.id,evidence:decision.evidence,created_at:decision.created_at} });
  }
  return transaction(() => {
    const activeKeys = new Set<string>();
    for (const fact of facts) {
      const logical = `${fact.workspace_id}:${fact.task_id}:${fact.type}:${fact.authority_scope}`;
      activeKeys.add(logical);
      const fingerprint = digest({ logical, severity:fact.severity, impact:fact.impact, recommendation:fact.recommendation, due_at:fact.due_at, evidence:fact.evidence });
      const current = queryOne<any>(`SELECT * FROM task_exceptions WHERE workspace_id=? AND task_id=? AND type=? AND authority_scope=? AND is_current=1 AND status='open'`,[fact.workspace_id,fact.task_id,fact.type,fact.authority_scope]);
      if (current?.fingerprint === fingerprint) { run('UPDATE task_exceptions SET last_seen_at=? WHERE id=?',[now.toISOString(),current.id]); continue; }
      const version = (queryOne<{ value:number }>('SELECT COALESCE(MAX(decision_version),0)+1 AS value FROM task_exceptions WHERE workspace_id=? AND task_id=? AND type=? AND authority_scope=?',[fact.workspace_id,fact.task_id,fact.type,fact.authority_scope])?.value)||1;
      if (current) run('UPDATE task_exceptions SET is_current=0,status=\'superseded\',resolved_at=? WHERE id=?',[now.toISOString(),current.id]);
      const exceptionId=randomUUID();
      run(`INSERT INTO task_exceptions(id,workspace_id,task_id,type,authority_scope,decision_version,supersedes_id,is_current,severity,status,fingerprint,owner_agent_id,impact,evidence_json,recommendation,decision_schema,due_at,first_seen_at,last_seen_at)
        VALUES(?,?,?,?,?,?,?,1,?,'open',?,?,?,?,?,?,?, ?,?)`,[
        exceptionId,fact.workspace_id,fact.task_id,fact.type,fact.authority_scope,version,current?.id||null,fact.severity,fingerprint,null,fact.impact,JSON.stringify(fact.evidence),fact.recommendation,
        JSON.stringify({type:'object',properties:{note:{type:'string'}},additionalProperties:true}),fact.due_at,current?.first_seen_at||now.toISOString(),now.toISOString(),
      ]);
      if(['P0','P1'].includes(fact.severity))queueMattermostMilestone(fact.task_id,'task_exception',`${fact.impact}\n\nRecommendation: ${fact.recommendation}`,`exception:${exceptionId}`,now);
    }
    const currentRows = queryAll<any>(`SELECT * FROM task_exceptions WHERE workspace_id=? AND is_current=1 AND status='open'`,[workspaceId]);
    for (const row of currentRows) {
      const key=`${row.workspace_id}:${row.task_id}:${row.type}:${row.authority_scope}`;
      if (!activeKeys.has(key)) run("UPDATE task_exceptions SET status='resolved',is_current=0,resolved_at=?,last_seen_at=? WHERE id=?",[now.toISOString(),now.toISOString(),row.id]);
    }
    return queryAll<any>(`SELECT e.*,t.title,t.status AS task_status FROM task_exceptions e JOIN tasks t ON t.id=e.task_id WHERE e.workspace_id=? AND e.is_current=1 AND e.status='open' ORDER BY CASE e.severity WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,e.first_seen_at`,[workspaceId]);
  });
}

export function actOnException(id:string,input:{actor_principal_id:string;idempotency_key:string;expected_decision_version:number;action:'decide'|'delegate'|'snooze'|'acknowledge';decision_value?:unknown},now=new Date()) {
  return transaction(()=>{
    const item=queryOne<any>('SELECT * FROM task_exceptions WHERE id=?',[id]);
    if(!item)throw new Error('Exception not found');
    if(!item.is_current||item.status!=='open'||item.decision_version!==input.expected_decision_version)throw new Error('Stale exception version');
    const existing=queryOne<any>('SELECT * FROM exception_actions WHERE workspace_id=? AND actor_principal_id=? AND idempotency_key=?',[item.workspace_id,input.actor_principal_id,input.idempotency_key]);
    if(existing)return existing;
    const action={id:randomUUID(),workspace_id:item.workspace_id,exception_id:id,actor_principal_id:input.actor_principal_id,idempotency_key:input.idempotency_key,expected_decision_version:input.expected_decision_version,action:input.action,decision_value:JSON.stringify(input.decision_value??null),created_at:now.toISOString()};
    run('INSERT INTO exception_actions(id,workspace_id,exception_id,actor_principal_id,idempotency_key,expected_decision_version,action,decision_value,created_at) VALUES(?,?,?,?,?,?,?,?,?)',Object.values(action));
    if(['decide','delegate'].includes(input.action))run("UPDATE task_exceptions SET status='resolved',is_current=0,resolved_at=? WHERE id=?",[now.toISOString(),id]);
    return action;
  });
}

export function invalidateCompletionReview(taskId:string,now=new Date()) {
  transaction(()=>{
    const current=queryOne<{current_completion_review_id:string|null}>('SELECT current_completion_review_id FROM tasks WHERE id=?',[taskId]);
    if(current?.current_completion_review_id)run('UPDATE completion_reviews SET current_synthesis_id=NULL WHERE id=?',[current.current_completion_review_id]);
    run('UPDATE tasks SET evidence_version=evidence_version+1,current_completion_review_id=NULL,updated_at=? WHERE id=?',[now.toISOString(),taskId]);
  });
}

export function reviewCompletion(taskId:string,expectedEvidenceVersion:number,now=new Date()) {
  return transaction(()=>{
    const task=queryOne<any>('SELECT * FROM tasks WHERE id=?',[taskId]);
    if(!task)throw new Error('Task not found');
    if(task.evidence_version!==expectedEvidenceVersion)throw new Error('Evidence version changed');
    const contract=evaluateCompletionContract(taskId,now) as any;
    const criteria=queryAll<any>('SELECT id,description,status,evidence,verified_at FROM task_acceptance_criteria WHERE task_id=? ORDER BY sort_order,id',[taskId]);
    const boundaries=queryAll<any>('SELECT id,description,status,evidence,verified_at FROM task_protected_boundaries WHERE task_id=? ORDER BY sort_order,id',[taskId]);
    const deliverables=queryAll<any>('SELECT id,deliverable_type,title,path,description,created_at FROM task_deliverables WHERE task_id=? ORDER BY created_at,id',[taskId]);
    const report=queryOne<any>('SELECT * FROM task_completion_reports WHERE task_id=?',[taskId])||null;
    const evidence={schema_version:'1',workspace_id:task.workspace_id,task_id:task.id,evidence_version:task.evidence_version,brief:task.brief||task.description||'',criteria,boundaries,deliverables,report};
    const evidenceDigest=digest(evidence),reviewedAsOf=now.toISOString();
    const maxAge=(queryOne<{verification_max_age_minutes:number}>('SELECT verification_max_age_minutes FROM task_completion_contracts WHERE task_id=?',[taskId])?.verification_max_age_minutes)||1440;
    const ranAt=report?.verification_ran_at?Date.parse(report.verification_ran_at):Number.NaN;
    const boundaryEpoch=Number.isFinite(ranAt)?Math.floor((ranAt+maxAge*60_000)/1000):253402300799;
    const boundaryAt=new Date(boundaryEpoch*1000).toISOString();
    const freshnessBucket=digest({freshness_policy_version:'1',expired:boundaryEpoch<=Math.floor(now.getTime()/1000),freshness_boundary_at:boundaryAt});
    const existing=queryOne<any>('SELECT * FROM completion_reviews WHERE workspace_id=? AND task_id=? AND evidence_digest=? AND freshness_bucket=?',[task.workspace_id,taskId,evidenceDigest,freshnessBucket]);
    if(existing)return hydrateReview(existing);
    const verdict=contract.ready?'pass':'rework',findings=contract.reasons||[];
    const reviewId=randomUUID();
    run(`INSERT INTO completion_reviews(id,workspace_id,task_id,evidence_version,evidence_digest,freshness_policy_version,freshness_boundary_at,freshness_boundary_epoch,freshness_bucket,reviewed_as_of,verdict,findings_json,reviewed_at,reviewer_version)
      VALUES(?,?,?,?,?,'1',?,?,?,?,?,?,?,'deterministic-v1')`,[reviewId,task.workspace_id,taskId,task.evidence_version,evidenceDigest,boundaryAt,boundaryEpoch,freshnessBucket,reviewedAsOf,verdict,JSON.stringify(findings),reviewedAsOf]);
    if(verdict==='pass'){
      const evidenceIds=[...criteria.map(row=>row.id),...boundaries.map(row=>row.id),...deliverables.map(row=>row.id)];
      const content={objective_outcome:{text:report?.plan_vs_actual||'Completion contract satisfied.',evidence_ids:evidenceIds.slice(0,5)},delivered:deliverables.map(row=>({text:row.title,evidence_ids:[row.id]})),impact:[],risks:(JSON.parse(report?.deviations||'[]') as string[]).map(text=>({text,evidence_ids:criteria.slice(0,1).map(row=>row.id)})),decisions_required:[],deferred_work:(JSON.parse(report?.deferred_work||'[]') as string[]).map(text=>({text,evidence_ids:criteria.slice(0,1).map(row=>row.id)})),verification:(JSON.parse(report?.verification_commands||'[]') as any[]).map((command,index)=>({text:`${command.command}: ${command.output_summary}`,evidence_ids:[`verification:${index}`]})),evidence_links:deliverables.map(row=>({evidence_id:row.id,path:row.path||null}))};
      const promptHash=digest({schema:'executive-synthesis-v1'}),generationKey=digest(`deterministic-v1${promptHash}`),synthesisId=randomUUID();
      run(`INSERT INTO executive_syntheses(id,review_id,schema_version,generation_key,content_json,model_identity,prompt_hash,created_at) VALUES(?,?,'1',?,?,'deterministic-v1',?,?)`,[synthesisId,reviewId,generationKey,JSON.stringify(content),promptHash,reviewedAsOf]);
      run('UPDATE completion_reviews SET current_synthesis_id=? WHERE id=?',[synthesisId,reviewId]);
      queueMattermostMilestone(taskId,'executive_synthesis',`${content.objective_outcome.text}\n\nDelivered: ${content.delivered.map((item:any)=>item.text).join(', ')||'Verified completion contract.'}`,`synthesis:${synthesisId}`,now);
    }else{
      queueMattermostMilestone(taskId,'completion_rework',findings.map((finding:string)=>`- ${finding}`).join('\n'),`completion-rework:${reviewId}`,now);
    }
    const currency=run('UPDATE tasks SET current_completion_review_id=? WHERE id=? AND evidence_version=? AND unixepoch()<?',[reviewId,taskId,expectedEvidenceVersion,boundaryEpoch]);
    return {...hydrateReview(queryOne<any>('SELECT * FROM completion_reviews WHERE id=?',[reviewId])!),current:Boolean(currency.changes)};
  });
}

function hydrateReview(review:any){return{...review,findings:JSON.parse(review.findings_json||'[]'),synthesis:review.current_synthesis_id?queryOne<any>('SELECT * FROM executive_syntheses WHERE id=?',[review.current_synthesis_id]):null};}
export function getExecutiveSynthesis(taskId:string){const review=queryOne<any>('SELECT r.* FROM tasks t JOIN completion_reviews r ON r.id=t.current_completion_review_id WHERE t.id=?',[taskId]);return review?hydrateReview(review):null;}

let operatingTimer:ReturnType<typeof setInterval>|null=null;
export function startOperatingFeatures(){if(operatingTimer)return;const scan=()=>{for(const workspace of queryAll<{id:string}>('SELECT id FROM workspaces')){try{projectTaskExceptions(workspace.id);}catch(error){console.error('[OperatingFeatures] exception projection failed',error);}}};scan();operatingTimer=setInterval(scan,60_000);operatingTimer.unref?.();}
export function stopOperatingFeatures(){if(operatingTimer)clearInterval(operatingTimer);operatingTimer=null;}
