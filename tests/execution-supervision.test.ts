import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-execution-'));
process.env.DATABASE_PATH=path.join(testDir,'test.sqlite');
process.env.OPENCLAW_WEBHOOK_SECRET='test-only';

let db:typeof import('../src/lib/db');
let supervision:typeof import('../src/lib/openclaw/execution-supervision');
let dispatch:typeof import('../src/lib/openclaw/dispatch');

before(async()=>{
  db=await import('../src/lib/db');
  supervision=await import('../src/lib/openclaw/execution-supervision');
  dispatch=await import('../src/lib/openclaw/dispatch');
  db.run("INSERT OR IGNORE INTO workspaces(id,name,slug) VALUES('default','Default','default')");
  db.run("INSERT OR IGNORE INTO agents(id,name,role,gateway_agent_id) VALUES('agent-a','Tank','builder','tank')");
  db.run("INSERT OR IGNORE INTO agents(id,name,role,gateway_agent_id) VALUES('oracle','Oracle','recovery','oracle')");
});
after(()=>{db.closeDb();fs.rmSync(testDir,{recursive:true,force:true});});

function task(id:string){db.run("INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES(?,?,'assigned','agent-a','default')",[id,id]);}

test('controller dispatch starts a ready pending_dispatch task but preserves dependency fencing',()=>{
  db.run("INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES('task-ready-dispatch','ready','pending_dispatch','agent-a','default')");
  const started=supervision.startExecution({taskId:'task-ready-dispatch',agentId:'agent-a',sessionKey:'agent:tank:ready',runIdentity:'ready-run',leaseOwner:'ready-owner'});
  assert.equal(started.state,'running');
  assert.equal(db.queryOne<{status:string}>("SELECT status FROM tasks WHERE id='task-ready-dispatch'")?.status,'in_progress');
  supervision.transitionExecution({runId:started.id,leaseOwner:'ready-owner',leaseEpoch:1,eventKey:'ready-done',state:'complete'});

  db.run("INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES('task-prerequisite','prerequisite','in_progress','agent-a','default')");
  db.run("INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES('task-dependent-dispatch','dependent','pending_dispatch','agent-a','default')");
  db.run("INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES('task-dependent-dispatch','task-prerequisite')");
  assert.throws(
    ()=>supervision.startExecution({taskId:'task-dependent-dispatch',agentId:'agent-a',sessionKey:'agent:tank:dependent',runIdentity:'dependent-run',leaseOwner:'dependent-owner'}),
    /dependencies are incomplete/,
  );
  db.run("UPDATE tasks SET status='done' WHERE id IN ('task-prerequisite','task-dependent-dispatch')");
});

test('lease heartbeat is idempotent and stale fencing is rejected',()=>{
  task('task-one');
  const t0=new Date('2026-08-06T20:00:00.000Z');
  const run=supervision.startExecution({taskId:'task-one',agentId:'agent-a',sessionKey:'agent:tank:run',runIdentity:'run-1',leaseOwner:'worker-1'},t0);
  const first=supervision.heartbeat({runId:run.id,leaseOwner:'worker-1',leaseEpoch:1,eventKey:'hb-1',checkpoint:{step:2}},new Date(t0.getTime()+90_000));
  const duplicate=supervision.heartbeat({runId:run.id,leaseOwner:'worker-1',leaseEpoch:1,eventKey:'hb-1',checkpoint:{step:99}},new Date(t0.getTime()+120_000));
  assert.equal(JSON.parse(first.checkpoint!).step,2);
  assert.equal(duplicate.checkpoint,first.checkpoint);
  assert.throws(()=>supervision.heartbeat({runId:run.id,leaseOwner:'wrong',leaseEpoch:1,eventKey:'hb-2'}),supervision.StaleLeaseError);
  supervision.transitionExecution({runId:run.id,leaseOwner:'worker-1',leaseEpoch:1,eventKey:'done-1',state:'complete'});
});

test('one stale recovery is scheduled and the next stale epoch escalates once',()=>{
  task('task-two');
  const t0=new Date('2026-08-06T21:00:00.000Z');
  const run=supervision.startExecution({taskId:'task-two',agentId:'agent-a',sessionKey:'agent:tank:run2',runIdentity:'run-2',leaseOwner:'worker-2'},t0);
  const recovery=supervision.reconcileExecutions(new Date(t0.getTime()+supervision.LEASE_TTL_MS+1));
  assert.equal(recovery.length,1); assert.equal(recovery[0].kind,'resume'); assert.equal(recovery[0].run.resume_count,1);
  supervision.markRecoveryDelivered(recovery[0]);
  const escalated=supervision.reconcileExecutions(new Date(t0.getTime()+2*supervision.LEASE_TTL_MS+2));
  assert.equal(escalated.length,1); assert.equal(escalated[0].kind,'oracle');
  supervision.markRecoveryDelivered(escalated[0]);
  assert.equal(supervision.reconcileExecutions(new Date(t0.getTime()+2*supervision.LEASE_TTL_MS+3)).length,0);
  const current=supervision.getExecution('task-two')!;
  assert.equal(current.state,'stalled'); assert.equal(current.oracle_status,'pending');
  assert.ok(supervision.getExecutionEvents('task-two').some(event=>event.event_type==='oracle_escalation_requested'));
  assert.equal(run.task_id,current.task_id);
});

test('split brain start is rejected and Oracle can recover through explicit reassignment',()=>{
  task('task-three');
  const t0=new Date('2026-08-06T22:00:00.000Z');
  const run=supervision.startExecution({taskId:'task-three',agentId:'agent-a',sessionKey:'old',runIdentity:'run-3',leaseOwner:'worker-3'},t0);
  assert.throws(()=>supervision.startExecution({taskId:'task-three',agentId:'agent-a',sessionKey:'other',runIdentity:'split-brain',leaseOwner:'worker-x'},t0),supervision.ExecutionConflictError);
  const recovery=supervision.reconcileExecutions(new Date(t0.getTime()+supervision.LEASE_TTL_MS+1)); supervision.markRecoveryDelivered(recovery[0]);
  const escalation=supervision.reconcileExecutions(new Date(t0.getTime()+2*supervision.LEASE_TTL_MS+2)); supervision.markRecoveryDelivered(escalation[0]);
  supervision.acknowledgeOracle(run.id,'oracle','worker vanished');
  const reassigned=supervision.reassignExecution(run.id,'oracle','agent-a','replacement','resume checkpoint');
  assert.equal(reassigned.state,'recovering'); assert.equal(reassigned.oracle_status,'resolved'); assert.equal(reassigned.session_key,'replacement');
});

test('synthetic long-running checkpoint survives database process restart',()=>{
  task('task-restart');
  const t0=new Date('2026-08-06T23:00:00.000Z');
  const run=supervision.startExecution({taskId:'task-restart',agentId:'agent-a',sessionKey:'durable-session',runIdentity:'restart-run',leaseOwner:'worker-r'},t0);
  supervision.heartbeat({runId:run.id,leaseOwner:'worker-r',leaseEpoch:1,eventKey:'restart-hb',checkpoint:{phase:'halfway',artifact:'sha256:abc'}},new Date(t0.getTime()+90_000));
  db.closeDb();
  const restored=supervision.getExecution('task-restart')!;
  assert.deepEqual(JSON.parse(restored.checkpoint!),{phase:'halfway',artifact:'sha256:abc'});
  const actions=supervision.reconcileExecutions(new Date(t0.getTime()+supervision.LEASE_TTL_MS+90_001));
  assert.equal(actions.find(action=>action.run.id===run.id)?.kind,'resume');
});

test('in_progress without a lease is classified unhealthy and escalated once',()=>{
  db.run("INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES('task-unleased','unleased','in_progress','agent-a','default')");
  const actions=supervision.reconcileExecutions(new Date('2026-08-07T01:00:00.000Z'));
  const escalation=actions.find(action=>action.run.task_id==='task-unleased');
  assert.equal(escalation?.kind,'oracle');
  supervision.markRecoveryDelivered(escalation!);
  assert.equal(supervision.getExecution('task-unleased')?.state,'stalled');
  assert.equal(supervision.reconcileExecutions(new Date('2026-08-07T01:01:00.000Z')).filter(action=>action.run.task_id==='task-unleased').length,0);
});

test('explicit redispatch supersedes an acknowledged stalled run with a fresh lease',()=>{
  task('task-reactivated');
  const t0=new Date('2026-08-07T02:00:00.000Z');
  const first=supervision.startExecution({taskId:'task-reactivated',agentId:'agent-a',sessionKey:'old-session',runIdentity:'old-run',leaseOwner:'old-worker'},t0);
  const recovery=supervision.reconcileExecutions(new Date(t0.getTime()+supervision.LEASE_TTL_MS+1));supervision.markRecoveryDelivered(recovery[0]);
  const escalation=supervision.reconcileExecutions(new Date(t0.getTime()+2*supervision.LEASE_TTL_MS+2));supervision.markRecoveryDelivered(escalation[0]);
  supervision.acknowledgeOracle(first.id,'oracle','safe to redispatch',new Date(t0.getTime()+2*supervision.LEASE_TTL_MS+3));
  db.run("UPDATE tasks SET status='in_progress',updated_at=? WHERE id=?",[new Date(t0.getTime()+2*supervision.LEASE_TTL_MS+4).toISOString(),'task-reactivated']);

  const replacement=supervision.startExecution({taskId:'task-reactivated',agentId:'agent-a',sessionKey:'new-session',runIdentity:'new-run',leaseOwner:'new-worker'},new Date(t0.getTime()+2*supervision.LEASE_TTL_MS+5));
  assert.equal(replacement.state,'running');
  assert.equal(replacement.lease_epoch,1);
  assert.equal(db.queryOne<{state:string}>('SELECT state FROM task_execution_runs WHERE id=?',[first.id])?.state,'cancelled');
  assert.ok(supervision.getExecutionEvents('task-reactivated').some(item=>item.event_type==='execution_superseded'));
});

test('normal dispatch contract flows through activity heartbeat to terminal task state',()=>{
  task('task-dispatch');
  const started=supervision.startExecution({taskId:'task-dispatch',agentId:'agent-a',sessionKey:'agent:tank:dispatch',runIdentity:'dispatch-run',leaseOwner:'dispatch-owner'});
  const message=dispatch.buildTaskMessage({id:'task-dispatch',title:'dispatch',status:'assigned',priority:'normal',assigned_agent_id:'agent-a',workspace_id:'default',business_id:'default',created_at:'',updated_at:''} as any,{id:'agent-a',name:'Tank',role:'builder'} as any,'correlation','⚪',started);
  assert.match(message,/every 60–120 seconds/);
  assert.match(message,new RegExp(started.id));
  const renewed=supervision.heartbeatFromActivity('task-dispatch','agent-a','activity:progress',{phase:'integration'});
  assert.equal(JSON.parse(renewed!.checkpoint!).phase,'integration');
  supervision.transitionFromActivity('task-dispatch','agent-a','activity:complete','complete','verified');
  assert.equal(db.queryOne<{status:string}>('SELECT status FROM tasks WHERE id=?',['task-dispatch'])?.status,'review');
  assert.equal(supervision.getExecution('task-dispatch')?.state,'complete');
});
