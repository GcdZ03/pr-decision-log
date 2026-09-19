#!/usr/bin/env node
/**
 * Phase 0 raw recorder. Appends every hook payload verbatim to a JSONL file
 * so the exact field names can be inspected. Deliberately dependency-free
 * and fail-open: a hook must never break the agent loop.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OUT_DIR = process.env.PDL_RAW_DIR ?? join(homedir(), '.local', 'share', 'pdl', 'raw');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  try {
    const payload = buf.trim() ? JSON.parse(buf) : {};
    const session = payload.session_id ?? 'unknown';
    mkdirSync(OUT_DIR, { recursive: true });
    const row = { recorded_at: new Date().toISOString(), payload };
    appendFileSync(join(OUT_DIR, `${session}.jsonl`), JSON.stringify(row) + '\n');
  } catch {
    // fail open, always
  }
  process.exit(0);
});
