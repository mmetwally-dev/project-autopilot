#!/usr/bin/env node
// Mission 091 task 2.2: adhoc runner module.
//
// Calls the Phase 1 helpers and the 2.1 entry in order:
//   1.1 parse (parseAdhocArgs) → 1.4 --cmd capture (runAdhocCmd/save) →
//   1.3 prompt (buildAdhocPrompt) → 2.1 entry (runAdhocReview) →
//   1.2 summary write (writeAdhocSummary) → print.
//
// Self-contained orchestration only: no relay/adapter code lives here.
// Every step is injectable via `deps` so the 091 runner test can stub the
// 2.1 entry (and observe ordering) without touching the repo.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAdhocArgs } from "./adhoc-arg-parse.mjs";
import { runAdhocCmd, saveAdhocCmdEvidence } from "./adhoc-cmd-evidence.mjs";
import { ADHOC_ROLE_BY_COMMAND, buildAdhocPrompt } from "./adhoc-prompts.mjs";
import {
  formatAdhocPrinted,
  isNestedRunDirName,
  writeAdhocSummary,
} from "./adhoc-summary.mjs";

export const ADHOC_DIR_SEGMENT = path.join(".autopilot", "adhoc");

function fail(message) {
  return { ok: false, error: `Usage error: ${message}` };
}

function compactTimestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `T${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function readInputFile(filePath) {
  try {
    return { ok: true, text: fs.readFileSync(filePath, "utf8") };
  } catch (e) {
    return fail(`unreadable: cannot read input file: ${filePath} (${e?.message || e})`);
  }
}

// Default diff resolution for code-review kinds already validated by 1.1:
// diff-file → read the file; path (file) → read it; path (dir) / range /
// commit → best-effort `git diff`/`git show` from repoRoot. Anything that
// yields no text is a refusal (the reviewer must never guess).
function defaultResolveDiff({ kind, input }, { repoRoot = process.cwd() } = {}) {
  if (kind === "diff-file") return readInputFile(input);
  if (kind === "path") {
    try {
      const stat = fs.statSync(input);
      if (stat.isFile()) return readInputFile(input);
    } catch {
      return fail(`unreadable: cannot read review path: ${input}`);
    }
    // Directory path: best-effort working-tree diff.
    return runGitDiff(["diff", "--", input], repoRoot);
  }
  if (kind === "range") return runGitDiff(["diff", input, "--"], repoRoot);
  if (kind === "commit") return runGitDiff(["show", input, "--"], repoRoot);
  return fail(`unknown code-review kind: ${JSON.stringify(kind)}`);
}

function runGitDiff(gitArgs, repoRoot) {
  try {
    // Synchronous on purpose: the runner awaits each step in order.
    return runGitDiffSync(gitArgs, repoRoot);
  } catch (e) {
    return fail(`unreadable: cannot resolve diff for git ${gitArgs.join(" ")} (${e?.message || e})`);
  }
}

import { spawnSync } from "node:child_process";
import { loadAndMigrateConfig } from "./config-migration.mjs";

function runGitDiffSync(gitArgs, repoRoot) {
  const r = spawnSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8", shell: false });
  if (r.error) return fail(`unreadable: git ${gitArgs.join(" ")} failed to start (${r.error.message})`);
  if (r.status !== 0) {
    return fail(`unreadable: git ${gitArgs.join(" ")} exited ${r.status} (${String(r.stderr || "").trim().slice(0, 200)})`);
  }
  const text = String(r.stdout ?? "");
  if (!text.trim()) return fail(`unreadable: no diff content for git ${gitArgs.join(" ")}; refusing to guess.`);
  return { ok: true, text };
}

function findNestedRunDir(parentDir, role = null) {
  let entries = [];
  try {
    entries = fs.readdirSync(parentDir);
  } catch {
    return null;
  }
  const hits = entries.filter((e) => isNestedRunDirName(e, role));
  if (hits.length === 0) return null;
  hits.sort();
  return path.join(parentDir, hits[hits.length - 1]);
}

function asFindings(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((v) =>
      v === null || v === undefined
        ? ""
        : typeof v === "string"
          ? v
          : [v.location, v.problem, v.correction].filter(Boolean).join(" — ") || JSON.stringify(v),
    );
  }
  return String(value) === "" ? [] : [String(value)];
}

// Verdict/findings live on result.verdict (available) with a .review mirror;
// fall back to top-level decision/findings so stubbed entries stay simple.
export function extractAdhocVerdict(result) {
  const r = result ?? {};
  const verdict = r.verdict && typeof r.verdict === "object" ? r.verdict : null;
  const review = r.review && typeof r.review === "object" ? r.review : null;
  const decision = verdict?.decision ?? review?.decision ?? r.decision ?? null;
  const findings = asFindings(verdict?.findings ?? review?.findings ?? r.findings ?? []);
  return { verdict: decision ?? "(none)", findings };
}

async function defaultEntry({ role, prompt, adhocDir, repoRoot, config, timeoutMs }) {
  const { runAdhocReview } = await import("./autopilot.mjs");
  return runAdhocReview({ role, prompt, adhocDir, repoRoot, config, timeoutMs });
}

function defaultLoadConfig(repoRoot) {
  const configPath = path.join(String(repoRoot), ".autopilot", "config.json");
  try {
    const result = loadAndMigrateConfig(configPath, { persist: false });
    return result?.config ?? null;
  } catch {
    return null;
  }
}

// Run one adhoc command end to end. `argv` is the command's own slice (NOT
// process.argv). Returns { ok:true, printed, summaryPath, nestedRunDir,
// verdict, findings, adhocDir, role, ... } on success, { ok:false, error }
// on any refusal/failure. `events` (optional array) records the step order:
// ["parse","cmd","prompt","entry","summary","print"].
export async function runAdhocCommand(command, argv, deps = {}) {
  const {
    repoRoot = process.cwd(),
    config = undefined,
    loadConfig = defaultLoadConfig,
    readFile = readInputFile,
    resolveDiff = defaultResolveDiff,
    execFn = undefined,
    runCmd = runAdhocCmd,
    saveEvidence = saveAdhocCmdEvidence,
    buildPrompt = buildAdhocPrompt,
    entry = defaultEntry,
    writeSummary = writeAdhocSummary,
    print = (text) => console.log(text),
    now = () => new Date(),
    timeoutMs = null,
    events = null,
  } = deps ?? {};
  const mark = (step) => {
    if (Array.isArray(events)) events.push(step);
  };

  // Step 1 (1.1): parse + refusals.
  mark("parse");
  const parsed = parseAdhocArgs(command, argv);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const role = ADHOC_ROLE_BY_COMMAND[command];
  if (!role) return fail(`unknown adhoc command ${JSON.stringify(String(command))}.`);

  const cfg = config !== undefined ? config : loadConfig(repoRoot);
  if (!cfg || !cfg.roles?.[role]) {
    return fail(`missing: no configured role ${JSON.stringify(role)} (config at ${path.join(String(repoRoot), ".autopilot", "config.json")}).`);
  }

  // Parent adhoc dir: .autopilot/adhoc/<timestamp>-<role>/.
  const parent = path.join(path.resolve(String(repoRoot)), ADHOC_DIR_SEGMENT, `${compactTimestamp(now())}-${role}`);
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (e) {
    return fail(`unreadable: cannot create adhoc dir: ${parent} (${e?.message || e})`);
  }

  // Step 2 (1.4): --cmd capture (verify-file only; parse guarantees --cmd
  // appears nowhere else). Runs outside role containment in os.tmpdir(),
  // never in the repo write path; evidence saved into the parent adhoc dir.
  mark("cmd");
  let cmdEvidence = null;
  if (command === "verify-file" && parsed.cmd) {
    const runOpts = { cwd: os.tmpdir(), repoRoot, timeoutMs: timeoutMs ?? undefined };
    if (execFn !== undefined) runOpts.execFn = execFn;
    const ran = runCmd(parsed.cmd, runOpts);
    if (!ran.ok) return ran;
    cmdEvidence = ran.evidence;
    if (cmdEvidence) {
      const saved = saveEvidence(parent, cmdEvidence);
      if (!saved.ok) return saved;
    }
  }

  // Step 3 (1.3): build the role prompt from already-read input text.
  mark("prompt");
  let promptRes;
  if (command === "plan-review") {
    const read = readFile(parsed.input);
    if (!read.ok) return read;
    promptRes = buildPrompt(command, { input: parsed.input, text: read.text ?? read.content ?? "" });
  } else if (command === "verify-file") {
    const read = readFile(parsed.input);
    if (!read.ok) return read;
    promptRes = buildPrompt(command, {
      input: parsed.input,
      text: read.text ?? read.content ?? "",
      cmdEvidence,
    });
  } else {
    const resolved = await resolveDiff({ kind: parsed.kind, input: parsed.input }, { repoRoot });
    if (!resolved.ok) return resolved;
    promptRes = buildPrompt(command, {
      input: parsed.input,
      kind: parsed.kind,
      diffText: resolved.text ?? resolved.diffText ?? "",
    });
  }
  if (!promptRes.ok) return promptRes;

  // Step 4 (2.1): relay entry with the parent adhoc dir (relay artifacts
  // land as a nested NN-<role>-<id8>/ subdir inside it).
  mark("entry");
  let relayResult;
  try {
    relayResult = await entry({ role, prompt: promptRes.prompt, adhocDir: parent, repoRoot, config: cfg, timeoutMs });
  } catch (e) {
    return { ok: false, error: `relay failed for ${role}: ${e?.message || String(e)}` };
  }
  const nestedRunDir =
    relayResult?.nestedRunDir ??
    relayResult?.nested ??
    relayResult?.runDir ??
    relayResult?.dir ??
    findNestedRunDir(parent, role);
  if (!nestedRunDir) {
    return fail(`missing: no nested relay run dir found in parent adhoc dir: ${parent}`);
  }
  const { verdict, findings } = extractAdhocVerdict(relayResult);

  // Step 5 (1.2): summary write into the parent adhoc dir (records the
  // nested NN-<role>-<id8>/ path; never touches relay files).
  mark("summary");
  const summary = writeSummary(parent, {
    command,
    role,
    input: parsed.input,
    verdict,
    findings,
    cmd: parsed.cmd ?? cmdEvidence?.cmd ?? null,
    cmdEvidence,
    nestedRunDir,
    timestamp: path.basename(parent).split("-")[0],
  });
  if (!summary.ok) return summary;

  // Step 6: print verdict+findings (the exact text saved in the summary).
  mark("print");
  const printed = summary.printed ?? formatAdhocPrinted({ verdict, findings });
  try {
    await print(printed);
  } catch (e) {
    return { ok: false, error: `failed to print adhoc summary: ${e?.message || String(e)}` };
  }
  return {
    ok: true,
    command,
    role,
    input: parsed.input,
    adhocDir: parent,
    nestedRunDir,
    summaryPath: summary.summaryPath,
    printed,
    verdict,
    findings,
    relayResult,
  };
}
