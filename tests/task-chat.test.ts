import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-task-chat-'));
process.env.DATABASE_PATH = path.join(testDir, 'test.sqlite');
process.env.OPENCLAW_WEBHOOK_SECRET = 'test-only';

let db: typeof import('../src/lib/db');
let chat: typeof import('../src/lib/task-chat');

before(async () => {
  db = await import('../src/lib/db');
  chat = await import('../src/lib/task-chat');
  db.run("INSERT OR IGNORE INTO workspaces(id,name,slug) VALUES('default','Default','default')");
  db.run("INSERT INTO agents(id,name,role,workspace_id) VALUES('agent-a','Tank','Builder','default')");
  db.run("INSERT INTO agents(id,name,role,workspace_id) VALUES('agent-b','Roland','Researcher','default')");
  db.run("INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES('task-a','Chat A','in_progress','agent-a','default')");
  db.run("INSERT INTO tasks(id,title,status,assigned_agent_id,workspace_id) VALUES('task-b','Chat B','in_progress','agent-b','default')");
});

after(() => {
  db.closeDb();
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('messages are persisted, ordered, task-bound, and idempotent', () => {
  const first = chat.createTaskMessage('task-a', {
    content: 'First message', idempotencyKey: 'client-message-0001',
  });
  const duplicate = chat.createTaskMessage('task-a', {
    content: 'Changed text must not overwrite', idempotencyKey: 'client-message-0001',
  });
  chat.createTaskMessage('task-b', {
    content: 'Other task', idempotencyKey: 'client-message-0001',
  });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.message.id, first.message.id);
  assert.equal(chat.listTaskMessages('task-a').length, 1);
  assert.equal(chat.listTaskMessages('task-a')[0].content, 'First message');
  assert.equal(chat.listTaskMessages('task-b').length, 1);
});

test('only the assigned agent may write an agent reply', () => {
  const reply = chat.createTaskMessage('task-a', {
    content: 'Implemented.',
    senderType: 'agent',
    senderAgentId: 'agent-a',
    idempotencyKey: 'agent-reply-0000001',
  });
  assert.equal(reply.message.delivery_status, 'received');
  assert.equal(reply.message.sender_name, 'Tank');

  assert.throws(() => chat.createTaskMessage('task-a', {
    content: 'Wrong agent',
    senderType: 'agent',
    senderAgentId: 'agent-b',
    idempotencyKey: 'agent-reply-0000002',
  }), /currently assigned agent/);
});

test('failed delivery can be reset for an idempotent retry', () => {
  const original = chat.createTaskMessage('task-a', {
    content: 'Retry me', idempotencyKey: 'client-message-retry-1',
  }).message;
  db.run("UPDATE task_messages SET delivery_status='failed', delivery_error='offline' WHERE id=?", [original.id]);
  const retry = chat.createTaskMessage('task-a', {
    content: 'Retry me', idempotencyKey: 'client-message-retry-1', retry: true,
  });
  assert.equal(retry.created, false);
  assert.equal(retry.message.delivery_status, 'queued');
  assert.equal(retry.message.delivery_error, null);
});

test('task workspace uses near-full-screen responsive dimensions', () => {
  const modal = fs.readFileSync(path.join(process.cwd(), 'src/components/TaskModal.tsx'), 'utf8');
  assert.match(modal, /sm:w-\[96vw\]/);
  assert.match(modal, /h-\[96dvh\]/);
  assert.match(modal, /max-w-\[1600px\]/);
});
