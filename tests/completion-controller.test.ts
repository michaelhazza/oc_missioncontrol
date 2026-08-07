import assert from 'node:assert/strict';
import{after,before,test}from'node:test';
import fs from'node:fs';import os from'node:os';import path from'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-controller-'));process.env.DATABASE_PATH=path.join(dir,'db.sqlite');process.env.OPENCLAW_WEBHOOK_SECRET='test';
let db:typeof import('../src/lib/db');let controller:typeof import('../src/lib/openclaw/completion-controller');let supervision:typeof import('../src/lib/openclaw/execution-supervision');
const t0=new Date('2026-08-07T00:00:00.000Z');
before(async()=>{process.env.MISSION_CONTROL_COMPLETION_ACTIONS='dispatch,request_verification,close';db=await import('../src/lib/db');controller=await import('../src/lib/openclaw/completion-controller');supervision=await import('../src/lib/openclaw/execution-supervision');
db.run("INSERT OR IGNORE INTO agents(id,name,role,gateway_agent_id) VALUES('worker','Worker','specialist','worker')");db.run("INSERT OR IGNORE INTO agents(id,name,role,gateway_agent_id) VALUES('reviewer','Reviewer','reviewer','reviewer')");db.run("INSERT OR IGNORE INTO agents(id,name,role,gateway_agent_id) VALUES('oracle','Oracle','monitor','oracle')");
});after(()=>{db.closeDb();fs.rmSync(dir,{recursive:true,force:true})});
function add(id:string,status:string,agent:string|null='worker',reason:string|null=null){db.run('INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id,status_reason,updated_at) VALUES(?,?,?,?,?,?,?)',[id,id,status,agent,'default',reason,t0.toISOString()]);}

test('classifies complete lifecycle and produces idempotent dry-run actions',async()=>{
  add('healthy','assigned');supervision.startExecution({taskId:'healthy',agentId:'worker',sessionKey:'s',runIdentity:'healthy-run',leaseOwner:'o'},t0);
  add('missing','assigned');
  add('parked','inbox');
  add('stalled','in_progress');db.run(`INSERT INTO task_execution_runs(id,task_id,agent_id,session_key,run_identity,state,lease_epoch,oracle_status,created_at,updated_at) VALUES('stalled-run','stalled','worker','s','stalled-identity','stalled',1,'pending',?,?)`,[t0.toISOString(),t0.toISOString()]);
  add('verify','review');db.run("INSERT INTO task_roles(id,task_id,role,agent_id) VALUES('role-v','verify','reviewer','reviewer')");
  add('close','review');db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title) VALUES('d','close','file','evidence')");db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message) VALUES('a','close','worker','completed','done')");db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message) VALUES('a-verify','close','reviewer','verification_passed','gates passed')");
  add('prereq','in_progress');add('dependent','pending_dispatch');db.run("INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES('dependent','prereq')");
  add('human','blocked','worker','Michael approval required for production');
  add('blocked','blocked','worker','test failure');
  const first=await controller.runCompletionScan('dry_run',new Date(t0.getTime()+60_000));assert.equal(first.status,'completed');if(first.status!=='completed')return;
  const byId=Object.fromEntries(first.decisions.map(d=>[d.taskId,d]));
  assert.equal(byId.healthy.classification,'healthy_running');assert.equal(byId.missing.action,'dispatch');assert.equal(byId.stalled.classification,'stalled');
  assert.equal(byId.parked.classification,'awaiting_agent');assert.equal(byId.parked.action,undefined);
  assert.equal(byId.verify.action,'request_verification');assert.equal(byId.close.action,'close');assert.equal(byId.dependent.classification,'awaiting_dependency');
  assert.equal(byId.human.authority,'michael');assert.equal(byId.blocked.authority,'oracle');
  const actionCount=db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM completion_controller_actions')!.n;
  const second=await controller.runCompletionScan('dry_run',new Date(t0.getTime()+180_000));assert.equal(second.status,'completed');
  assert.equal(db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM completion_controller_actions')!.n,actionCount);
});

test('active mode is fenced by a single controller lease',async()=>{
  const one=controller.runCompletionScan('dry_run',new Date(t0.getTime()+360_000));
  const two=controller.runCompletionScan('dry_run',new Date(t0.getTime()+360_000));
  const results=await Promise.all([one,two]);assert.equal(results.filter(result=>result.status==='leased').length,1);
});

test('active scan promotes an identical dry-run action and drains it once',async()=>{
  add('promote-close','review');
  db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title) VALUES('promote-d','promote-close','file','evidence')");
  db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message) VALUES('promote-a','promote-close','worker','completed','done')");
  db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message) VALUES('promote-v','promote-close','reviewer','verification_passed','passed')");
  await controller.runCompletionScan('dry_run',new Date(t0.getTime()+540_000));
  const proposed=db.queryOne<{id:string;state:string}>("SELECT id,state FROM completion_controller_actions WHERE task_id='promote-close' AND action_type='close'")!;assert.equal(proposed.state,'proposed');
  db.run("DELETE FROM completion_controller_actions WHERE task_id!='promote-close'");
  db.run("UPDATE tasks SET status='done' WHERE id!='promote-close'");
  await controller.runCompletionScan('active',new Date(t0.getTime()+720_000));
  assert.equal(db.queryOne<{status:string}>("SELECT status FROM tasks WHERE id='promote-close'")!.status,'done');
  assert.equal(db.queryOne<{id:string;state:string}>("SELECT id,state FROM completion_controller_actions WHERE id=?",[proposed.id])!.state,'completed');
  assert.equal(db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM completion_controller_actions WHERE task_id='promote-close' AND action_type='close'")!.n,1);
});

test('authority queue exposes only one unresolved delivery at a time',()=>{
  add('oracle-one','review');add('oracle-two','review');
  const now=t0.toISOString();
  db.run(`INSERT INTO completion_controller_actions(id,task_id,action_key,action_type,authority,state,payload,created_at,updated_at,completed_at,delivered_at)
    VALUES('oracle-action-one','oracle-one','oracle-one:key','oracle_review','oracle','completed','{}',?,?,?,?)`,[now,now,now,now]);
  db.run(`INSERT INTO completion_controller_actions(id,task_id,action_key,action_type,authority,state,payload,created_at,updated_at)
    VALUES('oracle-action-two','oracle-two','oracle-two:key','oracle_review','oracle','pending','{}',?,?)`,[now,now]);
  assert.equal(controller.hasUnresolvedAuthorityAction('oracle'),true);
  assert.equal(controller.hasUnresolvedAuthorityAction('oracle','oracle-action-one'),false);
  const queue=controller.getControllerQueue() as {id:string}[];
  assert.equal(queue[0].id,'oracle-action-one');
  db.run("UPDATE completion_controller_actions SET resolution_status='passed',resolved_at=? WHERE id='oracle-action-one'",[now]);
  assert.equal(controller.hasUnresolvedAuthorityAction('oracle'),false);
});

test('a later verification pass supersedes an earlier failure',()=>{
  add('reverified','review');
  db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title) VALUES('reverified-d','reverified','file','evidence')");
  db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,created_at) VALUES('reverified-c','reverified','worker','completed','done',?)",[new Date(t0.getTime()+1_000).toISOString()]);
  db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,created_at) VALUES('reverified-f','reverified','reviewer','verification_failed','first review failed',?)",[new Date(t0.getTime()+2_000).toISOString()]);
  db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,created_at) VALUES('reverified-p','reverified','reviewer','verification_passed','rework passed',?)",[new Date(t0.getTime()+3_000).toISOString()]);
  assert.equal(controller.classifyTask(db.queryOne<any>("SELECT id,title,status,brief,status_reason,assigned_agent_id,workflow_template_id,updated_at FROM tasks WHERE id='reverified'")!).classification,'ready_to_close');
});

test('authority session routing defaults to the gateway agent, not main',()=>{
  assert.equal(controller.buildAuthoritySessionKey({name:'Oracle',session_key_prefix:null,gateway_agent_id:'oracle'},'mission-control-oracle'),'agent:oracle:mission-control-oracle');
  assert.equal(controller.buildAuthoritySessionKey({name:'Oracle',session_key_prefix:'agent:custom:',gateway_agent_id:'oracle'},'review'),'agent:custom:review');
});

test('only Oracle review delivery waits on controller resolution',()=>{
  assert.equal(controller.actionRequiresResolution('oracle'),true);
  assert.equal(controller.actionRequiresResolution('specialist'),false);
  assert.equal(controller.actionRequiresResolution('verifier'),false);
  assert.equal(controller.actionRequiresResolution('michael'),false);
});

test('a dispatch invalidated by a concurrent state change is superseded',()=>{
  const decision={taskId:'race',classification:'awaiting_agent',reason:'ready',action:'dispatch',authority:'controller',evidence:{},fingerprint:'race'} as const;
  assert.equal(controller.isSupersededDispatchError(decision,'Task state inbox cannot execute'),true);
  assert.equal(controller.isSupersededDispatchError(decision,'Gateway unavailable'),false);
});
