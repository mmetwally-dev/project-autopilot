// Backlog #4 Part A: run the configured test command once in setup `ap setup`
// / `ap config`, classify the failures it reports, and record the files that
// cannot run inside a mission gate.
//
// Parsing is intentionally conservative: only files the runner itself names
// are extracted. When the runner is unknown we return no files and the caller
// falls back to showing the output tail with a warning, exactly as before this
// feature existed.
import fs from "node:fs";
import path from "node:path";
import { runGuardedCommand } from "./guarded-command.mjs";
import { createGateShell } from "./gate-shell.mjs";

export const PROBE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_COLLECTED_OUTPUT = 2 * 1024 * 1024;

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const FILE_EXT = String.raw`(?:test|spec)\.[cm]?[jt]sx?`;
const FILE_PATH = String.raw`(?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])?(?:[^\s()'"\`<>:]+[\\/])*[^\s()'"\`<>:]+\.${FILE_EXT}`;

export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_RE, "");
}

function normalizeFile(raw, repoRoot) {
  let file = String(raw ?? "").trim();
  if (!file) return null;
  file = file.replace(/^file:\/\//i, "");
  try { file = decodeURIComponent(file); } catch { /* keep as-is */ }
  file = file.replace(/\\/g, "/");
  file = file.replace(/:\d+:\d+$/, "");
  file = file.replace(/^\.\//, "");
  if (repoRoot) {
    const root = String(repoRoot).replace(/\\/g, "/").replace(/\/+$/, "");
    if (root && file.startsWith(`${root}/`)) file = file.slice(root.length + 1);
  }
  return file || null;
}

function lineStartOf(text, index) {
  const nl = text.lastIndexOf("\n", index);
  return nl === -1 ? 0 : nl + 1;
}

// Runner detection uses the command first (most reliable) and the output
// signatures second, so `npm test` wrapping vitest/jest is still recognised.
export function detectRunner(output, command = "") {
  const cmd = String(command ?? "");
  if (/\bvitest\b/i.test(cmd)) return "vitest";
  if (/\bjest\b/i.test(cmd)) return "jest";
  if (/\bnode\s+--test\b/.test(cmd)) return "node-test";
  if (/\bmocha\b/i.test(cmd)) return "mocha";

  const text = stripAnsi(output);
  if (/Test Files\s+\d|⎯{5,}|Vitest v?\d|❯\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?\s+\(/i.test(text)) return "vitest";
  if (/Test Suites:\s*\d|PASS\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?|●\s/i.test(text)) return "jest";
  if (/# Subtest:|^TAP version \d+|node:test/m.test(text)) return "node-test";
  if (/\d+ passing\b|\d+ failing\b|mocha/i.test(text)) return "mocha";
  return "unknown";
}

function collectMatches(text, regex, repoRoot, occurrences) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1];
    const file = normalizeFile(raw, repoRoot);
    if (!file) continue;
    const index = match.index + match[0].indexOf(raw);
    occurrences.push({ file, index, lineStart: lineStartOf(text, index) });
    if (match[0].length === 0) regex.lastIndex += 1;
  }
}

// Every place the output names a failing test file. The first occurrence in a
// runner report starts that file's failure block; later occurrences (stack
// lines, the summary arrow) are folded into the same block.
export function parseFailingFiles(output, { command = "", repoRoot = null, runner = null } = {}) {
  const text = stripAnsi(output);
  const kind = runner || detectRunner(text, command);
  const occurrences = [];

  if (kind === "vitest") {
    collectMatches(text, new RegExp(String.raw`^\s*(?:FAIL|❯)\s+(${FILE_PATH})(?=[\s:(]|$)`, "gm"), repoRoot, occurrences);
  } else if (kind === "jest") {
    collectMatches(text, new RegExp(String.raw`^\s*FAIL\s+(${FILE_PATH})(?=[\s:(]|$)`, "gm"), repoRoot, occurrences);
    if (!occurrences.length) {
      collectMatches(text, new RegExp(String.raw`^\s*at\s+.*?\((${FILE_PATH}):\d+:\d+\)\s*$`, "gm"), repoRoot, occurrences);
    }
  } else if (kind === "node-test" || kind === "mocha") {
    collectMatches(text, new RegExp(String.raw`((?:file:\/\/[^\s)]+|(?:[A-Za-z]:)?[^\s()'"]*?${FILE_PATH})):\d+:\d+`, "g"), repoRoot, occurrences);
    collectMatches(text, new RegExp(String.raw`^# Subtest:.*?(${FILE_PATH})\s*$`, "gm"), repoRoot, occurrences);
  }

  occurrences.sort((a, b) => a.index - b.index);
  const files = [];
  for (const occurrence of occurrences) {
    if (!files.includes(occurrence.file)) files.push(occurrence.file);
  }
  return { runner: kind, files, occurrences };
}

function hasMatch(text, re) {
  return String(text ?? "").search(re) >= 0;
}

function serverReason(text) {
  const match = /ECONNREFUSED[^\n]*?((?:\[[0-9a-f:]+\]|[A-Za-z0-9_.-]+):(\d{2,5}))/i.exec(text)
    || /((?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5}))/i.exec(text);
  if (match) return `server not reachable on ${match[1]}`;
  return "server not reachable (ECONNREFUSED / fetch failed)";
}

function missingEnvReason(text) {
  const named = /Environment variable not found:\s*([A-Z][A-Z0-9_]+)/i.exec(text);
  if (named) return `missing environment variable ${named[1]} (.env not loaded)`;
  const known = /\b(DATABASE_URL|DIRECT_URL|REDIS_URL|NEXTAUTH_SECRET|AUTH_SECRET|API_KEY)\b[^\n]{0,80}?(?:undefined|not\s+(?:set|defined|found)|missing|empty)/i.exec(text);
  if (known) return `missing environment variable ${known[1]} (.env not loaded)`;
  return "missing env/.env or database configuration (Prisma init failed)";
}

function noNetworkReason(text) {
  const match = /(?:ENOTFOUND|EAI_AGAIN)[^\n]*?([A-Za-z0-9.-]+\.[A-Za-z]{2,})/i.exec(text)
    || /getaddrinfo[^\n]*?([A-Za-z0-9.-]+\.[A-Za-z]{2,})/i.exec(text);
  return match
    ? `no network: cannot resolve ${match[1]} (ENOTFOUND / getaddrinfo failed)`
    : "no network (ENOTFOUND / getaddrinfo failed)";
}

// A file's cause is the strongest environment signature in its failure block.
// Server/network win over a generic Prisma init error because they explain it;
// anything without one of those signatures is a real test failure and is
// never hidden or excluded automatically.
export function classifyCause(text) {
  const source = stripAnsi(text);
  // Server/network are the root cause even when a Prisma wrapper mentions the
  // database first: Prisma init errors are grouped with missing env only when
  // there is no connection/DNS signature at all.
  if (hasMatch(source, /ECONNREFUSED|fetch failed/i)) return { kind: "server", reason: serverReason(source) };
  if (hasMatch(source, /ENOTFOUND|EAI_AGAIN|getaddrinfo/i)) return { kind: "no_network", reason: noNetworkReason(source) };
  if (hasMatch(source, /Environment variable not found|DATABASE_URL|DIRECT_URL|Prisma(?:ClientInitializationError|ClientKnownRequestError|.*(?:initialization|init|P1000|P1001|P1012))/i)) {
    return { kind: "missing_env", reason: missingEnvReason(source) };
  }
  return { kind: "other", reason: "a test failed (not environment-related)" };
}

function blockTextFor(occurrence, occurrences, text) {
  const next = occurrences.find((other) => other.index > occurrence.index && other.file !== occurrence.file);
  const summary = /^(?:Test Files|Test Suites|Tests:|Snapshots:|Time:|Ran all test suites)/m;
  const tail = text.slice(occurrence.lineStart, next ? next.lineStart : text.length);
  const summaryMatch = summary.exec(tail);
  return summaryMatch ? tail.slice(0, summaryMatch.index) : tail;
}

export function groupFailures(output, options = {}) {
  const { runner, files, occurrences } = parseFailingFiles(output, options);
  const text = stripAnsi(output);
  const groups = [];
  const byReason = new Map();
  for (const file of files) {
    const fileOccurrences = occurrences.filter((entry) => entry.file === file);
    const evidence = fileOccurrences.map((entry) => blockTextFor(entry, occurrences, text)).join("\n");
    const cause = classifyCause(evidence || text);
    let group = byReason.get(cause.reason);
    if (!group) {
      group = { kind: cause.kind, reason: cause.reason, files: [] };
      byReason.set(cause.reason, group);
      groups.push(group);
    }
    group.files.push(file);
  }
  const order = { server: 0, missing_env: 1, no_network: 2, other: 3 };
  groups.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  return { runner, files, groups };
}

export function tailLines(text, count = 40) {
  const lines = stripAnsi(text).split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-count).join("\n");
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The saved gate command omits the files that cannot run in a mission. Each
// runner gets its own native exclusion flag; no synthetic script is created.
export function buildExclusionCommand(command, files, runner) {
  const base = String(command ?? "").trim();
  const list = [...new Set((Array.isArray(files) ? files : []).map((file) => String(file).trim()).filter(Boolean))];
  if (!base || !list.length) return null;
  if (runner === "vitest") {
    const additions = list
      .filter((file) => !base.includes(`--exclude ${quote(file)}`))
      .map((file) => `--exclude ${quote(file)}`);
    return additions.length ? [base, ...additions].join(" ") : base;
  }
  if (runner === "jest") {
    if (base.includes("--testPathIgnorePatterns")) return base;
    const pattern = list.map(escapeRegExp).join("|");
    return `${base} --testPathIgnorePatterns ${quote(pattern)}`;
  }
  return null;
}

// The exact command that runs the skipped files by hand after the mission.
export function buildManualCommand(command, files) {
  const base = String(command ?? "").trim();
  const list = [...new Set((Array.isArray(files) ? files : []).map((file) => String(file).trim()).filter(Boolean))];
  if (!base || !list.length) return base;
  const quoted = list.map(quote).join(" ");
  const packageRunner = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(base);
  if (packageRunner) {
    return /\s--\s/.test(base) ? `${base} ${quoted}` : `${base} -- ${quoted}`;
  }
  return `${base} ${quoted}`;
}

// Run the configured test command through the SAME guarded runner and shell
// environment the phase gate uses. `timeoutMs` bounds the probe; passing 0
// disables the limit (tests use this for deterministic fixtures).
export async function probeTestCommand({
  repo,
  command,
  networkIsolation = true,
  envAllowlist = [],
  timeoutMs = PROBE_TIMEOUT_MS,
  logFile = null,
  onStart = null,
} = {}) {
  const cwd = path.resolve(repo);
  const { shellGuard, env } = createGateShell(cwd, cwd, networkIsolation !== false, envAllowlist);
  if (typeof onStart === "function") onStart(command);
  const result = await runGuardedCommand(cwd, command, env, shellGuard, {
    label: "setup.test-probe",
    capture: true,
    collectOutput: true,
    maxOutputBytes: MAX_COLLECTED_OUTPUT,
    ...(logFile ? { logFile } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  });
  const output = typeof result.output === "string" ? result.output : String(result.tail ?? "");
  return { ...result, ok: result.status === 0 && !result.timedOut, output };
}

// Formatting shared by setup's terminal output and the mission final report.
export function formatNotRunInMissions(list) {
  if (!Array.isArray(list) || !list.length) return "";
  const lines = ["Tests not run in missions (run them after the mission):"];
  for (const entry of list) {
    if (!entry || !Array.isArray(entry.files) || !entry.files.length) continue;
    lines.push(`- ${entry.reason}`);
    lines.push(`  files: ${entry.files.join(", ")}`);
    if (entry.command) lines.push(`  run: ${entry.command}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

export function appendNotRunInMissionsToReport(file, list) {
  const text = formatNotRunInMissions(list);
  if (!text) return false;
  try {
    if (!fs.existsSync(file)) return false;
    const current = fs.readFileSync(file, "utf8");
    if (current.includes("Tests not run in missions")) return false;
    fs.writeFileSync(file, `${current.replace(/\n+$/, "")}\n\n${text}\n`);
    return true;
  } catch {
    return false;
  }
}
