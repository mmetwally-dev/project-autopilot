// Planning-stage write-boundary enforcement for SpecKit.
//
// Bug this fixes: a new, unrelated planning request was able to attach
// itself to an existing SpecKit feature directory (specs/<existing>/...)
// merely because that feature already had complete spec/plan/tasks
// artifacts, and the Planner was able to create implementation deliverables
// (e.g. docs/AUTOPILOT-SMOKE-TEST.md) during the Spec stage with nothing to
// stop it. adapters/planning-state.mjs's specKitState() intentionally scans
// the whole specs/ tree to answer "does *a* SpecKit feature look planned
// anywhere" (used for resume detection) — it is not, and must not become,
// a per-feature write boundary. This module is that boundary, enforced
// against the actually OBSERVED files a planner relay call touched
// (autopilot.mjs's touchedFilesBetween), never against prompt wording.
//
// The boundary is STAGE-SPECIFIC, matching the real speckit-specify/
// speckit-plan/speckit-tasks artifact contracts:
//
//   specify: .specify/feature.json, specs/<feature>/spec.md,
//            specs/<feature>/checklists/**
//   plan:    specs/<feature>/plan.md, research.md, data-model.md,
//            quickstart.md, contracts/**, and ONLY the controlled
//            <!-- SPECKIT START/END --> marker section of CLAUDE.md
//   tasks:   specs/<feature>/tasks.md
//
// A file that is merely "somewhere under the right feature directory" is
// NOT automatically allowed — e.g. plan.md written during specify, or
// tasks.md written during plan, is rejected as a wrong-stage artifact even
// though it lives inside the correct feature directory.

import fs from "node:fs";
import path from "node:path";

export const CLAUDE_MD_MARKER_BEGIN = "<!-- SPECKIT START -->";
export const CLAUDE_MD_MARKER_END = "<!-- SPECKIT END -->";

function normalizeRel(p) {
  return String(p).replaceAll("\\", "/");
}

// The only export here that touches the filesystem — everything else is a
// pure function over already-collected data (touched-file lists, file
// contents) so the write-boundary logic itself is unit testable without
// touching disk. See test-planning-boundary.mjs.
export function listSpecKitFeatureDirNames(repo) {
  const specsRoot = path.join(repo, "specs");
  if (!fs.existsSync(specsRoot)) return [];
  return fs.readdirSync(specsRoot, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

// ---------------------------------------------------------------------
// Per-stage static allowlists, parameterized by the resolved feature dir
// name (e.g. "999-smoke-test"). Each returns true only for an EXACT match
// of that stage's real artifact contract — never "anything under the
// feature directory."
// ---------------------------------------------------------------------

function specifyAllowed(rel, featureDir) {
  if (rel === ".specify/feature.json") return true;
  if (!featureDir) return false;
  const base = `specs/${featureDir}/`;
  if (rel === `${base}spec.md`) return true;
  if (rel.startsWith(`${base}checklists/`) && rel.length > `${base}checklists/`.length) return true;
  return false;
}
function planAllowed(rel, featureDir) {
  if (rel === "CLAUDE.md") return true;
  if (!featureDir) return false;
  const base = `specs/${featureDir}/`;
  if ([`${base}plan.md`, `${base}research.md`, `${base}data-model.md`, `${base}quickstart.md`].includes(rel)) return true;
  if (rel.startsWith(`${base}contracts/`) && rel.length > `${base}contracts/`.length) return true;
  return false;
}
function tasksAllowed(rel, featureDir) {
  if (!featureDir) return false;
  return rel === `specs/${featureDir}/tasks.md`;
}
const STAGE_ALLOW = { specify: specifyAllowed, plan: planAllowed, tasks: tasksAllowed };

// ---------------------------------------------------------------------
// .specify/feature.json — exact expected schema, per the real
// speckit-specify skill: a single required string field, no others.
//
//   { "feature_directory": "specs/<resolved-feature>" }
//
// No branch/feature_name/feature_number fields exist in the real schema —
// do not invent or require them.
// ---------------------------------------------------------------------

const FEATURE_JSON_FIELDS = ["feature_directory"];

export function validateFeatureJson(raw, { featureDir = null } = {}) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, reason: "feature_json_invalid_json" }; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "feature_json_not_an_object" };
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== FEATURE_JSON_FIELDS.length || !FEATURE_JSON_FIELDS.every((k, i) => keys[i] === k)) {
    return { ok: false, reason: "feature_json_unexpected_shape" };
  }
  if (typeof parsed.feature_directory !== "string" || !parsed.feature_directory) {
    return { ok: false, reason: "feature_json_field_feature_directory_invalid" };
  }
  const dirMatch = parsed.feature_directory.match(/^specs\/([^/]+)$/);
  if (!dirMatch) return { ok: false, reason: "feature_json_feature_directory_malformed" };
  const dirName = dirMatch[1];
  if (featureDir && dirName !== featureDir) return { ok: false, reason: "feature_json_feature_directory_mismatch" };
  return { ok: true, featureDir: dirName };
}

// ---------------------------------------------------------------------
// CLAUDE.md — only the controlled <!-- SPECKIT START/END --> marker
// section may change during the plan stage. Everything outside that span
// must be byte-for-byte identical to the session's baseline (captured
// before any planner call ran).
// ---------------------------------------------------------------------

function markerSpan(content) {
  if (typeof content !== "string") return null;
  const beginIdx = content.indexOf(CLAUDE_MD_MARKER_BEGIN);
  const endIdx = content.indexOf(CLAUDE_MD_MARKER_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  if (content.indexOf(CLAUDE_MD_MARKER_BEGIN, beginIdx + 1) !== -1) return null;
  if (content.indexOf(CLAUDE_MD_MARKER_END, endIdx + 1) !== -1) return null;
  return { before: content.slice(0, beginIdx), after: content.slice(endIdx + CLAUDE_MD_MARKER_END.length) };
}

// A planner's editor commonly normalizes the file's final line ending on
// save (adding or removing one trailing LF/CRLF at EOF) even when it only
// touched the marker section. When the SPECKIT END marker is the last thing
// in the file, that single optional terminal line ending is not a real
// outside-marker edit — tolerate exactly these three equivalent forms as the
// COMPLETE post-marker suffix. Anything else after the marker (prefix
// changes, trailing text, trailing spaces/tabs, an extra blank line, i.e.
// more than one line ending) still requires a byte-for-byte match.
//
// TASK 15.6D: Native Windows editors additionally normalize line-ending
// ENCODING (CRLF vs LF) across the whole file, and can leave a mixed
// terminal artifact (observed: baseline suffix "\n\r\n" vs rewritten "\n").
// LF and CRLF are therefore treated as equivalent when comparing
// outside-marker bytes, but ONLY for encoding — line count, text content,
// and all non-newline whitespace (spaces/tabs) remain strictly protected.
// See normalizeClaudeMdNewlines() and claudeMdTailsEquivalent() below.
const CLAUDE_MD_TERMINAL_SUFFIXES = new Set(["", "\n", "\r\n"]);

// TASK 15.6D: line-ending encoding normalization for outside-marker
// comparison. CRLF and LF denote the same logical line break; lone CR is
// left untouched (it is neither LF nor CRLF, so it stays strict).
function normalizeClaudeMdNewlines(s) {
  return String(s).replace(/\r\n/g, "\n");
}

function claudeMdTailsEquivalent(beforeAfterMarker, afterAfterMarker) {
  if (beforeAfterMarker === afterAfterMarker) return true;
  if (CLAUDE_MD_TERMINAL_SUFFIXES.has(beforeAfterMarker) && CLAUDE_MD_TERMINAL_SUFFIXES.has(afterAfterMarker)) return true;
  // Encoding-only normalization with identical line structure (e.g. CRLF
  // outside-marker lines rewritten as LF, or vice versa, with the same
  // number of lines and identical text).
  const normalizedBefore = normalizeClaudeMdNewlines(beforeAfterMarker);
  const normalizedAfter = normalizeClaudeMdNewlines(afterAfterMarker);
  if (normalizedBefore === normalizedAfter) return true;
  // CORRECTION (TASK 15.6D): the trailing-newline-count tolerance below was
  // over-permissive — stripping ALL trailing LFs accepted blank-line
  // additions after real tail text (e.g. after-END "\r\nTail\r\n" vs
  // "\nTail\n\n\n"). The exception now applies ONLY when BOTH complete
  // suffixes after SPECKIT END contain newline characters exclusively. Any
  // text, spaces, or tabs after END requires exact equality after
  // CRLF→LF normalization (already failed above), so such cases fail here.
  if (!isClaudeMdNewlineOnly(beforeAfterMarker) || !isClaudeMdNewlineOnly(afterAfterMarker)) return false;
  // Observed Native Windows false positive: a mixed terminal artifact such
  // as baseline "\n\r\n" vs rewritten "\n" (normalized: "\n\n" vs "\n").
  // Tolerated ONLY as a single-break encoding artifact: the normalized
  // newline-only suffixes must differ by exactly one trailing LF, encoding
  // normalization must have been involved (a CR on either side, proving the
  // editor re-encoded newlines), and no lone CR may remain (it is neither
  // LF nor CRLF, so it stays strict). Arbitrary additions/removals of
  // multiple blank lines still fail, as do all pure-LF count differences
  // (extra-blank-line protection preserved).
  if (!beforeAfterMarker.includes("\r") && !afterAfterMarker.includes("\r")) return false;
  if (!/^\n*$/.test(normalizedBefore) || !/^\n*$/.test(normalizedAfter)) return false;
  return Math.abs(normalizedBefore.length - normalizedAfter.length) === 1;
}

// CORRECTION (TASK 15.6D): true only when the whole string is newline
// characters (CRLF, LF, or lone CR) — i.e. no text, spaces, or tabs.
function isClaudeMdNewlineOnly(s) {
  return /^(?:\r\n|\n|\r)*$/.test(s);
}

export function validateClaudeMdEdit(beforeContent, afterContent) {
  if (typeof beforeContent !== "string") return { ok: false, reason: "claude_md_no_baseline" };
  if (typeof afterContent !== "string") return { ok: false, reason: "claude_md_unreadable" };
  const beforeSpan = markerSpan(beforeContent);
  if (!beforeSpan) return { ok: false, reason: "claude_md_baseline_missing_markers" };
  const afterSpan = markerSpan(afterContent);
  if (!afterSpan) return { ok: false, reason: "claude_md_markers_removed_or_duplicated" };
  // TASK 15.6D: the pre-START section preserves the exact number and content
  // of lines, but LF and CRLF encodings of the same lines are equivalent.
  // Blank-line structure changes before START still fail because the
  // normalized forms differ in newline count.
  if (normalizeClaudeMdNewlines(beforeSpan.before) !== normalizeClaudeMdNewlines(afterSpan.before) || !claudeMdTailsEquivalent(beforeSpan.after, afterSpan.after)) {
    return { ok: false, reason: "claude_md_edit_outside_marker_section" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------
// Whole-call evaluation.
// ---------------------------------------------------------------------

function reasonForRejection(rel, stage, featureDir, preexistingFeatureDirs) {
  if (rel === ".specify/feature.json") return stage === "specify" ? "feature_json_content_invalid" : "wrong_stage_artifact";
  if (rel === "CLAUDE.md") return stage === "plan" ? "claude_md_content_invalid" : "wrong_stage_artifact";
  const m = rel.match(/^specs\/([^/]+)\//) || rel.match(/^specs\/([^/]+)$/);
  if (!m) return "outside_allowed_paths";
  if (preexistingFeatureDirs.includes(m[1]) && m[1] !== featureDir) return "preexisting_feature_directory";
  if (!featureDir) return "feature_directory_unresolved";
  if (m[1] !== featureDir) return "different_feature_directory";
  return "wrong_stage_artifact";
}

// touchedFiles: repo-relative paths actually observed to have changed
//   (autopilot.mjs relay results' touchedFiles, from relay-guards.mjs's
//   touchedFilesBetween — never prompt wording).
// stage: "specify" | "plan" | "tasks".
// preexistingFeatureDirs: feature dir names that existed before this (new)
//   planning session started (frozen once, at session start).
// resolvedFeatureDir: the feature dir already locked in by a prior stage
//   in this same session, or null if not yet known (only possible pre-lock
//   during "specify", where it is discovered from a specs/<x>/spec.md
//   write in THIS call).
// readFile(rel): returns current file content (string) or null.
// claudeMdBaseline: CLAUDE.md content captured at session start, or null.
export function evaluatePlanningWriteBoundary({
  stage, touchedFiles = [], preexistingFeatureDirs = [], resolvedFeatureDir = null,
  readFile = () => null, claudeMdBaseline = null
} = {}) {
  const matcher = STAGE_ALLOW[stage];
  if (!matcher) throw new Error(`Unknown planning stage: ${stage}`);
  const files = touchedFiles.map(normalizeRel);

  let featureDir = resolvedFeatureDir || null;
  let ambiguous = false;
  if (!featureDir && stage === "specify") {
    // Discover the new feature dir from whichever of spec.md / feature.json
    // was written (normally both, together) — if they disagree, that is
    // itself an ambiguous/inconsistent selection, not a silent pick.
    // A spec.md/feature.json aimed at an ALREADY-existing feature directory
    // must never be treated as discovering a legitimate new feature — that
    // is exactly the "reused an unrelated existing feature" failure mode.
    // Such writes fall through to reasonForRejection() below, which reports
    // them precisely as preexisting_feature_directory.
    const specNames = new Set();
    for (const rel of files) {
      const m = rel.match(/^specs\/([^/]+)\/spec\.md$/);
      if (m && !preexistingFeatureDirs.includes(m[1])) specNames.add(m[1]);
    }
    if (files.includes(".specify/feature.json")) {
      try {
        const parsed = JSON.parse(readFile(".specify/feature.json"));
        const dm = typeof parsed?.feature_directory === "string" && parsed.feature_directory.match(/^specs\/([^/]+)$/);
        if (dm && !preexistingFeatureDirs.includes(dm[1])) specNames.add(dm[1]);
      } catch { /* malformed feature.json is reported separately below */ }
    }
    if (specNames.size === 1) featureDir = [...specNames][0];
    else if (specNames.size > 1) ambiguous = true;
  }

  const violations = [];
  for (const rel of files) {
    if (ambiguous && /^specs\/[^/]+\/spec\.md$/.test(rel)) {
      violations.push({ path: rel, reason: "multiple_new_feature_directories" });
      continue;
    }
    if (!matcher(rel, featureDir)) {
      violations.push({ path: rel, reason: reasonForRejection(rel, stage, featureDir, preexistingFeatureDirs) });
      continue;
    }
    if (rel === ".specify/feature.json") {
      const content = readFile(rel);
      if (typeof content !== "string") { violations.push({ path: rel, reason: "feature_json_unreadable" }); continue; }
      const verdict = validateFeatureJson(content, { featureDir });
      if (!verdict.ok) { violations.push({ path: rel, reason: verdict.reason }); continue; }
    }
    if (rel === "CLAUDE.md") {
      const content = readFile(rel);
      const verdict = validateClaudeMdEdit(claudeMdBaseline, content);
      if (!verdict.ok) { violations.push({ path: rel, reason: verdict.reason }); continue; }
    }
  }
  return { ok: violations.length === 0, violations, resolvedFeatureDir: ambiguous ? null : featureDir };
}
