import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODE_REVIEW_EXHAUSTIVE_LINE,
  CODE_REVIEW_VERIFY_LINE,
  codeReviewerRoundLines,
  evaluateRereviewPreviousStatuses,
  buildRereviewPreviousRetryPrompt,
  normalizePreviousStatuses,
  codeReviewScopeKey,
  recordCodeReviewRound,
} from "./code-review-rounds.mjs";
import { recordVerifierRound } from "./escalation-model.mjs";
import { saveReviewFeedback, loadReviewFeedback } from "./review-feedback.mjs";
import { enforceRereviewPreviousOnPassForTests } from "./autopilot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`PASS ${name}`);
    });
}

await test("brief after verifier FAIL includes structured per-finding instruction even with empty codeReviewHistory", () => {
  const s = {};
  const scopeKey = codeReviewScopeKey("standalone-phase", 0);
  recordVerifierRound(s, scopeKey, ["src/a.mjs:10 missing null check"]);
  assert.equal(s.codeReviewHistory, undefined);

  const firstReviewLines = codeReviewerRoundLines(s, scopeKey);
  assert.deepEqual(firstReviewLines, [CODE_REVIEW_EXHAUSTIVE_LINE]);

  const rereviewLines = codeReviewerRoundLines(s, scopeKey, { hasFeedback: true });
  assert.equal(rereviewLines.length, 1);
  assert.equal(rereviewLines[0], CODE_REVIEW_VERIFY_LINE);
  assert.match(rereviewLines[0], /"previous":\[\{"finding":/);
  assert.match(rereviewLines[0], /"fixed"\|"not_fixed"/);
});

await test("evaluateRereviewPreviousStatuses: first review (no listed findings) is unchanged", () => {
  const res = evaluateRereviewPreviousStatuses([], null);
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.notFixed, []);
});

await test("evaluateRereviewPreviousStatuses: previous:null or missing entry is rejected", () => {
  const f1 = "src/a.mjs:10 missing null check";
  const f2 = "src/b.mjs:22 wrong status code";

  const nullRes = evaluateRereviewPreviousStatuses([f1], null);
  assert.equal(nullRes.ok, false);
  assert.deepEqual(nullRes.missing, [f1]);
  assert.deepEqual(nullRes.notFixed, []);

  const partialRes = evaluateRereviewPreviousStatuses([f1, f2], [{ finding: "src/a.mjs:10 missing null check", status: "fixed" }]);
  assert.equal(partialRes.ok, false);
  assert.deepEqual(partialRes.missing, [f2]);
  assert.deepEqual(partialRes.fixed, [f1]);

  // Duplicate entry for f1 must not satisfy f2
  const dupRes = evaluateRereviewPreviousStatuses([f1, f2], [
    { finding: "src/a.mjs:10 missing null check", status: "fixed" },
    { finding: "src/a.mjs:10 missing null check", status: "fixed" },
  ]);
  assert.equal(dupRes.ok, false);
  assert.deepEqual(dupRes.missing, [f2]);
});

await test("evaluateRereviewPreviousStatuses: all fixed (exact or shortened) is accepted", () => {
  const f1 = "src/a.mjs:10 missing null check Required correction: add guard";
  const f2 = "src/b.mjs:22 wrong status code";
  const res = evaluateRereviewPreviousStatuses([f1, f2], [
    { finding: "src/a.mjs:10 missing null check", status: "fixed" },
    { finding: "wrong status code in src/b.mjs", status: "fixed" },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.notFixed, []);
  assert.equal(res.fixed.length, 2);
});

await test("evaluateRereviewPreviousStatuses: one not_fixed is rejected with notFixed finding", () => {
  const f1 = "src/a.mjs:10 missing null check";
  const f2 = "src/b.mjs:22 wrong status code";
  const res = evaluateRereviewPreviousStatuses([f1, f2], [
    { finding: f1, status: "fixed" },
    { finding: f2, status: "not_fixed" },
  ]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.notFixed, [f2]);
  assert.deepEqual(res.missing, []);
});

const baseConfig = {
  policy: { free_model_turns_cap: 30, caps: { code_reviewer: { max_turns: 30 } } },
  roles: { code_reviewer: { adapter: "codex", model: "gpt-5" } },
};

await test("enforceRereviewPreviousOnPass: first review PASS with previous:null is accepted without retry", async () => {
  let retryCalls = 0;
  const res = await enforceRereviewPreviousOnPassForTests({
    rv: { status: "completed", review: { decision: "PASS", findings: [], previous: null } },
    listedFindings: [],
    c: baseConfig,
    s: {},
    reviewFn: async () => { retryCalls++; return {}; },
  });
  assert.equal(res.action, "accept");
  assert.equal(retryCalls, 0);
});

await test("enforceRereviewPreviousOnPass: PASS with previous:null runs 1 verdict-only retry (max 5 turns); still missing -> FAIL", async () => {
  const f1 = "src/a.mjs:10 missing null check";
  const seenCalls = [];
  const res = await enforceRereviewPreviousOnPassForTests({
    rv: { status: "completed", review: { decision: "PASS", findings: [], previous: null } },
    listedFindings: [f1],
    c: baseConfig,
    s: {},
    reviewFn: async (role, prompt, cRetry) => {
      seenCalls.push({ role, prompt, maxTurns: cRetry.policy.caps.code_reviewer.max_turns, freeCap: cRetry.policy.free_model_turns_cap });
      return { status: "completed", review: { decision: "PASS", findings: [], previous: null } };
    },
  });
  assert.equal(seenCalls.length, 1);
  assert.equal(seenCalls[0].role, "code_reviewer");
  assert.equal(seenCalls[0].maxTurns, 5);
  assert.equal(seenCalls[0].freeCap, 5);
  assert.match(seenCalls[0].prompt, /VERDICT-ONLY RETRY/);
  assert.match(seenCalls[0].prompt, /src\/a\.mjs:10 missing null check/);
  assert.equal(res.action, "fail");
  assert.equal(res.failFindings.length, 1);
  assert.match(res.failFindings[0], /src\/a\.mjs:10 missing null check/);
});

await test("enforceRereviewPreviousOnPass: PASS with previous:null -> retry confirms all fixed -> accepted", async () => {
  const f1 = "src/a.mjs:10 missing null check";
  const res = await enforceRereviewPreviousOnPassForTests({
    rv: { status: "completed", review: { decision: "PASS", findings: [], previous: null } },
    listedFindings: [f1],
    c: baseConfig,
    s: {},
    reviewFn: async () => ({
      status: "completed",
      review: { decision: "PASS", findings: [], previous: [{ finding: f1, status: "fixed" }] },
    }),
  });
  assert.equal(res.action, "accept");
  assert.equal(res.rv.review.previous[0].status, "fixed");
});

await test("enforceRereviewPreviousOnPass: PASS with not_fixed becomes FAIL immediately without retry", async () => {
  const f1 = "src/a.mjs:10 missing null check";
  let retryCalls = 0;
  const res = await enforceRereviewPreviousOnPassForTests({
    rv: { status: "completed", review: { decision: "PASS", findings: [], previous: [{ finding: f1, status: "not_fixed" }] } },
    listedFindings: [f1],
    c: baseConfig,
    s: {},
    reviewFn: async () => { retryCalls++; return {}; },
  });
  assert.equal(retryCalls, 0);
  assert.equal(res.action, "fail");
  assert.deepEqual(res.failFindings, [f1]);
  assert.equal(res.previous[0].status, "not_fixed");
});

await test("enforceRereviewPreviousOnPass: PASS with all fixed is accepted immediately without retry", async () => {
  const f1 = "src/a.mjs:10 missing null check";
  let retryCalls = 0;
  const res = await enforceRereviewPreviousOnPassForTests({
    rv: { status: "completed", review: { decision: "PASS", findings: [], previous: [{ finding: f1, status: "fixed" }] } },
    listedFindings: [f1],
    c: baseConfig,
    s: {},
    reviewFn: async () => { retryCalls++; return {}; },
  });
  assert.equal(retryCalls, 0);
  assert.equal(res.action, "accept");
});

await test("brief text mentions needs_run and restricts it to gate/verifier checks", () => {
  assert.match(CODE_REVIEW_VERIFY_LINE, /"fixed"\|"not_fixed"\|"needs_run"/);
  assert.match(CODE_REVIEW_VERIFY_LINE, /use "needs_run" ONLY for findings that need the gate\/verifier to run/);
  assert.match(CODE_REVIEW_VERIFY_LINE, /never to skip reading the code/);
  const retryPrompt = buildRereviewPreviousRetryPrompt(["src/e2e.spec.ts:12 Playwright timeout"]);
  assert.match(retryPrompt, /"fixed"\|"not_fixed"\|"needs_run"/);
  assert.match(retryPrompt, /never to skip reading the code/);
});

await test("normalizePreviousStatuses accepts needs_run", () => {
  const norm = normalizePreviousStatuses([
    { finding: "Playwright check", status: "needs_run" },
    { finding: "Flaky test", status: "needs-run" },
  ]);
  assert.deepEqual(norm, [
    { finding: "Playwright check", status: "needs_run" },
    { finding: "Flaky test", status: "needs_run" },
  ]);
});

await test("PASS with one needs_run + others fixed is accepted and logs needs_run count", async () => {
  const f1 = "src/a.mjs:10 missing null check";
  const f2 = "tests/e2e.spec.ts:44 Playwright login flow";
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(" ")); origLog(...args); };
  let res;
  try {
    res = await enforceRereviewPreviousOnPassForTests({
      rv: {
        status: "completed",
        review: {
          decision: "PASS",
          findings: [],
          previous: [
            { finding: f1, status: "fixed" },
            { finding: f2, status: "needs_run" },
          ],
        },
      },
      listedFindings: [f1, f2],
      c: baseConfig,
      s: {},
    });
  } finally {
    console.log = origLog;
  }
  assert.equal(res.action, "accept");
  assert.ok(logs.some(l => /1 finding\(s\) as needs_run/.test(l)), `expected needs_run log line, got: ${JSON.stringify(logs)}`);
});

await test("needs_run never hides a not_fixed", async () => {
  const f1 = "tests/e2e.spec.ts:44 Playwright login flow";
  const f2 = "src/a.mjs:10 missing null check";
  let retryCalls = 0;
  const res = await enforceRereviewPreviousOnPassForTests({
    rv: {
      status: "completed",
      review: {
        decision: "PASS",
        findings: [],
        previous: [
          { finding: f1, status: "needs_run" },
          { finding: f2, status: "not_fixed" },
        ],
      },
    },
    listedFindings: [f1, f2],
    c: baseConfig,
    s: {},
    reviewFn: async () => { retryCalls++; return {}; },
  });
  assert.equal(retryCalls, 0);
  assert.equal(res.action, "fail");
  assert.deepEqual(res.failFindings, [f2]);
});

await test("positional/count fallback matches heavily shortened text when count matches", () => {
  const f1 = "src/a.mjs:10 missing null check in auth handler";
  const f2 = "src/b.mjs:22 wrong HTTP status code";
  const res = evaluateRereviewPreviousStatuses([f1, f2], [
    { finding: "auth guard", status: "fixed" },
    { finding: "response status", status: "needs_run" },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.fixed, [f1]);
  assert.deepEqual(res.needsRun, [f2]);

  // Fewer entries than listed still leaves the extra finding missing
  const shortRes = evaluateRereviewPreviousStatuses([f1, f2], [
    { finding: "auth guard", status: "fixed" },
  ]);
  assert.equal(shortRes.ok, false);
  assert.deepEqual(shortRes.missing, [f2]);
});

await test("both standalone and SpecKit loops wire enforceRereviewPreviousOnPass before clearCodeReviewHistory/PASS", () => {
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const standaloneIdx = src.indexOf('codeReviewScopeKey("standalone-phase",s.phaseIndex)');
  const speckitIdx = src.indexOf('codeReviewScopeKey("speckit-phase",s.phaseIndex)');
  assert.ok(standaloneIdx > 0 && speckitIdx > standaloneIdx);

  for (const [label, scopeToken] of [
    ["standalone", 'codeReviewScopeKey("standalone-phase",s.phaseIndex)'],
    ["speckit", 'codeReviewScopeKey("speckit-phase",s.phaseIndex)'],
  ]) {
    const passMarker = `clearCodeReviewHistory(s,${scopeToken});const transition=decideTransition(checkpoint,{stage:"code_reviewer",status:"completed",decision:"PASS"`;
    const passIdx = src.indexOf(passMarker);
    assert.ok(passIdx > 0, `${label}: missing PASS transition marker`);
    const windowBefore = src.slice(Math.max(0, passIdx - 1800), passIdx);
    assert.ok(windowBefore.includes("enforceRereviewPreviousOnPass({"), `${label}: enforceRereviewPreviousOnPass must run before PASS transition`);
    assert.ok(windowBefore.includes('failure("IMPLEMENTATION_REJECTED","implementation",true,prevCheck.failFindings)'), `${label}: must reject via IMPLEMENTATION_REJECTED`);
    assert.ok(windowBefore.includes("recordCodeReviewRound(s,scopeKey,prevCheck.failFindings,prevCheck.previous)"), `${label}: must record code review round`);
    assert.ok(windowBefore.includes('noteEscalationTrigger(s,c,"implementer",scopeKey,"code_reviewer",prevCheck.previous)'), `${label}: must note escalation trigger`);
  }

  // review() passes hasFeedback to codeReviewerRoundLines
  assert.match(src, /codeReviewerRoundLines\(s,roundKey,\{hasFeedback:Boolean\(feedback&&String\(feedback\)\.trim\(\)\)\}\)/);

  // saveReviewFeedback + loadReviewFeedback roundtrip preserves findings for both loops
  const s = {};
  saveReviewFeedback(s, "phase:0", ["src/x.mjs:1 broken"]);
  assert.deepEqual(loadReviewFeedback(s, "phase:0"), ["src/x.mjs:1 broken"]);
  recordCodeReviewRound(s, "standalone-phase:0", ["src/x.mjs:1 broken"], [{ finding: "src/x.mjs:1 broken", status: "not_fixed" }]);
  assert.equal(s.codeReviewHistory["standalone-phase:0"][0].previous[0].status, "not_fixed");
});

console.log(`\n${passed} passed`);
