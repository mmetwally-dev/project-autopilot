#!/usr/bin/env node
// gitSnapshot skips IGNORED test/build output dirs (dist, .playwright-mcp, ...)
// but keeps agent-config dirs and TRACKED files under those names, and takes
// its untracked list from `status` (must equal `git ls-files --others`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {gitSnapshot, touchedFilesBetween, SNAPSHOT_EXCLUDED_DIR_SEGMENTS} from "./relay-guards.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`); }
}
function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, stdio: "pipe"});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).toString().trim()}`);
  return r.stdout;
}
function write(repo, rel, content) {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  fs.writeFileSync(full, content);
}

for (const seg of ["dist", "build", "coverage",
  ".nyc_output", "out", ".cache", "__pycache__", ".pytest_cache", "target"]) {
  check(`segment ${seg} is excluded`, SNAPSHOT_EXCLUDED_DIR_SEGMENTS.includes(seg));
}
for (const seg of [".opencode", ".playwright-mcp", "playwright-report", "test-results"]) {
  check(`${seg} is not an excluded segment`, !SNAPSHOT_EXCLUDED_DIR_SEGMENTS.includes(seg));
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-snapshot-output-dirs-"));
try {
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.invalid"]);
  git(repo, ["config", "user.name", "T"]);
  write(repo, ".gitignore", ["dist/", "coverage/", ".playwright-mcp/", "test-results/", ".opencode/", ""].join("\n"));
  write(repo, "file.txt", "base\n");
  write(repo, "release/dist/tracked.js", "t1\n");
  git(repo, ["add", "-A"]);
  git(repo, ["add", "-f", "release/dist/tracked.js"]);
  git(repo, ["commit", "-q", "-m", "init"]);

  // (a) ignored build/coverage output dirs
  write(repo, "dist/a.js", "1");
  write(repo, "pkg/dist/b.js", "1");
  write(repo, "coverage/lcov.info", "1");
  const s1 = gitSnapshot(repo);
  const hasOutput = (files) => Object.keys(files).filter((f) => /(^|\/)(dist|coverage)\//.test(f) && !f.startsWith("release/"));
  check("ignored dist/ and coverage/ are not in files", hasOutput(s1.files).length === 0, hasOutput(s1.files).join(","));
  write(repo, "dist/a.js", "2");
  write(repo, "coverage/new.info", "new");
  fs.rmSync(path.join(repo, "pkg/dist"), {recursive: true});
  const s2 = gitSnapshot(repo);
  check("changing ignored dist/coverage does not change the fingerprint", s2.fingerprint === s1.fingerprint);

  // (a2) Playwright/browser artifacts stay fingerprinted
  write(repo, ".playwright-mcp/p1.png", "1");
  write(repo, "test-results/secret-screenshot.txt", "1");
  const p1 = gitSnapshot(repo);
  check("ignored .playwright-mcp and test-results files ARE in files",
    ".playwright-mcp/p1.png" in p1.files && "test-results/secret-screenshot.txt" in p1.files);
  check("adding them changes the fingerprint", p1.fingerprint !== s2.fingerprint);
  write(repo, "test-results/secret-screenshot.txt", "2");
  write(repo, ".playwright-mcp/p1.png", "2");
  const p2 = gitSnapshot(repo);
  check("changing them changes the fingerprint", p2.fingerprint !== p1.fingerprint);
  const touched = touchedFilesBetween(p1, p2, repo);
  check("touchedFilesBetween reports both artifacts",
    touched.includes("test-results/secret-screenshot.txt") && touched.includes(".playwright-mcp/p1.png"), JSON.stringify(touched));
  const s2b = p2;

  // (b) ignored agent dir stays fingerprinted
  write(repo, ".opencode/x.json", "{\"a\":1}");
  const s3 = gitSnapshot(repo);
  check("ignored .opencode/x.json is in files", ".opencode/x.json" in s3.files);
  check("adding it changed the fingerprint", s3.fingerprint !== s2b.fingerprint);
  write(repo, ".opencode/x.json", "{\"a\":2}");
  const s4 = gitSnapshot(repo);
  check("changing .opencode/x.json changes the fingerprint", s4.fingerprint !== s3.fingerprint);

  // (c) tracked file under dist/
  write(repo, "release/dist/tracked.js", "t2\n");
  const s5 = gitSnapshot(repo);
  check("tracked release/dist/tracked.js change changes the fingerprint", s5.fingerprint !== s4.fingerprint);
  check("tracked change shows in status", s5.status.toString().includes("release/dist/tracked.js"));
  check("tracked change shows in diff", s5.diff.toString().includes("+t2"));
  check("tracked file is in files", "release/dist/tracked.js" in s5.files);

  // (d) untracked list equals git ls-files --others --exclude-standard
  write(repo, "plain.txt", "p");
  write(repo, "n/d/e/f.txt", "f");
  write(repo, "sp ace.txt", "s");
  write(repo, "dir with sp/y z", "y");
  write(repo, "é ü 日本.txt", "u");
  write(repo, "nl\nname", "n");
  fs.mkdirSync(path.join(repo, "emptyd"));
  fs.mkdirSync(path.join(repo, "ne/empty"), {recursive: true});
  fs.mkdirSync(path.join(repo, "nested"));
  git(path.join(repo, "nested"), ["init", "-q"]);
  write(repo, "nested/q.txt", "q");
  fs.symlinkSync("plain.txt", path.join(repo, "lnk"));
  write(repo, ".autopilot/run/z", "z");
  const s6 = gitSnapshot(repo);
  const lsOthers = git(repo, ["ls-files", "--others", "-z", "--exclude-standard"]).toString()
    .split("\0").filter(Boolean).filter((p) => !p.startsWith(".autopilot/")).sort();
  const tracked = new Set(git(repo, ["ls-files", "-z"]).toString().split("\0").filter(Boolean));
  const ignoredScoped = new Set([".opencode/x.json", ".playwright-mcp/p1.png", "test-results/secret-screenshot.txt"]);
  const untrackedInFiles = Object.keys(s6.files).filter((f) => !tracked.has(f) && !ignoredScoped.has(f)).sort();
  // files{} skips directory entries (lstat isDirectory), as it did with ls-files.
  const lsOthersFiles = lsOthers.filter((p) => !p.endsWith("/"));
  check("untracked files set equals git ls-files --others (incl. unicode, newline, spaces)",
    JSON.stringify(untrackedInFiles) === JSON.stringify(lsOthersFiles),
    JSON.stringify({untrackedInFiles, lsOthersFiles}));
  check("nested git repo is a directory entry in ls-files (not a file in snapshot)",
    lsOthers.includes("nested/") && !untrackedInFiles.some((p) => p.startsWith("nested")));
  const statusOthers = s6.status.toString().split("\0").filter((t) => t.startsWith("?? ")).map((t) => t.slice(3))
    .filter((p) => !p.startsWith(".autopilot/")).sort();
  check("status ?? entries equal ls-files --others exactly", JSON.stringify(statusOthers) === JSON.stringify(lsOthers),
    JSON.stringify({statusOthers, lsOthers}));
  check("empty untracked dirs are in neither", !lsOthers.some((p) => p.startsWith("emptyd")) && !untrackedInFiles.some((p) => p.startsWith("emptyd")));
} finally {
  fs.rmSync(repo, {recursive: true, force: true});
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("OK");
