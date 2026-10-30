#!/usr/bin/env node
// askE2eChoice (setup.mjs): extracted from source and run with stubs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {detectUiProject, detectE2eTool} from './e2e-detect.mjs';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup.mjs'), 'utf8');
const m = src.match(/const E2E_PROMPT[^\n]*\n\nfunction storedE2e[\s\S]*?\nasync function askE2eChoice[\s\S]*?\n}\n/);
let failed = 0;
const check = (n, c) => { if (!c) { failed++; console.log('FAIL', n); } else console.log('ok', n); };
check('helper found', !!m);

function repoWith(deps) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eq-'));
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({dependencies: deps}));
  return d;
}
async function run(current, repo, interactive, answer) {
  let asked = 0;
  const ctx = {detectUiProject, detectE2eTool, console, ask: async () => { asked++; return Array.isArray(answer) ? answer.shift() : answer; }};
  vm.createContext(ctx);
  vm.runInContext(m[0] + '\nthis.fn = askE2eChoice;', ctx);
  return {value: await ctx.fn(current, repo, interactive), asked};
}
const ui = repoWith({react: '1'});
check('unset+UI asks, yes->playwright', await (async () => { const r = await run({}, ui, true, 'yes'); return r.asked === 1 && r.value === 'playwright'; })());
check('no->none', (await run({}, ui, true, 'no')).value === 'none');
check('cypress->cypress', (await run({}, ui, true, 'cypress')).value === 'cypress');
for (const v of ['none', 'playwright', 'cypress']) {
  const r = await run({capabilities: {verification: {e2e: v}}}, ui, true, 'yes');
  check('stored ' + v + ' not asked, kept', r.asked === 0 && r.value === v);
}
check('typo asks again', await (async () => { const r = await run({}, ui, true, ['cy', 'c']); return r.asked === 2 && r.value === 'cypress'; })());
check('empty->playwright', (await run({}, ui, true, '')).value === 'playwright');
check('non-interactive does not ask', (await run({}, ui, false, 'yes')).asked === 0);
check('existing tool does not ask', (await run({}, repoWith({react: '1', '@playwright/test': '1'}), true, 'yes')).asked === 0);
check('no UI does not ask', (await run({}, repoWith({}), true, 'yes')).asked === 0);
process.exit(failed ? 1 : 0);
