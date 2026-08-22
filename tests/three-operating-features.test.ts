import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-three-features-'));
process.env.DATABASE_PATH=path.join(dir,'db.sqlite');process.env.OPENCLAW_WEBHOOK_SECRET='test';
process.env.MC_MATTERMOST_ACCOUNT_ID='switch';process.env.MC_MATTERMOST_SENDER_ID='michael';process.env.MC_MATTERMOST_CHANNEL_ID='dm-channel';
let db:typeof import('../src/lib/db');let intake:typeof import('../src/lib/mattermost-intake');let features:typeof import('../src/lib/operating-features');let contracts:typeof import('../src/lib/completion-contract');
const now=new Date('2026-08-21T12:00:00.000Z');
before(async()=>{db=await import('../src/lib/db');intake=await import('../src/lib/mattermost-intake');features=await import('../src/lib/operating-features');contracts=await import('../src/lib/completion-contract');});
after(()=>{db.closeDb();fs.rmSync(dir,{recursive:true,force:true});});
const inbound=(overrides:Record<string,unknown>={})=>({workspace_id:'default',mattermost_account_id:'switch',provider_event_id:'event-1',sender_id:'michael',channel_id:'dm-channel',channel_type:'D',source_post_id:'root-1',message:'Build the approved capability end to end',provider_created_at:now.toISOString(),...overrides});

test('thread capture is idempotent and replies enrich the canonical task',()=>{
  const first=intake.processMattermostInbound(inbound(),now) as any;assert.equal(first.disposition,'captured');
  const duplicate=intake.processMattermostInbound(inbound(),now) as any;assert.equal(duplicate.disposition,'duplicate');assert.equal(duplicate.task_id,first.task_id);
  const reply=intake.processMattermostInbound(inbound({provider_event_id:'event-2',source_post_id:'reply-1',root_post_id:'root-1',message:'Correction: include browser verification'}),new Date(now.getTime()+1000)) as any;
  assert.equal(reply.disposition,'corrected');assert.equal(reply.task_id,first.task_id);
  assert.equal(db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM tasks WHERE mattermost_root_post_id=\'root-1\'')!.n,1);
  assert.equal(db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM task_brief_revisions WHERE task_id=?',[first.task_id])!.n,2);
});

test('terminal-thread replies fail closed as follow-on candidates',()=>{
  const task=db.queryOne<{id:string}>("SELECT id FROM tasks WHERE mattermost_root_post_id='root-1'")!;db.run("UPDATE tasks SET status='done' WHERE id=?",[task.id]);
  const result=intake.processMattermostInbound(inbound({provider_event_id:'event-3',source_post_id:'reply-2',root_post_id:'root-1',message:'Now add another feature'}),new Date(now.getTime()+2000)) as any;
  assert.equal(result.disposition,'needs_classification');assert.equal(result.candidate_reason,'terminal_follow_on');
});

test('exception projection suppresses healthy work and deduplicates blockers and overdue risks',()=>{
  db.run("INSERT INTO tasks(id,title,status,status_reason,workspace_id,commitment_due_at,updated_at) VALUES('blocked','Blocked task','blocked','Needs CEO input','default',NULL,?)",[now.toISOString()]);
  db.run("INSERT INTO tasks(id,title,status,workspace_id,commitment_due_at,updated_at) VALUES('overdue','Overdue task','in_progress','default',?,?)",[new Date(now.getTime()-60_000).toISOString(),now.toISOString()]);
  db.run("INSERT INTO tasks(id,title,status,workspace_id,updated_at) VALUES('healthy','Healthy task','in_progress','default',?)",[now.toISOString()]);
  const first=features.projectTaskExceptions('default',now) as any[];const second=features.projectTaskExceptions('default',now) as any[];
  assert.equal(first.filter(row=>['blocked','overdue'].includes(row.task_id)).length,2);assert.equal(second.length,first.length);
  assert.equal(db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM task_exceptions WHERE task_id IN ('blocked','overdue')")!.n,2);
  assert.equal(first.some(row=>row.task_id==='healthy'),false);
});

test('passing evidence creates one deterministic review and cited synthesis',()=>{
  db.run("INSERT INTO tasks(id,title,status,workspace_id,evidence_version,updated_at) VALUES('review-task','Review task','review','default',0,?)",[now.toISOString()]);
  db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title,path,created_at) VALUES('artifact','review-task','file','Implementation','/tmp/implementation',?)",[new Date(now.getTime()-60_000).toISOString()]);
  const snapshot=contracts.createCompletionContract('review-task',{acceptance_criteria:['All behavior verified'],protected_boundaries:['No unrelated mutation']},new Date(now.getTime()-120_000)) as any;
  contracts.submitCompletionReport('review-task',{criteria:snapshot.criteria.map((item:any)=>({id:item.id,status:'passed',evidence:'Verified by integration test'})),boundaries:snapshot.boundaries.map((item:any)=>({id:item.id,status:'intact',evidence:'Diff reviewed'})),plan_vs_actual:'Delivered the requested features.',deviations:[],deferred_work:[],verification_commands:[{command:'npm run test:execution',exit_code:0,output_summary:'All tests passed'}],verification_ran_at:now.toISOString(),next_action:'Close after executive review'},now);
  const version=db.queryOne<{evidence_version:number}>("SELECT evidence_version FROM tasks WHERE id='review-task'")!.evidence_version;
  const first=features.reviewCompletion('review-task',version,now) as any;const replay=features.reviewCompletion('review-task',version,now) as any;
  assert.equal(first.verdict,'pass');assert.equal(replay.id,first.id);assert.ok(first.synthesis);
  assert.equal(db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM completion_reviews WHERE task_id='review-task'")!.n,1);
  const content=JSON.parse(first.synthesis.content_json);assert.ok(content.objective_outcome.evidence_ids.length>0);
});

