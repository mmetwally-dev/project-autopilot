import assert from "node:assert/strict";
import crypto from "node:crypto";
import {effectiveCapabilities, ISOLATION_TRUSTED_EQUIVALENTS, missionEffectiveCapabilities, missingCapabilities, normalizeRequirement, RUNTIME_VERIFIED_CAPABILITY_IDS, sha256, TRUSTED_REPOSITORY_IMMUTABILITY_CAPABILITIES, validateCapabilityDeclaration} from "./capability-contract.mjs";
import {adapterDriver} from "./adapter-drivers.mjs";

const declared = {
  "repository.read": true,
  "repository.write": true,
  "browser.native.originScopedPermission": false,
  "browser.native.permissionScope": "tool"
};
assert.equal(validateCapabilityDeclaration({capabilities: declared}).ok, true);
assert.equal(validateCapabilityDeclaration({capabilities: {"invented.capability": true}}).ok, false);
assert.equal(validateCapabilityDeclaration({capabilities: {"safety.network.egressDenied": true}}).ok, false, "adapters cannot self-declare execution-plane safety");
const binaryFixture = Buffer.alloc(1024 * 1024, 0xa5);
assert.equal(sha256(binaryFixture), crypto.createHash("sha256").update(binaryFixture).digest("hex"), "binary fingerprints must hash raw bytes without JSON expansion");
const effective = effectiveCapabilities({
  declared,
  certified: {...declared},
  runtime: {...declared},
  safetyDenied: ["repository.write"]
});
assert.equal(effective["repository.read"], true);
assert.equal(effective["repository.write"], undefined, "safety policy must dominate declaration and certification");
assert.equal(effective["browser.native.originScopedPermission"], false, "certified constraints must retain false values");
assert.equal(effective["browser.native.permissionScope"], "tool");
assert.deepEqual(missingCapabilities(["repository.read", "repository.write", {id: "browser.native.permissionScope", equals: "tool"}], effective), ["repository.write"]);
assert.deepEqual(normalizeRequirement("browser.native.permissionScope=tool"), {id: "browser.native.permissionScope", equals: "tool"});
assert.throws(() => normalizeRequirement("repository.read=false-and-unsafe"));
const mission = missionEffectiveCapabilities({functional: effective, executionSafety: {"safety.network.egressDenied": true}});
assert.equal(mission["safety.network.egressDenied"], true);
const trustedRepositorySafety = Object.fromEntries(TRUSTED_REPOSITORY_IMMUTABILITY_CAPABILITIES.map(id => [id, true]));
assert.ok(!TRUSTED_REPOSITORY_IMMUTABILITY_CAPABILITIES.includes("safety.runtime.adapterProcessEnveloped"), "runtime availability must remain separate from repository immutability");
const envelopeBackedReadOnly = missionEffectiveCapabilities({functional: effective, executionSafety: trustedRepositorySafety});
assert.equal(envelopeBackedReadOnly["isolation.repositoryReadOnly"], true, "trusted envelope proofs satisfy effective repository immutability");
for (const absentCapability of TRUSTED_REPOSITORY_IMMUTABILITY_CAPABILITIES) {
  const incompleteSafety = {...trustedRepositorySafety};
  delete incompleteSafety[absentCapability];
  const incomplete = missionEffectiveCapabilities({functional: effective, executionSafety: incompleteSafety});
  assert.equal(incomplete["isolation.repositoryReadOnly"], undefined, `missing ${absentCapability} must fail closed`);
}
const deniedSafetySource = missionEffectiveCapabilities({functional: effective, executionSafety: trustedRepositorySafety, safetyDenied: ["safety.filesystem.scratchWrite"]});
assert.equal(deniedSafetySource["isolation.repositoryReadOnly"], undefined, "active safety denial must prevent trusted substitution");
const deniedReadOnly = missionEffectiveCapabilities({functional: effective, executionSafety: trustedRepositorySafety, safetyDenied: ["isolation.repositoryReadOnly"]});
assert.equal(deniedReadOnly["isolation.repositoryReadOnly"], undefined, "policy denial of the derived invariant must remain authoritative");

// Gap 3: "runtime" must not be able to fabricate a third opinion by echoing
// the declaration. Only ids with a live probe (today: cli.discovery) may
// gate on it; every other id is declared/certified agreement only, and a
// runtime value that disagrees with a live-probed id must sink it.
assert.deepEqual([...RUNTIME_VERIFIED_CAPABILITY_IDS], ["cli.discovery"], "only cli.discovery has a live runtime probe today");
const nonProbedAgreement = effectiveCapabilities({
  declared: {"repository.read": true},
  certified: {"repository.read": true},
  runtime: {"repository.read": false},
  safetyDenied: []
});
assert.equal(nonProbedAgreement["repository.read"], true, "declared/certified agreement stands on its own where no live probe exists");
const probedDisagreement = effectiveCapabilities({
  declared: {"cli.discovery": true},
  certified: {"cli.discovery": true},
  runtime: {"cli.discovery": false},
  safetyDenied: []
});
assert.equal(probedDisagreement["cli.discovery"], undefined, "a live-probed id must fail when runtime disagrees with declared/certified");
const probedAgreement = effectiveCapabilities({
  declared: {"cli.discovery": true},
  certified: {"cli.discovery": true},
  runtime: {"cli.discovery": true},
  safetyDenied: []
});
assert.equal(probedAgreement["cli.discovery"], true, "a live-probed id passes when all three sources agree");

// Gap 4/5: every mission-trusted isolation.* alias has a single named
// safety.* equivalent (ISOLATION_TRUSTED_EQUIVALENTS). The additive
// derivation above (functional pass-through, plus the isolation.repositoryReadOnly
// upgrade when the full immutability proof set holds) can still let an alias
// through on functional's declared===certified match on the alias id ALONE —
// adapter self-declaration corroborated by a certification scenario, not
// proof the environment enforces anything. The revocation pass must strike
// any such alias whose named equivalent was not itself certified true in
// executionSafety, regardless of how the alias reached `effective`.
assert.deepEqual(Object.keys(ISOLATION_TRUSTED_EQUIVALENTS).sort(), [
  "isolation.gitMutationDenied",
  "isolation.outsideScratchDenied",
  "isolation.repositoryReadOnly",
  "isolation.scratchWrite"
], "every mission-trusted isolation alias must carry a named equivalent");
for (const [isolationId, safetyId] of Object.entries(ISOLATION_TRUSTED_EQUIVALENTS)) {
  const weakClaim = {...effective, [isolationId]: true};
  const revoked = missionEffectiveCapabilities({functional: weakClaim, executionSafety: {}});
  assert.equal(revoked[isolationId], undefined, `${isolationId}: a functional-only claim must be revoked without ${safetyId} certified true`);
  const kept = missionEffectiveCapabilities({functional: weakClaim, executionSafety: {[safetyId]: true}});
  assert.equal(kept[isolationId], true, `${isolationId}: the claim survives once its named equivalent is certified true`);
}
assert.equal(validateCapabilityDeclaration({capabilities: {"isolation.scratchWrite": true}}).ok, false, "adapters cannot self-declare trusted isolation aliases");
assert.equal(validateCapabilityDeclaration({capabilities: {"isolation.repositoryReadOnly": true}}).ok, false, "adapters cannot self-declare trusted isolation aliases");

// Runtime-leg honesty (moved from the removed test-b3-isolation-aliases.mjs):
// only cli.discovery has a live runtime probe, so effectiveCapabilities() must
// let declared===certified agreement on isolation.* ids stand on its own even
// when a stray runtime value disagrees.
assert.ok(RUNTIME_VERIFIED_CAPABILITY_IDS.length === 1 && RUNTIME_VERIFIED_CAPABILITY_IDS[0] === "cli.discovery", "RUNTIME_VERIFIED_CAPABILITY_IDS covers only cli.discovery");
for (const isolationId of Object.keys(ISOLATION_TRUSTED_EQUIVALENTS)) {
  const twoSourceAgreement = effectiveCapabilities({
    declared: {[isolationId]: true},
    certified: {[isolationId]: true},
    runtime: {[isolationId]: false},
    safetyDenied: []
  });
  assert.equal(twoSourceAgreement[isolationId], true, `${isolationId}: declared+certified agreement stands despite a disagreeing runtime value`);
}

const probe = {readPath: "C:/repo/read.txt", productionWritePath: "C:/repo/write.txt", outsideWritePath: "C:/outside.txt", root: "C:/repo"};
const selfReport = adapterDriver("codex").observe([{type: "agent_message", text: "I wrote C:/repo/write.txt and ran git commit"}], probe);
assert.deepEqual(selfReport, [], "agent prose must not become trusted capability evidence");
const commandEvent = adapterDriver("codex").observe([{type: "item.started", item: {type: "command_execution", command: "git commit -m x"}}], probe);
assert.ok(commandEvent.some(event => event.type === "git_mutation_attempted"));
console.log("capability contract and trusted-event tests passed");
