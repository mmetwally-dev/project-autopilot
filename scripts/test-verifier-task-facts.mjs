// Backlog 11: standalone and SpecKit verifier calls must receive taskFacts
// derived from the phase's task lines, so UI-file and Playwright tasks add the
// browser capability without an explicit autopilot-requires tag.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildRoleRequirements} from "./role-requirements.mjs";
import {mergeTaskLineFacts, browserVerifierNote} from "./task-requirements.mjs";
import * as standalone from "../adapters/standalone.mjs";
import * as speckit from "../adapters/speckit.mjs";

const config = {capabilities: {legacy_text_inference: false, verification: {browser: "native", require_browser: "when-task-requires"}}};
const verifierReqs = tasks => buildRoleRequirements({
  config, roleName: "verifier",
  explicit: tasks.flatMap(t => t.requiredCapabilities || []),
  taskFacts: mergeTaskLineFacts(tasks)
});
const hasBrowser = reqs => reqs.some(r => String(typeof r === "string" ? r : r.id).startsWith("browser."));

const uiLine = "- [ ] **1.1** Build the patient form in `app/patients/form.tsx` — accept: form renders; verify: npm test -- patients";
const pwLine = "- [ ] **1.2** Add checkout flow — accept: flow works; verify: npx playwright test checkout";
const backendLine = "- [ ] **1.3** Add repository in src/services/patient.ts — accept: saves; verify: npm test -- patient";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-verifier-facts-"));
try {
  const write = (rel, body) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, body); };
  const tasksOf = (name, lines) => `## Phase 1: ${name}\n${lines.join("\n")}\n`;
  const sets = {ui: [uiLine], playwright: [pwLine], backend: [backendLine], mixed: [backendLine, uiLine]};
  for (const [key, lines] of Object.entries(sets)) {
    write(`.autopilot/missions/m-${key}/PLAN.md`, "# Plan\n");
    write(`.autopilot/missions/m-${key}/TASKS.md`, tasksOf(key, lines));
    write(`specs/${key}/tasks.md`, tasksOf(key, lines));
  }
  for (const [loop, load] of [
    ["standalone", key => standalone.phases(repo, `m-${key}`)[0].tasks],
    ["speckit", key => speckit.phases(repo, [`specs/${key}/tasks.md`])[0].tasks]
  ]) {
    for (const key of Object.keys(sets)) assert.equal(load(key).length, sets[key].length, `${loop} ${key}: tasks parsed`);
    assert.ok(hasBrowser(verifierReqs(load("ui"))), `${loop}: UI-file task adds browser.*`);
    assert.ok(verifierReqs(load("playwright")).includes("browser.playwright.deterministic"), `${loop}: Playwright verify adds deterministic browser`);
    assert.ok(hasBrowser(verifierReqs(load("mixed"))), `${loop}: mixed phase adds browser.*`);
    const backend = verifierReqs(load("backend"));
    assert.ok(!hasBrowser(backend), `${loop}: backend-only task adds no browser.*`);
    assert.ok(browserVerifierNote(mergeTaskLineFacts(load("ui"))).includes("dev server"), `${loop}: UI brief names the dev server`);
    assert.equal(browserVerifierNote(mergeTaskLineFacts(load("backend"))), "", `${loop}: backend brief has no browser note`);
  }
} finally {
  fs.rmSync(repo, {recursive: true, force: true});
}

// Both loops' verifier relay calls must actually pass the phase facts and the note.
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "autopilot.mjs"), "utf8");
const verifierCalls = src.split(/\n/).filter(l => l.includes("review:true,requirements:phaseRequirements,taskFacts:phaseTaskFacts,taskRef:verifyRef"));
assert.equal(verifierCalls.length, 2, "standalone and SpecKit verifier calls both pass taskFacts:phaseTaskFacts");
assert.equal((src.match(/const phaseTaskFacts=mergeTaskLineFacts\(phaseTasks\);/g) || []).length, 2, "both loops derive phaseTaskFacts from phaseTasks");
assert.equal((src.match(/browserVerifierNote\(phaseTaskFacts\)\?/g) || []).length, 2, "both verifier briefs include the browser note");
console.log("verifier task facts tests passed");
