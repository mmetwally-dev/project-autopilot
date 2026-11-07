#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {makeFixtureRepo, writeConfig} from "./test-fixtures/workflow-order-harness.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, ok, detail){
  if (ok) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const spentState = () => ({
  version: 1,
  phase: "escalated",
  step: "standalone-plan",
  phaseIndex: 1,
  taskIndex: 0,
  attempt: 1,
  failureBudgets: {
    "infrastructureRetryBudget:mission": 2,
    "adapterRetryBudget:adapter:opencode:verifier": 1
  },
  lastFailureBudget: {
    allowed: false,
    budget: "infrastructureRetryBudget",
    used: 2,
    limit: 2,
    scope: "mission"
  }
});

function makeRepo(state) {
  const repo = makeFixtureRepo("reset-flags");
  writeConfig(repo, {planningFramework: "standalone"});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify(state, null, 2));
  return repo;
}

// 1. node scripts/autopilot.mjs reset --dry-run (cwd: temp repo)
{
  const repo = makeRepo(spentState());
  const beforeBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const r = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "reset", "--dry-run"], {
    cwd: repo,
    encoding: "utf8"
  });
  const afterBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const out = `${r.stdout || ""}${r.stderr || ""}`;

  check("autopilot.mjs reset --dry-run exits 0", r.status === 0, {status: r.status, out});
  check("autopilot.mjs reset --dry-run prints 'would clear'", out.includes("would clear"), out);
  check("autopilot.mjs reset --dry-run prints 'dry run — nothing changed'", out.includes("dry run — nothing changed"), out);
  check("autopilot.mjs reset --dry-run leaves state.json byte-identical", beforeBytes.equals(afterBytes), {
    beforeLen: beforeBytes.length,
    afterLen: afterBytes.length
  });
}

// reset --yes --dry-run
{
  const repo = makeRepo(spentState());
  const beforeBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const r = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "reset", "--yes", "--dry-run"], {
    cwd: repo,
    encoding: "utf8"
  });
  const afterBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const out = `${r.stdout || ""}${r.stderr || ""}`;

  check("reset --yes --dry-run exits 0", r.status === 0, {status: r.status, out});
  check("reset --yes --dry-run leaves state.json identical", beforeBytes.equals(afterBytes), {
    beforeLen: beforeBytes.length,
    afterLen: afterBytes.length
  });
}

// 2. node bin/ap.cjs reset --dry-run --repo <temp repo>
{
  const repo = makeRepo(spentState());
  const beforeBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const r = spawnSync(process.execPath, [path.join(skillRoot, "bin", "ap.cjs"), "reset", "--dry-run", "--repo", repo], {
    encoding: "utf8"
  });
  const afterBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const out = `${r.stdout || ""}${r.stderr || ""}`;

  check("ap.cjs reset --dry-run exits 0", r.status === 0, {status: r.status, out});
  check("ap.cjs reset --dry-run prints 'would clear'", out.includes("would clear"), out);
  check("ap.cjs reset --dry-run prints 'dry run — nothing changed'", out.includes("dry run — nothing changed"), out);
  check("ap.cjs reset --dry-run leaves state.json byte-identical", beforeBytes.equals(afterBytes), {
    beforeLen: beforeBytes.length,
    afterLen: afterBytes.length
  });
}

// 3. node scripts/autopilot.mjs reset --bogus (cwd: temp repo)
{
  const repo = makeRepo(spentState());
  const beforeBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const r = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "reset", "--bogus"], {
    cwd: repo,
    encoding: "utf8"
  });
  const afterBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const stderr = r.stderr || "";

  check("reset --bogus exits 2", r.status === 2, {status: r.status, stderr});
  check("reset --bogus prints unknown option error to stderr", stderr.includes("ap reset: unknown option '--bogus'"), stderr);
  check("reset --bogus prints usage line to stderr", stderr.includes("Usage: ap reset [--scope <key>] [--dry-run] [--repo <path>]"), stderr);
  check("reset --bogus leaves state.json byte-identical", beforeBytes.equals(afterBytes), {
    beforeLen: beforeBytes.length,
    afterLen: afterBytes.length
  });
}

// 4. node bin/ap.cjs reset --bogus --repo <temp repo>
{
  const repo = makeRepo(spentState());
  const beforeBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const r = spawnSync(process.execPath, [path.join(skillRoot, "bin", "ap.cjs"), "reset", "--bogus", "--repo", repo], {
    encoding: "utf8"
  });
  const afterBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const stderr = r.stderr || "";

  check("ap.cjs reset --bogus exits 2", r.status === 2, {status: r.status, stderr});
  check("ap.cjs reset --bogus prints unknown option error to stderr", stderr.includes("ap reset: unknown option '--bogus'"), stderr);
  check("ap.cjs reset --bogus prints usage line to stderr", stderr.includes("Usage: ap reset [--scope <key>] [--dry-run] [--repo <path>]"), stderr);
  check("ap.cjs reset --bogus leaves state.json byte-identical", beforeBytes.equals(afterBytes), {
    beforeLen: beforeBytes.length,
    afterLen: afterBytes.length
  });
}

// 5. Scoped dry-run: node scripts/autopilot.mjs reset --scope infrastructureRetryBudget:mission --dry-run
{
  const repo = makeRepo(spentState());
  const beforeBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const r = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "reset", "--scope", "infrastructureRetryBudget:mission", "--dry-run"], {
    cwd: repo,
    encoding: "utf8"
  });
  const afterBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const out = `${r.stdout || ""}${r.stderr || ""}`;

  check("scoped reset --dry-run exits 0", r.status === 0, {status: r.status, out});
  check("scoped reset --dry-run prints 'would clear'", out.includes("would clear 2/2 recorded use(s)"), out);
  check("scoped reset --dry-run prints 'dry run — nothing changed'", out.includes("dry run — nothing changed"), out);
  check("scoped reset --dry-run leaves state.json byte-identical", beforeBytes.equals(afterBytes));
}

// 6. Plain reset clears state
{
  const repo = makeRepo(spentState());
  const beforeBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const r = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "reset"], {
    cwd: repo,
    encoding: "utf8"
  });
  const afterBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const s = JSON.parse(afterBytes.toString("utf8"));

  check("plain reset exits 0", r.status === 0, {status: r.status, out});
  check("plain reset prints 'cleared'", out.includes("cleared"), out);
  check("plain reset does not print 'dry run — nothing changed'", !out.includes("dry run — nothing changed"), out);
  check("plain reset modifies state.json", !beforeBytes.equals(afterBytes));
  check("plain reset clears failureBudgets", Object.keys(s.failureBudgets || {}).length === 0, s.failureBudgets);
}

// 7. Unknown positional argument
{
  const repo = makeRepo(spentState());
  const beforeBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const r = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "reset", "unexpectedArg"], {
    cwd: repo,
    encoding: "utf8"
  });
  const afterBytes = fs.readFileSync(path.join(repo, ".autopilot", "state.json"));
  const stderr = r.stderr || "";

  check("reset unexpectedArg exits 2", r.status === 2, {status: r.status, stderr});
  check("reset unexpectedArg prints unknown option error", stderr.includes("ap reset: unknown option 'unexpectedArg'"), stderr);
  check("reset unexpectedArg leaves state.json byte-identical", beforeBytes.equals(afterBytes));
}

// 8. bin/ap.cjs help line includes [--dry-run]
{
  const r = spawnSync(process.execPath, [path.join(skillRoot, "bin", "ap.cjs"), "help"], {
    encoding: "utf8"
  });
  const out = r.stdout || "";
  check("bin/ap.cjs help exits 0", r.status === 0, r.status);
  check("bin/ap.cjs help line has ap reset [--scope <key>] [--dry-run] [--repo <path>]",
    out.includes("ap reset [--scope <key>] [--dry-run] [--repo <path>]"), out);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll checks passed");
}
