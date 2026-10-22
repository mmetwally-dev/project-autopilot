#!/usr/bin/env node
// Mission 091 task 1.2: adhoc summary-writer coverage.
// Accept: summary lands in the parent adhoc dir recording the nested
// NN-<role>-<id8>/ path with printed verdict+findings saved and relay files
// untouched. Run: node scripts/test-091-adhoc-run-dir.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADHOC_SUMMARY_FILENAME,
  formatAdhocPrinted,
  formatAdhocSummary,
  isNestedRunDirName,
  writeAdhocSummary,
} from "./adhoc-summary.mjs";

let failed = 0;
let ran = 0;
const check = (name, fn) => {
  ran++;
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} :: ${e?.message || String(e)}`);
  }
};

const snapshot = (dir) => {
  const out = new Map();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    out.set(e.name, e.isFile() ? fs.readFileSync(full, "utf8") : `<dir:${fs.readdirSync(full).sort().join(",")}>`);
  }
  return out;
};

// Fixtures live under $TMPDIR, outside the project repo.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "091-adhoc-run-dir-"));
const parent = path.join(root, ".autopilot", "adhoc", "20260101T000000-plan_reviewer");
const nestedBase = "01-plan_reviewer-a1b2c3d4";
const nested = path.join(parent, nestedBase);
fs.mkdirSync(nested, { recursive: true });
// Fake relay artifacts inside the nested run dir.
fs.writeFileSync(path.join(nested, "status.json"), JSON.stringify({ role: "plan_reviewer" }), "utf8");
fs.writeFileSync(path.join(nested, "result.json"), JSON.stringify({ verdict: "PASS" }), "utf8");
const relayBefore = snapshot(nested);

check("nested run-dir name matches NN-<role>-<id8>", () => {
  assert.equal(isNestedRunDirName(nestedBase), true);
  assert.equal(isNestedRunDirName(nestedBase, "plan_reviewer"), true);
  assert.equal(isNestedRunDirName("summary.md"), false);
});

check("printed text carries verdict+findings", () => {
  const printed = formatAdhocPrinted({ verdict: "PASS", findings: ["looks good", "minor nit"] });
  assert.ok(printed.includes("Verdict: PASS"));
  assert.ok(printed.includes("looks good") && printed.includes("minor nit"));
});

let first = null;
check("summary lands in parent dir recording nested path", () => {
  first = writeAdhocSummary(parent, {
    command: "plan-review",
    role: "plan_reviewer",
    input: "PLAN.md",
    verdict: "PASS",
    findings: ["looks good", "minor nit"],
    cmdEvidence: { cmd: "npm test", exitCode: 0, stdout: "ok\n" },
    nestedRunDir: nested,
    timestamp: "20260101T000000",
  });
  assert.equal(first.ok, true, first.error || "not ok");
  assert.equal(first.summaryPath, path.join(parent, ADHOC_SUMMARY_FILENAME));
  assert.ok(fs.existsSync(first.summaryPath), "summary file must exist");
  const body = fs.readFileSync(first.summaryPath, "utf8");
  assert.ok(body.includes(nestedBase), "summary must record nested run-dir basename");
  assert.ok(body.includes(nested), "summary must record nested run-dir path");
  assert.ok(body.includes("Verdict: PASS"), "summary must save printed verdict");
  assert.ok(body.includes("looks good"), "summary must save printed findings");
  assert.ok(body.includes("npm test"), "summary must save --cmd evidence");
  assert.ok(body.includes(first.printed.split("\n")[0]), "printed verdict line must match saved text");
  assert.equal(fs.existsSync(path.join(nested, ADHOC_SUMMARY_FILENAME)), false, "summary must not land inside nested dir");
});

check("relay files untouched (no overwrite, no duplication)", () => {
  const after = snapshot(nested);
  assert.deepEqual([...after.entries()], [...relayBefore.entries()]);
  const parentEntries = fs.readdirSync(parent).sort();
  assert.ok(parentEntries.includes(ADHOC_SUMMARY_FILENAME));
  assert.ok(parentEntries.includes(nestedBase));
});

check("summary builder records run dir without I/O", () => {
  const body = formatAdhocSummary({ verdict: "FAIL", findings: ["gap"], nestedRunDir: nested });
  assert.ok(body.includes(nestedBase) && body.includes("Verdict: FAIL") && body.includes("gap"));
});

check("nested dir outside parent is refused", () => {
  const res = writeAdhocSummary(parent, { verdict: "PASS", nestedRunDir: path.join(root, "elsewhere", "01-plan_reviewer-a1b2c3d4") });
  assert.equal(res.ok, false);
  assert.match(res.error, /directly inside parent/);
});

check("bad nested basename is refused", () => {
  const badDir = path.join(parent, "not-a-run-dir");
  fs.mkdirSync(badDir, { recursive: true });
  const res = writeAdhocSummary(parent, { verdict: "PASS", nestedRunDir: badDir });
  assert.equal(res.ok, false);
  assert.match(res.error, /NN-<role>-<id8>/);
  fs.rmdirSync(badDir);
});

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
