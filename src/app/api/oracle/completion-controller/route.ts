import { NextRequest,NextResponse } from 'next/server';
import { getControllerQueue,runCompletionScan } from '@/lib/openclaw/completion-controller';
import { queryAll } from '@/lib/db';
import { getMattermostOutbox } from '@/lib/openclaw/mattermost-task-updates';

export const dynamic='force-dynamic';

export async function GET(){
  const latest=queryAll('SELECT * FROM completion_controller_scans ORDER BY started_at DESC LIMIT 10');
  return NextResponse.json({enabled:process.env.MISSION_CONTROL_COMPLETION_CONTROLLER||'disabled',activeActions:(process.env.MISSION_CONTROL_COMPLETION_ACTIONS||'dispatch,request_verification').split(','),queue:getControllerQueue(),mattermostOutbox:getMattermostOutbox(),recentScans:latest});
}

export async function POST(request:NextRequest){
  const body=await request.json().catch(()=>({}));
  const requested=body.mode==='active'?'active':'dry_run';
  if(requested==='active'&&process.env.MISSION_CONTROL_COMPLETION_CONTROLLER!=='active')
    return NextResponse.json({error:{code:'ACTIVE_MODE_DISABLED',message:'Set MISSION_CONTROL_COMPLETION_CONTROLLER=active only after rollout review.'}},{status:409});
  const result=await runCompletionScan(requested);
  return NextResponse.json(result,{status:result.status==='leased'?409:200});
}
