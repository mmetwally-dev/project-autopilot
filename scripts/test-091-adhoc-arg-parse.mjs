#!/usr/bin/env node
// Mission 091 task 1.1: adhoc arg-parse/refusal coverage for
// plan-review / code-review / verify-file (incl. --cmd, missing/unreadable
// refusals, verify-file no-criteria refusal, code-review resolution order).
// Run: node scripts/test-091-adhoc-arg-parse.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseAdhocArgs,
  hasCheckableCriteria,
  resolveCodeReviewInput,
  classifyCodeReviewPositional,
} from "./adhoc-arg-parse.mjs";

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

// Fixtures live under $TMPDIR, outside the project repo.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "091-adhoc-arg-parse-"));
const planFile = path.join(dir, "PLAN.md");
fs.writeFileSync(planFile, "# Plan\n\n- [ ] do the thing\n");
const criteriaFile = path.join(dir, "CRITERIA.md");
fs.writeFileSync(criteriaFile, "# Acceptance criteria\n\n- [ ] must render verdict\n");
const noCriteriaFile = path.join(dir, "NOTES.md");
fs.writeFileSync(noCriteriaFile, "just some prose about ideas, nothing testable here\n");
const keywordProseFile = path.join(dir, "PROSE.md");
fs.writeFileSync(keywordProseFile, "I should probably check this later, no idea.\n");
const emptyFile = path.join(dir, "EMPTY.md");
fs.writeFileSync(emptyFile, "\n");
const diffFile = path.join(dir, "change.diff");
fs.writeFileSync(diffFile, "diff --git a/f b/f\n@@ -1 +1 @@\n-old\n+new\n");
const plainFile = path.join(dir, "notes.txt");
fs.writeFileSync(plainFile, "hello\n");
const subdir = path.join(dir, "sub");
fs.mkdirSync(subdir);
const missing = path.join(dir, "does-not-exist.md");

const okResult = (res, want = {}) => {
  if (!res || res.ok !== true) return false;
  if (want.kind && res.kind !== want.kind) return false;
  if (want.input && res.input !== want.input) return false;
  if (want.cmd !== undefined && res.cmd !== want.cmd) return false;
  return true;
};
const errResult = (res, snippet = "") => {
  if (!res || res.ok !== false || typeof res.error !== "string") return false;
  if (!/^Usage error:/.test(res.error)) return false;
  if (snippet && !res.error.includes(snippet)) return false;
  return true;
};

// ── plan-review ──
check("[plan-review] parses readable file",
  okResult(parseAdhocArgs("plan-review", [planFile]), { kind: "plan-file", input: planFile }));
check("[plan-review] missing arg refuses",
  errResult(parseAdhocArgs("plan-review", []), "missing:"));
check("[plan-review] missing file refuses",
  errResult(parseAdhocArgs("plan-review", [missing]), "missing:"));
check("[plan-review] directory refuses as unreadable",
  errResult(parseAdhocArgs("plan-review", [subdir]), "unreadable:"));
check("[plan-review] extra positional refuses",
  errResult(parseAdhocArgs("plan-review", [planFile, planFile]), "expected 1"));
check("[plan-review] --cmd refused",
  errResult(parseAdhocArgs("plan-review", [planFile, "--cmd", "npm test"]), "--cmd"));
check("[plan-review] unknown flag refused",
  errResult(parseAdhocArgs("plan-review", [planFile, "--verbose"]), "unknown flag"));

// ── verify-file ──
check("[verify-file] parses criteria file",
  okResult(parseAdhocArgs("verify-file", [criteriaFile]), { kind: "criteria-file", input: criteriaFile }));
check("[verify-file] --cmd separate value parsed",
  okResult(parseAdhocArgs("verify-file", [criteriaFile, "--cmd", "npm test"]), { cmd: "npm test" }));
check("[verify-file] --cmd= inline parsed",
  okResult(parseAdhocArgs("verify-file", [criteriaFile, "--cmd=npm test"]), { cmd: "npm test" }));
check("[verify-file] cmd defaults to null",
  parseAdhocArgs("verify-file", [criteriaFile]).cmd === null);
check("[verify-file] missing arg refuses",
  errResult(parseAdhocArgs("verify-file", []), "missing:"));
check("[verify-file] missing file refuses",
  errResult(parseAdhocArgs("verify-file", [missing]), "missing:"));
check("[verify-file] directory refuses as unreadable",
  errResult(parseAdhocArgs("verify-file", [subdir]), "unreadable:"));
check("[verify-file] no-criteria prose refuses",
  errResult(parseAdhocArgs("verify-file", [noCriteriaFile]), "no checkable criteria"));
check("[verify-file] keyword-bearing prose without criteria refuses",
  errResult(parseAdhocArgs("verify-file", [keywordProseFile]), "no checkable criteria"));
check("[verify-file] empty file refuses as no-criteria",
  errResult(parseAdhocArgs("verify-file", [emptyFile]), "no checkable criteria"));
check("[verify-file] --cmd without value refuses",
  errResult(parseAdhocArgs("verify-file", [criteriaFile, "--cmd"]), "requires a value"));
check("[verify-file] --cmd flag-like value refuses",
  errResult(parseAdhocArgs("verify-file", [criteriaFile, "--cmd", "--other"]), "requires a value"));
check("[verify-file] extra positional refuses",
  errResult(parseAdhocArgs("verify-file", [criteriaFile, plainFile]), "expected 1"));
check("[verify-file] --range refused",
  errResult(parseAdhocArgs("verify-file", [criteriaFile, "--range", "a..b"]), "--range"));

// ── code-review resolution order ──
check("[code-review] positional range resolves",
  okResult(parseAdhocArgs("code-review", ["main..feature"]), { kind: "range", input: "main..feature" }));
check("[code-review] positional commit resolves",
  okResult(parseAdhocArgs("code-review", ["abc1234"]), { kind: "commit", input: "abc1234" }));
check("[code-review] positional diff file resolves",
  okResult(parseAdhocArgs("code-review", [diffFile]), { kind: "diff-file", input: diffFile }));
check("[code-review] positional plain path resolves",
  okResult(parseAdhocArgs("code-review", [plainFile]), { kind: "path", input: plainFile }));
check("[code-review] positional dir resolves as path",
  okResult(parseAdhocArgs("code-review", [subdir]), { kind: "path", input: subdir }));
check("[code-review] --range flag resolves",
  okResult(parseAdhocArgs("code-review", ["--range", "a..b"]), { kind: "range", input: "a..b" }));
check("[code-review] --commit flag resolves",
  okResult(parseAdhocArgs("code-review", ["--commit", "deadbee"]), { kind: "commit", input: "deadbee" }));
check("[code-review] --diff-file flag resolves",
  okResult(parseAdhocArgs("code-review", ["--diff-file", diffFile]), { kind: "diff-file", input: diffFile }));
check("[code-review] missing input refuses",
  errResult(parseAdhocArgs("code-review", []), "missing:"));
check("[code-review] missing positional path refuses",
  errResult(parseAdhocArgs("code-review", [missing]), "missing:"));
check("[code-review] missing --diff-file refuses",
  errResult(parseAdhocArgs("code-review", ["--diff-file", missing]), "missing:"));
check("[code-review] --diff-file directory refuses as unreadable",
  errResult(parseAdhocArgs("code-review", ["--diff-file", subdir]), "unreadable:"));
check("[code-review] flag+positional refuses",
  errResult(parseAdhocArgs("code-review", ["--range", "a..b", plainFile]), "not both"));
check("[code-review] extra positional refuses",
  errResult(parseAdhocArgs("code-review", [plainFile, planFile]), "expected 1"));
check("[code-review] --cmd refused",
  errResult(parseAdhocArgs("code-review", [plainFile, "--cmd", "npm test"]), "--cmd"));
check("[code-review] --commit without value refuses",
  errResult(parseAdhocArgs("code-review", ["--commit"]), "requires a value"));
check("[code-review] dotdot relative missing path refuses as missing (not range)",
  errResult(parseAdhocArgs("code-review", [path.join(subdir, "..", "does-not-exist.diff")]), "missing:"));
check("[code-review] dotdot existing diff resolves as diff-file (not range)",
  okResult(parseAdhocArgs("code-review", [path.join(subdir, "..", "change.diff")]), { kind: "diff-file" }));
check("[code-review] dotdot existing plain file resolves as path (not range)",
  okResult(parseAdhocArgs("code-review", [path.join(subdir, "..", "notes.txt")]), { kind: "path" }));
check("[code-review] unknown flag refused",
  errResult(parseAdhocArgs("code-review", ["--since", "yesterday"]), "unknown flag"));

// Resolution-order unit checks (no fs needed).
check("[resolve] range beats commit",
  JSON.stringify(resolveCodeReviewInput({ range: "a..b", commit: "abc1234", diffFile: diffFile, positional: plainFile })) === JSON.stringify({ kind: "range", value: "a..b" }));
check("[resolve] commit beats diff-file",
  JSON.stringify(resolveCodeReviewInput({ commit: "abc1234", diffFile: diffFile, positional: plainFile })) === JSON.stringify({ kind: "commit", value: "abc1234" }));
check("[resolve] diff-file beats positional",
  JSON.stringify(resolveCodeReviewInput({ diffFile: diffFile, positional: plainFile })) === JSON.stringify({ kind: "diff-file", value: diffFile }));
check("[classify] range/commit/diff-file/path order",
  classifyCodeReviewPositional("a..b") === "range"
  && classifyCodeReviewPositional("ABC1234") === "commit"
  && classifyCodeReviewPositional(diffFile) === "diff-file"
  && classifyCodeReviewPositional(plainFile) === "path");

// ── shared guards ──
check("[shared] unknown command refuses",
  errResult(parseAdhocArgs("plan", [planFile]), "unknown adhoc command"));
check("[shared] hasCheckableCriteria accepts checkbox/numbered/section list, refuses prose",
  hasCheckableCriteria("- [ ] must do x") === true
  && hasCheckableCriteria("1. first expectation here") === true
  && hasCheckableCriteria("# Acceptance criteria\n\n- must render verdict\n") === true
  && hasCheckableCriteria("# Acceptance criteria\n\n## Scope\n") === true
  && hasCheckableCriteria("The system MUST respond fast") === false
  && hasCheckableCriteria("I should probably check this later, no idea.") === false
  && hasCheckableCriteria("- must do x without a section") === false
  && hasCheckableCriteria("just prose") === false
  && hasCheckableCriteria("") === false
  && hasCheckableCriteria("   \n  ") === false);
check("[shared] dotdot classify: missing is path, existing diff is diff-file",
  classifyCodeReviewPositional(path.join(subdir, "..", "does-not-exist.diff")) === "path"
  && classifyCodeReviewPositional(path.join(subdir, "..", "change.diff")) === "diff-file");

fs.rmSync(dir, { recursive: true, force: true });

console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
