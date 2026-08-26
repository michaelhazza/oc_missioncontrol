import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { buildIntakePayload } from './payload.mjs';
import { deliverIntakePayload } from './delivery.mjs';

export default definePluginEntry({id:'mission-control-intake',name:'Mission Control DM Intake',description:'Captures allowlisted inbound Mattermost DM threads in Mission Control.',register(api){
  const config=api.pluginConfig;
  api.on('message_received',async(event,ctx)=>{const payload=buildIntakePayload(event,ctx,config);if(!payload)return;const result=await deliverIntakePayload(payload,config);if(!result.ok)api.logger.error(result.status?`Mission Control intake rejected ${result.status} after ${result.attempts} attempt(s): ${result.detail}`:`Mission Control intake unavailable after ${result.attempts} attempt(s): ${result.error}`);}, {priority:50});
}});
