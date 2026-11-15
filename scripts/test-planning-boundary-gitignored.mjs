#!/usr/bin/env node
// Unit and integration tests for splitGitIgnoredTouched() in planning-boundary.mjs
// and its wiring into enforcePlanningWriteBoundary() in autopilot.mjs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  splitGitIgnoredTouched,
  evaluatePlanningWriteBoundary
} from "./planning-boundary.mjs";

let failures = 0;
let passed = 0;
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const tempDirs = [];
try {
  // Temp git repo with .gitignore containing playwright-report/, test-results/, and .env
  const repo = makeTempDir("ap-pb-gitignore-");
  tempDirs.push(repo);
  git(repo, ["init"]);
  fs.writeFileSync(
    path.join(repo, ".gitignore"),
    "playwright-report/\ntest-results/\n.env\n.env.*\n",
    "utf8"
  );

  // (a) splitGitIgnoredTouched with playwright-report/index.html and test-results/x.txt -> both in ignored
  {
    const res = splitGitIgnoredTouched(repo, [
      "playwright-report/index.html",
      "test-results/x.txt"
    ]);
    check(
      "(a) playwright-report/index.html and test-results/x.txt are both in ignored",
      res.kept.length === 0 &&
        res.ignored.length === 2 &&
        res.ignored[0] === "playwright-report/index.html" &&
        res.ignored[1] === "test-results/x.txt"
    );
  }

  // (b) src/app.ts (not ignored) -> kept
  {
    const res = splitGitIgnoredTouched(repo, ["src/app.ts"]);
    check(
      "(b) src/app.ts (not ignored) stays in kept",
      res.kept.length === 1 &&
        res.kept[0] === "src/app.ts" &&
        res.ignored.length === 0
    );
  }

  // (c) .env (ignored) -> kept (never dropped), and nested .env.local -> kept
  {
    const res = splitGitIgnoredTouched(repo, [".env", "apps/web/.env.local", "playwright-report/index.html"]);
    check(
      "(c) .env and apps/web/.env.local stay in kept even when git-ignored",
      res.kept.length === 2 &&
        res.kept.includes(".env") &&
        res.kept.includes("apps/web/.env.local") &&
        res.ignored.length === 1 &&
        res.ignored[0] === "playwright-report/index.html"
    );
  }

  // (d) specs/011-x/tasks.md even when a pattern ignores it -> kept
  //     (also verify .specify/ and CLAUDE.md are never dropped)
  {
    const repoIgnoreSpecs = makeTempDir("ap-pb-gitignore-specs-");
    tempDirs.push(repoIgnoreSpecs);
    git(repoIgnoreSpecs, ["init"]);
    fs.writeFileSync(
      path.join(repoIgnoreSpecs, ".gitignore"),
      "specs/\n.specify/\nCLAUDE.md\nplaywright-report/\n",
      "utf8"
    );
    const res = splitGitIgnoredTouched(repoIgnoreSpecs, [
      "specs/011-x/tasks.md",
      ".specify/feature.json",
      "CLAUDE.md",
      "playwright-report/index.html"
    ]);
    check(
      "(d) specs/011-x/tasks.md, .specify/feature.json, CLAUDE.md stay in kept even when ignored",
      res.kept.length === 3 &&
        res.kept.includes("specs/011-x/tasks.md") &&
        res.kept.includes(".specify/feature.json") &&
        res.kept.includes("CLAUDE.md") &&
        res.ignored.length === 1 &&
        res.ignored[0] === "playwright-report/index.html"
    );
  }

  // (e) repo that is not a git repo / git failure -> everything kept (fail closed)
  {
    const nonGitRepo = makeTempDir("ap-pb-nongit-");
    tempDirs.push(nonGitRepo);
    fs.writeFileSync(path.join(nonGitRepo, ".gitignore"), "playwright-report/\n", "utf8");
    const input = ["playwright-report/index.html", "specs/011-x/tasks.md"];
    const res = splitGitIgnoredTouched(nonGitRepo, input);
    check(
      "(e1) non-git directory fails closed and keeps everything",
      res.kept.length === 2 &&
        res.kept[0] === "playwright-report/index.html" &&
        res.kept[1] === "specs/011-x/tasks.md" &&
        res.ignored.length === 0
    );

    const missingRepo = path.join(nonGitRepo, "does-not-exist");
    const resMissing = splitGitIgnoredTouched(missingRepo, input);
    check(
      "(e2) nonexistent repo path fails closed and keeps everything",
      resMissing.kept.length === 2 &&
        resMissing.ignored.length === 0
    );
  }

  // (f) end-to-end through evaluatePlanningWriteBoundary after splitGitIgnoredTouched
  {
    const { kept: keptAllowed, ignored: ignoredAllowed } = splitGitIgnoredTouched(repo, [
      "specs/011-x/tasks.md",
      "playwright-report/index.html"
    ]);
    const evalAllowed = evaluatePlanningWriteBoundary({
      stage: "tasks",
      touchedFiles: keptAllowed,
      preexistingFeatureDirs: [],
      resolvedFeatureDir: "011-x"
    });
    check(
      "(f1) tasks stage with [specs/011-x/tasks.md, playwright-report/index.html] after split -> ok true",
      ignoredAllowed.length === 1 &&
        ignoredAllowed[0] === "playwright-report/index.html" &&
        evalAllowed.ok === true &&
        evalAllowed.violations.length === 0
    );

    const { kept: keptRejected } = splitGitIgnoredTouched(repo, [
      "specs/011-x/tasks.md",
      "src/app.ts"
    ]);
    const evalRejected = evaluatePlanningWriteBoundary({
      stage: "tasks",
      touchedFiles: keptRejected,
      preexistingFeatureDirs: [],
      resolvedFeatureDir: "011-x"
    });
    check(
      "(f2) tasks stage with [specs/011-x/tasks.md, src/app.ts] after split -> ok false with outside_allowed_paths",
      evalRejected.ok === false &&
        evalRejected.violations.length === 1 &&
        evalRejected.violations[0].path === "src/app.ts" &&
        evalRejected.violations[0].reason === "outside_allowed_paths"
    );
  }

  // (g) source-level check that enforcePlanningWriteBoundary in scripts/autopilot.mjs
  //     calls splitGitIgnoredTouched before evaluatePlanningWriteBoundary
  {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
    const fnStart = autopilotSrc.indexOf("function enforcePlanningWriteBoundary(");
    const fnEnd = autopilotSrc.indexOf("function enforcePlanningStagePostcondition(", fnStart);
    const fnBody = fnStart !== -1 && fnEnd !== -1 ? autopilotSrc.slice(fnStart, fnEnd) : "";
    const splitIdx = fnBody.indexOf("splitGitIgnoredTouched(");
    const evalIdx = fnBody.indexOf("evaluatePlanningWriteBoundary(");
    check(
      "(g) enforcePlanningWriteBoundary in autopilot.mjs calls splitGitIgnoredTouched before evaluatePlanningWriteBoundary",
      fnStart !== -1 &&
        fnEnd !== -1 &&
        splitIdx !== -1 &&
        evalIdx !== -1 &&
        splitIdx < evalIdx &&
        /touchedFiles\s*:\s*kept\b/.test(fnBody)
    );
  }

  // (h) tracked file matching an ignore pattern stays in kept, not ignored
  {
    fs.appendFileSync(path.join(repo, ".gitignore"), "build/\n", "utf8");
    fs.mkdirSync(path.join(repo, "build"), { recursive: true });
    fs.writeFileSync(path.join(repo, "build", "keep.txt"), "tracked\n", "utf8");
    git(repo, ["add", "-f", "build/keep.txt"]);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-m", "track ignored file"]);
    const res = splitGitIgnoredTouched(repo, ["build/keep.txt"]);
    check(
      "(h) tracked file matching ignore pattern (build/keep.txt) stays in kept, not ignored",
      res.kept.length === 1 &&
        res.kept[0] === "build/keep.txt" &&
        res.ignored.length === 0
    );
  }
} finally {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

if (failures) {
  console.error(`${failures} planning-boundary-gitignored check(s) failed.`);
  process.exit(1);
}
console.log(`planning-boundary-gitignored unit tests: PASS (${passed}/${passed} checks)`);
