import assert from 'node:assert/strict';
import{after,before,test}from'node:test';
import fs from'node:fs';import os from'node:os';import path from'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-controller-'));process.env.DATABASE_PATH=path.join(dir,'db.sqlite');process.env.OPENCLAW_WEBHOOK_SECRET='test';
let db:typeof import('../src/lib/db');let controller:typeof import('../src/lib/openclaw/completion-controller');let supervision:typeof import('../src/lib/openclaw/execution-supervision');
const t0=new Date('2026-08-07T00:00:00.000Z');
before(async()=>{db=await import('../src/lib/db');controller=await import('../src/lib/openclaw/completion-controller');supervision=await import('../src/lib/openclaw/execution-supervision');
db.run("INSERT OR IGNORE INTO agents(id,name,role,gateway_agent_id) VALUES('worker','Worker','specialist','worker')");db.run("INSERT OR IGNORE INTO agents(id,name,role,gateway_agent_id) VALUES('reviewer','Reviewer','reviewer','reviewer')");
});after(()=>{db.closeDb();fs.rmSync(dir,{recursive:true,force:true})});
function add(id:string,status:string,agent:string|null='worker',reason:string|null=null){db.run('INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id,status_reason,updated_at) VALUES(?,?,?,?,?,?,?)',[id,id,status,agent,'default',reason,t0.toISOString()]);}

test('classifies complete lifecycle and produces idempotent dry-run actions',async()=>{
  add('healthy','assigned');supervision.startExecution({taskId:'healthy',agentId:'worker',sessionKey:'s',runIdentity:'healthy-run',leaseOwner:'o'},t0);
  add('missing','assigned');
  add('stalled','in_progress');db.run(`INSERT INTO task_execution_runs(id,task_id,agent_id,session_key,run_identity,state,lease_epoch,oracle_status,created_at,updated_at) VALUES('stalled-run','stalled','worker','s','stalled-identity','stalled',1,'pending',?,?)`,[t0.toISOString(),t0.toISOString()]);
  add('verify','review');db.run("INSERT INTO task_roles(id,task_id,role,agent_id) VALUES('role-v','verify','reviewer','reviewer')");
  add('close','review');db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title) VALUES('d','close','file','evidence')");db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message) VALUES('a','close','worker','completed','done')");db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message) VALUES('a-verify','close','reviewer','verification_passed','gates passed')");
  add('prereq','in_progress');add('dependent','pending_dispatch');db.run("INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES('dependent','prereq')");
  add('human','blocked','worker','Michael approval required for production');
  add('blocked','blocked','worker','test failure');
  const first=await controller.runCompletionScan('dry_run',new Date(t0.getTime()+60_000));assert.equal(first.status,'completed');if(first.status!=='completed')return;
  const byId=Object.fromEntries(first.decisions.map(d=>[d.taskId,d]));
  assert.equal(byId.healthy.classification,'healthy_running');assert.equal(byId.missing.action,'dispatch');assert.equal(byId.stalled.classification,'stalled');
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
  await controller.runCompletionScan('active',new Date(t0.getTime()+720_000));
  assert.equal(db.queryOne<{status:string}>("SELECT status FROM tasks WHERE id='promote-close'")!.status,'done');
  assert.equal(db.queryOne<{id:string;state:string}>("SELECT id,state FROM completion_controller_actions WHERE id=?",[proposed.id])!.state,'completed');
  assert.equal(db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM completion_controller_actions WHERE task_id='promote-close' AND action_type='close'")!.n,1);
});
