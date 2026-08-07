import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { queryAll,queryOne,run,transaction } from '@/lib/db';

const execFile=promisify(execFileCallback);
const MAX_ATTEMPTS=3;
const CLAIM_MS=60_000;
const COOLDOWN_MS=15*60_000;

interface TaskDestination{id:string;title:string;mattermost_channel_id:string|null;mattermost_root_post_id:string|null}
export interface MilestoneDelivery{id:string;task_id:string;action_key:string;milestone:string;channel_id:string;root_post_id:string;message:string;state:string;attempts:number;not_before:string|null;claim_owner:string|null;claim_expires_at:string|null}

const semanticMessages:Record<string,(title:string,detail:string)=>string>={
  dispatched:(title,detail)=>`▶️ **Work started — ${title}**\n${detail}`,
  verification:(title,detail)=>`🔎 **Verification started — ${title}**\n${detail}`,
  rework:(title,detail)=>`↩️ **Rework required — ${title}**\n${detail}`,
  decision:(title,detail)=>`⏸️ **Decision required — ${title}**\n${detail}`,
  blocked:(title,detail)=>`⛔ **Task blocked — ${title}**\n${detail}`,
  completed:(title,detail)=>`✅ **Completion verified — ${title}**\n${detail}`,
  failed:(title,detail)=>`❌ **Task failed — ${title}**\n${detail}`,
};

export function queueMattermostMilestone(taskId:string,milestone:keyof typeof semanticMessages,detail:string,actionKey:string,now=new Date()):MilestoneDelivery|null{
  return transaction(()=>{
    const task=queryOne<TaskDestination>('SELECT id,title,mattermost_channel_id,mattermost_root_post_id FROM tasks WHERE id=?',[taskId]);
    if(!task?.mattermost_channel_id||!task.mattermost_root_post_id)return null;
    const previous=queryOne<{created_at:string;state:string}>(`SELECT created_at,state FROM mattermost_task_update_outbox WHERE task_id=? AND milestone=? AND state IN ('pending','delivering','delivered') ORDER BY created_at DESC LIMIT 1`,[taskId,milestone]);
    if(previous&&now.getTime()-Date.parse(previous.created_at)<COOLDOWN_MS)return null;
    const id=randomUUID(),iso=now.toISOString(),message=semanticMessages[milestone](task.title,detail);
    const inserted=run(`INSERT OR IGNORE INTO mattermost_task_update_outbox(id,task_id,action_key,milestone,channel_id,root_post_id,message,state,not_before,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`,[id,taskId,actionKey,milestone,task.mattermost_channel_id,task.mattermost_root_post_id,message,iso,iso,iso]);
    if(!inserted.changes)return null;
    run(`INSERT INTO task_activities(id,task_id,activity_type,message,metadata,created_at) VALUES(?,?,'mattermost_update_queued',?,?,?)`,[randomUUID(),taskId,`Queued Mattermost ${milestone} milestone`,JSON.stringify({outboxId:id,actionKey,rootPostId:task.mattermost_root_post_id}),iso]);
    return queryOne<MilestoneDelivery>('SELECT * FROM mattermost_task_update_outbox WHERE id=?',[id])!;
  });
}

export async function defaultMattermostSender(item:MilestoneDelivery):Promise<{messageId?:string}>{
  const {stdout}=await execFile('openclaw',['message','send','--account','switch','--channel','mattermost','--target',item.channel_id,'--reply-to',item.root_post_id,'--message',item.message,'--json'],{timeout:30_000,maxBuffer:1024*1024});
  return{messageId:parseProviderMessageId(stdout)};
}

export function parseProviderMessageId(stdout:string):string|undefined{
  const parsed=JSON.parse(stdout||'{}') as {messageId?:string;message_id?:string;id?:string;result?:{messageId?:string};payload?:{messageId?:string;result?:{messageId?:string}}};
  return parsed.messageId||parsed.message_id||parsed.id||parsed.result?.messageId||parsed.payload?.messageId||parsed.payload?.result?.messageId;
}

export async function drainMattermostOutbox(now=new Date(),sender=defaultMattermostSender):Promise<{delivered:number;failed:number}>{
  const owner=`mattermost:${randomUUID()}`,iso=now.toISOString();
  run("UPDATE mattermost_task_update_outbox SET state='pending',claim_owner=NULL,claim_expires_at=NULL WHERE state='delivering' AND claim_expires_at<=?",[iso]);
  const ids=queryAll<{id:string}>("SELECT id FROM mattermost_task_update_outbox WHERE state='pending' AND attempts<? AND (not_before IS NULL OR not_before<=?) ORDER BY created_at",[MAX_ATTEMPTS,iso]);
  let delivered=0,failed=0;
  for(const row of ids){
    const claim=run(`UPDATE mattermost_task_update_outbox SET state='delivering',claim_owner=?,claim_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='pending'`,[owner,new Date(now.getTime()+CLAIM_MS).toISOString(),iso,row.id]);
    if(!claim.changes)continue;
    const item=queryOne<MilestoneDelivery>('SELECT * FROM mattermost_task_update_outbox WHERE id=?',[row.id])!;
    try{
      const result=await sender(item);
      run("UPDATE mattermost_task_update_outbox SET state='delivered',provider_message_id=?,delivered_at=?,claim_owner=NULL,claim_expires_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND claim_owner=?",[result.messageId||null,iso,iso,item.id,owner]);
      run(`INSERT INTO task_activities(id,task_id,activity_type,message,metadata,created_at) VALUES(?,?,'mattermost_update_delivered',?,?,?)`,[randomUUID(),item.task_id,`Delivered Mattermost ${item.milestone} milestone in originating thread`,JSON.stringify({outboxId:item.id,rootPostId:item.root_post_id,providerMessageId:result.messageId||null}),iso]);
      delivered++;
    }catch(error){
      const message=error instanceof Error?error.message:String(error);failed++;
      run(`UPDATE mattermost_task_update_outbox SET state=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,last_error=?,not_before=?,claim_owner=NULL,claim_expires_at=NULL,updated_at=? WHERE id=? AND claim_owner=?`,[MAX_ATTEMPTS,message,new Date(now.getTime()+60_000).toISOString(),iso,item.id,owner]);
      const terminal=queryOne<{state:string}>('SELECT state FROM mattermost_task_update_outbox WHERE id=?',[item.id])?.state==='failed';
      if(terminal)run(`INSERT INTO task_activities(id,task_id,activity_type,message,metadata,created_at) VALUES(?,?,'mattermost_update_failed',?,?,?)`,[randomUUID(),item.task_id,`Mattermost ${item.milestone} milestone exhausted bounded retries`,JSON.stringify({outboxId:item.id,rootPostId:item.root_post_id,attempts:MAX_ATTEMPTS,error:message}),iso]);
    }
  }
  return{delivered,failed};
}

export function getMattermostOutbox(){return queryAll('SELECT * FROM mattermost_task_update_outbox ORDER BY created_at DESC')}
