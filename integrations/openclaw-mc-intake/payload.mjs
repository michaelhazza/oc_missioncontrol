export function buildIntakePayload(event,ctx,config){
  const metadata=event.metadata||{};
  const provider=String(metadata.channel||metadata.provider||ctx.channelId||'');
  const accountId=String(metadata.accountId||ctx.accountId||config.accountId);
  const senderId=String(event.senderId||ctx.senderId||'');
  const channelId=String(metadata.channelId||metadata.channel_id||ctx.conversationId||'');
  if(provider!=='mattermost'||accountId!==config.accountId||senderId!==config.senderId||channelId!==config.channelId)return null;
  const source=String(event.messageId||ctx.messageId||'');if(!source||!event.content.trim())return null;
  const root=String(event.threadId||event.replyToId||ctx.replyToId||source);
  return {workspace_id:config.workspaceId,mattermost_account_id:accountId,provider_event_id:`mattermost:${source}:${event.timestamp||0}`,sender_id:senderId,channel_id:channelId,channel_type:'D',root_post_id:root,source_post_id:source,message:event.content,provider_created_at:new Date(event.timestamp||Date.now()).toISOString(),event_kind:'created'};
}
