#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDocumentedCatalog} from './model-discovery.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '..', 'adapters', 'documented-models');

// Every shipped catalog file must be well-formed JSON with a real source URL,
// a dated last_verified stamp, and at least one labeled entry — this fails
// loudly on a bad file instead of loadDocumentedCatalog silently swallowing it.
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
if (!files.length) throw new Error('No documented model catalogs found under adapters/documented-models/.');

for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); // throws on malformed JSON
  if (typeof raw.source !== 'string' || !/^https?:\/\//.test(raw.source)) {
    throw new Error(`${f}: "source" must be an http(s) URL`);
  }
  if (typeof raw.last_verified !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.last_verified)) {
    throw new Error(`${f}: "last_verified" must be a YYYY-MM-DD date`);
  }
  if (!Array.isArray(raw.models) || !raw.models.length) {
    throw new Error(`${f}: "models" must be a non-empty array`);
  }
  for (const m of raw.models) {
    if (!m.id || !m.label) throw new Error(`${f}: every model needs an id and a label`);
  }
}

// The module API must resolve the same data, and must not invent a catalog
// for an adapter that ships none.
const claude = loadDocumentedCatalog('claude');
if (!claude || !Array.isArray(claude.models) || !claude.models.length) {
  throw new Error('loadDocumentedCatalog("claude") did not return a usable catalog');
}
const opus = claude.models.find(m => m.id === 'opus');
if (!opus || !Array.isArray(opus.reasoning) || !opus.reasoning.includes('high')) {
  throw new Error('Claude documented catalog must expose model-specific reasoning levels for opus');
}
const sonnet = claude.models.find(m => m.id === 'sonnet');
if (!sonnet || !Array.isArray(sonnet.reasoning) || !sonnet.reasoning.includes('high') || !sonnet.reasoning.includes('xhigh') || !sonnet.reasoning.includes('max')) {
  throw new Error('Claude sonnet reasoning levels are incorrect for the current documented aliases');
}
const fable = claude.models.find(m => m.id === 'fable');
if (!fable || !Array.isArray(fable.reasoning) || !fable.reasoning.includes('max')) {
  throw new Error('Claude fable alias or reasoning levels are missing');
}
if (loadDocumentedCatalog('does-not-exist') !== null) {
  throw new Error('loadDocumentedCatalog should return null for an adapter with no shipped snapshot');
}

console.log(`documented model catalog tests passed (${files.length} file(s) checked)`);
