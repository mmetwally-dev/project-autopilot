import assert from "node:assert/strict";
import {deriveTaskFacts, mergeTaskFacts} from "./task-requirements.mjs";

const ui = deriveTaskFacts({files: ["apps/web/src/app/settings/page.tsx"], verify: "npm run test:e2e", requiredCapabilities: ["paths.unicode"]});
assert.equal(ui.browser, true);
assert.equal(ui.playwright, true);
assert.equal(ui.commands, false, "trusted gate commands do not imply verifier command permission");
const backend = deriveTaskFacts({files: ["src/services/patient.ts"], verify: "npm test"});
assert.equal(backend.browser, false);
assert.equal(backend.playwright, false);
const merged = mergeTaskFacts([{taskFacts: ui}, {taskFacts: backend}]);
assert.equal(merged.browser, true);
assert.equal(merged.playwright, true);
assert.deepEqual(merged.requiredCapabilities, ["paths.unicode"]);
console.log("structural task capability derivation tests passed");
