#!/usr/bin/env node
// TASK-28 — evidence for `git_commit_detected`.
//
// Unit: describeGitStateChange()/GIT_STATE_FIELDS/redactedGitSnapshot() from
// scripts/relay-guards.mjs over synthetic snapshots.
// Integration: one real temp repo, stage-then-unstage (git add + git reset),
// asserting the actually-differing fields (the run-58 hypothesis).
// End-to-end: the smallest live `git_commit_detected` loop (a real,
// guard-bypassed commit, the test-guard-log-availability section-3 shape —
// no adapter needed) driven through the REAL production helpers into a
// result.json-shaped object through the same conditional makeRelayResult()
// uses, plus source-text pins proving makeRelayResult() itself is wired.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {
  GIT_STATE_FIELDS,
  describeGitStateChange,
  redactedGitSnapshot,
  touchedFilesBetween,
  gitSnapshot,
  createGitMutationGuard,
  classifyGitBlocks
} from "./relay-guards.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  return false;
}

// Mirror of scripts/autopilot.mjs makeRelayResult()'s detection (kept in
// lockstep; if the source changes, update this too). Proves the refactored
// comparison equals the old `||` chain per field.
function commitDetectedLikeRelay(before, after) {
  const refsChanged = before.refs !== after.refs;
  const changes = describeGitStateChange(before, after);
  const administrativeGitStateChanged = refsChanged
    || changes.some((entry) => entry.field !== "head" && entry.field !== "refs");
  return before.head !== after.head || administrativeGitStateChanged;
}

function baseSnapshot() {
  return {
    head: "aaa111",
    headSymbolic: "refs/heads/main",
    refs: "refs/heads/main\0aaa111\0\n",
    config: {
      "--local": "0:user.name=Bob\nuser.email=bob@example.invalid",
      "--worktree": "1:",
      "--global": "0:user.name=Bob",
      "--system": "128:"
    },
    sequencer: "MERGE_HEAD=0,CHERRY_PICK_HEAD=0",
    reflogs: "HEAD:abc123",
    objects: "count: 3\nsize: 0\nin-pack: 0\n",
    indexState: "H file.txt\n",
    hooksDigest: "default:pre-commit:hash1:mode=33188:symlink=false",
    administrativeDigest: "ORIG_HEAD:ABSENT"
  };
}

// ---- Unit: identical snapshots -> [] ----
{
  const snap = baseSnapshot();
  check("identical snapshots -> []", describeGitStateChange(snap, structuredClone(snap)).length === 0);
}

// ---- Unit: each field on its own -> exactly one entry ----
{
  const cases = {
    head: ["bbb222", "aaa111"],
    headSymbolic: ["DETACHED", "refs/heads/main"],
    refs: ["refs/heads/main\0bbb222\0\n", "refs/heads/main\0aaa111\0\n"],
    config: ["0:user.name=Bob\nuser.email=changed@example.invalid", "0:user.name=Bob\nuser.email=bob@example.invalid"],
    sequencer: ["MERGE_HEAD=1,CHERRY_PICK_HEAD=0", "MERGE_HEAD=0,CHERRY_PICK_HEAD=0"],
    reflogs: ["HEAD:def456", "HEAD:abc123"],
    objects: ["count: 4\nsize: 0\nin-pack: 0\n", "count: 3\nsize: 0\nin-pack: 0\n"],
    indexState: ["H file.txt\nH other.txt\n", "H file.txt\n"],
    hooksDigest: ["default:pre-commit:hash2:mode=33188:symlink=false", "default:pre-commit:hash1:mode=33188:symlink=false"],
    administrativeDigest: ["ORIG_HEAD:file:deadbeef:mode=33188", "ORIG_HEAD:ABSENT"]
  };
  for (const [field, [afterVal, beforeVal]] of Object.entries(cases)) {
    const before = baseSnapshot();
    const after = baseSnapshot();
    if (field === "config") {
      before.config = {...before.config, "--local": beforeVal};
      after.config = {...after.config, "--local": afterVal};
    } else {
      before[field] = beforeVal;
      after[field] = afterVal;
    }
    const out = describeGitStateChange(before, after);
    const okSingle = out.length === 1 && out[0].field === field;
    check(`single-field change: ${field} -> exactly one entry`, okSingle, out.map((e) => e.field));
    if (okSingle) {
      if (field === "head" || field === "headSymbolic") {
        check(`single-field change: ${field} added/removed`, JSON.stringify(out[0].added) === JSON.stringify([afterVal])
          && JSON.stringify(out[0].removed) === JSON.stringify([beforeVal]), out[0]);
      } else {
        check(`single-field change: ${field} counts exact`, out[0].addedCount === out[0].added.length
          && out[0].removedCount === out[0].removed.length && out[0].truncated === false, out[0]);
      }
    }
  }
}

// ---- Unit: fixed field order ----
{
  const before = baseSnapshot();
  const after = baseSnapshot();
  after.administrativeDigest = "ORIG_HEAD:file:x:mode=1";
  after.head = "zzz999";
  after.indexState = "H file.txt\nH z.txt\n";
  after.config = {...after.config, "--local": "0:user.name=Zed"};
  const fields = describeGitStateChange(before, after).map((e) => e.field);
  check("fixed field order", JSON.stringify(fields) === JSON.stringify(["head", "config", "indexState", "administrativeDigest"]), fields);
}

// ---- Unit: indexState +1/-1; objects count:/size: ----
{
  const before = baseSnapshot();
  const after = baseSnapshot();
  before.indexState = "H a.txt\nH b.txt\n";
  after.indexState = "H a.txt\nH c.txt\n";
  const entry = describeGitStateChange(before, after).find((e) => e.field === "indexState");
  check("indexState gains one line and loses another",
    entry && JSON.stringify(entry.added) === JSON.stringify(["H c.txt"])
    && JSON.stringify(entry.removed) === JSON.stringify(["H b.txt"])
    && entry.addedCount === 1 && entry.removedCount === 1, entry);

  const b2 = baseSnapshot();
  const a2 = baseSnapshot();
  b2.objects = "count: 3\nsize: 12\nin-pack: 0\n";
  a2.objects = "count: 4\nsize: 15\nin-pack: 0\n";
  const oEntry = describeGitStateChange(b2, a2).find((e) => e.field === "objects");
  check("objects count:/size: lines diff",
    oEntry && oEntry.added.includes("count: 4") && oEntry.added.includes("size: 15")
    && oEntry.removed.includes("count: 3") && oEntry.removed.includes("size: 12"), oEntry);
}

// ---- Unit: 120 added lines -> 50 kept, truncated, exact count ----
{
  const before = baseSnapshot();
  const after = baseSnapshot();
  before.refs = "";
  after.refs = Array.from({length: 120}, (_, i) => `refs/heads/b${i}\0aaa${i}\0`).join("\n") + "\n";
  const entry = describeGitStateChange(before, after).find((e) => e.field === "refs");
  check("120 added lines -> 50 kept, truncated, addedCount:120",
    entry && entry.added.length === 50 && entry.truncated === true
    && entry.addedCount === 120 && entry.removedCount === 0, entry && {kept: entry.added.length, truncated: entry.truncated, addedCount: entry.addedCount});
}

// ---- Unit: 2,000-char line truncated to 500 chars ----
{
  const before = baseSnapshot();
  const after = baseSnapshot();
  const long = `x=${"y".repeat(1998)}`;
  before.indexState = "H a.txt\n";
  after.indexState = `H a.txt\n${long}\n`;
  const entry = describeGitStateChange(before, after).find((e) => e.field === "indexState");
  const stored = entry?.added.find((l) => l.startsWith("x="));
  check("2,000-char line stored truncated to 500 chars",
    stored !== undefined && stored.length <= 501 && stored.endsWith("…") && stored === `${long.slice(0, 500)}…`,
    stored && {length: stored.length, suffix: stored.slice(-1)});
}

// ---- Unit: every-field blowup stays within 64 KB, fields+counts intact ----
{
  const before = baseSnapshot();
  const after = baseSnapshot();
  const bigLines = (prefix, n) => Array.from({length: n}, (_, i) => `${prefix}-${i}-${"z".repeat(400)}`).join("\n") + "\n";
  after.head = `newhead-${"h".repeat(100)}`;
  after.headSymbolic = "DETACHED";
  after.refs = bigLines("ref", 300);
  before.refs = bigLines("oldref", 300);
  after.sequencer = `MERGE_HEAD=1,${"q".repeat(2000)}`;
  after.reflogs = bigLines("reflog", 300);
  before.reflogs = bigLines("oldreflog", 300);
  after.objects = bigLines("obj", 300);
  before.objects = bigLines("oldobj", 300);
  after.indexState = bigLines("idx", 300);
  before.indexState = bigLines("oldidx", 300);
  after.hooksDigest = bigLines("hook", 300);
  before.hooksDigest = bigLines("oldhook", 300);
  after.administrativeDigest = bigLines("admin", 300);
  before.administrativeDigest = bigLines("oldadmin", 300);
  after.config = {...after.config, "--local": `0:\n${bigLines("cfg", 300)}`};
  before.config = {...before.config, "--local": `0:\n${bigLines("oldcfg", 300)}`};
  const out = describeGitStateChange(before, after);
  const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");
  check("every-field blowup stays within 64 KB", bytes <= 64 * 1024, {bytes});
  check("every-field blowup keeps every field",
    JSON.stringify(out.map((e) => e.field)) === JSON.stringify([...GIT_STATE_FIELDS]), out.map((e) => e.field));
  // sequencer is one comma-joined line, so its counts are 1/1; every other
  // multi-line field moved 300 lines each way.
  const singleLine = new Set(["head", "headSymbolic", "sequencer"]);
  check("every-field blowup keeps exact counts",
    out.every((e) => Number.isInteger(e.addedCount) && Number.isInteger(e.removedCount)
      && (singleLine.has(e.field)
        ? e.addedCount === 1 && e.removedCount === 1
        : e.addedCount === 300 && e.removedCount === 300)),
    out.map((e) => ({field: e.field, addedCount: e.addedCount, removedCount: e.removedCount})));
}

// ---- Unit: GIT_STATE_FIELDS pin (refactored comparison == old || chain) ----
{
  let ok = true;
  for (const field of GIT_STATE_FIELDS) {
    const before = baseSnapshot();
    const after = baseSnapshot();
    if (field === "config") after.config = {...after.config, "--local": "0:user.name=Someone Else"};
    else if (field === "head") after.head = "different-head";
    else if (field === "headSymbolic") after.headSymbolic = "DETACHED";
    else after[field] = `${after[field]}#changed`;
    if (!commitDetectedLikeRelay(before, after)) {
      ok = false;
      console.error(`FAIL GIT_STATE_FIELDS pin: differing only in '${field}' does not trip commitDetected`);
    }
  }
  const snap = baseSnapshot();
  if (commitDetectedLikeRelay(snap, structuredClone(snap))) {
    ok = false;
    console.error("FAIL GIT_STATE_FIELDS pin: identical pair trips commitDetected");
  }
  check("GIT_STATE_FIELDS pin: each field trips, identical does not", ok);
  check("GIT_STATE_FIELDS has the ten expected fields",
    JSON.stringify([...GIT_STATE_FIELDS]) === JSON.stringify(["head", "headSymbolic", "refs", "config", "sequencer", "reflogs", "objects", "indexState", "hooksDigest", "administrativeDigest"]),
    [...GIT_STATE_FIELDS]);
}

// ---- Unit: duplicate lines are multisets ----
{
  const before = baseSnapshot();
  const after = baseSnapshot();
  before.indexState = "H dup.txt\nH dup.txt\nH once.txt\n";
  after.indexState = "H dup.txt\nH other.txt\n";
  const entry = describeGitStateChange(before, after).find((e) => e.field === "indexState");
  check("duplicate lines handled as multisets",
    entry && JSON.stringify(entry.removed.sort()) === JSON.stringify(["H dup.txt", "H once.txt"])
    && JSON.stringify(entry.added) === JSON.stringify(["H other.txt"])
    && entry.addedCount === 1 && entry.removedCount === 2, entry);
}

// ---- Unit: config redaction ----
{
  const before = baseSnapshot();
  const after = baseSnapshot();
  before.config = {...before.config, "--local": "0:user.name=Bob\nuser.email=bob@example.invalid"};
  after.config = {...after.config, "--local": "0:user.name=Bob\nuser.email=bob@example.invalid\nhttp.extraheader=AUTHORIZATION: bearer SECRET123\nmy.url=https://alice:hunter2@example.com/repo.git"};
  const out = describeGitStateChange(before, after);
  const text = JSON.stringify(out);
  check("config redaction: URL credentials masked", !text.includes("hunter2") && text.includes("https://***@example.com/repo.git"), text.slice(0, 400));
  check("config redaction: secret-valued key masked", !text.includes("SECRET123") && !text.includes("bearer SECRET123"), text.slice(0, 400));
  check("config redaction: key name stays readable", text.includes("http.extraheader") && text.includes("my.url"), text.slice(0, 400));
  // Key-name-only matching: a value containing a secret word under a benign
  // key is kept verbatim.
  const b2 = baseSnapshot();
  const a2 = baseSnapshot();
  b2.config = {...b2.config, "--local": "0:user.name=Bob"};
  a2.config = {...a2.config, "--local": "0:user.name=Bob the token collector"};
  const out2 = JSON.stringify(describeGitStateChange(b2, a2));
  check("config redaction: benign key value kept verbatim", out2.includes("Bob the token collector"), out2.slice(0, 300));
}

// ---- Unit: redactedGitSnapshot shape ----
{
  const snap = {...baseSnapshot(), diff: "HUGE", files: {a: 1}, status: "M", fingerprint: "fp", extra: true};
  snap.config = {...snap.config, "--local": "0:github.token=SUPERSECRET\nuser.name=Bob"};
  const red = redactedGitSnapshot(snap);
  check("redacted snapshot holds only the ten fields",
    JSON.stringify(Object.keys(red).sort()) === JSON.stringify([...GIT_STATE_FIELDS].sort()), Object.keys(red));
  check("redacted snapshot drops diff/files/status", !("diff" in red) && !("files" in red) && !("status" in red) && !("fingerprint" in red));
  const text = JSON.stringify(red);
  check("redacted snapshot masks secrets", !text.includes("SUPERSECRET") && text.includes("github.token=***") && text.includes("user.name=Bob"), text.slice(0, 300));
}

// ---- Integration: real repo, stage-then-unstage ----
function git(cwd, args, env = withoutOuterGitGuard(process.env)) {
  return spawnSync("git", args, {cwd, encoding: "utf8", env, shell: false});
}

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-gitstate-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "gitstate-test@example.invalid"]);
  git(repo, ["config", "user.name", "Git State Test"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

{
  const repo = makeRepo("unstage");
  try {
    const before = gitSnapshot(repo);
    fs.writeFileSync(path.join(repo, "new.txt"), "hello\n");
    git(repo, ["add", "new.txt"]);
    git(repo, ["reset", "-q"]);
    const after = gitSnapshot(repo);
    const fields = describeGitStateChange(before, after).map((e) => e.field);
    console.log(`stage-then-unstage changed: ${fields.join(", ") || "(none)"}`);
    check("stage-then-unstage: HEAD unchanged", before.head === after.head);
    check("stage-then-unstage: objects grew and never shrank back", fields.includes("objects"), fields);
    check("stage-then-unstage: tripped fields are reported", fields.length > 0, fields);
    check("stage-then-unstage: trips commitDetected with HEAD equal", commitDetectedLikeRelay(before, after) === true);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// ---- Integration: CRLF-only rewrite invisible, real CRLF edit exact ----
// Fixture mirrors DIAGNOSIS 1.1: LF blobs, CRLF worktree (Windows checkout
// shape), no ambient autocrlf (WSL shape). All worktree readings go through
// the production gitSnapshot()/touchedFilesBetween()/describeGitStateChange()
// helpers; raw `git -c ...` invocations use explicit config so the contrast
// is deterministic regardless of ambient gitconfig.
{
  const repo = makeRepo("crlf");
  try {
    const file = path.join(repo, "file.txt");
    const lines = Array.from({length: 100}, (_, i) => `line-${String(i + 1).padStart(3, "0")}`);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "hundred LF lines"]);
    const before = gitSnapshot(repo);
    // CRLF-only rewrite: identical lines, CRLF terminators, blobs stay LF.
    const lf = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, lf.replace(/\n/g, "\r\n"));
    const rewritten = gitSnapshot(repo);
    check("crlf-only rewrite: fingerprint unchanged", before.fingerprint === rewritten.fingerprint);
    const phantomTouched = touchedFilesBetween(before, rewritten, repo);
    check("crlf-only rewrite: touched files empty", phantomTouched.length === 0, phantomTouched);
    const phantomChanges = describeGitStateChange(before, rewritten);
    check("crlf-only rewrite: state-change evidence empty", phantomChanges.length === 0, phantomChanges.map((e) => e.field));
    check("crlf-only rewrite: redacted snapshots identical",
      JSON.stringify(redactedGitSnapshot(before)) === JSON.stringify(redactedGitSnapshot(rewritten)));
    // Raw contrast proving the artifact the normalization hides.
    const phantom = git(repo, ["-c", "core.autocrlf=false", "diff", "--stat"]).stdout;
    check("crlf-only rewrite: raw WSL-style diff still shows phantom churn",
      phantom.includes("file.txt") && /100 insertions/.test(phantom), phantom.trim().split("\n").pop());
    const calm = git(repo, ["-c", "core.autocrlf=input", "diff", "--ignore-cr-at-eol", "--stat"]).stdout;
    check("crlf-only rewrite: normalized diff is clean", calm.trim() === "", calm.trim().slice(0, 120));

    // Real edit preserving CRLF endings: 2 lines modified + 3 inserted.
    const edit = lf.split("\n");
    edit[9] = "line-010-EDITED";
    edit[19] = "line-020-EDITED";
    edit.splice(50, 0, "insert-a", "insert-b", "insert-c");
    fs.writeFileSync(file, edit.join("\n").replace(/\n/g, "\r\n"));
    const edited = gitSnapshot(repo);
    check("real crlf edit: fingerprint changed", before.fingerprint !== edited.fingerprint);
    const editTouched = touchedFilesBetween(before, edited, repo);
    check("real crlf edit: touched files exact", JSON.stringify(editTouched) === JSON.stringify(["file.txt"]), editTouched);
    const editChanges = describeGitStateChange(before, edited);
    check("real crlf edit: no phantom admin evidence", editChanges.length === 0, editChanges.map((e) => e.field));
    const numstat = git(repo, ["-c", "core.autocrlf=input", "diff", "--ignore-cr-at-eol", "--numstat"]).stdout.trim();
    check("real crlf edit: normalized numstat exact 5/2", numstat === "5\t2\tfile.txt", numstat);

    // Commit the real edit with LF-normalizing add so blobs stay LF.
    git(repo, ["-c", "core.autocrlf=input", "add", "-A"]);
    const committed = git(repo, ["-c", "core.autocrlf=input", "commit", "-q", "-m", "real edit on crlf fixture"]);
    check("crlf commit: commit succeeded", committed.status === 0, (committed.stderr || "").slice(0, 200));
    const committedSnap = gitSnapshot(repo);
    const headEntry = describeGitStateChange(edited, committedSnap).find((e) => e.field === "head");
    check("crlf commit: head evidence with exact counts",
      !!headEntry && headEntry.addedCount === 1 && headEntry.removedCount === 1, headEntry);
    const commitTouched = touchedFilesBetween(edited, committedSnap, repo);
    check("crlf commit: touched files exact via range fallback",
      JSON.stringify(commitTouched) === JSON.stringify(["file.txt"]), commitTouched);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// ---- End-to-end: live git_commit_detected loop through the production
// ---- helpers into a result.json-shaped object.
// Loop: the test-guard-log-availability section-3 shape — a real,
// guard-bypassed commit between the two snapshots. It is the smallest live
// trigger of `git_commit_detected` (no adapter needed; the b4 loops only
// mirror the detection formula or assert source text, and the checkpoint
// loop only classifies the policy string — none of them produces a relay
// result.json with snapshots).
{
  const repo = makeRepo("e2e");
  try {
    const runDir = path.join(repo, ".autopilot", "runs", "01-implementer-eeee4444");
    fs.mkdirSync(runDir, {recursive: true});
    const guard = createGitMutationGuard(runDir, repo);
    const before = gitSnapshot(repo);
    // Guard bypassed on purpose: real HEAD/refs mutation, empty guard log.
    const real = git(repo, ["commit", "--allow-empty", "-m", "real mutation, guard bypassed"]);
    const after = gitSnapshot(repo);
    check("e2e: the direct commit actually succeeded", real.status === 0);

    // Exactly makeRelayResult()'s evidence block: conditional gitStateChanges
    // plus redacted git-guard/snapshot-{before,after}.json, warning on
    // failure without changing the outcome.
    const changes = describeGitStateChange(before, after);
    const refsChanged = before.refs !== after.refs;
    const administrative = refsChanged || changes.some((e) => e.field !== "head" && e.field !== "refs");
    const commitDetected = before.head !== after.head || administrative;
    const resultJson = {policyViolation: commitDetected ? "git_commit_detected" : null};
    if (commitDetected) {
      resultJson.gitStateChanges = changes;
      try {
        fs.mkdirSync(guard.guardDir, {recursive: true});
        fs.writeFileSync(path.join(guard.guardDir, "snapshot-before.json"), JSON.stringify(redactedGitSnapshot(before), null, 2));
        fs.writeFileSync(path.join(guard.guardDir, "snapshot-after.json"), JSON.stringify(redactedGitSnapshot(after), null, 2));
      } catch (error) {
        console.warn(`git state evidence snapshots unavailable: ${error?.message || error}`);
      }
    }
    const onDisk = path.join(runDir, "result.json");
    fs.writeFileSync(onDisk, JSON.stringify(resultJson, null, 2));
    const readBack = JSON.parse(fs.readFileSync(onDisk, "utf8"));

    check("e2e: result.json contains gitStateChanges naming the changed field",
      Array.isArray(readBack.gitStateChanges)
      && readBack.gitStateChanges.some((e) => e.field === "head")
      && readBack.policyViolation === "git_commit_detected",
      readBack.gitStateChanges?.map((e) => e.field));
    for (const name of ["snapshot-before.json", "snapshot-after.json"]) {
      const file = path.join(guard.guardDir, name);
      check(`e2e: git-guard/${name} exists`, fs.existsSync(file));
      if (fs.existsSync(file)) {
        const snap = JSON.parse(fs.readFileSync(file, "utf8"));
        check(`e2e: ${name} holds only the ten fields`,
          JSON.stringify(Object.keys(snap).sort()) === JSON.stringify([...GIT_STATE_FIELDS].sort()), Object.keys(snap));
      }
    }

    // Non-violating control: identical snapshots -> no gitStateChanges key.
    const calmBefore = gitSnapshot(repo);
    const calmAfter = gitSnapshot(repo);
    const calmChanges = describeGitStateChange(calmBefore, calmAfter);
    const calmDetected = calmBefore.head !== calmAfter.head
      || calmBefore.refs !== calmAfter.refs
      || calmChanges.some((e) => e.field !== "head" && e.field !== "refs");
    const calmResult = {policyViolation: null};
    if (calmDetected) calmResult.gitStateChanges = calmChanges;
    check("e2e: non-violating run has no gitStateChanges",
      calmDetected === false && !("gitStateChanges" in calmResult), Object.keys(calmResult));
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
}

// ---- Source pins: makeRelayResult() itself is wired ----
{
  const source = fs.readFileSync(path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8");
  // Membership, not exact text: TASK-31 appended formatRelayPolicyViolation to
  // this import list and the old literal pin (`…, redactedGitSnapshot }`) broke.
  const relayGuardsImport = (source.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/relay-guards\.mjs"/) || [])[1] || "";
  const importedNames = relayGuardsImport.split(",").map((s) => s.trim());
  check("wiring: makeRelayResult imports describeGitStateChange",
    importedNames.includes("describeGitStateChange") && importedNames.includes("redactedGitSnapshot"), importedNames.join(","));
  // TASK-39 moved the verdict into relay-guards.mjs's classifyGitBlocks:
  // check the behavior there, and that makeRelayResult still hands it
  // commitDetected.
  const sameSnapshot = {head: "h", refs: "r", indexState: "i"};
  const verdict = classifyGitBlocks([{target: "unproven"}], {
    commitDetected: true, readOnlyViolation: false, guardLogUnavailable: false,
    before: sameSnapshot, after: sameSnapshot,
  });
  check("wiring: commitDetected still feeds git_commit_detected",
    verdict.policyViolation === "git_commit_detected"
      && /classifyGitBlocks\(guardEvents,\{commitDetected,/.test(source), verdict);
  check("wiring: commitDetected still includes administrativeGitStateChanged",
    /const commitDetected=before\.head!==after\.head \|\| administrativeGitStateChanged/.test(source), null);
  check("wiring: violation records gitStateChanges", source.includes("result.gitStateChanges=gitStateChangesForEvidence"), null);
  check("wiring: violation writes snapshot-before/after.json",
    source.includes("snapshot-before.json") && source.includes("snapshot-after.json"), null);
  check("wiring: policy evidence names git_state_changed fields",
    source.includes('"git_state_changed"') || source.includes("'git_state_changed'") || source.includes("git_state_changed"), null);
}

if (failures) {
  console.error(`${failures} git-state-change-evidence check(s) failed.`);
  process.exit(1);
}
console.log("git-state-change-evidence tests passed");
