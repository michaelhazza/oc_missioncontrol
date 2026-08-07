import { z } from 'zod';

// Task status and priority enums from types
const TaskStatus = z.enum([
  'pending_dispatch',
  'planning',
  'inbox',
  'assigned',
  'paused',
  'in_progress',
  'testing',
  'review',
  'verification',
  'blocked',
  'done'
]);

const TaskPriority = z.enum(['low', 'normal', 'high', 'urgent']);

const TriggerType = z.enum(['manual', 'cron', 'agent', 'webhook']);

const ActivityType = z.enum([
  'spawned',
  'updated',
  'completed',
  'file_created',
  'status_changed',
  'created',
  'assigned',
  'progress',
  'blocked',
  'note',
  'verification_passed',
  'verification_failed',
  'completion_contract_passed',
  'test_passed'
]);

const DeliverableType = z.enum(['file', 'url', 'artifact']);

// Task validation schemas
export const CreateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500, 'Title must be 500 characters or less'),
  description: z.string().max(10000, 'Description must be 10000 characters or less').optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  assigned_agent_id: z.string().uuid().optional().nullable(),
  created_by_agent_id: z.string().uuid().optional().nullable(),
  business_id: z.string().optional(),
  workspace_id: z.string().optional(),
  workflow_template_id: z.string().optional().nullable(),
  due_date: z.string().optional().nullable(),
  brief: z.string().max(50000, 'Brief must be 50000 characters or less').optional(),
  trigger_type: TriggerType.optional(),
  trigger_source: z.string().optional(),
  cron_job_id: z.string().optional(),
  mattermost_channel_id: z.string().max(128).optional(),
  mattermost_root_post_id: z.string().max(128).optional(),
  mattermost_source_post_id: z.string().max(128).optional(),
  mattermost_thread_url: z.string().url().max(2000).optional(),
  depends_on_task_ids: z.array(z.string().uuid()).max(50).optional(),
}).superRefine((task,ctx)=>{
  if(Boolean(task.mattermost_channel_id)!==Boolean(task.mattermost_root_post_id))ctx.addIssue({code:z.ZodIssueCode.custom,path:['mattermost_root_post_id'],message:'Mattermost task origin requires both channel and root post IDs'});
});

export const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  assigned_agent_id: z.string().uuid().optional().nullable(),
  workflow_template_id: z.string().optional().nullable(),
  due_date: z.string().optional().nullable(),
  updated_by_agent_id: z.string().uuid().optional(),
  brief: z.string().max(50000, 'Brief must be 50000 characters or less').optional(),
  mattermost_channel_id: z.string().max(128).optional().nullable(),
  mattermost_root_post_id: z.string().max(128).optional().nullable(),
  mattermost_source_post_id: z.string().max(128).optional().nullable(),
  mattermost_thread_url: z.string().url().max(2000).optional().nullable(),
});

// Activity validation schema
export const CreateActivitySchema = z.object({
  activity_type: ActivityType,
  message: z.string().min(1, 'Message is required').max(5000, 'Message must be 5000 characters or less'),
  agent_id: z.string().uuid().optional(),
  author: z.string().optional(),
  metadata: z.string().optional(),
});

// Deliverable validation schema
export const CreateDeliverableSchema = z.object({
  deliverable_type: DeliverableType,
  title: z.string().min(1, 'Title is required'),
  path: z.string().optional(),
  description: z.string().optional(),
});

// Type exports for use in routes
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type CreateActivityInput = z.infer<typeof CreateActivitySchema>;
export type CreateDeliverableInput = z.infer<typeof CreateDeliverableSchema>;
