#!/usr/bin/env node
// Backlog #14 (`ap uninstall`) — unit tests for the pure teardown core in
// scripts/uninstall.mjs. Everything runs against an in-memory fake `fs` (a
// Map of path -> {type,data}) so no branch needs a real temp repo: absence of
// `.autopilot/`, the exact-line `.gitignore` removal, EOL preservation, an
// emptied `.gitignore` being kept, `--keep-missions` archive naming and its
// collision suffix, and `executeUninstall` applying moves before deletes.
//
// Node's built-in test runner is not used here: this file mirrors the
// scripts/test-*.mjs convention (a `check()` tally + process.exit on failure)
// so it runs as plain `node scripts/test-uninstall-module.mjs`.
import {planUninstall, executeUninstall} from "./uninstall.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

// ---------------------------------------------------------------- fake fs ---
// Backed by a flat Map keyed by the exact absolute path the module builds via
// path.join. Directories are their own node (revealing children to
// readdirSync); files carry a string `data`. Every mutator records an op so
// tests can assert execution ORDER (moves vs deletes vs edits).
function makeFakeFs(seed = []) {
  const files = new Map();
  const ops = [];
  for (const e of seed) {
    files.set(e.path, e.dir ? {type: "dir"} : {type: "file", data: e.data});
  }
  const ancestors = (p) => {
    const parts = p.split("/");
    let cur = "";
    for (let i = 1; i < parts.length; i += 1) {
      cur += `/${parts[i]}`;
      if (!files.has(cur)) files.set(cur, {type: "dir"});
    }
  };
  const fs = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      const n = files.get(p);
      if (!n || n.type !== "file") throw new Error(`ENOENT read ${p}`);
      return n.data;
    },
    writeFileSync: (p, data) => { ops.push(["writef", p]); files.set(p, {type: "file", data: String(data)}); },
    mkdirSync: (p) => { ops.push(["mkdir", p]); ancestors(p); },
    renameSync: (from, to) => {
      ops.push(["rename", from, to]);
      const moving = [...files.keys()].filter((k) => k === from || k.startsWith(`${from}/`));
      for (const k of moving) {
        files.set(to + k.slice(from.length), files.get(k));
        files.delete(k);
      }
    },
    rmSync: (p, opts) => {
      ops.push(["rm", p, !!opts?.recursive]);
      const recursive = !!opts?.recursive;
      const killed = [...files.keys()].filter((k) => k === p || (recursive && k.startsWith(`${p}/`)));
      for (const k of killed) files.delete(k);
    },
    // The non-recursive delete path (`.autopilot/` once it is empty): like the
    // real fs, `rmdirSync` only removes an empty directory and `unlinkSync`
    // only removes a file — which is exactly why the real-fs regression test
    // below exists (the fake alone could not see ERR_FS_EISDIR).
    rmdirSync: (p) => {
      const node = files.get(p);
      if (!node || node.type !== "dir") throw Object.assign(new Error(`ENOTDIR ${p}`), {code: "ENOTDIR"});
      if ([...files.keys()].some((k) => k.startsWith(`${p}/`))) throw Object.assign(new Error(`ENOTEMPTY ${p}`), {code: "ENOTEMPTY"});
      ops.push(["rm", p, false]);
      files.delete(p);
    },
    unlinkSync: (p) => {
      const node = files.get(p);
      if (!node) throw Object.assign(new Error(`ENOENT ${p}`), {code: "ENOENT"});
      if (node.type === "dir") throw Object.assign(new Error(`EISDIR ${p}`), {code: "EISDIR"});
      ops.push(["rm", p, false]);
      files.delete(p);
    },
    readdirSync: (p) => {
      const prefix = `${p}/`;
      const out = [];
      const seen = new Set();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rel = k.slice(prefix.length);
        const name = rel.split("/")[0];
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({name, isDirectory: () => files.get(`${prefix}${name}`)?.type === "dir"});
      }
      return out;
    },
    _files: files,
    _ops: ops,
  };
  return fs;
}

const REPO = "/proj";
const AP = `${REPO}/.autopilot`;
const NOW = new Date("2020-01-02T03:04:05.000Z");
const STAMP = NOW.toISOString().slice(0, 10); // "2020-01-02"

// A fully populated `.autopilot/` subtree (mirrors the real layout).
const typicalAutopilot = () => [
  {path: REPO, dir: true},
  {path: AP, dir: true},
  {path: `${AP}/config.json`, data: "{}"},
  {path: `${AP}/state.json`, data: "{}"},
  {path: `${AP}/certifications`, dir: true},
  {path: `${AP}/missions`, dir: true},
  {path: `${AP}/missions/001-demo`, dir: true},
];

// ------------------------------------------------ exports + surface shape ---
check("planUninstall is exported as a function", typeof planUninstall === "function");
check("executeUninstall is exported as a function", typeof executeUninstall === "function");

// ------------------------------- 1. .autopilot/ absent -> setUp:false -------
{
  const fs = makeFakeFs([{path: REPO, dir: true}]);
  const plan = planUninstall(REPO, {fs, now: NOW});
  check("absent: projectPath points at .autopilot", plan.projectPath === AP, plan.projectPath);
  check("absent: setUp is false", plan.setUp === false);
  check("absent: nothing to delete", Array.isArray(plan.deletes) && plan.deletes.length === 0);
  check("absent: no edits", Array.isArray(plan.edits) && plan.edits.length === 0);
  check("absent: no moves", Array.isArray(plan.moves) && plan.moves.length === 0);
}

// --------------------- 2. .autopilot/ present, no .gitignore -> setUp:true --
{
  const fs = makeFakeFs(typicalAutopilot());
  const plan = planUninstall(REPO, {fs, now: NOW});
  check("present: setUp is true", plan.setUp === true);
  check("present: recursive delete of .autopilot", plan.deletes.length === 1 && plan.deletes[0].path === AP && plan.deletes[0].recursive === true, plan.deletes);
  check("present: no gitignore edit when file absent", plan.edits.length === 0);
  check("present: no moves without keep-missions", plan.moves.length === 0);
}

// --------------- 3. gitignore: exact-line removal only, EOL kept (LF) -------
{
  const before = "node_modules/\n.autopilot/\nscratch/\n";
  const fs = makeFakeFs([{path: REPO, dir: true}, {path: AP, dir: true}, {path: `${REPO}/.gitignore`, data: before}]);
  const plan = planUninstall(REPO, {fs, now: NOW});
  check("gitignore LF: exactly one edit", plan.edits.length === 1);
  const edit = plan.edits[0];
  check("gitignore LF: edit targets .gitignore", edit.path === `${REPO}/.gitignore`);
  check("gitignore LF: before preserved", edit.before === before);
  check("gitignore LF: only the exact line removed, others + trailing newline kept", edit.after === "node_modules/\nscratch/\n", edit.after);
}

// ----------------- 4. gitignore: loose matches are left untouched -----------
{
  const before = ".autopilot\n" +                 // no trailing slash -> kept
                 "foo/.autopilot/\n" +            // nested path -> kept
                 ".autopilot-cache/\n" +          // substring -> kept
                 ".autopilot/\n";                 // the one exact line -> removed
  const fs = makeFakeFs([{path: REPO, dir: true}, {path: AP, dir: true}, {path: `${REPO}/.gitignore`, data: before}]);
  const plan = planUninstall(REPO, {fs, now: NOW});
  check("gitignore loose: one edit (the exact line exists)", plan.edits.length === 1, plan.edits.length);
  const after = plan.edits[0].after;
  check("gitignore loose: keeps no-slash .autopilot", after.includes(".autopilot\n"), after);
  check("gitignore loose: keeps nested foo/.autopilot/", after.includes("foo/.autopilot/\n"), after);
  check("gitignore loose: keeps .autopilot-cache/", after.includes(".autopilot-cache/\n"), after);
  check("gitignore loose: exact bare line removed", !/^\.autopilot\/\n/m.test(after), after);
}

// ---------------------------- 5. gitignore: CRLF style preserved -------------
{
  const before = "node_modules/\r\n.autopilot/\r\n";
  const fs = makeFakeFs([{path: REPO, dir: true}, {path: AP, dir: true}, {path: `${REPO}/.gitignore`, data: before}]);
  const plan = planUninstall(REPO, {fs, now: NOW});
  check("gitignore CRLF: one edit", plan.edits.length === 1);
  check("gitignore CRLF: EOL style preserved", plan.edits[0].after === "node_modules/\r\n", plan.edits[0].after);
}

// ---------------------- 6. gitignore: emptied file is kept (not deleted) -----
{
  const before = ".autopilot/\n";
  const fs = makeFakeFs([{path: REPO, dir: true}, {path: AP, dir: true}, {path: `${REPO}/.gitignore`, data: before}]);
  const plan = planUninstall(REPO, {fs, now: NOW});
  check("gitignore emptied: still one edit", plan.edits.length === 1);
  check("gitignore emptied: after is empty string (file kept, not removed)", plan.edits[0].after === "", plan.edits[0].after);
  check("gitignore emptied: no delete planned for .gitignore", !plan.deletes.some((d) => d.path === `${REPO}/.gitignore`), plan.deletes);
}

// ------------- 7. gitignore present but no .autopilot line -> no edit --------
{
  const before = "node_modules/\n";
  const fs = makeFakeFs([{path: REPO, dir: true}, {path: AP, dir: true}, {path: `${REPO}/.gitignore`, data: before}]);
  const plan = planUninstall(REPO, {fs, now: NOW});
  check("gitignore unrelated: no edit emitted", plan.edits.length === 0);
}

// -------------- 8. keep-missions: archive naming (no collision) --------------
{
  const fs = makeFakeFs(typicalAutopilot());
  const plan = planUninstall(REPO, {keepMissions: true, fs, now: NOW});
  check("keep-missions: one move", plan.moves.length === 1);
  const move = plan.moves[0];
  check("keep-missions: move source is .autopilot/missions", move.from === `${AP}/missions`, move.from);
  check("keep-missions: archive name is dated at repo root", move.to === `${REPO}/autopilot-missions-archive-${STAMP}`, move.to);
  const dirDeletes = plan.deletes.filter((d) => d.recursive);
  check("keep-missions: no recursive delete of .autopilot itself", !dirDeletes.some((d) => d.path === AP), dirDeletes);
  check("keep-missions: non-missions entries scheduled for recursive delete", dirDeletes.some((d) => d.path === `${AP}/config.json`) && dirDeletes.some((d) => d.path === `${AP}/certifications`), dirDeletes);
  check("keep-missions: empty .autopilot removed at the end", plan.deletes.some((d) => d.path === AP && d.recursive === false), plan.deletes);
}

// -------------- 9. keep-missions: collision gets a numeric suffix ------------
{
  const seed = typicalAutopilot();
  seed.push({path: `${REPO}/autopilot-missions-archive-${STAMP}`, dir: true});           // already taken
  seed.push({path: `${REPO}/autopilot-missions-archive-${STAMP}-2`, dir: true});          // ...and next too
  const fs = makeFakeFs(seed);
  const plan = planUninstall(REPO, {keepMissions: true, fs, now: NOW});
  check("keep-missions collision: picks first free -N suffix", plan.moves[0].to === `${REPO}/autopilot-missions-archive-${STAMP}-3`, plan.moves[0].to);
}

// ---------------- 10. keep-missions absent missions -> no move ----------------
{
  const fs = makeFakeFs([{path: REPO, dir: true}, {path: AP, dir: true}, {path: `${AP}/config.json`, data: "{}"}]);
  const plan = planUninstall(REPO, {keepMissions: true, fs, now: NOW});
  check("keep-missions no dir: no move", plan.moves.length === 0);
  check("keep-missions no dir: still tears down .autopilot", plan.setUp === true && plan.deletes.some((d) => d.path === AP), plan.deletes);
}

// ------------- 11. executeUninstall: moves happen before deletes -------------
{
  const seed = typicalAutopilot();
  seed.push({path: `${REPO}/.gitignore`, data: "node_modules/\n.autopilot/\n"});
  const fs = makeFakeFs(seed);
  const plan = planUninstall(REPO, {keepMissions: true, fs, now: NOW});
  executeUninstall(plan, {fs});
  const ops = fs._ops;
  const firstRename = ops.findIndex((o) => o[0] === "rename");
  const firstRm = ops.findIndex((o) => o[0] === "rm");
  const firstWrite = ops.findIndex((o) => o[0] === "writef");
  check("execute: a move occurred", firstRename !== -1, ops);
  check("execute: a delete occurred", firstRm !== -1, ops);
  check("execute: moves precede deletes", firstRename !== -1 && firstRm !== -1 && firstRename < firstRm, {firstRename, firstRm});
  check("execute: edit applied after teardown", firstWrite !== -1 && firstRm !== -1 && firstRm < firstWrite, {firstRm, firstWrite});
  check("execute: .autopilot fully removed", !fs.existsSync(AP));
  check("execute: archived missions landed at repo root", fs.existsSync(`${REPO}/autopilot-missions-archive-${STAMP}/missions/001-demo`) || fs.existsSync(`${REPO}/autopilot-missions-archive-${STAMP}/001-demo`));
  check("execute: .gitignore edit applied", fs.readFileSync(`${REPO}/.gitignore`) === "node_modules/\n");
}

// ------------- 12. executeUninstall: emptied gitignore kept as empty ----------
{
  const fs = makeFakeFs([{path: AP, dir: true}, {path: `${REPO}/.gitignore`, data: ".autopilot/\n"}]);
  const plan = planUninstall(REPO, {fs, now: NOW});
  executeUninstall(plan, {fs});
  check("execute emptied: .autopilot removed", !fs.existsSync(AP));
  check("execute emptied: .gitignore still present, now empty", fs.existsSync(`${REPO}/.gitignore`) && fs.readFileSync(`${REPO}/.gitignore`) === "");
}

// ------------- 13. executeUninstall: setUp:false plan is a no-op -------------
{
  const fs = makeFakeFs([{path: REPO, dir: true}]);
  const plan = planUninstall(REPO, {fs, now: NOW});
  executeUninstall(plan, {fs});
  check("execute no-op: nothing mutated for an unset-up repo", fs._ops.length === 0, fs._ops);
}

// ------- 14. executeUninstall: REAL fs, keep-missions end to end -------------
// The fake fs records ops without validating them, so it cannot see the real
// filesystem's objections. This is the test that pins the non-recursive
// `.autopilot/` delete (planDeletes marks it `recursive:false` because the
// `missions/` move and every sibling delete vacate it first): `rmSync` WITHOUT
// `recursive` refuses a directory with ERR_FS_EISDIR, so the executor must
// empty-dir it via `rmdirSync`. Built under $TMPDIR, never inside the repo.
{
  const real = await import("node:fs");
  const os = await import("node:os");
  const tmp = real.mkdtempSync(path.join(os.tmpdir(), "uninstall-real."));
  try {
    real.mkdirSync(path.join(tmp, ".autopilot", "missions", "081-demo"), {recursive: true});
    real.writeFileSync(path.join(tmp, ".autopilot", "state.json"), "{}\n");
    real.writeFileSync(path.join(tmp, ".autopilot", "missions", "081-demo", "PLAN.md"), "# p\n");
    real.writeFileSync(path.join(tmp, ".gitignore"), "node_modules/\n.autopilot/\n");
    const plan = planUninstall(tmp, {keepMissions: true, now: NOW});
    let threw = null;
    try { executeUninstall(plan); } catch (e) { threw = e; }
    check("real fs: keep-missions executes without throwing", threw === null, threw?.message);
    check("real fs: .autopilot removed entirely", !real.existsSync(path.join(tmp, ".autopilot")));
    const arcs = real.readdirSync(tmp).filter((f) => f.startsWith("autopilot-missions-archive-"));
    check("real fs: missions archived at repo root", arcs.length === 1 &&
      real.existsSync(path.join(tmp, arcs[0], "081-demo", "PLAN.md")), arcs);
    check("real fs: .gitignore keeps only unrelated lines",
      real.readFileSync(path.join(tmp, ".gitignore"), "utf8") === "node_modules/\n");
  } finally {
    real.rmSync(tmp, {recursive: true, force: true});
  }
}

// ------------------------------------------------------- CLI wiring (static)
// Backlog #14 task 1.2: `ap uninstall` lives in scripts/autopilot.mjs, which
// is a CLI entry point (it runs `main()` at import time), so the integration
// is asserted statically against the source rather than by spawning it. The
// assertions mirror the task contract: `uninstallCommand` exists and is
// modeled on `cancelCommand` (same `stopLivePid()` liveness refusal, same
// plan-first/--dry-run/--yes/non-TTY-refusal confirmation contract), and
// `main()` dispatches `uninstall` BEFORE `ensureFirstRun()` so a repo without
// `.autopilot/` reports "Autopilot is not set up here" and exits 0 instead of
// launching the setup wizard.
import fs from "node:fs";
import path from "node:path";

const autoSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

check("wiring: autopilot.mjs imports the pure teardown core",
  /import \{planUninstall, executeUninstall\} from "\.\/uninstall\.mjs";/.test(autoSrc));
check("wiring: uninstallCommand is defined in autopilot.mjs",
  /function uninstallCommand\(args=\[\]\)\{/.test(autoSrc));
check("wiring: --repo resolves the target repo (module-level argv parse)",
  autoSrc.includes("const repo=path.resolve(process.argv.includes(\"--repo\")?process.argv[process.argv.indexOf(\"--repo\")+1]||\".\":process.cwd());"));

// Slice the command body: from its declaration to the next top-level
// statement (the STOP_GRACE_MS constants after it), so every per-command
// assertion below cannot accidentally match another command's code.
const cmdStart = autoSrc.indexOf("function uninstallCommand(");
const cmdEnd = autoSrc.indexOf("\nconst ", cmdStart);
const cmdBody = cmdStart >= 0 && cmdEnd > cmdStart ? autoSrc.slice(cmdStart, cmdEnd) : "";
check("wiring: command body located", cmdBody.length > 0, {cmdStart, cmdEnd});

check("wiring: refuses while a run is live, reusing stopLivePid()",
  cmdBody.includes("const found=stopLivePid();"));
check("wiring: ambiguous live runs are reported, never guessed past",
  cmdBody.includes("found.ambiguous.length} live runs match this repository"));
check("wiring: a live pid refuses with a non-zero exit",
  /if\(found\.pid\)\{/.test(cmdBody) && cmdBody.includes("return 1;"));
check("wiring: plans through the pure planner, keyed on keepMissions",
  cmdBody.includes("planUninstall(repo,{keepMissions})"));
check("wiring: not set up here reports and exits 0 without setup",
  cmdBody.includes("if(!plan.setUp){")
  && cmdBody.indexOf("console.log(\"Autopilot is not set up here.\");") > cmdBody.indexOf("if(!plan.setUp){")
  && cmdBody.indexOf("return 0;") > cmdBody.indexOf("console.log(\"Autopilot is not set up here.\");"));
check("wiring: plan printed with the project path plus every delete/edit/move path",
  cmdBody.includes("plan.projectPath")
  && cmdBody.includes("will archive:")
  && cmdBody.includes("will delete:")
  && cmdBody.includes("will edit:"));

// Flag surface: --dry-run / --yes / --keep-missions are parsed inside the
// handler, like cancelCommand's --yes/--dry-run.
check("wiring: --dry-run flag parsed", cmdBody.includes("args.includes(\"--dry-run\")"));
check("wiring: --yes flag parsed", cmdBody.includes("args.includes(\"--yes\")"));
check("wiring: --keep-missions flag parsed", cmdBody.includes("args.includes(\"--keep-missions\")"));

// Confirmation contract, in order: dry-run returns before the prompt and
// before anything is written; a missing TTY without --yes refuses with exit 1
// before the mutation; the single writer runs last.
const dryRunIdx = cmdBody.indexOf("if(dryRun) return 0;");
const promptIdx = cmdBody.indexOf("stdinIsInteractive()");
const executeIdx = cmdBody.indexOf("executeUninstall(plan);");
check("wiring: --dry-run prints the plan and writes nothing",
  dryRunIdx >= 0 && promptIdx > dryRunIdx && executeIdx > dryRunIdx);
check("wiring: no TTY and no --yes refuses with exit 1 before any write",
  promptIdx >= 0 && executeIdx > promptIdx
  && /console\.error\("ap uninstall: refusing to act without confirmation/.test(cmdBody)
  && cmdBody.indexOf("return 1;", promptIdx) < executeIdx);
check("wiring: executeUninstall is the single writer and runs last",
  executeIdx >= 0 && cmdBody.indexOf("writeFileSync") === -1 && cmdBody.indexOf("rmSync") === -1);

// Dispatch position: main() must route `uninstall` BEFORE ensureFirstRun().
const mainIdx = autoSrc.indexOf("async function main(");
const dispatchIdx = autoSrc.indexOf("if(command===\"uninstall\")", mainIdx);
const callIdx = autoSrc.indexOf("uninstallCommand(commandArgs)", mainIdx);
const firstRunIdx = autoSrc.indexOf("ensureFirstRun();", mainIdx);
check("wiring: main() dispatches the uninstall command", dispatchIdx >= 0 && callIdx > dispatchIdx);
check("wiring: dispatch precedes ensureFirstRun() in main()",
  firstRunIdx >= 0 && dispatchIdx >= 0 && dispatchIdx < firstRunIdx);
check("wiring: dispatch applies the handler's exit code",
  autoSrc.includes("const code=uninstallCommand(commandArgs);")
  && autoSrc.includes("process.exitCode=code;"));

// ---------------------------------------------------------------- report ----
console.log(`\ntest-uninstall-module: ${ok} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
