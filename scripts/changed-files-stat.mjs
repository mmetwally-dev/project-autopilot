import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(cwd, args) {
  const p = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (p.error) throw p.error;
  if (p.status !== 0) throw new Error(String(p.stderr || `git ${args.join(" ")} failed`).trim());
  return String(p.stdout || "");
}

function lineCount(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function withPaths(args, paths) {
  return Array.isArray(paths) && paths.length ? [...args, "--", ...paths] : args;
}

export function changedFilesStat(cwd, { paths = null, beforePaths = null } = {}) {
  const beforeSet = beforePaths instanceof Set ? beforePaths : new Set(Array.isArray(beforePaths) ? beforePaths : (beforePaths ? [beforePaths] : []));
  const diff = git(cwd, withPaths(["diff", "--stat"], paths));
  const untracked = git(cwd, withPaths(["ls-files", "--others", "--exclude-standard"], paths))
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const lines = diff.split(/\r?\n/).filter(Boolean);
  const summaryLine = lines.find((line) => /^\s*\d+\s+files?\s+changed\b/.test(line)) || "";
  const body = lines.filter((line) => line !== summaryLine);
  const summary = summaryLine.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);
  let insertions = Number(summary?.[2] ?? 0);
  let deletions = Number(summary?.[3] ?? 0);

  for (const file of untracked) {
    const n = lineCount(path.join(cwd, file));
    if (beforeSet.has(String(file).replace(/\\/g, "/"))) {
      body.push(`${file} (untracked, edited)`);
    } else {
      body.push(`${file} +${n} new`);
      insertions += n;
    }
  }

  if (!body.length) return "";
  const count = body.length;
  return [...body, `${count} file${count === 1 ? "" : "s"} changed, ${insertions} insertion${insertions === 1 ? "" : "s"}(+), ${deletions} deletion${deletions === 1 ? "" : "s"}(-)`].join("\n");
}
