import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boundDeltaChunks, boundDeltaChunksDetail, diffLineCounts, DEFAULT_DELTA_BUDGET_CHARS } from "./implementation-baseline.mjs";
import { buildStandaloneHandoff } from "./standalone-handoff.mjs";

console.log("Running bound review delta tests...");

const testDir = path.resolve(".autopilot", "test-bound-delta-" + Date.now());
fs.mkdirSync(testDir, { recursive: true });

try {
  // 0. DEFAULT_DELTA_BUDGET_CHARS constant check (180_000 chars = 225000 * 0.4 * 2)
  assert.equal(DEFAULT_DELTA_BUDGET_CHARS, 180_000, "DEFAULT_DELTA_BUDGET_CHARS should be 180_000 chars (2 chars/token for diffs, 40% of 225K wrap-up)");

  // 1. diffLineCounts
  {
    const sample = [
      "diff --git a/file.js b/file.js",
      "--- a/file.js",
      "+++ b/file.js",
      "@@ -1,3 +1,4 @@",
      "-old line 1",
      "-old line 2",
      "+new line 1",
      "+new line 2",
      "+new line 3",
      " context line"
    ].join("\n");
    const counts = diffLineCounts(sample);
    assert.equal(counts.added, 3, "added line count should be 3");
    assert.equal(counts.removed, 2, "removed line count should be 2");
  }

  // 2. Small delta: unchanged behaviour (inlined exactly as before)
  {
    const smallChunks = [
      { path: "src/alpha.js", text: "diff --git a/src/alpha.js b/src/alpha.js\n+added 1\n-removed 1" },
      { path: "src/beta.js", text: "diff --git a/src/beta.js b/src/beta.js\n+added 2" },
    ];
    const expectedInline = smallChunks.map(c => c.text).join("\n");
    const result = boundDeltaChunks(smallChunks, { dir: testDir, budget: 10000 });
    assert.equal(result, expectedInline, "small delta should be inlined exactly as before");

    const detail = boundDeltaChunksDetail(smallChunks, { dir: testDir, budget: 10000 });
    assert.equal(detail.bounded, false, "detail.bounded should be false for small delta");
    assert.equal(detail.text, expectedInline, "detail.text should match inlined delta");
    assert.equal(detail.filePath, null, "detail.filePath should be null for small delta");
  }

  // 3. Large delta: under budget, names delta file, file contains full delta
  {
    const largeChunks = [
      { path: "src/b_file.js", text: "diff --git a/src/b_file.js b/src/b_file.js\n" + "+line\n".repeat(100) },
      { path: "src/a_file.js", text: "diff --git a/src/a_file.js b/src/a_file.js\n" + "+line\n".repeat(100) },
      { path: "src/c_file.js", text: "diff --git a/src/c_file.js b/src/c_file.js\n" + "-line\n".repeat(50) },
    ];
    const fullExpectedDelta = largeChunks.map(c => c.text).join("\n");
    const budget = 500; // Force over budget

    const detail = boundDeltaChunksDetail(largeChunks, {
      dir: testDir,
      budget,
      role: "code_reviewer",
      kind: "FIX"
    });

    assert.equal(detail.bounded, true, "detail.bounded should be true for large delta");
    assert.ok(detail.text.length < fullExpectedDelta.length, "bounded text length must be smaller than full delta");
    assert.ok(detail.filePath, "detail.filePath must be set");
    assert.ok(fs.existsSync(detail.filePath), "delta file must exist on disk");

    const fileContent = fs.readFileSync(detail.filePath, "utf8");
    assert.equal(fileContent, fullExpectedDelta, "file on disk must contain the complete, unmodified full delta");

    // Check bounded text content
    assert.ok(detail.text.includes(detail.filePath), "bounded text must name the delta file path");
    assert.ok(detail.text.includes("Read"), "bounded text must tell reviewer to read selectively");
    assert.ok(detail.text.includes("- src/a_file.js (+100/-0)"), "must list sorted files with line counts (a_file first)");
    assert.ok(detail.text.includes("- src/b_file.js (+100/-0)"), "must list sorted files with line counts (b_file second)");
    assert.ok(detail.text.includes("- src/c_file.js (+0/-50)"), "must list sorted files with line counts (c_file third)");
    // Verify sorting: a_file comes before b_file
    const idxA = detail.text.indexOf("src/a_file.js");
    const idxB = detail.text.indexOf("src/b_file.js");
    assert.ok(idxA < idxB, "file list must be sorted by path");
  }

  // 4. Standalone loop integration: small delta vs large delta in buildStandaloneHandoff
  {
    const phaseTasks = [{ file: path.join(testDir, "TASKS.md"), line: 10, text: "Do task" }];
    const smallChunks = [
      { path: "src/small.js", text: "diff --git a/src/small.js b/src/small.js\n+small" }
    ];

    // Standalone small delta
    const handoffSmall = buildStandaloneHandoff({
      kind: "PHASE_REREVIEW",
      phaseName: "Phase 1",
      phaseIndex: 0,
      phaseTotal: 1,
      phaseTasks,
      attempt: 1,
      deltaChunks: smallChunks,
      baselineKey: "base-k",
      declaredPaths: [],
      implementationSummary: "done"
    });
    assert.ok(handoffSmall.text.includes("diff --git a/src/small.js b/src/small.js\n+small"), "small delta inlined exactly as before in standalone");

    // Standalone large delta with boundDeltaChunksDetail
    const largeChunks = Array.from({ length: 30 }, (_, i) => ({
      path: `src/mod_${String(i).padStart(2, "0")}.js`,
      text: `diff --git a/src/mod_${i}.js b/src/mod_${i}.js\n` + "+line\n".repeat(150)
    }));
    const fullLargeDelta = largeChunks.map(c => c.text).join("\n");
    const budget = 2000;

    const detail = boundDeltaChunksDetail(largeChunks, {
      dir: testDir,
      budget,
      role: "code_reviewer",
      kind: "FIX"
    });
    assert.equal(detail.bounded, true);

    const effectiveChunks = detail.bounded
      ? [{ path: detail.filePath, text: detail.text }]
      : largeChunks;

    const handoffLarge = buildStandaloneHandoff({
      kind: "PHASE_REREVIEW",
      phaseName: "Phase 1",
      phaseIndex: 0,
      phaseTotal: 1,
      phaseTasks,
      attempt: 1,
      deltaChunks: effectiveChunks,
      baselineKey: "base-k",
      declaredPaths: [],
      implementationSummary: "done"
    });

    assert.ok(handoffLarge.text.includes(detail.filePath), "standalone handoff must name the delta file");
    assert.ok(handoffLarge.text.includes("src/mod_00.js (+150/-0)"), "standalone handoff must include file list");
    assert.ok(!handoffLarge.text.includes("+line\n".repeat(50)), "standalone handoff must NOT inline full large delta");
    assert.equal(fs.readFileSync(detail.filePath, "utf8"), fullLargeDelta, "delta file contains full delta");
  }

  // 5. SpecKit loop integration: small delta vs large delta
  {
    const smallChunks = [
      { path: "src/speckit_small.js", text: "diff --git a/src/speckit_small.js b/src/speckit_small.js\n+speckit" }
    ];
    const smallBody = boundDeltaChunks(smallChunks, { dir: testDir, budget: 10000, emptyPlaceholder: "The fix changed no files." });
    assert.equal(smallBody, smallChunks[0].text, "speckit small delta inlined exactly as before");

    const largeChunks = Array.from({ length: 25 }, (_, i) => ({
      path: `src/speckit_${String(i).padStart(2, "0")}.js`,
      text: `diff --git a/src/speckit_${i}.js b/src/speckit_${i}.js\n` + "+speckit_line\n".repeat(120)
    }));
    const fullSpecDelta = largeChunks.map(c => c.text).join("\n");
    const budget = 1500;
    const largeDetail = boundDeltaChunksDetail(largeChunks, { dir: testDir, budget, role: "code_reviewer", kind: "FIX" });
    assert.equal(largeDetail.bounded, true);
    assert.ok(largeDetail.text.includes(largeDetail.filePath), "speckit prompt text names delta file");
    assert.ok(largeDetail.text.includes("Changed files (25):"), "speckit prompt text includes file counts");
    assert.equal(fs.readFileSync(largeDetail.filePath, "utf8"), fullSpecDelta, "speckit delta file contains full delta");
  }

  // 6. Default budget (180,000 chars): under 180K inlines, over 180K bounds
  {
    // Under 180,000 chars: ~50KB delta
    const underChunks = [
      { path: "src/under.js", text: "diff --git a/src/under.js b/src/under.js\n" + "+line\n".repeat(5000) } // ~30KB
    ];
    const underDetail = boundDeltaChunksDetail(underChunks, { dir: testDir });
    assert.equal(underDetail.bounded, false, "delta under 180,000 chars must be inlined by default");
    assert.equal(underDetail.text, underChunks[0].text);

    // Over 180,000 chars: ~220KB delta
    const overChunks = [
      { path: "src/over.js", text: "diff --git a/src/over.js b/src/over.js\n" + "+long_line_for_testing_delta_bounding\n".repeat(6000) } // ~222KB
    ];
    assert.ok(overChunks[0].text.length > 180_000, "overChunks must exceed 180,000 chars");
    const overDetail = boundDeltaChunksDetail(overChunks, { dir: testDir });
    assert.equal(overDetail.bounded, true, "delta over 180,000 chars must be bounded by default");
    assert.ok(overDetail.text.includes(overDetail.filePath), "must name delta file");
    assert.equal(fs.readFileSync(overDetail.filePath, "utf8"), overChunks[0].text, "file must contain full delta");
  }

  console.log("All bound review delta tests PASSED!");
} finally {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
}
