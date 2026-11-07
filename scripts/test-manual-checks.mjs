import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserCheckNotes, BROWSER_CHECK_NOTE_PREFIX } from "./task-requirements.mjs";
import { appendManualChecks } from "./manual-checks.mjs";

// Test 1: browserCheckNotes picks prefixed notes from notes and findings (case-insensitive), ignores others, [] on null/garbage
assert.deepEqual(browserCheckNotes(null), [], "null review returns []");
assert.deepEqual(browserCheckNotes(undefined), [], "undefined review returns []");
assert.deepEqual(browserCheckNotes("garbage"), [], "string review returns []");
assert.deepEqual(browserCheckNotes({}), [], "empty object returns []");
assert.deepEqual(browserCheckNotes({ notes: "not-an-array" }), [], "non-array notes returns []");
assert.deepEqual(browserCheckNotes({ findings: 123 }), [], "non-array findings returns []");

const mixedReview = {
  notes: [
    "  browser check not possible: check form header",
    "some other note",
    `${BROWSER_CHECK_NOTE_PREFIX} verify button color`
  ],
  findings: [
    "regular finding",
    "BROWSER CHECK NOT POSSIBLE: check modal dialog",
    null,
    123
  ]
};

const extracted = browserCheckNotes(mixedReview);
assert.equal(extracted.length, 3, "extracts exactly the 3 matching items");
assert.equal(extracted[0], "  browser check not possible: check form header");
assert.equal(extracted[1], `${BROWSER_CHECK_NOTE_PREFIX} verify button color`);
assert.equal(extracted[2], "BROWSER CHECK NOT POSSIBLE: check modal dialog");

// Test 2: appendManualChecks creates the file with header in temp dir, appends a second section, returns false and writes nothing for empty notes or empty missionDir
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-checks-test-"));
try {
  // Empty notes or empty missionDir
  assert.equal(appendManualChecks("", { phaseName: "Phase 1", notes: ["note"] }), false, "empty missionDir returns false");
  assert.equal(appendManualChecks(null, { phaseName: "Phase 1", notes: ["note"] }), false, "null missionDir returns false");
  assert.equal(appendManualChecks(tempDir, { phaseName: "Phase 1", notes: [] }), false, "empty notes returns false");
  assert.equal(appendManualChecks(tempDir, { phaseName: "Phase 1", notes: null }), false, "null notes returns false");

  const manualChecksPath = path.join(tempDir, "MANUAL-CHECKS.md");
  assert.ok(!fs.existsSync(manualChecksPath), "file not created on invalid calls");

  // First call creates file
  const ok1 = appendManualChecks(tempDir, {
    phaseName: "Phase 1",
    notes: ["BROWSER CHECK NOT POSSIBLE: check login button"],
    at: "2026-11-05T12:00:00.000Z"
  });
  assert.equal(ok1, true, "appendManualChecks returns true on write");
  assert.ok(fs.existsSync(manualChecksPath), "MANUAL-CHECKS.md created");

  const content1 = fs.readFileSync(manualChecksPath, "utf8");
  const expected1 = [
    "# Manual checks the operator must do by hand",
    "",
    "## Phase 1 (2026-11-05T12:00:00.000Z)",
    "- BROWSER CHECK NOT POSSIBLE: check login button",
    "",
    ""
  ].join("\n");
  assert.equal(content1, expected1, "first call creates expected structure");

  // Second call appends a second section
  const ok2 = appendManualChecks(tempDir, {
    phaseName: "Phase 2",
    notes: [
      "BROWSER CHECK NOT POSSIBLE: check signup page",
      "BROWSER CHECK NOT POSSIBLE: check footer"
    ],
    at: "2026-11-05T13:00:00.000Z"
  });
  assert.equal(ok2, true, "second call returns true on write");

  const content2 = fs.readFileSync(manualChecksPath, "utf8");
  const expected2 = [
    "# Manual checks the operator must do by hand",
    "",
    "## Phase 1 (2026-11-05T12:00:00.000Z)",
    "- BROWSER CHECK NOT POSSIBLE: check login button",
    "",
    "## Phase 2 (2026-11-05T13:00:00.000Z)",
    "- BROWSER CHECK NOT POSSIBLE: check signup page",
    "- BROWSER CHECK NOT POSSIBLE: check footer",
    "",
    ""
  ].join("\n");
  assert.equal(content2, expected2, "second call appends expected second section");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// Test 3: source-text check that autopilot.mjs calls browserCheckNotes(vv.review) exactly twice
const autopilotPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "autopilot.mjs");
const src = fs.readFileSync(autopilotPath, "utf8");
const matches = src.match(/browserCheckNotes\(vv\.review\)/g) || [];
assert.equal(matches.length, 2, "autopilot.mjs calls browserCheckNotes(vv.review) exactly twice");

console.log("manual checks tests passed");
