import { strict as assert } from 'node:assert';
import { discoverAgentContract } from './agent-contract.mjs';

const adapter = {
  binary: 'fake',
  probe: ['--version'],
  write: ['run'],
  read_only: ['plan'],
  model_flag: '--model',
  effort_flag: '--effort',
  variant_flag: null,
  model_discovery: 'manual'
};

const result = await discoverAgentContract('fake', adapter);
assert.equal(result.access.method, 'cli');
assert.equal(result.access.requires_api_key, false);
assert.equal(result.models.status, 'unsupported');
console.log('CLI access-mode discovery is CLI-auth based and API-key independent');
