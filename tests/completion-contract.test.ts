import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-contract-'));
process.env.DATABASE_PATH=path.join(dir,'db.sqlite');process.env.OPENCLAW_WEBHOOK_SECRET='test';
let db:typeof import('../src/lib/db');let contracts:typeof import('../src/lib/completion-contract');let controller:typeof import('../src/lib/openclaw/completion-controller');
const now=new Date('2026-08-08T20:00:00.000Z');

before(async()=>{db=await import('../src/lib/db');contracts=await import('../src/lib/completion-contract');controller=await import('../src/lib/openclaw/completion-controller');
  db.run("INSERT OR IGNORE INTO agents(id,name,role) VALUES('worker','Worker','specialist')");
  db.run("INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id,updated_at) VALUES('task','Contract task','review','worker','default',?)",[now.toISOString()]);
  db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title,created_at) VALUES('deliverable','task','file','artifact',?)",[new Date(now.getTime()-60_000).toISOString()]);
  db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,created_at) VALUES('complete','task','worker','completed','done',?)",[now.toISOString()]);
  db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,created_at) VALUES('verified','task','worker','verification_passed','passed',?)",[now.toISOString()]);
});
after(()=>{db.closeDb();fs.rmSync(dir,{recursive:true,force:true})});

test('required contracts block coarse count-based closure until every gate has evidence',()=>{
  const contract=contracts.createCompletionContract('task',{acceptance_criteria:['Tests pass','Documentation updated'],protected_boundaries:['No production mutation']},new Date(now.getTime()-120_000)) as any;
  assert.equal(contract.ready,false);
  const blocked=controller.classifyTask(db.queryOne<any>("SELECT id,title,status,brief,status_reason,assigned_agent_id,workflow_template_id,updated_at FROM tasks WHERE id='task'")!,now);
  assert.equal(blocked.classification,'awaiting_verification');
  assert.match(blocked.reason,/Every acceptance criterion/);
});

test('complete current evidence makes the task eligible for closure',()=>{
  const snapshot=contracts.getCompletionContract('task',now) as any;
  const result=contracts.submitCompletionReport('task',{
    criteria:snapshot.criteria.map((item:any)=>({id:item.id,status:'passed',evidence:`Evidence for ${item.description}`})),
    boundaries:snapshot.boundaries.map((item:any)=>({id:item.id,status:'intact',evidence:`Confirmed ${item.description}`})),
    plan_vs_actual:'Implemented the planned contract behavior with no scope change.',
    deviations:[],deferred_work:[],
    verification_commands:[{command:'npm run test:execution',exit_code:0,output_summary:'All tests passed'}],
    verification_ran_at:now.toISOString(),next_action:'None — task complete',submitted_by_agent_id:'worker',
  },now) as any;
  assert.equal(result.ready,true);
  assert.equal(db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM task_activities WHERE task_id='task' AND activity_type='completion_contract_passed'")!.n,1);
  assert.equal(controller.classifyTask(db.queryOne<any>("SELECT id,title,status,brief,status_reason,assigned_agent_id,workflow_template_id,updated_at FROM tasks WHERE id='task'")!,now).action,'close');
});

test('a violated boundary and stale verification each fail closed',()=>{
  const boundary=db.queryOne<{id:string}>("SELECT id FROM task_protected_boundaries WHERE task_id='task'")!;
  db.run("UPDATE task_protected_boundaries SET status='violated' WHERE id=?",[boundary.id]);
  assert.equal(contracts.evaluateCompletionContract('task',now).ready,false);
  db.run("UPDATE task_protected_boundaries SET status='intact' WHERE id=?",[boundary.id]);
  assert.equal(contracts.evaluateCompletionContract('task',new Date(now.getTime()+25*60*60_000)).ready,false);
});

test('legacy tasks without contracts remain backward compatible',()=>{
  db.run("INSERT INTO tasks(id,title,status,workspace_id,updated_at) VALUES('legacy','Legacy','review','default',?)",[now.toISOString()]);
  assert.deepEqual(contracts.evaluateCompletionContract('legacy',now),{exists:false,required:false,ready:true,reasons:[]});
});
