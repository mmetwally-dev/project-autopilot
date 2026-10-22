import path from "node:path";
import {buildSecurityChecklistSection} from "./security-checklist.mjs";
import {scopedDeltaBeginMarker, SCOPED_DELTA_END_MARKER} from "./implementation-baseline.mjs";
import {taskLabel} from "./finding-task-locality.mjs";
import {formatLinkedTestDurations, formatHeavySuiteNoParallelNote, formatRedGateVerdictRule} from "./verifier-brief.mjs";

// Task 4: shared standalone handoff builder + prompt-size guard.
// Centralizes the four hand-built review/verify prompts in
// runStandaloneImplementation so every role gets the same phase identity,
// task scope, implementer report, and delta markers. Requirements stay
// OUTSIDE the builder by design: callers feed them through the relay
// `requirements` channel (role-requirements.mjs), never as handoff text.
// Never launches a role, never reads git; pure text assembly over caller
// supplied chunks. Fail-closed: invalid budgets throw, truncation is always
// announced inside the markers, impossible fits throw HANDOFF_TOO_LARGE.

export const PHASE_DELTA_BUDGET = 60000;
export const PHASE_HANDOFF_BUDGET = 70000;
export const MISSION_DELTA_BUDGET = 80000;
export const MISSION_HANDOFF_BUDGET = 95000;
export const SUMMARY_MAX_CHARS = 2000;
export const DECLARED_LINE_MAX_CHARS = 500;

const KINDS = ["PHASE_REVIEW", "PHASE_VERIFY", "MISSION_FINAL", "PHASE_REREVIEW"];

const PHASE_SCOPE_PROSE = "Scoped implementation delta for THIS PHASE only (pre-existing repository changes made before this mission started, and changes from earlier phases, are excluded — do not evaluate or flag anything outside this delta; an empty delta means this phase made no repository changes):";
const REREVIEW_SCOPE_PROSE = "Changes since your last review (everything the fix changed — review ONLY this diff for new problems or regressions):";
const MISSION_SCOPE_PROSE = "Scoped implementation delta for THIS ENTIRE MISSION (pre-existing repository changes made before this mission started are excluded — do not evaluate or flag anything outside this delta; an empty delta means this mission made no repository changes):";
const WORKTREE_INSTRUCTION = "Read the omitted files from the worktree with ranged reads (offset/limit) before deciding; do not treat the absence of their diffs as absence of changes.";
const EMPTY_DELTA_PLACEHOLDER = "(empty — no repository changes in scope)";
const EMPTY_FIX_PLACEHOLDER = "The fix changed no files.";
const EOL_DIFF_GUIDANCE = "If a git diff shows whole-file churn, re-run it EOL-normalized (git diff --ignore-cr-at-eol or git -c core.autocrlf=input diff) and trust the normalized stat.";

// Mission 067 task 1.1: single definition of the whole-mission-diff
// reviewer line for the MISSION_FINAL security section. Defined here and
// reused by both the standalone assembly below and the SpecKit
// mission-final prompts in autopilot.mjs (imported, never duplicated).
export const MISSION_FINAL_SECURITY_LINE = "Apply the security checklist to the whole mission diff above.";

// Mission 031 phase 8 task 8.2: efficiency/evidence instruction block for
// code_reviewer (PHASE_REVIEW) and verifier (PHASE_VERIFY) briefs. Kept as
// one exported constant so the text stays verbatim in both handoffs and the
// enrichment test asserts against this exact string. Pure text — never
// reads the filesystem.
export const REVIEW_EFFICIENCY_INSTRUCTIONS = "read only the ranges you need; re-run the implementer evidence command before writing a new probe; a PASS must list what could not be verified";

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    const e = new Error(`${name} must be a positive integer`);
    e.code = "INVALID_HANDOFF_BUDGET"; throw e;
  }
}

function tooLarge(message) {
  const e = new Error(message);
  e.code = "HANDOFF_TOO_LARGE"; throw e;
}

// Builder-owned sanitization: one rule for every call site. Collapses
// whitespace, strips control characters, caps TOTAL length at
// SUMMARY_MAX_CHARS inclusive of the truncation marker.
const SUMMARY_TRUNCATION_MARKER = "… [truncated]";
export function sanitizeSummary(raw) {
  let text = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  text = text.split("\n").map(l => l.replace(/[ \t]+/g, " ").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > SUMMARY_MAX_CHARS) text = `${text.slice(0, SUMMARY_MAX_CHARS - SUMMARY_TRUNCATION_MARKER.length).trimEnd()}${SUMMARY_TRUNCATION_MARKER}`;
  return text;
}

function declaredLine(declaredPaths) {
  const paths = [...new Set((declaredPaths || []).filter(Boolean))].sort();
  if (!paths.length) return "Declared deliverables (0): none";
  let line = `Declared deliverables (${paths.length}): ${paths.join(", ")}`;
  if (line.length > DECLARED_LINE_MAX_CHARS) {
    let shown = [];
    for (const p of paths) {
      const candidate = shown.length ? `${shown.join(", ")}, ${p}` : p;
      if (`Declared deliverables (${paths.length}): ${candidate}`.length > DECLARED_LINE_MAX_CHARS - 12) break;
      shown.push(p);
    }
    const more = paths.length - shown.length;
    line = more > 0
      ? `Declared deliverables (${paths.length}): ${shown.join(", ")}… +${more} more`
      : `Declared deliverables (${paths.length}): ${shown.join(", ")}`;
  }
  return line;
}

// Task lines shown to a reviewer/verifier, each prefixed with its 1-based
// label `[T<n>]`. The label is intentionally 1-based while the stable task ID's
// `T` segment is 0-based (a reviewer reads "T1" as "first"): taskLabel() is the
// ONLY place that offset exists, and position i here is `phaseTaskIds[i]`.
function taskScopeLines(phaseTasks) {
  return (phaseTasks || []).map((t, i) => `- [${taskLabel(i)}] ${t.text} (${t.file}:${t.line})`).join("\n");
}

function diffLineCounts(text) {
  let added = 0;
  let removed = 0;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function buildNotice(kept, dropped) {
  const omittedChars = dropped.reduce((n, c) => n + c.text.length + 1, 0);
  const omittedList = dropped.map(c => {
    const { added, removed } = diffLineCounts(c.text);
    return `${c.path} (+${added}/−${removed})`;
  }).join(", ");
  const lines = [
    `TRUNCATED: omitted ${dropped.length} file diff(s) (~${omittedChars} chars); included ${kept.length} file diff(s) (reviewed ${kept.length} of ${kept.length + dropped.length} chunks).`,
    `Omitted files: ${omittedList}`,
    WORKTREE_INSTRUCTION,
  ];
  return {notice: lines.join("\n"), omittedChars};
}

function scopeProse(kind) {
  if (kind === "MISSION_FINAL") return MISSION_SCOPE_PROSE;
  if (kind === "PHASE_REREVIEW") return REREVIEW_SCOPE_PROSE;
  return PHASE_SCOPE_PROSE;
}

function markerScope(kind) {
  if (kind === "MISSION_FINAL") return "MISSION";
  if (kind === "PHASE_REREVIEW") return "FIX";
  return "PHASE";
}

// TASK-23: one line naming every file the phase changed so far (paths only,
// no diffs), so a re-reviewer knows the context the fix diff sits in.
function changedFilesLine(changedFiles) {
  const files = [...new Set((changedFiles || []).filter(Boolean))].sort();
  return files.length
    ? `Changed files in this phase so far: ${files.join(", ")}`
    : "Changed files in this phase so far: none";
}

// Mission 025 phase 4 task 4.1: per-linked-verify duration history reader.
// The live gateResult.results entries are the primary duration source; the
// persisted gate history (state.json s.gateDurations, {command: durationMs},
// written by gates() in autopilot.mjs) is the fallback for entries whose
// durationMs is missing. Returns {command: durationMs} covering live results
// first, then history-only commands. Pure read — never throws on odd input.
export function resolveGateDurations(gateResult, gateHistory) {
  const out = {};
  const results = Array.isArray(gateResult?.results) ? gateResult.results : [];
  for (const r of results) {
    if (!r || typeof r.command !== "string" || !r.command) continue;
    const d = typeof r.durationMs === "string" && r.durationMs.trim() !== "" ? Number(r.durationMs) : r.durationMs;
    if (typeof d === "number" && Number.isFinite(d) && d >= 0) out[r.command] = d;
  }
  if (gateHistory && typeof gateHistory === "object" && !Array.isArray(gateHistory)) {
    for (const [command, value] of Object.entries(gateHistory)) {
      if (typeof command !== "string" || !command || Object.hasOwn(out, command)) continue;
      const d = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof d === "number" && Number.isFinite(d) && d >= 0) out[command] = d;
    }
  }
  if (gateResult && typeof gateResult.command === "string" && !Object.hasOwn(out, gateResult.command)) {
    const d = typeof gateResult.durationMs === "string" && String(gateResult.durationMs).trim() !== "" ? Number(gateResult.durationMs) : gateResult.durationMs;
    if (typeof d === "number" && Number.isFinite(d) && d >= 0) out[gateResult.command] = d;
  }
  return out;
}

// Backfill a gate result's missing per-command durationMs from the
// persisted history so the brief always has a per-test duration source.
// Entries that already carry a finite durationMs are untouched; a result
// with no entries at all ({ok:true}) stays empty so the brief stays
// byte-identical when no gate ran.
function gateResultWithHistory(gateResult, gateHistory) {
  if (!gateResult || typeof gateResult !== "object") return gateResult;
  if (!gateHistory || typeof gateHistory !== "object" || Array.isArray(gateHistory)) return gateResult;
  const fill = (command, durationMs) => {
    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) return durationMs;
    if (typeof command !== "string" || !command) return durationMs ?? null;
    const h = typeof gateHistory[command] === "string" && gateHistory[command].trim() !== "" ? Number(gateHistory[command]) : gateHistory[command];
    return (typeof h === "number" && Number.isFinite(h) && h >= 0) ? h : (durationMs ?? null);
  };
  if (Array.isArray(gateResult.results) && gateResult.results.length) {
    let changed = false;
    const results = gateResult.results.map((r) => {
      if (!r || typeof r !== "object") return r;
      const filled = fill(r.command, r.durationMs);
      if (filled !== r.durationMs) { changed = true; return {...r, durationMs: filled}; }
      return r;
    });
    if (!changed) return gateResult;
    const top = (typeof gateResult.durationMs === "number" && Number.isFinite(gateResult.durationMs) && gateResult.durationMs >= 0)
      ? gateResult.durationMs
      : fill(gateResult.command, gateResult.durationMs);
    return {...gateResult, durationMs: top ?? gateResult.durationMs, results};
  }
  return gateResult;
}
export function formatGateResult(gateResult) {
  const results = Array.isArray(gateResult?.results) && gateResult.results.length
    ? gateResult.results
    : (gateResult && typeof gateResult.command === "string"
      ? [{command: gateResult.command, ok: !!gateResult.ok, exitCode: gateResult.exitCode ?? null, durationMs: gateResult.durationMs ?? null, logFile: gateResult.logFile ?? null, tail: gateResult.tail ?? ""}]
      : []);
  if (!results.length) return "";
  const lines = [
    "Gate result (the full configured gate already ran; this is its recorded output — do not re-run it):",
    ...results.map((r) => `- ${r.ok ? "PASS" : "FAIL"} ${r.command} — exit ${r.exitCode ?? "?"}, ${r.durationMs ?? "?"} ms, log: ${r.logFile ?? "(none)"}`),
  ];
  const failed = results.find((r) => !r.ok);
  const shown = failed ?? results[results.length - 1];
  if (failed) lines.push(`Failing command: ${failed.command}`);
  lines.push("Output tail:");
  lines.push(shown.tail && String(shown.tail).trim() ? String(shown.tail) : "(no output)");
  lines.push("");
  if (failed) {
    lines.push(`Instructions: the full suite has already run as the phase gate. Do not re-run the whole suite; re-run a single test only if a specific claim is in doubt. ${formatRedGateVerdictRule(gateResult)}`);
  } else {
    lines.push("Instructions: the full suite has already run as the phase gate. Do not re-run the whole suite; re-run a single test only if a specific claim is in doubt. On gate FAIL, analyse the provided output and name the cause.");
  }
  return lines.join("\n");
}

// Mission 031 phase 8 task 8.1: absolute-path section for code_reviewer
// and verifier briefs. Lists the mission PLAN.md, the mission TASKS.md,
// and every task's file:line so a reviewer/verifier in a fresh sandbox
// session can open the exact files without guessing paths. Resolution
// order: explicit missionDir wins, then explicit planPath/tasksPath, then
// the dirname of the first absolute task file (production phase tasks
// already carry the absolute TASKS.md path). Returns "" when nothing is
// resolvable so older callers without path context still get a brief.
// Pure text assembly — never reads the filesystem.
export function absolutePathsSection({missionDir, planPath, tasksPath, phaseTasks} = {}) {
  let planAbs = typeof planPath === "string" && planPath ? planPath : null;
  let tasksAbs = typeof tasksPath === "string" && tasksPath ? tasksPath : null;
  let dir = typeof missionDir === "string" && missionDir ? missionDir : null;
  if (!dir && (planAbs || tasksAbs)) dir = path.dirname(planAbs ?? tasksAbs);
  if (!dir && Array.isArray(phaseTasks)) {
    const first = phaseTasks.find((t) => t && typeof t.file === "string" && t.file && path.isAbsolute(t.file));
    if (first) dir = path.dirname(first.file);
  }
  if (!planAbs && dir) planAbs = path.join(dir, "PLAN.md");
  if (!tasksAbs && dir) tasksAbs = path.join(dir, "TASKS.md");
  if (!planAbs && !tasksAbs) return "";
  const lines = ["ABSOLUTE PATHS:"];
  if (planAbs) lines.push(`- ${planAbs}`);
  if (tasksAbs) lines.push(`- ${tasksAbs}`);
  const seen = new Set(lines);
  for (const t of (Array.isArray(phaseTasks) ? phaseTasks : [])) {
    if (!t || typeof t.file !== "string" || !t.file) continue;
    const entry = `- ${t.file}${Number.isInteger(t.line) ? `:${t.line}` : ""}`;
    if (seen.has(entry)) continue;
    seen.add(entry);
    lines.push(entry);
  }
  return lines.join("\n");
}

// Mission 063 task 1.3: operator-edit section for phase-delta rebase.
// Formats the `operatorPhaseEdits` record (array of
// {files, note, at, expectedDeltaDigest, observedDeltaDigest}) as
// informational reviewer text. Display-only: the header carries no review
// instruction and never changes scope. A record with no file
// list (the rebase default) still renders as a note + time +
// old->new digest line so it is included in the brief and then cleared.
// Returns "" when the record is absent or not an array — callers rely on
// that for byte-identical output when there are no operator edits. Pure
// text assembly — never reads the filesystem, never throws on odd input.
export function formatOperatorPhaseEdits(operatorPhaseEdits) {
  if (!Array.isArray(operatorPhaseEdits) || !operatorPhaseEdits.length) return "";
  const lines = [];
  const seen = new Set();
  const pushUnique = (line) => {
    if (!line || seen.has(line)) return;
    seen.add(line);
    lines.push(line);
  };
  for (const record of operatorPhaseEdits) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const files = Array.isArray(record.files) ? record.files.filter((f) => typeof f === "string" && f) : [];
    const note = typeof record.note === "string" && record.note.trim() ? ` — ${record.note.trim()}` : "";
    const at = typeof record.at === "string" && record.at ? ` (${record.at})` : "";
    if (files.length) {
      for (const f of [...new Set(files)].sort()) {
        pushUnique(`- ${f}${at}${note}`);
      }
      continue;
    }
    const expected = typeof record.expectedDeltaDigest === "string" && record.expectedDeltaDigest ? record.expectedDeltaDigest : "";
    const observed = typeof record.observedDeltaDigest === "string" && record.observedDeltaDigest ? record.observedDeltaDigest : "";
    const digests = [expected, observed].filter(Boolean).join(" -> ");
    pushUnique(`- (no file list recorded)${at}${note}${digests ? ` ${digests}` : ""}`.trimEnd());
  }
  if (!lines.length) return "";
  return [
    "Operator edits (informational — operator-acknowledged changes recorded by `ap rebase`):",
    ...lines,
  ].join("\n");
}

function assemble({kind, phaseName, phaseIndex, phaseTotal, phaseTasks, attempt, summary, declaredPaths, planPath, tasksPath, pathsSection, deltaBody, changedFiles, gateSection, durationsSection, noParallelSection, securitySection, operatorEditsSection}) {
  const parts = [];
  if (kind === "MISSION_FINAL") {
    parts.push(`Final repository review against standalone plan ${planPath} and tasks ${tasksPath}.`);
    parts.push("");
    if (pathsSection) parts.push(pathsSection, "");
    parts.push(declaredLine(declaredPaths));
    if (summary) parts.push(`\nImplementer report (untrusted — verify against the delta):\n${summary}`);
    parts.push("");
    if (gateSection) parts.push(gateSection, "");
    if (durationsSection) parts.push(durationsSection, "");
    // Mission 025 phase 4 task 4.3: the heavy-suite no-parallel rule rides
    // every brief unconditionally (all kinds) — the formatter is always
    // non-empty, so no `if` guard can silently drop it.
    if (noParallelSection) parts.push(noParallelSection, "");
    // Mission 063 task 1.3: operator edits ride every brief when recorded
    // (all kinds) — part of the fitted assembly so the joint budget loop
    // accounts for their bytes. Absent/empty renders nothing.
    if (operatorEditsSection) parts.push(operatorEditsSection, "");
    // Mission 067 task 1.1: security checklist rides the MISSION_FINAL
    // brief verbatim plus the shared whole-mission-diff reviewer line.
    // Phase kinds are untouched (handled in the non-final path below).
    if (securitySection) parts.push(`${securitySection}\n${MISSION_FINAL_SECURITY_LINE}`, "");
    parts.push(scopeProse(kind));
    parts.push(EOL_DIFF_GUIDANCE);
    parts.push(`${scopedDeltaBeginMarker(markerScope(kind))}\n${deltaBody}\n${SCOPED_DELTA_END_MARKER}`);
    return parts.join("\n");
  }
  const header = kind === "PHASE_VERIFY"
    ? (gateSection
      ? "Verify this phase after implementation and code review. The full test suite already ran as the phase gate; review the recorded gate result below — do not re-run it."
      : "Verify this phase after implementation and code review. Run the full test suite yourself end-to-end; do not rely solely on the implementer's or code_reviewer's report.")
    : kind === "PHASE_REREVIEW"
    ? "Re-review after a fix. Your previous findings are listed under FEEDBACK TO ADDRESS. For each one, confirm it is fixed or still stands. Then review ONLY the changes below — they are everything that changed since your last review — for new problems or regressions. Code outside these changes was already reviewed; do not re-review it, but you may read any file for context."
    : "Review the whole phase (all tasks together) — not task by task. Verify contested claims by reading the diff; only re-run a specific test if a claim about it is in doubt — the full suite re-run is the Verifier's job, not yours.";
  parts.push(header);
  parts.push(`Phase: ${phaseName}`);
  parts.push(`Progress: phase ${phaseIndex + 1}/${phaseTotal}; attempt ${attempt}`);
  parts.push("");
  parts.push("Tasks:");
  parts.push(taskScopeLines(phaseTasks));
  parts.push("");
  parts.push(declaredLine(declaredPaths));
  if (pathsSection) parts.push("", pathsSection);
  if (summary) parts.push(`\nImplementer report (untrusted — verify against the delta):\n${summary}`);
  parts.push("");
  if (kind === "PHASE_REREVIEW") parts.push(changedFilesLine(changedFiles));
  if (gateSection) parts.push(gateSection, "");
  if (durationsSection) parts.push(durationsSection, "");
  if (noParallelSection) parts.push(noParallelSection, "");
  // Mission 031 phase 8 task 8.2: efficiency/evidence instructions ride
  // the code_reviewer (PHASE_REVIEW) and verifier (PHASE_VERIFY) briefs
  // only — re-reviews and the mission-final review keep their own scope
  // prose without this block.
  if (kind === "PHASE_REVIEW" || kind === "PHASE_VERIFY") {
    parts.push(`Instructions: ${REVIEW_EFFICIENCY_INSTRUCTIONS}.`);
  }
  // Mission 066 task 1.2: security checklist rides the code_reviewer
  // (PHASE_REVIEW) and re-reviewer (PHASE_REREVIEW) briefs verbatim —
  // helper output only, no added prose, so the helper's length budget
  // covers the whole inserted section.
  if ((kind === "PHASE_REVIEW" || kind === "PHASE_REREVIEW") && securitySection) parts.push(securitySection, "");
  // Mission 063 task 1.3: operator edits render just before the scoped
  // delta so the reviewer sees them as distinct from mission work. Part of
  // the fitted assembly so the joint budget loop accounts for their bytes.
  if (operatorEditsSection) parts.push(operatorEditsSection, "");
  parts.push(scopeProse(kind));
  parts.push(EOL_DIFF_GUIDANCE);
  parts.push(`${scopedDeltaBeginMarker(markerScope(kind))}\n${deltaBody}\n${SCOPED_DELTA_END_MARKER}`);
  return parts.join("\n");
}

// TASK-12: delta-only twin of the builder's chunk fit, for loops that keep
// their own prompt prose (SpecKit). Same budgets, same dropped-chunk notice,
// same meta shape (so truncationWarning applies). Empty delta -> "" body.
export function boundedDeltaBody(chunks, {kind = "PHASE_REVIEW", baselineKey, maxDeltaChars} = {}) {
  const max = maxDeltaChars ?? (kind === "MISSION_FINAL" ? MISSION_DELTA_BUDGET : PHASE_DELTA_BUDGET);
  assertPositiveInt(max, "maxDeltaChars");
  const all = Array.isArray(chunks) ? chunks : [];
  const originalChars = all.map(c => c.text).join("\n").length;
  for (let keep = all.length; keep >= 0; keep--) {
    const kept = all.slice(0, keep);
    const dropped = all.slice(keep);
    const keptText = kept.map(c => c.text).join("\n");
    const body = dropped.length
      ? `${keptText ? `${keptText}\n` : ""}${buildNotice(kept, dropped).notice}`
      : keptText;
    if (body.length > max) continue;
    return {
      body,
      meta: {
        kind, truncated: dropped.length > 0, originalChars, emittedChars: body.length,
        includedFiles: kept.map(c => c.path), omittedFiles: dropped.map(c => c.path),
        includedChunks: kept.length, omittedChunks: dropped.length, baselineKey,
      },
    };
  }
  throw tooLarge(`HANDOFF_TOO_LARGE: delta notice alone exceeds maxDeltaChars=${max} for baseline ${baselineKey}`);
}

export function buildStandaloneHandoff(opts = {}) {
  const kind = opts.kind;
  if (!KINDS.includes(kind)) {
    const e = new Error(`Unknown handoff kind: ${kind}`);
    e.code = "INVALID_HANDOFF_KIND"; throw e;
  }
  if ("requirements" in opts) {
    const e = new Error("buildStandaloneHandoff does not accept requirements: feed them through the relay requirements channel instead");
    e.code = "INVALID_HANDOFF_REQUIREMENTS"; throw e;
  }
  const maxDeltaChars = opts.maxDeltaChars ?? (kind === "MISSION_FINAL" ? MISSION_DELTA_BUDGET : PHASE_DELTA_BUDGET);
  const maxHandoffChars = opts.maxHandoffChars ?? (kind === "MISSION_FINAL" ? MISSION_HANDOFF_BUDGET : PHASE_HANDOFF_BUDGET);
  assertPositiveInt(maxDeltaChars, "maxDeltaChars");
  assertPositiveInt(maxHandoffChars, "maxHandoffChars");

  const baselineKey = opts.baselineKey;
  if (typeof baselineKey !== "string" || !baselineKey) {
    const e = new Error("buildStandaloneHandoff requires a non-empty baselineKey");
    e.code = "INVALID_HANDOFF_BASELINE"; throw e;
  }
  if (kind === "MISSION_FINAL") {
    if (typeof opts.planPath !== "string" || !opts.planPath || typeof opts.tasksPath !== "string" || !opts.tasksPath) {
      const e = new Error("MISSION_FINAL handoff requires planPath and tasksPath");
      e.code = "INVALID_HANDOFF_PATHS"; throw e;
    }
  } else {
    if (typeof opts.phaseName !== "string" || !opts.phaseName) {
      const e = new Error(`${kind} handoff requires phaseName`);
      e.code = "INVALID_HANDOFF_PHASE"; throw e;
    }
    if (!Number.isInteger(opts.phaseIndex) || opts.phaseIndex < 0 || !Number.isInteger(opts.phaseTotal) || opts.phaseTotal <= 0) {
      const e = new Error(`${kind} handoff requires phaseIndex >= 0 and phaseTotal > 0`);
      e.code = "INVALID_HANDOFF_PHASE"; throw e;
    }
    if (!Array.isArray(opts.phaseTasks) || !opts.phaseTasks.length) {
      const e = new Error(`${kind} handoff requires a non-empty phaseTasks array`);
      e.code = "INVALID_HANDOFF_TASKS"; throw e;
    }
    if (!Number.isInteger(opts.attempt) || opts.attempt <= 0) {
      const e = new Error(`${kind} handoff requires attempt >= 1`);
      e.code = "INVALID_HANDOFF_ATTEMPT"; throw e;
    }
  }

  const summary = sanitizeSummary(opts.implementationSummary);
  const chunks = Array.isArray(opts.deltaChunks) ? opts.deltaChunks : [];
  const originalChars = chunks.map(c => c.text).join("\n").length;
  const gateSection = formatGateResult(gateResultWithHistory(opts.gateResult, opts.gateHistory));
  // Mission 025 phase 4 task 4.2: per-linked-test duration lines for the
  // reviewer (no fresh gate result — history only) and the verifier (live
  // result over history). Empty when the caller passes no linked commands.
  const durationsSection = formatLinkedTestDurations(opts.linkedVerifyCommands, resolveGateDurations(opts.gateResult, opts.gateHistory));
  // Mission 025 phase 4 task 4.3: heavy-suite no-parallel rule for every
  // reviewer/verifier brief (all kinds) — always non-empty by construction.
  const noParallelSection = formatHeavySuiteNoParallelNote();

  // Mission 066 task 1.2: security checklist for the code_reviewer
  // (PHASE_REVIEW) and re-reviewer (PHASE_REREVIEW) briefs, plus mission
  // 067 task 1.1: the MISSION_FINAL brief. Explicit repoRoot only —
  // absent/unreadable yields the generic section, never throws. Computed
  // once outside the joint-fit loop so its bytes count toward
  // maxHandoffChars. PHASE_VERIFY stays excluded so its brief is unchanged.
  const securitySection = (kind === "PHASE_REVIEW" || kind === "PHASE_REREVIEW" || kind === "MISSION_FINAL")
    ? buildSecurityChecklistSection(opts.repoRoot)
    : "";
  // Mission 063 task 1.3: recorded operator phase edits (`ap rebase`)
  // ride every brief when present. Computed once outside the joint-fit
  // loop and passed into the fitted assembly so the section counts toward
  // maxHandoffChars. "" when absent/empty keeps output byte-identical.
  const operatorEditsSection = formatOperatorPhaseEdits(opts.operatorPhaseEdits);
  // Mission 031 phase 8 task 8.1: absolute paths for PLAN.md, TASKS.md,
  // and every task file:line ride every brief whose paths resolve
  // (code_reviewer kinds PHASE_REVIEW/PHASE_REREVIEW and verifier kind
  // PHASE_VERIFY via missionDir or the task-file fallback; MISSION_FINAL
  // via its required planPath/tasksPath). Part of the fitted assembly so
  // the joint budget loop accounts for its bytes.
  const pathsSection = absolutePathsSection({
    missionDir: opts.missionDir,
    planPath: opts.planPath,
    tasksPath: opts.tasksPath,
    phaseTasks: opts.phaseTasks,
  });
  // Joint fit: drop trailing chunks until the delta body (kept chunks plus
  // the recomputed notice) fits maxDeltaChars AND the assembled text fits
  // maxHandoffChars. The notice is part of every truncated candidate, so its
  // space is always reserved — never appended after the fact.
  for (let keep = chunks.length; keep >= 0; keep--) {
    const kept = chunks.slice(0, keep);
    const dropped = chunks.slice(keep);
    const keptText = kept.map(c => c.text).join("\n");
    let body;
    if (!dropped.length) {
      // TASK-23: an empty fix diff still sends the re-review — the reviewer
      // judges whether the findings still stand. Never skip the review.
      body = keptText || (kind === "PHASE_REREVIEW" ? EMPTY_FIX_PLACEHOLDER : EMPTY_DELTA_PLACEHOLDER);
    } else {
      const {notice} = buildNotice(kept, dropped);
      body = `${keptText ? `${keptText}\n` : ""}${notice}`;
    }
    if (body.length > maxDeltaChars) continue;
    const full = assemble({
      kind,
      phaseName: opts.phaseName,
      phaseIndex: opts.phaseIndex,
      phaseTotal: opts.phaseTotal,
      phaseTasks: opts.phaseTasks,
      attempt: opts.attempt,
      declaredPaths: opts.declaredPaths,
      planPath: opts.planPath,
      tasksPath: opts.tasksPath,
      pathsSection,
      summary,
      deltaBody: body,
      changedFiles: opts.changedFiles,
      gateSection,
      durationsSection,
      noParallelSection,
      securitySection,
      operatorEditsSection,
    });
    if (full.length <= maxHandoffChars) {
      return {
        text: full,
        meta: {
          kind,
          truncated: dropped.length > 0,
          originalChars,
          emittedChars: full.length,
          includedFiles: kept.map(c => c.path),
          omittedFiles: dropped.map(c => c.path),
          includedChunks: kept.length,
          omittedChunks: dropped.length,
          baselineKey,
        },
      };
    }
  }
  throw tooLarge(`HANDOFF_TOO_LARGE: headers alone exceed maxHandoffChars=${maxHandoffChars} for baseline ${baselineKey}`);
}

// Concise caller-side warning; call sites must log it when meta.truncated.
// originalChars and emittedChars are different dimensions (raw delta input
// vs assembled handoff output), so each is labeled — never compare them.
export function truncationWarning(meta) {
  return `Scoped delta truncated for baseline ${meta.baselineKey}: ${meta.includedChunks} chunk(s) kept / ${meta.omittedChunks} omitted, delta ${meta.originalChars} chars -> handoff ${meta.emittedChars} chars.`;
}

// Backlog #39: the review run's result must say when the reviewer saw only
// part of the phase delta. Null for a complete handoff.
export function reviewTruncationResult(meta) {
  if (!meta || meta.truncated !== true) return null;
  const kept = Number(meta.includedChunks) || 0;
  const omitted = Number(meta.omittedChunks) || 0;
  return {
    deltaTruncated: {kept, omitted},
    reviewedChunks: `reviewed ${kept} of ${kept + omitted} chunks`,
  };
}

// Mission 031 phase 3 task 3.1 / phase 7 task 7.2: role-aware review
// wrap-up prompt for cap-boundary handoff notes. Code review roles
// (code_reviewer, verifier) track progress via Found-section growth over
// code file:line ranges; plan_reviewer tracks the same way over PLAN.md
// sections / TASKS.md numeric IDs; the planner tracks PLAN.md/TASKS.md
// tracks PLAN.md/TASKS.md changes. Every template carries a Found section
// (already checked + result) and a Next section (left to check /
// unfinished items) so a resumed session knows what is done and what
// remains. Pure text assembly — never launches a role, never reads git.
const REVIEW_WRAPUP_ROLES = ["code_reviewer", "verifier", "plan_reviewer", "planner"];

export function buildReviewWrapUpPrompt(role, context = {}) {
  if (!REVIEW_WRAPUP_ROLES.includes(role)) {
    const e = new Error(`Unknown review wrap-up role: ${role}`);
    e.code = "INVALID_REVIEW_ROLE"; throw e;
  }
  const ctx = (context && typeof context === "object") ? context : {};
  const priorNote = typeof ctx.priorNote === "string" && ctx.priorNote.trim()
    ? `\nPrior handoff note (build on it — do not duplicate Found entries):\n${ctx.priorNote.trim()}\n`
    : "";
  const scopeLine = ctx.taskRef || ctx.phaseName
    ? `Scope: ${[ctx.phaseName, ctx.taskRef].filter(Boolean).join(" / ")}\n`
    : "";
  const notePathLine = ctx.notePath ? `Write the note to: ${ctx.notePath}\n` : "";
  if (role === "plan_reviewer") {
    return [
      `You hit a cap boundary as plan_reviewer. Write a wrap-up handoff note so the resumed session continues the plan review without re-checking what you already covered.`,
      scopeLine + notePathLine,
      "## Found (plan sections/tasks already checked + result)",
      "- List one bullet per PLAN.md section / TASKS.md task already checked, each with its result (e.g. `- TASKS.md 2.3 — checked task sizing, result: ok`).",
      "- Cite TASKS.md items by numeric ID exactly as written in the file; cite PLAN.md by numbered list item or section heading.",
      "Progress signal: Found section growth — the resumed session must add new Found entries, never rewrite existing ones.",
      "",
      "## Next (plan sections/tasks left to check)",
      "- List every plan section/task left to check (TASKS.md numeric ID or PLAN.md section + what to verify).",
      "- If nothing remains, write `(none)` on its own line.",
      priorNote,
      "Keep the note short and factual; no prose outside these sections.",
    ].filter(Boolean).join("\n");
  }
  if (role === "planner") {
    return [
      `You hit a cap boundary as planner. Write a wrap-up handoff note so the resumed session continues planning without redoing work.`,
      scopeLine + notePathLine,
      "## Found (PLAN.md/TASKS.md change tracking + decisions already made)",
      "- List each PLAN.md / TASKS.md change you made (section + one-line result).",
      "- Already checked + result: every planning decision already taken with its outcome.",
      "- Found — code facts: exact file:line, function names, how the code works there, what the request needs changed.",
      "Progress signal: PLAN.md/TASKS.md change + Next section — the resumed session must show new PLAN/TASKS changes or a shrinking Next section.",
      "",
      "## Next (unfinished items)",
      "- List every unfinished planning item (left to decide / left to write).",
      "- If nothing remains, write `(none)` on its own line.",
      priorNote,
      "Keep the note short and factual; no prose outside these sections.",
    ].filter(Boolean).join("\n");
  }
  return [
    `You hit a cap boundary as ${role}. Write a wrap-up handoff note so the resumed session continues the review without re-checking what you already covered.`,
    scopeLine + notePathLine,
    "## Found (already checked + result)",
    "- List one bullet per item already checked, each with its result (e.g. `- file.js:12-40 — checked auth guard, result: ok`).",
    "Progress signal: Found section growth — the resumed session must add new Found entries, never rewrite existing ones.",
    "",
    "## Next (left to check)",
    "- List every item left to check (file:line-range + what to verify).",
    "- If nothing remains, write `(none)` on its own line.",
    priorNote,
    "Keep the note short and factual; no prose outside these sections.",
  ].filter(Boolean).join("\n");
}

// Mission 031 phase 3 task 3.1: count the bullet entries in the Found
// section of a wrap-up handoff note. Sections are `## Found ...` up to the
// next `## ` (or `# `) header or end of text. Only real bullets count:
// lines starting with `- `, `* `, or `N. ` with non-space content after
// the marker. A `(none)` placeholder counts as zero. Pure read — never
// throws on odd input.
export function parseFoundEntries(noteText) {
  const body = sectionBody(noteText, "Found");
  if (!body) return 0;
  let count = 0;
  for (const line of body.split("\n")) {
    if (/^\s*[-*]\s+\S/.test(line)) { count++; continue; }
    if (/^\s*\d+\.\s+\S/.test(line)) { count++; continue; }
  }
  return count;
}

// Mission 031 phase 3 task 3.4: incomplete-signal helpers. A review is
// incomplete when its decision is INCOMPLETE or its wrap-up handoff note
// still lists unfinished work (non-empty Next section). A planning result
// is incomplete when its planner handoff note Next section is non-empty.
// Pure reads — never throw on odd input; unknown shapes return false.
function sectionBody(noteText, name) {
  const text = String(noteText ?? "");
  const header = new RegExp(`^#{1,2}\\s*${name}[^\\n]*(?:\n|$)`, "im");
  const hm = header.exec(text);
  if (!hm) return "";
  const rest = text.slice(hm.index + hm[0].length);
  const next = /^#{1,2}\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function nextSectionBody(noteText) {
  return sectionBody(noteText, "Next");
}

function hasNextItems(noteText) {
  const body = nextSectionBody(noteText);
  if (!body || !body.trim()) return false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\(none\)$/i.test(trimmed)) continue;
    if (/^[-*]\s+\S/.test(line)) return true;
    if (/^\d+\.\s+\S/.test(line)) return true;
  }
  return false;
}

function candidateNoteText(obj) {
  if (typeof obj === "string") return obj;
  if (!obj || typeof obj !== "object") return "";
  const keys = ["handoffNote", "note", "noteText", "handoffNoteText", "wrapUpNote", "handoff", "text"];
  for (const k of keys) {
    if (typeof obj[k] === "string" && obj[k].trim()) return obj[k];
  }
  return "";
}

function extractDecision(obj) {
  if (typeof obj === "string") return obj.trim().toUpperCase() === "INCOMPLETE" ? "INCOMPLETE" : null;
  if (!obj || typeof obj !== "object") return null;
  const candidates = [
    obj.decision,
    obj.verdict && typeof obj.verdict === "object" ? obj.verdict.decision : obj.verdict,
    obj.review && typeof obj.review === "object" ? obj.review.decision : null,
    obj.result && typeof obj.result === "object" ? obj.result.decision : null,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().toUpperCase() === "INCOMPLETE") return "INCOMPLETE";
  }
  return null;
}

export function parseIncompleteSignal(reviewResult) {
  if (extractDecision(reviewResult) === "INCOMPLETE") return true;
  return hasNextItems(candidateNoteText(reviewResult));
}

export function parsePlanningIncompleteSignal(planningResult) {
  return hasNextItems(candidateNoteText(planningResult));
}
