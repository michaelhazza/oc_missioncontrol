/**
 * File Preview API
 * Serves local files for preview (HTML only for security)
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync, realpathSync } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }

  // Only allow HTML files
  if (!filePath.endsWith('.html') && !filePath.endsWith('.htm')) {
    return NextResponse.json({ error: 'Only HTML files can be previewed' }, { status: 400 });
  }

  // Expand tilde and normalize
  const expandedPath = filePath.replace(/^~/, process.env.HOME || '');
  const normalizedPath = path.normalize(expandedPath);

  // Security check - only allow paths from environment config
  const allowedPaths = [
    process.env.WORKSPACE_BASE_PATH?.replace(/^~/, process.env.HOME || ''),
    process.env.PROJECTS_PATH?.replace(/^~/, process.env.HOME || ''),
  ].filter(Boolean) as string[];

  if (allowedPaths.length === 0) {
    return NextResponse.json({ error: 'No allowed directories configured' }, { status: 403 });
  }

  if (!existsSync(normalizedPath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  // Resolve real path to prevent symlink attacks
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(normalizedPath);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const isAllowed = allowedPaths.some(allowed => {
    try {
      const resolvedAllowed = realpathSync(path.normalize(allowed));
      return resolvedPath.startsWith(resolvedAllowed + path.sep) || resolvedPath === resolvedAllowed;
    } catch {
      return false;
    }
  });

  if (!isAllowed) {
    console.warn(`[SECURITY] Preview path traversal attempt blocked: ${filePath} -> ${resolvedPath}`);
    return NextResponse.json({ error: 'Path not allowed' }, { status: 403 });
  }

  try {
    const content = readFileSync(resolvedPath, 'utf-8');
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/html',
        // Sandbox the preview to prevent scripts from accessing the parent origin
        'Content-Security-Policy': "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'",
      },
    });
  } catch (error) {
    console.error('[FILE] Error reading file:', error);
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
