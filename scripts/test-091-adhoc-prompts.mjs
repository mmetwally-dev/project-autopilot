#!/usr/bin/env node
// Mission 091 task 1.3: adhoc prompt-builder coverage.
// Accept: prompts built per role with correct input plumbed in.
// Run: node scripts/test-091-adhoc-prompts.mjs
import assert from "node:assert";
import {
  ADHOC_ROLE_BY_COMMAND,
  buildAdhocPrompt,
  buildCodeReviewPrompt,
  buildPlanReviewPrompt,
  buildVerifierPrompt,
} from "./adhoc-prompts.mjs";

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

const PLAN_PATH = "/tmp/PLAN.md";
const PLAN_TEXT = "# Plan\n\n- [ ] do the thing\n";
const DIFF_TEXT = "diff --git a/f b/f\n@@ -1 +1 @@\n-old\n+new\n";
const CRITERIA_PATH = "/tmp/CRITERIA.md";
const CRITERIA_TEXT = "# Acceptance criteria\n\n- [ ] must render verdict\n";

check("plan_reviewer prompt plumbs plan file + content", () => {
  const r = buildPlanReviewPrompt({ planPath: PLAN_PATH, planText: PLAN_TEXT });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.role, "plan_reviewer");
  assert.ok(r.prompt.includes("plan_reviewer"), "names role");
  assert.ok(r.prompt.includes(PLAN_PATH), "plumbs plan path");
  assert.ok(r.prompt.includes("do the thing"), "plumbs plan content");
  assert.ok(r.prompt.includes("Verdict:"), "carries output contract");
});

check("code_reviewer prompt plumbs resolved diff + kind", () => {
  const r = buildCodeReviewPrompt({ kind: "diff-file", input: "/tmp/change.diff", diffText: DIFF_TEXT });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.role, "code_reviewer");
  assert.ok(r.prompt.includes("code_reviewer"), "names role");
  assert.ok(r.prompt.includes("diff-file"), "plumbs resolved kind");
  assert.ok(r.prompt.includes("/tmp/change.diff"), "plumbs input");
  assert.ok(r.prompt.includes("diff --git"), "plumbs diff content");
  assert.ok(r.prompt.includes("Verdict:"), "carries output contract");
});

check("verifier prompt plumbs criteria + --cmd evidence text (no execution)", () => {
  const r = buildVerifierPrompt({
    criteriaPath: CRITERIA_PATH,
    criteriaText: CRITERIA_TEXT,
    cmdEvidence: { cmd: "npm test", exitCode: 0, stdout: "ok\n" },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.role, "verifier");
  assert.ok(r.prompt.includes("verifier"), "names role");
  assert.ok(r.prompt.includes(CRITERIA_PATH), "plumbs criteria path");
  assert.ok(r.prompt.includes("must render verdict"), "plumbs criteria content");
  assert.ok(r.prompt.includes("npm test") && r.prompt.includes("ok"), "inlines evidence text");
  assert.ok(r.prompt.includes("Verdict:"), "carries output contract");
});

check("verifier prompt without evidence says so", () => {
  const r = buildVerifierPrompt({ criteriaPath: CRITERIA_PATH, criteriaText: CRITERIA_TEXT });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.prompt.includes("No --cmd evidence"), "notes missing evidence");
});

check("dispatcher maps each command to its role", () => {
  assert.equal(ADHOC_ROLE_BY_COMMAND["plan-review"], "plan_reviewer");
  assert.equal(ADHOC_ROLE_BY_COMMAND["code-review"], "code_reviewer");
  assert.equal(ADHOC_ROLE_BY_COMMAND["verify-file"], "verifier");
  const p = buildAdhocPrompt("plan-review", { input: PLAN_PATH, text: PLAN_TEXT });
  assert.equal(p.ok && p.role, "plan_reviewer");
  assert.ok(p.prompt.includes("do the thing"));
  const c = buildAdhocPrompt("code-review", { kind: "range", input: "a..b", text: DIFF_TEXT });
  assert.equal(c.ok && c.role, "code_reviewer");
  assert.ok(c.prompt.includes("a..b") && c.prompt.includes("range"));
  const v = buildAdhocPrompt("verify-file", { input: CRITERIA_PATH, text: CRITERIA_TEXT, cmdEvidence: null });
  assert.equal(v.ok && v.role, "verifier");
  assert.ok(v.prompt.includes("must render verdict"));
});

check("empty inputs refuse without touching fs/exec/relay", () => {
  assert.equal(buildPlanReviewPrompt({ planPath: PLAN_PATH, planText: "  \n" }).ok, false);
  assert.equal(buildCodeReviewPrompt({ kind: "path", input: "x", diffText: "" }).ok, false);
  assert.equal(buildVerifierPrompt({ criteriaPath: CRITERIA_PATH, criteriaText: "" }).ok, false);
  assert.equal(buildAdhocPrompt("nope", {}).ok, false);
});

check("builders are pure (no --cmd execution or relay code)", async () => {
  const [{ default: fsMod }, src] = [{ default: null }, null];
  void fsMod; void src;
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(new URL("./adhoc-prompts.mjs", import.meta.url), "utf8");
  assert.ok(!/child_process|spawnSync|execSync|execFile|runRelay|relayAsync/.test(body), "no exec/relay imports or calls");
  assert.ok(!/readFileSync|writeFileSync|statSync|accessSync/.test(body), "no filesystem I/O");
});

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
