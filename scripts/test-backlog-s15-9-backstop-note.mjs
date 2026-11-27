import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isHandoffNoteFresh,
  appendReviewBackstopFallbackSection,
  reviewSessionProgress,
  REVIEW_FALLBACK_SECTION_HEADING,
} from "./per-task-budget.mjs";
import { handleCodeReviewerUnchangedNoteForTests } from "./autopilot.mjs";

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

// 1. Freshness check with minMtimeMs: session 1's note (08:02) is NOT fresh
// during session 2 (started 08:02:10) even when no repo edits occurred.
const tSession1Note = Date.parse("2026-11-22T08:02:00Z");
const tSession2Start = Date.parse("2026-11-22T08:02:10Z");
const tSession2End = Date.parse("2026-11-22T08:05:30Z");
const tLastRepoEdit = Date.parse("2026-11-22T07:55:00Z");

const freshWithoutMin = isHandoffNoteFresh({
  noteText: "1. Checked and clear\n- apps/web/src/app/page.tsx:1-40",
  noteMtimeMs: tSession1Note,
  lastProjectEditMtimeMs: tLastRepoEdit,
  nowMs: tSession2End,
});
check("without minMtimeMs, session 1 note looks fresh (explaining the run 411 bug)", freshWithoutMin.fresh === true, freshWithoutMin);

const freshWithMin = isHandoffNoteFresh({
  noteText: "1. Checked and clear\n- apps/web/src/app/page.tsx:1-40",
  noteMtimeMs: tSession1Note,
  lastProjectEditMtimeMs: tLastRepoEdit,
  nowMs: tSession2End,
  minMtimeMs: tSession2Start,
});
check("with minMtimeMs=sessionStart, session 1 note is NOT fresh for session 2",
  freshWithMin.fresh === false && freshWithMin.reason === "note_older_than_session", freshWithMin);

const freshWrittenInSession2 = isHandoffNoteFresh({
  noteText: "1. Checked and clear\n- apps/web/src/app/page.tsx:1-40",
  noteMtimeMs: tSession2Start + 5000,
  lastProjectEditMtimeMs: tLastRepoEdit,
  nowMs: tSession2End,
  minMtimeMs: tSession2Start,
});
check("note written during session 2 IS fresh", freshWrittenInSession2.fresh === true, freshWrittenInSession2);

// 2. Backstop-cut review session appends an orchestrator fallback section with
// files read, commands run, and last message while preserving session 1's note
const session1Note = [
  "# Handoff Note — final-review-speckit (session 1)",
  "",
  "1. Checked and clear",
  "- apps/web/src/app/login/page.tsx:1-120",
  "",
  "2. Findings (final)",
  "- none",
  "",
  "3. Remaining",
  "- spec FRs, UI messages, admin tenants",
  "",
  "4. Dead ends",
  "- none",
].join("\n");

const session2Events = [
  {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "apps/web/src/messages/ar.json" } },
        { type: "tool_use", name: "Read", input: { file_path: "apps/web/src/app/[locale]/admin/tenants/page.tsx" } },
        { type: "tool_use", name: "Bash", input: { command: "rg -n 'FR-012' specs/008/spec.md" } },
        { type: "text", text: "Verified Arabic messages and admin tenants page against FR-012; moving to provisioning route next." },
      ],
    },
  },
];

const updatedNote = appendReviewBackstopFallbackSection(session1Note, {
  taskRef: "final-review-speckit",
  events: session2Events,
  adapterId: "claude",
  repoRoot: "/repo",
  capBreach: { type: "backstop", used: 6025557, limit: 6000000, backstop: true },
  lastMessage: "",
  maxChars: 8000,
});

check("updated note preserves session 1 Checked and clear content",
  updatedNote.includes("apps/web/src/app/login/page.tsx:1-120"), updatedNote);
check("updated note appends Orchestrator fallback section header with backstop info",
  updatedNote.includes(`${REVIEW_FALLBACK_SECTION_HEADING} (session cut: backstop 6025557/6000000)`), updatedNote);
check("updated note lists newly read files",
  updatedNote.includes("apps/web/src/messages/ar.json") && updatedNote.includes("apps/web/src/app/[locale]/admin/tenants/page.tsx"), updatedNote);
check("updated note lists commands run",
  updatedNote.includes("rg -n 'FR-012' specs/008/spec.md"), updatedNote);
check("updated note includes last message excerpt",
  updatedNote.includes("Verified Arabic messages and admin tenants page against FR-012"), updatedNote);

// 3. No-progress rule sees growth when fallback section adds new files/commands
const grew = reviewSessionProgress(
  { noteText: session1Note, reportText: "" },
  { noteText: updatedNote, reportText: "" },
);
check("reviewSessionProgress sees growth from backstop fallback section", grew === true, grew);

// 4. No-progress rule returns false when a backstop fallback section adds NO new files or commands
const emptyFallbackNote = appendReviewBackstopFallbackSection(session1Note, {
  taskRef: "final-review-speckit",
  events: [],
  adapterId: "claude",
  repoRoot: "/repo",
  capBreach: { type: "backstop", used: 6050000, limit: 6000000, backstop: true },
  lastMessage: "Still thinking.",
  maxChars: 8000,
});
const noGrowth = reviewSessionProgress(
  { noteText: session1Note, reportText: "" },
  { noteText: emptyFallbackNote, reportText: "" },
);
check("reviewSessionProgress returns false when fallback section has no new files/commands", noGrowth === false, noGrowth);

// 5. handleCodeReviewerUnchangedNote resets streak / does not escalate when fallback section shows growth
const state = { mission: "m-008" };
let escalated = false;
handleCodeReviewerUnchangedNoteForTests({
  s: state,
  rv: { capped: { type: "backstop", used: 6025557, limit: 6000000, backstop: true } },
  prevNote: session1Note,
  nextNote: updatedNote,
  contScope: "final:speckit",
  subject: "Final review (speckit)",
  step: "final_review_not_converging",
  fatal: () => { escalated = true; },
});
check("handleCodeReviewerUnchangedNote accepts backstop progress without escalating",
  escalated === false && state.codeReviewUnchangedNoteStreak["final:speckit"] === 1,
  { escalated, streak: state.codeReviewUnchangedNoteStreak });

// 6. Wiring check in scripts/autopilot.mjs (both loops share runRelay wrap-up)
const autopilotSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
check("runRelay wrap-up uses reviewMinMtimeMs for review roles",
  autopilotSrc.includes("const reviewMinMtimeMs=isReviewHandoffRole(roleName)?sessionStartedAtMs:null;"));
check("runRelay wrap-up calls appendReviewBackstopFallbackSection on backstop-cut review roles",
  autopilotSrc.includes("const isBackstopReviewCut=isReviewHandoffRole(roleName)") && autopilotSrc.includes("appendReviewBackstopFallbackSection(previousNoteText"));

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} check(s) failed`);
