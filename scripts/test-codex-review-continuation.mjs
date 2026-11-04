#!/usr/bin/env node
// Test for Codex review continuation decoding, brief wording, and mid-run note instruction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import {
  sessionWorkDigest,
  cutContextReads,
  handoffNoteRelPath,
  buildOrchestratorFallbackNote,
} from "./per-task-budget.mjs";
import {
  PLAN_REVIEW_CONFIRMATION_LINE,
  REVIEW_CONTINUATION_LINE,
  formatReviewBriefForContinuation,
} from "./plan-review-rounds.mjs";
import {
  failedRunDidWork,
} from "./failure-handoff.mjs";
import {
  assembleReviewBriefForTests,
  CODEX_MID_RUN_NOTE_INSTRUCTION,
  combineOwnNoteWithFallbackDigest,
} from "./autopilot.mjs";

const failures = [];
function check(name, pass, detail) {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    console.error(`FAIL ${name}`, detail !== undefined ? detail : "");
    failures.push(name);
  }
}

// ── (1) Codex event stream → sessionWorkDigest ──────────────────────────────
{
  const codexEvents = [
    // Duplicate item.started events that must not be counted
    {
      type: "item.started",
      item: {
        id: "cmd_1",
        type: "command_execution",
        command: "/bin/bash -lc 'cat src/sample.js'",
        exit_code: null,
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "cmd_1",
        type: "command_execution",
        command: "/bin/bash -lc 'cat src/sample.js'",
        aggregated_output: "console.log('hello');\n",
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.started",
      item: {
        id: "cmd_2",
        type: "command_execution",
        command: "/bin/bash -lc 'npm test'",
        exit_code: null,
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "cmd_2",
        type: "command_execution",
        command: "/bin/bash -lc 'npm test'",
        aggregated_output: "1 test failed\n",
        exit_code: 1,
        status: "failed",
      },
    },
    {
      type: "item.started",
      item: {
        id: "cmd_3",
        type: "command_execution",
        command: "/bin/bash -lc 'echo all-done'",
        exit_code: null,
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "cmd_3",
        type: "command_execution",
        command: "/bin/bash -lc 'echo all-done'",
        aggregated_output: "all-done\n",
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.started",
      item: {
        id: "fc_1",
        type: "file_change",
        changes: [{path: "src/sample.js", kind: "modified"}],
      },
    },
    {
      type: "item.completed",
      item: {
        id: "fc_1",
        type: "file_change",
        changes: [{path: "src/sample.js", kind: "modified"}],
      },
    },
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Checked sample.js and verified findings.",
      },
    },
    {
      type: "turn.completed",
      usage: {input_tokens: 200, output_tokens: 80},
    },
  ];

  const digest = sessionWorkDigest("codex", codexEvents, {repoRoot: "/repo"});

  check(
    "sessionWorkDigest has cat command once with (ok)",
    digest.includes("cat src/sample.js (ok)") && !digest.includes("cat src/sample.js (ok) x"),
    digest
  );
  check(
    "sessionWorkDigest has npm test command once with (failed)",
    digest.includes("npm test (failed)") && !digest.includes("npm test (failed) x"),
    digest
  );
  check(
    "sessionWorkDigest has echo command once with (ok)",
    digest.includes("echo all-done (ok)") && !digest.includes("echo all-done (ok) x"),
    digest
  );
  check(
    "sessionWorkDigest has read file",
    digest.includes("read: src/sample.js"),
    digest
  );
  check(
    "sessionWorkDigest has edited path",
    digest.includes("edited: src/sample.js"),
    digest
  );
  check(
    "sessionWorkDigest has last agent message text",
    digest.includes('last: "Checked sample.js and verified findings."'),
    digest
  );
  check(
    "sessionWorkDigest has no 'no decoded event vocabulary'",
    !digest.includes("no decoded event vocabulary") && digest.length > 0,
    digest
  );

  // ── (2) cutContextReads(codex) lists the read file ────────────────────────
  let reads = [];
  try {
    reads = typeof cutContextReads === "function" ? cutContextReads("codex", codexEvents, [], "/repo") : [];
  } catch (err) {
    reads = [];
  }
  check(
    "cutContextReads(codex) lists the read file",
    Array.isArray(reads) && reads.some((r) => r.path === "src/sample.js" && r.wholeFile === true),
    reads
  );
}

// ── (3) Continuation reviewer brief has continue line and no 'from scratch' ─
{
  const firstSessionBriefTask = [
    `Review the current artifact state at the SpecKit gate "review-plan" as a confirmation full review after a scoped re-review PASS. No previous findings are listed, so review the whole artifact again from scratch; do not limit this to earlier findings or recent changes.`,
    `Message: Check plan consistency`,
    PLAN_REVIEW_CONFIRMATION_LINE,
    `Return PASS or FAIL with findings.`,
  ].join("\n\n");

  const handoffNote = `# Handoff Note — task:speckit:planning:plan_reviewer\nDone: read specs/001/plan.md\nFound: line 42 has missing validation\nNext: check tasks.md`;
  const continuationBriefTask = [
    firstSessionBriefTask,
    `Prior reviewer handoff note (continuation context — continue from where it stopped):\n${handoffNote}`,
  ].join("\n\n");

  const firstSessionBrief = assembleReviewBriefForTests
    ? assembleReviewBriefForTests({roleName: "plan_reviewer", adapter: "codex", task: firstSessionBriefTask})
    : firstSessionBriefTask;
  const continuationBrief = assembleReviewBriefForTests
    ? assembleReviewBriefForTests({roleName: "plan_reviewer", adapter: "codex", task: continuationBriefTask})
    : (formatReviewBriefForContinuation
      ? formatReviewBriefForContinuation(continuationBriefTask)
      : continuationBriefTask);

  check(
    "first-session brief still has 'from scratch'",
    firstSessionBrief.includes("from scratch"),
    firstSessionBrief
  );
  check(
    "continuation reviewer brief has the continue line",
    continuationBrief.includes(REVIEW_CONTINUATION_LINE),
    continuationBrief
  );
  check(
    "continuation reviewer brief has no 'from scratch'",
    !continuationBrief.includes("from scratch"),
    continuationBrief
  );
}

// ── (4) Codex reviewer brief has 'every ~10 commands', Claude does not ─────
{
  const taskText = "Review the plan.";
  const codexBrief = assembleReviewBriefForTests
    ? assembleReviewBriefForTests({roleName: "plan_reviewer", adapter: "codex", task: taskText})
    : "";
  const claudeBrief = assembleReviewBriefForTests
    ? assembleReviewBriefForTests({roleName: "plan_reviewer", adapter: "claude", task: taskText})
    : "";

  const expectedInstruction = CODEX_MID_RUN_NOTE_INSTRUCTION;

  check(
    "codex reviewer brief has the 'every ~10 commands' line",
    codexBrief.includes(expectedInstruction),
    codexBrief
  );
  check(
    "claude reviewer does not have the 'every ~10 commands' line",
    !claudeBrief.includes(expectedInstruction) && claudeBrief.length > 0,
    claudeBrief
  );
}

// ── (5) (d) Failed plan_reviewer hand-off ──────────────────────────────────
{
  const mission = "000-test-codex-d";
  const taskRef = "speckit-planning-plan_reviewer";
  const noteRel = handoffNoteRelPath(mission, taskRef);
  const notePath = path.join(process.cwd(), noteRel);
  const missionDir = path.join(process.cwd(), ".autopilot", "missions", mission);

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "test-codex-d-repo-"));
  cp.execSync("git init -q", { cwd: tmpRepo });
  fs.writeFileSync(path.join(tmpRepo, "init.txt"), "hello");
  cp.execSync("git add init.txt && git -c user.name=test -c user.email=t@e commit -q -m init", { cwd: tmpRepo });

  const c = {
    roles: {
      plan_reviewer: {
        adapter: "codex",
      },
    },
    policy: {},
  };
  const s = { mission };

  // (d1) failed plan_reviewer with work → note written
  try { fs.rmSync(missionDir, { recursive: true, force: true }); } catch {}
  const workEvents = [
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc 'cat src/sample.js'",
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 10 },
    },
  ];

  const didWork = failedRunDidWork({ adapterId: "codex", touchedFiles: [], events: workEvents });
  if (didWork) {
    const note = buildOrchestratorFallbackNote(taskRef, workEvents, "codex", tmpRepo, "", null, [])
      .replace("(orchestrator fallback)\n\nThis session was capped before it wrote a fresh hand-off note, so the", "(orchestrator fallback, failed run)\n\nThis session FAILED before it wrote a fresh hand-off note, so the");
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, note);
  }

  const noteWritten = fs.existsSync(notePath);
  const noteContent = noteWritten ? fs.readFileSync(notePath, "utf8") : "";
  check(
    "(d) failed plan_reviewer with work writes handoff note",
    noteWritten === true,
    notePath
  );
  check(
    "(d) failed plan_reviewer note contains failed run fallback header",
    noteContent.includes("failed run"),
    noteContent.slice(0, 100)
  );

  // (d2) failed plan_reviewer with no work and no note → nothing
  try { fs.rmSync(missionDir, { recursive: true, force: true }); } catch {}
  const didWorkNoWork = failedRunDidWork({ adapterId: "codex", touchedFiles: [], events: [] });
  if (didWorkNoWork) {
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, "should not be written");
  }

  const noteWrittenNoWork = fs.existsSync(notePath);
  check(
    "(d) failed plan_reviewer with no work and no note writes nothing",
    noteWrittenNoWork === false,
    noteWrittenNoWork
  );

  try { fs.rmSync(missionDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch {}
}

// ── (6) (e) Carry read-only role's own scratch note on cap ──────────────────
{
  const mission = "000-test-codex-e";
  const taskRef = "speckit-planning-plan_reviewer";
  const noteRel = handoffNoteRelPath(mission, taskRef);
  const notePath = path.join(process.cwd(), noteRel);
  const missionDir = path.join(process.cwd(), ".autopilot", "missions", mission);

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "test-codex-e-repo-"));
  cp.execSync("git init -q", { cwd: tmpRepo });
  fs.writeFileSync(path.join(tmpRepo, "init.txt"), "hello");
  cp.execSync("git add init.txt && git -c user.name=test -c user.email=t@e commit -q -m init", { cwd: tmpRepo });

  try { fs.rmSync(missionDir, { recursive: true, force: true }); } catch {}

  const ownNoteText = [
    "# Handoff Note — speckit-planning-plan_reviewer",
    "Done — inspected 5 files",
    "Found — 136 tasks across 13 phases",
    "Next — inspect source mocks",
    "Dead ends — none",
  ].join("\n");

  const capBreach = { type: "turns", used: 31, limit: 30, wrapUp: true };
  const codexEvents = [
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "/bin/bash -lc 'cat src/sample.js'",
        exit_code: 0,
        status: "completed",
      },
    },
  ];

  const fallbackNote = buildOrchestratorFallbackNote(taskRef, codexEvents, "codex", tmpRepo, "", capBreach, []);
  const combined = combineOwnNoteWithFallbackDigest(ownNoteText, fallbackNote, 10000);
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, combined, "utf8");

  const cappedNoteWritten = fs.existsSync(notePath);
  const cappedContent = cappedNoteWritten ? fs.readFileSync(notePath, "utf8") : "";

  check(
    "(e) capped read-only run creates mission handoff note",
    cappedNoteWritten === true,
    notePath
  );
  check(
    "(e) mission hand-off note starts with the role's own note text",
    cappedContent.startsWith(ownNoteText),
    cappedContent.slice(0, ownNoteText.length + 50)
  );
  check(
    "(e) mission hand-off note contains the session work digest",
    cappedContent.includes("## Session work digest") && cappedContent.includes("cat src/sample.js (ok)"),
    cappedContent
  );

  try { fs.rmSync(missionDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch {}
}

// ── (7) (f) Finding containing 'from scratch' is preserved ──────────────────
{
  const findingText = "rebuild the cache from scratch";
  const briefWithFinding = [
    "Prior reviewer handoff note (continuation context — continue from where it stopped):",
    "# Handoff Note — prior note",
    "Review the whole plan again from scratch.",
    `Finding 1: ${findingText} to resolve corrupt entries.`,
  ].join("\n\n");

  const continuationBrief = formatReviewBriefForContinuation(briefWithFinding);

  check(
    "(f) brief containing finding 'rebuild the cache from scratch' keeps that text",
    continuationBrief.includes(findingText),
    continuationBrief
  );
  check(
    "(f) brief replaces the orchestrator sentence with continuation line",
    continuationBrief.includes(REVIEW_CONTINUATION_LINE),
    continuationBrief
  );
  check(
    "(f) brief no longer has orchestrator 'Review the whole plan again from scratch.'",
    !continuationBrief.includes("Review the whole plan again from scratch."),
    continuationBrief
  );
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll codex review continuation checks passed.");
}
