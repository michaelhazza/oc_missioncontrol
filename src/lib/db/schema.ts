/**
 * Database Schema for Mission Control
 * 
 * This defines the current desired schema state.
 * For existing databases, migrations handle schema updates.
 * 
 * IMPORTANT: When adding new tables or columns:
 * 1. Add them here for new databases
 * 2. Create a migration in migrations.ts for existing databases
 */

export const schema = `
-- Workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT DEFAULT '📁',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT,
  avatar_emoji TEXT DEFAULT '🤖',
  status TEXT DEFAULT 'standby' CHECK (status IN ('standby', 'working', 'offline')),
  is_master INTEGER DEFAULT 0,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  soul_md TEXT,
  user_md TEXT,
  agents_md TEXT,
  model TEXT,
  source TEXT DEFAULT 'local',
  gateway_agent_id TEXT,
  session_key_prefix TEXT,
  mattermost_channel TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Tasks table (Mission Queue)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'inbox' CHECK (status IN ('pending_dispatch', 'planning', 'inbox', 'assigned', 'in_progress', 'testing', 'review', 'verification', 'blocked', 'done')),
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_agent_id TEXT REFERENCES agents(id),
  created_by_agent_id TEXT REFERENCES agents(id),
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  business_id TEXT DEFAULT 'default',
  due_date TEXT,
  workflow_template_id TEXT REFERENCES workflow_templates(id),
  planning_session_key TEXT,
  planning_messages TEXT,
  planning_complete INTEGER DEFAULT 0,
  planning_spec TEXT,
  planning_agents TEXT,
  planning_dispatch_error TEXT,
  status_reason TEXT,
  gateway_task_id TEXT,
  sync_status TEXT DEFAULT 'local' CHECK (sync_status IN ('local', 'synced', 'pending_sync', 'sync_failed')),
  retry_count INTEGER DEFAULT 0,
  last_sync_attempt TEXT,
  gateway_completion_notes TEXT,
  brief TEXT,
  trigger_type TEXT DEFAULT 'manual' CHECK (trigger_type IN ('manual', 'cron', 'agent', 'webhook')),
  trigger_source TEXT,
  cron_job_id TEXT,
  mattermost_channel_id TEXT,
  mattermost_root_post_id TEXT,
  mattermost_source_post_id TEXT,
  mattermost_thread_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Task dependency graph. A task remains pending_dispatch until every
-- prerequisite task has reached done.
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id != depends_on_task_id)
);

-- Planning questions table
CREATE TABLE IF NOT EXISTS planning_questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  question_type TEXT DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'text', 'yes_no')),
  options TEXT,
  answer TEXT,
  answered_at TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Planning specs table (locked specifications)
CREATE TABLE IF NOT EXISTS planning_specs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  spec_markdown TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  locked_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Conversations table (agent-to-agent or task-related)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'task')),
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Conversation participants
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, agent_id)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  sender_agent_id TEXT REFERENCES agents(id),
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'task_update', 'file')),
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Events table (for live feed)
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Businesses/Workspaces table (legacy - kept for compatibility)
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- OpenClaw session mapping
CREATE TABLE IF NOT EXISTS openclaw_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  openclaw_session_id TEXT NOT NULL,
  channel TEXT,
  status TEXT DEFAULT 'active',
  session_type TEXT DEFAULT 'persistent',
  task_id TEXT REFERENCES tasks(id),
  ended_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Durable ownership and recovery state for agent task executions. Mission
-- Control remains authoritative; a task marked in_progress is healthy only
-- while its live run owns a recent renewable lease.
CREATE TABLE IF NOT EXISTS task_execution_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  session_key TEXT NOT NULL,
  run_identity TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running'
    CHECK (state IN ('running','waiting_input','blocked','stalled','recovering','failed','cancelled','complete')),
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  checkpoint TEXT,
  checkpoint_at TEXT,
  resume_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  recovery_not_before TEXT,
  last_failure_code TEXT,
  last_failure_detail TEXT,
  oracle_status TEXT NOT NULL DEFAULT 'none'
    CHECK (oracle_status IN ('none','pending','acknowledged','resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE(task_id, run_identity)
);

CREATE TABLE IF NOT EXISTS task_execution_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_execution_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  lease_epoch INTEGER,
  payload TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, event_key)
);

CREATE TABLE IF NOT EXISTS completion_controller_scans (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('dry_run','active')),
  owner_id TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
  task_count INTEGER NOT NULL DEFAULT 0, actionable_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0, summary TEXT
);
CREATE TABLE IF NOT EXISTS task_reconciliations (
  id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES completion_controller_scans(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, classification TEXT NOT NULL,
  fingerprint TEXT NOT NULL, proposed_action TEXT, reason TEXT NOT NULL, evidence TEXT,
  created_at TEXT NOT NULL, UNIQUE(scan_id,task_id)
);
CREATE TABLE IF NOT EXISTS completion_controller_actions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action_key TEXT NOT NULL UNIQUE, action_type TEXT NOT NULL, authority TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('proposed','pending','executing','completed','failed','cancelled')),
  payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, not_before TEXT,
  last_error TEXT, claim_owner TEXT, claim_expires_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  delivered_at TEXT, resolution_status TEXT, resolved_at TEXT, resolution_note TEXT
);
CREATE TABLE IF NOT EXISTS completion_controller_lease (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);

-- Durable, fenced, thread-rooted semantic Mattermost updates. Heartbeats are
-- deliberately excluded; only material task milestones enter this outbox.
CREATE TABLE IF NOT EXISTS mattermost_task_update_outbox (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action_key TEXT NOT NULL UNIQUE,
  milestone TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_post_id TEXT NOT NULL,
  message TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','delivering','delivered','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT, claim_owner TEXT, claim_expires_at TEXT,
  provider_message_id TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT
);

-- Workflow templates (per-workspace workflow definitions)
CREATE TABLE IF NOT EXISTS workflow_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  name TEXT NOT NULL,
  description TEXT,
  stages TEXT NOT NULL,
  fail_targets TEXT,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Task role assignments (role -> agent mapping per task)
CREATE TABLE IF NOT EXISTS task_roles (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(task_id, role)
);

-- Knowledge entries (learner knowledge base)
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  task_id TEXT REFERENCES tasks(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  confidence REAL DEFAULT 0.5,
  created_by_agent_id TEXT REFERENCES agents(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Task activities table (for real-time activity log)
CREATE TABLE IF NOT EXISTS task_activities (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id),
  activity_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Task deliverables table (files, URLs, artifacts)
CREATE TABLE IF NOT EXISTS task_deliverables (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  deliverable_type TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Criteria-level completion contracts. Existing tasks without a contract retain
-- the legacy completion path; every newly created task receives a contract.
CREATE TABLE IF NOT EXISTS task_completion_contracts (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  required INTEGER NOT NULL DEFAULT 1,
  verification_max_age_minutes INTEGER NOT NULL DEFAULT 1440,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_acceptance_criteria (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','passed','waived')),
  evidence TEXT,
  verified_at TEXT,
  verifier_agent_id TEXT REFERENCES agents(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_protected_boundaries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','intact','violated','waived')),
  evidence TEXT,
  verified_at TEXT,
  verifier_agent_id TEXT REFERENCES agents(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_completion_reports (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  plan_vs_actual TEXT NOT NULL,
  deviations TEXT NOT NULL DEFAULT '[]',
  deferred_work TEXT NOT NULL DEFAULT '[]',
  verification_commands TEXT NOT NULL DEFAULT '[]',
  verification_ran_at TEXT NOT NULL,
  next_action TEXT NOT NULL,
  submitted_by_agent_id TEXT REFERENCES agents(id),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Workspace settings (per-workspace integration configuration)
CREATE TABLE IF NOT EXISTS workspace_settings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
  gateway_url TEXT,
  webhook_secret TEXT,
  polling_interval_seconds INTEGER DEFAULT 60,
  state_mapping TEXT DEFAULT '{"queued":"inbox","assigned":"in_progress","running":"in_progress","completed":"done","failed":"blocked"}',
  max_retry_count INTEGER DEFAULT 5,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_prerequisite ON task_dependencies(depends_on_task_id);
CREATE INDEX IF NOT EXISTS idx_acceptance_criteria_task ON task_acceptance_criteria(task_id,sort_order);
CREATE INDEX IF NOT EXISTS idx_protected_boundaries_task ON task_protected_boundaries(task_id,sort_order);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_activities_task ON task_activities(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverables_task ON task_deliverables(task_id);
CREATE INDEX IF NOT EXISTS idx_openclaw_sessions_task ON openclaw_sessions(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_execution_one_live ON task_execution_runs(task_id)
  WHERE state IN ('running','waiting_input','blocked','stalled','recovering');
CREATE INDEX IF NOT EXISTS idx_task_execution_reconcile
  ON task_execution_runs(state, lease_expires_at, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_task_execution_events_task
  ON task_execution_events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_controller_actions_queue ON completion_controller_actions(state,not_before,created_at);
CREATE INDEX IF NOT EXISTS idx_controller_actions_claim ON completion_controller_actions(state,not_before,claim_expires_at);
CREATE INDEX IF NOT EXISTS idx_mattermost_task_update_delivery ON mattermost_task_update_outbox(state,not_before,claim_expires_at,created_at);
CREATE INDEX IF NOT EXISTS idx_mattermost_task_update_cooldown ON mattermost_task_update_outbox(task_id,milestone,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliations_task ON task_reconciliations(task_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_planning_questions_task ON planning_questions(task_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_workspace ON workflow_templates(workspace_id);
CREATE INDEX IF NOT EXISTS idx_task_roles_task ON task_roles(task_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_workspace ON knowledge_entries(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_task ON knowledge_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_sync_status ON tasks(sync_status);
CREATE INDEX IF NOT EXISTS idx_tasks_gateway_task_id ON tasks(gateway_task_id);
CREATE INDEX IF NOT EXISTS idx_workspace_settings_workspace ON workspace_settings(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_cron_job_id ON tasks(cron_job_id);
`;
