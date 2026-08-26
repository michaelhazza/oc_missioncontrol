/**
 * Database Migrations System
 * 
 * Handles schema changes in a production-safe way:
 * 1. Tracks which migrations have been applied
 * 2. Runs new migrations automatically on startup
 * 3. Never runs the same migration twice
 */

import Database from 'better-sqlite3';
import { bootstrapCoreAgentsRaw } from '@/lib/bootstrap-agents';

interface Migration {
  id: string;
  name: string;
  up: (db: Database.Database) => void;
}

// All migrations in order - NEVER remove or reorder existing migrations
const migrations: Migration[] = [
  {
    id: '001',
    name: 'initial_schema',
    up: (db) => {
      // Core tables - these are created in schema.ts on fresh databases
      // This migration exists to mark the baseline for existing databases
      console.log('[Migration 001] Baseline schema marker');
    }
  },
  {
    id: '002',
    name: 'add_workspaces',
    up: (db) => {
      console.log('[Migration 002] Adding workspaces table and columns...');
      
      // Create workspaces table if not exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT,
          icon TEXT DEFAULT '📁',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
      
      // Insert default workspace if not exists
      db.exec(`
        INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon) 
        VALUES ('default', 'Default Workspace', 'default', 'Default workspace', '🏠');
      `);
      
      // Add workspace_id to tasks if not exists
      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!tasksInfo.some(col => col.name === 'workspace_id')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id)`);
        console.log('[Migration 002] Added workspace_id to tasks');
      }
      
      // Add workspace_id to agents if not exists
      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      if (!agentsInfo.some(col => col.name === 'workspace_id')) {
        db.exec(`ALTER TABLE agents ADD COLUMN workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id)`);
        console.log('[Migration 002] Added workspace_id to agents');
      }
    }
  },
  {
    id: '003',
    name: 'add_planning_tables',
    up: (db) => {
      console.log('[Migration 003] Adding planning tables...');
      
      // Create planning_questions table if not exists
      db.exec(`
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
      `);
      
      // Create planning_specs table if not exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS planning_specs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          spec_markdown TEXT NOT NULL,
          locked_at TEXT NOT NULL,
          locked_by TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
      
      // Create index
      db.exec(`CREATE INDEX IF NOT EXISTS idx_planning_questions_task ON planning_questions(task_id, sort_order)`);
      
      // Update tasks status check constraint to include 'planning'
      // SQLite doesn't support ALTER CONSTRAINT, so we check if it's needed
      const taskSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
      if (taskSchema && !taskSchema.sql.includes("'planning'")) {
        console.log('[Migration 003] Note: tasks table needs planning status - will be handled by schema recreation on fresh dbs');
      }
    }
  },
  {
    id: '004',
    name: 'add_planning_session_columns',
    up: (db) => {
      console.log('[Migration 004] Adding planning session columns to tasks...');

      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];

      // Add planning_session_key column
      if (!tasksInfo.some(col => col.name === 'planning_session_key')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_session_key TEXT`);
        console.log('[Migration 004] Added planning_session_key');
      }

      // Add planning_messages column (stores JSON array of messages)
      if (!tasksInfo.some(col => col.name === 'planning_messages')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_messages TEXT`);
        console.log('[Migration 004] Added planning_messages');
      }

      // Add planning_complete column
      if (!tasksInfo.some(col => col.name === 'planning_complete')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_complete INTEGER DEFAULT 0`);
        console.log('[Migration 004] Added planning_complete');
      }

      // Add planning_spec column (stores final spec JSON)
      if (!tasksInfo.some(col => col.name === 'planning_spec')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_spec TEXT`);
        console.log('[Migration 004] Added planning_spec');
      }

      // Add planning_agents column (stores generated agents JSON)
      if (!tasksInfo.some(col => col.name === 'planning_agents')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_agents TEXT`);
        console.log('[Migration 004] Added planning_agents');
      }
    }
  },
  {
    id: '005',
    name: 'add_agent_model_field',
    up: (db) => {
      console.log('[Migration 005] Adding model field to agents...');

      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];

      // Add model column
      if (!agentsInfo.some(col => col.name === 'model')) {
        db.exec(`ALTER TABLE agents ADD COLUMN model TEXT`);
        console.log('[Migration 005] Added model to agents');
      }
    }
  },
  {
    id: '006',
    name: 'add_planning_dispatch_error_column',
    up: (db) => {
      console.log('[Migration 006] Adding planning_dispatch_error column to tasks...');

      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];

      // Add planning_dispatch_error column
      if (!tasksInfo.some(col => col.name === 'planning_dispatch_error')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_dispatch_error TEXT`);
        console.log('[Migration 006] Added planning_dispatch_error to tasks');
      }
    }
  },
  {
    id: '007',
    name: 'add_agent_source_and_gateway_id',
    up: (db) => {
      console.log('[Migration 007] Adding source and gateway_agent_id to agents...');

      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];

      // Add source column: 'local' for MC-created, 'gateway' for imported from OpenClaw Gateway
      if (!agentsInfo.some(col => col.name === 'source')) {
        db.exec(`ALTER TABLE agents ADD COLUMN source TEXT DEFAULT 'local'`);
        console.log('[Migration 007] Added source to agents');
      }

      // Add gateway_agent_id column: stores the original agent ID/name from the Gateway
      if (!agentsInfo.some(col => col.name === 'gateway_agent_id')) {
        db.exec(`ALTER TABLE agents ADD COLUMN gateway_agent_id TEXT`);
        console.log('[Migration 007] Added gateway_agent_id to agents');
      }
    }
  },
  {
    id: '008',
    name: 'add_status_reason_column',
    up: (db) => {
      console.log('[Migration 008] Adding status_reason column to tasks...');

      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];

      if (!tasksInfo.some(col => col.name === 'status_reason')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN status_reason TEXT`);
        console.log('[Migration 008] Added status_reason to tasks');
      }
    }
  },
  {
    id: '009',
    name: 'add_agent_session_key_prefix',
    up: (db) => {
      console.log('[Migration 009] Adding session_key_prefix to agents...');

      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];

      if (!agentsInfo.some(col => col.name === 'session_key_prefix')) {
        db.exec(`ALTER TABLE agents ADD COLUMN session_key_prefix TEXT`);
        console.log('[Migration 009] Added session_key_prefix to agents');
      }
    }
  },
  {
    id: '010',
    name: 'add_workflow_templates_roles_knowledge',
    up: (db) => {
      console.log('[Migration 010] Adding workflow templates, task roles, and knowledge tables...');

      // Create workflow_templates table
      db.exec(`
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
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_templates_workspace ON workflow_templates(workspace_id)`);

      // Create task_roles table
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_roles (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(task_id, role)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_roles_task ON task_roles(task_id)`);

      // Create knowledge_entries table
      db.exec(`
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
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_entries_workspace ON knowledge_entries(workspace_id, created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_entries_task ON knowledge_entries(task_id)`);

      // Add workflow_template_id to tasks
      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!tasksInfo.some(col => col.name === 'workflow_template_id')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN workflow_template_id TEXT REFERENCES workflow_templates(id)`);
        console.log('[Migration 010] Added workflow_template_id to tasks');
      }

      // Recreate tasks table to add 'verification' + 'pending_dispatch' to status CHECK constraint
      // SQLite doesn't support ALTER CONSTRAINT, so we need table recreation
      const taskSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
      if (taskSchema && !taskSchema.sql.includes("'verification'")) {
        console.log('[Migration 010] Recreating tasks table to add verification status...');

        // Get current column names from the old table
        const oldCols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(c => c.name);
        const hasWorkflowCol = oldCols.includes('workflow_template_id');

        db.exec(`ALTER TABLE tasks RENAME TO _tasks_old_010`);
        db.exec(`
          CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            status TEXT DEFAULT 'inbox' CHECK (status IN ('pending_dispatch', 'planning', 'inbox', 'assigned', 'in_progress', 'testing', 'review', 'verification', 'done')),
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
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          )
        `);

        // Copy data with explicit column mapping
        const sharedCols = 'id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, planning_session_key, planning_messages, planning_complete, planning_spec, planning_agents, planning_dispatch_error, status_reason, created_at, updated_at';

        if (hasWorkflowCol) {
          db.exec(`
            INSERT INTO tasks (${sharedCols}, workflow_template_id)
            SELECT ${sharedCols}, workflow_template_id FROM _tasks_old_010
          `);
        } else {
          db.exec(`
            INSERT INTO tasks (${sharedCols})
            SELECT ${sharedCols} FROM _tasks_old_010
          `);
        }

        db.exec(`DROP TABLE _tasks_old_010`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id)`);
        console.log('[Migration 010] Tasks table recreated with verification status');
      }

      // Seed default workflow templates for the 'default' workspace
      const existingTemplates = db.prepare('SELECT COUNT(*) as count FROM workflow_templates').get() as { count: number };
      if (existingTemplates.count === 0) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
          VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'tpl-simple',
          'Simple',
          'Builder only — for quick, straightforward tasks',
          JSON.stringify([
            { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
            { id: 'done', label: 'Done', role: null, status: 'done' }
          ]),
          JSON.stringify({}),
          0, now, now
        );

        db.prepare(`
          INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
          VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'tpl-standard',
          'Standard',
          'Builder → Tester → Reviewer — for most projects',
          JSON.stringify([
            { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
            { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
            { id: 'review', label: 'Review', role: 'reviewer', status: 'review' },
            { id: 'done', label: 'Done', role: null, status: 'done' }
          ]),
          JSON.stringify({ testing: 'in_progress', review: 'in_progress' }),
          1, now, now
        );

        db.prepare(`
          INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
          VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'tpl-strict',
          'Strict',
          'Builder → Tester → Verifier + Learner — for critical projects',
          JSON.stringify([
            { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
            { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
            { id: 'review', label: 'Review', role: null, status: 'review' },
            { id: 'verify', label: 'Verify', role: 'verifier', status: 'verification' },
            { id: 'done', label: 'Done', role: null, status: 'done' }
          ]),
          JSON.stringify({ testing: 'in_progress', review: 'in_progress', verification: 'in_progress' }),
          0, now, now
        );

        console.log('[Migration 010] Seeded default workflow templates');
      }
    }
  },
  {
    id: '011',
    name: 'fix_broken_fk_references',
    up: (db) => {
      // Migration 010 renamed tasks → _tasks_old_010, which caused SQLite to
      // rewrite FK references in ALL child tables to point to "_tasks_old_010".
      // After dropping _tasks_old_010, those FK references became dangling.
      // Fix: recreate affected tables with correct FK references.
      console.log('[Migration 011] Fixing broken FK references from migration 010...');

      const broken = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%_tasks_old_010%'`
      ).all() as { name: string }[];

      if (broken.length === 0) {
        console.log('[Migration 011] No broken FK references found — skipping');
        return;
      }

      // Table definitions with correct FK references to tasks(id)
      const tableDefinitions: Record<string, string> = {
        planning_questions: `CREATE TABLE planning_questions (
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
        )`,
        planning_specs: `CREATE TABLE planning_specs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          spec_markdown TEXT NOT NULL,
          locked_at TEXT NOT NULL,
          locked_by TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        conversations: `CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          title TEXT,
          type TEXT DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'task')),
          task_id TEXT REFERENCES tasks(id),
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )`,
        events: `CREATE TABLE events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          agent_id TEXT REFERENCES agents(id),
          task_id TEXT REFERENCES tasks(id),
          message TEXT NOT NULL,
          metadata TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        openclaw_sessions: `CREATE TABLE openclaw_sessions (
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
        )`,
        task_activities: `CREATE TABLE task_activities (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent_id TEXT REFERENCES agents(id),
          activity_type TEXT NOT NULL,
          message TEXT NOT NULL,
          metadata TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        task_deliverables: `CREATE TABLE task_deliverables (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          deliverable_type TEXT NOT NULL,
          title TEXT NOT NULL,
          path TEXT,
          description TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        task_roles: `CREATE TABLE task_roles (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(task_id, role)
        )`,
      };

      for (const { name } of broken) {
        const newSql = tableDefinitions[name];
        if (!newSql) {
          console.warn(`[Migration 011] No definition for table ${name} — skipping`);
          continue;
        }

        // Get column names from old table
        const cols = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[])
          .map(c => c.name).join(', ');

        const tmpName = `_${name}_fix_011`;
        db.exec(`ALTER TABLE ${name} RENAME TO ${tmpName}`);
        db.exec(newSql);
        db.exec(`INSERT INTO ${name} (${cols}) SELECT ${cols} FROM ${tmpName}`);
        db.exec(`DROP TABLE ${tmpName}`);
        console.log(`[Migration 011] Recreated table: ${name}`);
      }

      // Recreate indexes for affected tables
      db.exec(`CREATE INDEX IF NOT EXISTS idx_planning_questions_task ON planning_questions(task_id, sort_order)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_roles_task ON task_roles(task_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_activities_task ON task_activities(task_id, created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_deliverables_task ON task_deliverables(task_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_openclaw_sessions_task ON openclaw_sessions(task_id)`);

      console.log('[Migration 011] All broken FK references fixed');
    }
  },
  {
    id: '012',
    name: 'fix_strict_template_review_queue',
    up: (db) => {
      // Update Strict template: review is a queue (no role), verification is the active QC step.
      // Also fix the seed data in migration 010 for new databases.
      console.log('[Migration 012] Updating Strict workflow template...');

      const strictStages = JSON.stringify([
        { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
        { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
        { id: 'review', label: 'Review', role: null, status: 'review' },
        { id: 'verify', label: 'Verify', role: 'verifier', status: 'verification' },
        { id: 'done', label: 'Done', role: null, status: 'done' }
      ]);

      const updated = db.prepare(
        `UPDATE workflow_templates
         SET stages = ?, description = ?, updated_at = datetime('now')
         WHERE id = 'tpl-strict'`
      ).run(strictStages, 'Builder → Tester → Verifier + Learner — for critical projects');

      if (updated.changes > 0) {
        console.log('[Migration 012] Strict template updated (review is now a queue)');
      } else {
        console.log('[Migration 012] No tpl-strict found — will be correct on fresh seed');
      }
    }
  },
  {
    id: '013',
    name: 'reset_fresh_start',
    up: (db) => {
      console.log('[Migration 013] Fresh start — wiping all data and bootstrapping...');

      // 1. Delete all row data (keep workspaces + workflow_templates infrastructure)
      const tablesToWipe = [
        'task_roles',
        'task_activities',
        'task_deliverables',
        'planning_questions',
        'planning_specs',
        'knowledge_entries',
        'messages',
        'conversation_participants',
        'conversations',
        'events',
        'openclaw_sessions',
        'agents',
        'tasks',
      ];
      for (const table of tablesToWipe) {
        try {
          db.exec(`DELETE FROM ${table}`);
          console.log(`[Migration 013] Wiped ${table}`);
        } catch (err) {
          // Table might not exist on fresh DBs — skip silently
          console.log(`[Migration 013] Table ${table} not found — skipping`);
        }
      }

      // 2. Make Strict the default template, Standard non-default
      db.exec(`UPDATE workflow_templates SET is_default = 0 WHERE id = 'tpl-standard'`);
      db.exec(`UPDATE workflow_templates SET is_default = 1 WHERE id = 'tpl-strict'`);

      // 3. Fix Strict template: verification role → 'reviewer' (was 'verifier')
      const fixedStages = JSON.stringify([
        { id: 'build',  label: 'Build',  role: 'builder',  status: 'in_progress' },
        { id: 'test',   label: 'Test',   role: 'tester',   status: 'testing' },
        { id: 'review', label: 'Review', role: null,        status: 'review' },
        { id: 'verify', label: 'Verify', role: 'reviewer',  status: 'verification' },
        { id: 'done',   label: 'Done',   role: null,        status: 'done' },
      ]);
      db.prepare(
        `UPDATE workflow_templates SET stages = ?, description = ?, updated_at = datetime('now') WHERE id = 'tpl-strict'`
      ).run(fixedStages, 'Builder → Tester → Reviewer + Learner — for critical projects');

      console.log('[Migration 013] Strict template is now default with reviewer role');

      // 4. Bootstrap 4 core agents for the default workspace
      const missionControlUrl = process.env.MISSION_CONTROL_URL || 'http://localhost:4000';
      bootstrapCoreAgentsRaw(db, 'default', missionControlUrl);

      console.log('[Migration 013] Fresh start complete');
    }
  },
  {
    id: '014',
    name: 'add_content_items',
    up: (db) => {
      console.log('[Migration 014] Adding content_items table...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS content_items (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          platform TEXT DEFAULT 'youtube',
          stage TEXT DEFAULT 'idea' CHECK (stage IN ('idea', 'script', 'thumbnail', 'filming', 'published')),
          script TEXT,
          thumbnail_url TEXT,
          notes TEXT,
          workspace_id TEXT DEFAULT 'default',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_content_items_workspace ON content_items(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_content_items_stage ON content_items(stage);
      `);
      console.log('[Migration 014] content_items table created');
    }
  },
  {
    id: '015',
    name: 'add_task_gateway_sync_columns',
    up: (db) => {
      console.log('[Migration 015] Adding gateway sync columns to tasks...');

      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];

      if (!tasksInfo.some(col => col.name === 'gateway_task_id')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN gateway_task_id TEXT`);
      }
      if (!tasksInfo.some(col => col.name === 'sync_status')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN sync_status TEXT DEFAULT 'local'`);
      }
      if (!tasksInfo.some(col => col.name === 'retry_count')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0`);
      }
      if (!tasksInfo.some(col => col.name === 'last_sync_attempt')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN last_sync_attempt TEXT`);
      }
      if (!tasksInfo.some(col => col.name === 'gateway_completion_notes')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN gateway_completion_notes TEXT`);
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_sync_status ON tasks(sync_status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_gateway_task_id ON tasks(gateway_task_id)`);
      console.log('[Migration 015] Gateway sync columns added to tasks');
    }
  },
  {
    id: '016',
    name: 'add_workspace_settings',
    up: (db) => {
      console.log('[Migration 016] Adding workspace_settings table...');
      db.exec(`
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
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_settings_workspace ON workspace_settings(workspace_id)`);
      console.log('[Migration 016] workspace_settings table created');
    }
  },
  {
    id: '017',
    name: 'add_agent_capabilities',
    up: (db) => {
      console.log('[Migration 017] Adding capabilities column to agents...');
      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      if (!agentsInfo.some(col => col.name === 'capabilities')) {
        db.exec(`ALTER TABLE agents ADD COLUMN capabilities TEXT`);
      }
      console.log('[Migration 017] Capabilities column added to agents');
    }
  },
  {
    id: '018',
    name: 'add_content_items_gateway_tracking',
    up: (db) => {
      console.log('[Migration 018] Adding gateway tracking columns to content_items...');
      const info = db.prepare("PRAGMA table_info(content_items)").all() as { name: string }[];
      if (!info.some(col => col.name === 'gateway_task_id')) {
        db.exec(`ALTER TABLE content_items ADD COLUMN gateway_task_id TEXT`);
      }
      if (!info.some(col => col.name === 'generation_status')) {
        db.exec(`ALTER TABLE content_items ADD COLUMN generation_status TEXT DEFAULT 'idle'`);
      }
      console.log('[Migration 018] Gateway tracking columns added to content_items');
    }
  },
  {
    id: '019',
    name: 'add_blocked_task_status',
    up: (db) => {
      console.log('[Migration 019] Adding blocked status to tasks CHECK constraint...');

      const taskSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
      if (taskSchema && taskSchema.sql.includes("'blocked'")) {
        console.log('[Migration 019] blocked status already present — skipping');
        return;
      }

      // Get current column names
      const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');

      db.exec(`ALTER TABLE tasks RENAME TO _tasks_old_019`);
      db.exec(`
        CREATE TABLE tasks (
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
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);

      db.exec(`INSERT INTO tasks (${colList}) SELECT ${colList} FROM _tasks_old_019`);
      db.exec(`DROP TABLE _tasks_old_019`);

      // Recreate indexes
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_sync_status ON tasks(sync_status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_gateway_task_id ON tasks(gateway_task_id)`);

      console.log('[Migration 019] Tasks table recreated with blocked status');
    }
  },
  {
    id: '020',
    name: 'add_correlation_id_to_tasks',
    up: (db) => {
      console.log('[Migration 020] Adding correlation_id to tasks...');
      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!tasksInfo.some(col => col.name === 'correlation_id')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN correlation_id TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_correlation_id ON tasks(correlation_id)`);
      }
      console.log('[Migration 020] correlation_id added to tasks');
    }
  },
  {
    id: '021',
    name: 'add_correlation_id_to_content_items',
    up: (db) => {
      console.log('[Migration 021] Adding correlation_id to content_items...');
      const info = db.prepare("PRAGMA table_info(content_items)").all() as { name: string }[];
      if (!info.some(col => col.name === 'correlation_id')) {
        db.exec(`ALTER TABLE content_items ADD COLUMN correlation_id TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_content_items_correlation_id ON content_items(correlation_id)`);
      }
      console.log('[Migration 021] correlation_id added to content_items');
    }
  },
  {
    id: '022',
    name: 'add_agent_frontmatter_columns',
    up: (db) => {
      console.log('[Migration 022] Adding mc_role and frontmatter_parse_error to agents...');
      const info = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      if (!info.some(col => col.name === 'mc_role')) {
        db.exec(`ALTER TABLE agents ADD COLUMN mc_role TEXT`);
      }
      if (!info.some(col => col.name === 'frontmatter_parse_error')) {
        db.exec(`ALTER TABLE agents ADD COLUMN frontmatter_parse_error INTEGER NOT NULL DEFAULT 0`);
      }
      console.log('[Migration 022] Agent frontmatter columns added');
    }
  },
  {
    id: '023',
    name: 'add_monitor_columns_to_workspace_settings',
    up: (db) => {
      console.log('[Migration 023] Adding monitor columns to workspace_settings...');
      const info = db.prepare("PRAGMA table_info(workspace_settings)").all() as { name: string }[];
      if (!info.some(col => col.name === 'stale_task_threshold_minutes')) {
        db.exec(`ALTER TABLE workspace_settings ADD COLUMN stale_task_threshold_minutes INTEGER NOT NULL DEFAULT 60`);
      }
      if (!info.some(col => col.name === 'monitor_cron_interval_minutes')) {
        db.exec(`ALTER TABLE workspace_settings ADD COLUMN monitor_cron_interval_minutes INTEGER NOT NULL DEFAULT 15`);
      }
      console.log('[Migration 023] Monitor columns added to workspace_settings');
    }
  },
  {
    id: '024',
    name: 'drop_agent_capabilities',
    up: (db) => {
      console.log('[Migration 024] Dropping capabilities column from agents...');
      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      if (agentsInfo.some(col => col.name === 'capabilities')) {
        db.exec(`ALTER TABLE agents DROP COLUMN capabilities`);
      }
      console.log('[Migration 024] Capabilities column dropped from agents');
    }
  },
  {
    id: '025',
    name: 'add_task_intake_columns',
    up: (db) => {
      console.log('[Migration 025] Adding task intake columns (brief, trigger_type, trigger_source, cron_job_id)...');

      const columns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      const hasColumn = (name: string) => columns.some(c => c.name === name);

      if (!hasColumn('brief')) {
        db.exec("ALTER TABLE tasks ADD COLUMN brief TEXT");
      }
      if (!hasColumn('trigger_type')) {
        db.exec("ALTER TABLE tasks ADD COLUMN trigger_type TEXT DEFAULT 'manual'");
      }
      if (!hasColumn('trigger_source')) {
        db.exec("ALTER TABLE tasks ADD COLUMN trigger_source TEXT");
      }
      if (!hasColumn('cron_job_id')) {
        db.exec("ALTER TABLE tasks ADD COLUMN cron_job_id TEXT");
      }

      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_cron_job_id ON tasks(cron_job_id)");
      console.log('[Migration 025] Task intake columns added');
    }
  },
  {
    id: '026',
    name: 'add_mattermost_channel_to_agents',
    up: (db) => {
      console.log('[Migration 026] Adding mattermost_channel to agents...');
      const columns = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      if (!columns.some(c => c.name === 'mattermost_channel')) {
        db.exec("ALTER TABLE agents ADD COLUMN mattermost_channel TEXT");
      }
      console.log('[Migration 026] mattermost_channel added to agents');
    }
  },
  {
    id: '027',
    name: 'reconcile_agent_dispatch_schema',
    up: (db) => {
      console.log('[Migration 027] Reconciling agent dispatch schema...');

      // A database restored from an older backup can retain a newer
      // _migrations ledger. Re-check the columns required by current dispatch
      // code instead of assuming the historical migration records are enough.
      const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!taskColumns.some(column => column.name === 'correlation_id')) {
        db.exec('ALTER TABLE tasks ADD COLUMN correlation_id TEXT');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_correlation_id ON tasks(correlation_id)');

      const agentColumns = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      if (!agentColumns.some(column => column.name === 'mc_role')) {
        db.exec('ALTER TABLE agents ADD COLUMN mc_role TEXT');
      }
      if (!agentColumns.some(column => column.name === 'frontmatter_parse_error')) {
        db.exec('ALTER TABLE agents ADD COLUMN frontmatter_parse_error INTEGER NOT NULL DEFAULT 0');
      }
      if (!agentColumns.some(column => column.name === 'mattermost_channel')) {
        db.exec('ALTER TABLE agents ADD COLUMN mattermost_channel TEXT');
      }

      console.log('[Migration 027] Agent dispatch schema reconciled');
    }
  },
  {
    id: '028',
    name: 'add_task_dependencies',
    up: (db) => {
      console.log('[Migration 028] Adding task dependencies...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_dependencies (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          created_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (task_id, depends_on_task_id),
          CHECK (task_id != depends_on_task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_dependencies_prerequisite
          ON task_dependencies(depends_on_task_id);
      `);
      console.log('[Migration 028] Task dependencies added');
    }
  },
  {
    id: '029',
    name: 'add_single_specialist_default_workflow',
    up: (db) => {
      console.log('[Migration 029] Adding single-specialist default workflow...');
      const now = new Date().toISOString();
      const stages = JSON.stringify([
        { id: 'work', label: 'Work', role: 'specialist', status: 'in_progress' },
        { id: 'done', label: 'Done', role: null, status: 'done' },
      ]);

      db.prepare(`
        INSERT INTO workflow_templates
          (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          stages = excluded.stages,
          fail_targets = excluded.fail_targets,
          updated_at = excluded.updated_at
      `).run(
        'tpl-single-specialist',
        'default',
        'Single Specialist',
        'One assigned specialist completes the task directly. Use Strict only when independent build/test/review roles are explicitly assigned.',
        stages,
        '{}',
        now,
        now,
      );

      db.prepare('UPDATE workflow_templates SET is_default = 0 WHERE workspace_id = ?')
        .run('default');
      db.prepare('UPDATE workflow_templates SET is_default = 1 WHERE id = ?')
        .run('tpl-single-specialist');
      console.log('[Migration 029] Single Specialist is now the default workflow');
    }
  },
  {
    id: '030',
    name: 'add_durable_execution_supervision',
    up: (db) => {
      console.log('[Migration 030] Adding durable execution supervision...');
      db.exec(`
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
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_execution_one_live
          ON task_execution_runs(task_id)
          WHERE state IN ('running','waiting_input','blocked','stalled','recovering');
        CREATE INDEX IF NOT EXISTS idx_task_execution_reconcile
          ON task_execution_runs(state, lease_expires_at, heartbeat_at);

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
        CREATE INDEX IF NOT EXISTS idx_task_execution_events_task
          ON task_execution_events(task_id, created_at DESC);
      `);
      console.log('[Migration 030] Durable execution supervision added');
    }
  },
  {
    id: '031',
    name: 'add_oracle_completion_controller',
    up: (db) => {
      console.log('[Migration 031] Adding Oracle completion controller...');
      db.exec(`
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
          last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS completion_controller_lease (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_controller_actions_queue ON completion_controller_actions(state,not_before,created_at);
        CREATE INDEX IF NOT EXISTS idx_reconciliations_task ON task_reconciliations(task_id,created_at DESC);
      `);
      console.log('[Migration 031] Oracle completion controller added');
    }
  },
  {
    id: '032',
    name: 'add_mattermost_thread_identity_to_tasks',
    up: (db) => {
      console.log('[Migration 032] Adding Mattermost thread identity to tasks...');
      const columns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
      const existing = new Set(columns.map(column => column.name));
      for (const column of [
        'mattermost_channel_id',
        'mattermost_root_post_id',
        'mattermost_source_post_id',
        'mattermost_thread_url',
      ]) {
        if (!existing.has(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_mattermost_root
          ON tasks(mattermost_channel_id, mattermost_root_post_id);
      `);
      console.log('[Migration 032] Mattermost thread identity added');
    }
  }
  ,{
    id: '033',
    name: 'fence_completion_controller_outbox',
    up: (db) => {
      const columns = new Set((db.prepare('PRAGMA table_info(completion_controller_actions)').all() as {name:string}[]).map(c=>c.name));
      if(!columns.has('claim_owner'))db.exec('ALTER TABLE completion_controller_actions ADD COLUMN claim_owner TEXT');
      if(!columns.has('claim_expires_at'))db.exec('ALTER TABLE completion_controller_actions ADD COLUMN claim_expires_at TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_controller_actions_claim ON completion_controller_actions(state,not_before,claim_expires_at)');
    }
  },
  {
    id: '034',
    name: 'add_completion_action_resolution_lifecycle',
    up: (db) => {
      const columns = new Set((db.prepare('PRAGMA table_info(completion_controller_actions)').all() as {name:string}[]).map(c=>c.name));
      if(!columns.has('delivered_at'))db.exec('ALTER TABLE completion_controller_actions ADD COLUMN delivered_at TEXT');
      if(!columns.has('resolution_status'))db.exec('ALTER TABLE completion_controller_actions ADD COLUMN resolution_status TEXT');
      if(!columns.has('resolved_at'))db.exec('ALTER TABLE completion_controller_actions ADD COLUMN resolved_at TEXT');
      if(!columns.has('resolution_note'))db.exec('ALTER TABLE completion_controller_actions ADD COLUMN resolution_note TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_controller_actions_resolution ON completion_controller_actions(authority,resolution_status,delivered_at)');
    }
  },
  {
    id: '035',
    name: 'add_mattermost_milestone_outbox',
    up: (db) => {
      db.exec(`
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
          not_before TEXT,
          claim_owner TEXT,
          claim_expires_at TEXT,
          provider_message_id TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mattermost_task_update_delivery
          ON mattermost_task_update_outbox(state,not_before,claim_expires_at,created_at);
        CREATE INDEX IF NOT EXISTS idx_mattermost_task_update_cooldown
          ON mattermost_task_update_outbox(task_id,milestone,created_at DESC);
      `);
    }
  },
  {
    id: '036',
    name: 'add_task_completion_contracts',
    up: (db) => {
      db.exec(`
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
        CREATE INDEX IF NOT EXISTS idx_acceptance_criteria_task ON task_acceptance_criteria(task_id,sort_order);
        CREATE INDEX IF NOT EXISTS idx_protected_boundaries_task ON task_protected_boundaries(task_id,sort_order);
      `);
    }
  },
  {
    id: '037',
    name: 'restore_blocked_task_status_after_table_recreation',
    up: (db) => {
      const taskSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
      if (taskSchema?.sql.match(/status\s+TEXT[\s\S]*?CHECK\s*\(status IN \([^)]*'blocked'/)) return;
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(column => column.name);
      const colList = cols.join(', ');
      db.exec('ALTER TABLE tasks RENAME TO _tasks_old_037');
      db.exec(`CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        status TEXT DEFAULT 'inbox' CHECK (status IN ('pending_dispatch','planning','inbox','assigned','in_progress','testing','review','verification','blocked','done')),
        priority TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
        assigned_agent_id TEXT REFERENCES agents(id), created_by_agent_id TEXT REFERENCES agents(id),
        workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id), business_id TEXT DEFAULT 'default', due_date TEXT,
        workflow_template_id TEXT REFERENCES workflow_templates(id), planning_session_key TEXT, planning_messages TEXT,
        planning_complete INTEGER DEFAULT 0, planning_spec TEXT, planning_agents TEXT, planning_dispatch_error TEXT,
        status_reason TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
        brief TEXT, trigger_type TEXT, trigger_source TEXT, gateway_task_id TEXT,
        sync_status TEXT DEFAULT 'local' CHECK (sync_status IN ('local','synced','pending_sync','sync_failed')),
        retry_count INTEGER DEFAULT 0, last_sync_attempt TEXT, gateway_completion_notes TEXT, cron_job_id TEXT,
        correlation_id TEXT, mattermost_channel_id TEXT, mattermost_root_post_id TEXT, mattermost_source_post_id TEXT,
        mattermost_thread_url TEXT
      )`);
      db.exec(`INSERT INTO tasks (${colList}) SELECT ${colList} FROM _tasks_old_037`);
      db.exec('DROP TABLE _tasks_old_037');
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status); CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id); CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id); CREATE INDEX IF NOT EXISTS idx_tasks_sync_status ON tasks(sync_status); CREATE INDEX IF NOT EXISTS idx_tasks_gateway_task_id ON tasks(gateway_task_id); CREATE INDEX IF NOT EXISTS idx_tasks_cron_job_id ON tasks(cron_job_id); CREATE INDEX IF NOT EXISTS idx_tasks_correlation_id ON tasks(correlation_id); CREATE INDEX IF NOT EXISTS idx_tasks_mattermost_root ON tasks(mattermost_channel_id,mattermost_root_post_id)');
    }
  },
  {
    id: '038',
    name: 'three_high_leverage_operating_features',
    up: (db) => {
      const taskColumns = new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(row => row.name));
      const additions = [
        ['mattermost_account_id', 'TEXT'], ['parent_task_id', 'TEXT REFERENCES tasks(id)'], ['lineage_id', 'TEXT'],
        ['is_current_lineage_member', 'INTEGER NOT NULL DEFAULT 1'], ['deleted_at', 'TEXT'], ['commitment_due_at', 'TEXT'],
        ['evidence_version', 'INTEGER NOT NULL DEFAULT 0'], ['current_completion_review_id', 'TEXT'],
      ] as const;
      for (const [name, definition] of additions) if (!taskColumns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_intake_events (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, mattermost_account_id TEXT NOT NULL,
          provider_event_id TEXT NOT NULL, sender_id TEXT NOT NULL, channel_id TEXT NOT NULL,
          channel_type TEXT NOT NULL, root_post_id TEXT NOT NULL, source_post_id TEXT NOT NULL,
          provider_created_at TEXT NOT NULL, provider_revision TEXT, event_kind TEXT NOT NULL,
          payload_hash TEXT NOT NULL, received_at TEXT NOT NULL, candidate_state TEXT NOT NULL DEFAULT 'resolved',
          candidate_reason TEXT, disposition TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), error TEXT,
          processed_at TEXT,
          UNIQUE(workspace_id,mattermost_account_id,provider_event_id)
        );
        CREATE TABLE IF NOT EXISTS task_brief_revisions (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL, source_post_id TEXT NOT NULL, provider_created_at TEXT NOT NULL,
          provider_revision TEXT, payload_hash TEXT NOT NULL, brief TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE(task_id,revision), UNIQUE(task_id,payload_hash,source_post_id)
        );
        CREATE TABLE IF NOT EXISTS task_exceptions (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          type TEXT NOT NULL, authority_scope TEXT NOT NULL, decision_version INTEGER NOT NULL,
          supersedes_id TEXT, is_current INTEGER NOT NULL DEFAULT 1, severity TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open', fingerprint TEXT NOT NULL UNIQUE, owner_agent_id TEXT,
          impact TEXT NOT NULL, evidence_json TEXT NOT NULL, recommendation TEXT, decision_schema TEXT,
          due_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT,
          UNIQUE(workspace_id,task_id,type,authority_scope,decision_version)
        );
        CREATE TABLE IF NOT EXISTS exception_actions (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, exception_id TEXT NOT NULL REFERENCES task_exceptions(id),
          actor_principal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, expected_decision_version INTEGER NOT NULL,
          action TEXT NOT NULL, decision_value TEXT, created_at TEXT NOT NULL,
          UNIQUE(workspace_id,actor_principal_id,idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS completion_reviews (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          evidence_version INTEGER NOT NULL, evidence_digest TEXT NOT NULL, freshness_policy_version TEXT NOT NULL,
          freshness_boundary_at TEXT NOT NULL, freshness_boundary_epoch INTEGER NOT NULL, freshness_bucket TEXT NOT NULL,
          reviewed_as_of TEXT NOT NULL, verdict TEXT NOT NULL, findings_json TEXT NOT NULL, reviewed_at TEXT NOT NULL,
          reviewer_version TEXT NOT NULL, current_synthesis_id TEXT,
          UNIQUE(workspace_id,task_id,evidence_digest,freshness_bucket)
        );
        CREATE TABLE IF NOT EXISTS executive_syntheses (
          id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES completion_reviews(id) ON DELETE CASCADE,
          schema_version TEXT NOT NULL, generation_key TEXT NOT NULL, content_json TEXT NOT NULL,
          model_identity TEXT NOT NULL, prompt_hash TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE(review_id,schema_version,generation_key)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_current_mattermost_lineage
          ON tasks(workspace_id,mattermost_account_id,mattermost_channel_id,mattermost_root_post_id)
          WHERE deleted_at IS NULL AND is_current_lineage_member=1 AND mattermost_account_id IS NOT NULL
            AND mattermost_channel_id IS NOT NULL AND mattermost_root_post_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_exceptions_current_open
          ON task_exceptions(workspace_id,task_id,type,authority_scope) WHERE is_current=1 AND status='open';
        CREATE INDEX IF NOT EXISTS idx_task_intake_root ON task_intake_events(workspace_id,mattermost_account_id,channel_id,root_post_id);
        CREATE INDEX IF NOT EXISTS idx_task_exceptions_ceo ON task_exceptions(workspace_id,status,is_current,severity,last_seen_at);
        CREATE INDEX IF NOT EXISTS idx_completion_reviews_task ON completion_reviews(task_id,reviewed_at DESC);
      `);
    }
  },
  {
    id: '039',
    name: 'bind_mattermost_outbox_to_originating_account',
    up: (db) => {
      const columns = new Set((db.prepare('PRAGMA table_info(mattermost_task_update_outbox)').all() as { name: string }[]).map(row => row.name));
      if (!columns.has('account_id')) db.exec("ALTER TABLE mattermost_task_update_outbox ADD COLUMN account_id TEXT NOT NULL DEFAULT 'switch'");
      db.exec(`UPDATE mattermost_task_update_outbox
        SET account_id=COALESCE((SELECT mattermost_account_id FROM tasks WHERE tasks.id=mattermost_task_update_outbox.task_id),account_id)`);
    }
  },
  {
    id: '040',
    name: 'agent_control_plane_contracts_and_memory_boundaries',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_tool_contracts (
          name TEXT NOT NULL, version INTEGER NOT NULL, risk TEXT NOT NULL
            CHECK(risk IN ('read','internal_write','external_action','destructive')),
          input_schema TEXT NOT NULL, rate_limit_count INTEGER NOT NULL CHECK(rate_limit_count>0),
          rate_limit_window_seconds INTEGER NOT NULL CHECK(rate_limit_window_seconds>0),
          enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
          PRIMARY KEY(name,version)
        );
        CREATE TABLE IF NOT EXISTS agent_tool_grants (
          agent_id TEXT NOT NULL REFERENCES agents(id), contract_name TEXT NOT NULL,
          contract_version INTEGER NOT NULL, granted_by TEXT NOT NULL, expires_at TEXT,
          created_at TEXT NOT NULL, revoked_at TEXT,
          PRIMARY KEY(agent_id,contract_name,contract_version),
          FOREIGN KEY(contract_name,contract_version) REFERENCES agent_tool_contracts(name,version)
        );
        CREATE TABLE IF NOT EXISTS agent_tool_invocations (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES task_execution_runs(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(id), contract_name TEXT NOT NULL,
          contract_version INTEGER NOT NULL, idempotency_key TEXT NOT NULL, input_digest TEXT NOT NULL,
          risk TEXT NOT NULL, state TEXT NOT NULL
            CHECK(state IN ('pending_confirmation','authorized','completed','denied','failed')),
          confirmation_actor TEXT, confirmation_at TEXT, result_digest TEXT, error_code TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(agent_id,idempotency_key),
          FOREIGN KEY(contract_name,contract_version) REFERENCES agent_tool_contracts(name,version)
        );
        CREATE INDEX IF NOT EXISTS idx_tool_invocation_rate
          ON agent_tool_invocations(agent_id,contract_name,contract_version,created_at);
        CREATE TABLE IF NOT EXISTS agent_control_plane_audit_events (
          id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          actor_id TEXT NOT NULL, event_type TEXT NOT NULL, target_id TEXT,
          outcome TEXT NOT NULL CHECK(outcome IN ('allowed','denied','completed','failed')),
          detail_digest TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_control_plane_audit_task
          ON agent_control_plane_audit_events(task_id,created_at);
        CREATE TABLE IF NOT EXISTS reference_workflow_runs (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          execution_run_id TEXT NOT NULL UNIQUE REFERENCES task_execution_runs(id) ON DELETE CASCADE,
          owner_agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL
            CHECK(state IN ('running','waiting_input','evaluating','complete','failed')),
          phase TEXT NOT NULL, checkpoint TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
          pending_invocation_id TEXT REFERENCES agent_tool_invocations(id), evaluator_agent_id TEXT REFERENCES agents(id),
          evaluation_verdict TEXT CHECK(evaluation_verdict IN ('passed','failed')),
          evaluation_evidence TEXT, evaluation_evidence_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reference_workflow_events (
          id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES reference_workflow_runs(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL, expected_version INTEGER NOT NULL, event_type TEXT NOT NULL,
          payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workflow_id,idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS agent_memory_records (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_key TEXT NOT NULL,
          plane TEXT NOT NULL CHECK(plane IN ('session_context','curated_fact','semantic_memory')),
          content TEXT, content_hash TEXT NOT NULL, source_ref TEXT NOT NULL,
          retention_until TEXT, correction_of_id TEXT REFERENCES agent_memory_records(id),
          deleted_at TEXT, deletion_reason TEXT, created_at TEXT NOT NULL,
          CHECK(plane!='session_context' OR retention_until IS NOT NULL),
          CHECK((deleted_at IS NULL AND content IS NOT NULL AND deletion_reason IS NULL)
             OR (deleted_at IS NOT NULL AND content IS NULL AND deletion_reason IS NOT NULL))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_current_fact
          ON agent_memory_records(workspace_id,subject_key,plane) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_memory_retention ON agent_memory_records(plane,retention_until);
      `);
    }
  }
];

/**
 * Run all pending migrations
 */
export function runMigrations(db: Database.Database): void {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Get already applied migrations
  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map(m => m.id)
  );

  // Run pending migrations in order
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }

    console.log(`[DB] Running migration ${migration.id}: ${migration.name}`);

    try {
      // Disable FK checks during migrations (required for table recreation).
      // PRAGMA foreign_keys must be set outside a transaction in SQLite.
      db.pragma('foreign_keys = OFF');
      // Prevent ALTER TABLE RENAME from rewriting FK references in other tables.
      db.pragma('legacy_alter_table = ON');

      db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name);
      })();

      // Re-enable FK checks and legacy alter table
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');

      console.log(`[DB] Migration ${migration.id} completed`);
    } catch (error) {
      // Re-enable FK checks even on failure
      db.pragma('foreign_keys = ON');
      console.error(`[DB] Migration ${migration.id} failed:`, error);
      throw error;
    }
  }
}

/**
 * Get migration status
 */
export function getMigrationStatus(db: Database.Database): { applied: string[]; pending: string[] } {
  const applied = (db.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: string }[]).map(m => m.id);
  const pending = migrations.filter(m => !applied.includes(m.id)).map(m => m.id);
  return { applied, pending };
}
