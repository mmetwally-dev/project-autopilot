#!/usr/bin/env node
// Backlog #5 item 5: the "documented non-live catalog" warnings print as ONE
// grouped entry; the validator's own warning list is not changed.
import {formatValidationWarnings} from "./config-validation.mjs";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`); }
}

const W = (label, model) => `${label}: model '${model}' is from a documented non-live catalog; account/subscription availability was not verified.`;
const roles = {
  planner: {adapter: "claude", escalation_model: {adapter: "claude"}},
  plan_reviewer: {adapter: "claude"},
  implementer: {adapter: "claude", escalation_model: {adapter: "claude"}},
  code_reviewer: {adapter: "claude"},
  verifier: {adapter: "claude"}
};

// Same escalation model for planner + implementer; escalation entries arrive
// before some roles on purpose to prove the printed order is normalised.
const warnings = [
  "implementer: something else entirely.",
  W("planner.escalation_model", "claude-opus-4-7"),
  W("verifier", "claude-haiku-4-5"),
  W("planner", "claude-opus-4-7"),
  W("implementer.escalation_model", "claude-opus-4-7"),
  W("plan_reviewer", "claude-sonnet-4-6"),
  "code_reviewer: other warning."
];
const before = JSON.stringify(warnings);
const out = formatValidationWarnings(warnings, roles);
check("input warning list is not mutated", JSON.stringify(warnings) === before);
check("other warnings keep their one-line form, before the group",
  out[0] === "  ⚠ implementer: something else entirely." && out[1] === "  ⚠ code_reviewer: other warning.", JSON.stringify(out));
check("exactly one grouped entry header", out.filter(l => l.includes("Claude models are taken from Claude's documented list and could not be checked")).length === 1, out.join("\n"));
check("second header line names Claude Code", out.includes("    against your account (Claude Code has no model-list command):"), out.join("\n"));
check("roles in the normal order on one line",
  out.includes("    planner: claude-opus-4-7 · plan_reviewer: claude-sonnet-4-6 · verifier: claude-haiku-4-5"), out.join("\n"));
check("same escalation shown once as (planner + implementer), last",
  out[out.length - 1] === "    escalation (planner + implementer): claude-opus-4-7", out.join("\n"));
check("no per-role long warning is printed", !out.some(l => /documented non-live catalog/.test(l)), out.join("\n"));

const diff = formatValidationWarnings([
  W("planner.escalation_model", "claude-opus-4-7"),
  W("implementer.escalation_model", "claude-sonnet-4-6"),
  W("planner", "claude-opus-4-7")
], roles);
check("different escalation models are shown separately",
  diff[diff.length - 1] === "    escalation (planner): claude-opus-4-7 · escalation (implementer): claude-sonnet-4-6", diff.join("\n"));

const one = formatValidationWarnings([W("implementer.escalation_model", "claude-opus-4-7")], roles);
check("single escalation names its role", one[one.length - 1] === "    escalation (implementer): claude-opus-4-7", one.join("\n"));

const fb = formatValidationWarnings([
  W("planner.fallbacks[1]", "claude-haiku-4-5"),
  W("planner", "claude-opus-4-7")
], {planner: {adapter: "claude", fallbacks: [{adapter: "claude"}, {adapter: "claude"}]}});
check("fallback warnings go on the role line", fb.includes("    planner: claude-opus-4-7 · planner fallback 2: claude-haiku-4-5"), fb.join("\n"));

const other = formatValidationWarnings([W("planner", "gpt-x")], {planner: {adapter: "codex"}});
check("other catalogs use their adapter name", other[0].includes("codex models are taken from codex's documented list") && other[1].includes("(codex has no model-list command)"), other.join("\n"));

check("no warnings -> no lines", formatValidationWarnings([], roles).length === 0);

// The validator's detection regex for "Save anyway?" is untouched and the
// non-live catalog warning does not trigger it (unchanged behaviour).
const here = path.dirname(fileURLToPath(import.meta.url));
const setupSrc = fs.readFileSync(path.join(here, "setup.mjs"), "utf8");
check("Save anyway regex unchanged",
  setupSrc.includes("/not be live-verified|outside the documented catalog|manual selection is unverified|model-unverified/i") &&
  setupSrc.includes("Some model selections could not be live-verified. Save anyway?"));
const validatorSrc = fs.readFileSync(path.join(here, "config-validation.mjs"), "utf8");
check("validator still emits the per-role long warning",
  validatorSrc.includes("is from a documented non-live catalog; account/subscription availability was not verified."));

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
