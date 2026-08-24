import { createHash } from 'node:crypto';

export interface MattermostThreadIdentityInput {
  workspace_id: string;
  mattermost_account_id?: string | null;
  mattermost_channel_id?: string | null;
  mattermost_root_post_id?: string | null;
  mattermost_source_post_id?: string | null;
  mattermost_thread_url?: string | null;
}

export interface MattermostThreadIdentity {
  accountId: string;
  channelId: string;
  rootPostId: string;
  sourcePostId: string;
  threadUrl: string;
  lineageId: string;
}

export function resolveMattermostThreadIdentity(input: MattermostThreadIdentityInput): MattermostThreadIdentity | null {
  const values = [input.mattermost_channel_id, input.mattermost_root_post_id, input.mattermost_source_post_id, input.mattermost_thread_url];
  if (values.every(value => !value)) return null;
  if (values.some(value => !value)) throw new Error('Mattermost task origin requires channel, root post, source post, and thread URL');
  const accountId = input.mattermost_account_id || process.env.MC_MATTERMOST_ACCOUNT_ID || 'switch';
  const canonical = `${input.workspace_id}\0${accountId}\0${input.mattermost_channel_id}\0${input.mattermost_root_post_id}`;
  return {
    accountId,
    channelId: input.mattermost_channel_id!,
    rootPostId: input.mattermost_root_post_id!,
    sourcePostId: input.mattermost_source_post_id!,
    threadUrl: input.mattermost_thread_url!,
    lineageId: createHash('sha256').update(canonical).digest('hex'),
  };
}
