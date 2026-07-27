#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const repair = process.argv.includes('--repair');

function loadSqlite() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.prepare('SELECT 1').get();
  db.close();
}

try {
  loadSqlite();
  console.log(`[native-deps] better-sqlite3 is compatible with Node ${process.version} (ABI ${process.versions.modules})`);
} catch (error) {
  if (!repair || error?.code !== 'ERR_DLOPEN_FAILED') {
    console.error('[native-deps] better-sqlite3 failed to load.');
    console.error(error);
    process.exit(1);
  }

  console.warn(
    `[native-deps] Native module ABI mismatch under Node ${process.version} ` +
      `(ABI ${process.versions.modules}); rebuilding better-sqlite3...`
  );

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['rebuild', 'better-sqlite3'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  try {
    loadSqlite();
    console.log('[native-deps] better-sqlite3 rebuilt and verified successfully.');
  } catch (verificationError) {
    console.error('[native-deps] better-sqlite3 still fails after rebuild.');
    console.error(verificationError);
    process.exit(1);
  }
}
