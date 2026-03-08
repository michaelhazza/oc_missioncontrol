import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const WORKSPACE_PATH = path.join(process.env.HOME || '/Users/aiteam', '.openclaw', 'workspace');
const MEMORY_DIR = path.join(WORKSPACE_PATH, 'memory');
const MEMORY_MD = path.join(WORKSPACE_PATH, 'MEMORY.md');

export interface MemoryFile {
  filename: string;
  path: string;
  content: string;
  modified_at: string;
  is_longterm: boolean;
}

export async function GET() {
  try {
    const files: MemoryFile[] = [];

    // Read MEMORY.md (long-term memory)
    if (fs.existsSync(MEMORY_MD)) {
      const stat = fs.statSync(MEMORY_MD);
      const content = fs.readFileSync(MEMORY_MD, 'utf-8');
      files.push({
        filename: 'MEMORY.md',
        path: MEMORY_MD,
        content,
        modified_at: stat.mtime.toISOString(),
        is_longterm: true,
      });
    }

    // Read memory/ directory files
    if (fs.existsSync(MEMORY_DIR)) {
      const dirFiles = fs.readdirSync(MEMORY_DIR)
        .filter(f => f.endsWith('.md') || f.endsWith('.json') || f.endsWith('.txt'))
        .sort()
        .reverse(); // newest first

      for (const filename of dirFiles) {
        const filepath = path.join(MEMORY_DIR, filename);
        try {
          const stat = fs.statSync(filepath);
          const content = fs.readFileSync(filepath, 'utf-8');
          files.push({
            filename,
            path: filepath,
            content,
            modified_at: stat.mtime.toISOString(),
            is_longterm: false,
          });
        } catch {
          // Skip unreadable files
        }
      }
    }

    return NextResponse.json(files);
  } catch (error) {
    console.error('GET /api/memory error:', error);
    return NextResponse.json({ error: 'Failed to read memory files' }, { status: 500 });
  }
}
