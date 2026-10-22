#!/usr/bin/env node
// Mission 024 phase 3 task 3.1: prove the relay-guards gitSnapshot and the
// execution-plane-safety gitStateSnapshot twin share the same EOL expectation.
//
// - An untouched CRLF checkout snapshot equals the clean fingerprint in BOTH
//   copies (CRLF-only rewrite is a phantom, filtered via the
//   --ignore-cr-at-eol dirty set).
// - A real CRLF-preserving edit is still detected in BOTH copies and reports
//   the small exact stat (5+/2- numstat) through the snapshot path.
// - The working-tree-clean status parsing keeps real edits to files whose
//   names contain spaces and non-ASCII characters (parsed via -z, unquoted).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {
  gitSnapshot,
  parsePorcelainV1ZEntries,
  keepEntryAfterEolFilter,
} from "./relay-guards.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

// Mission-env only: every `git` call through the outer guard PATH shim costs
// ~1 s, and gitSnapshot/gitStateSnapshot exec via process.env, so strip the
// outer guard from this process before any git call.
{ const clean = withoutOuterGitGuard(process.env); for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k]; process.env.PATH = clean.PATH; }

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
}

const cleanEnv = () => withoutOuterGitGuard({...process.env});
function git(cwd, args) {
  return spawnSync("git", args, {cwd, encoding: "utf8", env: cleanEnv(), shell: false});
}
function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-eol-twins-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "eol-twins@example.invalid"]);
  git(repo, ["config", "user.name", "EOL Twins"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}
function eolDirtySet(repo) {
  const r = git(repo, ["-c", "core.autocrlf=input", "diff", "--ignore-cr-at-eol", "--name-only", "-z", "HEAD"]);
  if (r.status !== 0) return null;
  return new Set(String(r.stdout || "").split("\0").filter(Boolean));
}
function keptStatusPaths(repo) {
  const s = git(repo, ["-c", "core.autocrlf=input", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const dirty = eolDirtySet(repo);
  const kept = [];
  for (const entry of parsePorcelainV1ZEntries(String(s.stdout || ""))) {
    if (entry.paths.some((p) => String(p).includes(".autopilot/"))) continue;
    if (entry.xy === null) { kept.push(entry.raw); continue; }
    if (!keepEntryAfterEolFilter(entry, dirty)) continue;
    kept.push(entry.toPath);
    if (entry.fromPath !== null) kept.push(entry.fromPath);
  }
  return {kept, dirty};
}

// ---- Twin 1: untouched CRLF checkout equals clean fingerprint, both copies ----
{
  const repo = makeRepo("clean");
  try {
    const file = path.join(repo, "file.txt");
    const lines = Array.from({length: 100}, (_, i) => `line-${String(i + 1).padStart(3, "0")}`);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "hundred LF lines"]);
    const relayClean = gitSnapshot(repo);
    const lf = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, lf.replace(/\n/g, "\r\n"));
    const relayRewritten = gitSnapshot(repo);
    check("twins: relay CRLF-only rewrite fingerprint unchanged",
      relayClean.fingerprint === relayRewritten.fingerprint);

    // Real CRLF-preserving edit: 2 lines modified + 3 inserted => 5+/2-.
    const edit = lf.split("\n");
    edit[9] = "line-010-EDITED";
    edit[19] = "line-020-EDITED";
    edit.splice(50, 0, "insert-a", "insert-b", "insert-c");
    fs.writeFileSync(file, edit.join("\n").replace(/\n/g, "\r\n"));
    const relayEdited = gitSnapshot(repo);
    check("twins: relay real edit changes fingerprint",
      relayClean.fingerprint !== relayEdited.fingerprint);
    const numstat = git(repo, ["-c", "core.autocrlf=input", "diff", "--ignore-cr-at-eol", "--numstat"]).stdout.trim();
    check("twins: real crlf edit normalized numstat exact 5/2",
      numstat === "5\t2\tfile.txt", numstat);
    const {kept} = keptStatusPaths(repo);
    check("twins: real crlf edit survives parse+filter", kept.includes("file.txt"), kept);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// ---- Twin 2: spaces + non-ASCII paths survive the parse+filter ----
{
  const repo = makeRepo("names");
  try {
    const spaced = path.join(repo, "sp ace.txt");
    const uni = path.join(repo, "é.txt");
    fs.writeFileSync(spaced, "spaced base\n");
    fs.writeFileSync(uni, "unicode base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "odd names"]);
    const relayClean = gitSnapshot(repo);
    fs.writeFileSync(spaced, "spaced EDITED\n");
    fs.writeFileSync(uni, "unicode EDITED\n");
    const {kept} = keptStatusPaths(repo);
    check("twins: spaced path survives parse+filter", kept.includes("sp ace.txt"), kept);
    check("twins: non-ascii path survives parse+filter", kept.includes("é.txt"), kept);
    const relayEdited = gitSnapshot(repo);
    check("twins: odd-name edits change relay fingerprint",
      relayClean.fingerprint !== relayEdited.fingerprint);
    // Phantom control: revert to committed content with CRLF-only endings;
    // both odd names must then be filtered as phantoms.
    fs.writeFileSync(spaced, "spaced base\n".replace(/\n/g, "\r\n"));
    fs.writeFileSync(uni, "unicode base\n".replace(/\n/g, "\r\n"));
    const {kept: phantomKept} = keptStatusPaths(repo);
    check("twins: CRLF-only odd names filtered as phantoms",
      !phantomKept.includes("sp ace.txt") && !phantomKept.includes("é.txt"), phantomKept);
    const relayPhantom = gitSnapshot(repo);
    check("twins: CRLF-only odd names relay fingerprint unchanged",
      relayClean.fingerprint === relayPhantom.fingerprint);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} eol-snapshot-twins check(s) failed.`);
  process.exit(1);
}
console.log("eol-snapshot-twins tests passed");
