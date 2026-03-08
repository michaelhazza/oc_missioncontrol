import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const workspaceId = searchParams.get('workspace_id') || 'default';

    const db = getDb();
    const items = db.prepare(
      `SELECT * FROM content_items WHERE workspace_id = ? ORDER BY created_at DESC`
    ).all(workspaceId);

    return NextResponse.json(items);
  } catch (error) {
    console.error('GET /api/content error:', error);
    return NextResponse.json({ error: 'Failed to fetch content items' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { title, description, platform = 'youtube', stage = 'idea', notes, workspace_id = 'default' } = body;

    if (!title) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }

    const id = uuidv4();
    const db = getDb();
    db.prepare(
      `INSERT INTO content_items (id, title, description, platform, stage, notes, workspace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, title, description || null, platform, stage, notes || null, workspace_id);

    const item = db.prepare(`SELECT * FROM content_items WHERE id = ?`).get(id);
    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    console.error('POST /api/content error:', error);
    return NextResponse.json({ error: 'Failed to create content item' }, { status: 500 });
  }
}
