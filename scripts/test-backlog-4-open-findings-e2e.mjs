#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executionEnvelopeContext } from "./execution-envelope.mjs";
import {
  makeFixtureRepo,
  makeFixtureBin,
  makeSpecKitWorkflowOnly,
  setScenario,
  writeConfig,
  runAutopilot,
  cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import { fixtureGit } from "./test-fixtures/fixture-git.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "..");

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}

// Completed runs of a role, chronological, with the brief the role received.
function runs(repo, role) {
  const out = [];
  for (const f of walk(path.join(repo, ".autopilot"))) {
    if (path.basename(f) !== "result.json") continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    if (role && data.role !== role) continue;
    const dir = path.dirname(f);
    const briefFile = path.join(dir, "brief.txt");
    let note = null;
    try {
      note = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).note ?? null;
    } catch {
      note = null;
    }
    out.push({
      dir,
      role: data.role || null,
      data,
      decision: data.verdict?.decision ?? null,
      startedAt: Date.parse(data.startedAt) || 0,
      finishedAt: Date.parse(data.finishedAt) || 0,
      note,
      brief: fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8") : "",
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt || a.finishedAt - b.finishedAt);
}

function installScriptedCodeReviewer(binDir) {
  const target = path.join(binDir, "cursor-agent");
  const src = fs.readFileSync(target, "utf8");
  const anchor = src.indexOf('\nSCENARIO="success"');
  if (anchor < 0) throw new Error('fake adapter layout changed: anchor SCENARIO="success" not found');
  const prelude = `
if [ "$ROLE" = "code_reviewer" ] && [ -f ./.autopilot/.cr-script ]; then
  _n=$(find ./.autopilot -name status.json -exec grep -l '"role": *"code_reviewer"' {} + 2>/dev/null | wc -l)
  _n=$(( _n + 0 ))
  if [ "$_n" -ge 1 ]; then
    _line=$(sed -n "$_n"p ./.autopilot/.cr-script)
  else
    _line=""
  fi
  if [ -n "$_line" ]; then
    printf '%s\\n' "$_line"
  else
    printf 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}\\n'
  fi
  exit 0
fi`;
  fs.writeFileSync(target, src.slice(0, anchor) + prelude + src.slice(anchor));
  fs.chmodSync(target, 0o755);
}

function makeTestBin(prefix) {
  const binDir = makeFixtureBin(prefix);
  installScriptedCodeReviewer(binDir);
  return binDir;
}

function setScript(repo, lines) {
  fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".autopilot", ".cr-script"), lines.join("\n") + "\n");
  const addRes = fixtureGit(["add", "-f", ".autopilot/.cr-script"], { cwd: repo });
  if (addRes.status !== 0) throw new Error(`git add .cr-script failed: ${(addRes.stderr || addRes.stdout || "").trim()}`);
  const commitRes = fixtureGit(["commit", "-q", "-m", "code reviewer script"], { cwd: repo });
  if (commitRes.status !== 0) throw new Error(`git commit .cr-script failed: ${(commitRes.stderr || commitRes.stdout || "").trim()}`);
}

function writeTestConfig(repo, framework) {
  writeConfig(repo, {
    planningFramework: framework,
    maxPlanRevisions: 3,
    failureBudgets: { implementationFailureBudget: 5, verificationFailureBudget: 5 },
    networkIsolation: false,
  });
  const cfgPath = path.join(repo, ".autopilot", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.workflow.finalReview = false;
  cfg.workflow.final_review = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

// Active feedback portion of an implementer brief, excluding the trailing
// "Findings from ALL earlier code-review rounds" historical keep-fixed section.
function activeImplFeedback(brief) {
  return String(brief || "").split("Findings from ALL earlier code-review rounds")[0];
}

console.log("=== Part 1: Static wiring verification (autopilot.mjs) ===");
{
  const autoSrc = fs.readFileSync(path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8");

  // Imports
  assert.ok(autoSrc.includes("updateReviewOpenFindings"), "autopilot.mjs must import updateReviewOpenFindings");
  assert.ok(autoSrc.includes("formatReviewOpenFindingsBrief"), "autopilot.mjs must import formatReviewOpenFindingsBrief");
  assert.ok(autoSrc.includes("loadReviewOpenFindings"), "autopilot.mjs must import loadReviewOpenFindings");
  assert.ok(!autoSrc.includes("handleReviewPassConfirmation"), "autopilot.mjs must not contain handleReviewPassConfirmation");
  assert.ok(!autoSrc.includes("reviewConfirmationPending"), "autopilot.mjs must not contain reviewConfirmationPending");

  // Standalone loop wiring
  assert.ok(autoSrc.includes("const openResult=updateReviewOpenFindings(s,phaseKey,{"), "standalone loop must call updateReviewOpenFindings at FAIL site");
  assert.ok(autoSrc.includes("const prevCheck=await enforceRereviewPreviousOnPass({"), "standalone loop must enforce previous on pass");

  // SpecKit loop wiring
  assert.ok(autoSrc.includes("const openResult=updateReviewOpenFindings(s,speckitPhaseKey,{"), "speckit loop must call updateReviewOpenFindings at FAIL site");
  assert.ok(autoSrc.includes("const prevCheck=await enforceRereviewPreviousOnPass({"), "speckit loop must enforce previous on pass");

  console.log("PASS static wiring verification");
}

console.log("\n=== Part 2: End-to-end fixture missions ===");

// Check if bubblewrap is usable in this environment
const bwrapCtx = executionEnvelopeContext({ repo: process.cwd() });
const bwrapAvailable = bwrapCtx?.mechanism?.available === true;

if (!bwrapAvailable && process.env.FORCE_E2E !== "1") {
  console.log("NOTICE: Bubblewrap is unavailable in this environment (bwrap cannot create user namespaces in container).");
  console.log("Read-only roles (code_reviewer) require bwrap on Linux.");
  console.log("Static wiring verification PASSED. Run this script on the host to execute live subprocess missions.");
  process.exit(0);
}

for (const framework of ["standalone", "speckit"]) {
  console.log(`\n--- Testing framework: ${framework} ---`);

  // Case 1: Main scenario (3 review rounds)
  // Round 1: FAIL with two findings (F1 on T1, F2 on T2)
  // Round 2: FAIL with NEW finding F3 on T2 and previous: F1 fixed, F2 missing -> F2 carried
  // Round 3: PASS with previous statuses for all listed (F2 and F3) -> no extra review run
  {
    console.log(`[${framework}] Running Case 1: 3 rounds with carried finding F2 and clean PASS`);
    const repo = makeFixtureRepo(`b4-${framework}-main`);
    const binDir = makeTestBin(`b4-${framework}-main`);
    try {
      if (framework === "speckit") makeSpecKitWorkflowOnly(repo);
      writeTestConfig(repo, framework);
      setScenario(repo, "findings_per_task");

      const round1Verdict = JSON.stringify({
        decision: "FAIL",
        findings: [
          { tasks: ["T1"], location: "output/carry-T0.txt:1", problem: "Finding F1 on task T1", correction: "Fix F1 on task T1" },
          { tasks: ["T2"], location: "output/carry-T1.txt:1", problem: "Finding F2 on task T2", correction: "Fix F2 on task T2" },
        ],
      });

      const round2Verdict = JSON.stringify({
        decision: "FAIL",
        findings: [
          { tasks: ["T2"], location: "output/carry-T1.txt:1", problem: "Finding F3 on task T2", correction: "Fix F3 on task T2" },
        ],
        previous: [
          { finding: "Finding F1 on task T1", status: "fixed" },
        ],
      });

      const round3Verdict = JSON.stringify({
        decision: "PASS",
        findings: [],
        previous: [
          { finding: "Finding F2 on task T2", status: "fixed" },
          { finding: "Finding F3 on task T2", status: "fixed" },
        ],
      });

      setScript(repo, [
        `AUTOPILOT_REVIEW=${round1Verdict}`,
        `AUTOPILOT_REVIEW=${round2Verdict}`,
        `AUTOPILOT_REVIEW=${round3Verdict}`,
      ]);

      const runResult = runAutopilot(repo, binDir, { request: "implement the fixture task", timeoutMs: 180000 });
      const crRuns = runs(repo, "code_reviewer");
      const implRuns = runs(repo, "implementer");

      // 1. Mission completed (exit 0)
      assert.equal(runResult.status, 0, `${framework}: autopilot mission must exit 0. Details:\n${(runResult.stderr || runResult.stdout || "").slice(-2000)}`);

      // 2. Exactly 3 code_reviewer runs (no extra confirmation review run)
      assert.equal(crRuns.length, 3, `${framework}: must have exactly 3 code_reviewer runs, got ${crRuns.length}`);

      // 3. Round 1 FAIL and Round 2 FAIL
      assert.equal(crRuns[0].decision, "FAIL", `${framework}: round 1 reviewer must FAIL`);
      assert.equal(crRuns[1].decision, "FAIL", `${framework}: round 2 reviewer must FAIL`);

      // 4. Assert round-3 code-review prompt lists F2 and F3 as still-open with their IDs, not F1
      const r3Brief = crRuns[2].brief;
      assert.ok(r3Brief.includes("F2:"), `${framework}: round-3 code-review prompt must list F2`);
      assert.ok(r3Brief.includes("Finding F2 on task T2"), `${framework}: round-3 code-review prompt must contain F2 finding text`);
      assert.ok(r3Brief.includes("F3:"), `${framework}: round-3 code-review prompt must list F3`);
      assert.ok(r3Brief.includes("Finding F3 on task T2"), `${framework}: round-3 code-review prompt must contain F3 finding text`);
      assert.ok(!r3Brief.includes("F1:"), `${framework}: round-3 code-review prompt must NOT list resolved F1 as open`);
      assert.ok(!r3Brief.includes("Finding F1 on task T1"), `${framework}: round-3 code-review prompt must NOT contain resolved F1 text`);

      // 5. Assert the implementer re-run brief after round 2 FAIL contains F2 and F3, not F1
      const reRunImpls = implRuns.filter(r => r.startedAt >= crRuns[1].startedAt);
      assert.ok(reRunImpls.length > 0, `${framework}: must have at least one implementer run after round 2 FAIL`);
      assert.ok(reRunImpls.some(r => activeImplFeedback(r.brief).includes("Finding F2 on task T2")), `${framework}: implementer re-run brief must contain F2's text`);
      assert.ok(reRunImpls.some(r => activeImplFeedback(r.brief).includes("Finding F3 on task T2")), `${framework}: implementer re-run brief must contain F3's text`);
      assert.ok(reRunImpls.every(r => !activeImplFeedback(r.brief).includes("Finding F1 on task T1")), `${framework}: implementer re-run active feedback must NOT contain resolved F1`);

      // 6. Round 3 reviewer PASS cleanly accepted without extra confirmation review
      assert.equal(crRuns[2].decision, "PASS", `${framework}: round 3 reviewer must report PASS`);

      console.log(`PASS [${framework}] Case 1: 3 rounds with carried finding F2 and clean PASS`);
    } finally {
      cleanup(repo, binDir);
    }
  }

  // Case 2: Round 2 marks F2 not_fixed -> carried
  {
    console.log(`[${framework}] Running Case 2: round 2 marks F2 not_fixed -> carried`);
    const repo = makeFixtureRepo(`b4-${framework}-notfixed`);
    const binDir = makeTestBin(`b4-${framework}-notfixed`);
    try {
      if (framework === "speckit") makeSpecKitWorkflowOnly(repo);
      writeTestConfig(repo, framework);
      setScenario(repo, "findings_per_task");

      const round1Verdict = JSON.stringify({
        decision: "FAIL",
        findings: [
          { tasks: ["T1"], location: "output/carry-T0.txt:1", problem: "Finding F1 on task T1", correction: "Fix F1 on task T1" },
          { tasks: ["T2"], location: "output/carry-T1.txt:1", problem: "Finding F2 on task T2", correction: "Fix F2 on task T2" },
        ],
      });

      const round2Verdict = JSON.stringify({
        decision: "FAIL",
        findings: [
          { tasks: ["T2"], location: "output/carry-T1.txt:1", problem: "Finding F3 on task T2", correction: "Fix F3 on task T2" },
        ],
        previous: [
          { finding: "Finding F1 on task T1", status: "fixed" },
          { finding: "Finding F2 on task T2", status: "not_fixed" },
        ],
      });

      const round3Verdict = JSON.stringify({
        decision: "PASS",
        findings: [],
        previous: [
          { finding: "Finding F2 on task T2", status: "fixed" },
          { finding: "Finding F3 on task T2", status: "fixed" },
        ],
      });

      setScript(repo, [
        `AUTOPILOT_REVIEW=${round1Verdict}`,
        `AUTOPILOT_REVIEW=${round2Verdict}`,
        `AUTOPILOT_REVIEW=${round3Verdict}`,
      ]);

      const runResult = runAutopilot(repo, binDir, { request: "implement the fixture task", timeoutMs: 180000 });
      const crRuns = runs(repo, "code_reviewer");
      const implRuns = runs(repo, "implementer");

      assert.equal(runResult.status, 0, `${framework}: autopilot mission must exit 0. Details:\n${(runResult.stderr || runResult.stdout || "").slice(-2000)}`);
      assert.equal(crRuns.length, 3, `${framework}: must have exactly 3 code_reviewer runs, got ${crRuns.length}`);
      assert.equal(crRuns[0].decision, "FAIL", `${framework}: round 1 must FAIL`);
      assert.equal(crRuns[1].decision, "FAIL", `${framework}: round 2 must FAIL`);

      const r3Brief = crRuns[2].brief;
      assert.ok(r3Brief.includes("F2:"), `${framework}: round-3 prompt must list F2`);
      assert.ok(r3Brief.includes("Finding F2 on task T2"), `${framework}: round-3 prompt must contain F2 text`);
      assert.ok(r3Brief.includes("F3:"), `${framework}: round-3 prompt must list F3`);
      assert.ok(r3Brief.includes("Finding F3 on task T2"), `${framework}: round-3 prompt must contain F3 text`);
      assert.ok(!r3Brief.includes("F1:"), `${framework}: round-3 prompt must NOT list resolved F1`);
      assert.ok(!r3Brief.includes("Finding F1 on task T1"), `${framework}: round-3 prompt must NOT contain resolved F1 text`);

      const reRunImpls = implRuns.filter(r => r.startedAt >= crRuns[1].startedAt);
      assert.ok(reRunImpls.length > 0, `${framework}: must have at least one implementer run after round 2 FAIL`);
      assert.ok(reRunImpls.some(r => activeImplFeedback(r.brief).includes("Finding F2 on task T2")), `${framework}: implementer re-run brief must contain F2 text`);
      assert.ok(reRunImpls.some(r => activeImplFeedback(r.brief).includes("Finding F3 on task T2")), `${framework}: implementer re-run brief must contain F3 text`);
      assert.ok(reRunImpls.every(r => !activeImplFeedback(r.brief).includes("Finding F1 on task T1")), `${framework}: implementer re-run active feedback must NOT contain resolved F1`);
      assert.equal(crRuns[2].decision, "PASS", `${framework}: round 3 must report PASS`);

      console.log(`PASS [${framework}] Case 2: round 2 marks F2 not_fixed -> carried`);
    } finally {
      cleanup(repo, binDir);
    }
  }

  // Case 3: Short scenario (round 2 fixes all -> exactly 2 reviews, no confirmation run)
  {
    console.log(`[${framework}] Running Case 3: short case (round 2 fixes all -> 2 reviews)`);
    const repo = makeFixtureRepo(`b4-${framework}-short`);
    const binDir = makeTestBin(`b4-${framework}-short`);
    try {
      if (framework === "speckit") makeSpecKitWorkflowOnly(repo);
      writeTestConfig(repo, framework);
      setScenario(repo, "findings_per_task");

      const round1Verdict = JSON.stringify({
        decision: "FAIL",
        findings: [
          { tasks: ["T1"], location: "output/carry-T0.txt:1", problem: "Finding F1 on task T1", correction: "Fix F1 on task T1" },
          { tasks: ["T2"], location: "output/carry-T1.txt:1", problem: "Finding F2 on task T2", correction: "Fix F2 on task T2" },
        ],
      });

      const round2Verdict = JSON.stringify({
        decision: "PASS",
        findings: [],
        previous: [
          { finding: "Finding F1 on task T1", status: "fixed" },
          { finding: "Finding F2 on task T2", status: "fixed" },
        ],
      });

      setScript(repo, [
        `AUTOPILOT_REVIEW=${round1Verdict}`,
        `AUTOPILOT_REVIEW=${round2Verdict}`,
      ]);

      const runResult = runAutopilot(repo, binDir, { request: "implement the fixture task", timeoutMs: 180000 });
      const crRuns = runs(repo, "code_reviewer");

      assert.equal(runResult.status, 0, `${framework} (short): autopilot mission must exit 0. Details:\n${(runResult.stderr || runResult.stdout || "").slice(-2000)}`);
      assert.equal(crRuns.length, 2, `${framework} (short): must have exactly 2 code_reviewer runs, got ${crRuns.length}`);
      assert.equal(crRuns[0].decision, "FAIL", `${framework} (short): round 1 must FAIL`);
      assert.equal(crRuns[1].decision, "PASS", `${framework} (short): round 2 must PASS`);

      console.log(`PASS [${framework}] Case 3: short case (2 reviews)`);
    } finally {
      cleanup(repo, binDir);
    }
  }
}

console.log("\nAll backlog #4 end-to-end tests passed.");
