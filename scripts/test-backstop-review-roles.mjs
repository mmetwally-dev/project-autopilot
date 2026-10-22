#!/usr/bin/env node
// Backlog #59 part (a) — cumulative raw-token backstop on the non-implementer
// roles (planner, plan_reviewer, code_reviewer, verifier).
//
// autopilot.mjs runs main() on import, so the shared helper and the rollover
// wiring at the seven non-implementer capped sites are static-covered here
// (same pattern as test-backstop-continuation.mjs / test-cap-breach-wiring.mjs).
// Accept: a backstop firing at any of the 7 sites records on the SEPARATE
// firing ledger (never the continuation allowance), escalates on the second
// consecutive firing with role-named evidence, and otherwise retries the stage
// with a bare `continue` — no consumeContinuation, no
// handlePlanningContinuation, no recordRolloverDeadEnd.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import { importNames } from "./test-fixtures/source-scan.mjs";
import {
  handleRoleBackstopFiring,
  readBackstopFirings,
  clearBackstopFirings,
} from "./per-task-budget.mjs";

let failures = 0;
const check = (name, condition, evidence) => {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence).slice(0, 300)}` : ""}`);
  }
};
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

// ── Helper: record + escalate decision, pure state change ──
{
  const s = {};
  const scope = "task:standalone:planning:planner";
  const relayResult = {capped: {backstop: true, type: "backstop", used: 7_100_000, limit: 6_000_000}, usage: {turns: 200, maxSingleTurnContext: 35000}};
  const first = handleRoleBackstopFiring(s, scope, relayResult);
  check("helper: first firing does not escalate",
    first.escalate === false && first.firings.length === 1, first);
  check("helper: first firing records generation, totalRawTokens, turns, maxSingleTurnContext",
    first.firings[0].generation === 1 && first.firings[0].totalRawTokens === 7_100_000
    && first.firings[0].turns === 200 && first.firings[0].maxSingleTurnContext === 35000, first.firings[0]);
  check("helper: last is the recorded firing",
    first.last === first.firings[0], first.last);
  const second = handleRoleBackstopFiring(s, scope, {capped: {backstop: true, type: "backstop", used: 7_300_000, limit: 6_000_000}, usage: {turns: 210, maxSingleTurnContext: 36000}});
  check("helper: second firing in a row escalates with both firings",
    second.escalate === true && second.firings.length === 2 && second.last.totalRawTokens === 7_300_000, second);
  check("helper: extra_sessions (continuation) ledger untouched",
    s.continuationBudgets === undefined, Object.keys(s));
  const degraded = handleRoleBackstopFiring(s, "task:standalone:phase-0:verifier", {capped: {used: 6_500_000, limit: 6_000_000}});
  check("helper: missing usage degrades to null turns/maxSingleTurnContext",
    degraded.firings[0].totalRawTokens === 6_500_000 && degraded.firings[0].turns === null
    && degraded.firings[0].maxSingleTurnContext === null, degraded.firings[0]);
}
{
  const s = {};
  const scope = "task:standalone:phase-0:code_reviewer";
  const relayResult = {capped: {backstop: true, type: "backstop", used: 7_100_000, limit: 6_000_000}, usage: {turns: 200, maxSingleTurnContext: 35000}};
  handleRoleBackstopFiring(s, scope, relayResult);
  handleRoleBackstopFiring(s, scope, relayResult);
  check("helper: two firings recorded before the clear",
    readBackstopFirings(s, scope).length === 2, readBackstopFirings(s, scope).length);
  check("helper: clearBackstopFirings clears the ledger",
    clearBackstopFirings(s, scope) === true && readBackstopFirings(s, scope).length === 0);
  const after = handleRoleBackstopFiring(s, scope, relayResult);
  check("helper: count restarts after the clear (first firing again)",
    after.escalate === false && after.firings.length === 1, after);
}

// ── Wiring: the shared helper is imported ──
check("wiring: handleRoleBackstopFiring imported from per-task-budget.mjs",
  importNames(src, "./per-task-budget.mjs").includes("handleRoleBackstopFiring"));

// ── Wiring: all 7 non-implementer capped sites ──
const sites = [
  {name: "standalone planner", role: "planner", re: /if\(planner\.capped\)\{/g, occurrence: 0, afterClear: "clearBackstopFirings(s,'task:standalone:planning:planner');"},
  {name: "standalone plan_reviewer pre-helper", role: "plan_reviewer", re: /if\(reviewResult\.capped\)\{/g, occurrence: 0, afterClear: "clearBackstopFirings(s,'task:standalone:planning:plan_reviewer');"},
  {name: "standalone plan_reviewer post-retry", role: "plan_reviewer", re: /if\(reviewResult\.capped\)\{/g, occurrence: 1, afterClear: "clearBackstopFirings(s,'task:standalone:planning:plan_reviewer');"},
  {name: "standalone code_reviewer", role: "code_reviewer", re: /if\(rv\.capped\)\{/g, occurrence: 0, afterClear: "clearBackstopFirings(s,`task:standalone:phase-${s.phaseIndex}:code_reviewer`);"},
  {name: "standalone verifier", role: "verifier", re: /if\(vv\.capped\)\{/g, occurrence: 0, afterClear: "clearBackstopFirings(s,`task:standalone:phase-${s.phaseIndex}:verifier`);"},
  {name: "speckit code_reviewer", role: "code_reviewer", re: /if\(rv\.capped\)\{/g, occurrence: 1, afterClear: "clearBackstopFirings(s,`task:speckit:phase-${s.phaseIndex}:code_reviewer`);"},
  {name: "speckit verifier", role: "verifier", re: /if\(vv\.capped\)\{/g, occurrence: 1, afterClear: "clearBackstopFirings(s,`task:speckit:phase-${s.phaseIndex}:verifier`);"},
];
const allStarts = sites.flatMap((s) => [...src.matchAll(s.re)].map((m) => m.index)).sort((a, b) => a - b);
for (const site of sites) {
  const matches = [...src.matchAll(site.re)];
  const match = matches[site.occurrence];
  check(`site ${site.name}: capped branch present`, match !== undefined);
  if (!match) continue;
  const start = match.index;
  const nextStart = allStarts.find((i) => i > start);
  const body = src.slice(start, nextStart ?? start + 6000);
  const backstopIdx = body.indexOf("capped.backstop===true||");
  check(`site ${site.name}: backstop branch present`, backstopIdx !== -1);
  const contIdx = body.search(/consumeContinuation\(|handlePlanningContinuation\(/);
  check(`site ${site.name}: backstop branch precedes the continuation call`,
    backstopIdx !== -1 && contIdx !== -1 && backstopIdx < contIdx, {backstopIdx, contIdx});
  const backstopBody = body.slice(backstopIdx, body.indexOf("continue;", backstopIdx));
  check(`site ${site.name}: backstop branch body has no continuation call`,
    !/consumeContinuation\(|handlePlanningContinuation\(/.test(backstopBody));
  check(`site ${site.name}: backstop branch records via the shared helper`,
    backstopBody.includes("handleRoleBackstopFiring("));
  check(`site ${site.name}: escalation step + evidence code`,
    backstopBody.includes('s.step="runaway_session_escalation"')
    && backstopBody.includes('code:"BACKSTOP_CONSECUTIVE_FIRINGS"'));
  check(`site ${site.name}: escalation evidence names the role`,
    backstopBody.includes(`evidence:{role:"${site.role}"`));
  check(`site ${site.name}: escalation dies naming the role (message shape)`,
    /die\(`(Standalone|SpecKit) /.test(backstopBody)
    && backstopBody.includes("fired the cumulative backstop twice in a row"));
  check(`site ${site.name}: non-backstop capped path resets the consecutive count`,
    /clearBackstopFirings\(s,contScope\);/.test(body));
  check(`site ${site.name}: normal completed path resets the consecutive count`,
    body.includes(site.afterClear));
}

// ── Discovery ──
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runner = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
  check("discovery: test-backstop-review-roles.mjs matches the runner discovery regex",
    /^test-.*\.mjs$/.test("test-backstop-review-roles.mjs"));
  check("discovery: test-backstop-review-roles.mjs absent from both test-all exclusion sets",
    !runner.includes("test-backstop-review-roles.mjs"));
}

console.log(`\n${failures === 0 ? "all" : failures} ${failures === 0 ? "checks passed" : "check(s) FAILED"}`);
if (failures) process.exit(1);
