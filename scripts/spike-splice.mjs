#!/usr/bin/env node
/** Phase 0: prove the marker splice is idempotent and quoting-safe. */
import { createHash } from 'node:crypto';

const START = '<!-- pdl:start -->';
const END = '<!-- pdl:end -->';

export function splice(body, section) {
  const hash = createHash('sha256').update(section).digest('hex').slice(0, 12);
  const block = `${START}\n<!-- pdl:hash=${hash} -->\n${section}\n${END}`;
  const existing = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (existing.test(body)) {
    const current = body.match(existing)[0];
    if (current.includes(`pdl:hash=${hash}`)) return { body, changed: false };
    return { body: body.replace(existing, block), changed: true };
  }
  const sep = body.trim() ? '\n\n' : '';
  return { body: body.trim() + sep + block, changed: true };
}

// --- tests ---
let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); };

const section = '## Decision log\n\n- Ran `npm test`: 42 passed';

const r1 = splice('Fixes the sync bug.', section);
check('inserts into existing body', r1.changed && r1.body.includes('Decision log'));
check('preserves original text', r1.body.startsWith('Fixes the sync bug.'));

const r2 = splice(r1.body, section);
check('second identical run is a no-op', r2.changed === false && r2.body === r1.body);

const r3 = splice(r1.body, section + '\n- Ran `npm run build`: ok');
check('changed content replaces in place', r3.changed === true);
check('no duplicate markers', (r3.body.match(/pdl:start/g) || []).length === 1);
check('original text still intact', r3.body.startsWith('Fixes the sync bug.'));

const r4 = splice('', section);
check('handles empty body', r4.body.startsWith(START));

// Quoting hazards that would break a shell-interpolated --body
const nasty = '## Decision log\n\n- Ran `npm test -- --grep "foo bar"`\n- Cost $(whoami) and `date`\n- Path: C:\\Users\\x\n- Emoji ✓ and 100% done';
const r5 = splice('Body', nasty);
check('round-trips backticks/$()/quotes untouched', r5.body.includes('$(whoami)') && r5.body.includes('"foo bar"') && r5.body.includes('C:\\Users\\x'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
