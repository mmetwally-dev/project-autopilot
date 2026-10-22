import assert from 'node:assert/strict';
import fs from 'node:fs';
const src=fs.readFileSync(new URL('./agent-process.mjs', import.meta.url),'utf8');
assert.match(src, /where\.exe/);
assert.match(src, /sorted\[0\]/);
assert.doesNotMatch(src, /for\s*\(const candidate of whereCandidates/);
console.log('windows cli resolution static test passed');
