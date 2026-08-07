import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { acknowledgeOracle, ExecutionConflictError, reassignExecution } from '@/lib/openclaw/execution-supervision';

const Command=z.discriminatedUnion('action',[
  z.object({action:z.literal('acknowledge'),runId:z.string().uuid(),oracleAgentId:z.string().min(1),note:z.string().min(1).max(2000)}),
  z.object({action:z.literal('reassign'),runId:z.string().uuid(),oracleAgentId:z.string().min(1),newAgentId:z.string().min(1),newSessionKey:z.string().min(1),reason:z.string().min(1).max(2000)}),
]);

export async function POST(request:NextRequest,{params}:{params:{id:string}}){
  const parsed=Command.safeParse(await request.json().catch(()=>null));
  if(!parsed.success) return NextResponse.json({error:{code:'VALIDATION_FAILED',issues:parsed.error.issues}},{status:400});
  try{
    const command=parsed.data;
    const result=command.action==='acknowledge'
      ? acknowledgeOracle(command.runId,command.oracleAgentId,command.note)
      : reassignExecution(command.runId,command.oracleAgentId,command.newAgentId,command.newSessionKey,command.reason);
    if(result.task_id!==params.id) return NextResponse.json({error:{code:'TASK_RUN_MISMATCH'}},{status:409});
    return NextResponse.json(result);
  }catch(error){
    if(error instanceof ExecutionConflictError) return NextResponse.json({error:{code:'EXECUTION_CONFLICT',message:error.message}},{status:409});
    if(error instanceof Error && /not found/.test(error.message)) return NextResponse.json({error:{code:'NOT_FOUND',message:error.message}},{status:404});
    console.error('[Execution recovery API]',error);
    return NextResponse.json({error:{code:'INTERNAL_ERROR'}},{status:500});
  }
}
