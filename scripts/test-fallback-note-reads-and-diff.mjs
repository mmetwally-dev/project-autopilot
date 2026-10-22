#!/usr/bin/env node
// Backlog #15 part 3 — the orchestrator fallback note must decode bash file
// reads (not just read-tool calls) and show only what THIS session changed.
import {
  decodeBashFileReads, sessionEditPaths, buildOrchestratorFallbackNote,
} from "./per-task-budget.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reads = (command, root = "/repo") => decodeBashFileReads(command, root);

// ── (i) decodeBashFileReads: every supported form ──────────────────────────
check("decode: sed -n quoted range",
  eq(reads("sed -n '120,180p' scripts/a.mjs"), [{path: "scripts/a.mjs", from: 120, to: 180, wholeFile: false}]), reads("sed -n '120,180p' scripts/a.mjs"));
check("decode: sed -n unquoted range",
  eq(reads("sed -n 10,40p scripts/a.mjs"), [{path: "scripts/a.mjs", from: 10, to: 40, wholeFile: false}]), reads("sed -n 10,40p scripts/a.mjs"));
check("decode: sed -n double-quoted range",
  eq(reads('sed -n "5,9p" scripts/a.mjs'), [{path: "scripts/a.mjs", from: 5, to: 9, wholeFile: false}]), reads('sed -n "5,9p" scripts/a.mjs'));
check("decode: cat is a whole-file read",
  eq(reads("cat scripts/a.mjs"), [{path: "scripts/a.mjs", from: null, to: null, wholeFile: true}]), reads("cat scripts/a.mjs"));
check("decode: cat with several files reads them all",
  eq(reads("cat scripts/a.mjs scripts/b.mjs").map((r) => r.path), ["scripts/a.mjs", "scripts/b.mjs"]), reads("cat scripts/a.mjs scripts/b.mjs"));
check("decode: head -n N -> 1..N",
  eq(reads("head -n 50 scripts/a.mjs"), [{path: "scripts/a.mjs", from: 1, to: 50, wholeFile: false}]), reads("head -n 50 scripts/a.mjs"));
check("decode: head -N -> 1..N",
  eq(reads("head -50 scripts/a.mjs"), [{path: "scripts/a.mjs", from: 1, to: 50, wholeFile: false}]), reads("head -50 scripts/a.mjs"));
check("decode: head defaults to 10 lines",
  eq(reads("head scripts/a.mjs"), [{path: "scripts/a.mjs", from: 1, to: 10, wholeFile: false}]), reads("head scripts/a.mjs"));
check("decode: tail is a whole-file read (unknown start)",
  eq(reads("tail -n 20 scripts/a.mjs"), [{path: "scripts/a.mjs", from: null, to: null, wholeFile: true}]), reads("tail -n 20 scripts/a.mjs"));
check("decode: nl is a whole-file read",
  eq(reads("nl scripts/a.mjs"), [{path: "scripts/a.mjs", from: null, to: null, wholeFile: true}]), reads("nl scripts/a.mjs"));
check("decode: awk is a whole-file read",
  eq(reads("awk '{print $1}' scripts/a.mjs"), [{path: "scripts/a.mjs", from: null, to: null, wholeFile: true}]), reads("awk '{print $1}' scripts/a.mjs"));
check("decode: grep with one file records the file (no range)",
  eq(reads('grep -n "helper" scripts/a.mjs'), [{path: "scripts/a.mjs", from: null, to: null, wholeFile: false}]), reads('grep -n "helper" scripts/a.mjs'));
check("decode: grep -rn is ignored",
  eq(reads('grep -rn "helper" scripts'), []), reads('grep -rn "helper" scripts'));
check("decode: chained && / ; / | each decoded",
  eq(reads("sed -n '1,5p' scripts/a.mjs && cat scripts/b.mjs; head -n 3 scripts/c.mjs | grep -n x scripts/d.mjs").map((r) => r.path),
    ["scripts/a.mjs", "scripts/b.mjs", "scripts/c.mjs", "scripts/d.mjs"]),
  reads("sed -n '1,5p' scripts/a.mjs && cat scripts/b.mjs; head -n 3 scripts/c.mjs | grep -n x scripts/d.mjs"));
check("decode: cd <repo> && sed decodes the file",
  eq(reads("cd /repo && sed -n '10,40p' scripts/x.mjs"), [{path: "scripts/x.mjs", from: 10, to: 40, wholeFile: false}]), reads("cd /repo && sed -n '10,40p' scripts/x.mjs"));
check("decode: path outside the repo is ignored",
  eq(reads("cat /elsewhere/secret.mjs"), []), reads("cat /elsewhere/secret.mjs"));
check("decode: non-file-looking tokens are ignored",
  eq(reads("grep -n x TODO"), []), reads("grep -n x TODO"));
check("decode: garbage never throws",
  Array.isArray(decodeBashFileReads(null, null)) && eq(decodeBashFileReads(undefined), []));

// ── (ii) fallback note built from bash-only reads ──────────────────────────
const bash = (command) => ({type: "tool_use", part: {type: "tool_use", tool: "bash",
  state: {input: {command}, status: "completed", metadata: {exit: 0}}}});
const bashOnly = [
  bash("sed -n '120,180p' scripts/a.mjs"),
  bash("cat scripts/b.mjs"),
];
{
  const note = buildOrchestratorFallbackNote("T7", bashOnly, "opencode", "/repo", "");
  check("bash note: Largest read names a decoded file",
    /Largest read: scripts\/[ab]\.mjs/.test(note) && !note.includes("no decoded file reads"), note.slice(0, 500));
  check("bash note: read list carries the sed range",
    note.includes("read: ") && note.includes("scripts/a.mjs:120-180"), note);
  check("bash note: whole-file cat read is listed",
    note.includes("scripts/b.mjs"), note);
}
{
  // A whole-file read wins over ranges; adjacent ranges merge.
  const note = buildOrchestratorFallbackNote("T7b", [
    bash("sed -n '1,10p' scripts/c.mjs"),
    bash("sed -n '11,20p' scripts/c.mjs"),
    bash("cat scripts/c.mjs"),
  ], "opencode", "/repo", "");
  check("bash note: whole-file read wins over ranges",
    note.includes("read: scripts/c.mjs;") || /read: scripts\/c\.mjs(\n|$)/.test(note), note);
  check("bash note: merged ranges are shown without a whole-file override",
    buildOrchestratorFallbackNote("T7c", [
      bash("sed -n '1,10p' scripts/d.mjs"),
      bash("sed -n '11,20p' scripts/d.mjs"),
    ], "opencode", "/repo", "").includes("scripts/d.mjs:1-20"));
}

// ── (iii) no edits -> session-only changes section ─────────────────────────
const wholeWorktreeDiff = [
  " src/unrelated-one.mjs | 630 ++++++++++++++++++++++++++++-----",
  " src/unrelated-two.mjs |  12 ++++---",
  " 2 files changed, 500 insertions(+), 142 deletions(-)",
].join("\n");
{
  const noEdits = [bash("node scripts/test-all.mjs"), bash("git status --short")];
  const note = buildOrchestratorFallbackNote("T8", noEdits, "opencode", "/repo", wholeWorktreeDiff);
  check("no edits: note says the session changed nothing",
    note.includes("This session changed no files."), note.slice(0, 700));
  check("no edits: unrelated whole-worktree files are not shown",
    !note.includes("unrelated-one") && !note.includes("unrelated-two"), note);
  check("no edits: heading is the session-changes heading",
    note.includes("## Changes made in this session") && !note.includes("Worktree diff at cap"), note.slice(0, 400));
}

// ── (iv) one edited file -> only that file in the changes section ──────────
{
  const edit = (filePath) => ({type: "tool_use", part: {type: "tool_use", tool: "edit",
    state: {input: {filePath}, status: "completed"}}});
  const events = [edit("/repo/scripts/a.mjs")];
  check("edits: sessionEditPaths finds the edited file",
    eq(sessionEditPaths("opencode", events, "/repo"), ["scripts/a.mjs"]), sessionEditPaths("opencode", events, "/repo"));
  const diff = [
    " scripts/a.mjs | 4 ++++",
    " scripts/other.mjs | 9 +++++++--",
    " 2 files changed, 13 insertions(+), 2 deletions(-)",
  ].join("\n");
  const note = buildOrchestratorFallbackNote("T9", events, "opencode", "/repo", diff);
  check("edits: only the session's file appears in the changes section",
    note.includes("scripts/a.mjs | 4 ++++") && !note.includes("scripts/other.mjs"), note);
  check("edits: note does not claim nothing changed",
    !note.includes("This session changed no files."), note.slice(0, 400));
  check("edits: caller-supplied snapshot paths win over decoded events",
    buildOrchestratorFallbackNote("T10", [], "opencode", "/repo", " scripts/b.mjs | 2 ++", null, ["scripts/b.mjs"])
      .includes("scripts/b.mjs | 2 ++"));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
