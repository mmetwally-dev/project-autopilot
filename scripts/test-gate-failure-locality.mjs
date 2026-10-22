#!/usr/bin/env node
// Mission 073 Phase 1 tasks 1.1+1.2 — smoke-check plus full case matrix for
// the pure gate-failure-locality helpers: classify/parse/link/format.
// Pure module: no filesystem, process, or state-file access, no exit hooks.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  classifyGateFailures,
  parseGateFailures,
  taskLinkedTestFiles,
  formatGateFailureEscalation,
} from "./gate-failure-locality.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

check("exports classifyGateFailures", typeof classifyGateFailures === "function");
check("exports parseGateFailures", typeof parseGateFailures === "function");
check("exports taskLinkedTestFiles", typeof taskLinkedTestFiles === "function");
check("exports formatGateFailureEscalation", typeof formatGateFailureEscalation === "function");

// ── Purity: no filesystem/state access, no exit hooks ──
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "gate-failure-locality.mjs"), "utf8");
  for (const token of [
    "node:fs", "node:child_process", "node:net", "node:http", "node:https",
    "process.", "new Date(", "writeFileSync", "readFileSync", "renameSync",
    "spawnSync", "execSync", "fetch(", "XMLHttpRequest", "process.exit",
  ]) {
    check(`pure: no ${token}`, !source.includes(token), token);
  }
  const codeOnly = source.replace(/\/\/.*$/gm, "");
  check("pure: no module imports", !/^\s*import\s/m.test(codeOnly), "import statement found");
}

// ── classify: all-outside / mixed / all-inside / empty / truncated / task-linked ──
{
  const all = classifyGateFailures({
    failingFiles: ["scripts/old-test.mjs"],
    phaseDeltaFiles: ["scripts/new-feature.mjs"],
  });
  check("classify: all-outside-delta",
    all.allOutsideDelta === true &&
    JSON.stringify(all.outside) === JSON.stringify(["scripts/old-test.mjs"]) &&
    all.inside.length === 0, all);

  const mixed = classifyGateFailures({
    failingFiles: ["scripts/old-test.mjs", "scripts/new-feature.mjs"],
    phaseDeltaFiles: ["scripts/new-feature.mjs"],
  });
  check("classify: mixed yields false with inside+outside split",
    mixed.allOutsideDelta === false &&
    JSON.stringify(mixed.outside) === JSON.stringify(["scripts/old-test.mjs"]) &&
    JSON.stringify(mixed.inside) === JSON.stringify(["scripts/new-feature.mjs"]), mixed);

  const inside = classifyGateFailures({
    failingFiles: ["scripts/new-feature.mjs"],
    phaseDeltaFiles: ["scripts/new-feature.mjs"],
  });
  check("classify: all-inside yields false",
    inside.allOutsideDelta === false &&
    inside.outside.length === 0 &&
    JSON.stringify(inside.inside) === JSON.stringify(["scripts/new-feature.mjs"]), inside);

  check("classify: empty failingFiles yields false",
    classifyGateFailures({failingFiles: [], phaseDeltaFiles: []}).allOutsideDelta === false);
  check("classify: truncated yields false",
    classifyGateFailures({failingFiles: ["a.mjs"], phaseDeltaFiles: ["b.mjs"], truncated: true}).allOutsideDelta === false);

  // A test file named by a phase task unions into the delta, so it counts
  // as inside and blocks escalation.
  const linked = taskLinkedTestFiles([
    {file: "TASKS.md", line: 1, text: "Fix it; verify: node scripts/test-linked.mjs"},
  ]);
  const linkedCase = classifyGateFailures({
    failingFiles: ["scripts/test-linked.mjs"],
    phaseDeltaFiles: ["scripts/other.mjs", ...linked],
  });
  check("classify: task-linked test file counts as inside",
    linkedCase.allOutsideDelta === false &&
    linkedCase.outside.length === 0 &&
    JSON.stringify(linkedCase.inside) === JSON.stringify(["scripts/test-linked.mjs"]), linkedCase);
}

// ── parse: keep-going summary (with/without shard), TEST FAILED fallback, truncated, unparseable ──
{
  const sharded = parseGateFailures(
    "1 test file(s) failed (--keep-going):\n- scripts/old-test.mjs [1/2]: FAIL stale assertion\n",
  );
  check("parse: summary line with shard suffix",
    sharded.truncated === false && sharded.failures.length === 1 &&
    sharded.failures[0].file === "scripts/old-test.mjs" &&
    sharded.failures[0].firstCheck === "FAIL stale assertion", sharded);

  const plain = parseGateFailures(
    "2 test file(s) failed (--keep-going):\n- scripts/a.mjs: FAIL first check\n- scripts/b.mjs: FAIL second check\n",
  );
  check("parse: summary lines without shard suffix",
    plain.truncated === false && plain.failures.length === 2 &&
    plain.failures[0].file === "scripts/a.mjs" &&
    plain.failures[0].firstCheck === "FAIL first check" &&
    plain.failures[1].file === "scripts/b.mjs" &&
    plain.failures[1].firstCheck === "FAIL second check", plain);

  const fallbackLine = "TEST FAILED: scripts/other.mjs  [2/2]";
  const fallback = parseGateFailures(`${fallbackLine}\n`);
  check("parse: TEST FAILED fallback with line as firstCheck",
    fallback.failures.length === 1 && fallback.failures[0].file === "scripts/other.mjs" &&
    fallback.failures[0].firstCheck === fallbackLine, fallback);

  const stopped = parseGateFailures(
    "1 test file(s) failed (--keep-going):\n- scripts/a.mjs: FAIL x\nReached --max-failures, stopping early\n",
  );
  check("parse: Reached --max-failures yields truncated true",
    stopped.truncated === true && stopped.failures.length === 1 &&
    stopped.failures[0].file === "scripts/a.mjs", stopped);

  const garbage = parseGateFailures("all green, nothing to see here\nok 3 passed\n");
  check("parse: unparseable log yields empty failures",
    garbage.truncated === false && Array.isArray(garbage.failures) && garbage.failures.length === 0, garbage);

  // ── Mission 073 reviewer regression: assertion-diff `- key: value` lines
  // in test output must never parse as failing files ──
  {
    const diffWithSummary = parseGateFailures(
      "not ok 1 - should match\n- a: 2\n- b: 3\n+ expected: 4\nTEST FAILED: scripts/test-new-feature.mjs [1/3]\n2 test file(s) failed (--keep-going):\n- scripts/test-new-feature.mjs [1/3]: FAIL should match\n",
    );
    check("parse: diff lines before summary header are not files",
      diffWithSummary.failures.length === 1 &&
      diffWithSummary.failures[0].file === "scripts/test-new-feature.mjs" &&
      diffWithSummary.failures[0].firstCheck === "FAIL should match" &&
      !diffWithSummary.failures.some((f) => f.file === "a" || f.file === "b"), diffWithSummary);
    check("parse: own-test failure inside delta never escalates",
      classifyGateFailures({
        failingFiles: diffWithSummary.failures.map((f) => f.file),
        phaseDeltaFiles: ["scripts/test-new-feature.mjs"],
      }).allOutsideDelta === false, diffWithSummary);

    const diffNoSummary = parseGateFailures(
      "not ok 1 - should match\n- a: 2\n- expected: 4\nTEST FAILED: scripts/test-new-feature.mjs [1/3]\n",
    );
    check("parse: diff lines without summary block fall back to TEST FAILED only",
      diffNoSummary.failures.length === 1 &&
      diffNoSummary.failures[0].file === "scripts/test-new-feature.mjs" &&
      !diffNoSummary.failures.some((f) => f.file === "a" || f.file === "expected"), diffNoSummary);
  }
}

// ── task-linked files: from task text/verify, gate commands never passed ──
{
  const linked = taskLinkedTestFiles([
    {file: "TASKS.md", line: 3, text: "Do x; verify: node scripts/test-linked.mjs"},
  ]);
  check("linked: verify command file", JSON.stringify(linked) === JSON.stringify(["scripts/test-linked.mjs"]), linked);

  const both = taskLinkedTestFiles([
    {file: "TASKS.md", line: 1, text: "Cover scripts/test-from-text.mjs in the fix"},
    {file: "TASKS.md", line: 2, text: "Other work", verify: "node scripts/test-from-verify.mjs"},
    {file: "TASKS.md", line: 3, text: "Repeat node scripts/test-from-text.mjs again"},
  ]);
  check("linked: files from task text and verify, deduped in order",
    JSON.stringify(both) === JSON.stringify(["scripts/test-from-text.mjs", "scripts/test-from-verify.mjs"]), both);

  // Phase tasks only: the gate command (e.g. scripts/test-all.mjs) is never
  // passed to taskLinkedTestFiles, so gate files stay out of the delta union.
  const phaseOnly = taskLinkedTestFiles([
    {file: "TASKS.md", line: 1, text: "Fix; verify: node scripts/test-phase.mjs"},
  ]);
  check("linked: gate commands excluded",
    JSON.stringify(phaseOnly) === JSON.stringify(["scripts/test-phase.mjs"]) &&
    !phaseOnly.includes("scripts/test-all.mjs"), phaseOnly);
}

// ── formatter: file list, first check, stale hint, ap run line ──
{
  const message = formatGateFailureEscalation({
    failures: [{file: "scripts/old-test.mjs", firstCheck: "FAIL stale assertion"}],
    phaseName: "Phase 1",
  });
  check("format: names the file and first check",
    message.includes("scripts/old-test.mjs") && message.includes("FAIL stale assertion"), message);
  check("format: stale hint and ap run line",
    /stale/i.test(message) && message.includes("ap run"), message);

  const multi = formatGateFailureEscalation({
    failures: [
      {file: "scripts/old-test.mjs", firstCheck: "FAIL stale assertion"},
      {file: "scripts/other.mjs", firstCheck: "TEST FAILED: scripts/other.mjs"},
    ],
    phaseName: "Phase 1",
    mission: "073-fix-backlog-item",
  });
  check("format: multi-file list keeps every file and check",
    multi.includes("scripts/old-test.mjs") && multi.includes("FAIL stale assertion") &&
    multi.includes("scripts/other.mjs") && multi.includes("TEST FAILED: scripts/other.mjs"), multi);
  check("format: multi-file stale hint and ap run line",
    /stale/i.test(multi) && multi.includes("ap run"), multi);
}

// ── Mission 073 task 1.3: source contract — escalate-once wiring in the
// STANDALONE verifier-stage FAIL fallthrough (SpecKit untouched) ──
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const auto = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  check("wire: autopilot imports classifyGateFailures from gate-failure-locality",
    auto.includes("classifyGateFailures") && /from ["']\.\/gate-failure-locality\.mjs["']/.test(auto), "import missing");
  check("wire: autopilot imports parse/taskLinked/formatter helpers",
    auto.includes("parseGateFailures") && auto.includes("taskLinkedTestFiles") && auto.includes("formatGateFailureEscalation"), "helper import missing");
  const marker = "Mission 073 Phase 1 task 1.3";
  const markerAt = auto.indexOf(marker);
  const stepToken = 's.step="standalone_gate_unrelated_failures"';
  const stepAt = auto.indexOf(stepToken);
  check("wire: FAIL fallthrough escalates as standalone_gate_unrelated_failures",
    markerAt >= 0 && stepAt > markerAt, {markerAt, stepAt});
  check("wire: escalation is STANDALONE-only (single site, no SpecKit twin)",
    stepAt >= 0 && auto.indexOf(stepToken, stepAt + 1) < 0, "step appears more than once");
  const recordToken = "recordPhaseFindingTasks(phaseKey,rawReviewFindings(vv),true)";
  const recordAfter = auto.indexOf(recordToken, stepAt);
  const classifyCall = auto.indexOf("classifyGateFailures({", markerAt);
  check("wire: classifyGateFailures called in the FAIL fallthrough before recordPhaseFindingTasks",
    classifyCall > markerAt && recordAfter > classifyCall && stepAt < recordAfter,
    {classifyCall, stepAt, recordAfter});
  check("wire: escalates only when allOutsideDelta and no import makes it local",
    /if\s*\(\s*locality\.allOutsideDelta\s*&&\s*!importLocality\s*\)/.test(auto.slice(markerAt, recordAfter)), "allOutsideDelta guard missing");
  check("wire: gate-red guard precedes the locality check",
    auto.slice(markerAt, classifyCall).includes("g&&g.ok===false") || auto.slice(markerAt, classifyCall).includes("g && g.ok === false"), "red-gate guard missing");
  check("wire: delta unions scopedDeltaChunks paths with taskLinkedTestFiles(phaseTasks)",
    auto.slice(markerAt, recordAfter).includes("scopedDeltaChunks(repo,phaseBaselineKey,{mission,declaredPaths}).map(c=>c.path)") &&
    auto.slice(markerAt, recordAfter).includes("taskLinkedTestFiles(phaseTasks)"), "delta union missing");
  check("wire: no new checkpoint state on the escalate path",
    !auto.slice(markerAt, recordAfter).includes("CHECKPOINT_STATE_KEY"), "checkpoint touched");
}

// ── Backlog #89: source-scanning tests and failure output name delta files ──
{
  const delta = ["scripts/autopilot.mjs", "scripts/adhoc-new.mjs"];
  const base = {phaseDeltaFiles: delta};
  const a1 = classifyGateFailures({...base, failingFiles: ["scripts/test-x.mjs"],
    testSources: {"scripts/test-x.mjs": 'const t = fs.readFileSync("scripts/autopilot.mjs","utf8");'}});
  check("89a: relative-path source reference is related", a1.allOutsideDelta === false && a1.inside.length === 1, a1);
  const a2 = classifyGateFailures({...base, failingFiles: ["scripts/test-x.mjs"],
    testSources: {"scripts/test-x.mjs": 'path.join(here, "autopilot.mjs")'}});
  check("89a: basename source reference is related", a2.allOutsideDelta === false, a2);
  const a3 = classifyGateFailures({...base, failingFiles: ["scripts/test-x.mjs"],
    testSources: {"scripts/test-x.mjs": 'for (const f of fs.readdirSync(path.join(root, "scripts"))) scan(f)'}});
  check("89a: directory scan covering a NEW delta file is related", a3.allOutsideDelta === false, a3);
  const b1 = classifyGateFailures({...base, failingFiles: ["scripts/test-y.mjs"],
    failureText: "AssertionError at scripts/adhoc-new.mjs:1298\n"});
  check("89b: failure output naming a delta file is related", b1.allOutsideDelta === false && b1.related.length === 1, b1);
  const u = classifyGateFailures({...base, failingFiles: ["scripts/test-z.mjs"],
    testSources: {"scripts/test-z.mjs": 'import x from "./other.mjs"; readdirSync("docs")'},
    failureText: "AssertionError at scripts/other.mjs:3\n"});
  check("89: genuinely unrelated failure still escalates", u.allOutsideDelta === true && u.outside.length === 1, u);
  const u2 = classifyGateFailures({...base, failingFiles: ["scripts/test-z.mjs"],
    testSources: {"scripts/test-z.mjs": 'mentions my-autopilot.mjs.bak and autopilot.mjsx'}});
  check("89: partial-name text does not match", u2.allOutsideDelta === true, u2);
}

console.log(`\n${ok} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);