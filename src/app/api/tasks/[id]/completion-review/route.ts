import { NextRequest,NextResponse } from 'next/server';
import { reviewCompletion } from '@/lib/operating-features';
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{const {id}=await params;const body=await request.json();if(!Number.isInteger(body.expected_evidence_version))return NextResponse.json({error:'expected_evidence_version is required'},{status:400});return NextResponse.json(reviewCompletion(id,body.expected_evidence_version));}catch(error){const message=error instanceof Error?error.message:String(error);return NextResponse.json({error:message},{status:/version changed/i.test(message)?409:/not found/i.test(message)?404:400});}}

