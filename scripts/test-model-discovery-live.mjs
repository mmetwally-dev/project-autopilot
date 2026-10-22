#!/usr/bin/env node
// Companion to test-model-discovery.mjs, which only exercises the parsing/
// protocol logic against a mock binary. This test calls the REAL installed
// CLI when one is on PATH, so the mock's assumptions get checked against
// actual behavior at least on machines that have codex/opencode installed.
// It is not part of the mock suite's pass/fail because most environments
// (including this repo's own sandboxed test runs) won't have either CLI
// installed — a missing binary is a skip, not a failure.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {discoverModelCatalog} from './model-discovery.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentsFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'adapters', 'agents.json'), 'utf8'));

function isOnPath(binary){
  const probe = process.platform === 'win32' ? spawnSync('where', [binary]) : spawnSync('which', [binary]);
  return probe.status === 0;
}

const targets = [
  {adapter: 'codex', binary: agentsFile.adapters.codex.binary},
  {adapter: 'opencode', binary: agentsFile.adapters.opencode.binary},
];

let ran = 0;
for (const {adapter, binary} of targets) {
  if (!isOnPath(binary)) {
    console.log(`skip: ${adapter} (${binary}) not found on PATH`);
    continue;
  }
  ran++;
  const meta = agentsFile.adapters[adapter];
  const catalog = await discoverModelCatalog(meta);
  if (!Array.isArray(catalog)) throw new Error(`${adapter}: discoverModelCatalog did not return an array`);
  if (!catalog.every(m => m && typeof m.id === 'string' && m.id.length)) {
    throw new Error(`${adapter}: every discovered entry needs a non-empty string id — got ${JSON.stringify(catalog)}`);
  }
  console.log(`${adapter}: discovered ${catalog.length} model(s) from the real CLI — ${catalog.slice(0, 5).map(m => m.id).join(', ')}${catalog.length > 5 ? ', …' : ''}`);
}

if (!ran) {
  console.log('\nno real adapter CLIs found on PATH — live checks skipped (mock-based test-model-discovery.mjs still covers protocol/parsing logic)');
} else {
  console.log(`\nlive model discovery checks passed against ${ran} real CLI(s)`);
}
