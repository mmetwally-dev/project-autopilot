import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadReviewOpenFindings,
  saveReviewOpenFindings,
  clearReviewOpenFindings,
  clearReviewOpenFindingsByPrefix,
  updateReviewOpenFindings,
  formatReviewOpenFindingsBrief,
  normalizeFindingKey,
  matchFinding,
  saveReviewFeedback,
  loadReviewFeedback,
} from "./review-feedback.mjs";
import { parseReviewContract } from "./failure-contract.mjs";

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`PASS ${name}`);
    });
}

// -----------------------------------------------------------------------------
// 1. Sentinel parsing without "resolved"
// -----------------------------------------------------------------------------
await test("parseReviewContract: standard sentinel parses verdict and findings", () => {
  const sentinel = `Review output
AUTOPILOT_REVIEW: {"decision":"FAIL","findings":["src/foo.mjs:10 problem"]}`;
  const parsed = parseReviewContract(sentinel);
  assert.equal(parsed.contract.status, "valid");
  assert.equal(parsed.verdict.status, "available");
  assert.equal(parsed.verdict.decision, "FAIL");
  assert.deepEqual(parsed.verdict.findings, ["src/foo.mjs:10 problem"]);
  assert.equal(parsed.verdict.resolved, undefined);
});

await test("parseReviewContract: parses previous statuses without resolved field", () => {
  const sentinel = `Review output
AUTOPILOT_REVIEW: {"decision":"PASS","findings":[],"previous":[{"finding":"src/foo.mjs:10 problem","status":"fixed"}]}`;
  const parsed = parseReviewContract(sentinel);
  assert.equal(parsed.contract.status, "valid");
  assert.equal(parsed.verdict.status, "available");
  assert.equal(parsed.verdict.decision, "PASS");
  assert.deepEqual(parsed.verdict.findings, []);
  assert.equal(parsed.verdict.previous.length, 1);
  assert.equal(parsed.verdict.previous[0].status, "fixed");
  assert.equal(parsed.verdict.resolved, undefined);
});

// -----------------------------------------------------------------------------
// 2. updateReviewOpenFindings driven by "previous"
// -----------------------------------------------------------------------------
await test("updateReviewOpenFindings: assigns stable IDs F1, F2...", () => {
  const s = {};
  const res1 = updateReviewOpenFindings(s, "phase:0", {
    newFindings: [
      "src/a.mjs:10 missing null check",
      { location: "src/b.mjs:20", problem: "unclosed resource", fix: "close it" },
    ],
    previous: [],
  });
  assert.equal(res1.openFindings.length, 2);
  assert.equal(res1.openFindings[0].id, "F1");
  assert.equal(res1.openFindings[1].id, "F2");
  assert.deepEqual(loadReviewOpenFindings(s, "phase:0"), res1.openFindings);
});

await test("updateReviewOpenFindings: marking F1 fixed in previous drops F1 and leaves F2", () => {
  const s = {};
  updateReviewOpenFindings(s, "phase:0", {
    newFindings: ["src/a.mjs:10 first", "src/b.mjs:20 second"],
    previous: [],
  });
  const res2 = updateReviewOpenFindings(s, "phase:0", {
    newFindings: [],
    previous: [{ finding: "src/a.mjs:10 first", status: "fixed" }],
  });
  assert.equal(res2.openFindings.length, 1);
  assert.equal(res2.openFindings[0].id, "F2");
  assert.equal(res2.openFindings[0].text, "src/b.mjs:20 second");
  assert.equal(res2.dropped.length, 1);
  assert.equal(res2.dropped[0].id, "F1");
});

await test("updateReviewOpenFindings: marking F1 needs_run in previous drops F1", () => {
  const s = {};
  updateReviewOpenFindings(s, "phase:0", {
    newFindings: ["src/a.mjs:10 flaky test check", "src/b.mjs:20 second"],
    previous: [],
  });
  const res2 = updateReviewOpenFindings(s, "phase:0", {
    newFindings: [],
    previous: [{ finding: "F1: src/a.mjs:10 flaky test check", status: "needs_run" }],
  });
  assert.equal(res2.openFindings.length, 1);
  assert.equal(res2.openFindings[0].id, "F2");
  assert.equal(res2.dropped.length, 1);
  assert.equal(res2.dropped[0].id, "F1");
});

await test("updateReviewOpenFindings: marking F2 not_fixed in previous keeps F2 carried", () => {
  const s = {};
  updateReviewOpenFindings(s, "phase:0", {
    newFindings: ["src/a.mjs:10 first", "src/b.mjs:20 second"],
    previous: [],
  });
  const res2 = updateReviewOpenFindings(s, "phase:0", {
    newFindings: [],
    previous: [
      { finding: "src/a.mjs:10 first", status: "fixed" },
      { finding: "src/b.mjs:20 second", status: "not_fixed" },
    ],
  });
  assert.equal(res2.openFindings.length, 1);
  assert.equal(res2.openFindings[0].id, "F2");
  assert.equal(res2.openFindings[0].text, "src/b.mjs:20 second");
  assert.equal(res2.remainingEarlier.length, 1);
  assert.equal(res2.remainingEarlier[0].id, "F2");
});

await test("updateReviewOpenFindings: missing previous status for F2 carries F2 (silently-dropped bug fix)", () => {
  const s = {};
  updateReviewOpenFindings(s, "phase:0", {
    newFindings: ["src/a.mjs:10 first", "src/b.mjs:20 second"],
    previous: [],
  });
  // Reviewer reports previous only for F1, completely omitting F2
  const res2 = updateReviewOpenFindings(s, "phase:0", {
    newFindings: [],
    previous: [{ finding: "src/a.mjs:10 first", status: "fixed" }],
  });
  assert.equal(res2.openFindings.length, 1);
  assert.equal(res2.openFindings[0].id, "F2");
  assert.equal(res2.remainingEarlier.length, 1);
  assert.equal(res2.remainingEarlier[0].id, "F2");
});

await test("updateReviewOpenFindings: re-raised finding dedupes and retains its ID", () => {
  const s = {};
  updateReviewOpenFindings(s, "phase:0", {
    newFindings: ["src/a.mjs:10 issue A", "src/b.mjs:20 issue B"],
    previous: [],
  });
  // Re-raise issue B with identical text + report brand new issue C; F1 fixed
  const res2 = updateReviewOpenFindings(s, "phase:0", {
    newFindings: ["src/b.mjs:20 issue B", "src/c.mjs:30 issue C"],
    previous: [{ finding: "F1", status: "fixed" }],
  });
  assert.equal(res2.openFindings.length, 2);
  assert.equal(res2.openFindings[0].id, "F2");
  assert.equal(res2.openFindings[0].text, "src/b.mjs:20 issue B");
  assert.equal(res2.openFindings[1].id, "F3");
  assert.equal(res2.openFindings[1].text, "src/c.mjs:30 issue C");
});

await test("updateReviewOpenFindings: re-raised structured finding dedupes by location+problem", () => {
  const s = {};
  updateReviewOpenFindings(s, "phase:0", {
    newFindings: [{ location: "src/x.mjs:5", problem: "memory leak", fix: "free buffer" }],
    previous: [],
  });
  // Re-raise with slightly different fix wording
  const res2 = updateReviewOpenFindings(s, "phase:0", {
    newFindings: [{ location: "src/x.mjs:5", problem: "memory leak", fix: "buffer.dispose()" }],
    previous: [],
  });
  assert.equal(res2.openFindings.length, 1);
  assert.equal(res2.openFindings[0].id, "F1");
  assert.equal(res2.openFindings[0].raw.problem, "memory leak");
});

// -----------------------------------------------------------------------------
// 3. Backlog item #4 scenario (standalone and SpecKit)
// -----------------------------------------------------------------------------
for (const [framework, phaseKey] of [["standalone", "phase:0"], ["speckit", "speckit-phase:0"]]) {
  await test(`${framework}: Backlog #4 scenario — omitted unfixed finding carried forward`, () => {
    const s = {};

    // Round 1: reviewer reports F1 and F2
    const round1 = updateReviewOpenFindings(s, phaseKey, {
      newFindings: ["src/auth.mjs:12 auth bypass", "src/db.mjs:45 leak"],
      previous: [],
    });
    assert.equal(round1.openFindings.length, 2);
    assert.equal(round1.openFindings[0].id, "F1");
    assert.equal(round1.openFindings[1].id, "F2");

    saveReviewFeedback(s, phaseKey, round1.openFindings.map(f => f.raw || f.text));
    assert.deepEqual(loadReviewFeedback(s, phaseKey), [
      "src/auth.mjs:12 auth bypass",
      "src/db.mjs:45 leak",
    ]);

    // Implementer fixes F1.
    // Round 2: Reviewer reports F3, previous marks F1 fixed, but OMITS F2!
    const round2 = updateReviewOpenFindings(s, phaseKey, {
      newFindings: ["src/api.mjs:88 status code wrong"],
      previous: [{ finding: "src/auth.mjs:12 auth bypass", status: "fixed" }],
    });

    // F2 MUST NOT BE LOST: openFindings contains both F2 (carried forward) and F3 (new)
    assert.equal(round2.openFindings.length, 2);
    assert.equal(round2.openFindings[0].id, "F2");
    assert.equal(round2.openFindings[0].text, "src/db.mjs:45 leak");
    assert.equal(round2.openFindings[1].id, "F3");
    assert.equal(round2.openFindings[1].text, "src/api.mjs:88 status code wrong");

    // The saved feedback for Implementer re-run brief includes F2
    saveReviewFeedback(s, phaseKey, round2.openFindings.map(f => f.raw || f.text));
    const savedFeedback = loadReviewFeedback(s, phaseKey);
    assert.equal(savedFeedback.length, 2);
    assert.ok(savedFeedback.some(t => String(t).includes("src/db.mjs:45 leak")));
    assert.ok(savedFeedback.some(t => String(t).includes("src/api.mjs:88 status code wrong")));

    // Re-review brief lists open findings with IDs
    const brief = formatReviewOpenFindingsBrief(loadReviewOpenFindings(s, phaseKey));
    assert.ok(brief.includes("F2: src/db.mjs:45 leak"));
    assert.ok(brief.includes("F3: src/api.mjs:88 status code wrong"));
  });
}

// -----------------------------------------------------------------------------
// 4. formatReviewOpenFindingsBrief: capping at 20
// -----------------------------------------------------------------------------
await test("formatReviewOpenFindingsBrief: lists all findings when under 20", () => {
  const findings = [
    { id: "F1", text: "src/1.mjs:1 error" },
    { id: "F2", text: "src/2.mjs:2 warn" },
  ];
  const brief = formatReviewOpenFindingsBrief(findings);
  assert.ok(brief.includes("F1: src/1.mjs:1 error"));
  assert.ok(brief.includes("F2: src/2.mjs:2 warn"));
  assert.ok(!brief.includes("more earlier open findings"));
});

await test("formatReviewOpenFindingsBrief: caps at 20 and counts the rest", () => {
  const findings = [];
  for (let i = 1; i <= 25; i++) {
    findings.push({ id: `F${i}`, text: `file${i}.js: error ${i}` });
  }
  const brief = formatReviewOpenFindingsBrief(findings);
  assert.ok(brief.includes("F1:"));
  assert.ok(brief.includes("F20:"));
  assert.ok(!brief.includes("F21:"));
  assert.ok(brief.includes("...and 5 more earlier open finding(s)"));
});

// -----------------------------------------------------------------------------
// 5. Clearing open findings
// -----------------------------------------------------------------------------
await test("clearReviewOpenFindings and clearReviewOpenFindingsByPrefix", () => {
  const s = {};
  updateReviewOpenFindings(s, "phase:0", { newFindings: ["err1"], previous: [] });
  updateReviewOpenFindings(s, "phase:1", { newFindings: ["err2"], previous: [] });
  assert.equal(loadReviewOpenFindings(s, "phase:0").length, 1);
  assert.equal(loadReviewOpenFindings(s, "phase:1").length, 1);

  clearReviewOpenFindings(s, "phase:0");
  assert.deepEqual(loadReviewOpenFindings(s, "phase:0"), []);
  assert.equal(loadReviewOpenFindings(s, "phase:1").length, 1);

  clearReviewOpenFindingsByPrefix(s, "phase:");
  assert.deepEqual(loadReviewOpenFindings(s, "phase:1"), []);
});

console.log(`\nAll ${passed} tests passed.`);
