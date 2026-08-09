import { getOpenClawClient } from './client';
import { markRecoveryDelivered, markRecoveryDeliveryFailed, reconcileExecutions, RECONCILE_INTERVAL_MS, type RecoveryAction } from './execution-supervision';
import { queryOne } from '@/lib/db';

let watchdogInterval:NodeJS.Timeout|null=null;

async function deliver(action:RecoveryAction):Promise<void>{
  const client=getOpenClawClient();
  if(!client.isConnected()) await client.connect();
  if(action.kind==='resume'){
    await client.call('chat.send',{
      sessionKey:action.run.session_key,
      idempotencyKey:action.recoveryKey,
      message:`Mission Control durable recovery: re-fetch task ${action.run.task_id} from Mission Control, then continue it from the last persisted checkpoint. The current task brief is authoritative. Recovery lease epoch ${action.run.lease_epoch} is authoritative. Do not restart completed work or create a second worker. POST heartbeats with this lease owner/epoch every 1–2 minutes, and finish only with an explicit terminal transition.`,
    });
    return;
  }
  const oracle=queryOne<{session_key_prefix:string|null;gateway_agent_id:string}>('SELECT session_key_prefix,gateway_agent_id FROM agents WHERE lower(name)=? LIMIT 1',['oracle']);
  if(!oracle) throw new Error('Oracle agent is not registered');
  const sessionKey=`${oracle.session_key_prefix||`agent:${oracle.gateway_agent_id}:`}mission-control-recovery`;
  await client.call('chat.send',{
    sessionKey,
    idempotencyKey:action.recoveryKey,
    message:`Oracle recovery escalation: task ${action.run.task_id}, execution ${action.run.id}, is stalled after bounded automatic recovery. Inspect Mission Control evidence, acknowledge the incident, and either reassign through the execution recovery API or leave it stalled with a specific diagnosis. Do not create an untracked worker. Remain silent in the originating Mattermost thread unless recovery needs a decision from Michael; routine recovery belongs only in Mission Control.`,
  });
}

export async function runTaskWatchdogCheck(now=new Date()):Promise<'no-task'|'active'|'resumed'|'escalated'|'partial'> {
  const actions=reconcileExecutions(now);
  if(actions.length===0)return 'no-task';
  let resumed=0,escalated=0,failed=0;
  for(const action of actions){
    try{
      await deliver(action);
      markRecoveryDelivered(action);
      if(action.kind==='resume') resumed++;
      else escalated++;
    }
    catch(error){failed++;markRecoveryDeliveryFailed(action,error);console.error(`[ExecutionSupervisor] ${action.kind} delivery failed for ${action.run.task_id}:`,error);}
  }
  if(failed)return 'partial';
  if(escalated)return 'escalated';
  return resumed?'resumed':'active';
}

export function startTaskWatchdog():void{
  if(watchdogInterval||process.env.MISSION_CONTROL_TASK_WATCHDOG==='disabled')return;
  console.log(`[ExecutionSupervisor] One-minute reconciliation backstop enabled; leases/heartbeats remain primary`);
  void runTaskWatchdogCheck().catch(error=>console.error('[ExecutionSupervisor] Initial reconciliation failed:',error));
  watchdogInterval=setInterval(()=>void runTaskWatchdogCheck().catch(error=>console.error('[ExecutionSupervisor] Reconciliation failed:',error)),RECONCILE_INTERVAL_MS);
}

export function stopTaskWatchdog():void{
  if(watchdogInterval)clearInterval(watchdogInterval);
  watchdogInterval=null;
}
