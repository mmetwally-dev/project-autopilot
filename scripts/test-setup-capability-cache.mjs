#!/usr/bin/env node
import { buildDiscoveryCaches } from './setup-discovery.mjs';

const calls = [];
const agents = { opencode: { binary: 'opencode' } };
const first = {
  capabilities: { model: true, model_flag: '--model', effort: false, variant: true, variant_flag: null, resume: true },
  models: { status: 'reported', items: [{ id: 'opencode/model-a', label: 'Model A', reasoning: [], variants: ['low', 'high'] }] }
};
const second = {
  capabilities: { model: false, model_flag: null, effort: false, variant: true, variant_flag: null, resume: false },
  models: { status: 'reported', items: [] }
};
const { capabilityCache, contractCache } = await buildDiscoveryCaches(
  ['opencode'], agents,
  async id => { calls.push(id); return calls.length === 1 ? first : second; }
);
if (calls.length !== 1) throw new Error(`expected one discovery probe, got ${calls.length}`);
if (capabilityCache.get('opencode')?.model !== true) throw new Error('capability cache missing first probe result');
if (contractCache.get('opencode')?.models?.items?.[0]?.id !== 'opencode/model-a') throw new Error('model catalog cache missing');
console.log('setup capability discovery cache regression passed');
