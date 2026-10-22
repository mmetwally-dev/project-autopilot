import { discoverAgentContract } from './agent-contract.mjs';
import { discoverCapabilities } from './model-discovery.mjs';

export async function buildDiscoveryCaches(availableIds, agentsMap, discoverFn = discoverAgentContract) {
  const capabilityCache = new Map();
  const contractCache = new Map();
  for (const id of availableIds) {
    try {
      const contract = await discoverFn(id, agentsMap[id]);
      contractCache.set(id, contract);
      capabilityCache.set(id, contract?.capabilities || await discoverCapabilities(agentsMap[id]));
    } catch {
      capabilityCache.set(id, await discoverCapabilities(agentsMap[id]));
    }
  }
  return { capabilityCache, contractCache };
}
