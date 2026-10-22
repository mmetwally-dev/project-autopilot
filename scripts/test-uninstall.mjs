#!/usr/bin/env node
// End-to-end tests for `ap uninstall` (backlog #14).
//
// Unlike scripts/test-uninstall-module.mjs (which unit-tests the pure
// planner/executor against a fake fs), this file spawns the real CLI —
// `node scripts/autopilot.mjs uninstall … --repo <tmp>` — against throwaway
// fixture repos under the OS temp dir, so the cases below observe the actual
// command surface an operator gets: the printed plan, the confirmation
// contract, the bytes on disk afterwards, and the exit codes.
//
// Covered cases (see the phase-3 tasks for the full accept text):
//   --dry-run               prints the plan (project path, the recursive
//                            `.autopilot/` delete, the `.gitignore` edit) and
//                            leaves the fixture byte-identical
//   --yes                   removes `.autopilot/`, strips only the exact
//                            `.autopilot/` line from `.gitignore`, keeps every
//                            project file and decoy line, prints the
//                            "Nothing outside" confirmation
//   not set up             a repo without `.autopilot/` reports
//                            "Autopilot is not set up here" and exits 0
//   non-TTY refusal         a piped stdin without `--yes` refuses (exit 1) and
//                            changes nothing
//   --keep-missions         `.autopilot/` is gone and `missions/` is archived
//                            once at the repo root, `.gitignore` handled the
//                            same way
//   live run (decoy)        a real `node <repo>/autopilot.mjs run` decoy makes
//                            BOTH `--dry-run` and `--yes` refuse (exit 1) and
//                            name its pid — the liveness gate precedes the
//                            dry-run branch — while `.autopilot/` and
//                            `.gitignore` stay byte-identical and the run is
//                            left alive (uninstall never kills; POSIX only,
//                            win32 skips)
//
// Self-contained runner (no new dependency): a `check()` tally plus
// `process.exit(1)` on failure, mirroring the scripts/test-*.mjs convention.
// Every fixture repo is removed explicitly by `cleanupRepos()` at the end of
// the run (no `process.on` hooks), and the final case asserts that no fixture
// directory is left behind in the OS temp dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn, spawnSync} from "node:child_process";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  const passed = typeof condition === "function" ? condition() : condition;
  if (passed) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

// ------------------------------------------------------------ scaffolding ---
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = fs.realpathSync(os.tmpdir());
const FIXTURE_PREFIX = "ap-uninstall-test.";
const MISSION = "083-demo-mission";
const PLAN_BODY = "# demo plan\n\n- [x] step one\n";

// The lines a real setup appends (`node_modules/` and the exact `.autopilot/`
// entry) interleaved with decoys the teardown must NOT touch: a nested
// `foo/.autopilot/`, the bare `.autopilot` (no trailing slash) and an
// unrelated `secret.env`.
const GITIGNORE = [
  "node_modules/",
  ".autopilot/",
  "foo/.autopilot/",
  ".autopilot",
  "secret.env",
  "",
].join("\n");

// What the fixture's `.gitignore` must hold after a successful uninstall: the
// same lines minus the exact `.autopilot/` entry the teardown removed (its
// trailing empty element supplies the trailing newline). Derived from
// `GITIGNORE` by exact line match — never a substring or a whole-file rewrite —
// so the expectation stays in lockstep with `makeRepo()` and pins the decoys.
const EXPECTED_GITIGNORE = GITIGNORE.split("\n").filter((line) => line !== ".autopilot/").join("\n");

const createdRepos = [];
function track(repo) { createdRepos.push(repo); return repo; }
// A fresh fixture repo under $TMPDIR, never inside the project repo.
function makeRepo(label = "repo") {
  const repo = track(fs.mkdtempSync(path.join(tmpRoot, `${FIXTURE_PREFIX}${label}.`)));
  const missionDir = path.join(repo, ".autopilot", "missions", MISSION);
  fs.mkdirSync(missionDir, {recursive: true});
  fs.writeFileSync(path.join(missionDir, "PLAN.md"), PLAN_BODY);
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), "{}\n");
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), "{}\n");
  fs.writeFileSync(path.join(repo, "app.js"), "// app\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), GITIGNORE);
  return repo;
}
// Spawn the CLI under test with fully piped (deterministically non-TTY)
// stdio — stdin is a pipe closed at once, so the confirmation prompt has no
// answer to read — and return `{status, out}` where `out` is the combined
// stdout+stderr.
function run(args, repo) {
  const r = spawnSync(
    process.execPath,
    [path.join(skillRoot, "scripts", "autopilot.mjs"), ...args, "--repo", repo],
    {encoding: "utf8", shell: false, stdio: ["pipe", "pipe", "pipe"], input: ""},
  );
  return {status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`};
}
// Same piped, deterministic non-TTY spawn, but through the LAUNCHER
// (`node bin/ap.cjs …`) instead of scripts/autopilot.mjs directly, so the
// case observes the runtime-mode router's `uninstall` route and the local
// re-dispatch back into autopilot.mjs (bin/ap.cjs:241) that an operator's
// `ap uninstall` actually takes — not just the handler in isolation.
function runLauncher(args, repo) {
  const r = spawnSync(
    process.execPath,
    [path.join(skillRoot, "bin", "ap.cjs"), ...args, "--repo", repo],
    {encoding: "utf8", shell: false, stdio: ["pipe", "pipe", "pipe"], input: ""},
  );
  return {status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`};
}
// A live run the real liveness detector trips on: a file literally named
// `autopilot.mjs` launched with a `run` arg (the same C3 cmdline shape used
// across the mission-control suite) and `cwd` = <repo>, so the /proc scan
// attributes it to THIS fixture repo. It is a bare `setTimeout`, so it holds
// `.autopilot/` open without touching state or invoking a model.
function spawnDecoy(repo) {
  const fake = path.join(repo, "autopilot.mjs");
  fs.writeFileSync(fake, "setTimeout(()=>{}, 120000);\n");
  return spawn(process.execPath, [fake, "run"], {cwd: repo, stdio: "ignore"});
}
// Alive until the process has exited: neither an exit code nor a terminating
// signal has been recorded yet. Used to prove `ap uninstall` REFUSES a live
// run without killing it — that is `ap stop`'s job, never uninstall's.
function decoyAlive(child) {
  return child.exitCode === null && child.signalCode == null;
}
// Resolve once a killed decoy has actually reaped (SIGKILL in `finally`),
// bounded so a wedged signal can never hang the suite. `exitCode`/`signalCode`
// are written before the `exit` event fires, so by the time this resolves
// `decoyAlive()` reports the true end state.
function decoyDead(child) {
  return new Promise((resolve) => {
    if (!decoyAlive(child)) return resolve();
    child.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
}
const settle = (ms) => new Promise((res) => setTimeout(res, ms));
// Raw bytes of a file, or null when it is gone (a dry-run must never delete
// `.gitignore`), so byte-identity never depends on an encoding assumption.
function readBytes(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}
// Byte-exact snapshot of a directory tree: every regular file below `root`,
// keyed by a POSIX-style relative path and holding its raw bytes. A missing
// root yields an empty map, so a deleted or replaced tree can never compare
// equal to a populated one — which is what makes "unchanged" provable rather
// than assumed from the exit code alone.
function snapshotTree(root) {
  const snap = {};
  if (!fs.existsSync(root)) return snap;
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const abs = path.join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, key);
      else snap[key] = fs.readFileSync(abs);
    }
  };
  walk(root, "");
  return snap;
}
// Equal snapshots: same path set AND byte-identical contents for every path.
function sameTree(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => k in b && Buffer.compare(a[k], b[k]) === 0);
}
function remove(repo) {
  try { fs.rmSync(repo, {recursive: true, force: true}); return true; }
  catch { return false; }
}
function cleanupRepos() {
  for (const repo of createdRepos.splice(0)) remove(repo);
}
// Every fixture repo this process created, by absolute base name.
function remainingFixtures() {
  const leftovers = [];
  let entries = [];
  try { entries = fs.readdirSync(tmpRoot); } catch { return leftovers; }
  for (const entry of entries) {
    if (!entry.startsWith(FIXTURE_PREFIX)) continue;
    leftovers.push(path.join(tmpRoot, entry));
  }
  return leftovers;
}

try {
  // ---------------------------------------------------- scaffold self-check ---
  check("scaffold: makeRepo/run/cleanup helpers are present and callable",
    typeof makeRepo === "function" && typeof run === "function"
    && typeof cleanupRepos === "function");
  check("scaffold: makeRepo builds the full fixture layout", () => {
    const repo = makeRepo("selfcheck");
    try {
      const files = [
        path.join(repo, ".autopilot", "missions", MISSION, "PLAN.md"),
        path.join(repo, ".autopilot", "config.json"),
        path.join(repo, ".autopilot", "state.json"),
        path.join(repo, "app.js"),
        path.join(repo, ".gitignore"),
      ].every((f) => fs.existsSync(f) && fs.statSync(f).isFile());
      return files && fs.readFileSync(path.join(repo, ".gitignore"), "utf8") === GITIGNORE;
    } finally { remove(repo); }
  });
  check("scaffold: run reports the CLI exit code and combined output", () => {
    const repo = makeRepo("selfcheck-run");
    try {
      const r = run(["uninstall", "--dry-run"], repo);
      return typeof r.status === "number" && typeof r.out === "string";
    } finally { remove(repo); }
  });

  // ------------------------------------------------------------- --dry-run ---
  // The read-only preview: exit 0, the full plan on stdout (project path, the
  // recursive `.autopilot/` delete, the `.gitignore` edit) and — because
  // `uninstallCommand` returns before both the non-TTY refusal and the single
  // writer — a fixture that is byte-identical to its pre-run snapshot. The
  // on-disk proof is what pins "nothing was changed": the text alone could be
  // printed by a command that mutated anyway.
  {
    const repo = makeRepo("dry-run");
    try {
      const projectPath = path.join(repo, ".autopilot");
      const gitignore = path.join(repo, ".gitignore");
      const before = {tree: snapshotTree(projectPath), bytes: readBytes(gitignore)};
      const r = run(["uninstall", "--dry-run"], repo);
      const after = {tree: snapshotTree(projectPath), bytes: readBytes(gitignore)};
      const missing = [];
      if (r.status !== 0) missing.push(`exit ${r.status} (expected 0)`);
      if (!r.out.includes("--dry-run")) missing.push("output never says --dry-run");
      if (!r.out.includes(`project:      ${projectPath}`)) missing.push(`no \`project:      ${projectPath}\` line`);
      if (!r.out.includes(`will delete:  ${projectPath} (recursively)`)) missing.push(`no \`will delete:  ${projectPath} (recursively)\` line`);
      if (!r.out.includes("will edit:")) missing.push("no `will edit:` line");
      if (!r.out.includes(gitignore)) missing.push(`\`will edit:\` never names ${gitignore}`);
      if (!sameTree(before.tree, after.tree)) missing.push(`.autopilot/ tree changed: ${JSON.stringify(Object.keys(after.tree))}`);
      if (!before.bytes || !after.bytes || Buffer.compare(before.bytes, after.bytes) !== 0) missing.push(".gitignore bytes changed");
      check("dry-run: exit 0, prints the plan, leaves the fixture byte-identical",
        missing.length === 0, missing.length ? {missing, out: r.out} : undefined);
    } finally { remove(repo); }
  }

  // -------------------------------------------------------- launcher route ---
  // The same read-only preview as `--dry-run` above, but spawned through the
  // LAUNCHER (`node bin/ap.cjs uninstall … --repo <tmp> --dry-run`) rather
  // than scripts/autopilot.mjs directly. Every case up to here bypasses
  // bin/ap.cjs, so nothing has yet proven that the `uninstall` it receives
  // reaches the real handler: bin/ap.cjs:241 routes it through the runtime
  // mode router (`routeSubcommand({command:"uninstall"})`) and — on a
  // non-Windows project — re-dispatches it back into autopilot.mjs. The plan
  // printing at all is the proof the route landed: a broken route would
  // surface a routing error, the Setup wizard, or a WSL delegation instead of
  // the `project:` / `will delete:` lines. The byte-identical snapshots then
  // re-pin that a dry-run still changed nothing once it arrives this way.
  {
    const repo = makeRepo("launcher-route");
    try {
      const projectPath = path.join(repo, ".autopilot");
      const gitignore = path.join(repo, ".gitignore");
      const before = {tree: snapshotTree(projectPath), bytes: readBytes(gitignore)};
      const r = runLauncher(["uninstall", "--dry-run"], repo);
      const after = {tree: snapshotTree(projectPath), bytes: readBytes(gitignore)};
      const missing = [];
      if (r.status !== 0) missing.push(`exit ${r.status} (expected 0)`);
      if (!r.out.includes(`project:      ${projectPath}`)) missing.push(`no \`project:      ${projectPath}\` line`);
      if (!r.out.includes(`will delete:  ${projectPath} (recursively)`)) missing.push(`no \`will delete:  ${projectPath} (recursively)\` line`);
      if (!sameTree(before.tree, after.tree)) missing.push(`.autopilot/ tree changed: ${JSON.stringify(Object.keys(after.tree))}`);
      if (!before.bytes || !after.bytes || Buffer.compare(before.bytes, after.bytes) !== 0) missing.push(".gitignore bytes changed");
      check("launcher route: bin/ap.cjs uninstall --dry-run exits 0, prints the plan, leaves the fixture byte-identical",
        missing.length === 0, missing.length ? {missing, out: r.out} : undefined);
    } finally { remove(repo); }
  }

  // ---------------------------------------------------------------- --yes ---
  // The destructive path, approved up front. Exit 0, `.autopilot/` gone, and
  // `.gitignore` holding exactly its original lines minus the single exact
  // `.autopilot/` entry — so `node_modules/`, the decoy `foo/.autopilot/`, the
  // bare `.autopilot` (a real project directory an operator ignores) and the
  // unrelated `secret.env` all survive untouched, and `app.js` is never in
  // scope. The printed confirmation is also pinned: it is the one line that
  // tells an operator nothing outside `.autopilot/` was touched, so a teardown
  // that quietly reached further would still be reported as success.
  {
    const repo = makeRepo("yes");
    try {
      const projectPath = path.join(repo, ".autopilot");
      const gitignore = path.join(repo, ".gitignore");
      const appJs = path.join(repo, "app.js");
      const r = run(["uninstall", "--yes"], repo);
      const missing = [];
      if (r.status !== 0) missing.push(`exit ${r.status} (expected 0)`);
      if (fs.existsSync(projectPath)) missing.push(`${projectPath} still exists`);
      const after = readBytes(gitignore);
      if (after === null) missing.push(".gitignore was deleted");
      else if (after.toString("utf8") !== EXPECTED_GITIGNORE) {
        missing.push(`.gitignore is ${JSON.stringify(after.toString("utf8"))}, expected ${JSON.stringify(EXPECTED_GITIGNORE)}`);
      }
      if (readBytes(appJs)?.toString("utf8") !== "// app\n") missing.push("app.js did not survive");
      if (!r.out.includes("Nothing outside `.autopilot/` and that one `.gitignore` line was touched.")) missing.push("no \"Nothing outside\" confirmation");
      check("yes: exit 0, .autopilot/ gone, only the exact .autopilot/ line stripped, project files intact",
        missing.length === 0, missing.length ? {missing, out: r.out} : undefined);
    } finally { remove(repo); }
  }

  // ---------------------------------------------------------- not set up ---
  // A repo with no `.autopilot/` at all: there is nothing to remove, so the
  // command says so and exits 0 rather than planning a teardown (or — via
  // main()'s dispatch order — launching the setup wizard in its place). The
  // fixture keeps everything else a real project has, including a `.gitignore`
  // still carrying the exact `.autopilot/` line: an implementation that built
  // the plan or applied the edit before checking `setUp` would move those
  // bytes, which an exit code alone could never show.
  {
    const repo = makeRepo("not-set-up");
    try {
      fs.rmSync(path.join(repo, ".autopilot"), {recursive: true, force: true});
      const projectPath = path.join(repo, ".autopilot");
      const gitignore = path.join(repo, ".gitignore");
      const before = readBytes(gitignore);
      const r = run(["uninstall"], repo);
      const after = readBytes(gitignore);
      const missing = [];
      if (r.status !== 0) missing.push(`exit ${r.status} (expected 0)`);
      if (!r.out.includes("Autopilot is not set up here")) missing.push("no \"Autopilot is not set up here\" report");
      if (fs.existsSync(projectPath)) missing.push(`${projectPath} was created`);
      if (fs.existsSync(path.join(projectPath, "config.json"))) missing.push(`${path.join(projectPath, "config.json")} was created`);
      if (!before || !after || Buffer.compare(before, after) !== 0) missing.push(".gitignore bytes changed");
      check("not set up: reports \"Autopilot is not set up here\", exits 0, leaves nothing behind",
        missing.length === 0, missing.length ? {missing, out: r.out} : undefined);
    } finally { remove(repo); }
  }

  // ------------------------------------------------------ non-TTY refusal ---
  // The confirmation contract: with `--yes` absent and stdin a pipe that is
  // closed at once (never a TTY), there is nobody to ask, so the command
  // refuses with exit 1 and names `--yes` — a scripted uninstall must never
  // delete in silence. The byte-identical snapshots are the load-bearing
  // assertions: the refusal prints the very same plan the successful run does,
  // so only the untouched `.autopilot/` tree, `.gitignore` and project file
  // separate a refusal from a teardown.
  {
    const repo = makeRepo("refuse");
    try {
      const projectPath = path.join(repo, ".autopilot");
      const gitignore = path.join(repo, ".gitignore");
      const appJs = path.join(repo, "app.js");
      const before = {tree: snapshotTree(projectPath), gitignore: readBytes(gitignore), app: readBytes(appJs)};
      const r = run(["uninstall"], repo);
      const after = {tree: snapshotTree(projectPath), gitignore: readBytes(gitignore), app: readBytes(appJs)};
      const missing = [];
      if (r.status !== 1) missing.push(`exit ${r.status} (expected 1)`);
      if (!r.out.includes("--yes")) missing.push("the refusal never names --yes");
      if (!sameTree(before.tree, after.tree)) missing.push(`.autopilot/ tree changed: ${JSON.stringify(Object.keys(after.tree))}`);
      if (!before.gitignore || !after.gitignore || Buffer.compare(before.gitignore, after.gitignore) !== 0) missing.push(".gitignore bytes changed");
      if (!before.app || !after.app || Buffer.compare(before.app, after.app) !== 0) missing.push("app.js bytes changed");
      check("non-TTY refusal: piped stdin without --yes exits 1, names --yes, and changes nothing",
        missing.length === 0, missing.length ? {missing, out: r.out} : undefined);
    } finally { remove(repo); }
  }

  // ------------------------------------------------------ --keep-missions ---
  // The third destructive path: the same teardown as `--yes`, except the
  // mission history survives. The move must land at the REPO ROOT (never
  // inside `.autopilot/`, which is deleted), exactly once, and the archive is
  // the old `missions/` directory itself (SKILL.md: the missions records live
  // on as the audit trail) — so it holds the mission directories and nothing
  // else: an archive that also carried `config.json`/`state.json`, or a second
  // dated directory from a repeat run, would be discovered here. `.gitignore`
  // is edited the same exact-line way as plain `--yes`, so the decoys are
  // pinned again, and the printed archive path is the only line that tells an
  // operator where their missions went.
  {
    const repo = makeRepo("keep-missions");
    try {
      const projectPath = path.join(repo, ".autopilot");
      const gitignore = path.join(repo, ".gitignore");
      const appJs = path.join(repo, "app.js");
      const r = run(["uninstall", "--keep-missions", "--yes"], repo);
      const missing = [];
      if (r.status !== 0) missing.push(`exit ${r.status} (expected 0)`);
      if (fs.existsSync(projectPath)) missing.push(`${projectPath} still exists`);
      // Exactly one archive directory at the repo root, dated — matched by
      // shape rather than a literal stamp so a run across midnight UTC (the
      // planner's `toISOString()` date) cannot flake.
      const archives = fs.readdirSync(repo).filter((e) => /^autopilot-missions-archive-\d{4}-\d{2}-\d{2}$/.test(e));
      if (archives.length !== 1) {
        missing.push(`expected 1 dated archive directory at the repo root, found ${JSON.stringify(archives)}`);
      }
      if (readBytes(appJs)?.toString("utf8") !== "// app\n") missing.push("app.js did not survive");
      const after = readBytes(gitignore);
      if (after === null) missing.push(".gitignore was deleted");
      else if (after.toString("utf8") !== EXPECTED_GITIGNORE) {
        missing.push(`.gitignore is ${JSON.stringify(after.toString("utf8"))}, expected ${JSON.stringify(EXPECTED_GITIGNORE)}`);
      }
      const archive = archives.length === 1 ? path.join(repo, archives[0]) : null;
      if (archive) {
        const tree = snapshotTree(archive);
        const keys = Object.keys(tree).sort();
        const expectedKeys = [`${MISSION}/PLAN.md`];
        if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
          missing.push(`archive holds ${JSON.stringify(keys)}, expected ${JSON.stringify(expectedKeys)}`);
        }
        const plan = readBytes(path.join(archive, MISSION, "PLAN.md"));
        if (!plan || plan.toString("utf8") !== PLAN_BODY) missing.push("archived PLAN.md content changed");
        if (!r.out.includes(`Missions archived to ${archive}.`)) missing.push("output never names the archive path");
      }
      check("keep-missions: exit 0, .autopilot/ gone, one dated archive holding the mission's PLAN.md, .gitignore kept",
        missing.length === 0, missing.length ? {missing, out: r.out} : undefined);
    } finally { remove(repo); }
  }

  // ------------------------------------------- live-run refusal (decoy) ---
  // A live run OWNS `.autopilot/` (its state, owner PID file and
  // checkpoints), so `ap uninstall` refuses rather than deleting the directory
  // out from under it — mirroring the same `stopLivePid()` liveness gate as
  // `ap cancel`/`ap stop`. The gate (`uninstallCommand`,
  // scripts/autopilot.mjs:491-499) runs BEFORE the `--dry-run` early return
  // (:513), so even the read-only preview exits 1 and names the pid on stderr:
  // there is no "preview then ask" surface while a run is alive, and `--yes`
  // does not bypass it either. Crucially, uninstall never KILLS the run (that
  // is `ap stop`'s job) — it only refuses and points at `ap stop` — so the
  // decoy must survive both invocations and is reaped by this test's own
  // `finally`, which is what makes "dead by the end of the finally" the proof
  // that uninstall left the live run running.
  //
  // POSIX-only: native Windows attributes the decoy via a CIM command-line
  // query whose visibility lags a just-spawned process by seconds, so the case
  // is skipped there (the mission-control suite owns the live-run detector).
  // Elsewhere, poll the real detector — the read-only `uninstall --dry-run`,
  // which never touches state — until it names the pid (bounded ~20s) instead
  // of a fixed settle that would race the very /proc scan under test.
  if (process.platform === "win32") {
    console.log("SKIP live-run refusal case on win32 (CIM visibility lags a just-spawned decoy; covered by test-mission-control-commands.mjs)");
  } else {
    const repo = makeRepo("live-run");
    const child = spawnDecoy(repo);
    try {
      const projectPath = path.join(repo, ".autopilot");
      const gitignore = path.join(repo, ".gitignore");
      const pidMsg = `a live run (pid ${child.pid})`;
      const before = {tree: snapshotTree(projectPath), gitignore: readBytes(gitignore)};
      await settle(400);

      // Poll the read-only preview until the decoy is visible. Each poll reads
      // combined stdout+stderr (what `run()` returns) and only breaks once the
      // exit is 1 AND the pid is named; bounded ~20s so a lagging /proc cannot
      // hang the suite.
      let dry;
      const start = Date.now();
      for (;;) {
        dry = run(["uninstall", "--dry-run"], repo);
        if (dry.status === 1 && dry.out.includes(pidMsg)) break;
        if (!decoyAlive(child)) break;
        if (Date.now() - start > 20000) break;
        await settle(500);
      }

      const dryMissing = [];
      if (dry.status !== 1) dryMissing.push(`exit ${dry.status} (expected 1 — the liveness gate precedes the dry-run branch)`);
      if (!dry.out.includes(pidMsg)) dryMissing.push(`the preview never named pid ${child.pid}`);
      if (!dry.out.includes("`ap stop`")) dryMissing.push("the refusal never points at `ap stop`");
      if (!decoyAlive(child)) dryMissing.push("the read-only preview killed the decoy");
      if (!sameTree(before.tree, snapshotTree(projectPath))) dryMissing.push(`.autopilot/ changed or was deleted on the dry-run: ${JSON.stringify(Object.keys(snapshotTree(projectPath)))}`);
      if (!before.gitignore || !readBytes(gitignore) || Buffer.compare(before.gitignore, readBytes(gitignore)) !== 0) dryMissing.push(".gitignore bytes changed on the dry-run");
      check("live-run: uninstall --dry-run refuses (exit 1) naming the pid and changes nothing (liveness gate precedes dry-run)",
        dryMissing.length === 0, dryMissing.length ? {missing: dryMissing, out: dry.out} : undefined);

      // --yes must ALSO refuse: approving up front never bypasses the liveness
      // gate. The project bytes stay intact, and — because uninstall never
      // kills a live run — the decoy is still alive here.
      const go = run(["uninstall", "--yes"], repo);
      const goMissing = [];
      if (go.status !== 1) goMissing.push(`exit ${go.status} (expected 1)`);
      if (!go.out.includes(pidMsg)) goMissing.push(`--yes never named pid ${child.pid}`);
      if (!sameTree(before.tree, snapshotTree(projectPath))) goMissing.push(`.autopilot/ changed or was deleted on --yes: ${JSON.stringify(Object.keys(snapshotTree(projectPath)))}`);
      if (!before.gitignore || !readBytes(gitignore) || Buffer.compare(before.gitignore, readBytes(gitignore)) !== 0) goMissing.push(".gitignore bytes changed on --yes");
      if (!decoyAlive(child)) goMissing.push("--yes killed the live run — only `ap stop` may do that");
      check("live-run: uninstall --yes refuses (exit 1) naming the pid, keeps .autopilot/ and .gitignore, and does not kill the run",
        goMissing.length === 0, goMissing.length ? {missing: goMissing, out: go.out} : undefined);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await decoyDead(child);
    }
    check("live-run: the decoy is dead by the end of the finally", !decoyAlive(child));
  }
} finally {
  cleanupRepos();
  check("teardown: no fixture directory left in the OS temp dir", remainingFixtures().length === 0, remainingFixtures());
  // ---------------------------------------------------------- report -------
  console.log(`\ntest-uninstall: ${ok} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
