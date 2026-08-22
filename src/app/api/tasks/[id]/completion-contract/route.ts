import { NextRequest,NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { CompletionContractSchema,CompletionReportSchema } from '@/lib/validation';
import { createCompletionContract,getCompletionContract,submitCompletionReport } from '@/lib/completion-contract';
import { reviewCompletion } from '@/lib/operating-features';

export const dynamic='force-dynamic';

export async function GET(_:NextRequest,{params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  if(!queryOne('SELECT id FROM tasks WHERE id=?',[id]))return NextResponse.json({error:'Task not found'},{status:404});
  return NextResponse.json(getCompletionContract(id));
}

export async function PUT(request:NextRequest,{params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  const task=queryOne<{status:string}>('SELECT status FROM tasks WHERE id=?',[id]);
  if(!task)return NextResponse.json({error:'Task not found'},{status:404});
  if(['in_progress','testing','verification','review','done'].includes(task.status))return NextResponse.json({error:'Completion contracts lock when execution starts'},{status:409});
  const parsed=CompletionContractSchema.safeParse(await request.json());
  if(!parsed.success)return NextResponse.json({error:'Validation failed',details:parsed.error.issues},{status:400});
  return NextResponse.json(createCompletionContract(id,parsed.data));
}

export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  if(!queryOne('SELECT id FROM tasks WHERE id=?',[id]))return NextResponse.json({error:'Task not found'},{status:404});
  const parsed=CompletionReportSchema.safeParse(await request.json());
  if(!parsed.success)return NextResponse.json({error:'Validation failed',details:parsed.error.issues},{status:400});
  try{const contract=submitCompletionReport(id,parsed.data);const task=queryOne<{evidence_version:number}>('SELECT evidence_version FROM tasks WHERE id=?',[id])!;const review=reviewCompletion(id,task.evidence_version);return NextResponse.json({...contract,completion_review:review});}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:String(error)},{status:409});}
}
