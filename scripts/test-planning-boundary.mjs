#!/usr/bin/env node
// Pure unit tests for planning-boundary.mjs — the STAGE-SPECIFIC SpecKit
// planning write-boundary used by autopilot.mjs's runPlanningPhase() to:
//   - stop a new, unrelated request from being attached to an existing
//     SpecKit feature (specify discovers/locks a NEW feature dir only),
//   - stop the Planner from creating implementation deliverables,
//   - stop a file that is merely "somewhere under the right feature
//     directory" but wrong for the CURRENT stage (e.g. plan.md written
//     during specify) from being silently accepted,
//   - validate the exact .specify/feature.json schema (the REAL
//     speckit-specify schema: exactly one field, feature_directory — no
//     branch/feature_name/feature_number), and
//   - validate that CLAUDE.md only changes inside its controlled
//     <!-- SPECKIT START/END --> marker section (the REAL marker text —
//     no colon).
// See test-speckit-new-request-isolation.mjs for the end-to-end behavioral
// proof (real orchestrator subprocess + a fake adapter emulating the real
// speckit-specify/speckit-plan/speckit-tasks artifact contracts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluatePlanningWriteBoundary, validateFeatureJson, validateClaudeMdEdit,
  listSpecKitFeatureDirNames, CLAUDE_MD_MARKER_BEGIN, CLAUDE_MD_MARKER_END
} from "./planning-boundary.mjs";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

// The real speckit-specify schema is exactly one field.
const goodFeatureJson = JSON.stringify({feature_directory: "specs/999-smoke-test"});

check("markers are the real (colon-free) SPECKIT START/END text", CLAUDE_MD_MARKER_BEGIN === "<!-- SPECKIT START -->" && CLAUDE_MD_MARKER_END === "<!-- SPECKIT END -->");

// ---------------------------------------------------------------------
// validateFeatureJson — exact expected schema: { "feature_directory":
// "specs/<resolved-feature>" }, no other fields.
// ---------------------------------------------------------------------
{
  check("feature.json: well-formed matches its own feature dir", validateFeatureJson(goodFeatureJson, {featureDir: "999-smoke-test"}).ok === true);
  check("feature.json: well-formed, no featureDir constraint given", validateFeatureJson(goodFeatureJson, {}).ok === true);
  check("feature.json: rejects mismatched featureDir", validateFeatureJson(goodFeatureJson, {featureDir: "002-other"}).reason === "feature_json_feature_directory_mismatch");
  check("feature.json: rejects invalid JSON", validateFeatureJson("{not json", {}).reason === "feature_json_invalid_json");
  check("feature.json: rejects an array", validateFeatureJson("[]", {}).reason === "feature_json_not_an_object");
  check("feature.json: rejects malformed feature_directory (no specs/ prefix)", validateFeatureJson(JSON.stringify({
    feature_directory: "999-smoke-test"
  }), {}).reason === "feature_json_feature_directory_malformed");
  check("feature.json: rejects a non-string feature_directory", validateFeatureJson(JSON.stringify({
    feature_directory: 999
  }), {}).reason === "feature_json_field_feature_directory_invalid");
  check("feature.json: rejects an empty feature_directory", validateFeatureJson(JSON.stringify({
    feature_directory: ""
  }), {}).reason === "feature_json_field_feature_directory_invalid");

  // Regression: the previously-invented 4-field schema (branch,
  // feature_directory, feature_name, feature_number) must now be REJECTED
  // as an unexpected shape — it is not, and never was, the real schema.
  const invented = JSON.stringify({
    branch: "999-smoke-test", feature_directory: "specs/999-smoke-test",
    feature_name: "smoke-test", feature_number: "999"
  });
  check("feature.json: the invented 4-field schema is rejected (unexpected_shape)", validateFeatureJson(invented, {}).reason === "feature_json_unexpected_shape");
  // Regression: a single extra field beyond feature_directory alone.
  check("feature.json: feature_directory plus ANY extra field is rejected", validateFeatureJson(JSON.stringify({
    feature_directory: "specs/999-smoke-test", branch: "999-smoke-test"
  }), {}).reason === "feature_json_unexpected_shape");
}

// ---------------------------------------------------------------------
// validateClaudeMdEdit — only the controlled marker section may change.
// Markers are the REAL text: "<!-- SPECKIT START -->" / "<!-- SPECKIT
// END -->" (no colon).
// ---------------------------------------------------------------------
{
  const baseline = `# CLAUDE.md\n\nProject notes.\n\n${CLAUDE_MD_MARKER_BEGIN}\n(no active feature)\n${CLAUDE_MD_MARKER_END}\n\nMore notes.\n`;
  const legit = `# CLAUDE.md\n\nProject notes.\n\n${CLAUDE_MD_MARKER_BEGIN}\nActive feature: 999-smoke-test\n${CLAUDE_MD_MARKER_END}\n\nMore notes.\n`;
  const outside = `# CLAUDE.md\n\nProject notes -- TAMPERED.\n\n${CLAUDE_MD_MARKER_BEGIN}\n(no active feature)\n${CLAUDE_MD_MARKER_END}\n\nMore notes.\n`;
  const noMarkersAfter = `# CLAUDE.md\n\nProject notes.\n\nActive feature: 999-smoke-test\n\nMore notes.\n`;
  const duplicateBegin = `${CLAUDE_MD_MARKER_BEGIN}\n${CLAUDE_MD_MARKER_BEGIN}\nx\n${CLAUDE_MD_MARKER_END}\n`;
  // Regression: the previously-invented colon markers must NOT satisfy the
  // real (colon-free) marker check — a baseline using them has no real
  // markers at all.
  const inventedColonMarkers = `# CLAUDE.md\n\n<!-- SPECKIT:BEGIN -->\n(no active feature)\n<!-- SPECKIT:END -->\n`;

  check("CLAUDE.md: editing only inside the markers is allowed", validateClaudeMdEdit(baseline, legit).ok === true);
  check("CLAUDE.md: no-op (identical) is allowed", validateClaudeMdEdit(baseline, baseline).ok === true);
  check("CLAUDE.md: editing content outside the markers is rejected", validateClaudeMdEdit(baseline, outside).reason === "claude_md_edit_outside_marker_section");
  check("CLAUDE.md: removing the markers is rejected", validateClaudeMdEdit(baseline, noMarkersAfter).reason === "claude_md_markers_removed_or_duplicated");
  check("CLAUDE.md: a baseline with no markers at all is rejected (can't prove scope)", validateClaudeMdEdit(noMarkersAfter, legit).reason === "claude_md_baseline_missing_markers");
  check("CLAUDE.md: duplicated begin marker after edit is rejected", validateClaudeMdEdit(baseline, duplicateBegin).reason === "claude_md_markers_removed_or_duplicated");
  check("CLAUDE.md: unreadable current content is rejected", validateClaudeMdEdit(baseline, null).reason === "claude_md_unreadable");
  check("CLAUDE.md: the invented colon-style markers do not count as real markers", validateClaudeMdEdit(inventedColonMarkers, legit).reason === "claude_md_baseline_missing_markers");

  // Regression: a planner's editor commonly normalizes the file's final
  // line ending on save (adding/removing one trailing LF/CRLF at EOF) even
  // when it only touched the marker section. When SPECKIT END is the last
  // thing in the file, that single optional terminal line ending must not
  // be mistaken for an outside-marker edit.
  const noTrailingNewline = `# CLAUDE.md\n\n${CLAUDE_MD_MARKER_BEGIN}\n(none)\n${CLAUDE_MD_MARKER_END}`;
  const trailingLf = `${noTrailingNewline}\n`;
  const trailingCrlf = `${noTrailingNewline}\r\n`;
  const trailingLfEdited = `# CLAUDE.md\n\n${CLAUDE_MD_MARKER_BEGIN}\nActive: 999-smoke-test\n${CLAUDE_MD_MARKER_END}\n`;
  const noTrailingNewlineEdited = `# CLAUDE.md\n\n${CLAUDE_MD_MARKER_BEGIN}\nActive: 999-smoke-test\n${CLAUDE_MD_MARKER_END}`;
  const trailingCrlfEdited = `# CLAUDE.md\n\n${CLAUDE_MD_MARKER_BEGIN}\nActive: 999-smoke-test\n${CLAUDE_MD_MARKER_END}\r\n`;
  const extraBlankLine = `${noTrailingNewline}\n\n`;
  const trailingSpaces = `${noTrailingNewline}\n  `;
  const trailingText = `${noTrailingNewline}\nMore notes.\n`;

  check("CLAUDE.md: baseline with no terminal newline, current adds one LF, is allowed",
    validateClaudeMdEdit(noTrailingNewline, trailingLfEdited).ok === true);
  check("CLAUDE.md: baseline with a terminal LF, current removes it, is allowed",
    validateClaudeMdEdit(trailingLf, noTrailingNewlineEdited).ok === true);
  check("CLAUDE.md: terminal LF and terminal CRLF forms are equivalent (LF baseline -> CRLF current)",
    validateClaudeMdEdit(trailingLf, trailingCrlfEdited).ok === true);
  check("CLAUDE.md: terminal LF and terminal CRLF forms are equivalent (CRLF baseline -> LF current)",
    validateClaudeMdEdit(trailingCrlf, trailingLfEdited).ok === true);
  check("CLAUDE.md: an extra trailing blank line after END is rejected",
    validateClaudeMdEdit(noTrailingNewline, extraBlankLine).reason === "claude_md_edit_outside_marker_section");
  check("CLAUDE.md: trailing spaces after END are rejected",
    validateClaudeMdEdit(noTrailingNewline, trailingSpaces).reason === "claude_md_edit_outside_marker_section");
  check("CLAUDE.md: trailing text after END is rejected",
    validateClaudeMdEdit(noTrailingNewline, trailingText).reason === "claude_md_edit_outside_marker_section");
  check("CLAUDE.md: a prefix change before START is still rejected even with a tolerated terminal newline change",
    validateClaudeMdEdit(noTrailingNewline, `# CLAUDE.md TAMPERED\n\n${CLAUDE_MD_MARKER_BEGIN}\n(none)\n${CLAUDE_MD_MARKER_END}\n`).reason === "claude_md_edit_outside_marker_section");
  check("CLAUDE.md: duplicated markers remain rejected even with a tolerated terminal newline change",
    validateClaudeMdEdit(noTrailingNewline, `${CLAUDE_MD_MARKER_BEGIN}\n${CLAUDE_MD_MARKER_BEGIN}\nx\n${CLAUDE_MD_MARKER_END}\n`).reason === "claude_md_markers_removed_or_duplicated");
  check("CLAUDE.md: legitimate plan-stage marker-content-only changes still pass regardless of terminal newline form",
    validateClaudeMdEdit(noTrailingNewline, trailingLfEdited).ok === true && validateClaudeMdEdit(trailingLf, trailingLfEdited.slice(0, -1)).ok === true);
}

// ---------------------------------------------------------------------
// TASK 15.6D: Native Windows line-ending false positive. The Planner
// correctly edited only the marker section, but its editor normalized
// Windows/mixed line endings to LF. Observed bytes: baseline suffix
// "\n\r\n", rewritten suffix "\n" (and in the full smoke-4 file,
// baseline after-END "\n\r\n" vs rewritten "\n\n"). LF and CRLF encodings
// of identical lines are equivalent; line count, text, and non-newline
// whitespace outside the markers stay strictly protected.
// ---------------------------------------------------------------------
{
  // Exact observed byte forms (minimal): baseline suffix "\n\r\n",
  // rewritten suffix "\n" → PASS.
  const mixedBaseline = `# Smoke Test Instructions\n\n${CLAUDE_MD_MARKER_BEGIN}\nNo active feature.\n${CLAUDE_MD_MARKER_END}\n\r\n`;
  const mixedRewritten = `# Smoke Test Instructions\n\n${CLAUDE_MD_MARKER_BEGIN}\nActive feature: 001-windows-autopilot-smoke-doc\n${CLAUDE_MD_MARKER_END}\n`;
  check("TASK 15.6D: observed Windows byte case (baseline suffix \\n\\r\\n, rewritten \\n) passes",
    validateClaudeMdEdit(mixedBaseline, mixedRewritten).ok === true);

  // Full observed smoke-4 byte forms: baseline after-END "\n\r\n" vs
  // rewritten after-END "\n\n" (END-line newline plus one trailing empty
  // line, only the empty line's encoding differs) → PASS.
  const fullBaseline = `# Smoke Test Instructions\n\n${CLAUDE_MD_MARKER_BEGIN}\nNo active feature.\n${CLAUDE_MD_MARKER_END}\n\r\n`;
  const fullRewritten = `# Smoke Test Instructions\n\n${CLAUDE_MD_MARKER_BEGIN}\nActive feature: 001-windows-autopilot-smoke-doc\n${CLAUDE_MD_MARKER_END}\n\n`;
  check("TASK 15.6D: full observed smoke-4 bytes (mixed terminal vs LF terminal) pass",
    validateClaudeMdEdit(fullBaseline, fullRewritten).ok === true);

  // CRLF outside-marker lines rewritten as LF with identical content → PASS.
  const crlfBaseline = `# Title\r\n\r\nProject notes.\r\n\r\n${CLAUDE_MD_MARKER_BEGIN}\r\nold content\r\n${CLAUDE_MD_MARKER_END}\r\n\r\nMore notes.\r\n`;
  const lfRewritten = `# Title\n\nProject notes.\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew content\n${CLAUDE_MD_MARKER_END}\n\nMore notes.\n`;
  check("TASK 15.6D: CRLF outside-marker lines rewritten as LF with identical content passes",
    validateClaudeMdEdit(crlfBaseline, lfRewritten).ok === true);

  // LF rewritten as CRLF with identical content → PASS.
  check("TASK 15.6D: LF rewritten as CRLF with identical content passes",
    validateClaudeMdEdit(lfRewritten, crlfBaseline).ok === true);

  // Changed outside-marker text → FAIL (even when CR encoding is involved,
  // so the CR tolerance cannot open a content hole).
  check("TASK 15.6D: changed outside-marker text fails",
    validateClaudeMdEdit(lfRewritten, lfRewritten.replace("Project notes.", "Project notes -- TAMPERED.")).reason === "claude_md_edit_outside_marker_section");
  check("TASK 15.6D: changed outside-marker text with CR present still fails",
    validateClaudeMdEdit(crlfBaseline, crlfBaseline.replace("Project notes.", "Project notes -- TAMPERED.")).reason === "claude_md_edit_outside_marker_section");

  // Changed blank-line structure before START → FAIL (exact line count
  // preserved, even across encodings).
  check("TASK 15.6D: changed blank-line structure before START fails",
    validateClaudeMdEdit(`# Title\n\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\n`, `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\n`).reason === "claude_md_edit_outside_marker_section");
  check("TASK 15.6D: changed blank-line structure before START fails even with CR present",
    validateClaudeMdEdit(`# Title\r\n\r\n\r\n${CLAUDE_MD_MARKER_BEGIN}\r\nold\r\n${CLAUDE_MD_MARKER_END}\r\n`, `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\n`).reason === "claude_md_edit_outside_marker_section");

  // Trailing spaces/tabs → FAIL (non-newline whitespace preserved).
  check("TASK 15.6D: trailing spaces after END fail",
    validateClaudeMdEdit(`# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\n`, `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\n  `).reason === "claude_md_edit_outside_marker_section");
  check("TASK 15.6D: trailing tab after END fails even with CR present",
    validateClaudeMdEdit(`# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\n\r\n`, `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\n\t`).reason === "claude_md_edit_outside_marker_section");

  // Duplicated/removed markers → FAIL (marker protection preserved).
  check("TASK 15.6D: duplicated markers fail",
    validateClaudeMdEdit(`# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\n`, `${CLAUDE_MD_MARKER_BEGIN}\n${CLAUDE_MD_MARKER_BEGIN}\nx\n${CLAUDE_MD_MARKER_END}\n`).reason === "claude_md_markers_removed_or_duplicated");
  check("TASK 15.6D: removed markers fail",
    validateClaudeMdEdit(`# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\n`, `# Title\n\nActive feature: no markers here\n`).reason === "claude_md_markers_removed_or_duplicated");

  // Pure-LF extra blank line stays rejected (no CR involved, so the mixed
  // terminal tolerance must not fire) — guards against over-permissiveness.
  check("TASK 15.6D: pure-LF extra trailing blank line still fails",
    validateClaudeMdEdit(`# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}`, `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\n\n`).reason === "claude_md_edit_outside_marker_section");
}

// ---------------------------------------------------------------------
// TASK 15.6D CORRECTION: the trailing-newline-count tolerance was
// over-permissive — it stripped ALL trailing LFs whenever a CR was
// present, accepting blank-line additions after real tail text. The
// exception now applies only when BOTH complete post-END suffixes are
// newline-only, and only for a single-break encoding artifact.
// ---------------------------------------------------------------------
{
  // Confirmed failing case: tail text plus added blank lines must fail,
  // even though encoding normalization is involved.
  check("TASK 15.6D CORRECTION: tail text plus added blank lines fails",
    validateClaudeMdEdit(
      `Head\r\n${CLAUDE_MD_MARKER_BEGIN}\r\nold\r\n${CLAUDE_MD_MARKER_END}\r\nTail\r\n`,
      `Head\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\nTail\n\n\n`
    ).reason === "claude_md_edit_outside_marker_section");

  // Identical tail text with CRLF↔LF normalization passes (both directions).
  check("TASK 15.6D CORRECTION: identical tail text CRLF->LF passes",
    validateClaudeMdEdit(
      `# Title\r\n\r\n${CLAUDE_MD_MARKER_BEGIN}\r\nold\r\n${CLAUDE_MD_MARKER_END}\r\nTail\r\n`,
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\nTail\n`
    ).ok === true);
  check("TASK 15.6D CORRECTION: identical tail text LF->CRLF passes",
    validateClaudeMdEdit(
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\nTail\n`,
      `# Title\r\n\r\n${CLAUDE_MD_MARKER_BEGIN}\r\nnew\r\n${CLAUDE_MD_MARKER_END}\r\nTail\r\n`
    ).ok === true);

  // Added/removed blank lines after tail text fail.
  check("TASK 15.6D CORRECTION: added blank line after tail text fails",
    validateClaudeMdEdit(
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\nTail\n`,
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\nTail\n\n`
    ).reason === "claude_md_edit_outside_marker_section");
  check("TASK 15.6D CORRECTION: removed blank line after tail text fails",
    validateClaudeMdEdit(
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\nTail\n\n`,
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\nTail\n`
    ).reason === "claude_md_edit_outside_marker_section");
  check("TASK 15.6D CORRECTION: added blank lines after tail text fail even with CR present",
    validateClaudeMdEdit(
      `# Title\r\n\r\n${CLAUDE_MD_MARKER_BEGIN}\r\nold\r\n${CLAUDE_MD_MARKER_END}\r\nTail\r\n`,
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\nTail\n\n\n`
    ).reason === "claude_md_edit_outside_marker_section");

  // The observed "\n\r\n" versus "\n" case still passes.
  check("TASK 15.6D CORRECTION: observed mixed terminal still passes",
    validateClaudeMdEdit(
      `# Smoke Test Instructions\n\n${CLAUDE_MD_MARKER_BEGIN}\nNo active feature.\n${CLAUDE_MD_MARKER_END}\n\r\n`,
      `# Smoke Test Instructions\n\n${CLAUDE_MD_MARKER_BEGIN}\nActive feature.\n${CLAUDE_MD_MARKER_END}\n`
    ).ok === true);

  // Multiple added blank lines are not an encoding artifact, even with CR.
  check("TASK 15.6D CORRECTION: multiple added blank lines fail even with CR present",
    validateClaudeMdEdit(
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\n`,
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\n\r\n\r\n`
    ).reason === "claude_md_edit_outside_marker_section");

  // Spaces, tabs, changed text, missing/duplicated markers remain rejected.
  check("TASK 15.6D CORRECTION: trailing spaces after tail text fail",
    validateClaudeMdEdit(
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\nTail\n`,
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\nTail  \n`
    ).reason === "claude_md_edit_outside_marker_section");
  check("TASK 15.6D CORRECTION: changed tail text fails",
    validateClaudeMdEdit(
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nold\n${CLAUDE_MD_MARKER_END}\nTail\n`,
      `# Title\n\n${CLAUDE_MD_MARKER_BEGIN}\nnew\n${CLAUDE_MD_MARKER_END}\nTail TAMPERED\n`
    ).reason === "claude_md_edit_outside_marker_section");
}

// ---------------------------------------------------------------------
// evaluatePlanningWriteBoundary — stage-specific allowlists
// ---------------------------------------------------------------------
function readerFor(files) {
  return (rel) => Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null;
}

// specify
{
  const featureJson = goodFeatureJson;
  const ok = evaluatePlanningWriteBoundary({
    stage: "specify",
    touchedFiles: [".specify/feature.json", "specs/999-smoke-test/spec.md", "specs/999-smoke-test/checklists/requirements.md"],
    preexistingFeatureDirs: ["002-existing"],
    readFile: readerFor({".specify/feature.json": featureJson})
  });
  check("specify: feature.json + spec.md + checklist is fully allowed", ok.ok === true && ok.resolvedFeatureDir === "999-smoke-test");

  const wrongStage = evaluatePlanningWriteBoundary({
    stage: "specify",
    touchedFiles: [".specify/feature.json", "specs/999-smoke-test/spec.md", "specs/999-smoke-test/plan.md"],
    preexistingFeatureDirs: [],
    readFile: readerFor({".specify/feature.json": featureJson})
  });
  check("specify: plan.md written during specify (same feature dir) is rejected", wrongStage.ok === false);
  check("specify: plan.md-during-specify reason is wrong_stage_artifact", wrongStage.violations.find(v => v.path.endsWith("plan.md")).reason === "wrong_stage_artifact");

  const implFile = evaluatePlanningWriteBoundary({
    stage: "specify",
    touchedFiles: [".specify/feature.json", "specs/999-smoke-test/spec.md", "specs/999-smoke-test/implementation.js"],
    preexistingFeatureDirs: [],
    readFile: readerFor({".specify/feature.json": featureJson})
  });
  check("specify: arbitrary implementation.js inside the feature dir is rejected", implFile.ok === false && implFile.violations.some(v => v.path.endsWith("implementation.js") && v.reason === "wrong_stage_artifact"));

  const outsideDeliverable = evaluatePlanningWriteBoundary({
    stage: "specify",
    touchedFiles: ["specs/999-smoke-test/spec.md", "docs/AUTOPILOT-SMOKE-TEST.md"],
    preexistingFeatureDirs: []
  });
  check("specify: implementation deliverable outside specs/ is rejected", outsideDeliverable.ok === false && outsideDeliverable.violations.some(v => v.path === "docs/AUTOPILOT-SMOKE-TEST.md" && v.reason === "outside_allowed_paths"));

  const reusesExisting = evaluatePlanningWriteBoundary({
    stage: "specify",
    touchedFiles: ["specs/002-existing/spec.md"],
    preexistingFeatureDirs: ["002-existing"]
  });
  check("specify: writing spec.md into a preexisting feature dir is rejected", reusesExisting.ok === false && reusesExisting.violations[0].reason === "preexisting_feature_directory");

  const ambiguous = evaluatePlanningWriteBoundary({
    stage: "specify",
    touchedFiles: ["specs/999-smoke-test/spec.md", "specs/998-other/spec.md"],
    preexistingFeatureDirs: []
  });
  check("specify: two new spec.md dirs in one call is rejected (ambiguous)", ambiguous.ok === false && ambiguous.resolvedFeatureDir === null);

  const crossFileMismatch = evaluatePlanningWriteBoundary({
    stage: "specify",
    touchedFiles: [".specify/feature.json", "specs/999-smoke-test/spec.md"],
    preexistingFeatureDirs: [],
    readFile: readerFor({".specify/feature.json": JSON.stringify({feature_directory: "specs/998-different"})})
  });
  check("specify: feature.json pointing at a DIFFERENT dir than spec.md is rejected (ambiguous)", crossFileMismatch.ok === false && crossFileMismatch.resolvedFeatureDir === null);

  const badSchema = evaluatePlanningWriteBoundary({
    stage: "specify",
    touchedFiles: [".specify/feature.json", "specs/999-smoke-test/spec.md"],
    preexistingFeatureDirs: [],
    readFile: readerFor({".specify/feature.json": JSON.stringify({feature_directory: "specs/999-smoke-test", branch: "999-smoke-test"})})
  });
  check("specify: feature.json with an extra invented field is rejected even though the path is allowed", badSchema.ok === false && badSchema.violations.some(v => v.path === ".specify/feature.json" && v.reason === "feature_json_unexpected_shape"));
}

// plan
{
  const claudeBaseline = `# CLAUDE.md\n\n${CLAUDE_MD_MARKER_BEGIN}\n(none)\n${CLAUDE_MD_MARKER_END}\n`;
  const claudeLegit = `# CLAUDE.md\n\n${CLAUDE_MD_MARKER_BEGIN}\nActive: 999-smoke-test\n${CLAUDE_MD_MARKER_END}\n`;
  const claudeTampered = `# CLAUDE.md TAMPERED\n\n${CLAUDE_MD_MARKER_BEGIN}\n(none)\n${CLAUDE_MD_MARKER_END}\n`;

  const ok = evaluatePlanningWriteBoundary({
    stage: "plan",
    touchedFiles: [
      "specs/999-smoke-test/plan.md", "specs/999-smoke-test/research.md", "specs/999-smoke-test/data-model.md",
      "specs/999-smoke-test/quickstart.md", "specs/999-smoke-test/contracts/health.md", "CLAUDE.md"
    ],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: ["002-existing"],
    readFile: readerFor({"CLAUDE.md": claudeLegit}),
    claudeMdBaseline: claudeBaseline
  });
  check("plan: full real artifact set + in-marker CLAUDE.md edit is allowed", ok.ok === true);

  const wrongStage = evaluatePlanningWriteBoundary({
    stage: "plan",
    touchedFiles: ["specs/999-smoke-test/plan.md", "specs/999-smoke-test/tasks.md"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: []
  });
  check("plan: tasks.md written during plan (same feature dir) is rejected", wrongStage.ok === false && wrongStage.violations.find(v => v.path.endsWith("tasks.md")).reason === "wrong_stage_artifact");

  // Backlog #9 option (a): a gate revision in 'plan' may also edit the earlier
  // stage's spec.md (same feature dir), but never a later stage's tasks.md.
  const planRevisionOk = evaluatePlanningWriteBoundary({
    stage: "plan",
    touchedFiles: ["specs/999-smoke-test/plan.md", "specs/999-smoke-test/spec.md"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: [],
    revision: true
  });
  check("plan (revision): spec.md edited during plan is allowed", planRevisionOk.ok === true);
  const planNonRevision = evaluatePlanningWriteBoundary({
    stage: "plan",
    touchedFiles: ["specs/999-smoke-test/plan.md", "specs/999-smoke-test/spec.md"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: []
  });
  check("plan (non-revision): spec.md edited during plan is rejected", planNonRevision.ok === false);
  const planRevisionTasks = evaluatePlanningWriteBoundary({
    stage: "plan",
    touchedFiles: ["specs/999-smoke-test/plan.md", "specs/999-smoke-test/tasks.md"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: [],
    revision: true
  });
  check("plan (revision): tasks.md still rejected", planRevisionTasks.ok === false && planRevisionTasks.violations.find(v => v.path.endsWith("tasks.md")).reason === "wrong_stage_artifact");
  const planRevisionFeatureJson = evaluatePlanningWriteBoundary({
    stage: "plan",
    touchedFiles: ["specs/999-smoke-test/plan.md", ".specify/feature.json"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: [],
    revision: true
  });
  check("plan (revision): feature.json still rejected", planRevisionFeatureJson.ok === false);

  const claudeOutside = evaluatePlanningWriteBoundary({
    stage: "plan",
    touchedFiles: ["specs/999-smoke-test/plan.md", "CLAUDE.md"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: [],
    readFile: readerFor({"CLAUDE.md": claudeTampered}),
    claudeMdBaseline: claudeBaseline
  });
  check("plan: CLAUDE.md edit outside the marker section is rejected", claudeOutside.ok === false && claudeOutside.violations.find(v => v.path === "CLAUDE.md").reason === "claude_md_edit_outside_marker_section");

  const claudeDuringSpecify = evaluatePlanningWriteBoundary({
    stage: "specify",
    touchedFiles: ["specs/999-smoke-test/spec.md", "CLAUDE.md"],
    preexistingFeatureDirs: [],
    readFile: readerFor({"CLAUDE.md": claudeLegit}),
    claudeMdBaseline: claudeBaseline
  });
  check("specify: CLAUDE.md is not allowed at all (only plan may touch it)", claudeDuringSpecify.ok === false && claudeDuringSpecify.violations.find(v => v.path === "CLAUDE.md").reason === "wrong_stage_artifact");

  const featureJsonDuringPlan = evaluatePlanningWriteBoundary({
    stage: "plan",
    touchedFiles: ["specs/999-smoke-test/plan.md", ".specify/feature.json"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: []
  });
  check("plan: feature.json is not allowed (only specify may touch it)", featureJsonDuringPlan.ok === false && featureJsonDuringPlan.violations.find(v => v.path === ".specify/feature.json").reason === "wrong_stage_artifact");

  const differentFeature = evaluatePlanningWriteBoundary({
    stage: "plan",
    touchedFiles: ["specs/002-existing/plan.md"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: ["002-existing"]
  });
  check("plan: writing into a different (preexisting) feature dir is rejected", differentFeature.ok === false && differentFeature.violations[0].reason === "preexisting_feature_directory");
}

// tasks
{
  const ok = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: ["specs/999-smoke-test/tasks.md"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: []
  });
  check("tasks: tasks.md for the resolved feature is allowed", ok.ok === true);

  const wrongStage = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: ["specs/999-smoke-test/tasks.md", "specs/999-smoke-test/plan.md"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: []
  });
  check("tasks: plan.md re-written during tasks is rejected", wrongStage.ok === false && wrongStage.violations.find(v => v.path.endsWith("plan.md")).reason === "wrong_stage_artifact");

  // Backlog #9 option (a): a gate revision in 'tasks' may also edit earlier
  // stages' spec.md and plan.md (same feature dir), but never feature.json.
  const tasksRevisionOk = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: ["specs/999-smoke-test/tasks.md", "specs/999-smoke-test/spec.md", "specs/999-smoke-test/plan.md"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: [],
    revision: true
  });
  check("tasks (revision): spec.md+plan.md edited during tasks are allowed", tasksRevisionOk.ok === true);
  const tasksNonRevision = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: ["specs/999-smoke-test/tasks.md", "specs/999-smoke-test/plan.md"],
    resolvedFeatureDir: "999-smoke-test",
    preexistingFeatureDirs: []
  });
  check("tasks (non-revision): plan.md edited during tasks is rejected", tasksNonRevision.ok === false);

  const unresolved = evaluatePlanningWriteBoundary({
    stage: "tasks",
    touchedFiles: ["specs/999-smoke-test/tasks.md"],
    resolvedFeatureDir: null,
    preexistingFeatureDirs: []
  });
  check("tasks: with no resolved feature dir at all, nothing is allowed", unresolved.ok === false && unresolved.violations[0].reason === "feature_directory_unresolved");
}

// ---------------------------------------------------------------------
// Regression fixtures — the EXACT real feature.json and CLAUDE.md text,
// loaded from disk (not just inline JS objects), proving valid specify/
// plan writes pass and malformed/outside-marker changes fail against the
// real formats byte-for-byte.
// ---------------------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-planning-boundary-fixtures-"));
  try {
    const featureJsonPath = path.join(root, "feature.json");
    fs.writeFileSync(featureJsonPath, '{"feature_directory":"specs/999-smoke-test"}\n');
    const realFeatureJson = fs.readFileSync(featureJsonPath, "utf8").trim();
    check("fixture: real feature.json text validates cleanly", validateFeatureJson(realFeatureJson, {featureDir: "999-smoke-test"}).ok === true);

    const claudeMdPath = path.join(root, "CLAUDE.md");
    fs.writeFileSync(claudeMdPath, [
      "# CLAUDE.md",
      "",
      "Project instructions.",
      "",
      "<!-- SPECKIT START -->",
      "(no active feature)",
      "<!-- SPECKIT END -->",
      "",
      "More project instructions.",
      ""
    ].join("\n"));
    const realClaudeMdBaseline = fs.readFileSync(claudeMdPath, "utf8");

    fs.writeFileSync(claudeMdPath, [
      "# CLAUDE.md",
      "",
      "Project instructions.",
      "",
      "<!-- SPECKIT START -->",
      "Active feature: 999-smoke-test",
      "<!-- SPECKIT END -->",
      "",
      "More project instructions.",
      ""
    ].join("\n"));
    const realClaudeMdLegitEdit = fs.readFileSync(claudeMdPath, "utf8");
    check("fixture: real CLAUDE.md in-marker edit validates cleanly", validateClaudeMdEdit(realClaudeMdBaseline, realClaudeMdLegitEdit).ok === true);

    fs.writeFileSync(claudeMdPath, [
      "# CLAUDE.md",
      "",
      "Project instructions -- TAMPERED OUTSIDE THE MARKERS.",
      "",
      "<!-- SPECKIT START -->",
      "(no active feature)",
      "<!-- SPECKIT END -->",
      "",
      "More project instructions.",
      ""
    ].join("\n"));
    const realClaudeMdOutsideEdit = fs.readFileSync(claudeMdPath, "utf8");
    check("fixture: real CLAUDE.md outside-marker edit is rejected", validateClaudeMdEdit(realClaudeMdBaseline, realClaudeMdOutsideEdit).reason === "claude_md_edit_outside_marker_section");

    // A full, real end-to-end specify + plan pass against these exact
    // fixture files via evaluatePlanningWriteBoundary (not just the
    // sub-validators in isolation).
    const specifyPass = evaluatePlanningWriteBoundary({
      stage: "specify",
      touchedFiles: [".specify/feature.json", "specs/999-smoke-test/spec.md"],
      preexistingFeatureDirs: [],
      readFile: (rel) => rel === ".specify/feature.json" ? realFeatureJson : null
    });
    check("fixture: real feature.json + spec.md specify write passes end-to-end", specifyPass.ok === true && specifyPass.resolvedFeatureDir === "999-smoke-test");

    const planPass = evaluatePlanningWriteBoundary({
      stage: "plan",
      touchedFiles: ["specs/999-smoke-test/plan.md", "CLAUDE.md"],
      resolvedFeatureDir: "999-smoke-test",
      preexistingFeatureDirs: [],
      readFile: (rel) => rel === "CLAUDE.md" ? realClaudeMdLegitEdit : null,
      claudeMdBaseline: realClaudeMdBaseline
    });
    check("fixture: real plan.md + in-marker CLAUDE.md plan write passes end-to-end", planPass.ok === true);

    const planFail = evaluatePlanningWriteBoundary({
      stage: "plan",
      touchedFiles: ["specs/999-smoke-test/plan.md", "CLAUDE.md"],
      resolvedFeatureDir: "999-smoke-test",
      preexistingFeatureDirs: [],
      readFile: (rel) => rel === "CLAUDE.md" ? realClaudeMdOutsideEdit : null,
      claudeMdBaseline: realClaudeMdBaseline
    });
    check("fixture: real plan.md + outside-marker CLAUDE.md plan write fails end-to-end", planFail.ok === false && planFail.violations.find(v => v.path === "CLAUDE.md").reason === "claude_md_edit_outside_marker_section");
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

// listSpecKitFeatureDirNames
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-planning-boundary-"));
  try {
    check("no specs/ dir yet: empty list", listSpecKitFeatureDirNames(root).length === 0);
    fs.mkdirSync(path.join(root, "specs", "002-existing"), {recursive: true});
    fs.mkdirSync(path.join(root, "specs", "001-other"), {recursive: true});
    fs.writeFileSync(path.join(root, "specs", "NOTES.md"), "not a feature dir\n");
    const names = listSpecKitFeatureDirNames(root);
    check("lists only feature directories, sorted, files excluded", JSON.stringify(names) === JSON.stringify(["001-other", "002-existing"]));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------
// Backlog #9 wiring: boundaryNoteFor / earlierStageEditsNote live in
// autopilot.mjs (not importable: it runs main), so the real function source is
// extracted and executed here.
{
  const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const grab = (name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found in autopilot.mjs`);
    let depth = 0, i = src.indexOf("{", src.indexOf(")", start));
    const open = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    return { text: src.slice(start, i + 1), open, end: i };
  };
  const noteFn = grab("boundaryNoteFor");
  const editsFn = grab("earlierStageEditsNote");
  const boundaryNoteFor = new Function("CLAUDE_MD_MARKER_BEGIN", "CLAUDE_MD_MARKER_END", `${noteFn.text}; return boundaryNoteFor;`)(CLAUDE_MD_MARKER_BEGIN, CLAUDE_MD_MARKER_END);
  const earlierStageEditsNote = new Function(`${editsFn.text}; return earlierStageEditsNote;`)();

  check("boundaryNoteFor source has no literal backslash-n template start", !/`\\\\n/.test(noteFn.text));
  for (const step of ["specify", "plan", "tasks"]) {
    for (const revision of [false, true]) {
      const note = boundaryNoteFor(step, "999-x", { revision });
      check(`boundaryNoteFor(${step}, revision=${revision}) starts with a real newline and has no literal backslash-n`, note.startsWith("\n") && !note.includes("\\n"));
    }
  }
  check("boundaryNoteFor(plan): revision text only in revision mode",
    boundaryNoteFor("plan", "999-x", { revision: true }).includes("Revision mode") && !boundaryNoteFor("plan", "999-x").includes("Revision mode"));
  check("boundaryNoteFor(plan, revision): asks for the hand-off note record",
    boundaryNoteFor("plan", "999-x", { revision: true }).includes("hand-off note"));
  check("planner prompt has no second revision-permission suffix", !/Revision mode: you may fix a cited/.test(src));

  const edits = { stage: "plan", files: ["specs/999-x/spec.md"] };
  check("earlierStageEditsNote names the files for the matching stage", earlierStageEditsNote({ planningEarlierStageEdits: edits }, "plan").includes("specs/999-x/spec.md"));
  check("earlierStageEditsNote is empty for another stage", earlierStageEditsNote({ planningEarlierStageEdits: edits }, "tasks") === "");
  check("earlierStageEditsNote is empty with nothing recorded", earlierStageEditsNote({}, "plan") === "");

  // Clearing: the gate PASS path (the block that clears the stage's review
  // feedback) must drop planningEarlierStageEdits too.
  const passAt = src.indexOf("clearReviewFeedback(s,speckitStageFeedbackKey(gateStage));");
  const passBlock = src.slice(passAt - 300, passAt + 600);
  check("gate PASS path clears planningEarlierStageEdits", passAt > 0 && /delete s\.planningEarlierStageEdits;/.test(passBlock));
}

if (failures) {
  console.error(`${failures} planning-boundary check(s) failed.`);
  process.exit(1);
}
console.log("planning-boundary unit tests: PASS");
