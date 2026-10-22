#!/usr/bin/env node
// Mission 091 task 1.2: adhoc summary writer.
//
// Saves verdict/findings/--cmd evidence in the PARENT adhoc dir
// (.autopilot/adhoc/<timestamp>-<role>/) beside the relay's nested
// NN-<role>-<id8>/ run dir, and records that nested run-dir path in the
// summary. Never invokes the relay, never writes into the nested run dir,
// never duplicates relay artifacts.

import fs from "node:fs";
import path from "node:path";

export const ADHOC_SUMMARY_FILENAME = "summary.md";

// Basename of a relay nested run dir: NN-<role>-<id8> (seq 2+ digits,
// sanitized role, 8-hex id suffix).
export function isNestedRunDirName(name, role = null) {
  const text = String(name ?? "");
  const m = text.match(/^(\d{2,})-(.+)-([0-9a-fA-F]{8})$/);
  if (!m) return false;
  if (role !== null && role !== undefined && String(role) !== "") {
    const sanitized = String(role).replace(/[^A-Za-z0-9_]/g, "_");
    if (m[2] !== sanitized) return false;
  }
  return true;
}

function asLines(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  const text = String(value);
  return text === "" ? [] : text.split(/\r?\n/);
}

// Printable console text: verdict line + findings lines. This exact text is
// also embedded in the saved summary so "printed verdict+findings saved" holds.
export function formatAdhocPrinted({ verdict, findings }) {
  const out = [`Verdict: ${String(verdict ?? "").trim() || "(none)"}`];
  const lines = asLines(findings).filter((l) => l.trim() !== "");
  if (lines.length > 0) {
    out.push("Findings:");
    for (const l of lines) out.push(`- ${l}`);
  } else {
    out.push("Findings: (none)");
  }
  return out.join("\n");
}

// Full markdown summary saved in the parent adhoc dir. Records the nested
// relay run-dir path (basename + full path) plus verdict/findings and any
// --cmd evidence. Pure string builder: no I/O, no relay.
export function formatAdhocSummary({
  command = null,
  role = null,
  input = null,
  verdict = "",
  findings = [],
  cmd = null,
  cmdEvidence = null,
  nestedRunDir = "",
  timestamp = null,
} = {}) {
  const nestedBase = nestedRunDir ? path.basename(String(nestedRunDir)) : "";
  const lines = ["# Adhoc review summary", ""];
  if (command) lines.push(`- command: ${command}`);
  if (role) lines.push(`- role: ${role}`);
  if (input) lines.push(`- input: ${input}`);
  if (timestamp) lines.push(`- timestamp: ${timestamp}`);
  // The nested relay run dir is recorded, never written to.
  lines.push(`- run_dir: ${nestedBase || "(none)"}`);
  if (nestedRunDir) lines.push(`- run_dir_path: ${nestedRunDir}`);
  lines.push("");
  lines.push(formatAdhocPrinted({ verdict, findings }));
  const evidence = cmdEvidence ?? (cmd ? { cmd } : null);
  if (evidence && (evidence.cmd || evidence.stdout !== undefined || evidence.exitCode !== undefined)) {
    lines.push("", "## Command evidence");
    if (evidence.cmd) lines.push(`- cmd: ${evidence.cmd}`);
    if (evidence.exitCode !== undefined && evidence.exitCode !== null) {
      lines.push(`- exit_code: ${evidence.exitCode}`);
    }
    if (evidence.stdout !== undefined && evidence.stdout !== null && String(evidence.stdout) !== "") {
      lines.push("", "```", String(evidence.stdout).replace(/\s+$/, ""), "```");
    }
  }
  lines.push("");
  return lines.join("\n");
}

// Write the summary into the PARENT adhoc dir only. `parentDir` is the
// already-created .autopilot/adhoc/<timestamp>-<role>/ dir; `nestedRunDir` is
// the relay's nested NN-<role>-<id8>/ dir (created by the runner/relay, only
// recorded here). Never creates/writes/deletes anything under nestedRunDir.
export function writeAdhocSummary(parentDir, {
  command = null,
  role = null,
  input = null,
  verdict = "",
  findings = [],
  cmd = null,
  cmdEvidence = null,
  nestedRunDir = "",
  timestamp = null,
} = {}) {
  const parent = String(parentDir ?? "");
  if (!parent || !path.isAbsolute(parent)) {
    return { ok: false, error: `Usage error: missing: parent adhoc dir must be an absolute path (got ${JSON.stringify(parent)}).` };
  }
  let stat = null;
  try {
    stat = fs.statSync(parent);
  } catch {
    return { ok: false, error: `Usage error: missing: parent adhoc dir not found: ${parent}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `Usage error: unreadable: parent adhoc dir is not a directory: ${parent}` };
  }
  const nested = String(nestedRunDir ?? "");
  if (!nested) {
    return { ok: false, error: "Usage error: missing: nested relay run dir path is required." };
  }
  // Containment: the nested run dir must sit directly inside the parent dir,
  // and the summary file must land in the parent dir (never inside nested).
  if (path.dirname(path.resolve(nested)) !== path.resolve(parent)) {
    return { ok: false, error: `Usage error: nested run dir ${nested} is not directly inside parent adhoc dir ${parent}.` };
  }
  if (!isNestedRunDirName(path.basename(nested))) {
    return { ok: false, error: `Usage error: nested run dir basename ${JSON.stringify(path.basename(nested))} does not match NN-<role>-<id8>.` };
  }
  const summaryPath = path.join(path.resolve(parent), ADHOC_SUMMARY_FILENAME);
  // Never write into the nested dir: the resolved summary path must stay in
  // the parent dir itself.
  if (path.dirname(summaryPath) !== path.resolve(parent)) {
    return { ok: false, error: "Usage error: summary path escapes the parent adhoc dir; refusing." };
  }
  const printed = formatAdhocPrinted({ verdict, findings });
  const body = formatAdhocSummary({
    command, role, input, verdict, findings, cmd, cmdEvidence, nestedRunDir: nested, timestamp,
  });
  fs.writeFileSync(summaryPath, body, "utf8");
  return { ok: true, summaryPath, printed, body };
}
