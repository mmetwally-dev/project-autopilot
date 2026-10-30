#!/usr/bin/env node
// Regression for the path-limited gitSnapshot diffs. Each case builds a temp
// git repo, mutates it, then compares gitSnapshot() against a reference
// rebuilt with the three original full-tree commands (status, name-only diff,
// binary diff) plus the original files/fingerprint assembly. The limited
// batched diffs must be byte-identical, including rename ordering across a
// batch boundary.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {
  gitSnapshot,
  parsePorcelainV1ZEntries,
  keepEntryAfterEolFilter,
  SNAPSHOT_EXCLUDED_DIR_SEGMENTS,
} from "./relay-guards.mjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

// Mission-env only: every `git` call through the outer guard PATH shim costs
// ~1 s, and gitSnapshot execs via process.env, so strip the guard first.
{ const clean = withoutOuterGitGuard(process.env); for (const k of Object.keys(process.env)) if (!(k in clean)) delete process.env[k]; process.env.PATH = clean.PATH; }

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
}

const cleanEnv = () => withoutOuterGitGuard({...process.env});

function git(repo, args) {
  const r = spawnSync("git", args, {cwd: repo, env: cleanEnv(), stdio: "pipe"});
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").toString().trim()}`);
  }
  return r.stdout || Buffer.alloc(0);
}
function write(repo, rel, content) {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  fs.writeFileSync(full, content);
}
function hashBytes(data) { return crypto.createHash("sha256").update(data).digest("hex"); }

function eolNormalizedFileHash(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return hashBytes(buf);
    if (!buf.includes(13)) return hashBytes(buf);
    const out = [];
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] === 13 && buf[i + 1] === 10) continue;
      out.push(buf[i]);
    }
    return hashBytes(Buffer.from(out));
  } catch { return "MISSING"; }
}

function oldPathExcluded(rel) {
  if (rel === ".autopilot/" || rel.startsWith(".autopilot/")) return true;
  return String(rel).split("/").some((seg) => SNAPSHOT_EXCLUDED_DIR_SEGMENTS.includes(seg));
}

// The pre-change snapshot assembly, kept here as the oracle. Every git call is
// the ORIGINAL full-tree command; only the downstream parsing is shared with
// relay-guards (the parsing itself was not changed by this optimization).
function oldSnapshotParts(repo) {
  const eolDirtySet = new Set(
    git(repo, ["-c", "core.autocrlf=input", "diff", "--ignore-cr-at-eol", "--name-only", "-z", "HEAD"])
      .toString().split("\0").filter(Boolean)
  );
  const statusText = git(repo, ["-c", "core.autocrlf=input", "status", "--porcelain=v1", "-z", "--untracked-files=all"]).toString("utf8");
  const statusKept = [];
  for (const entry of parsePorcelainV1ZEntries(statusText)) {
    if (entry.paths.some((p) => String(p).includes(".autopilot/"))) continue;
    if (entry.xy === null) { statusKept.push(entry.raw); continue; }
    if (!keepEntryAfterEolFilter(entry, eolDirtySet)) continue;
    statusKept.push(`${entry.xy} ${entry.toPath}`);
    if (entry.fromPath !== null) statusKept.push(entry.fromPath);
  }
  const status = Buffer.from(statusKept.join("\0") + (statusKept.length ? "\0" : ""));
  const diff = git(repo, ["-c", "core.autocrlf=input", "diff", "--ignore-cr-at-eol", "--no-ext-diff", "--binary", "HEAD", "--", ".", ":(exclude).autopilot/**"]);

  const fileSet = new Set([...eolDirtySet].filter((rel) => !rel.startsWith(".autopilot/")));
  for (const rel of git(repo, ["ls-files", "--others", "-z", "--exclude-standard"]).toString().split("\0").filter(Boolean)) {
    if (!rel.startsWith(".autopilot/")) fileSet.add(rel);
  }
  const excludePathspecs = [];
  for (const seg of SNAPSHOT_EXCLUDED_DIR_SEGMENTS) {
    excludePathspecs.push(`:(exclude)${seg}/**`, `:(exclude)**/${seg}/**`);
  }
  const ignoredEntries = git(repo, ["ls-files", "--others", "--ignored", "-z", "--exclude-standard", "--directory", "--", ".", ":(exclude).autopilot/**", ...excludePathspecs])
    .toString().split("\0").filter(Boolean);
  const dirsToExpand = [];
  for (const rel of ignoredEntries) {
    if (oldPathExcluded(rel)) continue;
    if (rel.endsWith("/")) dirsToExpand.push(rel);
    else fileSet.add(rel);
  }
  for (const dir of dirsToExpand) {
    for (const rel of git(repo, ["ls-files", "--others", "--ignored", "-z", "--exclude-standard", "--", dir]).toString().split("\0").filter(Boolean)) {
      if (oldPathExcluded(rel)) continue;
      fileSet.add(rel);
    }
  }
  const files = {};
  for (const rel of [...fileSet].sort()) {
    const full = path.join(repo, rel);
    try {
      const st = fs.lstatSync(full);
      if (st.isDirectory()) continue;
      files[rel] = {hash: eolNormalizedFileHash(full), mode: st.mode, type: st.isSymbolicLink() ? "symlink" : "file"};
    } catch { files[rel] = {hash: "MISSING", mode: 0, type: "missing"}; }
  }
  return {status, diff, files};
}

function assertMatchesOld(name, repo) {
  const snap = gitSnapshot(repo);
  const old = oldSnapshotParts(repo);
  check(`${name}: status identical`, snap.status.equals(old.status),
    `new=${JSON.stringify(snap.status.toString())} old=${JSON.stringify(old.status.toString())}`);
  check(`${name}: diff identical (Buffer.equals)`, Buffer.from(snap.diff).equals(Buffer.from(old.diff)),
    `new=${Buffer.byteLength(snap.diff)}B old=${old.diff.length}B`);
  check(`${name}: files identical`, JSON.stringify(snap.files) === JSON.stringify(old.files),
    `new=${Object.keys(snap.files).length} old=${Object.keys(old.files).length}`);
  const expectedFingerprint = hashBytes(Buffer.from(JSON.stringify({
    head: snap.head,
    headSymbolic: snap.headSymbolic,
    refs: snap.refs,
    config: snap.config,
    sequencer: snap.sequencer,
    reflogs: snap.reflogs,
    objects: snap.objects,
    indexState: snap.indexState,
    hooksDigest: snap.hooksDigest,
    administrativeDigest: snap.administrativeDigest,
    // The three fields this optimization touches come from the old-way oracle.
    status: old.status.toString("utf8"),
    diff: old.diff.toString("utf8"),
    files: old.files,
  })));
  check(`${name}: fingerprint matches old-way`, snap.fingerprint === expectedFingerprint,
    `new=${snap.fingerprint} old=${expectedFingerprint}`);
  return snap;
}

function makeRepo(label) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-snapshot-limited-diff-${label}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "snapshot-limited-diff@example.invalid"]);
  git(repo, ["config", "user.name", "Snapshot Limited Diff"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, ".gitignore"),
    ["node_modules/", ".next/", ".autopilot/", "*.log", ""].join("\n"));
  return repo;
}
function commitAll(repo, message) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
}

const cases = [];
function addCase(label, setup, mutate, extra) {
  cases.push({label, setup, mutate, extra});
}

addCase("clean", (repo) => {
  write(repo, "file.txt", "baseline\n");
  commitAll(repo, "init");
}, () => {});

addCase("modified", (repo) => {
  write(repo, "file.txt", "baseline\n");
  commitAll(repo, "init");
}, (repo) => {
  write(repo, "file.txt", "changed\n");
});

addCase("deleted", (repo) => {
  write(repo, "gone.txt", "delete me\n");
  commitAll(repo, "init");
}, (repo) => {
  fs.unlinkSync(path.join(repo, "gone.txt"));
});

addCase("staged-rename", (repo) => {
  write(repo, "old-name.txt", "rename me\n");
  commitAll(repo, "init");
}, (repo) => {
  git(repo, ["mv", "old-name.txt", "new-name.txt"]);
});

addCase("added-staged", (repo) => {
  write(repo, "base.txt", "base\n");
  commitAll(repo, "init");
}, (repo) => {
  write(repo, "added.txt", "brand new\n");
  git(repo, ["add", "added.txt"]);
});

addCase("untracked", (repo) => {
  write(repo, "base.txt", "base\n");
  commitAll(repo, "init");
}, (repo) => {
  write(repo, "untracked.txt", "not added\n");
});

addCase("ignored", (repo) => {
  write(repo, "base.txt", "base\n");
  commitAll(repo, "init");
}, (repo) => {
  write(repo, "debug.log", "ignored output\n");
});

addCase("crlf-phantom", (repo) => {
  const lines = Array.from({length: 40}, (_, i) => `line-${i + 1}`);
  write(repo, "crlf.txt", `${lines.join("\n")}\n`);
  commitAll(repo, "init");
}, (repo) => {
  const lf = fs.readFileSync(path.join(repo, "crlf.txt"), "utf8");
  fs.writeFileSync(path.join(repo, "crlf.txt"), lf.replace(/\n/g, "\r\n"));
}, (snap) => {
  check("crlf-phantom: filtered from status", snap.status.length === 0,
    JSON.stringify(snap.status.toString()));
  check("crlf-phantom: not present in diff", snap.diff.length === 0,
    `${snap.diff.length}B`);
});

addCase("binary", (repo) => {
  fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 10, 13]));
  commitAll(repo, "init");
}, (repo) => {
  fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 9, 8, 7, 0, 255, 13, 10, 11]));
});

addCase("spaces-unicode", (repo) => {
  write(repo, "sp ace.txt", "spaced base\n");
  write(repo, "é.txt", "unicode base\n");
  write(repo, "nested dir/naïve file.txt", "nested base\n");
  commitAll(repo, "init");
}, (repo) => {
  write(repo, "sp ace.txt", "spaced changed\n");
  write(repo, "é.txt", "unicode changed\n");
  write(repo, "nested dir/naïve file.txt", "nested changed\n");
});

addCase("multi-batch", (repo) => {
  for (let i = 0; i < 450; i += 1) {
    write(repo, `f-${String(i).padStart(3, "0")}.txt`, `base ${i}\n`);
  }
  write(repo, "a-cross-batch-source.txt", "rename across batches\n");
  commitAll(repo, "init");
}, (repo) => {
  for (let i = 0; i < 450; i += 1) {
    write(repo, `f-${String(i).padStart(3, "0")}.txt`, `changed ${i}\n`);
  }
  // The destination sorts after every f-* file, so source and destination
  // land in different naive batches; the implementation must keep the pair
  // together to reproduce the full-tree rename output.
  git(repo, ["mv", "a-cross-batch-source.txt", "z-cross-batch-dest.txt"]);
}, (snap) => {
  const headers = snap.diff.toString("utf8").split("\n").filter((line) => line.startsWith("diff --git ")).length;
  check("multi-batch: all 450 edits plus one rename are present", headers === 451, headers);
});

addCase("autopilot-excluded", (repo) => {
  write(repo, "base.txt", "base\n");
  write(repo, ".autopilot/tracked.txt", "autopilot baseline\n");
  git(repo, ["add", "-A", "-f"]);
  git(repo, ["commit", "-q", "-m", "init"]);
}, (repo) => {
  write(repo, ".autopilot/tracked.txt", "autopilot changed\n");
}, (snap) => {
  check("autopilot-excluded: diff stays empty", snap.diff.length === 0, `${snap.diff.length}B`);
  check("autopilot-excluded: status stays empty", snap.status.length === 0,
    JSON.stringify(snap.status.toString()));
  check("autopilot-excluded: path absent from files", !(".autopilot/tracked.txt" in snap.files),
    Object.keys(snap.files));
});

for (const {label, setup, mutate, extra} of cases) {
  const repo = makeRepo(label);
  try {
    setup(repo);
    mutate(repo);
    const snap = assertMatchesOld(label, repo);
    if (extra) extra(snap, repo);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} snapshot-limited-diff check(s) failed.`);
  process.exit(1);
}
console.log("snapshot-limited-diff tests passed");
