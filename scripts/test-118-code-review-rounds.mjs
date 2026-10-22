// Backlog #118: code-review round discipline + fixed/not_fixed record.
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseReviewContract } from "./failure-contract.mjs";
import {
  recordCodeReviewRound, clearCodeReviewHistory, codeReviewerRoundLines, implementerEarlierRoundsText,
  codeReviewRoundCount, normalizePreviousStatuses, CODE_REVIEW_EXHAUSTIVE_LINE, CODE_REVIEW_VERIFY_LINE,
} from "./code-review-rounds.mjs";

const s = {};
const K = "phase:0";
// round 1: exhaustive, no implementer text
assert.deepEqual(codeReviewerRoundLines(s, K), [CODE_REVIEW_EXHAUSTIVE_LINE]);
assert.equal(implementerEarlierRoundsText(s, K), "");
recordCodeReviewRound(s, K, ["A is wrong", "B is missing"]);
assert.equal(codeReviewRoundCount(s, K), 1);
// first fix brief: latest round only -> nothing earlier
assert.equal(implementerEarlierRoundsText(s, K), "");
let lines = codeReviewerRoundLines(s, K);
assert.equal(lines[0], CODE_REVIEW_VERIFY_LINE);
assert.match(lines[1], /A is wrong/);
assert.match(lines[0], /not_fixed/);
// round 2 with structured previous statuses
recordCodeReviewRound(s, K, ["A still wrong"], [{ finding: "A is wrong", status: "not_fixed" }, { finding: "B is missing", status: "fixed" }, { finding: "x", status: "bogus" }, null]);
assert.deepEqual(s.codeReviewHistory[K][1].previous, [{ finding: "A is wrong", status: "not_fixed" }, { finding: "B is missing", status: "fixed" }]);
const earlier = implementerEarlierRoundsText(s, K);
assert.match(earlier, /A is wrong/); assert.doesNotMatch(earlier, /A still wrong/); assert.match(earlier, /keep them fixed/);
// scopes are independent; clear on PASS
recordCodeReviewRound(s, "final:standalone", ["F"]);
clearCodeReviewHistory(s, K);
assert.equal(codeReviewRoundCount(s, K), 0);
assert.equal(codeReviewRoundCount(s, "final:standalone"), 1);
clearCodeReviewHistory(s, "final:standalone");
assert.equal(s.codeReviewHistory, undefined);
assert.deepEqual(normalizePreviousStatuses("nope"), []);
assert.equal(normalizePreviousStatuses([{ finding: "q", status: "Not Fixed" }])[0].status, "not_fixed");

// parser: optional "previous", old results still parse
const withPrev = parseReviewContract('x\nAUTOPILOT_REVIEW={"decision":"FAIL","findings":["f"],"previous":[{"finding":"a","status":"fixed"},{"finding":"b","status":"not_fixed"}]}');
assert.equal(withPrev.contract.status, "valid");
assert.deepEqual(withPrev.verdict.previous.map(p => p.status), ["fixed", "not_fixed"]);
const old = parseReviewContract('AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}');
assert.equal(old.contract.status, "valid"); assert.deepEqual(old.verdict.previous, []);
const bad = parseReviewContract('AUTOPILOT_REVIEW={"decision":"PASS","findings":[],"previous":"junk"}');
assert.equal(bad.contract.status, "valid"); assert.deepEqual(bad.verdict.previous, []);

// wiring (anchored on source text, tolerant)
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
for (const needle of [
  'codeReviewScopeKey("standalone-phase",s.phaseIndex));',
  'codeReviewScopeKey("speckit-phase",s.phaseIndex));',
  'recordCodeReviewRound(s,codeReviewScopeKey("final","standalone")',
  'recordCodeReviewRound(s,codeReviewScopeKey("final","speckit")',
  "delete s.codeReviewHistory;",
]) assert.ok(src.includes(needle), `missing wiring: ${needle}`);
assert.ok((src.match(/implementerEarlierRoundsText\(/g) || []).length >= 4);
assert.ok((src.match(/clearCodeReviewHistory\(/g) || []).length >= 6);
// argument POSITION: review(reviewer,task,c,s,feedback,requirements,taskRef,timeoutMs,capEnabled,roundKey)
import { callArgs, skipLiteral } from "./test-fixtures/source-scan.mjs";
function topArgs(call) {
  const body = call.slice(call.indexOf("(") + 1, -1);
  const out = []; let depth = 0, cur = 0;
  for (let i = 0; i < body.length; i++) {
    const j = skipLiteral(body, i);
    if (j >= i) { i = j; continue; }
    const ch = body[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) { out.push(body.slice(cur, i).trim()); cur = i + 1; }
  }
  out.push(body.slice(cur).trim());
  return out;
}
const sig = /function review\(([^)]*)\)/.exec(src)[1].split(",").map(x => x.split("=")[0].trim());
assert.equal(sig[9], "roundKey");
const keyed = callArgs(src, 'review("code_reviewer",').filter(c => c.includes("codeReviewScopeKey"));
assert.ok(keyed.length >= 5, "keyed code_reviewer calls found: " + keyed.length);
for (const c of keyed) {
  const a = topArgs(c);
  assert.ok(a.length <= sig.length, "too many args: " + a.length);
  assert.match(a[9] || "", /^codeReviewScopeKey\(/, "roundKey must be 10th arg: " + a.slice(8).join(" | "));
}
console.log("test-118-code-review-rounds OK");
