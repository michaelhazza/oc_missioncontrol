import { NextRequest, NextResponse } from 'next/server';
import { processMattermostInbound, verifyMattermostSignature, type MattermostInboundEvent } from '@/lib/mattermost-intake';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const raw = await request.text();
  const verified = verifyMattermostSignature(raw, request.headers.get('x-mc-signature'), request.headers.get('x-mc-timestamp'));
  if (!verified.ok) return NextResponse.json({ error: verified.reason }, { status: 401 });
  try {
    return NextResponse.json(processMattermostInbound(JSON.parse(raw) as MattermostInboundEvent));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /allowlist|direct Mattermost|required fields|ISO-8601/.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

