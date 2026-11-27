import assert from "node:assert/strict";
import { parseReviewContract } from "./failure-contract.mjs";
import {
  CODE_REVIEW_VERIFY_LINE,
  buildRereviewPreviousRetryPrompt,
  extractPreviousFromFallbackJson,
  evaluateRereviewPreviousStatuses,
} from "./code-review-rounds.mjs";
import { enforceRereviewPreviousOnPassForTests } from "./autopilot.mjs";

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, detail);
  }
}

// 1. Exact SampleApp run-303 message shape: fenced ```json block with "previous"
// followed by AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}
const listedFindings = [
  "Live-suite manifest omitted the new provisioning spec entry in tests/e2e/manifest.json.",
];

const run303Message = [
  "Checked T187 fix against the current diff. The manifest entry is now present.",
  "",
  "```json",
  '{"previous":[{"finding":"Live-suite manifest omitted the new provisioning spec entry","status":"fixed"}]}',
  "```",
  "",
  'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}',
].join("\n");

const parsed303 = parseReviewContract(run303Message);
check("run-303 shape: contract is valid PASS", parsed303.contract.status === "valid" && parsed303.verdict.decision === "PASS", parsed303);
check("run-303 shape: previous array extracted from fenced json block", parsed303.verdict.previous.length === 1 && parsed303.verdict.previous[0].status === "fixed", parsed303.verdict.previous);

const eval303 = evaluateRereviewPreviousStatuses(listedFindings, parsed303.verdict.previous);
check("run-303 shape: evaluateRereviewPreviousStatuses passes with 0 missing", eval303.ok === true && eval303.missing.length === 0, eval303);

let retryCalls303 = 0;
const enforce303 = await enforceRereviewPreviousOnPassForTests({
  rv: { status: "completed", review: parsed303.verdict },
  listedFindings,
  c: { policy: {} },
  s: {},
  reviewFn: async () => {
    retryCalls303 += 1;
    return { status: "completed", review: { decision: "PASS", findings: [], previous: [] } };
  },
});
check("run-303 shape: enforceRereviewPreviousOnPass accepts without verdict-only retry", enforce303.action === "accept" && retryCalls303 === 0, { enforce303, retryCalls303 });

// 2. Standalone JSON object (no markdown fence) before sentinel -> also accepted
const standaloneJsonMsg = [
  "Verified previous findings:",
  '{"previous":[{"finding":"Live-suite manifest omitted the new provisioning spec entry","status":"fixed"}]}',
  'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}',
].join("\n");
const parsedStandalone = parseReviewContract(standaloneJsonMsg);
check("standalone JSON block: previous extracted", parsedStandalone.verdict.previous.length === 1 && parsedStandalone.verdict.previous[0].status === "fixed", parsedStandalone.verdict);

// 3. Multiple JSON blocks -> last one with valid "previous" wins
const multiBlockMsg = [
  "```json",
  '{"previous":[{"finding":"Live-suite manifest omitted the new provisioning spec entry","status":"not_fixed"}]}',
  "```",
  "After re-reading line 42, it is actually fixed:",
  "```json",
  '{"previous":[{"finding":"Live-suite manifest omitted the new provisioning spec entry","status":"fixed"}]}',
  "```",
  'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}',
].join("\n");
const parsedMulti = parseReviewContract(multiBlockMsg);
check("multiple JSON blocks: last valid previous block wins", parsedMulti.verdict.previous.length === 1 && parsedMulti.verdict.previous[0].status === "fixed", parsedMulti.verdict.previous);

// 4. Sentinel has its own "previous" -> sentinel takes precedence over earlier block
const sentinelWinsMsg = [
  "```json",
  '{"previous":[{"finding":"Live-suite manifest omitted the new provisioning spec entry","status":"not_fixed"}]}',
  "```",
  'AUTOPILOT_REVIEW={"decision":"PASS","findings":[],"previous":[{"finding":"Live-suite manifest omitted the new provisioning spec entry","status":"fixed"}]}',
].join("\n");
const parsedSentinelWins = parseReviewContract(sentinelWinsMsg);
check("sentinel previous takes precedence over earlier block", parsedSentinelWins.verdict.previous.length === 1 && parsedSentinelWins.verdict.previous[0].status === "fixed", parsedSentinelWins.verdict.previous);

// 5. Missing "previous" list altogether -> verdict-only retry STILL happens
const missingPrevMsg = [
  "Looks good now.",
  'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}',
].join("\n");
const parsedMissing = parseReviewContract(missingPrevMsg);
check("missing previous: parsed previous is empty", parsedMissing.verdict.previous.length === 0, parsedMissing.verdict);

let retryCallsMissing = 0;
let capturedRetryPrompt = "";
const enforceMissing = await enforceRereviewPreviousOnPassForTests({
  rv: { status: "completed", review: parsedMissing.verdict },
  listedFindings,
  c: { policy: {} },
  s: {},
  reviewFn: async (_role, prompt) => {
    retryCallsMissing += 1;
    capturedRetryPrompt = prompt;
    return {
      status: "completed",
      review: {
        decision: "PASS",
        findings: [],
        previous: [{ finding: "Live-suite manifest omitted the new provisioning spec entry", status: "fixed" }],
      },
    };
  },
});
check("missing previous: verdict-only retry still launched once", retryCallsMissing === 1 && enforceMissing.action === "accept", { retryCallsMissing, enforceMissing });
check("retry prompt instructs putting previous INSIDE AUTOPILOT_REVIEW JSON", /INSIDE the AUTOPILOT_REVIEW JSON/i.test(capturedRetryPrompt), capturedRetryPrompt);

// 6. Re-review brief wording tells reviewer that "previous" goes INSIDE AUTOPILOT_REVIEW JSON
check("CODE_REVIEW_VERIFY_LINE states previous goes INSIDE AUTOPILOT_REVIEW JSON", /INSIDE the final AUTOPILOT_REVIEW JSON/i.test(CODE_REVIEW_VERIFY_LINE), CODE_REVIEW_VERIFY_LINE);
const builtRetryPrompt = buildRereviewPreviousRetryPrompt(listedFindings);
check("buildRereviewPreviousRetryPrompt states previous goes INSIDE AUTOPILOT_REVIEW JSON", /INSIDE the AUTOPILOT_REVIEW JSON/i.test(builtRetryPrompt), builtRetryPrompt);

// 7. Direct helper edge cases
check("extractPreviousFromFallbackJson returns [] on unrelated JSON", extractPreviousFromFallbackJson('{"foo": 123}').length === 0);

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} check(s) failed`);
