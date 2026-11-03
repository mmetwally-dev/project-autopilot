#!/usr/bin/env node
// Test for Task #5: Antigravity (agy) sessionWorkDigest, sessionEditPaths,
// and buildOrchestratorFallbackNote changes section.
import {
  sessionWorkDigest,
  sessionEditPaths,
  buildOrchestratorFallbackNote,
} from "./per-task-budget.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) {
    console.log(`PASS ${name}`);
    ok += 1;
    return;
  }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

const CID = "test-session-generic-001";

// Synthetic agy stream-json events
const syntheticAgyEvents = [
  {
    event: "step_update",
    step_update: {
      conversation_id: CID,
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "read_file",
      tool_info: {
        name: "read_file",
        parameters: {Path: "docs/spec.md"},
        output: "line 1\nline 2\n",
      },
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: CID,
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "replace_file_content",
      tool_info: {
        name: "replace_file_content",
        parameters: {TargetFile: ".work/tasks.md"},
        output: "replaced",
      },
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: CID,
      step_index: 3,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: {CommandLine: "wc -l docs/spec.md"},
        output: "2 docs/spec.md\n",
      },
    },
  },
];

// ── 1. sessionWorkDigest decodes agy events ────────────────────────────────
const digest = sessionWorkDigest("antigravity", syntheticAgyEvents, {repoRoot: "/repo"});
check("digest: names the read file", digest.includes("read: docs/spec.md"), digest);
check("digest: names the edited file", digest.includes("edited: .work/tasks.md"), digest);
check("digest: names the command", digest.includes("ran: wc -l docs/spec.md (ok)"), digest);
check("digest: does not contain no-vocabulary prose", !digest.includes("no decoded event vocabulary"), digest);

// Check "agy" alias
const digestAgy = sessionWorkDigest("agy", syntheticAgyEvents, {repoRoot: "/repo"});
check("digest (agy alias): names the read file", digestAgy.includes("read: docs/spec.md"), digestAgy);
check("digest (agy alias): names the edited file", digestAgy.includes("edited: .work/tasks.md"), digestAgy);
check("digest (agy alias): names the command", digestAgy.includes("ran: wc -l docs/spec.md (ok)"), digestAgy);

// ── 2. sessionEditPaths finds edited file ──────────────────────────────────
const editPaths = sessionEditPaths("antigravity", syntheticAgyEvents, "/repo");
check("sessionEditPaths: finds .work/tasks.md", editPaths.includes(".work/tasks.md") && editPaths.length === 1, editPaths);

// ── 3. buildOrchestratorFallbackNote with untracked/git-ignored file ───────
const fallbackNote = buildOrchestratorFallbackNote(
  "T001",
  syntheticAgyEvents,
  "antigravity",
  "/repo",
  "", // git diff --stat was empty because .work/tasks.md is untracked/ignored
  null,
  [] // sessionPaths empty (git sees no changes)
);

check("fallback: names .work/tasks.md as edited (not tracked by git)",
  fallbackNote.includes(".work/tasks.md (edited — not tracked by git)"), fallbackNote);
check("fallback: does not claim session changed no files",
  !fallbackNote.includes("This session changed no files."), fallbackNote);
check("fallback: does not have no-vocabulary prose",
  !fallbackNote.includes("this adapter exposes no decoded event vocabulary"), fallbackNote);
check("fallback: contains read in session work digest",
  fallbackNote.includes("read: docs/spec.md"), fallbackNote);
check("fallback: contains command in session work digest",
  fallbackNote.includes("ran: wc -l docs/spec.md (ok)"), fallbackNote);

// ── 4. ERROR steps handling ────────────────────────────────────────────────
const mixedEvents = [
  ...syntheticAgyEvents,
  {
    event: "step_update",
    step_update: {
      conversation_id: CID,
      step_index: 4,
      state: "ACTIVE", // ACTIVE step should be ignored
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: {CommandLine: "git status"},
      },
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: CID,
      step_index: 5,
      state: "ERROR",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: {CommandLine: "false"},
        error: {type: "tool_error", message: "exit 1"},
      },
    },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: CID,
      step_index: 6,
      state: "ERROR",
      step_type: "tool",
      tool_name: "write_to_file",
      tool_info: {
        name: "write_to_file",
        parameters: {TargetFile: "bad.txt"},
        error: {type: "tool_error", message: "disk full"},
      },
    },
  },
];

const mixedDigest = sessionWorkDigest("antigravity", mixedEvents, {repoRoot: "/repo"});
check("mixed digest: failed command listed with (failed)", mixedDigest.includes("false (failed)"), mixedDigest);
check("mixed digest: active command git status not listed", !mixedDigest.includes("git status"), mixedDigest);
check("mixed digest: failed write not listed in edits", !mixedDigest.includes("bad.txt"), mixedDigest);

const mixedEditPaths = sessionEditPaths("antigravity", mixedEvents, "/repo");
check("mixed editPaths: failed write not in edit paths", !mixedEditPaths.includes("bad.txt"), mixedEditPaths);

// ── 5. Preserving other adapters ───────────────────────────────────────────
check("unknown adapter codex yields empty digest", sessionWorkDigest("codex", syntheticAgyEvents) === "");
const codexNote = buildOrchestratorFallbackNote("T002", syntheticAgyEvents, "codex", "/repo", "", null, []);
check("codex note keeps no decoded event vocabulary",
  codexNote.includes("(none: this adapter exposes no decoded event vocabulary)"), codexNote);

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
