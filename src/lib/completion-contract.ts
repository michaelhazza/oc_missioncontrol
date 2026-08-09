import { randomUUID } from 'node:crypto';
import { queryAll, queryOne, run, transaction } from '@/lib/db';

export type CriterionStatus='pending'|'passed'|'waived';
export type BoundaryStatus='pending'|'intact'|'violated'|'waived';
export interface ContractItem{ id:string;description:string;sort_order:number;status:string;evidence:string|null;verified_at:string|null;verifier_agent_id:string|null }
export interface CompletionContractInput{acceptance_criteria:string[];protected_boundaries?:string[];verification_max_age_minutes?:number;required?:boolean}
export interface CompletionReportInput{
  criteria:Array<{id:string;status:CriterionStatus;evidence:string;verified_at?:string;verifier_agent_id?:string}>;
  boundaries:Array<{id:string;status:BoundaryStatus;evidence:string;verified_at?:string;verifier_agent_id?:string}>;
  plan_vs_actual:string;deviations:string[];deferred_work:string[];
  verification_commands:Array<{command:string;exit_code:number;output_summary:string}>;
  verification_ran_at:string;next_action:string;submitted_by_agent_id?:string;
}

export function createCompletionContract(taskId:string,input:CompletionContractInput,now=new Date()){
  const stamp=now.toISOString();
  const criteria=input.acceptance_criteria.map(value=>value.trim()).filter(Boolean);
  const boundaries=(input.protected_boundaries||[]).map(value=>value.trim()).filter(Boolean);
  if(criteria.length===0)throw new Error('At least one acceptance criterion is required');
  transaction(()=>{
    run(`INSERT INTO task_completion_contracts(task_id,required,verification_max_age_minutes,created_at,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET required=excluded.required,verification_max_age_minutes=excluded.verification_max_age_minutes,updated_at=excluded.updated_at`,
      [taskId,input.required===false?0:1,input.verification_max_age_minutes||1440,stamp,stamp]);
    run('DELETE FROM task_acceptance_criteria WHERE task_id=?',[taskId]);
    run('DELETE FROM task_protected_boundaries WHERE task_id=?',[taskId]);
    run('DELETE FROM task_completion_reports WHERE task_id=?',[taskId]);
    criteria.forEach((description,index)=>run(`INSERT INTO task_acceptance_criteria(id,task_id,description,sort_order,status,created_at,updated_at) VALUES(?,?,?,?, 'pending',?,?)`,[randomUUID(),taskId,description,index,stamp,stamp]));
    boundaries.forEach((description,index)=>run(`INSERT INTO task_protected_boundaries(id,task_id,description,sort_order,status,created_at,updated_at) VALUES(?,?,?,?, 'pending',?,?)`,[randomUUID(),taskId,description,index,stamp,stamp]));
  });
  return getCompletionContract(taskId,now);
}

export function submitCompletionReport(taskId:string,input:CompletionReportInput,now=new Date()){
  const contract=queryOne<{task_id:string}>('SELECT task_id FROM task_completion_contracts WHERE task_id=?',[taskId]);
  if(!contract)throw new Error('Completion contract not found');
  const stamp=now.toISOString();
  const criterionIds=new Set(queryAll<{id:string}>('SELECT id FROM task_acceptance_criteria WHERE task_id=?',[taskId]).map(row=>row.id));
  const boundaryIds=new Set(queryAll<{id:string}>('SELECT id FROM task_protected_boundaries WHERE task_id=?',[taskId]).map(row=>row.id));
  if(input.criteria.length!==criterionIds.size||input.criteria.some(item=>!criterionIds.has(item.id)))throw new Error('Report must address every acceptance criterion exactly once');
  if(input.boundaries.length!==boundaryIds.size||input.boundaries.some(item=>!boundaryIds.has(item.id)))throw new Error('Report must address every protected boundary exactly once');
  if(input.verification_commands.length===0)throw new Error('At least one fresh verification command is required');
  if(!Number.isFinite(Date.parse(input.verification_ran_at)))throw new Error('verification_ran_at must be a valid timestamp');
  transaction(()=>{
    for(const item of input.criteria){
      if(!item.evidence.trim())throw new Error('Criterion evidence is required');
      run('UPDATE task_acceptance_criteria SET status=?,evidence=?,verified_at=?,verifier_agent_id=?,updated_at=? WHERE id=? AND task_id=?',[item.status,item.evidence.trim(),item.verified_at||input.verification_ran_at,item.verifier_agent_id||input.submitted_by_agent_id||null,stamp,item.id,taskId]);
    }
    for(const item of input.boundaries){
      if(!item.evidence.trim())throw new Error('Boundary evidence is required');
      run('UPDATE task_protected_boundaries SET status=?,evidence=?,verified_at=?,verifier_agent_id=?,updated_at=? WHERE id=? AND task_id=?',[item.status,item.evidence.trim(),item.verified_at||input.verification_ran_at,item.verifier_agent_id||input.submitted_by_agent_id||null,stamp,item.id,taskId]);
    }
    run(`INSERT INTO task_completion_reports(task_id,plan_vs_actual,deviations,deferred_work,verification_commands,verification_ran_at,next_action,submitted_by_agent_id,submitted_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET plan_vs_actual=excluded.plan_vs_actual,deviations=excluded.deviations,deferred_work=excluded.deferred_work,verification_commands=excluded.verification_commands,verification_ran_at=excluded.verification_ran_at,next_action=excluded.next_action,submitted_by_agent_id=excluded.submitted_by_agent_id,submitted_at=excluded.submitted_at,updated_at=excluded.updated_at`,
      [taskId,input.plan_vs_actual.trim(),JSON.stringify(input.deviations),JSON.stringify(input.deferred_work),JSON.stringify(input.verification_commands),input.verification_ran_at,input.next_action.trim(),input.submitted_by_agent_id||null,stamp,stamp]);
  });
  const result=getCompletionContract(taskId,now);
  if(result.ready){
    run(`INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,metadata,created_at) VALUES(?,?,?,'completion_contract_passed',?,?,?)`,
      [randomUUID(),taskId,input.submitted_by_agent_id||null,'Completion contract passed all criteria, boundary, reconciliation, and fresh-verification gates',JSON.stringify({verificationRanAt:input.verification_ran_at,criteria:input.criteria.length,boundaries:input.boundaries.length}),stamp]);
  }
  return result;
}

export function evaluateCompletionContract(taskId:string,now=new Date()){
  const contract=queryOne<{required:number;verification_max_age_minutes:number}>('SELECT required,verification_max_age_minutes FROM task_completion_contracts WHERE task_id=?',[taskId]);
  if(!contract)return{exists:false,required:false,ready:true,reasons:[] as string[]};
  const criteria=queryAll<ContractItem>('SELECT id,description,sort_order,status,evidence,verified_at,verifier_agent_id FROM task_acceptance_criteria WHERE task_id=? ORDER BY sort_order',[taskId]);
  const boundaries=queryAll<ContractItem>('SELECT id,description,sort_order,status,evidence,verified_at,verifier_agent_id FROM task_protected_boundaries WHERE task_id=? ORDER BY sort_order',[taskId]);
  const report=queryOne<{plan_vs_actual:string;deviations:string;deferred_work:string;verification_commands:string;verification_ran_at:string;next_action:string;submitted_at:string}>('SELECT plan_vs_actual,deviations,deferred_work,verification_commands,verification_ran_at,next_action,submitted_at FROM task_completion_reports WHERE task_id=?',[taskId]);
  const reasons:string[]=[];
  if(criteria.length===0)reasons.push('No acceptance criteria defined');
  if(criteria.some(item=>!['passed','waived'].includes(item.status)||!item.evidence))reasons.push('Every acceptance criterion needs passed/waived status and evidence');
  if(boundaries.some(item=>item.status==='violated'))reasons.push('A protected boundary is violated');
  if(boundaries.some(item=>!['intact','waived'].includes(item.status)||!item.evidence))reasons.push('Every protected boundary needs intact/waived status and evidence');
  if(!report)reasons.push('Completion report is missing');
  else{
    const commands=JSON.parse(report.verification_commands||'[]') as Array<{command?:string;exit_code?:number;output_summary?:string}>;
    if(!report.plan_vs_actual.trim())reasons.push('Plan-versus-actual reconciliation is missing');
    if(!report.next_action.trim())reasons.push('One explicit next action is missing');
    if(commands.length===0||commands.some(command=>!command.command||command.exit_code!==0||!command.output_summary))reasons.push('Fresh verification commands must all have exit code 0 and an output summary');
    const ranAt=Date.parse(report.verification_ran_at);
    if(!Number.isFinite(ranAt)||now.getTime()-ranAt>contract.verification_max_age_minutes*60_000||ranAt>now.getTime()+60_000)reasons.push('Verification evidence is stale or has an invalid timestamp');
    const latestDeliverable=queryOne<{created_at:string}>('SELECT created_at FROM task_deliverables WHERE task_id=? ORDER BY created_at DESC LIMIT 1',[taskId]);
    if(latestDeliverable&&ranAt<Date.parse(latestDeliverable.created_at))reasons.push('Verification predates the latest deliverable');
  }
  return{exists:true,required:Boolean(contract.required),ready:!contract.required||reasons.length===0,reasons,criteria,boundaries,report:report?{...report,deviations:JSON.parse(report.deviations),deferred_work:JSON.parse(report.deferred_work),verification_commands:JSON.parse(report.verification_commands)}:null};
}

export function getCompletionContract(taskId:string,now=new Date()){
  return evaluateCompletionContract(taskId,now);
}
