#!/usr/bin/env node
// Escalation-naming unit tests: the pure function is exercised directly over
// the values `recordFailureBudget()` produces — never a state object, never the
// filesystem, never a relay result.
//
// Covers every branch of `decideEscalationName()`:
// - `retryable:false` with budget remaining names non-retryability, and its
//   detail names the class instead of a count;
// - `retryable:false` at `used === limit` STILL names non-retryability: the
//   count alone would also satisfy exhaustion, so this is the priority-order
//   case, not a duplicate of the one above;
// - an absent budget (`budget:null, used:0, limit:0` — what a
//   planning/policy/orchestrator-domain failure actually records) names
//   "outside a retry budget", never "null_exhausted" / "null exhausted (0/0)":
//   `used >= limit` is a satisfied `0 >= 0`, so the count must not be consulted
//   first;
// - `retryable:true` with the budget genuinely exhausted names exhaustion;
// - `retryable:true` with budget remaining throws, because that combination is
//   not an escalation at all.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {decideEscalationName} from "./escalation-naming.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

check("exports decideEscalationName", typeof decideEscalationName === "function");

// ── Purity: no filesystem/child-channel/network access, no state writes ──
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "escalation-naming.mjs"), "utf8");
  for (const token of [
    "node:fs", "node:child_process", "node:net", "node:http", "node:https",
    "process.", "new Date(", "writeFileSync", "readFileSync", "renameSync",
    "spawnSync", "execSync", "fetch(", "XMLHttpRequest",
  ]) {
    check(`pure: no ${token}`, !source.includes(token), token);
  }
  // Never calls (or imports) the budget/state authorities: comment-stripped so
  // the docblock naming them as the caller's job does not false-positive.
  const codeOnly = source.replace(/\/\/.*$/gm, "");
  check("pure: no module imports", !/^\s*import\s/m.test(codeOnly), "import statement found");
  for (const name of ["recordFailureBudget", "enforceAttemptFailure", "recordAttemptFailure", "saveState"]) {
    check(`pure: never calls ${name}()`, !new RegExp(`\\b${name}\\s*\\(`).test(codeOnly), name);
  }
}

const naming = input => decideEscalationName(input);

// ── Wiring: every escalation site names itself from this one function ──
// The pure cases above pass whatever autopilot.mjs then does with the result,
// so on their own they could not have caught the GSD site persisting
// `naming.step` while still dying with the old, wrong "exhausted its own
// failure domain" wording.
{
  const autopilot = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "autopilot.mjs"), "utf8");
  const wiring = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "planning-review-wiring.mjs"), "utf8");
  check("autopilot.mjs no longer hand-builds a budget-exhausted name",
    !autopilot.includes("_exhausted"), "found '_exhausted' in autopilot.mjs");
  check("autopilot.mjs no longer claims 'exhausted its own failure domain'",
    !autopilot.includes("exhausted its own failure domain"));
  // Two escalation sites live in autopilot.mjs (the shared enforceAttemptFailure()
  // helper plus the GSD wave aggregator); the third lives in the extracted
  // planning-review-wiring.mjs module. Total across both files stays 3.
  const boundAuto = [...autopilot.matchAll(/const naming=decideEscalationName\(/g)].length;
  const boundWiring = [...wiring.matchAll(/const naming=decideEscalationName\(/g)].length;
  check("every decideEscalationName() call binds its result to `naming`",
    boundAuto === 2 && boundWiring === 1
    && [...autopilot.matchAll(/decideEscalationName\(/g)].length === 2
    && [...wiring.matchAll(/decideEscalationName\(/g)].length === 1,
    {autopilot: boundAuto, wiring: boundWiring});
  check("all three escalation messages use the shared detail",
    [...autopilot.matchAll(/naming\.detail/g)].length === 2
    && [...wiring.matchAll(/naming\.detail/g)].length === 1,
    {autopilot: [...autopilot.matchAll(/naming\.detail/g)].length, wiring: [...wiring.matchAll(/naming\.detail/g)].length});
  check("both persisted-step sites use the shared step",
    [...autopilot.matchAll(/step=naming\.step/g)].length === 2,
    [...autopilot.matchAll(/step=naming\.step/g)].length);
  // Evidence wiring: every escalation site passes its failure evidence so
  // RATE_LIMITED can name the provider/model (2 sites in autopilot.mjs —
  // enforceAttemptFailure + the GSD wave aggregator — plus 1 in wiring).
  check("enforceAttemptFailure passes observedFailure evidence",
    /decideEscalationName\(\{[^)]*evidence:recorded\.failure\.evidence/.test(autopilot), "missing evidence:recorded.failure.evidence");
  check("GSD wave aggregator passes record.failure evidence",
    /decideEscalationName\(\{[^)]*evidence:record\.failure\.evidence/.test(autopilot), "missing evidence:record.failure.evidence");
  check("planning-review wiring passes recorded.failure evidence",
    /decideEscalationName\(\{[^)]*evidence:recorded\.failure\.evidence/.test(wiring), "missing evidence:recorded.failure.evidence");
}

// ── Non-retryable, budget still available (the TASK-18 run-26 shape) ──
{
  const r = naming({failureClass: "PERMISSION_DENIED", retryable: false, used: 1, limit: 2, budget: "adapterRetryBudget"});
  check("retryable:false with budget remaining persists non_retryable_failure", r?.step === "non_retryable_failure", r);
  check("retryable:false detail names the class", r?.detail === "PERMISSION_DENIED is not retryable", r);
  check("retryable:false never says exhausted", !/exhaust/i.test(`${r?.step} ${r?.detail}`), r);
}

// ── Priority order: non-retryable AND used === limit ──
{
  const r = naming({failureClass: "PATH_UNSUPPORTED", retryable: false, used: 1, limit: 1, budget: "adapterRetryBudget"});
  check("retryable:false at used === limit still persists non_retryable_failure",
    r?.step === "non_retryable_failure" && r?.detail === "PATH_UNSUPPORTED is not retryable", r);
  check("retryable:false at used === limit never names a budget",
    !/adapterRetryBudget|exhaust/i.test(`${r?.step} ${r?.detail}`), r);
}

// ── Absent budget: the real shape for a planning/policy/orchestrator failure ──
{
  const r = naming({failureClass: "PLANNING_REJECTED", retryable: true, used: 0, limit: 0, budget: null});
  check("absent budget persists non_retryable_failure", r?.step === "non_retryable_failure", r);
  check("absent budget detail is the outside-a-budget wording",
    r?.detail === "failure is outside a retry budget", r);
  check("absent budget never renders null_exhausted or null exhausted (0/0)",
    !/null|exhaust/i.test(`${r?.step} ${r?.detail}`), r);
}

// ── Genuine exhaustion ──
{
  const r = naming({failureClass: "RATE_LIMITED", retryable: true, used: 2, limit: 2, budget: "adapterRetryBudget"});
  check("retryable:true with the budget exhausted persists the exhausted step",
    r?.step === "adapterRetryBudget_exhausted", r);
  check("retryable:true with the budget exhausted reports the count",
    r?.detail === "adapterRetryBudget exhausted (2/2)", r);
}

// ── RATE_LIMITED immediate escalation (non-retryable, evidence-aware) ──
{
  const r = naming({failureClass: "RATE_LIMITED", retryable: false, used: 1, limit: 2, budget: "infrastructureRetryBudget", evidence: [{provider: "opencode", model: "muse-spark-1.3-contributor-free"}]});
  check("RATE_LIMITED non-retryable persists rate_limited_escalation",
    r?.step === "rate_limited_escalation", r);
  check("RATE_LIMITED detail names the provider", r?.detail?.includes("opencode"), r);
  check("RATE_LIMITED detail names the model", r?.detail?.includes("muse-spark-1.3-contributor-free"), r);
  check("RATE_LIMITED detail carries the resume instruction", r?.detail?.includes("ap run"), r);
  // Fires whether or not evidence is present.
  const noEvidence = naming({failureClass: "RATE_LIMITED", retryable: false, used: 1, limit: 2, budget: "infrastructureRetryBudget"});
  check("RATE_LIMITED without evidence still persists rate_limited_escalation",
    noEvidence?.step === "rate_limited_escalation", noEvidence);
  check("RATE_LIMITED without evidence still carries the resume instruction",
    noEvidence?.detail?.includes("ap run"), noEvidence);
  // Evidence without provider/model falls back to wording without them.
  const bare = naming({failureClass: "RATE_LIMITED", retryable: false, used: 1, limit: 2, budget: "infrastructureRetryBudget", evidence: [{type: "rate_limited"}]});
  check("RATE_LIMITED with provider/model-less evidence still persists rate_limited_escalation",
    bare?.step === "rate_limited_escalation", bare);
  check("RATE_LIMITED fallback wording omits provider/model",
    !/opencode|muse-spark/.test(bare?.detail || ""), bare);
  check("RATE_LIMITED fallback still carries the resume instruction",
    bare?.detail?.includes("ap run"), bare);
  // Callers without evidence for non-RATE_LIMITED classes are unchanged.
  const unchanged = naming({failureClass: "PERMISSION_DENIED", retryable: false, used: 1, limit: 2, budget: "adapterRetryBudget"});
  check("non-RATE_LIMITED without evidence still persists non_retryable_failure",
    unchanged?.step === "non_retryable_failure" && unchanged?.detail === "PERMISSION_DENIED is not retryable", unchanged);
}

// ── Precondition: retryable with budget remaining is not an escalation ──
{
  let threw = null;
  try { naming({failureClass: "RATE_LIMITED", retryable: true, used: 1, limit: 2, budget: "adapterRetryBudget"}); }
  catch (error) { threw = error; }
  check("retryable:true with budget remaining throws instead of naming anything", threw instanceof Error, String(threw));
}

// ── Contract guard: the class is required to name the failure ──
{
  let threw = null;
  try { naming({retryable: false, used: 0, limit: 0, budget: null}); }
  catch (error) { threw = error; }
  check("a missing failure class throws", threw instanceof Error, String(threw));
}

if (failed) {
  console.error(`${failed} escalation-naming check(s) failed.`);
  process.exit(1);
}
console.log(`Escalation-naming tests passed (${ok} checks)`);
