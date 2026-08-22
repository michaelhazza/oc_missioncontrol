import { NextResponse } from 'next/server';
import { getExecutiveSynthesis } from '@/lib/operating-features';
export async function GET(_:Request,{params}:{params:Promise<{id:string}>}){const {id}=await params;const result=getExecutiveSynthesis(id);return result?NextResponse.json(result):NextResponse.json({error:'No current executive synthesis'},{status:404});}

