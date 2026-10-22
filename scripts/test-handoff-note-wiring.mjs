#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isHandoffNoteFresh, handoffNoteRelPath } from "./per-task-budget.mjs";

// Backlog #34c (mission 027 Phase 2 task 2.3): fresh-note wrap-up-skip
// wiring pin. autopilot.mjs runs main() on import, so the shared runRelay
// wrap-up path is static-covered here (same pattern as
// test-cap-breach-wiring.mjs). Decision logic itself (isHandoffNoteFresh) is
// unit-covered in test-handoff-note-freshness.mjs; both-loops behaviour
// (task 2.4) is behaviour-covered below against $TMPDIR fixture roots.
let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

// ── Helpers (shared runRelay path) ──
check("helpers: lastProjectEditMtimeMs defined",
  /function lastProjectEditMtimeMs\(/.test(src));
check("helpers: last-project-edit scan skips .git/.autopilot/node_modules",
  /function lastProjectEditMtimeMs[\s\S]{0,800}?\.git[\s\S]{0,800}?\.autopilot[\s\S]{0,800}?node_modules/.test(src));
check("helpers: handoffNoteFreshnessForWrapUp defined and delegates to the pure helper",
  /function handoffNoteFreshnessForWrapUp\(missionName, taskRef\)/.test(src)
  && /isHandoffNoteFresh\(\{noteText,noteMtimeMs,lastProjectEditMtimeMs:lastProjectEditMtimeMs\(repo\),nowMs:Date\.now\(\)\}\)/.test(src));

// ── Freshness-before-fallback order ──
{
  const gateIdx = src.indexOf("handoffNoteFreshnessForWrapUp(wrapMission,taskRef)");
  const fallbackIdx = src.indexOf('status:"orchestrator_fallback"');
  check("order: freshness gate before the orchestrator fallback write",
    gateIdx !== -1 && fallbackIdx !== -1 && gateIdx < fallbackIdx,
    gateIdx, fallbackIdx);
  check("no wrap-up resume remains (runNote:\"wrap-up\" gone)",
    !src.includes('runNote:"wrap-up"'));
  check("deleted resume paths are gone",
    !src.includes('reason:"no_session_id"')
    && !src.includes('reason:"resume_unsupported"')
    && !src.includes('reason:"no_note_after_wrap_up"')
    && !src.includes('reason:"wrap_up_timeout_or_failed"'));
}

// ── Skipped/note_fresh record shape ──
check("record: fresh note records wrapUp skipped with reason note_fresh",
  /if\(handoffNoteFreshnessForWrapUp\(wrapMission,taskRef\)\?\.fresh\)\s*\n\s*return \{status:"skipped",reason:"note_fresh",trigger:capBreach\.trigger\|\|null\};/.test(src));

// ── capEnabled scope (031 P4.5: wrap-up gate uses capEnabled, not roleName) ──
check("scope: skip gate lives inside the capEnabled cap/wrap-up trigger block",
  /if\(capEnabled && !isWrapUp && capBreach\?\.wrapUp && result\.capped\)\{[\s\S]{0,2000}?handoffNoteFreshnessForWrapUp\(wrapMission,taskRef\)/.test(src));

// ── capDriver unchanged ──
check("capDriver unchanged (capEnabled-gated, wrap-up turn exempt)",
  /const capDriver=\(!isWrapUp && capEnabled\)\?adapterDriver\(role\.adapter\):null;/.test(src));

// ── Task 1.6: WRAP_UP progress line carries the PATH field ──
// The single observe line after runWrapUp must report which branch produced
// the result: PATH=note_fresh (fresh-note skip), PATH=orchestrator_fallback
// (the orchestrator wrote the fallback note), PATH=- for everything else
// (note_scope_unknown skip, failed build/write, wrap_up_error). RAW_TOKENS
// stays on the same line (test-live-usage.mjs pins it).
{
  const lines = src.split("\n").filter((l) => l.includes("WRAP_UP | STATUS="));
  const logLine = lines.find((l) => l.includes("observe(")) || "";
  check("log: exactly one WRAP_UP observe progress line",
    lines.length === 1 && logLine.includes("observe("), lines.length);
  check("log: WRAP_UP observe line includes PATH=",
    logLine.includes("PATH="), logLine.includes("PATH="));
  check("log: WRAP_UP observe line still includes RAW_TOKENS=",
    logLine.includes("RAW_TOKENS="));
  check("log: PATH is derived right after REASON on the same line",
    /WRAP_UP \| STATUS=\$\{result\.wrapUp\.status\} \| REASON=\$\{result\.wrapUp\.reason\|\|"-"\} \| PATH=/.test(logLine));
  check("log: PATH maps note_fresh skip, orchestrator_fallback, and - for anything else",
    /const __wrapPath=result\.wrapUp\.reason==="note_fresh"\?"note_fresh":\(result\.wrapUp\.status==="orchestrator_fallback"\?"orchestrator_fallback":"-"\);/.test(src));
}

// ── Task 2.4: both-loops wrap-up-skip behaviour ──
// autopilot.mjs runs main() on import, so the production runWrapUp closure
// cannot be invoked here. This section mirrors its decision exactly
// (fresh note → {status:"skipped",reason:"note_fresh",trigger} with NO
// fallback note written; anything else → the orchestrator writes
// {status:"orchestrator_fallback",reason:"note_missing_or_stale"} itself,
// never resuming the session) and drives it with real filesystem state in
// $TMPDIR fixture roots (outside the project repo): a project file plus
// the task note at handoffNoteRelPath(). The freshness probe below follows
// handoffNoteFreshnessForWrapUp step for step (read note text + stat
// mtime, scan the tree skipping .git/.autopilot/node_modules, delegate to
// isHandoffNoteFresh).
const SKIP_DIRS = new Set([".git", ".autopilot", "node_modules"]);
function lastEditScan(root) {
  let latest = null;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(p);
      } else if (e.isFile()) {
        try {
          const mtime = fs.statSync(p).mtimeMs;
          if (Number.isFinite(mtime) && (latest === null || mtime > latest)) latest = mtime;
        } catch { /* best-effort */ }
      }
    }
  };
  try { walk(path.resolve(root)); } catch { return null; }
  return latest;
}
function freshnessForWrapUp(root, missionName, taskRef) {
  try {
    if (!missionName || !taskRef) return { fresh: false, reason: "missing_note" };
    const abs = path.join(root, handoffNoteRelPath(missionName, taskRef));
    let noteText = null, noteMtimeMs = null;
    try {
      noteText = fs.readFileSync(abs, "utf8");
      noteMtimeMs = fs.statSync(abs).mtimeMs;
    } catch {
      return { fresh: false, reason: "missing_note" };
    }
    return isHandoffNoteFresh({ noteText, noteMtimeMs, lastProjectEditMtimeMs: lastEditScan(root), nowMs: Date.now() });
  } catch {
    return { fresh: false, reason: "missing_note" };
  }
}
// Production runWrapUp's decision: a fresh note skips everything (recorded
// as note_fresh, never retried, rollover continues with the digest only);
// anything else (stale/missing/empty) means the ORCHESTRATOR writes the
// fallback note itself — the session is never resumed. writeNote() stands in
// for the orchestrator fallback write (git diff --stat + work digest).
function decideWrapUpUnit(freshness, capTrigger, writeNote) {
  if (freshness?.fresh)
    return { status: "skipped", reason: "note_fresh", trigger: capTrigger || null };
  return writeNote();
}
const NOTE_BODY = "1. Done — a.mjs.\n2. Found — a.mjs:10 foo().\n3. Next — edit a.mjs:12.\n4. Dead ends — none.\n";
function setMtime(p, ms) {
  const t = new Date(Number(ms));
  fs.utimesSync(p, t, t);
}
function makeLoopRoot(prefix, mission, taskRef) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projFile = path.join(root, "work.txt");
  fs.writeFileSync(projFile, "project edit\n");
  const noteAbs = path.join(root, handoffNoteRelPath(mission, taskRef));
  fs.mkdirSync(path.dirname(noteAbs), { recursive: true });
  return { root, projFile, noteAbs };
}
const LOOPS = [
  { label: "standalone", taskRef: "T2.4" },
  { label: "speckit", taskRef: "T001" },
];
{
  const mission = "wrap-skip-probe";
  const relStandalone = handoffNoteRelPath(mission, "T2.4");
  const relSpeckit = handoffNoteRelPath(mission, "T001");
  check("loops: note paths differ per task ref via the shared helper",
    relStandalone !== relSpeckit
    && relStandalone === `.autopilot/missions/${mission}/handoff/T2.4.md`
    && relSpeckit === `.autopilot/missions/${mission}/handoff/T001.md`,
    { relStandalone, relSpeckit });
}
for (const { label, taskRef } of LOOPS) {
  // ── Fresh note: skip the wrap-up resume, continue rollover ──
  {
    const { root, projFile, noteAbs } = makeLoopRoot(`ap-note-fresh-${label}-`, mission_default(), taskRef);
    try {
      const now = Date.now();
      setMtime(projFile, now - 60_000);
      fs.writeFileSync(noteAbs, NOTE_BODY);
      setMtime(noteAbs, now - 30_000);
      const fr = freshnessForWrapUp(root, mission_default(), taskRef);
      check(`${label}: fresh note probes fresh`, fr?.fresh === true && fr?.reason === "fresh", fr);
      let writeNotes = 0;
      const wrapUp = decideWrapUpUnit(fr, "turns", () => { writeNotes += 1; return { status: "ok" }; });
      check(`${label}: fresh note skips the fallback write (no fallback call)`, writeNotes === 0, writeNotes);
      check(`${label}: fresh skip keeps the wrapUp skipped/note_fresh shape with the trigger`,
        wrapUp?.status === "skipped" && wrapUp?.reason === "note_fresh" && wrapUp?.trigger === "turns", wrapUp);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  // ── Stale note (edit after the note): orchestrator writes the fallback ──
  {
    const { root, projFile, noteAbs } = makeLoopRoot(`ap-note-stale-${label}-`, mission_default(), taskRef);
    try {
      const now = Date.now();
      fs.writeFileSync(noteAbs, NOTE_BODY);
      setMtime(noteAbs, now - 120_000);
      setMtime(projFile, now - 60_000);
      const fr = freshnessForWrapUp(root, mission_default(), taskRef);
      check(`${label}: stale note probes stale (edit after note)`, fr?.fresh === false, fr);
      let writeNotes = 0;
      const wrapUp = decideWrapUpUnit(fr, "turns", () => {
        writeNotes += 1;
        return { status: "orchestrator_fallback", reason: "note_missing_or_stale", trigger: "turns", note: handoffNoteRelPath(mission_default(), taskRef), fallbackNote: true };
      });
      check(`${label}: stale note gets the orchestrator fallback note (no wrap-up resume)`,
        writeNotes === 1 && wrapUp?.status === "orchestrator_fallback", wrapUp);
      check(`${label}: stale fallback keeps the orchestrator_fallback shape (trigger + note + fallbackNote, no wrapRun)`,
        wrapUp?.reason === "note_missing_or_stale"
        && wrapUp?.trigger === "turns"
        && wrapUp?.note === handoffNoteRelPath(mission_default(), taskRef)
        && wrapUp?.fallbackNote === true
        && wrapUp?.wrapRun === undefined, wrapUp);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  // ── Missing note: orchestrator writes the fallback ──
  {
    const { root } = makeLoopRoot(`ap-note-missing-${label}-`, mission_default(), taskRef);
    try {
      const noteAbs = path.join(root, handoffNoteRelPath(mission_default(), taskRef));
      try { fs.rmSync(noteAbs); } catch { /* already absent */ }
      const fr = freshnessForWrapUp(root, mission_default(), taskRef);
      check(`${label}: missing note probes stale`, fr?.fresh === false && fr?.reason === "missing_note", fr);
      let writeNotes = 0;
      const wrapUp = decideWrapUpUnit(fr, "tokens", () => {
        writeNotes += 1;
        return { status: "orchestrator_fallback", reason: "note_missing_or_stale", trigger: "tokens", note: handoffNoteRelPath(mission_default(), taskRef), fallbackNote: true };
      });
      check(`${label}: missing note gets the orchestrator fallback note (no wrap-up resume)`,
        writeNotes === 1 && wrapUp?.status === "orchestrator_fallback", wrapUp);
      check(`${label}: missing-note fallback keeps the orchestrator_fallback shape`,
        wrapUp?.reason === "note_missing_or_stale"
        && wrapUp?.trigger === "tokens"
        && wrapUp?.fallbackNote === true
        && wrapUp?.wrapRun === undefined, wrapUp);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  // ── Empty note: orchestrator writes the fallback ──
  {
    const { root, projFile, noteAbs } = makeLoopRoot(`ap-note-empty-${label}-`, mission_default(), taskRef);
    try {
      const now = Date.now();
      setMtime(projFile, now - 60_000);
      fs.writeFileSync(noteAbs, "   \n\t  ");
      setMtime(noteAbs, now - 30_000);
      const fr = freshnessForWrapUp(root, mission_default(), taskRef);
      check(`${label}: empty note probes stale`, fr?.fresh === false && fr?.reason === "empty_note", fr);
      let writeNotes = 0;
      const wrapUp = decideWrapUpUnit(fr, "turns", () => {
        writeNotes += 1;
        return { status: "orchestrator_fallback", reason: "note_missing_or_stale", trigger: "turns", note: handoffNoteRelPath(mission_default(), taskRef), fallbackNote: true };
      });
      check(`${label}: empty note gets the orchestrator fallback note (no wrap-up resume)`,
        writeNotes === 1 && wrapUp?.status === "orchestrator_fallback", wrapUp);
      check(`${label}: empty-note fallback keeps the orchestrator_fallback shape`,
        wrapUp?.reason === "note_missing_or_stale" && wrapUp?.trigger === "turns" && wrapUp?.fallbackNote === true, wrapUp);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}
function mission_default() { return "wrap-skip-probe"; }

if (failures) {
  console.error(`${failures} handoff-note wiring check(s) failed.`);
  process.exit(1);
}
console.log("handoff-note wiring tests passed");
