import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-control-plane-'));
process.env.DATABASE_PATH=path.join(testDir,'test.sqlite');
process.env.OPENCLAW_WEBHOOK_SECRET='test-only';

let db:typeof import('../src/lib/db');
let control:typeof import('../src/lib/agent-control-plane');
let supervision:typeof import('../src/lib/openclaw/execution-supervision');
let taskId:string,executionRunId:string;

before(async()=>{
  db=await import('../src/lib/db');
  control=await import('../src/lib/agent-control-plane');
  supervision=await import('../src/lib/openclaw/execution-supervision');
  db.run("INSERT OR IGNORE INTO workspaces(id,name,slug) VALUES('default','Default','default')");
  db.run("INSERT INTO agents(id,name,role,gateway_agent_id) VALUES('builder','Builder','builder','builder')");
  db.run("INSERT INTO agents(id,name,role,gateway_agent_id) VALUES('verifier','Verifier','verifier','verifier')");
  taskId='control-task';
  db.run("INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES(?,?,'assigned','builder','default')",[taskId,taskId]);
  executionRunId=supervision.startExecution({taskId,agentId:'builder',sessionKey:'agent:builder:test',runIdentity:'control-run',leaseOwner:'worker'}).id;
});
after(()=>{db.closeDb();fs.rmSync(testDir,{recursive:true,force:true});});

test('migration is additive and backward-compatible on a populated database',()=>{
  assert.ok(db.queryOne("SELECT id FROM _migrations WHERE id='040'"));
  assert.ok(db.queryOne("SELECT id FROM tasks WHERE id=?",[taskId]));
  for(const table of ['agent_tool_contracts','agent_tool_invocations','reference_workflow_runs','agent_memory_records'])
    assert.ok(db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[table]));
});

test('typed least-privilege tool admission fails closed and is idempotent',()=>{
  const now=new Date('2026-08-26T00:00:00.000Z');
  control.registerToolContract({name:'mattermost.send',version:1,risk:'external_action',requiredFields:['channelId','message'],fieldTypes:{channelId:'string',message:'string'},rateLimitCount:1,rateLimitWindowSeconds:60},now);
  const input={taskId,runId:executionRunId,agentId:'builder',contractName:'mattermost.send',contractVersion:1,idempotencyKey:'send-1',payload:{channelId:'synthetic-channel',message:'synthetic'}};
  assert.throws(()=>control.requestToolInvocation(input,now),/TOOL_PERMISSION_DENIED/);
  assert.equal(db.queryOne<any>("SELECT count(*) total FROM agent_control_plane_audit_events WHERE event_type='tool.invocation_denied'")!.total,1);
  control.grantTool('builder','mattermost.send',1,'security-owner',null,now);
  assert.throws(()=>control.requestToolInvocation({...input,payload:{channelId:'synthetic-channel'}},now),/TOOL_INPUT_INVALID/);
  assert.throws(()=>control.requestToolInvocation({...input,payload:{channelId:'synthetic-channel',message:'synthetic',token:'forbidden'}},now),/TOOL_INPUT_INVALID/);
  const pending=control.requestToolInvocation(input,now);
  assert.equal(pending.state,'pending_confirmation');
  assert.equal(control.requestToolInvocation(input,now).id,pending.id);
  assert.throws(()=>control.requestToolInvocation({...input,payload:{...input.payload,message:'changed'}},now),/IDEMPOTENCY_PAYLOAD_MISMATCH/);
  assert.throws(()=>control.confirmToolInvocation(pending.id,'builder',now),/SEPARATION_REQUIRED/);
  assert.throws(()=>control.confirmToolInvocation(pending.id,'untrusted-actor',now),/AUTHORITY_REQUIRED/);
  assert.equal(control.confirmToolInvocation(pending.id,'security-owner',now).state,'authorized');
  control.completeToolInvocation(pending.id,{providerMessageId:'synthetic'},now);
  control.completeToolInvocation(pending.id,{providerMessageId:'synthetic'},now);
  assert.throws(()=>control.completeToolInvocation(pending.id,{providerMessageId:'different'},now),/RESULT_MISMATCH/);
  assert.equal(db.queryOne<any>("SELECT count(*) total FROM agent_control_plane_audit_events WHERE target_id=? AND outcome IN ('allowed','completed')",[pending.id])!.total,3);
  assert.throws(()=>control.requestToolInvocation({...input,idempotencyKey:'send-2'},new Date(now.getTime()+1)),/TOOL_RATE_LIMITED/);
});

test('reference workflow pauses, resumes after confirmed completion, and requires independent evidence',()=>{
  const now=new Date('2026-08-26T01:00:00.000Z');
  control.registerToolContract({name:'artifact.publish',version:1,risk:'external_action',requiredFields:['artifactDigest'],fieldTypes:{artifactDigest:'string'},rateLimitCount:5,rateLimitWindowSeconds:60},now);
  control.grantTool('builder','artifact.publish',1,'security-owner',null,now);
  const workflow=control.startReferenceWorkflow({taskId,executionRunId,ownerAgentId:'builder'},now);
  const invocation=control.requestToolInvocation({taskId,runId:executionRunId,agentId:'builder',contractName:'artifact.publish',contractVersion:1,idempotencyKey:'publish-1',payload:{artifactDigest:'sha256:abc'}},now);
  const paused=control.applyWorkflowEvent({workflowId:workflow.id,idempotencyKey:'pause-1',expectedVersion:1,type:'pause_for_confirmation',payload:{invocationId:invocation.id}},now);
  assert.equal(paused.state,'waiting_input');
  assert.equal(control.applyWorkflowEvent({workflowId:workflow.id,idempotencyKey:'pause-1',expectedVersion:1,type:'pause_for_confirmation',payload:{invocationId:invocation.id}}).version,2);
  assert.throws(()=>control.applyWorkflowEvent({workflowId:workflow.id,idempotencyKey:'pause-1',expectedVersion:1,type:'pause_for_confirmation',payload:{invocationId:'different'}}),/EVENT_MISMATCH/);
  assert.throws(()=>control.applyWorkflowEvent({workflowId:workflow.id,idempotencyKey:'resume-early',expectedVersion:2,type:'resume_after_tool',payload:{}}),/TOOL_NOT_COMPLETE/);
  control.confirmToolInvocation(invocation.id,'security-owner',now); control.completeToolInvocation(invocation.id,{ok:true},now);
  const resumed=control.applyWorkflowEvent({workflowId:workflow.id,idempotencyKey:'resume-1',expectedVersion:2,type:'resume_after_tool',payload:{toolResultDigest:'sha256:def'}},now);
  const evaluating=control.applyWorkflowEvent({workflowId:workflow.id,idempotencyKey:'evidence-1',expectedVersion:3,type:'submit_evidence',payload:{verification:'passed'}},now);
  assert.equal(resumed.state,'running'); assert.equal(evaluating.state,'evaluating');
  assert.throws(()=>control.evaluateReferenceWorkflow(workflow.id,'builder','passed','self review',now),/INDEPENDENT_EVALUATOR_REQUIRED/);
  assert.equal(control.evaluateReferenceWorkflow(workflow.id,'verifier','passed','Independent deterministic verification passed',now).state,'complete');
});

test('workflow checkpoint and idempotent events survive database restart',()=>{
  const row=db.queryOne<any>("SELECT id,checkpoint,version FROM reference_workflow_runs WHERE state='complete'")!;
  db.closeDb();
  const restored=db.queryOne<any>('SELECT checkpoint,version FROM reference_workflow_runs WHERE id=?',[row.id])!;
  assert.equal(restored.checkpoint,row.checkpoint); assert.equal(restored.version,row.version);
});

test('memory planes enforce retention, correction, and deletion boundaries',()=>{
  const now=new Date('2026-08-26T02:00:00.000Z');
  assert.throws(()=>control.writeMemory({workspaceId:'default',subjectKey:'task:1',plane:'session_context',content:'transient',sourceRef:'session:test'},now),/SESSION_RETENTION_REQUIRED/);
  assert.throws(()=>control.writeMemory({workspaceId:'default',subjectKey:'task:1',plane:'session_context',content:'transient',sourceRef:'session:test',retentionUntil:'2026-08-25T02:00:00.000Z'},now),/RETENTION_INVALID/);
  const session=control.writeMemory({workspaceId:'default',subjectKey:'task:1',plane:'session_context',content:'transient',sourceRef:'session:test',retentionUntil:'2026-08-27T02:00:00.000Z'},now);
  const fact=control.writeMemory({workspaceId:'default',subjectKey:'preference:format',plane:'curated_fact',content:'concise',sourceRef:'user:test'},now);
  assert.throws(()=>control.writeMemory({workspaceId:'default',subjectKey:'preference:format',plane:'semantic_memory',content:'wrong plane',sourceRef:'model:test',correctionOfId:fact.id},now),/MEMORY_CORRECTION_BOUNDARY/);
  const corrected=control.writeMemory({workspaceId:'default',subjectKey:'preference:format',plane:'curated_fact',content:'CEO concise',sourceRef:'user:correction',correctionOfId:fact.id},now);
  assert.equal(db.queryOne<any>('SELECT content,deletion_reason FROM agent_memory_records WHERE id=?',[fact.id])!.deletion_reason,'corrected');
  control.deleteMemory(corrected.id,'user erasure request',now);
  const deleted=db.queryOne<any>('SELECT content,content_hash,deletion_reason FROM agent_memory_records WHERE id=?',[corrected.id])!;
  assert.equal(deleted.content,null); assert.match(deleted.content_hash,/^[0-9a-f]{64}$/); assert.equal(deleted.deletion_reason,'user erasure request');
  control.deleteMemory(session.id,'retention expiry',now);
});
