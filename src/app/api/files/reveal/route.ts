/**
 * File Reveal API
 * Opens a file's location in Finder (macOS) or Explorer (Windows)
 */

import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, realpathSync } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

export async function POST(request: NextRequest) {
  try {
    const { filePath } = await request.json();

    if (!filePath) {
      return NextResponse.json({ error: 'filePath is required' }, { status: 400 });
    }

    // Expand tilde
    const expandedPath = filePath.replace(/^~/, process.env.HOME || '');

    // Security: Ensure path is within allowed directories (from env config)
    const allowedPaths = [
      process.env.WORKSPACE_BASE_PATH?.replace(/^~/, process.env.HOME || ''),
      process.env.PROJECTS_PATH?.replace(/^~/, process.env.HOME || ''),
    ].filter(Boolean) as string[];

    if (allowedPaths.length === 0) {
      return NextResponse.json(
        { error: 'No allowed directories configured (set WORKSPACE_BASE_PATH or PROJECTS_PATH)' },
        { status: 403 }
      );
    }

    const normalizedPath = path.normalize(expandedPath);

    // Check if file/directory exists
    if (!existsSync(normalizedPath)) {
      return NextResponse.json(
        { error: 'File or directory not found' },
        { status: 404 }
      );
    }

    // Resolve real path to prevent symlink attacks
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(normalizedPath);
    } catch {
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403 }
      );
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
      console.warn(`[SECURITY] Blocked file reveal outside allowed directories: ${filePath}`);
      return NextResponse.json(
        { error: 'Path not in allowed directories' },
        { status: 403 }
      );
    }

    // Open in Finder (macOS) - reveal the file
    // Use execFile (not exec) to prevent command injection — arguments are
    // passed as an array and never interpreted by a shell.
    const platform = process.platform;

    if (platform === 'darwin') {
      await execFileAsync('open', ['-R', resolvedPath]);
    } else if (platform === 'win32') {
      await execFileAsync('explorer', ['/select,', resolvedPath]);
    } else {
      // Linux - open containing folder
      await execFileAsync('xdg-open', [path.dirname(resolvedPath)]);
    }

    console.log(`[FILE] Revealed: ${resolvedPath}`);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[FILE] Error revealing file:', error);
    return NextResponse.json(
      { error: 'Failed to reveal file' },
      { status: 500 }
    );
  }
}
