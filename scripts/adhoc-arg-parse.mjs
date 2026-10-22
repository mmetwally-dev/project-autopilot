#!/usr/bin/env node
// Mission 091 task 1.1: adhoc arg-parse/refusal module for
// `ap plan-review <file>`, `ap code-review <diff|commit|range|path>`,
// `ap verify-file <criteria-file> [--cmd "<test command>"]`.
//
// Pure parsing + filesystem refusal checks only. No relay invocation,
// no run-dir creation, no state.json access.

import fs from "node:fs";

export const ADHOC_COMMANDS = ["plan-review", "code-review", "verify-file"];

// A criteria file counts as checkable when it contains at least one
// criterion-like signal: a markdown checkbox, a numbered-list item, or a
// list/heading line under an "Acceptance criteria" heading. Keyword-bearing
// prose alone ("I should probably check this later, no idea.") is refused so
// the verifier never guesses PASS/FAIL from untestable text.
const ACCEPTANCE_HEADING = /acceptance\s*criteri/i;

export function hasCheckableCriteria(text) {
  const content = String(text ?? "");
  if (!content.trim()) return false;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*-\s*\[[ xX]\]\s+\S/.test(line)) return true;
    if (/^\s*\d+[.)]\s+\S/.test(line)) return true;
  }
  const headIdx = lines.findIndex((line) => ACCEPTANCE_HEADING.test(line));
  if (headIdx >= 0) {
    for (let j = headIdx + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*#{1,6}\s+\S/.test(line)) return true;
      if (/^\s*[-*+]\s+\S/.test(line)) return true;
    }
  }
  return false;
}

function readableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function readablePathLike(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// A positional value is a range only when both sides are non-empty and
// neither side starts with "/" or "." and neither side contains a path
// separator or whitespace. Relative/absolute paths such as "../x.diff"
// therefore never classify as a range; they fall through to diff-file/path
// so missing/unreadable inputs refuse cleanly. Branch names containing "/"
// must use the explicit --range flag.
// Classify a bare positional code-review value without touching the network:
// existing file/dir (diff-file vs path) > range (strict pattern above) >
// commit (7-40 hex) > diff-file (existing file whose content looks like a
// unified diff, for injected readFile stubs) > path (anything else;
// existence is checked by the caller so unknown strings still resolve to
// path and then refuse cleanly on missing/unreadable).
const RANGE_RE = /^[^/\s.][^/\s]*\.\.\.?[^/\s.][^/\s]*$/;

export function classifyCodeReviewPositional(value, { readFile = readableFile, existsSync = fs.existsSync } = {}) {
  const v = String(value ?? "").trim();
  try {
    if (existsSync(v)) {
      let isDiffFile = false;
      try {
        if (readFile(v)) {
          const content = fs.readFileSync(v, "utf8");
          if (/^(diff --git|--- |\+\+\+ |@@ )/m.test(content)) isDiffFile = true;
        }
      } catch {
        // Fall through to path; the existence check below produces the refusal.
      }
      return isDiffFile ? "diff-file" : "path";
    }
  } catch {
    // Fall through to pattern checks below.
  }
  if (RANGE_RE.test(v)) return "range";
  if (/^[0-9a-f]{7,40}$/i.test(v)) return "commit";
  try {
    if (readFile(v)) {
      const content = fs.readFileSync(v, "utf8");
      if (/^(diff --git|--- |\+\+\+ |@@ )/m.test(content)) return "diff-file";
    }
  } catch {
    // Fall through to path; the existence check below produces the refusal.
  }
  return "path";
}

// Resolve code-review input by explicit resolution order:
// --range > --commit > --diff-file > positional (auto-classified).
// Returns { kind, value } where kind is range|commit|diff-file|path.
export function resolveCodeReviewInput({ range, commit, diffFile, positional }) {
  if (range !== undefined && range !== null && String(range).trim() !== "") {
    return { kind: "range", value: String(range).trim() };
  }
  if (commit !== undefined && commit !== null && String(commit).trim() !== "") {
    return { kind: "commit", value: String(commit).trim() };
  }
  if (diffFile !== undefined && diffFile !== null && String(diffFile).trim() !== "") {
    return { kind: "diff-file", value: String(diffFile).trim() };
  }
  const pos = String(positional ?? "").trim();
  return { kind: classifyCodeReviewPositional(pos), value: pos };
}

function usageError(command, detail) {
  const base = {
    "plan-review": "Use: ap plan-review <plan-file>",
    "code-review": "Use: ap code-review (<range> | <commit> | <diff-file> | <path>) [--range <a..b> | --commit <sha> | --diff-file <file>]",
    "verify-file": "Use: ap verify-file <criteria-file> [--cmd \"<test command>\"]",
  }[command] || "Use: ap <plan-review|code-review|verify-file> <input>";
  return `Usage error: ${detail} ${base}`;
}

function splitFlagValue(token, flag) {
  if (token === flag) return { matched: true, inline: null };
  if (token.startsWith(`${flag}=`)) return { matched: true, inline: token.slice(flag.length + 1) };
  return { matched: false, inline: null };
}

// Parse adhoc command args (the command's own argv slice, NOT process.argv).
// Returns { ok, command, ... } — on failure { ok:false, error } where error
// always starts with "Usage error:" or names the refusal ("missing:",
// "unreadable:", "no checkable criteria:").
export function parseAdhocArgs(command, args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  if (!ADHOC_COMMANDS.includes(command)) {
    return { ok: false, command: String(command), error: `Usage error: unknown adhoc command ${JSON.stringify(String(command))}. Use: ap <plan-review|code-review|verify-file> <input>` };
  }

  let cmd = null;
  let cmdSeen = false;
  let range;
  let commit;
  let diffFile;
  const positionals = [];
  let flagError = null;

  const takeValue = (inline, i, flag) => {
    if (inline !== null) return { value: inline, next: i };
    const value = list[i + 1];
    if (value === undefined || value === "") return { value: "", next: i + 1 };
    return { value, next: i + 1 };
  };

  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    const cmdSplit = splitFlagValue(token, "--cmd");
    const rangeSplit = splitFlagValue(token, "--range");
    const commitSplit = splitFlagValue(token, "--commit");
    const diffSplit = splitFlagValue(token, "--diff-file");
    if (cmdSplit.matched || rangeSplit.matched || commitSplit.matched || diffSplit.matched) {
      const flag = cmdSplit.matched ? "--cmd" : rangeSplit.matched ? "--range" : commitSplit.matched ? "--commit" : "--diff-file";
      const inline = cmdSplit.matched ? cmdSplit.inline : rangeSplit.matched ? rangeSplit.inline : commitSplit.matched ? commitSplit.inline : diffSplit.inline;
      // --cmd belongs to verify-file only.
      if (flag === "--cmd" && command !== "verify-file") {
        flagError = usageError(command, `${flag} is only supported by ap verify-file.`);
        break;
      }
      if (flag !== "--cmd" && command !== "code-review") {
        flagError = usageError(command, `${flag} is only supported by ap code-review.`);
        break;
      }
      const seenCheck = flag === "--cmd" ? cmdSeen : flag === "--range" ? range !== undefined : flag === "--commit" ? commit !== undefined : diffFile !== undefined;
      if (seenCheck) {
        flagError = usageError(command, `duplicate ${flag} flag.`);
        break;
      }
      const { value, next } = takeValue(inline, i, flag);
      i = next;
      if (!value || value.startsWith("--")) {
        flagError = usageError(command, `${flag} requires a value (got ${value ? JSON.stringify(value) : "none"}).`);
        break;
      }
      if (flag === "--cmd") { cmd = value; cmdSeen = true; }
      else if (flag === "--range") range = value;
      else if (flag === "--commit") commit = value;
      else diffFile = value;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { ok: false, command, error: usageError(command, "help requested."), help: true };
    }
    if (token.startsWith("--")) {
      flagError = usageError(command, `unknown flag ${JSON.stringify(token)}.`);
      break;
    }
    positionals.push(token);
  }
  if (flagError) return { ok: false, command, error: flagError };

  if (command === "plan-review") {
    if (positionals.length === 0) {
      return { ok: false, command, error: `Usage error: missing: plan file argument. ${"Use: ap plan-review <plan-file>"}` };
    }
    if (positionals.length > 1) {
      return { ok: false, command, error: usageError(command, `expected 1 plan file, got ${positionals.length}.`) };
    }
    const file = positionals[0];
    if (!fs.existsSync(file)) {
      return { ok: false, command, error: `Usage error: missing: plan file not found: ${file}` };
    }
    if (!readableFile(file)) {
      return { ok: false, command, error: `Usage error: unreadable: plan file is not a readable file: ${file}` };
    }
    return { ok: true, command, input: file, kind: "plan-file" };
  }

  if (command === "verify-file") {
    if (positionals.length === 0) {
      return { ok: false, command, error: `Usage error: missing: criteria file argument. ${"Use: ap verify-file <criteria-file> [--cmd \"<test command>\"]"}` };
    }
    if (positionals.length > 1) {
      return { ok: false, command, error: usageError(command, `expected 1 criteria file, got ${positionals.length}.`) };
    }
    const file = positionals[0];
    if (!fs.existsSync(file)) {
      return { ok: false, command, error: `Usage error: missing: criteria file not found: ${file}` };
    }
    if (!readableFile(file)) {
      return { ok: false, command, error: `Usage error: unreadable: criteria file is not a readable file: ${file}` };
    }
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return { ok: false, command, error: `Usage error: unreadable: cannot read criteria file: ${file}` };
    }
    if (!hasCheckableCriteria(content)) {
      return { ok: false, command, error: `Usage error: no checkable criteria: ${file} has no acceptance criteria to verify; refusing to guess.` };
    }
    return { ok: true, command, input: file, kind: "criteria-file", cmd };
  }

  // code-review
  const positional = positionals.length > 0 ? positionals[0] : "";
  if (positionals.length > 1) {
    return { ok: false, command, error: usageError(command, `expected 1 review input, got ${positionals.length}.`) };
  }
  const hasExplicit = range !== undefined || commit !== undefined || diffFile !== undefined;
  if (!hasExplicit && !positional) {
    return { ok: false, command, error: `Usage error: missing: code-review input argument. ${"Use: ap code-review (<range> | <commit> | <diff-file> | <path>)"}` };
  }
  if (hasExplicit && positional) {
    return { ok: false, command, error: usageError(command, "pass either a positional input or one of --range/--commit/--diff-file, not both.") };
  }
  const resolved = resolveCodeReviewInput({ range, commit, diffFile, positional });
  if (!resolved.value) {
    return { ok: false, command, error: usageError(command, "empty code-review input.") };
  }
  if (resolved.kind === "diff-file") {
    if (!fs.existsSync(resolved.value)) {
      return { ok: false, command, error: `Usage error: missing: diff file not found: ${resolved.value}` };
    }
    if (!readableFile(resolved.value)) {
      return { ok: false, command, error: `Usage error: unreadable: diff file is not a readable file: ${resolved.value}` };
    }
  } else if (resolved.kind === "path") {
    if (!fs.existsSync(resolved.value)) {
      return { ok: false, command, error: `Usage error: missing: review path not found: ${resolved.value}` };
    }
    if (!readablePathLike(resolved.value)) {
      return { ok: false, command, error: `Usage error: unreadable: review path is not readable: ${resolved.value}` };
    }
  } else if (resolved.kind === "range") {
    if (!resolved.value.includes("..")) {
      return { ok: false, command, error: usageError(command, `invalid range ${JSON.stringify(resolved.value)} (expected <base>..<head>).`) };
    }
  } else if (resolved.kind === "commit") {
    if (!/^[0-9a-f]{7,40}$/i.test(resolved.value)) {
      return { ok: false, command, error: usageError(command, `invalid commit ${JSON.stringify(resolved.value)} (expected 7-40 hex chars).`) };
    }
  }
  return { ok: true, command, input: resolved.value, kind: resolved.kind };
}

export function formatAdhocUsage(command) {
  return usageError(command || "plan-review", "help requested.");
}
