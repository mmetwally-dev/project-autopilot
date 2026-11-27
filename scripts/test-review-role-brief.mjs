#!/usr/bin/env node
// TASK-18 finding 2: every review-role prompt (plan_reviewer, code_reviewer,
// verifier) must carry the single-shot / no-later-turn contract.
//
// Run 15's planning reviewer ended its turn with "I'll stop polling now and
// wait for the background task notification to arrive", which a single-shot
// `-p` invocation can never deliver; it produced no sentinel and the mission
// halted. Nothing else in the prompt told it that was impossible.
//
// These are static checks over the single prompt choke point (runRelay's
// `review` branch) and the wiring that routes all three roles through it. What
// a model does with the instruction cannot be asserted from here, but its
// presence in every review prompt can — and its silent removal is exactly the
// regression that would otherwise pass unnoticed.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {formatLinkedTestDurations, formatHeavySuiteNoParallelNote, HEAVY_E2E_SUITES, LINKED_TEST_UNMEASURED_FALLBACK} from "./verifier-brief.mjs";
import {buildStandaloneHandoff} from "./standalone-handoff.mjs";
import {DEFECT_PATTERN_REVIEW_INSTRUCTION, DEFECT_PATTERN_FIX_INSTRUCTION, saveReviewFeedback, loadReviewFeedback, feedbackText} from "./review-feedback.mjs";
import {buildCrossPhaseRepairPrompt} from "./finding-task-locality.mjs";
import {assembleReviewBriefForTests, IMPLEMENTER_RETRY_FEEDBACK_HEADING} from "./autopilot.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  failed += 1;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

// ── The contract lives in the `review`-flagged branch of the prompt ──
const branch = source.match(/review \? [`']([\s\S]*?)[`'] : ""/);
check("the review-flagged prompt branch exists", branch !== null);
const branchText = branch ? branch[1] : "";
for (const phrase of ["SINGLE-SHOT", "no later turn", "waiting for a background task"]) {
  check(`review branch states '${phrase}'`, branchText.includes(phrase), branchText.slice(0, 200));
}
check("the contract precedes the sentinel instruction, so it is read as a constraint on the whole turn",
  branchText.indexOf("SINGLE-SHOT") >= 0 && branchText.indexOf("SINGLE-SHOT") < branchText.indexOf("End with exactly one line"),
  branchText.slice(0, 200));
check("the contract forbids ending the turn while waiting",
  /never end your turn waiting/i.test(branchText));
check("the contract names the consequence (no verdict / mission halts)",
  /no verdict/i.test(branchText) && /halts/i.test(branchText));

// ── All three review roles route through that branch ──
// A role's call body is its own argument list (from its opening "(" to the
// matching ")"), skipping string/template literals and comments so a
// `review:true` belonging to a later call or helper can never match.
function callBodyAt(index) {
  const open = source.indexOf("(", index);
  if (open < 0) return "";
  let parenDepth = 1;
  let inTemplate = false;
  const templateBraceDepths = [];
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i];
    if (inTemplate) {
      if (ch === "\\") { i++; continue; }
      if (ch === "`") { inTemplate = false; continue; }
      if (ch === "$" && source[i + 1] === "{") {
        templateBraceDepths.push(0);
        inTemplate = false;
        i++;
        continue;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i + 2);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      const quote = ch;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === quote) break;
        i++;
      }
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      continue;
    }
    if (ch === "{" && templateBraceDepths.length > 0) {
      templateBraceDepths[templateBraceDepths.length - 1]++;
      continue;
    }
    if (ch === "}" && templateBraceDepths.length > 0) {
      if (templateBraceDepths[templateBraceDepths.length - 1] === 0) {
        templateBraceDepths.pop();
        inTemplate = true;
      } else {
        templateBraceDepths[templateBraceDepths.length - 1]--;
      }
      continue;
    }
    if (ch === "(") {
      parenDepth++;
    } else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0 && templateBraceDepths.length === 0) {
        return source.slice(index, i + 1);
      }
    }
  }
  return source.slice(index);
}
for (const role of ["plan_reviewer", "code_reviewer", "verifier"]) {
  const bodies = [...source.matchAll(new RegExp(`(?:relayAsync|relay)\\(\\s*"${role}"`, "g"))].map(match => callBodyAt(match.index));
  check(`${role}: has at least one relay call`, bodies.length > 0);
  check(`${role}: every relay call passes review:true (so the contract reaches it)`,
    bodies.length > 0 && bodies.every(body => /review:\s*true/.test(body)),
    bodies.map(body => body.slice(0, 120)));
}

// ── The review() wrapper: the Standalone/SpecKit path ──
// The scan above only sees calls carrying a LITERAL role name, which is GSD's
// shape. `review()` takes the role as a parameter and is how Standalone and
// SpecKit dispatch `plan_reviewer`/`code_reviewer`, so if `review:true` were
// dropped from its own relay() call every one of those reviews would silently
// lose the contract while the scan above still passed on GSD's call sites.
const wrapper = source.match(/function review\(([\s\S]*?)\n\}/);
check("the review() wrapper exists", wrapper !== null);
check("review() itself passes review:true to relay()",
  wrapper !== null && /review:\s*true/.test(wrapper[1]),
  wrapper ? wrapper[1].slice(0, 200) : null);
const wrapperCallers = [...source.matchAll(/await review\(\s*"([a-z_]+)"/g)].map(match => match[1]);
check("review() is actually used for review roles, so that assertion is not vacuous",
  wrapperCallers.length >= 2, wrapperCallers);
check("every literal-role review() caller passes a review role",
  wrapperCallers.every(role => ["plan_reviewer", "code_reviewer", "verifier"].includes(role)),
  wrapperCallers);

// ── The writable roles are deliberately out of scope for this contract ──
check("planner (a writable role) does not carry the review contract",
  ![...source.matchAll(/(?:relayAsync|relay)\(\s*"planner"/g)].some(match => /review:\s*true/.test(callBodyAt(match.index))));

// ── EOL-normalized diff fallback reaches every relayed role ──
// Mission 024 phase 2 task 2.3: runRelay's shared prompt lines must instruct
// the cheap fallback with wording identical to the other brief builders.
check("relay prompt carries the EOL-normalized diff fallback sentence",
  source.includes("If a git diff shows whole-file churn, re-run it EOL-normalized (git diff --ignore-cr-at-eol or git -c core.autocrlf=input diff) and trust the normalized stat."));
check("relay prompt names git diff --ignore-cr-at-eol",
  source.includes("git diff --ignore-cr-at-eol"));
check("relay prompt names the pinned -c equivalent",
  source.includes("git -c core.autocrlf=input diff"));

// ── Mission 025 phase 4 task 4.4: duration lines + no-parallel rule ──
// Unit-level: the duration renderer states each linked test's measured
// duration and falls back explicitly when unmeasured.
// Standalone: the reviewer handoff carries both sections.
// SpecKit: the reviewer/final prompts in autopilot.mjs wire both sections.
{
  const measured = formatLinkedTestDurations(
    ["node scripts/test-a.mjs"], {"node scripts/test-a.mjs": 123});
  check("durations: measured line names the command with its ms",
    measured.includes("node scripts/test-a.mjs") && measured.includes("123 ms") && measured.includes("(measured)"),
    measured.slice(0, 200));
  check("durations: measured header forbids a shorter timeout",
    /never impose a shorter timeout/i.test(measured), measured.slice(0, 200));
  const unmeasured = formatLinkedTestDurations(["node scripts/test-b.mjs"], {});
  check("durations: unmeasured linked test gets the explicit fallback",
    unmeasured.includes("node scripts/test-b.mjs") && unmeasured.includes(LINKED_TEST_UNMEASURED_FALLBACK),
    unmeasured.slice(0, 200));
  check("durations: fallback forbids a shorter timeout than the role deadline",
    /do not impose a shorter timeout than the role deadline/i.test(unmeasured), unmeasured.slice(0, 200));
  check("durations: no linked commands renders empty (callers stay byte-identical)",
    formatLinkedTestDurations([], {}) === "" && formatLinkedTestDurations(null, null) === "");
  const historyOnly = formatLinkedTestDurations(
    ["node scripts/test-c.mjs"], {"node scripts/test-c.mjs": "456"});
  check("durations: string-coerced history sample still counts as measured",
    historyOnly.includes("456 ms") && historyOnly.includes("(measured)"), historyOnly.slice(0, 200));
}
{
  const note = formatHeavySuiteNoParallelNote();
  check("no-parallel: note is non-empty", note.trim().length > 0, note.slice(0, 200));
  for (const suite of HEAVY_E2E_SUITES) {
    check(`no-parallel: note names heavy suite '${suite}'`, note.includes(suite), note.slice(0, 200));
  }
  check("no-parallel: note forbids parallel runs", /do not run in parallel/i.test(note), note.slice(0, 200));
  check("no-parallel: note instructs serial runs", /serially/i.test(note), note.slice(0, 200));
}
{
  const linked = ["node scripts/test-a.mjs"];
  const gateResult = {command: "node scripts/test-a.mjs", ok: true, exitCode: 0, durationMs: 321, logFile: null, tail: "ok",
    results: [{command: "node scripts/test-a.mjs", ok: true, exitCode: 0, durationMs: 321, logFile: null, tail: "ok"}]};
  const handoff = buildStandaloneHandoff({kind: "PHASE_REVIEW",
    phaseName: "Phase 1 — Build", phaseIndex: 0, phaseTotal: 1,
    phaseTasks: [{file: "/repo/TASKS.md", line: 3, text: "Do the thing"}],
    attempt: 1, deltaChunks: [{path: "a.js", text: "diff"}],
    baselineKey: "mission-025-p4", declaredPaths: [], implementationSummary: "",
    gateResult, gateHistory: {}, linkedVerifyCommands: linked});
  check("standalone reviewer brief: states the linked test's measured duration",
    handoff.text.includes("node scripts/test-a.mjs") && handoff.text.includes("321 ms"),
    handoff.text.slice(0, 300));
  const unmeasuredHandoff = buildStandaloneHandoff({kind: "PHASE_REVIEW",
    phaseName: "Phase 1 — Build", phaseIndex: 0, phaseTotal: 1,
    phaseTasks: [{file: "/repo/TASKS.md", line: 3, text: "Do the thing"}],
    attempt: 1, deltaChunks: [{path: "a.js", text: "diff"}],
    baselineKey: "mission-025-p4", declaredPaths: [], implementationSummary: "",
    gateResult: null, gateHistory: {}, linkedVerifyCommands: ["node scripts/test-b.mjs"]});
  check("standalone reviewer brief: unmeasured linked test gets the fallback, never silently omitted",
    unmeasuredHandoff.text.includes("node scripts/test-b.mjs") && unmeasuredHandoff.text.includes(LINKED_TEST_UNMEASURED_FALLBACK),
    unmeasuredHandoff.text.slice(0, 300));
  const bareHandoff = buildStandaloneHandoff({kind: "PHASE_REVIEW",
    phaseName: "Phase 1 — Build", phaseIndex: 0, phaseTotal: 1,
    phaseTasks: [{file: "/repo/TASKS.md", line: 3, text: "Do the thing"}],
    attempt: 1, deltaChunks: [{path: "a.js", text: "diff"}],
    baselineKey: "mission-025-p4", declaredPaths: [], implementationSummary: ""});
  check("standalone reviewer brief: no-parallel rule rides unconditionally (no linked commands)",
    HEAVY_E2E_SUITES.every((suite) => bareHandoff.text.includes(suite)) && /do not run in parallel/i.test(bareHandoff.text),
    bareHandoff.text.slice(0, 300));
}
check("SpecKit reviewer prompt appends per-linked-test durations from gate history",
  source.includes("const reviewDurations=formatLinkedTestDurations(linkedVerifyCommandsForPhase(phaseTasks"),
  "missing SpecKit reviewer reviewDurations wiring");
check("SpecKit reviewer prompt appends the heavy-suite no-parallel note",
  source.includes("const heavyNoParallel=formatHeavySuiteNoParallelNote()"),
  "missing SpecKit reviewer heavyNoParallel wiring");
check("SpecKit verifier prompt appends per-linked-test durations from the just-run gate",
  source.includes("const verifyDurations=formatLinkedTestDurations(linkedVerifyCommandsForPhase(phaseTasks"),
  "missing SpecKit verifier verifyDurations wiring");
check("SpecKit final review carries the heavy-suite no-parallel note",
  source.includes("const speckitFinalNoParallel=formatHeavySuiteNoParallelNote()"),
  "missing SpecKit final speckitFinalNoParallel wiring");

// ── Backlog #9 / #8: defect pattern search and fix prompt contracts ──
check("review prompt carries defect pattern instruction",
  branchText.includes("${DEFECT_PATTERN_REVIEW_INSTRUCTION}") || branchText.replace(/\\'/g, "'").includes(DEFECT_PATTERN_REVIEW_INSTRUCTION),
  branchText.slice(0, 300));
check("assembleReviewBriefForTests includes defect pattern instruction for code_reviewer",
  assembleReviewBriefForTests({roleName: "code_reviewer", adapter: "codex"}).includes(DEFECT_PATTERN_REVIEW_INSTRUCTION));
check("assembleReviewBriefForTests includes defect pattern instruction for verifier",
  assembleReviewBriefForTests({roleName: "verifier", adapter: "codex"}).includes(DEFECT_PATTERN_REVIEW_INSTRUCTION));
// Backlog #4 moved the standalone/SpecKit verifier relay behind
// relayVerifierWithApp(); the wrapper's options still carry review:true to
// the inner relayAsync call, so both call sites must keep it.
check("both standalone and SpecKit verifier relay calls pass review:true",
  [...source.matchAll(/await relayVerifierWithApp\(/g)].length >= 2 &&
  [...source.matchAll(/await relayVerifierWithApp\(/g)].every(m =>
    /review:\s*true/.test(callBodyAt(source.indexOf("relayVerifierWithApp(", m.index))))
  && [...source.matchAll(/relayAsync\(\s*"verifier"/g)].every(m => /review:\s*true/.test(callBodyAt(m.index))));
check("implementer retry heading carries defect pattern fix instruction",
  IMPLEMENTER_RETRY_FEEDBACK_HEADING.includes(DEFECT_PATTERN_FIX_INSTRUCTION));
check("standalone and SpecKit implementer retry loops use IMPLEMENTER_RETRY_FEEDBACK_HEADING",
  [...source.matchAll(/\$\{IMPLEMENTER_RETRY_FEEDBACK_HEADING\}/g)].length >= 6);
{
  // Trace verifier FAIL -> saveReviewFeedback -> loadReviewFeedback -> implementer retry brief
  const state = {};
  const verifierFindings = [
    {location: "test/pem.mjs:12", problem: "PEM detector ignores bodies >8192 chars", correction: "Remove arbitrary length cap and validate PEM structure directly"},
  ];
  const saved = saveReviewFeedback(state, "phase:0", verifierFindings);
  const loaded = loadReviewFeedback(state, "phase:0");
  const retryBrief = `${IMPLEMENTER_RETRY_FEEDBACK_HEADING}\n${feedbackText(loaded)}`;
  check("implementer brief after verifier FAIL contains DEFECT_PATTERN_FIX_INSTRUCTION",
    saved.length === 1 && loaded.length === 1 && retryBrief.includes(DEFECT_PATTERN_FIX_INSTRUCTION),
    retryBrief.slice(0, 300));
  const crossPhasePrompt = buildCrossPhaseRepairPrompt({
    owner: {taskId: "T1"},
    file: "test/pem.mjs",
    findingText: feedbackText(loaded),
  });
  check("cross-phase repair prompt contains DEFECT_PATTERN_FIX_INSTRUCTION",
    crossPhasePrompt.includes(DEFECT_PATTERN_FIX_INSTRUCTION),
    crossPhasePrompt.slice(0, 300));
}
check("defect pattern fix instruction wording is exact and strengthened",
  DEFECT_PATTERN_FIX_INSTRUCTION === "fix this pattern everywhere it occurs in the phase's files, not only at the cited line, and fix the underlying rule rather than adding another limit that only covers the named case" &&
  /underlying rule/i.test(DEFECT_PATTERN_FIX_INSTRUCTION) &&
  /adding another limit/i.test(DEFECT_PATTERN_FIX_INSTRUCTION));
check("defect pattern review instruction wording is exact and strengthened",
  DEFECT_PATTERN_REVIEW_INSTRUCTION === "When you find a defect, search the phase's changed files for the same pattern and list EVERY location as its own finding in this verdict; if the defect is a weak rule in a check (such as an arbitrary size, length, or file-type limit that lets bad input through), report the root flaw and every boundary of it in ONE finding with the correction for the whole rule rather than one edge case per round" &&
  /weak rule/i.test(DEFECT_PATTERN_REVIEW_INSTRUCTION) &&
  /root flaw/i.test(DEFECT_PATTERN_REVIEW_INSTRUCTION) &&
  /every boundary/i.test(DEFECT_PATTERN_REVIEW_INSTRUCTION) &&
  /ONE finding/i.test(DEFECT_PATTERN_REVIEW_INSTRUCTION) &&
  /whole rule/i.test(DEFECT_PATTERN_REVIEW_INSTRUCTION));

if (failed) {
  console.error(`${failed} review-role brief check(s) failed.`);
  process.exit(1);
}
console.log(`Review-role brief contract tests passed (${ok} checks)`);
