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

export const CompletionContractSchema = z.object({
  acceptance_criteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(50),
  protected_boundaries: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
  verification_max_age_minutes: z.number().int().min(1).max(10080).optional(),
  required: z.boolean().optional(),
});

export const CompletionReportSchema = z.object({
  criteria: z.array(z.object({id:z.string().uuid(),status:z.enum(['pending','passed','waived']),evidence:z.string().trim().min(1).max(10000),verified_at:z.string().datetime().optional(),verifier_agent_id:z.string().uuid().optional()})).max(50),
  boundaries: z.array(z.object({id:z.string().uuid(),status:z.enum(['pending','intact','violated','waived']),evidence:z.string().trim().min(1).max(10000),verified_at:z.string().datetime().optional(),verifier_agent_id:z.string().uuid().optional()})).max(50),
  plan_vs_actual: z.string().trim().min(1).max(20000),
  deviations: z.array(z.string().trim().min(1).max(5000)).max(50),
  deferred_work: z.array(z.string().trim().min(1).max(5000)).max(50),
  verification_commands: z.array(z.object({command:z.string().trim().min(1).max(2000),exit_code:z.number().int(),output_summary:z.string().trim().min(1).max(10000)})).min(1).max(50),
  verification_ran_at: z.string().datetime(),
  next_action: z.string().trim().min(1).max(5000),
  submitted_by_agent_id: z.string().uuid().optional(),
});

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
  status_reason: z.string().max(10000).optional().nullable(),
  trigger_type: TriggerType.optional(),
  trigger_source: z.string().optional(),
  cron_job_id: z.string().optional(),
  mattermost_account_id: z.string().max(128).optional(),
  mattermost_channel_id: z.string().max(128).optional(),
  mattermost_root_post_id: z.string().max(128).optional(),
  mattermost_source_post_id: z.string().max(128).optional(),
  mattermost_thread_url: z.string().url().max(2000).optional(),
  depends_on_task_ids: z.array(z.string().uuid()).max(50).optional(),
  completion_contract: CompletionContractSchema.optional(),
}).superRefine((task,ctx)=>{
  const identity=[task.mattermost_channel_id,task.mattermost_root_post_id,task.mattermost_source_post_id,task.mattermost_thread_url];
  if(identity.some(Boolean)&&!identity.every(Boolean))ctx.addIssue({code:z.ZodIssueCode.custom,path:['mattermost_root_post_id'],message:'Mattermost task origin requires channel, root post, source post, and thread URL'});
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
  status_reason: z.string().max(10000).optional().nullable(),
  mattermost_account_id: z.string().max(128).optional().nullable(),
  mattermost_channel_id: z.string().max(128).optional().nullable(),
  mattermost_root_post_id: z.string().max(128).optional().nullable(),
  mattermost_source_post_id: z.string().max(128).optional().nullable(),
  mattermost_thread_url: z.string().url().max(2000).optional().nullable(),
}).superRefine((task,ctx)=>{
  const supplied=['mattermost_account_id','mattermost_channel_id','mattermost_root_post_id','mattermost_thread_url'].filter(field=>task[field as keyof typeof task]!==undefined);
  if(supplied.length>0&&supplied.length<4)ctx.addIssue({code:z.ZodIssueCode.custom,path:['mattermost_root_post_id'],message:'Canonical Mattermost thread identity must be updated as one complete set'});
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
