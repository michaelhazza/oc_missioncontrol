import { NextRequest,NextResponse } from 'next/server';
import { projectTaskExceptions } from '@/lib/operating-features';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){const workspace=request.nextUrl.searchParams.get('workspace')||'default';return NextResponse.json(projectTaskExceptions(workspace));}

