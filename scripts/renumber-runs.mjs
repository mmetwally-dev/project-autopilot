#!/usr/bin/env node
/*
 * Renumber all run dirs in a repo's .autopilot ledger to <seq>-<role>-<shortid>,
 * chronologically (oldest = 01, newest = highest). Skips `shell-*` scaffolding
 * dirs. Role is recovered from status.json/result.json, then the dir name, then
 * the run's own brief.txt; a fallback label is used when none are recoverable.
 *
 * Usage:
 *   node scripts/renumber-runs.mjs --repo /path/to/repo [--fallback run] [--dry-run]
 *
 * Reads-only otherwise: it never touches reports; run .autopilot/report.mjs
 * afterwards to refresh transcript links if desired.
 */
import fs from "node:fs";
import path from "node:path";
import { renumberRuns } from "./run-history.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
};
const repo = flag("repo") || process.env.AUTOPILOT_REPO || process.cwd();
const fallbackRole = flag("fallback") || "run";
const dryRun = args.includes("--dry-run");

const apDir = path.join(repo, ".autopilot");
const bases = [path.join(apDir, "runs")];
const missionsDir = path.join(apDir, "missions");
if (fs.existsSync(missionsDir)) {
  for (const m of fs.readdirSync(missionsDir)) {
    bases.push(path.join(missionsDir, m, "runs"));
  }
}

let total = 0;
for (const base of bases) {
  if (!fs.existsSync(base)) continue;
  if (dryRun) {
    const entries = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => !/^shell-/.test(e.name));
    if (entries.length) console.log(`[dry-run] ${base}: ${entries.length} run dir(s) would be renumbered`);
  } else {
    const n = renumberRuns(base, { fallbackRole });
    if (n > 0) console.log(`${base}: ${n} run dir(s) renumbered`);
    total += n;
  }
}
if (!dryRun) console.log(`done: ${total} run dir(s) renumbered`);