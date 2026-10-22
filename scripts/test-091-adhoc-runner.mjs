#!/usr/bin/env node
// Mission 091 task 2.2: adhoc runner coverage.
// Accept: runner order parse → --cmd capture → prompt → 2.1 entry (relay
// artifacts in adhoc dir) → 1.2 summary write → print, with a stubbed 2.1
// entry. Fixtures live under $TMPDIR, outside the project repo.
// Run: node scripts/test-091-adhoc-runner.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runAdhocCommand, extractAdhocVerdict } from "./adhoc-runner.mjs";

let failed = 0;
let ran = 0;
const check = (name, fn) => {
  ran++;
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(
      () => console.log(`PASS ${name}`),
      (e) => { failed++; console.log(`FAIL ${name} :: ${e?.message || String(e)}`); },
    );
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} :: ${e?.message || String(e)}`);
  }
};

const runnerPath = path.join(process.cwd(), "scripts", "adhoc-runner.mjs");
const runnerSrc = fs.readFileSync(runnerPath, "utf8");

// --- Static pins: helper order in the runner source -------------------------
check("runner module parses (node --check)", () => {
  const r = spawnSync(process.execPath, ["--check", runnerPath], { encoding: "utf8" });
  assert.equal(r.status, 0, `node --check failed: ${r.stderr || ""}`);
});

check("runner calls Phase 1 helpers + 2.1 entry in order", () => {
  const steps = [
    "parseAdhocArgs(",
    "runCmd(",
    "buildPrompt(",
    "entry(",
    "writeSummary(",
  ];
  let prev = -1;
  for (const s of steps) {
    const i = runnerSrc.indexOf(s);
    assert.ok(i !== -1, `runner must call ${s}`);
    assert.ok(i > prev, `${s} is out of order in adhoc-runner.mjs`);
    prev = i;
  }
  assert.ok(runnerSrc.includes("runAdhocReview"), "default entry must delegate to runAdhocReview");
  assert.ok(runnerSrc.includes('from "./adhoc-cmd-evidence.mjs"') && runnerSrc.includes("runAdhocCmd"), "1.4 --cmd helper must be the default runCmd");
  assert.ok(runnerSrc.includes('from "./adhoc-prompts.mjs"') && runnerSrc.includes("buildAdhocPrompt"), "1.3 prompt builder must be the default buildPrompt");
  assert.ok(runnerSrc.includes('from "./adhoc-summary.mjs"') && runnerSrc.includes("writeAdhocSummary"), "1.2 summary writer must be the default writeSummary");
});

check("extractAdhocVerdict reads verdict/review/top-level shapes", () => {
  assert.deepEqual(extractAdhocVerdict({ verdict: { decision: "PASS", findings: ["a"] } }), { verdict: "PASS", findings: ["a"] });
  assert.deepEqual(extractAdhocVerdict({ review: { decision: "FAIL", findings: ["b"] } }), { verdict: "FAIL", findings: ["b"] });
  assert.deepEqual(extractAdhocVerdict({ decision: "PASS", findings: ["c"] }), { verdict: "PASS", findings: ["c"] });
});

// --- Fixtures under $TMPDIR --------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "091-adhoc-runner-"));
const planFile = path.join(root, "PLAN.md");
fs.writeFileSync(planFile, "# Plan\n\nDo the thing.\n", "utf8");
const criteriaFile = path.join(root, "CRITERIA.md");
fs.writeFileSync(criteriaFile, "# Acceptance criteria\n\n- [ ] the thing works\n", "utf8");
const diffFile = path.join(root, "change.diff");
fs.writeFileSync(diffFile, "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n", "utf8");

const config = { roles: { plan_reviewer: { adapter: "fake" }, code_reviewer: { adapter: "fake" }, verifier: { adapter: "fake" } } };
const fixedNow = () => new Date("2026-01-01T00:00:00Z");
const okExec = () => ({ stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, signal: null });

// Stubbed 2.1 entry: records its args, writes relay artifacts as a nested
// NN-<role>-<id8>/ subdir inside the parent adhoc dir, returns a verdict.
function makeEntry(calls, { returnDir = true } = {}) {
  return async ({ role, prompt, adhocDir, repoRoot, config: c }) => {
    calls.push({ role, prompt, adhocDir, repoRoot, config: c });
    const nested = path.join(adhocDir, `01-${role}-a1b2c3d4`);
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "status.json"), JSON.stringify({ role }), "utf8");
    fs.writeFileSync(path.join(nested, "result.json"), JSON.stringify({ verdict: "PASS" }), "utf8");
    const res = { verdict: { decision: "PASS", findings: [`reviewed ${role}`] } };
    if (returnDir) res.nestedRunDir = nested;
    return res;
  };
}

// --- verify-file full order --------------------------------------------------
await check("verify-file: order parse→cmd→prompt→entry→summary→print", async () => {
  const calls = [];
  const events = [];
  const r = await runAdhocCommand("verify-file", [criteriaFile, "--cmd", "npm test"], {
    repoRoot: root,
    config,
    now: fixedNow,
    execFn: okExec,
    entry: makeEntry(calls),
    print: () => {},
    events,
  });
  assert.equal(r.ok, true, r.error || "not ok");
  assert.deepEqual(events, ["parse", "cmd", "prompt", "entry", "summary", "print"]);
});

  await check("verify-file: --cmd captured, prompt carries evidence, summary+print saved", async () => {
    const innerCalls = [];
    const innerEvents = [];
    const innerPrinted = [];
    const r = await runAdhocCommand("verify-file", [criteriaFile, "--cmd", "npm test"], {
      repoRoot: root,
      config,
      now: () => new Date("2026-01-01T00:00:01Z"),
      execFn: okExec,
      entry: makeEntry(innerCalls),
      print: (t) => { innerPrinted.push(t); },
      events: innerEvents,
    });
    assert.equal(r.ok, true, r.error || "not ok");
    // --cmd evidence saved into the parent adhoc dir.
    assert.ok(fs.existsSync(path.join(r.adhocDir, "cmd-evidence.txt")), "cmd-evidence.txt must be saved");
    assert.match(fs.readFileSync(path.join(r.adhocDir, "cmd-evidence.txt"), "utf8"), /npm test/);
    // Prompt given to the stubbed entry carries criteria + cmd evidence.
    assert.match(innerCalls[0].prompt, /the thing works/);
    assert.match(innerCalls[0].prompt, /npm test/);
    assert.equal(innerCalls[0].role, "verifier");
    assert.equal(innerCalls[0].repoRoot, root, "entry must receive the real repo root");
    // Relay artifacts landed as a nested NN-<role>-<id8>/ subdir.
    assert.match(path.basename(r.nestedRunDir), /^\d{2,}-verifier-[0-9a-fA-F]{8}$/);
    assert.ok(fs.existsSync(path.join(r.nestedRunDir, "result.json")));
    // Summary written in the parent dir recording the nested path.
    const body = fs.readFileSync(r.summaryPath, "utf8");
    assert.ok(body.includes(path.basename(r.nestedRunDir)));
    assert.ok(body.includes("Verdict: PASS") && body.includes("reviewed verifier"));
    // Printed verdict+findings match the saved text.
    assert.equal(innerPrinted.length, 1);
    assert.ok(innerPrinted[0].includes("Verdict: PASS"));
    assert.ok(body.includes(innerPrinted[0].split("\n")[0]));
    assert.equal(r.printed, innerPrinted[0]);
    // Relay files untouched by the summary write (exactly the two artifacts).
    assert.deepEqual(fs.readdirSync(r.nestedRunDir).sort(), ["result.json", "status.json"]);
  });

  await check("verify-file: nested dir found by scan when entry returns no path", async () => {
    const r = await runAdhocCommand("verify-file", [criteriaFile], {
      repoRoot: root,
      config,
      now: () => new Date("2026-01-01T00:00:02Z"),
      entry: makeEntry([], { returnDir: false }),
      print: () => {},
      events: [],
    });
    assert.equal(r.ok, true, r.error || "not ok");
    assert.match(path.basename(r.nestedRunDir), /^\d{2,}-verifier-[0-9a-fA-F]{8}$/);
    assert.ok(fs.existsSync(r.summaryPath));
  });

await check("plan-review: full run with stubbed entry", async () => {
  const calls = [];
  const events = [];
  const printed = [];
  const r = await runAdhocCommand("plan-review", [planFile], {
    repoRoot: root,
    config,
    now: () => new Date("2026-01-01T00:00:03Z"),
    entry: makeEntry(calls),
    print: (t) => { printed.push(t); },
    events,
  });
  assert.equal(r.ok, true, r.error || "not ok");
  assert.deepEqual(events, ["parse", "cmd", "prompt", "entry", "summary", "print"]);
  assert.match(calls[0].prompt, /Do the thing/);
  assert.equal(calls[0].role, "plan_reviewer");
  assert.ok(printed[0].includes("Verdict: PASS"));
});

await check("code-review diff-file: full run with stubbed entry", async () => {
  const calls = [];
  const r = await runAdhocCommand("code-review", [diffFile], {
    repoRoot: root,
    config,
    now: () => new Date("2026-01-01T00:00:04Z"),
    entry: makeEntry(calls),
    print: () => {},
    events: [],
  });
  assert.equal(r.ok, true, r.error || "not ok");
  assert.equal(calls[0].role, "code_reviewer");
  assert.match(calls[0].prompt, /diff --git/);
});

await check("refusals never reach the entry", async () => {
  let entered = 0;
  const never = async () => { entered++; throw new Error("entry must not run"); };
  const a = await runAdhocCommand("plan-review", [path.join(root, "missing.md")], {
    repoRoot: root, config, entry: never, print: () => {}, events: [],
  });
  assert.equal(a.ok, false);
  assert.match(a.error, /missing/);
  const b = await runAdhocCommand("verify-file", [criteriaFile, "--cmd", "npm test"], {
    repoRoot: root, config, entry: never, print: () => {}, events: [],
    execFn: () => { throw new Error("boom"); },
  });
  assert.equal(b.ok, false);
  assert.equal(entered, 0, "stubbed entry must not be called on refusal paths");
});

await check("entry throw becomes a relay failure (no summary, no print)", async () => {
  let printed = 0;
  const r = await runAdhocCommand("plan-review", [planFile], {
    repoRoot: root,
    config,
    now: () => new Date("2026-01-01T00:00:05Z"),
    entry: async () => { throw new Error("adapter down"); },
    print: () => { printed++; },
    events: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /relay failed.*adapter down/);
  assert.equal(printed, 0);
});

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
