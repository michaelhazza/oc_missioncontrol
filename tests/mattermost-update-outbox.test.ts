import assert from 'node:assert/strict';
import{after,before,test}from'node:test';
import fs from'node:fs';import os from'node:os';import path from'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-mattermost-outbox-'));process.env.DATABASE_PATH=path.join(dir,'db.sqlite');process.env.OPENCLAW_WEBHOOK_SECRET='test';
let db:typeof import('../src/lib/db');let updates:typeof import('../src/lib/openclaw/mattermost-task-updates');
const t0=new Date('2026-08-07T01:00:00.000Z');
before(async()=>{db=await import('../src/lib/db');updates=await import('../src/lib/openclaw/mattermost-task-updates');db.run("INSERT OR IGNORE INTO agents(id,name,role,gateway_agent_id) VALUES('worker','Worker','specialist','worker')");db.run(`INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id,mattermost_channel_id,mattermost_root_post_id,updated_at) VALUES('threaded','Threaded task','assigned','worker','default','channel-1','root-1',?)`,[t0.toISOString()]);db.run(`INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id,updated_at) VALUES('unthreaded','Unthreaded task','assigned','worker','default',?)`,[t0.toISOString()]);});
after(()=>{db.closeDb();fs.rmSync(dir,{recursive:true,force:true})});

test('queues only thread-rooted semantic milestones with idempotency and cooldown',()=>{
  const first=updates.queueMattermostMilestone('threaded','dispatched','Specialist started.','action:dispatch',t0)!;
  assert.equal(first.channel_id,'channel-1');assert.equal(first.root_post_id,'root-1');assert.match(first.message,/Work started/);
  assert.equal(updates.queueMattermostMilestone('threaded','dispatched','duplicate','action:dispatch',new Date(t0.getTime()+1_000)),null);
  assert.equal(updates.queueMattermostMilestone('threaded','dispatched','cooldown duplicate','different-key',new Date(t0.getTime()+60_000)),null);
  assert.equal(updates.queueMattermostMilestone('unthreaded','dispatched','no destination','unthreaded-key',t0),null);
});

test('fenced outbox survives restart, delivers once, and records thread evidence',async()=>{
  db.run("UPDATE mattermost_task_update_outbox SET state='delivering',claim_owner='dead-process',claim_expires_at=?",[new Date(t0.getTime()-1).toISOString()]);
  let sends=0;let observed:any;
  const result=await updates.drainMattermostOutbox(t0,async item=>{sends++;observed=item;return{messageId:'post-1'}});
  assert.deepEqual(result,{delivered:1,failed:0});assert.equal(sends,1);assert.equal(observed.root_post_id,'root-1');
  assert.deepEqual(await updates.drainMattermostOutbox(new Date(t0.getTime()+1_000),async()=>{sends++;return{}}),{delivered:0,failed:0});assert.equal(sends,1);
  const stored=db.queryOne<{state:string;provider_message_id:string}>('SELECT state,provider_message_id FROM mattermost_task_update_outbox WHERE task_id=?',['threaded'])!;assert.equal(stored.state,'delivered');assert.equal(stored.provider_message_id,'post-1');
  assert.equal(db.queryOne<{n:number}>("SELECT COUNT(*) n FROM task_activities WHERE task_id='threaded' AND activity_type='mattermost_update_delivered'")!.n,1);
});

test('bounded retries end in failed without duplicate concurrent sends',async()=>{
  updates.queueMattermostMilestone('threaded','verification','Verifier engaged.','action:verify',new Date(t0.getTime()+20*60_000));
  const fail=async()=>{throw new Error('provider unavailable')};
  await updates.drainMattermostOutbox(new Date(t0.getTime()+20*60_000),fail);
  await updates.drainMattermostOutbox(new Date(t0.getTime()+22*60_000),fail);
  await updates.drainMattermostOutbox(new Date(t0.getTime()+24*60_000),fail);
  assert.equal(db.queryOne<{state:string;attempts:number}>("SELECT state,attempts FROM mattermost_task_update_outbox WHERE milestone='verification'")!.state,'failed');
  assert.equal(db.queryOne<{state:string;attempts:number}>("SELECT state,attempts FROM mattermost_task_update_outbox WHERE milestone='verification'")!.attempts,3);
  assert.equal(db.queryOne<{n:number}>("SELECT COUNT(*) n FROM task_activities WHERE task_id='threaded' AND activity_type='mattermost_update_failed'")!.n,1);
});
