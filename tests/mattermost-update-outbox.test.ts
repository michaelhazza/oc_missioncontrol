import assert from 'node:assert/strict';
import{after,before,test}from'node:test';
import fs from'node:fs';import os from'node:os';import path from'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-mattermost-outbox-'));process.env.DATABASE_PATH=path.join(dir,'db.sqlite');process.env.OPENCLAW_WEBHOOK_SECRET='test';
let db:typeof import('../src/lib/db');let updates:typeof import('../src/lib/openclaw/mattermost-task-updates');
const t0=new Date('2026-08-07T01:00:00.000Z');
before(async()=>{db=await import('../src/lib/db');updates=await import('../src/lib/openclaw/mattermost-task-updates');db.run("INSERT OR IGNORE INTO agents(id,name,role,gateway_agent_id) VALUES('worker','Worker','specialist','worker')");db.run(`INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id,mattermost_channel_id,mattermost_root_post_id,updated_at) VALUES('threaded','Threaded task','assigned','worker','default','channel-1','root-1',?)`,[t0.toISOString()]);db.run(`INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id,updated_at) VALUES('unthreaded','Unthreaded task','assigned','worker','default',?)`,[t0.toISOString()]);});
after(()=>{db.closeDb();fs.rmSync(dir,{recursive:true,force:true})});

test('suppresses every automated Mattermost milestone',()=>{
  assert.equal(updates.queueMattermostMilestone('threaded','dispatched','Specialist started.','action:dispatch',t0),null);
  assert.equal(updates.queueMattermostMilestone('threaded','verification','Verifier started.','action:verify',t0),null);
  assert.equal(updates.queueMattermostMilestone('threaded','completed','Task completed.','action:complete',t0),null);
  assert.equal(updates.queueMattermostMilestone('threaded','blocked','Michael must decide.','action:blocked',t0),null);
  assert.equal(updates.queueMattermostMilestone('threaded','decision','Michael must decide.','action:decision',t0),null);
  assert.equal(updates.queueMattermostMilestone('threaded','failed','Execution failed.','action:failed',t0),null);
  const now=t0.toISOString();
  db.run(`INSERT INTO mattermost_task_update_outbox(id,task_id,action_key,milestone,channel_id,root_post_id,message,state,not_before,created_at,updated_at)
    VALUES('existing-exception','threaded','existing:blocked','blocked','channel-1','root-1','existing exception','pending',?,?,?)`,[now,now,now]);
  assert.equal(updates.queueMattermostMilestone('threaded','blocked','duplicate','action:blocked',new Date(t0.getTime()+1_000)),null);
  assert.equal(updates.queueMattermostMilestone('threaded','blocked','cooldown duplicate','different-key',new Date(t0.getTime()+60_000)),null);
  assert.equal(updates.queueMattermostMilestone('unthreaded','blocked','no destination','unthreaded-key',t0),null);
});

test('extracts the provider post ID from OpenClaw direct and nested JSON',()=>{
  assert.equal(updates.parseProviderMessageId('{"messageId":"direct"}'),'direct');
  assert.equal(updates.parseProviderMessageId('{"payload":{"result":{"messageId":"nested"}}}'),'nested');
});

test('fenced outbox does not deliver pending automated messages',async()=>{
  db.run("UPDATE mattermost_task_update_outbox SET state='delivering',claim_owner='dead-process',claim_expires_at=?",[new Date(t0.getTime()-1).toISOString()]);
  let sends=0;let observed:any;
  const result=await updates.drainMattermostOutbox(t0,async item=>{sends++;observed=item;return{messageId:'post-1'}});
  assert.deepEqual(result,{delivered:0,failed:0});assert.equal(sends,0);assert.equal(observed,undefined);
  assert.deepEqual(await updates.drainMattermostOutbox(new Date(t0.getTime()+1_000),async()=>{sends++;return{}}),{delivered:0,failed:0});assert.equal(sends,0);
  const stored=db.queryOne<{state:string}>('SELECT state FROM mattermost_task_update_outbox WHERE id=?',['existing-exception'])!;assert.equal(stored.state,'pending');
  assert.equal(db.queryOne<{n:number}>("SELECT COUNT(*) n FROM task_activities WHERE task_id='threaded' AND activity_type='mattermost_update_delivered'")!.n,0);
});

test('does not drain legacy routine milestones queued before single-speaker enforcement',async()=>{
  const now=new Date(t0.getTime()+10*60_000).toISOString();
  db.run(`INSERT INTO mattermost_task_update_outbox(id,task_id,action_key,milestone,channel_id,root_post_id,message,state,not_before,created_at,updated_at)
    VALUES('legacy-routine','threaded','legacy:dispatch','dispatched','channel-1','root-1','legacy chatter','pending',?,?,?)`,[now,now,now]);
  let sends=0;
  assert.deepEqual(await updates.drainMattermostOutbox(new Date(now),async()=>{sends++;return{}}),{delivered:0,failed:0});
  assert.equal(sends,0);
});
