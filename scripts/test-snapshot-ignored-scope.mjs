#!/usr/bin/env node
// TASK-31 (backlog #9) snapshot-scope regression: proves gitSnapshot's
// ignored-file scope excludes framework build caches and .autopilot while
// still fingerprinting agent config dirs and substring lookalikes.
//
// Fixture: temp git repo (os.tmpdir, removed at end) with a .gitignore
// covering node_modules/, .next/, .autopilot/, *.log, .opencode/, .turbo/.
// Bare basenames in .gitignore match at any depth, so top-level and nested
// (apps/web/...) cases share one ignore file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {gitSnapshot} from "./relay-guards.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function git(cwd, args) {
  const r = spawnSync("git", args, {cwd, encoding: "utf8", shell: false, stdio: "pipe"});
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return r;
}

function write(repo, rel, content) {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  fs.writeFileSync(full, content);
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-snapshot-ignored-scope-"));
try {
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "snapshot-scope-test@example.invalid"]);
  git(repo, ["config", "user.name", "Snapshot Scope Test"]);
  fs.writeFileSync(path.join(repo, ".gitignore"),
    ["node_modules/", ".next/", ".autopilot/", "*.log", ".opencode/", ".turbo/", ""].join("\n"));
  fs.writeFileSync(path.join(repo, "file.txt"), "baseline\n");
  // Tracked file under .autopilot/ for the step-1 pathspec case: ignored by
  // .gitignore, so force-add. A tracked change there must NOT alter the
  // `diff` component after the ":(exclude).autopilot/**" fix.
  write(repo, ".autopilot/tracked.txt", "autopilot baseline\n");
  git(repo, ["add", "-A", "-f"]);
  git(repo, ["commit", "-q", "-m", "init"]);

  const fp = (s) => s.fingerprint;
  const diffText = (s) => s.diff.toString("utf8");

  // ---- 1. Excluded mutations leave the fingerprint unchanged ----
  const baseline = gitSnapshot(repo);
  write(repo, "node_modules/foo.js", "v1");
  write(repo, ".next/build.js", "v1");
  write(repo, "apps/web/node_modules/pkg/index.js", "v1");
  write(repo, "apps/web/.next/build.js", "v1");
  write(repo, ".autopilot/runs/scratch.json", "{}");
  // Backlog #26 Step A: the implementer's hand-off note lives here too — a
  // write there must not change the fingerprint either.
  write(repo, ".autopilot/missions/001-test/handoff/T1.md", "1. Done — x\n");
  write(repo, ".turbo/run.json", "v1");
  write(repo, "apps/web/.turbo/run.json", "v1");
  const afterExcluded = gitSnapshot(repo);
  check("top-level node_modules mutation leaves fingerprint unchanged",
    fp(afterExcluded) === fp(baseline));
  check("top-level .next mutation leaves fingerprint unchanged",
    fp(afterExcluded) === fp(baseline));
  check("nested apps/web/node_modules mutation leaves fingerprint unchanged",
    fp(afterExcluded) === fp(baseline));
  check("nested apps/web/.next mutation leaves fingerprint unchanged",
    fp(afterExcluded) === fp(baseline));
  check("ignored .autopilot scratch mutation leaves fingerprint unchanged",
    fp(afterExcluded) === fp(baseline));
  check("ignored .autopilot handoff-note mutation leaves fingerprint unchanged",
    fp(afterExcluded) === fp(baseline));
  check("new cache .turbo top-level leaves fingerprint unchanged",
    fp(afterExcluded) === fp(baseline));
  check("new cache .turbo nested leaves fingerprint unchanged",
    fp(afterExcluded) === fp(baseline));

  // ---- 2. Tracked .autopilot change vs tracked change elsewhere (step 1) ----
  const beforeTracked = gitSnapshot(repo);
  write(repo, ".autopilot/tracked.txt", "autopilot changed\n");
  const afterAutopilotTracked = gitSnapshot(repo);
  check("tracked .autopilot change does not alter the diff component",
    diffText(afterAutopilotTracked) === diffText(beforeTracked));
  check("tracked .autopilot change does not alter the fingerprint",
    fp(afterAutopilotTracked) === fp(beforeTracked));
  // Revert so the next case measures only its own change.
  write(repo, ".autopilot/tracked.txt", "autopilot baseline\n");
  write(repo, "file.txt", "baseline changed\n");
  const afterElsewhereTracked = gitSnapshot(repo);
  check("tracked change elsewhere still alters the diff component",
    diffText(afterElsewhereTracked) !== diffText(beforeTracked));
  check("tracked change elsewhere still alters the fingerprint",
    fp(afterElsewhereTracked) !== fp(beforeTracked));
  // Revert to baseline content for the remaining cases.
  write(repo, "file.txt", "baseline\n");

  // ---- 3. Ignored agent-config dir stays fingerprinted ----
  const beforeAgent = gitSnapshot(repo);
  write(repo, ".opencode/opencode.json", "{\"model\":\"x\"}");
  const afterAgent = gitSnapshot(repo);
  check("ignored .opencode/opencode.json mutation CHANGES the fingerprint",
    fp(afterAgent) !== fp(beforeAgent));

  // ---- 4. Substring lookalike stays fingerprinted ----
  const beforeSub = gitSnapshot(repo);
  write(repo, "my_node_modules/x.log", "lookalike\n");
  const afterSub = gitSnapshot(repo);
  check("my_node_modules/x.log (substring name) CHANGES the fingerprint",
    fp(afterSub) !== fp(beforeSub));

  // ---- 5. Build outputs stay fingerprinted (dist/ is not an excluded cache) ----
  const beforeDist = gitSnapshot(repo);
  write(repo, "dist/bundle.js", "output\n");
  const afterDist = gitSnapshot(repo);
  check("dist/ output mutation CHANGES the fingerprint",
    fp(afterDist) !== fp(beforeDist));
} finally {
  fs.rmSync(repo, {recursive: true, force: true});
}

// Fail closed: the ignored-dir expansion must never swallow a git error —
// a silent catch would drop that dir's files from the fingerprint, so a write
// there during a read-only stage would go undetected.
{
  const src = fs.readFileSync(new URL("./relay-guards.mjs", import.meta.url), "utf8");
  const start = src.indexOf("export function gitSnapshot(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const loopStart = body.indexOf("for(const dir of dirsToExpand)");
  const loop = body.slice(loopStart, body.indexOf("const files={}", loopStart));
  check("ignored-dir expansion is fail-closed (no swallowing catch)",
    start >= 0 && body.includes("dirsToExpand") && !/catch\s*\{\s*\}/.test(loop) && !/try\s*\{/.test(loop));
}

if (failures) {
  console.error(`${failures} snapshot-ignored-scope check(s) failed.`);
  process.exit(1);
}
console.log("snapshot-ignored-scope regression tests passed");
