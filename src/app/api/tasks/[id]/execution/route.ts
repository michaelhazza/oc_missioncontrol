import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ExecutionConflictError, StaleLeaseError, getExecution, getExecutionEvents, heartbeat, recordTransientFailure, startExecution, transitionExecution } from '@/lib/openclaw/execution-supervision';

const Start=z.object({action:z.literal('start'),agentId:z.string().min(1),sessionKey:z.string().min(1),runIdentity:z.string().min(1),leaseOwner:z.string().min(1)});
const Heartbeat=z.object({action:z.literal('heartbeat'),runId:z.string().uuid(),leaseOwner:z.string().min(1),leaseEpoch:z.number().int().positive(),eventKey:z.string().min(1).max(200),checkpoint:z.record(z.string(),z.unknown()).optional()});
const Transition=z.object({action:z.literal('transition'),runId:z.string().uuid(),leaseOwner:z.string().min(1),leaseEpoch:z.number().int().positive(),eventKey:z.string().min(1).max(200),state:z.enum(['running','waiting_input','blocked','failed','cancelled','complete']),reason:z.string().max(2000).optional(),checkpoint:z.record(z.string(),z.unknown()).optional()});
const Failure=z.object({action:z.literal('transient_failure'),runId:z.string().uuid(),leaseOwner:z.string().min(1),leaseEpoch:z.number().int().positive(),eventKey:z.string().min(1).max(200),code:z.string().min(1).max(100),detail:z.string().max(2000).optional()});
const Command=z.discriminatedUnion('action',[Start,Heartbeat,Transition,Failure]);

export async function GET(_request:NextRequest,{params}:{params:{id:string}}){
  const execution=getExecution(params.id);
  return execution?NextResponse.json({...execution,events:getExecutionEvents(params.id)}):NextResponse.json({error:{code:'EXECUTION_NOT_FOUND'}},{status:404});
}

export async function POST(request:NextRequest,{params}:{params:{id:string}}){
  const parsed=Command.safeParse(await request.json().catch(()=>null));
  if(!parsed.success) return NextResponse.json({error:{code:'VALIDATION_FAILED',issues:parsed.error.issues}},{status:400});
  try{
    const command=parsed.data;
    const result=command.action==='start'
      ? startExecution({taskId:params.id,...command})
      : command.action==='heartbeat'
        ? heartbeat(command)
        : command.action==='transient_failure'
          ? recordTransientFailure(command)
          : transitionExecution(command);
    return NextResponse.json(result,{status:command.action==='start'?201:200});
  }catch(error){
    if(error instanceof StaleLeaseError) return NextResponse.json({error:{code:'STALE_LEASE',message:error.message}},{status:409});
    if(error instanceof ExecutionConflictError) return NextResponse.json({error:{code:'EXECUTION_CONFLICT',message:error.message}},{status:409});
    if(error instanceof Error && error.message==='Task not found') return NextResponse.json({error:{code:'TASK_NOT_FOUND'}},{status:404});
    console.error('[Execution API]',error);
    return NextResponse.json({error:{code:'INTERNAL_ERROR'}},{status:500});
  }
}
