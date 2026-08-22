import { NextRequest,NextResponse } from 'next/server';
import { actOnException } from '@/lib/operating-features';
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{const {id}=await params;const body=await request.json();return NextResponse.json(actOnException(id,{...body,actor_principal_id:'michael'}));}catch(error){const message=error instanceof Error?error.message:String(error);return NextResponse.json({error:message},{status:/Stale/.test(message)?409:/not found/i.test(message)?404:400});}}
