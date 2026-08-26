import { createHash, randomUUID } from 'node:crypto';
import { queryOne, run, transaction } from './db';

export type ToolRisk='read'|'internal_write'|'external_action'|'destructive';
export type ToolFieldType='string'|'number'|'boolean'|'object';
export type ToolContract={name:string;version:number;risk:ToolRisk;requiredFields:readonly string[];fieldTypes:Readonly<Record<string,ToolFieldType>>;rateLimitCount:number;rateLimitWindowSeconds:number};
export type MemoryPlane='session_context'|'curated_fact'|'semantic_memory';

const canonical=(value:unknown):string=>{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
};
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const iso=(value:Date)=>value.toISOString();
const audit=(taskId:string|null,actorId:string,eventType:string,targetId:string|null,outcome:'allowed'|'denied'|'completed'|'failed',detail:unknown,now:Date)=>
  run('INSERT INTO agent_control_plane_audit_events(id,task_id,actor_id,event_type,target_id,outcome,detail_digest,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [randomUUID(),taskId,actorId,eventType,targetId,outcome,digest(detail),iso(now)]);

export function registerToolContract(contract:ToolContract,now=new Date()):void{
  if(!/^[a-z][a-z0-9_.-]{1,127}$/.test(contract.name)||!Number.isInteger(contract.version)||contract.version<1
    ||contract.requiredFields.some(field=>!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(field))
    ||Object.keys(contract.fieldTypes).some(field=>!contract.requiredFields.includes(field))
    ||contract.requiredFields.some(field=>!(field in contract.fieldTypes))
    ||!Number.isInteger(contract.rateLimitCount)||contract.rateLimitCount<1
    ||!Number.isInteger(contract.rateLimitWindowSeconds)||contract.rateLimitWindowSeconds<1)throw new Error('INVALID_TOOL_CONTRACT');
  run(`INSERT INTO agent_tool_contracts(name,version,risk,input_schema,rate_limit_count,rate_limit_window_seconds,created_at)
    VALUES(?,?,?,?,?,?,?)`,[contract.name,contract.version,contract.risk,JSON.stringify({required:contract.requiredFields,types:contract.fieldTypes,additionalProperties:false}),contract.rateLimitCount,contract.rateLimitWindowSeconds,iso(now)]);
}

export function grantTool(agentId:string,name:string,version:number,grantedBy:string,expiresAt:string|null,now=new Date()):void{
  run(`INSERT INTO agent_tool_grants(agent_id,contract_name,contract_version,granted_by,expires_at,created_at)
    VALUES(?,?,?,?,?,?)`,[agentId,name,version,grantedBy,expiresAt,iso(now)]);
}

export function requestToolInvocation(input:{taskId:string;runId:string;agentId:string;contractName:string;contractVersion:number;idempotencyKey:string;payload:Record<string,unknown>},now=new Date()){
  try{return transaction(()=>{
    const existing=queryOne<any>('SELECT * FROM agent_tool_invocations WHERE agent_id=? AND idempotency_key=?',[input.agentId,input.idempotencyKey]);
    if(existing){if(existing.input_digest!==digest(input.payload))throw new Error('IDEMPOTENCY_PAYLOAD_MISMATCH');return existing;}
    const contract=queryOne<any>('SELECT * FROM agent_tool_contracts WHERE name=? AND version=? AND enabled=1',[input.contractName,input.contractVersion]);
    if(!contract)throw new Error('TOOL_CONTRACT_NOT_FOUND');
    const ownership=queryOne<any>(`SELECT r.id FROM task_execution_runs r JOIN tasks t ON t.id=r.task_id
      WHERE r.id=? AND r.task_id=? AND r.agent_id=? AND t.assigned_agent_id=?
        AND r.state IN ('running','waiting_input','recovering')`,[input.runId,input.taskId,input.agentId,input.agentId]);
    if(!ownership)throw new Error('TOOL_EXECUTION_OWNERSHIP_MISMATCH');
    const grant=queryOne<any>(`SELECT * FROM agent_tool_grants WHERE agent_id=? AND contract_name=? AND contract_version=?
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,[input.agentId,input.contractName,input.contractVersion,iso(now)]);
    if(!grant)throw new Error('TOOL_PERMISSION_DENIED');
    const schema=JSON.parse(contract.input_schema) as {required:string[];types:Record<string,ToolFieldType>;additionalProperties:false};
    if(schema.required.some(field=>!(field in input.payload)))throw new Error('TOOL_INPUT_INVALID');
    if(Object.keys(input.payload).some(field=>!(field in schema.types))||Object.entries(schema.types).some(([field,type])=>{
      const value=input.payload[field];
      return type==='object'?(value===null||typeof value!=='object'||Array.isArray(value)):typeof value!==type;
    }))throw new Error('TOOL_INPUT_INVALID');
    const since=iso(new Date(now.getTime()-contract.rate_limit_window_seconds*1000));
    const count=queryOne<{total:number}>(`SELECT count(*) total FROM agent_tool_invocations
      WHERE agent_id=? AND contract_name=? AND contract_version=? AND created_at>=?`,[input.agentId,input.contractName,input.contractVersion,since])!.total;
    if(count>=contract.rate_limit_count)throw new Error('TOOL_RATE_LIMITED');
    const state=['external_action','destructive'].includes(contract.risk)?'pending_confirmation':'authorized';
    const id=randomUUID();
    run(`INSERT INTO agent_tool_invocations(id,task_id,run_id,agent_id,contract_name,contract_version,idempotency_key,input_digest,risk,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,[id,input.taskId,input.runId,input.agentId,input.contractName,input.contractVersion,input.idempotencyKey,digest(input.payload),contract.risk,state,iso(now),iso(now)]);
    const admitted=queryOne<any>('SELECT * FROM agent_tool_invocations WHERE id=?',[id])!;
    audit(input.taskId,input.agentId,'tool.invocation_requested',id,'allowed',{contract:input.contractName,version:input.contractVersion,state},now);
    return admitted;
  });}catch(error){
    audit(input.taskId,input.agentId,'tool.invocation_denied',null,'denied',{contract:input.contractName,version:input.contractVersion,code:error instanceof Error?error.message:'UNKNOWN'},now);
    throw error;
  }
}

export function confirmToolInvocation(id:string,actor:string,now=new Date()){
  try{return transaction(()=>{
    const invocation=queryOne<any>('SELECT * FROM agent_tool_invocations WHERE id=?',[id]);
    if(!invocation)throw new Error('TOOL_INVOCATION_NOT_FOUND');
    if(invocation.state==='authorized')return invocation;
    if(invocation.state!=='pending_confirmation')throw new Error('TOOL_CONFIRMATION_INVALID_STATE');
    if(actor===invocation.agent_id)throw new Error('TOOL_CONFIRMATION_SEPARATION_REQUIRED');
    const grant=queryOne<any>(`SELECT granted_by FROM agent_tool_grants WHERE agent_id=? AND contract_name=?
      AND contract_version=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,
      [invocation.agent_id,invocation.contract_name,invocation.contract_version,iso(now)]);
    if(!grant||grant.granted_by!==actor)throw new Error('TOOL_CONFIRMATION_AUTHORITY_REQUIRED');
    run(`UPDATE agent_tool_invocations SET state='authorized',confirmation_actor=?,confirmation_at=?,updated_at=? WHERE id=?`,[actor,iso(now),iso(now),id]);
    audit(invocation.task_id,actor,'tool.invocation_confirmed',id,'allowed',{risk:invocation.risk},now);
    return queryOne<any>('SELECT * FROM agent_tool_invocations WHERE id=?',[id])!;
  });}catch(error){audit(null,actor,'tool.confirmation_denied',id,'denied',{code:error instanceof Error?error.message:'UNKNOWN'},now);throw error;}
}

export function completeToolInvocation(id:string,result:unknown,now=new Date()):void{
  const resultDigest=digest(result);
  const current=queryOne<any>('SELECT state,result_digest FROM agent_tool_invocations WHERE id=?',[id]);
  if(current?.state==='completed'){
    if(current.result_digest!==resultDigest)throw new Error('TOOL_RESULT_MISMATCH');
    return;
  }
  const changed=run(`UPDATE agent_tool_invocations SET state='completed',result_digest=?,updated_at=? WHERE id=? AND state='authorized'`,[resultDigest,iso(now),id]);
  if(changed.changes!==1)throw new Error('TOOL_INVOCATION_NOT_AUTHORIZED');
  const invocation=queryOne<any>('SELECT task_id,agent_id FROM agent_tool_invocations WHERE id=?',[id]);
  audit(invocation?.task_id||null,invocation?.agent_id||'unknown','tool.invocation_completed',id,'completed',{resultDigest:digest(result)},now);
}

export function startReferenceWorkflow(input:{taskId:string;executionRunId:string;ownerAgentId:string},now=new Date()){
  const existing=queryOne<any>('SELECT * FROM reference_workflow_runs WHERE execution_run_id=?',[input.executionRunId]);
  if(existing){if(existing.task_id!==input.taskId||existing.owner_agent_id!==input.ownerAgentId)throw new Error('WORKFLOW_IDENTITY_MISMATCH');return existing;}
  const ownership=queryOne<any>(`SELECT id FROM task_execution_runs WHERE id=? AND task_id=? AND agent_id=?
    AND state IN ('running','waiting_input','recovering')`,[input.executionRunId,input.taskId,input.ownerAgentId]);
  if(!ownership)throw new Error('WORKFLOW_EXECUTION_OWNERSHIP_MISMATCH');
  const id=randomUUID();
  run(`INSERT INTO reference_workflow_runs(id,task_id,execution_run_id,owner_agent_id,state,phase,checkpoint,created_at,updated_at)
    VALUES(?,?,?,?,'running','prepare','{}',?,?)`,[id,input.taskId,input.executionRunId,input.ownerAgentId,iso(now),iso(now)]);
  return queryOne<any>('SELECT * FROM reference_workflow_runs WHERE id=?',[id])!;
}

export function applyWorkflowEvent(input:{workflowId:string;idempotencyKey:string;expectedVersion:number;type:'pause_for_confirmation'|'resume_after_tool'|'submit_evidence';payload:Record<string,unknown>},now=new Date()){
  return transaction(()=>{
    const current=queryOne<any>('SELECT * FROM reference_workflow_runs WHERE id=?',[input.workflowId]);
    if(!current)throw new Error('WORKFLOW_NOT_FOUND');
    const prior=queryOne<any>('SELECT * FROM reference_workflow_events WHERE workflow_id=? AND idempotency_key=?',[input.workflowId,input.idempotencyKey]);
    if(prior){if(prior.event_type!==input.type||prior.expected_version!==input.expectedVersion||prior.payload!==canonical(input.payload))throw new Error('WORKFLOW_EVENT_MISMATCH');return current;}
    if(current.version!==input.expectedVersion)throw new Error('WORKFLOW_VERSION_CONFLICT');
    const transitions:any={pause_for_confirmation:{from:'running',to:'waiting_input',phase:'confirmation'},resume_after_tool:{from:'waiting_input',to:'running',phase:'execute'},submit_evidence:{from:'running',to:'evaluating',phase:'evaluation'}};
    const next=transitions[input.type]; if(current.state!==next.from)throw new Error('WORKFLOW_INVALID_TRANSITION');
    const invocation=input.payload.invocationId||null;
    if(input.type==='resume_after_tool'){
      const tool=queryOne<any>("SELECT state FROM agent_tool_invocations WHERE id=?",[current.pending_invocation_id]);
      if(tool?.state!=='completed')throw new Error('WORKFLOW_TOOL_NOT_COMPLETE');
    }
    const payload=canonical(input.payload);
    run(`INSERT INTO reference_workflow_events(id,workflow_id,idempotency_key,expected_version,event_type,payload,created_at) VALUES(?,?,?,?,?,?,?)`,[randomUUID(),input.workflowId,input.idempotencyKey,input.expectedVersion,input.type,payload,iso(now)]);
    run(`UPDATE reference_workflow_runs SET state=?,phase=?,checkpoint=?,pending_invocation_id=COALESCE(?,pending_invocation_id),version=version+1,updated_at=? WHERE id=?`,[next.to,next.phase,payload,invocation,iso(now),input.workflowId]);
    return queryOne<any>('SELECT * FROM reference_workflow_runs WHERE id=?',[input.workflowId])!;
  });
}

export function evaluateReferenceWorkflow(workflowId:string,evaluatorAgentId:string,verdict:'passed'|'failed',evidence:string,now=new Date()){
  return transaction(()=>{
    const current=queryOne<any>('SELECT * FROM reference_workflow_runs WHERE id=?',[workflowId]);
    if(!current||current.state!=='evaluating')throw new Error('WORKFLOW_NOT_EVALUATING');
    if(current.owner_agent_id===evaluatorAgentId)throw new Error('INDEPENDENT_EVALUATOR_REQUIRED');
    if(!evidence.trim())throw new Error('EVALUATION_EVIDENCE_REQUIRED');
    const evaluator=queryOne<{role:string}>('SELECT role FROM agents WHERE id=?',[evaluatorAgentId]);
    if(!evaluator||!['verifier','reviewer','tester','recovery'].includes(evaluator.role))throw new Error('EVALUATOR_PERMISSION_REQUIRED');
    run(`UPDATE reference_workflow_runs SET state=?,phase=?,evaluator_agent_id=?,evaluation_verdict=?,evaluation_evidence=?,evaluation_evidence_digest=?,version=version+1,updated_at=? WHERE id=?`,
      [verdict==='passed'?'complete':'failed',verdict==='passed'?'complete':'failed',evaluatorAgentId,verdict,evidence,digest(evidence),iso(now),workflowId]);
    return queryOne<any>('SELECT * FROM reference_workflow_runs WHERE id=?',[workflowId])!;
  });
}

export function writeMemory(input:{workspaceId:string;subjectKey:string;plane:MemoryPlane;content:string;sourceRef:string;retentionUntil?:string;correctionOfId?:string},now=new Date()){
  if(!input.content.trim())throw new Error('MEMORY_CONTENT_REQUIRED');
  if(input.plane==='session_context'&&!input.retentionUntil)throw new Error('SESSION_RETENTION_REQUIRED');
  if(input.retentionUntil&&Date.parse(input.retentionUntil)<=now.getTime())throw new Error('MEMORY_RETENTION_INVALID');
  return transaction(()=>{
    if(input.correctionOfId){
      const prior=queryOne<any>('SELECT * FROM agent_memory_records WHERE id=? AND deleted_at IS NULL',[input.correctionOfId]);
      if(!prior||prior.plane!==input.plane||prior.workspace_id!==input.workspaceId||prior.subject_key!==input.subjectKey)throw new Error('MEMORY_CORRECTION_BOUNDARY');
      run("UPDATE agent_memory_records SET deleted_at=?,content=NULL,deletion_reason='corrected' WHERE id=?",[iso(now),prior.id]);
    }
    const id=randomUUID();
    run(`INSERT INTO agent_memory_records(id,workspace_id,subject_key,plane,content,content_hash,source_ref,retention_until,correction_of_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,[id,input.workspaceId,input.subjectKey,input.plane,input.content,digest(input.content),input.sourceRef,input.retentionUntil||null,input.correctionOfId||null,iso(now)]);
    return queryOne<any>('SELECT * FROM agent_memory_records WHERE id=?',[id])!;
  });
}

export function deleteMemory(id:string,reason:string,now=new Date()):void{
  if(!reason.trim())throw new Error('MEMORY_DELETION_REASON_REQUIRED');
  const changed=run('UPDATE agent_memory_records SET content=NULL,deleted_at=?,deletion_reason=? WHERE id=? AND deleted_at IS NULL',[iso(now),reason, id]);
  if(changed.changes!==1)throw new Error('MEMORY_RECORD_NOT_CURRENT');
}
