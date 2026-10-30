#!/usr/bin/env node
// Regression test: Git can track regular files beneath a path that is a
// SYMLINK in the working tree (typically committed on Windows with
// core.symlinks=false). `git status` still reports those tracked children
// (as deleted) plus the symlink itself, so a naive per-path capture copies a
// child "through" the link into a real snapshot directory and then crashes
// with EEXIST when it tries to create the symlink at the same path.
//
// A symlink path must be captured ONCE as a symlink (its own target text),
// with its descendants skipped, and that shape must survive the delta path
// used by the orchestrator.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";
import {ensureBaseline, scopedDelta} from "./implementation-baseline.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? " -- " + detail : ""}`); }
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", env: withoutOuterGitGuard(process.env), shell: false});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `ap-ib-sp-${prefix}-`));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "ib-sp-test@example.invalid"]);
  git(repo, ["config", "user.name", "IB Symlink Parent Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function cleanup(...dirs) {
  for (const d of dirs) { try { fs.rmSync(d, {recursive: true, force: true}); } catch { /* best-effort */ } }
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), {recursive: true});
    fs.writeFileSync(abs, content);
  }
}

function baselines(repo, key) {
  const dir = path.join(repo, ".autopilot", "baseline", key);
  return {
    dir,
    manifest: JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")),
    filesDir: path.join(dir, "files"),
  };
}

function probeSymlinkCapability(repo) {
  const target = path.join(repo, ".symlink-probe-target");
  const link = path.join(repo, ".symlink-probe-link");
  try {
    fs.writeFileSync(target, "probe");
    fs.symlinkSync(target, link);
    fs.unlinkSync(link);
    fs.unlinkSync(target);
    return true;
  } catch {
    try { fs.rmSync(link, {force: true}); } catch {}
    try { fs.rmSync(target, {force: true}); } catch {}
    return false;
  }
}

const LINK_REL = "skills/next-best-practices";
const TARGET_REL = "vendor/next-best-practices";
const OTHER_TARGET_REL = "vendor-other/next-best-practices";
const CHILDREN = {
  "SKILL.md": "same skill body\n",
  "async-patterns.md": "same async patterns\n",
};

// ===========================================================================
// The crash shape: tracked regular files, working tree replaced by a symlink.
// ===========================================================================
{
  const repo = makeRepo("symlink");
  if (!probeSymlinkCapability(repo)) {
    console.log("SKIP: symlink-parent capture/delta checks — symlink creation is unavailable on this platform (Windows needs Developer Mode or elevation).");
    cleanup(repo);
  } else {
    try {
      writeFiles(repo, Object.fromEntries(
        Object.entries(CHILDREN).map(([name, body]) => [path.join(LINK_REL, name), body])
      ));
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "commit directory as regular files"]);

      // Replace the committed directory with a symlink to two other
      // directories holding byte-identical files (one current target and one
      // spare target for the later re-point check).
      writeFiles(repo, Object.fromEntries(
        Object.entries(CHILDREN).map(([name, body]) => [path.join(TARGET_REL, name), body])
      ));
      writeFiles(repo, Object.fromEntries(
        Object.entries(CHILDREN).map(([name, body]) => [path.join(OTHER_TARGET_REL, name), body])
      ));
      fs.rmSync(path.join(repo, LINK_REL), {recursive: true, force: true});
      const targetAbs = path.join(repo, TARGET_REL);
      const linkAbs = path.join(repo, LINK_REL);
      fs.symlinkSync(targetAbs, linkAbs);

      // Precondition: this really is the symlink-vs-tracked-files shape.
      const status = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
      check("fixture: git still reports a tracked child beneath the symlink",
        Object.keys(CHILDREN).some((name) => status.includes(`${LINK_REL}/${name}`)), status);
      check("fixture: the working-tree path itself is a symlink", fs.lstatSync(linkAbs).isSymbolicLink());

      let thrown = null;
      try { ensureBaseline(repo, "sym-key"); } catch (e) { thrown = e; }
      check("capture: building the baseline does not throw", thrown === null, thrown && (thrown.stack || thrown.message));

      if (!thrown) {
        const {manifest, filesDir} = baselines(repo, "sym-key");
        const entry = manifest.entries[LINK_REL];
        check("manifest: symlink path is recorded once as type symlink", entry && entry.type === "symlink", JSON.stringify(entry));
        check("manifest: symlink entry keeps the working-tree link text", entry && entry.target === targetAbs, JSON.stringify(entry));
        check("manifest: descendants are absent from the manifest",
          Object.keys(CHILDREN).every((name) => !(`${LINK_REL}/${name}` in manifest.entries)),
          JSON.stringify(Object.keys(manifest.entries)));
        const snapshot = path.join(filesDir, LINK_REL);
        check("snapshot: the symlink is recreated as a symlink, not a real directory",
          fs.lstatSync(snapshot).isSymbolicLink());

        const sameDelta = scopedDelta(repo, "sym-key");
        check("delta: an unchanged symlink subtree reports no spurious changes", sameDelta.trim() === "", sameDelta);

        // Re-point the symlink at the other target with identical file
        // contents: the delta must be the symlink change itself, never the
        // tracked children "through" the link.
        fs.unlinkSync(linkAbs);
        fs.symlinkSync(path.join(repo, OTHER_TARGET_REL), linkAbs);
        const movedDelta = scopedDelta(repo, "sym-key");
        check("delta: a changed symlink target is reported on the symlink path", movedDelta.includes(LINK_REL), movedDelta);
        check("delta: a changed symlink target never surfaces its descendants as separate paths",
          Object.keys(CHILDREN).every((name) => !movedDelta.includes(`${LINK_REL}/${name}`)), movedDelta);
      }
    } finally {
      cleanup(repo);
    }
  }
}

// ===========================================================================
// Resume after an interrupted capture: the baseline directory holds stale
// REAL snapshot directories but no manifest.json (written last). ensureBaseline
// must discard the incomplete snapshot, capture the symlink, and not throw.
// ===========================================================================
{
  const repo = makeRepo("resume");
  if (!probeSymlinkCapability(repo)) {
    console.log("SKIP: interrupted-capture resume check — symlink creation is unavailable on this platform.");
    cleanup(repo);
  } else {
    try {
      writeFiles(repo, Object.fromEntries(
        Object.entries(CHILDREN).map(([name, body]) => [path.join(LINK_REL, name), body])
      ));
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "commit directory as regular files"]);
      writeFiles(repo, Object.fromEntries(
        Object.entries(CHILDREN).map(([name, body]) => [path.join(TARGET_REL, name), body])
      ));
      fs.rmSync(path.join(repo, LINK_REL), {recursive: true, force: true});
      fs.symlinkSync(path.join(repo, TARGET_REL), path.join(repo, LINK_REL));

      // Simulate a crash mid-capture: stale real directories with copied
      // files, exactly where the symlink snapshot belongs, and no manifest.
      const key = "resume-key";
      const baselineDir = path.join(repo, ".autopilot", "baseline", key);
      const stale = path.join(baselineDir, "files", LINK_REL);
      fs.mkdirSync(stale, {recursive: true});
      fs.writeFileSync(path.join(stale, "SKILL.md"), "stale partial snapshot\n");
      check("resume fixture: no manifest.json before the resumed capture",
        !fs.existsSync(path.join(baselineDir, "manifest.json")));
      check("resume fixture: stale snapshot path is a real directory",
        fs.lstatSync(stale).isDirectory());

      let thrown = null;
      try { ensureBaseline(repo, key); } catch (e) { thrown = e; }
      check("resume: ensureBaseline does not throw on an incomplete prior capture",
        thrown === null, thrown && (thrown.stack || thrown.message));

      if (!thrown) {
        const {manifest, filesDir} = baselines(repo, key);
        const entry = manifest.entries[LINK_REL];
        check("resume: the symlink is recorded in the manifest",
          entry && entry.type === "symlink" && entry.target === path.join(repo, TARGET_REL),
          JSON.stringify(entry));
        const snapshot = path.join(filesDir, LINK_REL);
        check("resume: the stale real directory is replaced by a symlink snapshot",
          fs.lstatSync(snapshot).isSymbolicLink());
        check("resume: the stale copied file content is not retained",
          fs.readFileSync(path.join(snapshot, "SKILL.md"), "utf8") === CHILDREN["SKILL.md"]);
      }
    } finally {
      cleanup(repo);
    }
  }
}

// ===========================================================================
// Plain no-symlink case: unchanged behavior for ordinary declared files.
// ===========================================================================
{
  const repo = makeRepo("plain");
  try {
    const declared = ["plain/sub/a.txt", "plain/sub/b.txt"];
    writeFiles(repo, {
      "plain/sub/a.txt": "plain a\n",
      "plain/sub/b.txt": "plain b\n",
    });
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "plain files"]);
    ensureBaseline(repo, "plain-key", {declaredPaths: declared});

    const {manifest, filesDir} = baselines(repo, "plain-key");
    check("plain: ordinary paths are still captured as type file",
      declared.every((rel) => manifest.entries[rel]?.type === "file"), JSON.stringify(manifest.entries));
    check("plain: ordinary snapshot entries are real files",
      declared.every((rel) => fs.lstatSync(path.join(filesDir, rel)).isFile()));
    check("plain: unchanged ordinary files report an empty delta",
      scopedDelta(repo, "plain-key", {declaredPaths: declared}).trim() === "");

    fs.writeFileSync(path.join(repo, "plain/sub/a.txt"), "plain a changed\n");
    const delta = scopedDelta(repo, "plain-key", {declaredPaths: declared});
    check("plain: a later edit to an ordinary file is still reported",
      delta.includes("plain/sub/a.txt") && delta.includes("plain a changed"), delta);
  } finally {
    cleanup(repo);
  }
}

if (failures) {
  console.error(`${failures} symlink-parent baseline check(s) failed.`);
  process.exit(1);
}
console.log("symlink-parent baseline tests passed");
