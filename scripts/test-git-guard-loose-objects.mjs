#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitSnapshot, looseObjectGrowthHasCommit } from "./relay-guards.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function runGit(cwd, args, env = {}) {
  const r = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-git-loose-"));
try {
  runGit(tmpDir, ["init"]);
  runGit(tmpDir, ["config", "user.name", "Test User"]);
  runGit(tmpDir, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(tmpDir, "initial.txt"), "initial commit file\n");
  runGit(tmpDir, ["add", "initial.txt"]);
  runGit(tmpDir, ["commit", "-m", "initial commit"]);

  // Backdate initial commit objects so they are older than the 2-second grace window
  const objDir = path.join(tmpDir, ".git", "objects");
  for (const d of fs.readdirSync(objDir)) {
    if (/^[0-9a-f]{2}$/i.test(d)) {
      for (const f of fs.readdirSync(path.join(objDir, d))) {
        if (/^[0-9a-f]{38}$/i.test(f)) {
          const p = path.join(objDir, d, f);
          const past = new Date(Date.now() - 10000);
          fs.utimesSync(p, past, past);
        }
      }
    }
  }

  const before = gitSnapshot(tmpDir);
  check("snapshot takenAtMs is a number", typeof before.takenAtMs === "number" && before.takenAtMs > 0);

  // (a) `git hash-object -w` a file + `git write-tree` (after `git add` into a temp index
  // via GIT_INDEX_FILE so the real index state is unchanged) -> after=gitSnapshot;
  // looseObjectGrowthHasCommit -> commitOrTag false, counts.blob>=1, counts.tree>=1.
  const looseFile = path.join(tmpDir, "loose-blob.txt");
  fs.writeFileSync(looseFile, "loose content\n");
  runGit(tmpDir, ["hash-object", "-w", "loose-blob.txt"]);

  const tempIndex = path.join(tmpDir, "temp.index");
  runGit(tmpDir, ["add", "loose-blob.txt"], { GIT_INDEX_FILE: tempIndex });
  const treeSha = runGit(tmpDir, ["write-tree"], { GIT_INDEX_FILE: tempIndex }).trim();
  fs.unlinkSync(tempIndex);
  fs.unlinkSync(looseFile);

  const afterA = gitSnapshot(tmpDir);
  const resultA = looseObjectGrowthHasCommit(tmpDir, before, afterA);
  check("(a) looseObjectGrowthHasCommit commitOrTag is false for blob/tree only", resultA.commitOrTag === false, resultA);
  check("(a) looseObjectGrowthHasCommit counts.blob >= 1", resultA.counts?.blob >= 1, resultA.counts);
  check("(a) looseObjectGrowthHasCommit counts.tree >= 1", resultA.counts?.tree >= 1, resultA.counts);
  check("(a) looseObjectGrowthHasCommit counts.commit is 0", resultA.counts?.commit === 0, resultA.counts);
  check("(a) looseObjectGrowthHasCommit counts.tag is 0", resultA.counts?.tag === 0, resultA.counts);

  // (b) same, plus `git commit-tree <tree> -m x` (dangling commit) -> commitOrTag true.
  const commitSha = runGit(tmpDir, ["commit-tree", treeSha, "-m", "dangling commit message"]).trim();
  const afterB = gitSnapshot(tmpDir);
  const resultB = looseObjectGrowthHasCommit(tmpDir, before, afterB);
  check("(b) looseObjectGrowthHasCommit commitOrTag is true when dangling commit exists", resultB.commitOrTag === true, resultB);
  check("(b) looseObjectGrowthHasCommit counts.commit >= 1", resultB.counts?.commit >= 1, resultB.counts);

  // (c) before without takenAtMs -> commitOrTag true.
  const beforeNoTime = { ...before };
  delete beforeNoTime.takenAtMs;
  const resultC = looseObjectGrowthHasCommit(tmpDir, beforeNoTime, afterA);
  check("(c) looseObjectGrowthHasCommit commitOrTag is true when takenAtMs is missing", resultC.commitOrTag === true, resultC);
  check("(c) looseObjectGrowthHasCommit reason is 'no-start-time'", resultC.reason === "no-start-time", resultC);

  // (d) source check that autopilot.mjs only relaxes when "objects" is the sole changed field.
  const autopilotPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "autopilot.mjs");
  const src = fs.readFileSync(autopilotPath, "utf8");

  const hasSoleFieldCheck = src.includes('changedFields.length===1 && changedFields[0]==="objects"')
    || src.includes('changedFields.length === 1 && changedFields[0] === "objects"');
  check('(d) source check: autopilot.mjs checks changedFields sole entry is "objects"', hasSoleFieldCheck);

  const hasHeadAndRefsCheck = src.includes("before.head===after.head && !refsChanged")
    || src.includes("before.head === after.head && !refsChanged");
  check("(d) source check: autopilot.mjs verifies head and refs are equal", hasHeadAndRefsCheck);

  check("(d) source check: autopilot.mjs calls looseObjectGrowthHasCommit", src.includes("looseObjectGrowthHasCommit(cwd,before,after)") || src.includes("looseObjectGrowthHasCommit(cwd, before, after)"));

  // (e) before=gitSnapshot(repo); write one blob with `git hash-object -w`; after=gitSnapshot(repo);
  // then set that blob file's mtime to 1 hour before before.takenAtMs with fs.utimesSync;
  // looseObjectGrowthHasCommit -> commitOrTag true and reason "no-new-loose-objects-found".
  for (const d of fs.readdirSync(objDir)) {
    if (/^[0-9a-f]{2}$/i.test(d)) {
      for (const f of fs.readdirSync(path.join(objDir, d))) {
        if (/^[0-9a-f]{38}$/i.test(f)) {
          const p = path.join(objDir, d, f);
          const past = new Date(Date.now() - 100000);
          fs.utimesSync(p, past, past);
        }
      }
    }
  }

  const beforeE = gitSnapshot(tmpDir);
  const blobFileE = path.join(tmpDir, "blob-e.txt");
  fs.writeFileSync(blobFileE, "blob e content " + Date.now() + "\n");
  const blobShaE = runGit(tmpDir, ["hash-object", "-w", "blob-e.txt"]).trim();
  fs.unlinkSync(blobFileE);
  const afterE = gitSnapshot(tmpDir);

  const blobObjPathE = path.join(objDir, blobShaE.slice(0, 2), blobShaE.slice(2));
  const pastOneHour = new Date(beforeE.takenAtMs - 3600 * 1000);
  fs.utimesSync(blobObjPathE, pastOneHour, pastOneHour);

  const resultE = looseObjectGrowthHasCommit(tmpDir, beforeE, afterE);
  check("(e) looseObjectGrowthHasCommit commitOrTag is true when no new loose objects found", resultE.commitOrTag === true, resultE);
  check("(e) looseObjectGrowthHasCommit reason is 'no-new-loose-objects-found'", resultE.reason === "no-new-loose-objects-found", resultE);

} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

console.log(failures === 0 ? "test-git-guard-loose-objects: OK" : `test-git-guard-loose-objects: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
