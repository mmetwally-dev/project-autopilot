#!/usr/bin/env node
// Pending #22: one-round escalation model for planner / implementer.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scheduleEscalation, pendingEscalationModel, consumeEscalationFor, stuckFinding, normalizeEscalationModel,
  recordVerifierRound, verifierRoundLines, clearVerifierHistory, formatEscalationLog
} from "./escalation-model.mjs";
import { recordPlanReviewRound, planReviewerRoundLines } from "./plan-review-rounds.mjs";
import { migrateConfig } from "./config-migration.mjs";
import { toRuntimeConfig } from "./config-layout.mjs";
import { validateRoleSelection } from "./config-validation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ESC = { adapter: "claude", model: "claude-sonnet-5", reasoning: "high" };
const cfg = { roles: { planner: { adapter: "opencode", model: "free-x", escalation_model: ESC }, implementer: { adapter: "opencode", model: "free-y", escalation_model: ESC }, code_reviewer: {} } };
const NF = [{ finding: "missing regression test", status: "not_fixed" }];
const FIXED = [{ finding: "missing regression test", status: "fixed" }];
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`PASS ${name}`); };

t("trigger on a not_fixed previous record (same finding in two consecutive rounds)", () => {
  const s = {};
  const r = scheduleEscalation(s, cfg, { role: "implementer", scopeKey: "standalone-phase:2", source: "code_reviewer", previous: NF, round: 2 });
  assert.ok(r); assert.equal(r.finding, "missing regression test");
  assert.deepEqual(pendingEscalationModel(s, cfg, "implementer"), ESC);
  assert.ok(s.escalationSwitches["standalone-phase:2"]);
});

t("retries.escalate_after_not_fixed: 2 waits for a second not_fixed report, 1 keeps the old trigger", () => {
  const history = [
    { round: 1, findings: ["missing regression test"], previous: [] },
    { round: 2, findings: ["missing regression test"], previous: NF },
    { round: 3, findings: ["missing regression test"], previous: NF },
  ];
  const once = {};
  assert.equal(scheduleEscalation(once, cfg, { role: "implementer", scopeKey: "k", source: "code_reviewer", previous: NF, history, round: 3, minConsecutiveNotFixed: 3 }), null);
  assert.equal(once.escalationSwitches, undefined);
  const twice = {};
  assert.ok(scheduleEscalation(twice, cfg, { role: "implementer", scopeKey: "k", source: "code_reviewer", previous: NF, history, round: 3, minConsecutiveNotFixed: 2 }));
  const old = {};
  assert.ok(scheduleEscalation(old, cfg, { role: "implementer", scopeKey: "k", source: "code_reviewer", previous: NF, round: 2, minConsecutiveNotFixed: 1 }));
});

t("no trigger on new findings only, fixed, or empty previous", () => {
  for (const prev of [undefined, [], FIXED, [{ finding: "x", status: "bogus" }]]) {
    const s = {};
    assert.equal(scheduleEscalation(s, cfg, { role: "implementer", scopeKey: "k", source: "code_reviewer", previous: prev, round: 2 }), null);
    assert.equal(s.escalationPending, undefined);
  }
  assert.equal(stuckFinding(NF), "missing regression test");
});

t("off when escalation_model is not configured", () => {
  const s = {};
  assert.equal(scheduleEscalation(s, { roles: { implementer: { adapter: "a", model: "m" } } }, { role: "implementer", scopeKey: "k", source: "verifier", previous: NF, round: 2 }), null);
  assert.equal(scheduleEscalation(s, { roles: { implementer: { escalation_model: { adapter: "a" } } } }, { role: "implementer", scopeKey: "k", source: "verifier", previous: NF, round: 2 }), null);
  assert.equal(s.escalationSwitches, undefined);
});

t("one round, then back: the next reviewer/verifier start consumes the pending escalation", () => {
  const s = {};
  scheduleEscalation(s, cfg, { role: "implementer", scopeKey: "k", source: "verifier", previous: NF, round: 2 });
  assert.deepEqual(pendingEscalationModel(s, cfg, "implementer"), ESC);
  assert.equal(consumeEscalationFor(s, "plan_reviewer"), null, "plan reviewer does not end an implementer round");
  assert.deepEqual(pendingEscalationModel(s, cfg, "implementer"), ESC);
  assert.equal(consumeEscalationFor(s, "code_reviewer"), "implementer");
  assert.equal(pendingEscalationModel(s, cfg, "implementer"), null);
  assert.equal(s.escalationPending, undefined);
});

t("max once per scope (restart-safe), but a different scope can escalate again", () => {
  const s = {};
  assert.ok(scheduleEscalation(s, cfg, { role: "implementer", scopeKey: "standalone-phase:1", source: "code_reviewer", previous: NF, round: 2 }));
  consumeEscalationFor(s, "code_reviewer");
  const reloaded = JSON.parse(JSON.stringify(s));
  assert.equal(scheduleEscalation(reloaded, cfg, { role: "implementer", scopeKey: "standalone-phase:1", source: "verifier", previous: NF, round: 2 }), null);
  assert.equal(pendingEscalationModel(reloaded, cfg, "implementer"), null);
  assert.ok(scheduleEscalation(reloaded, cfg, { role: "implementer", scopeKey: "standalone-phase:2", source: "verifier", previous: NF, round: 2 }));
});

t("planner path: plan_reviewer previous record is stored per round and triggers the planner", () => {
  const s = {};
  recordPlanReviewRound(s, "plan:standalone", ["Plan is missing X"]);
  assert.deepEqual(s.planReviewHistory["plan:standalone"][0].previous, []);
  recordPlanReviewRound(s, "plan:standalone", ["Plan is missing X"], [{ finding: "Plan is missing X", status: "not_fixed" }]);
  const stored = s.planReviewHistory["plan:standalone"][1].previous;
  assert.deepEqual(stored, [{ finding: "Plan is missing X", status: "not_fixed" }]);
  assert.match(planReviewerRoundLines(s, "plan:standalone")[0], /"previous":\[\{"finding"/);
  assert.ok(scheduleEscalation(s, cfg, { role: "planner", scopeKey: "plan:standalone", source: "plan_reviewer", previous: stored, round: 2 }));
  assert.deepEqual(pendingEscalationModel(s, cfg, "planner"), ESC);
  assert.equal(consumeEscalationFor(s, "plan_reviewer"), "planner");
  assert.equal(pendingEscalationModel(s, cfg, "planner"), null);
});

t("verifier path: FAIL rounds store the previous record, brief asks for it, history clears", () => {
  const s = {};
  assert.deepEqual(verifierRoundLines(s, "k"), []);
  recordVerifierRound(s, "k", ["login still fails"]);
  const lines = verifierRoundLines(s, "k");
  assert.match(lines[0], /"previous":\[\{"finding"/);
  assert.match(lines[1], /login still fails/);
  recordVerifierRound(s, "k", ["login still fails"], [{ finding: "login still fails", status: "not_fixed" }]);
  assert.equal(s.verifierHistory.k[1].previous[0].status, "not_fixed");
  assert.ok(scheduleEscalation(s, cfg, { role: "implementer", scopeKey: "k", source: "verifier", previous: s.verifierHistory.k[1].previous, round: 2 }));
  clearVerifierHistory(s, "k");
  assert.equal(s.verifierHistory, undefined);
});

t("round 1 never triggers, even with a not_fixed record", () => {
  const s = {};
  assert.equal(scheduleEscalation(s, cfg, { role: "implementer", scopeKey: "k", source: "code_reviewer", previous: NF, round: 1 }), null);
  assert.equal(s.escalationSwitches, undefined);
});

t("removing escalation_model from config mid-mission cancels the pending round", () => {
  const s = {};
  scheduleEscalation(s, cfg, { role: "implementer", scopeKey: "k", source: "verifier", previous: NF, round: 2 });
  assert.equal(pendingEscalationModel(s, { roles: { implementer: {} } }, "implementer"), null);
});

t("source: failed escalated run skips the normal fallback chain and re-runs on the normal model", () => {
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  assert.match(src, /let escalated=false;/);
  assert.match(src, /if\(escalated\)\{[\s\S]{0,900}result\.escalationFailed=true;[\s\S]{0,200}\}else\s*\n?\s*try\{\s*const from=/);
  assert.match(src, /escalation model \$\{role\.model\|\|"\?"\} failed/);
  assert.match(src, /if\(result\?\.escalationFailed && Number\(__fallbackDepth\|\|0\)<8\)/);
  const setup = fs.readFileSync(path.join(here, "setup.mjs"), "utf8");
  assert.match(setup, /if \(prior\) \{\s*console\.log\("  No model picked; keeping the current escalation model\."\)/);
});

t("log line names role, models, source and finding", () => {
  const line = formatEscalationLog({ role: "implementer", from: { adapter: "opencode", model: "free-y" }, to: ESC, finding: "missing regression test", source: "code_reviewer" });
  assert.match(line, /^escalation: implementer opencode\/free-y → claude\/claude-sonnet-5/);
  assert.match(line, /code_reviewer/);
  assert.deepEqual(normalizeEscalationModel({ ...ESC, junk: 1 }), ESC);
});

t("source wiring: autopilot.mjs triggers from all three sources, applies and consumes the pin", () => {
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  for (const [role, source] of [["planner", "plan_reviewer"], ["implementer", "code_reviewer"], ["implementer", "verifier"]]) {
    assert.ok(new RegExp(`noteEscalationTrigger\\(s,c,"${role}",[^\\n]*?"${source}"`).test(src), `${role}/${source} trigger wired`);
  }
  assert.match(src, /pendingEscalationModel\(s,c,roleName\)/);
  assert.match(src, /consumeEscalationFor\(s,roleName\)/);
  assert.match(src, /clearRoleSession\(s,roleName\); \}/, "escalation switch starts a fresh session");
  assert.match(src, /type:"model_escalation"/);
  assert.match(src, /"escalationSwitches","escalationPending","verifierHistory"/, "cleared at a new mission");
  assert.match(src, /delete s\.escalationSwitches/);
  assert.match(src, /verifierRoundLines\(s,codeReviewScopeKey\("standalone-phase"/);
  assert.match(src, /role\.escalation_model/);
});

t("setup: optional question for planner/implementer, default skip, asked right after the role loop and interactive-only", () => {
  const src = fs.readFileSync(path.join(here, "setup.mjs"), "utf8");
  assert.match(src, /Use a stronger model for the \$\{who\} when/);
  assert.match(src, /Stronger model for the \$\{who\} when stuck: \$\{currentText\}/);
  assert.match(src, /\["No \(off\)", escRoles\.length > 1 \? "Yes — choose one model for both"/);
  assert.ok(!/Stronger model to use for one round/.test(src), "old per-role question is gone");
  const i = src.indexOf("Pending #22: optional \"stronger model");
  const fw = src.lastIndexOf("const labels = frameworkChoices.map(x => x.label);");
  const loopEnd = src.lastIndexOf("fallbacks = addFallback(fallbacks, candidate);");
  assert.ok(fw > 0 && loopEnd > 0 && i > loopEnd && i < fw, "asked after the last role's questions and before Planning framework");
  assert.ok(i < src.indexOf("await validateConfigForSave("), "asked before the main validation so it covers the escalation models");
  assert.ok(!src.includes("validation = await repairMissingModels(await revalidate());"), "no post-escalation revalidation left");
  assert.match(src.slice(i, i + 700), /if \(interactive\)/);
});

// Config: migration keeps it, validation accepts/rejects.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-p22-"));
const bin = path.join(dir, "fake-full");
fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--model MODEL --effort LEVEL --variant VAR --resume-last"; else echo ok; fi\n');
fs.chmodSync(bin, 0o755);
const bareBin = path.join(dir, "fake-bare");
fs.writeFileSync(bareBin, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--help nothing-useful"; else echo ok; fi\n');
fs.chmodSync(bareBin, 0o755);
const full = { binary: bin, probe: ["--help"], write: ["run"], read_only: ["plan"], model_flag: "--model", effort_flag: "--effort", variant_flag: "--variant", model_discovery: "manual" };
const bare = { binary: bareBin, probe: ["--help"], write: ["run"], read_only: ["plan"], model_flag: null, effort_flag: null, variant_flag: null, model_discovery: "manual" };
const agents = { full, bare };
const base = { adapter: "full", model: "", reasoning: "", variant: "", resume: false };
const check = (roleName, escalation_model) => validateRoleSelection({ roleName, role: { ...base, escalation_model }, adapter: full, agents });

try {
  const ok = await check("implementer", { adapter: "full", model: "big", reasoning: "" });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
  assert.equal((await validateRoleSelection({ roleName: "implementer", role: base, adapter: full, agents })).valid, true, "absent = valid");
  for (const [label, roleName, em, re] of [
    ["unknown adapter", "planner", { adapter: "nope", model: "m" }, /escalation_model.*adapter/],
    ["no model", "planner", { adapter: "full", model: "" }, /escalation_model.*model is required/],
    ["not an object", "implementer", "big", /escalation_model.*object/],
    ["no model capability", "implementer", { adapter: "bare", model: "m" }, /escalation_model.*model selection/],
    ["reviewer role", "code_reviewer", { adapter: "full", model: "m" }, /only the planner and implementer/]
  ]) {
    const r = await check(roleName, em);
    assert.equal(r.valid, false, label);
    assert.ok(r.errors.some(e => re.test(e)), `${label}: ${JSON.stringify(r.errors)}`);
  }
  n++; console.log("PASS config validation");
  const input = { schema_version: "3.0", project: { planning_framework: "standalone" }, roles: { implementer: { ...base, escalation_model: ESC } } };
  assert.deepEqual(toRuntimeConfig(migrateConfig(input).config).roles.implementer.escalation_model, ESC);
  n++; console.log("PASS migration keeps escalation_model");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${n} passed`);
