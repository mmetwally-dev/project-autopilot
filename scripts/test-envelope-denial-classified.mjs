#!/usr/bin/env node
// Backlog #5 — a read-only launch-plan denial (READ_ONLY_CONTAINMENT_UNAVAILABLE,
// e.g. the codex adapter runtime sibling missing) escalates as a CLASSIFIED
// failure in state.lastFailure and the WATCH-REPORT stop line — never as
// INTERNAL_CONTRACT_ERROR "Attempt failed without a classified cause."
//
// Covers:
//   (a) a launch plan denied with adapter_runtime_file_missing — the failure
//       recorded at the denial site names the reason, the missing file, the
//       role and the adapter (not the unclassified fallback);
//   (b) the same failure through the planning-review path
//       (resolvePlanningReviewAttempt / planning-review-wiring.mjs) — it is
//       recorded once, escalated with the class named, and never reaches the
//       "Attempt failed without a classified cause" fallback;
//   (c) the operator-facing message on Linux never says "Plain Windows"
//       (that sentence is Windows-only);
//   (d) the WATCH-REPORT stop line for the escalated mission shows the class
//       and the reason.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAILURE_CLASSES,
  selectAttemptFailure,
} from "./failure-contract.mjs";
import {
  READ_ONLY_CONTAINMENT_UNAVAILABLE_CLASS,
  envelopeDenialFailure,
  envelopeDenialDetail,
  isPlainWindows,
  recordEnvelopeDenial,
} from "./envelope-denial.mjs";
import { decidePlanningReview } from "./planning-review-decision.mjs";
import { resolvePlanningReviewAttempt } from "./planning-review-wiring.mjs";
import { classifyStatus } from "./watch-report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MISSING = "/usr/local/lib/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host";
const MISSING_FILE = path.basename(MISSING);

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

// ── (a) Denial site: the launch plan denied with adapter_runtime_file_missing ──
{
  const s = {};
  let persisted = null;
  const denial = envelopeDenialFailure({ reason: "adapter_runtime_file_missing", missingRuntimeFile: MISSING, role: "plan_reviewer", adapter: "codex" });
  recordEnvelopeDenial(s, { failure: denial, roleName: "plan_reviewer", adapter: "codex", persist: (st) => { persisted = JSON.parse(JSON.stringify(st)); } });

  check("a: class is READ_ONLY_CONTAINMENT_UNAVAILABLE", s.lastFailure?.class === READ_ONLY_CONTAINMENT_UNAVAILABLE_CLASS, s.lastFailure);
  check("a: not INTERNAL_CONTRACT_ERROR", s.lastFailure?.class !== "INTERNAL_CONTRACT_ERROR", s.lastFailure?.class);
  check("a: domain adapter, retryable false", s.lastFailure?.domain === "adapter" && s.lastFailure?.retryable === false, { domain: s.lastFailure?.domain, retryable: s.lastFailure?.retryable });
  check("a: evidence names the reason", s.lastFailure?.evidence?.some((e) => e?.reason === "adapter_runtime_file_missing"), s.lastFailure?.evidence);
  check("a: evidence names the missing runtime file", s.lastFailure?.evidence?.some((e) => e?.missingRuntimeFile === MISSING), s.lastFailure?.evidence);
  check("a: evidence carries role and adapter", s.lastFailure?.evidence?.every((e) => e?.role === "plan_reviewer" && e?.adapter === "codex"), s.lastFailure?.evidence);
  check("a: sourceRole and adapter are filled on lastFailure", s.lastFailure?.sourceRole === "plan_reviewer" && s.lastFailure?.adapter === "codex", { sourceRole: s.lastFailure?.sourceRole, adapter: s.lastFailure?.adapter });
  check("a: class is a known failure class", FAILURE_CLASSES.includes(READ_ONLY_CONTAINMENT_UNAVAILABLE_CLASS));
  check("a: mission escalates with a step naming the denial", s.phase === "escalated" && typeof s.step === "string" && /read_only_containment_unavailable/i.test(s.step), { phase: s.phase, step: s.step });
  check("a: persist callback saw the classified state", persisted?.lastFailure?.class === READ_ONLY_CONTAINMENT_UNAVAILABLE_CLASS && persisted?.phase === "escalated", persisted);
  // The generic recordAttemptFailure selection path also picks the classified failure.
  const picked = selectAttemptFailure({ results: [{ status: "failed", failure: denial }] });
  check("a: recordAttemptFailure's selection sees the classified failure", picked?.class === READ_ONLY_CONTAINMENT_UNAVAILABLE_CLASS, picked);
  // The production denial site in autopilot.mjs actually calls the helpers.
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const site = src.indexOf("!missionLaunchPlan.available");
  check("a: autopilot.mjs records the classified denial at the launch-plan site", site > -1 && src.indexOf("recordEnvelopeDenial", site) > -1 && src.indexOf("envelopeDenialDetail", site) > -1, { site });
}

// ── (b) Planning-review path: resolvePlanningReviewAttempt escalates it classified ──
{
  const state = {};
  const config = { policy: { failure_budgets: { adapterRetryBudget: 3 }, retry_delay_ms: 0 } };
  const denialResult = {
    status: "failed",
    role: "plan_reviewer",
    adapter: "codex",
    failure: envelopeDenialFailure({ reason: "adapter_runtime_file_missing", missingRuntimeFile: MISSING, role: "plan_reviewer", adapter: "codex" }),
  };
  let rerunCalled = false;
  let fatalMsg = null;
  const saveStateCalls = [];
  try {
    await resolvePlanningReviewAttempt(config, state, "speckit-gate-review", denialResult,
      async () => { rerunCalled = true; return denialResult; },
      {
        policyMessage: "SpecKit gate plan reviewer violated read-only relay policy.",
        escalatePrefix: "SpecKit gate plan",
        fatal: (m) => { fatalMsg = m; throw new Error(m); },
        saveState: (st) => { saveStateCalls.push(JSON.parse(JSON.stringify(st))); },
        readResetRequests: () => [],
        consumeResetRequest: () => {},
        getConfiguredBudget: () => undefined,
        now: () => "2026-11-03T00:00:00.000Z",
      });
  } catch {
    /* the injected fatal throws — expected for the escalate path */
  }
  check("b: rerunReviewer is not called (non-retryable denial)", rerunCalled === false);
  check("b: fatal message names the classified class", /READ_ONLY_CONTAINMENT_UNAVAILABLE/.test(fatalMsg ?? ""), fatalMsg);
  check("b: fatal message does not name INTERNAL_CONTRACT_ERROR / unclassified attempt", !/INTERNAL_CONTRACT_ERROR|Attempt failed without a classified cause/.test(fatalMsg ?? ""), fatalMsg);
  check("b: state.lastFailure.class is READ_ONLY_CONTAINMENT_UNAVAILABLE", state.lastFailure?.class === READ_ONLY_CONTAINMENT_UNAVAILABLE_CLASS, state.lastFailure);
  check("b: state.lastFailure is NOT INTERNAL_CONTRACT_ERROR", state.lastFailure?.class !== "INTERNAL_CONTRACT_ERROR");
  check("b: evidence names the missing runtime file", state.lastFailure?.evidence?.some((e) => e?.missingRuntimeFile === MISSING), state.lastFailure?.evidence);
  check("b: sourceRole and adapter are filled", state.lastFailure?.sourceRole === "plan_reviewer" && state.lastFailure?.adapter === "codex", { sourceRole: state.lastFailure?.sourceRole, adapter: state.lastFailure?.adapter });
  check("b: recorded against adapterRetryBudget", state.lastFailureBudget?.budget === "adapterRetryBudget", state.lastFailureBudget);
  check("b: mission escalates naming the denial", state.phase === "escalated" && state.step === "read_only_containment_unavailable", { phase: state.phase, step: state.step });
  check("b: lastFailure persisted via saveState", saveStateCalls.some((st) => st?.lastFailure?.class === READ_ONLY_CONTAINMENT_UNAVAILABLE_CLASS), saveStateCalls.length);
  const decision = decidePlanningReview({ failure: state.lastFailure, budget: state.lastFailureBudget, scope: "adapter:codex:plan_reviewer" });
  check("b: the planning-review decision is escalate (never retry/passthrough)", decision.action === "escalate", decision);
}

// ── (c) The operator-facing message on Linux never says "Plain Windows" ──
{
  const runtimeFileMsg = envelopeDenialDetail({ reason: "adapter_runtime_file_missing", missingRuntimeFile: MISSING, platform: "linux" });
  check("c: runtime-file message names the missing file", runtimeFileMsg.includes(MISSING), runtimeFileMsg);
  check("c: runtime-file message carries a one-line fix", runtimeFileMsg.includes("Fix: reinstall the agent CLI"), runtimeFileMsg);
  check("c: runtime-file message never says Plain Windows", !runtimeFileMsg.includes("Plain Windows"), runtimeFileMsg);
  const genericLinux = envelopeDenialDetail({ reason: "bubblewrap_unavailable", platform: "linux" });
  check("c: generic message on linux never says Plain Windows", !genericLinux.includes("Plain Windows"), genericLinux);
  const genericWsl = envelopeDenialDetail({ reason: "bubblewrap_unavailable", platform: "linux" });
  check("c: WSL (linux) never says Plain Windows", !genericWsl.includes("Plain Windows"), genericWsl);
  const genericDarwin = envelopeDenialDetail({ reason: "bubblewrap_unavailable", platform: "darwin" });
  check("c: macOS never says Plain Windows", !genericDarwin.includes("Plain Windows"), genericDarwin);
  const plainWindowsMsg = envelopeDenialDetail({ reason: "bubblewrap_unavailable", platform: "win32" });
  check("c: plain Windows keeps the Plain Windows sentence", plainWindowsMsg.includes("Plain Windows without WSL is not currently supported"), plainWindowsMsg);
  check("c: isPlainWindows is true only on win32", isPlainWindows("win32") === true && isPlainWindows("linux") === false && isPlainWindows("darwin") === false);
  check("c: default platform is this process platform", isPlainWindows() === (process.platform === "win32"));
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  check("c: autopilot.mjs builds the denial detail via envelopeDenialDetail", /envelopeDenialDetail\(/.test(src));
}

// ── (d) The WATCH-REPORT stop line shows the class + reason, not INTERNAL_CONTRACT_ERROR ──
{
  const lastFailure = envelopeDenialFailure({ reason: "adapter_runtime_file_missing", missingRuntimeFile: MISSING, role: "plan_reviewer", adapter: "codex" });
  const info = classifyStatus({ phase: "escalated", step: "read_only_containment_unavailable", lastFailure }, { operatorEvents: [], runs: [] });
  check("d: escalated stays ESCALATED", info.status === "ESCALATED", info);
  check("d: stop line shows the class", /READ_ONLY_CONTAINMENT_UNAVAILABLE/i.test(info.stopLine ?? ""), info.stopLine);
  check("d: stop line shows the reason (adapter_runtime_file_missing)", (info.stopLine ?? "").includes("adapter_runtime_file_missing"), info.stopLine);
  check("d: stop line never shows INTERNAL_CONTRACT_ERROR", !(info.stopLine ?? "").includes("INTERNAL_CONTRACT_ERROR"), info.stopLine);
  // A step that names neither class nor reason (the generic non_retryable_failure)
  // still surfaces the classified failure — this is the exact pre-fix report line shape.
  const generic = classifyStatus({ phase: "escalated", step: "non_retryable_failure", lastFailure }, { operatorEvents: [], runs: [] });
  check("d: generic step still shows the exact class", (generic.stopLine ?? "").includes("READ_ONLY_CONTAINMENT_UNAVAILABLE"), generic.stopLine);
  check("d: generic step still shows the reason", (generic.stopLine ?? "").includes("adapter_runtime_file_missing"), generic.stopLine);
  check("d: generic step never shows INTERNAL_CONTRACT_ERROR", !(generic.stopLine ?? "").includes("INTERNAL_CONTRACT_ERROR"));
}

console.log(`\ntest-envelope-denial-classified: ${ok} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
