import { createHmac } from 'node:crypto';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { buildIntakePayload } from './payload.mjs';

export default definePluginEntry({id:'mission-control-intake',name:'Mission Control DM Intake',description:'Captures allowlisted inbound Mattermost DM threads in Mission Control.',register(api){
  const config=api.pluginConfig;
  api.on('message_received',async(event,ctx)=>{const payload=buildIntakePayload(event,ctx,config);if(!payload)return;const raw=JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',config.secret).update(`${timestamp}.${raw}`).digest('hex');try{const response=await fetch(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-mc-timestamp':timestamp,'x-mc-signature':`sha256=${signature}`},body:raw,signal:AbortSignal.timeout(5000)});if(!response.ok)api.logger.error(`Mission Control intake rejected ${response.status}: ${(await response.text()).slice(0,300)}`);}catch(error){api.logger.error(`Mission Control intake unavailable: ${error instanceof Error?error.message:String(error)}`);}}, {priority:50});
}});
