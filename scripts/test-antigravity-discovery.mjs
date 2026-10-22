import assert from 'node:assert/strict';
import {parseAntigravityModels} from './model-discovery.mjs';
const sample=[
'gemini-3.7-flash-high     Gemini 3.7 Flash (High)',
'gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)',
'gemini-3.7-flash-low      Gemini 3.7 Flash (Low)',
'gemini-3.6-flash-high     Gemini 3.6 Flash (High)',
'gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)',
'gemini-3.6-flash-low      Gemini 3.6 Flash (Low)',
'gemini-3.1-pro-high       Gemini 3.1 Pro (High)',
'gemini-3.1-pro-low        Gemini 3.1 Pro (Low)',
'claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)',
'claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)',
'gpt-oss-120b-medium       GPT-OSS 120B (Medium)'
].join('\n');
const catalog=parseAntigravityModels(sample);
const flash=catalog.find(x=>x.id==='gemini-3.7-flash');
assert(flash);
assert.deepEqual(flash.reasoning,['low','medium','high']);
assert.equal(flash.effortModelIds.low,'gemini-3.7-flash-low');
assert.equal(flash.effortModelIds.medium,'gemini-3.7-flash-medium');
assert.equal(flash.effortModelIds.high,'gemini-3.7-flash-high');
assert.equal(catalog.find(x=>x.id==='gemini-3.1-pro').effortModelIds.high,'gemini-3.1-pro-high');
assert.equal(catalog.find(x=>x.id==='claude-sonnet-4-6').reasoning.length,0);
console.log('antigravity discovery regression passed');
