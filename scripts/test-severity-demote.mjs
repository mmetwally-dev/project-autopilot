#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoteLowSeverityFindings } from "./plan-review-rounds.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

// ── a. FAIL with mixed findings and existing notes ─────────────────────────
{
  const inputA = {
    decision: "FAIL",
    findings: ["[HIGH] a", "[MEDIUM] b", "[low] c", "[RULE: task-size] d"],
    notes: ["n1"]
  };
  const resA = demoteLowSeverityFindings(inputA);
  check("a: moved count is 2", resA.moved === 2, resA.moved);
  check("a: decision is FAIL", resA.review.decision === "FAIL", resA.review.decision);
  check("a: findings keep HIGH and RULE", JSON.stringify(resA.review.findings) === JSON.stringify(["[HIGH] a", "[RULE: task-size] d"]), resA.review.findings);
  check("a: notes appended with MEDIUM and low", JSON.stringify(resA.review.notes) === JSON.stringify(["n1", "[MEDIUM] b", "[low] c"]), resA.review.notes);
}

// ── b. FAIL with only MEDIUM / LOW findings ─────────────────────────────────
{
  const inputB = {
    decision: "FAIL",
    findings: ["[MEDIUM] x", "  [LOW] y"]
  };
  const resB = demoteLowSeverityFindings(inputB);
  check("b: moved count is 2", resB.moved === 2, resB.moved);
  check("b: findings empty", Array.isArray(resB.review.findings) && resB.review.findings.length === 0, resB.review.findings);
  check("b: decision becomes PASS", resB.review.decision === "PASS", resB.review.decision);
  check("b: notes created and populated", JSON.stringify(resB.review.notes) === JSON.stringify(["[MEDIUM] x", "  [LOW] y"]), resB.review.notes);
}

// ── c. unlabeled finding stays in findings and decision stays FAIL ─────────
{
  const inputC = {
    decision: "FAIL",
    findings: ["T012 has no schema"]
  };
  const resC = demoteLowSeverityFindings(inputC);
  check("c: moved count is 0", resC.moved === 0, resC.moved);
  check("c: unlabeled finding stays in findings", JSON.stringify(resC.review.findings) === JSON.stringify(["T012 has no schema"]), resC.review.findings);
  check("c: decision stays FAIL", resC.review.decision === "FAIL", resC.review.decision);
}

// ── d. object findings: problem field wins over location field ─────────────
{
  const f1 = { location: "tasks.md T012", problem: "[MEDIUM] schema not spelled out" };
  const f2 = { location: "[HIGH] tasks.md", problem: "x" };
  const inputD = {
    decision: "FAIL",
    findings: [f1, f2]
  };
  const resD = demoteLowSeverityFindings(inputD);
  check("d: moved count is 1", resD.moved === 1, resD.moved);
  check("d: f1 moved to notes", JSON.stringify(resD.review.notes) === JSON.stringify([f1]), resD.review.notes);
  check("d: f2 kept in findings", JSON.stringify(resD.review.findings) === JSON.stringify([f2]), resD.review.findings);
  check("d: decision stays FAIL", resD.review.decision === "FAIL", resD.review.decision);
}

// ── e. input object is not mutated ─────────────────────────────────────────
{
  const inputE = {
    decision: "FAIL",
    findings: ["[MEDIUM] b", { location: "tasks.md", problem: "[LOW] nit" }],
    notes: ["existing note"]
  };
  const copyE = JSON.parse(JSON.stringify(inputE));
  const resE = demoteLowSeverityFindings(inputE);
  check("e: input not mutated (deep-compare)", JSON.stringify(inputE) === JSON.stringify(copyE), { inputE, copyE });
  check("e: returned review is different instance", resE.review !== inputE, { resReview: resE.review, inputE });
}

// ── f. PASS review with no findings, FAIL review with no findings, and null review ──
{
  const passF = { decision: "PASS", findings: [] };
  const copyPassF = JSON.parse(JSON.stringify(passF));
  const resPassF = demoteLowSeverityFindings(passF);
  check("f: PASS review with no findings has moved 0", resPassF.moved === 0, resPassF.moved);
  check("f: PASS review unchanged", JSON.stringify(resPassF.review) === JSON.stringify(copyPassF), resPassF.review);

  const failEmpty = { decision: "FAIL", findings: [] };
  const resFailEmpty = demoteLowSeverityFindings(failEmpty);
  check("f: FAIL review with no findings has moved 0", resFailEmpty.moved === 0, resFailEmpty.moved);
  check("f: FAIL review with no findings decision stays FAIL", resFailEmpty.review.decision === "FAIL", resFailEmpty.review.decision);

  const resNull = demoteLowSeverityFindings(null);
  check("f: null input has moved 0", resNull.moved === 0, resNull.moved);
  check("f: null input returns review unchanged", resNull.review === null, resNull.review);
}

// ── g. source check: autopilot.mjs wiring ──────────────────────────────────
{
  const autopilotPath = path.join(__dirname, "autopilot.mjs");
  const autopilotSrc = fs.readFileSync(autopilotPath, "utf8");
  const expectedSentence = "Start every finding and every note with its label: [CRITICAL], [HIGH], [MEDIUM] or [LOW] for an analyze issue, or [RULE: <short rule name>] for any other FAIL rule in this review. Put CRITICAL, HIGH and RULE items in \"findings\" (FAIL); put MEDIUM and LOW issues in \"notes\".";
  const expectedLog = "console.log(`  [autopilot] ${moved} MEDIUM/LOW finding(s) moved to notes`);";

  check("g: autopilot contains new label sentence", autopilotSrc.includes(expectedSentence), "expected sentence not found");
  check("g: autopilot contains moved findings log line", autopilotSrc.includes(expectedLog), "expected log line not found");
  const cappedReviewMatch = /const runCappedReview\s*=\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?demoteLowSeverityFindings\(result\.review\)[\s\S]*?return result;/;
  check("g: autopilot calls demoteLowSeverityFindings inside runCappedReview", cappedReviewMatch.test(autopilotSrc), "call inside runCappedReview not found");
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All severity demote tests passed.");

