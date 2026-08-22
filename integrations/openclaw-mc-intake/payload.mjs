export function buildIntakePayload(event,ctx,config){
  const metadata=event.metadata||{};
  const provider=String(metadata.channel||metadata.provider||ctx.channelId||'');
  const accountId=String(metadata.accountId||ctx.accountId||config.accountId);
  const senderId=String(event.senderId||ctx.senderId||'');
  const conversationId=String(metadata.channelId||metadata.channel_id||ctx.conversationId||'');
  // OpenClaw normalizes Mattermost DMs to `user:<sender id>` instead of
  // exposing the provider channel id to message_received hooks. The plugin is
  // already pinned to one account, sender and channel, so accept that canonical
  // DM identity and persist the configured provider channel id.
  const expectedDmConversation=`user:${config.senderId}`;
  const allowedConversation=conversationId===config.channelId||conversationId===config.senderId||conversationId===expectedDmConversation;
  if(provider!=='mattermost'||accountId!==config.accountId||senderId!==config.senderId||!allowedConversation)return null;
  const channelId=String(config.channelId);
  const source=String(event.messageId||ctx.messageId||'');if(!source||!event.content.trim())return null;
  const root=String(event.threadId||event.replyToId||ctx.replyToId||source);
  return {workspace_id:config.workspaceId,mattermost_account_id:accountId,provider_event_id:`mattermost:${source}:${event.timestamp||0}`,sender_id:senderId,channel_id:channelId,channel_type:'D',root_post_id:root,source_post_id:source,message:event.content,provider_created_at:new Date(event.timestamp||Date.now()).toISOString(),event_kind:'created'};
}
