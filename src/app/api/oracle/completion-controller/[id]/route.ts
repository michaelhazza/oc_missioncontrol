import { NextRequest,NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne,run,transaction } from '@/lib/db';

const Resolution=z.object({oracleAgentId:z.string().min(1),resolution:z.enum(['passed','rework','cancelled','completed']),note:z.string().min(1).max(2000)});

export async function PATCH(request:NextRequest,{params}:{params:{id:string}}){
  const parsed=Resolution.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:{code:'VALIDATION_FAILED',issues:parsed.error.issues}},{status:400});
  const oracle=queryOne<{id:string}>('SELECT id FROM agents WHERE id=? AND lower(name)=?',[parsed.data.oracleAgentId,'oracle']);
  if(!oracle)return NextResponse.json({error:{code:'ORACLE_AUTHORITY_REQUIRED'}},{status:403});
  const action=queryOne<{id:string;task_id:string;state:string;authority:string;delivered_at:string|null;resolution_status:string|null}>('SELECT id,task_id,state,authority,delivered_at,resolution_status FROM completion_controller_actions WHERE id=?',[params.id]);
  if(!action)return NextResponse.json({error:{code:'ACTION_NOT_FOUND'}},{status:404});
  if(action.authority!=='oracle')return NextResponse.json({error:{code:'ORACLE_ACTION_REQUIRED'}},{status:409});
  if(!action.delivered_at)return NextResponse.json({error:{code:'ACTION_NOT_DELIVERED'}},{status:409});
  if(action.resolution_status)return NextResponse.json(action);
  transaction(()=>{
    const now=new Date().toISOString();
    const resolution=parsed.data.resolution==='completed'?'passed':parsed.data.resolution;
    run('UPDATE completion_controller_actions SET resolution_status=?,resolution_note=?,resolved_at=?,last_error=NULL,updated_at=? WHERE id=?',[resolution,parsed.data.note,now,now,action.id]);
    const activityType=resolution==='passed'?'verification_passed':resolution==='rework'?'verification_failed':'oracle_resolution';
    run(`INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,metadata,created_at) VALUES(?,?,?,?,?,?,?)`,[crypto.randomUUID(),action.task_id,oracle.id,activityType,parsed.data.note,JSON.stringify({controllerActionId:action.id,resolution}),now]);
  });
  return NextResponse.json(queryOne('SELECT * FROM completion_controller_actions WHERE id=?',[action.id]));
}
