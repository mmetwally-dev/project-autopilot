#!/usr/bin/env node
// Backlog #6: First-round coverage table, unchanged-text rule on later rounds,
// continuation table resume, progress counting table growth, and
// caps.plan_reviewer.first_round_reasoning.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLAN_REVIEW_EXHAUSTIVE_LINE,
  PLAN_REVIEW_VERIFY_LINE,
  PLAN_REVIEW_CONFIRMATION_LINE,
  PLAN_REVIEW_UNCHANGED_TEXT_RULE,
  planReviewerRoundLines,
  planReviewerConfirmationLines,
  recordPlanReviewRound,
  markPlanReviewConfirmationPending,
  markPlanReviewConfirmationFailed,
  isFirstPlanReviewRound,
  coverageTablePath,
  coverageTableInstruction,
} from "./plan-review-rounds.mjs";
import {
  reviewSessionProgress,
  copyCarriedScratch,
  seedPreviousScratch,
  readCarriedScratchReportText,
} from "./per-task-budget.mjs";
import { DEFAULTS, toRuntimeConfig, toNewLayoutConfig } from "./config-layout.mjs";
import { validateNewConfig } from "./config-validation.mjs";
import {
  readOnlyContinuationNoteForTests,
  withFirstRoundReasoningForTests,
  resolveFirstRoundReasoningForTests,
} from "./autopilot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

// ── 1. First-round brief contains coverage-table instruction ────────────────
{
  for (const [gate, expectedPath] of [
    ["review-plan", "/workspace/scratch/coverage-review-plan.md"],
    ["review-tasks", "/workspace/scratch/coverage-review-tasks.md"],
    ["standalone-plan", "/workspace/scratch/coverage-standalone-plan.md"],
  ]) {
    const p = coverageTablePath(gate);
    const instr = coverageTableInstruction(gate);
    check(`coverageTablePath(${gate}) -> ${expectedPath}`, p === expectedPath, p);
    check(`coverageTableInstruction(${gate}): names table path + schema + GAP rule + hand-off sections`,
      instr.includes(expectedPath)
      && instr.includes("requirement | covering task id(s) or plan section | OK or GAP: reason")
      && instr.includes("Every GAP row becomes a finding")
      && instr.includes("1. Checked and clear")
      && instr.includes("3. Remaining"),
      instr);
  }

  const s = {};
  const K = "speckit:tasks";
  check("isFirstPlanReviewRound: true on fresh state", isFirstPlanReviewRound(s, K) === true);
  // Deterministic denylist rejection (reviewer: false) leaves reviewer round count at 0 -> still round 1
  recordPlanReviewRound(s, K, ["TASKS.md T001: bad command"], [], { reviewer: false });
  check("isFirstPlanReviewRound: true after deterministic rejection (reviewer never ran)",
    isFirstPlanReviewRound(s, K) === true);

  // Real reviewer round 1 FAIL -> round 2+ is no longer first round
  recordPlanReviewRound(s, K, ["TASKS.md T001: missing FR-001"], [], { reviewer: true });
  check("isFirstPlanReviewRound: false after real reviewer round 1",
    isFirstPlanReviewRound(s, K) === false);

  const sConf = {};
  markPlanReviewConfirmationPending(sConf, K);
  check("isFirstPlanReviewRound: false when confirmation pending", isFirstPlanReviewRound(sConf, K) === false);

  const sConfFail = {};
  markPlanReviewConfirmationFailed(sConfFail, K);
  check("isFirstPlanReviewRound: false when confirmation failed", isFirstPlanReviewRound(sConfFail, K) === false);

  // Wiring in scripts/autopilot.mjs for all three sites (SpecKit review-plan, review-tasks, standalone)
  const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  check("autopilot.mjs wires SpecKit review-plan and review-tasks first-round coverage table",
    autopilotSrc.includes('(gateStage==="plan" || gateStage==="tasks") && isFirstPlanReviewRound(s,gateKey)')
    && autopilotSrc.includes("coverageTableInstruction(step.id)"),
    "missing SpecKit coverageTableInstruction wiring");
  check("autopilot.mjs wires standalone plan review first-round coverage table",
    autopilotSrc.includes('isFirstPlanReviewRound(s,STANDALONE_PLAN_FEEDBACK_KEY)')
    && autopilotSrc.includes('coverageTableInstruction("standalone-plan")'),
    "missing standalone coverageTableInstruction wiring");
}

// ── 2. Re-review brief contains unchanged-text rule and NOT table instruction ─
{
  const expectedRule = "A NEW finding on text unchanged since the first review round must say why the first round missed it, and is allowed only if BLOCKING; do not add new HIGH/minor items on unchanged text.";
  check("PLAN_REVIEW_UNCHANGED_TEXT_RULE matches exact wording",
    PLAN_REVIEW_UNCHANGED_TEXT_RULE === expectedRule, PLAN_REVIEW_UNCHANGED_TEXT_RULE);

  const K = "speckit:plan";
  const round1 = planReviewerRoundLines({}, K).join("\n");
  check("round 1 brief: exhaustive line, does NOT contain unchanged-text rule",
    round1.includes(PLAN_REVIEW_EXHAUSTIVE_LINE) && !round1.includes(expectedRule), round1);

  const s2 = {};
  recordPlanReviewRound(s2, K, ["PLAN.md Scope: missing auth"], [], { reviewer: true });
  const round2 = planReviewerRoundLines(s2, K).join("\n");
  check("re-review brief (round 2): contains unchanged-text rule and NOT coverage-table instruction",
    round2.includes(PLAN_REVIEW_VERIFY_LINE)
    && round2.includes(expectedRule)
    && !round2.includes("/workspace/scratch/coverage-"),
    round2);

  const conf = planReviewerConfirmationLines().join("\n");
  check("confirmation brief: contains unchanged-text rule and NOT coverage-table instruction",
    conf.includes(PLAN_REVIEW_CONFIRMATION_LINE)
    && conf.includes(expectedRule)
    && !conf.includes("/workspace/scratch/coverage-"),
    conf);

  const sConfFail = {};
  recordPlanReviewRound(sConfFail, K, ["PLAN.md Scope: still broken"], [], { reviewer: true });
  markPlanReviewConfirmationFailed(sConfFail, K);
  const postConfFail = planReviewerRoundLines(sConfFail, K).join("\n");
  check("post-confirmation-fail full brief: contains unchanged-text rule and NOT coverage-table instruction",
    postConfFail.includes(expectedRule) && !postConfFail.includes("/workspace/scratch/coverage-"),
    postConfFail);

  const offRound2 = planReviewerRoundLines(s2, K, false).join("\n");
  check("convergence-off round 2: contains unchanged-text rule and NOT coverage-table instruction",
    offRound2.includes(expectedRule) && !offRound2.includes("/workspace/scratch/coverage-"),
    offRound2);
}

// ── 3. Continuation brief tells next session to continue the same table ─────
{
  const noteBody = [
    "1. Checked and clear — coverage rows FR-001..FR-040 done",
    "2. Findings (final) — none",
    "3. Remaining — coverage rows FR-041..FR-070",
    "4. Dead ends — none",
  ].join("\n");

  for (const ref of ["speckit-plan_reviewer", "standalone-planning-plan_reviewer"]) {
    const cont = readOnlyContinuationNoteForTests(noteBody, "/nonexistent-repo", "008-test", ref, "reviewer");
    check(`continuation brief (${ref}): instructs to continue coverage table from first unfinished row without re-checking done rows`,
      cont.includes("coverage-*.md")
      && cont.includes("first unfinished row")
      && cont.includes("do not re-check done rows")
      && cont.includes("previous-session"),
      cont);
  }

  const codeCont = readOnlyContinuationNoteForTests(noteBody, "/nonexistent-repo", "008-test", "T1.1", "reviewer");
  check("continuation brief (code_reviewer T1.1): does not inject coverage-*.md instruction",
    !codeCont.includes("coverage-*.md"), codeCont);

  // Verify carried scratch preserves coverage-<gate>.md into previous-session/
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-b6-scratch-"));
  try {
    const srcScratch = path.join(tmp, "src-scratch");
    const carried = path.join(tmp, "carried");
    const nextScratch = path.join(tmp, "next-scratch");
    fs.mkdirSync(srcScratch, { recursive: true });
    fs.mkdirSync(nextScratch, { recursive: true });
    const tableContent = [
      "| requirement | covering | status |",
      "| --- | --- | --- |",
      "| FR-001 | T001 | OK |",
    ].join("\n");
    fs.writeFileSync(path.join(srcScratch, "coverage-review-tasks.md"), tableContent, "utf8");
    const copied = copyCarriedScratch(srcScratch, carried);
    const seeded = seedPreviousScratch(carried, nextScratch);
    const seededTable = path.join(nextScratch, "previous-session", "coverage-review-tasks.md");
    check("carried scratch preserves coverage-review-tasks.md into previous-session/",
      copied.copied === 1 && seeded === true && fs.existsSync(seededTable) && fs.readFileSync(seededTable, "utf8") === tableContent,
      { copied, seeded, exists: fs.existsSync(seededTable) });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 4. Progress counts coverage table growth ────────────────────────────────
{
  const sameNote = [
    "1. Checked and clear — coverage rows FR-001..FR-020 done",
    "2. Findings (final) — none",
    "3. Remaining — coverage rows FR-021..FR-040",
    "4. Dead ends — none",
  ].join("\n");

  const tableS1 = [
    "coverage-review-tasks.md:",
    "| requirement | covering task id(s) or plan section | OK or GAP: reason |",
    "| --- | --- | --- |",
    "| FR-001 | T001 | OK |",
    "| FR-002 | T002 | OK |",
  ].join("\n");

  const tableS2Grew = [
    tableS1,
    "| FR-003 | T003 | GAP: missing tenant check |",
  ].join("\n");

  check("progress: table grew with new row -> true even if Checked and clear text unchanged",
    reviewSessionProgress(
      { reportText: tableS1, noteText: sameNote, workDigest: "read: tasks.md" },
      { reportText: tableS2Grew, noteText: sameNote, workDigest: "read: tasks.md" }
    ) === true);

  check("progress: identical table and identical Checked and clear -> false (even with new workDigest)",
    reviewSessionProgress(
      { reportText: tableS1, noteText: sameNote, workDigest: "read: tasks.md" },
      { reportText: tableS1, noteText: sameNote, workDigest: "read: tasks.md; read: spec.md" }
    ) === false);

  // Real readCarriedScratchReportText integration
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-b6-prog-"));
  try {
    const s1Dir = path.join(tmp, "speckit-plan_reviewer-scratch");
    const s2Dir = path.join(tmp, "s2", "speckit-plan_reviewer-scratch");
    fs.mkdirSync(s1Dir, { recursive: true });
    fs.mkdirSync(s2Dir, { recursive: true });
    fs.writeFileSync(path.join(s1Dir, "coverage-review-plan.md"), "| FR-001 | Scope 1 | OK |\n", "utf8");
    fs.writeFileSync(path.join(s2Dir, "coverage-review-plan.md"), "| FR-001 | Scope 1 | OK |\n| FR-002 | Scope 2 | GAP: missing |\n", "utf8");
    const r1 = readCarriedScratchReportText(s1Dir);
    const r2 = readCarriedScratchReportText(s2Dir);
    check("progress via readCarriedScratchReportText: coverage-review-plan.md growth -> true",
      reviewSessionProgress({ reportText: r1, noteText: sameNote }, { reportText: r2, noteText: sameNote }) === true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 5. caps.plan_reviewer.first_round_reasoning ─────────────────────────────
{
  const example = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  const schema = JSON.parse(fs.readFileSync(path.join(root, "config.schema.json"), "utf8"));
  check("DEFAULTS.caps.plan_reviewer omits optional first_round_reasoning (unset by default)",
    !("first_round_reasoning" in DEFAULTS.caps.plan_reviewer), DEFAULTS.caps.plan_reviewer);
  check("config.example.json has caps.plan_reviewer.first_round_reasoning: null",
    example.caps?.plan_reviewer?.first_round_reasoning === null, example.caps?.plan_reviewer);
  check("config.schema.json defines caps.plan_reviewer.first_round_reasoning",
    Boolean(schema.properties?.caps?.properties?.plan_reviewer?.properties?.first_round_reasoning),
    schema.properties?.caps?.properties?.plan_reviewer?.properties);

  // Absent/null by default -> no change
  const baseCfg = {
    roles: { plan_reviewer: { adapter: "codex", model: "gpt-5", reasoning: "low", variant: "" } },
    policy: { caps: { plan_reviewer: { max_turns: 30, max_tokens: 250000, extra_sessions: 4 } } },
  };
  check("resolveFirstRoundReasoning: null when unset",
    resolveFirstRoundReasoningForTests(baseCfg) === null);
  check("withFirstRoundReasoning: no change when unset",
    withFirstRoundReasoningForTests(baseCfg, true) === baseCfg);

  // Set -> applied ONLY on round 1
  const setCfg = {
    roles: { plan_reviewer: { adapter: "codex", model: "gpt-5", reasoning: "low", variant: "" } },
    policy: { caps: { plan_reviewer: { max_turns: 30, max_tokens: 250000, extra_sessions: 4, first_round_reasoning: "high" } } },
  };
  check("resolveFirstRoundReasoning: returns 'high' when set",
    resolveFirstRoundReasoningForTests(setCfg) === "high");
  const r1Cfg = withFirstRoundReasoningForTests(setCfg, true);
  const r2Cfg = withFirstRoundReasoningForTests(setCfg, false);
  check("withFirstRoundReasoning: applies 'high' on round 1",
    r1Cfg.roles.plan_reviewer.reasoning === "high", r1Cfg.roles.plan_reviewer);
  check("withFirstRoundReasoning: keeps 'low' on later rounds (round 2+)",
    r2Cfg.roles.plan_reviewer.reasoning === "low", r2Cfg.roles.plan_reviewer);

  // Layout round-trip + validation
  const layout = JSON.parse(JSON.stringify(example));
  layout.caps.plan_reviewer.first_round_reasoning = "high";
  const okValid = validateNewConfig(layout);
  check("validateNewConfig accepts string caps.plan_reviewer.first_round_reasoning",
    okValid.valid === true, okValid.errors);
  const rt = toRuntimeConfig(layout);
  check("toRuntimeConfig maps caps.plan_reviewer.first_round_reasoning -> policy.caps.plan_reviewer.first_round_reasoning",
    rt.policy?.caps?.plan_reviewer?.first_round_reasoning === "high", rt.policy?.caps?.plan_reviewer);
  const back = toNewLayoutConfig(rt);
  check("toNewLayoutConfig round-trips first_round_reasoning",
    back.caps?.plan_reviewer?.first_round_reasoning === "high", back.caps?.plan_reviewer);

  const badType = JSON.parse(JSON.stringify(example));
  badType.caps.plan_reviewer.first_round_reasoning = 42;
  const badRes = validateNewConfig(badType);
  check("validateNewConfig rejects non-string caps.plan_reviewer.first_round_reasoning",
    badRes.valid === false && badRes.errors.some((e) => e.includes("first_round_reasoning")), badRes.errors);
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll backlog #6 coverage-table tests passed.");
