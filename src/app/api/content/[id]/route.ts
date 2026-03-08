import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { id } = params;
    const body = await req.json();
    const db = getDb();

    const existing = db.prepare(`SELECT * FROM content_items WHERE id = ?`).get(id);
    if (!existing) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    }

    const fields = ['title', 'description', 'platform', 'stage', 'script', 'thumbnail_url', 'notes'];
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const field of fields) {
      if (field in body) {
        updates.push(`${field} = ?`);
        values.push(body[field]);
      }
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    updates.push(`updated_at = datetime('now')`);
    values.push(id);

    db.prepare(
      `UPDATE content_items SET ${updates.join(', ')} WHERE id = ?`
    ).run(...values);

    const updated = db.prepare(`SELECT * FROM content_items WHERE id = ?`).get(id);
    return NextResponse.json(updated);
  } catch (error) {
    console.error('PATCH /api/content/[id] error:', error);
    return NextResponse.json({ error: 'Failed to update content item' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { id } = params;
    const db = getDb();
    db.prepare(`DELETE FROM content_items WHERE id = ?`).run(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/content/[id] error:', error);
    return NextResponse.json({ error: 'Failed to delete content item' }, { status: 500 });
  }
}
