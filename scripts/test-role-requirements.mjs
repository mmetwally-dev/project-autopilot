import assert from "node:assert/strict";
import {buildRoleRequirements, parseGsdRequirements, parseInlineRequirements, stripInlineRequirements} from "./role-requirements.mjs";

const config = {
  capabilities: {
    project_defaults: ["commands.execute"],
    role_requirements: {verifier: ["paths.unicode"]},
    legacy_text_inference: false,
    verification: {browser: "native", require_browser: "when-task-requires"}
  }
};
const annotation = "Build settings <!-- autopilot-requires: browser.native.supported verifier:browser.native.permissionScope=tool implementer:paths.spaces -->";
const explicit = parseInlineRequirements(annotation);
assert.ok(explicit.includes("browser.native.supported"));
assert.equal(stripInlineRequirements(annotation), "Build settings");
const verifier = buildRoleRequirements({config, roleName: "verifier", taskText: "UI dashboard", explicit});
assert.ok(verifier.includes("commands.execute"));
assert.ok(verifier.includes("isolation.repositoryReadOnly"));
assert.ok(verifier.includes("browser.native.supported"));
assert.ok(verifier.some(requirement => requirement.id === "browser.native.permissionScope" && requirement.equals === "tool"));
const implementer = buildRoleRequirements({config, roleName: "implementer", explicit});
assert.ok(implementer.includes("paths.spaces"));
assert.ok(!implementer.includes("browser.native.supported"), "unscoped task requirements belong to verification by default");

const structured = buildRoleRequirements({config, roleName: "verifier", taskFacts: {browser: true, playwright: true}});
assert.ok(structured.includes("browser.native.supported"));
assert.ok(structured.includes("browser.playwright.deterministic"));
const noLegacy = buildRoleRequirements({config, roleName: "verifier", taskText: "browser dashboard"});
assert.ok(!noLegacy.includes("browser.native.supported"));
const legacy = buildRoleRequirements({config: {capabilities: {...config.capabilities, legacy_text_inference: true}}, roleName: "verifier", taskText: "browser dashboard"});
assert.ok(legacy.includes("browser.native.supported"));
assert.deepEqual(parseGsdRequirements("<requires>verifier:browser.native.supported commands.execute</requires>"), ["verifier:browser.native.supported", "commands.execute"]);
assert.throws(() => buildRoleRequirements({config, roleName: "verifier", explicit: ["isolation.repositoryReadOnly=false"]}), /cannot weaken/);
const selected = buildRoleRequirements({config, roleName: "implementer", role: {model: "certified-model", reasoning: "high"}});
assert.ok(selected.includes("selection.model"), "configured model selection must be admitted explicitly");
assert.ok(selected.includes("selection.effort"), "configured reasoning selection must be admitted explicitly");
const defaults = buildRoleRequirements({config, roleName: "implementer", role: {model: "", reasoning: ""}});
assert.ok(!defaults.includes("selection.model") && !defaults.includes("selection.effort"), "CLI defaults must not require an unrequested selector");
console.log("role requirement precedence and structured annotation tests passed");
