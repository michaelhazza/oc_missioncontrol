import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateTaskSchema, UpdateTaskSchema } from '../src/lib/validation';
import { buildMattermostThreadInstruction } from '../src/lib/openclaw/dispatch';
import type { Task } from '../src/lib/types';

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
  assert.throws(() => UpdateTaskSchema.parse({ mattermost_thread_url: 'not-a-url' }));
});

test('dispatch pins all user-visible output to the originating thread', () => {
  const instruction = buildMattermostThreadInstruction({
    ...baseTask,
    mattermost_channel_id: 'channel-1',
    mattermost_root_post_id: 'root-1',
    mattermost_thread_url: 'https://mm.example.com/team/pl/root-1',
  });
  assert.match(instruction, /root-1/);
  assert.match(instruction, /Do not post a new top-level DM message/);
  assert.match(instruction, /sole routine speaker/);
  assert.match(instruction, /token-stream fragments/);
  assert.equal(buildMattermostThreadInstruction(baseTask), '');
});
