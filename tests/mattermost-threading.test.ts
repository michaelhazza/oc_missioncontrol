import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateTaskSchema, UpdateTaskSchema } from '../src/lib/validation';
import { buildMattermostThreadInstruction } from '../src/lib/openclaw/dispatch';
import type { Task } from '../src/lib/types';
import { resolveMattermostThreadIdentity } from '../src/lib/mattermost-thread-identity';

const baseTask = {
  id: 'task-1', title: 'Threaded task', status: 'inbox', priority: 'normal',
  assigned_agent_id: null, created_by_agent_id: null, workspace_id: 'default',
  business_id: 'default', created_at: '', updated_at: '',
} as Task;

test('task intake accepts and validates Mattermost thread identity', () => {
  const parsed = CreateTaskSchema.parse({
    title: 'Threaded task',
    mattermost_channel_id: 'channel-1',
    mattermost_root_post_id: 'root-1',
    mattermost_source_post_id: 'source-1',
    mattermost_thread_url: 'https://mm.example.com/team/pl/root-1',
  });
  assert.equal(parsed.mattermost_root_post_id, 'root-1');
  assert.throws(() => CreateTaskSchema.parse({ title: 'Partial', mattermost_channel_id: 'channel-1', mattermost_root_post_id: 'root-1' }));
  assert.throws(() => UpdateTaskSchema.parse({ mattermost_thread_url: 'not-a-url' }));
  assert.throws(() => UpdateTaskSchema.parse({ mattermost_channel_id: 'channel-2' }), /Canonical Mattermost/);
});

test('thread identity is deterministic while non-Mattermost tasks remain unchanged', () => {
  const first = resolveMattermostThreadIdentity({ workspace_id: 'default', mattermost_account_id: 'switch', mattermost_channel_id: 'channel-1', mattermost_root_post_id: 'root-1', mattermost_source_post_id: 'source-1', mattermost_thread_url: 'https://mm.example.com/team/pl/root-1' });
  const followUp = resolveMattermostThreadIdentity({ workspace_id: 'default', mattermost_account_id: 'switch', mattermost_channel_id: 'channel-1', mattermost_root_post_id: 'root-1', mattermost_source_post_id: 'reply-2', mattermost_thread_url: 'https://mm.example.com/team/pl/root-1' });
  assert.equal(first?.lineageId, followUp?.lineageId);
  assert.equal(resolveMattermostThreadIdentity({ workspace_id: 'default' }), null);
  assert.throws(() => resolveMattermostThreadIdentity({ workspace_id: 'default', mattermost_channel_id: 'channel-1' }), /requires channel/);
});

test('dispatch pins all user-visible output to the originating thread', () => {
  const instruction = buildMattermostThreadInstruction({
    ...baseTask,
    mattermost_account_id: 'switch',
    mattermost_channel_id: 'channel-1',
    mattermost_root_post_id: 'root-1',
    mattermost_thread_url: 'https://mm.example.com/team/pl/root-1',
  });
  assert.match(instruction, /root-1/);
  assert.match(instruction, /account `switch`/);
  assert.match(instruction, /Never default to the current conversation/);
  assert.match(instruction, /Do not post a new top-level DM message/);
  assert.match(instruction, /sole routine speaker/);
  assert.match(instruction, /token-stream fragments/);
  assert.equal(buildMattermostThreadInstruction(baseTask), '');
});
