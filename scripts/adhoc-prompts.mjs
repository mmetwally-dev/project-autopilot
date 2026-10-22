#!/usr/bin/env node
// Mission 091 task 1.3: adhoc role prompt builders.
//
// Pure text assembly only: plan_reviewer on the plan file, code_reviewer on
// the resolved diff, verifier on the criteria file (+ pre-captured --cmd
// evidence text). No --cmd execution, no relay invocation, no filesystem or
// state.json access — callers (arg-parse 1.1, cmd-evidence 1.4) supply the
// already-read input text.

export const ADHOC_ROLE_BY_COMMAND = Object.freeze({
  "plan-review": "plan_reviewer",
  "code-review": "code_reviewer",
  "verify-file": "verifier",
});

function fence(text) {
  return String(text ?? "").replace(/\s+$/, "");
}

function outputContract() {
  return [
    "## Output contract",
    "End with exactly these two sections (this is what the summary writer saves):",
    "Verdict: <PASS|FAIL>",
    "- <finding 1>",
    "- <finding 2>",
    'For the verifier, give one PASS/FAIL line per criterion, then the overall Verdict: line.',
  ].join("\n");
}

function fail(message) {
  return { ok: false, error: `Usage error: ${message}` };
}

// Plan reviewer: reviews the plan file content for gaps/risks.
export function buildPlanReviewPrompt({ planPath = "", planText = "" } = {}) {
  const path = String(planPath ?? "").trim();
  const text = String(planText ?? "");
  if (!path) return fail("missing: plan file path is required.");
  if (!text.trim()) return fail(`unreadable: plan file is empty or unreadable: ${path}`);
  const prompt = [
    "You are plan_reviewer: an independent, read-only reviewer of the plan below.",
    "Do not implement, edit, or run anything. Review only.",
    "",
    `Plan file: ${path}`,
    "",
    "--- plan begin ---",
    fence(text),
    "--- plan end ---",
    "",
    "Review the plan for missing steps, untestable criteria, scope gaps, and risks.",
    "",
    outputContract(),
  ].join("\n");
  return { ok: true, role: "plan_reviewer", command: "plan-review", input: path, prompt };
}

// Code reviewer: reviews the resolved diff content (range/commit/diff-file/
// path already resolved to unified-diff text by the caller).
export function buildCodeReviewPrompt({ kind = "", input = "", diffText = "" } = {}) {
  const source = String(input ?? "").trim();
  const resolvedKind = String(kind ?? "").trim() || "diff";
  const text = String(diffText ?? "");
  if (!source) return fail("missing: code-review input is required.");
  if (!text.trim()) return fail(`unreadable: no diff content to review for: ${source}`);
  const prompt = [
    "You are code_reviewer: an independent, read-only reviewer of the change below.",
    "Do not implement, edit, or run anything. Review only.",
    "",
    `Review source (${resolvedKind}): ${source}`,
    "",
    "--- diff begin ---",
    fence(text),
    "--- diff end ---",
    "",
    "Review the diff for correctness, regressions, missing tests, and style risks.",
    "",
    outputContract(),
  ].join("\n");
  return { ok: true, role: "code_reviewer", command: "code-review", input: source, kind: resolvedKind, prompt };
}

// Verifier: checks each criterion in the criteria file, using the
// pre-captured --cmd evidence text when supplied. Never executes --cmd here.
export function buildVerifierPrompt({ criteriaPath = "", criteriaText = "", cmdEvidence = null } = {}) {
  const path = String(criteriaPath ?? "").trim();
  const text = String(criteriaText ?? "");
  if (!path) return fail("missing: criteria file path is required.");
  if (!text.trim()) return fail(`unreadable: criteria file is empty or unreadable: ${path}`);
  const parts = [
    "You are verifier: check each acceptance criterion below against the evidence.",
    "Do not implement, edit, or run anything. Verify only; never guess PASS without evidence.",
    "",
    `Criteria file: ${path}`,
    "",
    "--- criteria begin ---",
    fence(text),
    "--- criteria end ---",
  ];
  if (cmdEvidence !== null && cmdEvidence !== undefined) {
    const cmd = typeof cmdEvidence === "string" ? cmdEvidence : cmdEvidence.cmd;
    const stdout = typeof cmdEvidence === "string" ? "" : cmdEvidence.stdout;
    const exitCode = typeof cmdEvidence === "string" ? undefined : cmdEvidence.exitCode;
    parts.push("", "--- command evidence begin ---");
    if (cmd) parts.push(`cmd: ${cmd}`);
    if (exitCode !== undefined && exitCode !== null) parts.push(`exit_code: ${exitCode}`);
    if (stdout !== undefined && stdout !== null && String(stdout) !== "") {
      parts.push("--- stdout begin ---", fence(stdout), "--- stdout end ---");
    }
    parts.push("--- command evidence end ---");
  } else {
    parts.push("", "No --cmd evidence was supplied; verify against the criteria text and repository state only.");
  }
  parts.push("", outputContract());
  return { ok: true, role: "verifier", command: "verify-file", input: path, prompt: parts.join("\n") };
}

// Dispatcher by adhoc CLI command. `args` carries the already-resolved input:
// plan-review: { input|planPath, text|planText }
// code-review: { input, kind, text|diffText }
// verify-file: { input|criteriaPath, text|criteriaText, cmdEvidence }
export function buildAdhocPrompt(command, args = {}) {
  const role = ADHOC_ROLE_BY_COMMAND[String(command ?? "")];
  if (!role) {
    return fail(`unknown adhoc command ${JSON.stringify(String(command))}. Use: ap <plan-review|code-review|verify-file> <input>`);
  }
  if (command === "plan-review") {
    return buildPlanReviewPrompt({
      planPath: args.planPath ?? args.input ?? "",
      planText: args.planText ?? args.text ?? "",
    });
  }
  if (command === "code-review") {
    return buildCodeReviewPrompt({
      kind: args.kind ?? "diff",
      input: args.input ?? "",
      diffText: args.diffText ?? args.text ?? "",
    });
  }
  return buildVerifierPrompt({
    criteriaPath: args.criteriaPath ?? args.input ?? "",
    criteriaText: args.criteriaText ?? args.text ?? "",
    cmdEvidence: args.cmdEvidence ?? null,
  });
}
