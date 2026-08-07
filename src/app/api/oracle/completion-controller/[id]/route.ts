import { NextRequest,NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne,run,transaction } from '@/lib/db';

const Resolution=z.object({oracleAgentId:z.string().min(1),resolution:z.enum(['completed','cancelled']),note:z.string().min(1).max(2000)});

export async function PATCH(request:NextRequest,{params}:{params:{id:string}}){
  const parsed=Resolution.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:{code:'VALIDATION_FAILED',issues:parsed.error.issues}},{status:400});
  const oracle=queryOne<{id:string}>('SELECT id FROM agents WHERE id=? AND lower(name)=?',[parsed.data.oracleAgentId,'oracle']);
  if(!oracle)return NextResponse.json({error:{code:'ORACLE_AUTHORITY_REQUIRED'}},{status:403});
  const action=queryOne<{id:string;task_id:string;state:string}>('SELECT id,task_id,state FROM completion_controller_actions WHERE id=?',[params.id]);
  if(!action)return NextResponse.json({error:{code:'ACTION_NOT_FOUND'}},{status:404});
  if(['completed','cancelled'].includes(action.state))return NextResponse.json(action);
  transaction(()=>{
    const now=new Date().toISOString();
    run('UPDATE completion_controller_actions SET state=?,last_error=NULL,completed_at=?,updated_at=? WHERE id=?',[parsed.data.resolution,now,now,action.id]);
    run(`INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,metadata,created_at) VALUES(?,?,?,'oracle_resolution',?,?,?)`,[crypto.randomUUID(),action.task_id,oracle.id,parsed.data.note,JSON.stringify({controllerActionId:action.id,resolution:parsed.data.resolution}),now]);
  });
  return NextResponse.json(queryOne('SELECT * FROM completion_controller_actions WHERE id=?',[action.id]));
}
