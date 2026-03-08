/**
 * File Upload API
 * Accepts file content over HTTP and saves it to the server filesystem.
 * This enables remote agents to create files on
 * the Mission Control server.
 */

import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// Base directory for all uploaded project files
// Set via PROJECTS_PATH env var (e.g., ~/projects or /var/www/projects)
const PROJECTS_BASE = (process.env.PROJECTS_PATH || '~/projects').replace(/^~/, process.env.HOME || '');

interface UploadRequest {
  // Path relative to PROJECTS_BASE (e.g., "dashboard-redesign/index.html")
  relativePath: string;
  // File content (text)
  content: string;
  // Optional: encoding (default: utf-8)
  encoding?: BufferEncoding;
}

/**
 * POST /api/files/upload
 * Upload a file to the server
 */
export async function POST(request: NextRequest) {
  try {
    const body: UploadRequest = await request.json();
    const { relativePath, content, encoding = 'utf-8' } = body;

    if (!relativePath || content === undefined) {
      return NextResponse.json(
        { error: 'relativePath and content are required' },
        { status: 400 }
      );
    }

    // Security: Prevent path traversal attacks
    const normalizedPath = path.normalize(relativePath);
    if (normalizedPath.startsWith('..') || normalizedPath.startsWith('/')) {
      return NextResponse.json(
        { error: 'Invalid path: must be relative and cannot traverse upward' },
        { status: 400 }
      );
    }

    // Build full path
    const fullPath = path.join(PROJECTS_BASE, normalizedPath);

    // Ensure base directory exists
    if (!existsSync(PROJECTS_BASE)) {
      mkdirSync(PROJECTS_BASE, { recursive: true });
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(fullPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Security: Verify resolved path is within PROJECTS_BASE (prevents symlink attacks)
    // Check parent dir since the file may not exist yet
    try {
      const resolvedParent = realpathSync(parentDir);
      const resolvedBase = realpathSync(PROJECTS_BASE);
      if (!resolvedParent.startsWith(resolvedBase + path.sep) && resolvedParent !== resolvedBase) {
        console.warn(`[SECURITY] Upload path traversal attempt blocked: ${fullPath} -> ${resolvedParent}`);
        return NextResponse.json(
          { error: 'Access denied' },
          { status: 403 }
        );
      }

      // Prevent overwriting symlinks that point outside the base
      const targetFile = path.join(resolvedParent, path.basename(normalizedPath));
      if (existsSync(targetFile)) {
        const stat = lstatSync(targetFile);
        if (stat.isSymbolicLink()) {
          const resolvedTarget = realpathSync(targetFile);
          if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
            console.warn(`[SECURITY] Upload to symlink outside base blocked: ${targetFile} -> ${resolvedTarget}`);
            return NextResponse.json(
              { error: 'Access denied' },
              { status: 403 }
            );
          }
        }
      }
    } catch (error) {
      console.error('[FILE UPLOAD] Error resolving path:', error);
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403 }
      );
    }

    // Write the file
    writeFileSync(fullPath, content, { encoding });

    console.log(`[FILE UPLOAD] Created: ${fullPath}`);

    return NextResponse.json({
      success: true,
      path: fullPath,
      relativePath: normalizedPath,
      size: Buffer.byteLength(content, encoding),
    }, { status: 201 });
  } catch (error) {
    console.error('Error uploading file:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/files/upload
 * Get info about the upload endpoint
 */
export async function GET() {
  return NextResponse.json({
    description: 'File upload endpoint for remote agents',
    basePath: PROJECTS_BASE,
    usage: {
      method: 'POST',
      body: {
        relativePath: 'project-name/filename.html',
        content: '<html>...</html>',
        encoding: 'utf-8 (optional)',
      },
    },
  });
}
