#!/usr/bin/env node
// Mission 064 Phase 1 task 1.1 — repo-scoped live-scan helper tests.
//
// Drives `isLiveRunForRepo` / `findRepoLiveRuns` (plus the scan's own
// `parseLiveScanRepoValue`) from `scripts/owner-pid.mjs` with a FAKE
// process list and injected readers only: no real /proc access, no spawned
// processes, no `process.on("exit")` hooks.
import fs from "node:fs";
import path from "node:path";
import {
  isLiveRunForRepo,
  findRepoLiveRuns,
  parseLiveScanRepoValue,
} from "./owner-pid.mjs";

let ok = 0, failed = 0;
function check(name, condition, detail){
  if(condition){ ok++; console.log(`PASS ${name}`); return; }
  failed++;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

// POSIX /proc-style cmdline: NUL-separated argv.
function procCmd(...argv){ return argv.join("\0") + "\0"; }

const REPO = "/work/this-repo";
const OTHER = "/work/other-repo";
const SIBLING = "/work/this-repo-other";
const LINK = "/work/link-repo";
const SPACE_REPO = "/work/space repo";
const ELSEWHERE = "/work/elsewhere";

// Fake realpath: LINK -> REPO, everything else identity. No real fs access.
const SYMLINKS = { [LINK]: REPO };
function fakeRealpath(p){
  if(p in SYMLINKS) return SYMLINKS[p];
  return p;
}
const rpOpts = { realpathSync: fakeRealpath };

// ---- 0. helpers importable -------------------------------------------------
check("isLiveRunForRepo importable", typeof isLiveRunForRepo === "function");
check("findRepoLiveRuns importable", typeof findRepoLiveRuns === "function");
check("parseLiveScanRepoValue importable", typeof parseLiveScanRepoValue === "function");

// ---- 0b. own parser: --repo= and value-less --repo count as absent ---------
check("proc parser ignores --repo= form",
  parseLiveScanRepoValue(procCmd("node", "/x/autopilot.mjs", "run", `--repo=${REPO}`)) === null);
check("proc parser value-less trailing --repo is absent",
  parseLiveScanRepoValue(procCmd("node", "/x/autopilot.mjs", "run", "--repo")) === null);
check("cim parser ignores --repo= form",
  parseLiveScanRepoValue(`node /x/autopilot.mjs run --repo=${REPO}`) === null);
check("cim parser value-less trailing --repo is absent",
  parseLiveScanRepoValue("node /x/autopilot.mjs run --repo") === null);
check("proc parser takes exact --repo next element",
  parseLiveScanRepoValue(procCmd("node", "/x/autopilot.mjs", "run", "--repo", REPO)) === REPO);
check("proc parser keeps spaced path as one element",
  parseLiveScanRepoValue(procCmd("node", "/x/autopilot.mjs", "run", "--repo", SPACE_REPO)) === SPACE_REPO);
check("cim parser quote-aware spaced path",
  parseLiveScanRepoValue(`node /x/autopilot.mjs run --repo "${SPACE_REPO}"`) === SPACE_REPO);

// ---- fake process table (linux /proc style) --------------------------------
// pid -> {cmd, cwd}; cwd === null means readCwd throws (unreadable).
const table = new Map([
  [101, { cmd: procCmd("node", "/x/other.mjs", "run", "--repo", REPO), cwd: REPO }],
  [102, { cmd: procCmd("node", "/x/autopilot.mjs", "run", "--repo", OTHER), cwd: OTHER }],
  [103, { cmd: procCmd("node", `${REPO}/scripts/autopilot.mjs`, "run", "--repo", OTHER), cwd: OTHER }],
  [104, { cmd: procCmd("node", "/x/autopilot.mjs", "run", "--repo", SIBLING), cwd: SIBLING }],
  [105, { cmd: procCmd("node", "/x/autopilot.mjs", "run", "--repo", REPO), cwd: ELSEWHERE }],
  [106, { cmd: procCmd("node", "/x/autopilot.mjs", "run"), cwd: REPO }],
  [107, { cmd: procCmd("node", "/x/autopilot.mjs", "resume", "--repo", LINK), cwd: ELSEWHERE }],
  [108, { cmd: procCmd("node", "/x/autopilot.mjs", "implement", "--repo", REPO), cwd: ELSEWHERE }],
  [109, { cmd: procCmd("node", "/x/autopilot.mjs", "run"), cwd: LINK }],
  [110, { cmd: procCmd("node", "/x/autopilot.mjs", "run", "--repo", ".."), cwd: `${REPO}/child` }],
  [111, { cmd: procCmd("node", "/x/autopilot.mjs", "run", "--repo", ".."), cwd: null }],
  [112, { cmd: procCmd("node", `${REPO}/scripts/autopilot.mjs`, "run"), cwd: null }],
  [113, { cmd: procCmd("node", "/x/autopilot.mjs", "run", "--repo", SPACE_REPO), cwd: ELSEWHERE }],
  [114, { cmd: procCmd("node", "/x/autopilot.mjs", "run", "Fix --repo bug"), cwd: OTHER }],
  [115, { cmd: procCmd("node", "/x/autopilot.mjs", "run", "--repo", REPO, "Fix --repo bug"), cwd: ELSEWHERE }],
  [116, { cmd: procCmd("node", "/x/autopilot.mjs", "run", `--repo=${REPO}`), cwd: OTHER }],
  [117, { cmd: procCmd("node", "/x/autopilot.mjs", "run", "--repo"), cwd: OTHER }],
  [118, { cmd: procCmd("node", "/x/autopilot.mjs", "status", "--repo", REPO), cwd: ELSEWHERE }],
]);

function makeReaders(extra = {}){
  const t = extra.table ?? table;
  return {
    listPids: () => [...t.keys()],
    readCmdline: (pid) => {
      const e = t.get(pid);
      if(!e) throw new Error(`no such pid ${pid}`);
      return e.cmd;
    },
    readCwd: (pid) => {
      const e = t.get(pid);
      if(!e || e.cwd == null) throw Object.assign(new Error("unreadable"), { code: "ENOENT" });
      return e.cwd;
    },
  };
}

// ---- 1. non-autopilot.mjs run process ignored -------------------------------
{
  const { listPids, readCmdline, readCwd } = makeReaders();
  const found = findRepoLiveRuns(REPO, { listPids, readCmdline, readCwd, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("non-autopilot.mjs run ignored", !found.includes(101), found);
}

// ---- 2. other-repo ignored ---------------------------------------------------
{
  const { listPids, readCmdline, readCwd } = makeReaders();
  const found = findRepoLiveRuns(REPO, { listPids, readCmdline, readCwd, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("other-repo --repo ignored", !found.includes(102), found);
}

// ---- 3. script-path containment ignored --------------------------------------
{
  const { listPids, readCmdline, readCwd } = makeReaders();
  const found = findRepoLiveRuns(REPO, { listPids, readCmdline, readCwd, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("script-path containment ignored", !found.includes(103), found);
}

// ---- 4. <repo>-other prefix sibling ignored ----------------------------------
{
  const { listPids, readCmdline, readCwd } = makeReaders();
  const found = findRepoLiveRuns(REPO, { listPids, readCmdline, readCwd, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("prefix sibling ignored", !found.includes(104), found);
}

// ---- 5. this-repo detected by --repo and by cwd, incl. symlinked spellings --
{
  const { listPids, readCmdline, readCwd } = makeReaders();
  const found = findRepoLiveRuns(REPO, { listPids, readCmdline, readCwd, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("this-repo via --repo detected", found.includes(105), found);
  check("this-repo via cwd detected", found.includes(106), found);
  check("symlinked --repo detected", found.includes(107), found);
  check("symlinked cwd detected", found.includes(109), found);
  // Direct matcher checks for the same spellings.
  check("matcher: symlinked --repo",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run", "--repo", LINK), ELSEWHERE, REPO, rpOpts) === true);
  check("matcher: symlinked cwd",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run"), LINK, REPO, rpOpts) === true);
}

// ---- 6. relative --repo: resolved-here detected, unreadable-cwd skipped -----
{
  check("matcher: relative --repo resolving here",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run", "--repo", ".."), `${REPO}/child`, REPO, rpOpts) === true);
  check("matcher: relative --repo with unreadable cwd skipped",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run", "--repo", ".."), null, REPO, rpOpts) === false);
  const { listPids, readCmdline, readCwd } = makeReaders();
  const found = findRepoLiveRuns(REPO, { listPids, readCmdline, readCwd, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("scan: relative --repo resolving here detected", found.includes(110), found);
  check("scan: relative --repo unreadable cwd skipped", !found.includes(111), found);
}

// ---- 7. script-path-only no---repo no-cwd skipped ----------------------------
{
  check("matcher: script-path-only no---repo no-cwd skipped",
    isLiveRunForRepo(procCmd("node", `${REPO}/scripts/autopilot.mjs`, "run"), null, REPO, rpOpts) === false);
  const { listPids, readCmdline, readCwd } = makeReaders();
  const found = findRepoLiveRuns(REPO, { listPids, readCmdline, readCwd, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("scan: script-path-only no-cwd skipped", !found.includes(112), found);
}

// ---- 8. /proc --repo path with spaces detected -------------------------------
{
  check("matcher: spaced /proc --repo",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run", "--repo", SPACE_REPO), ELSEWHERE, SPACE_REPO, rpOpts) === true);
  const { listPids, readCmdline, readCwd } = makeReaders();
  const foundSpace = findRepoLiveRuns(SPACE_REPO, { listPids, readCmdline, readCwd, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("scan: spaced /proc --repo detected for its repo", foundSpace.includes(113), foundSpace);
  const foundMain = findRepoLiveRuns(REPO, { listPids, readCmdline, readCwd, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("scan: spaced other-repo not attributed to this repo", !foundMain.includes(113), foundMain);
}

// ---- 9. request argument containing --repo text not misparsed ----------------
{
  check("matcher: bare request '--repo' text not a flag",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run", "Fix --repo bug"), OTHER, REPO, rpOpts) === false);
  check("matcher: real --repo wins over later request text",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run", "--repo", REPO, "Fix --repo bug"), ELSEWHERE, REPO, rpOpts) === true);
  const { listPids, readCmdline, readCwd } = makeReaders();
  const found = findRepoLiveRuns(REPO, { listPids, readCmdline, readCwd, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("scan: request --repo text not misparsed", !found.includes(114), found);
  check("scan: real --repo + request text detected", found.includes(115), found);
}

// ---- 10. undeterminable skipped ----------------------------------------------
{
  check("matcher: --repo= form unattributed (cwd elsewhere)",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run", `--repo=${REPO}`), OTHER, REPO, rpOpts) === false);
  check("matcher: value-less --repo unattributed (cwd elsewhere)",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run", "--repo"), OTHER, REPO, rpOpts) === false);
  check("matcher: no --repo + unreadable cwd skipped",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run"), null, REPO, rpOpts) === false);
  const { listPids, readCmdline, readCwd } = makeReaders();
  const found = findRepoLiveRuns(REPO, { listPids, readCmdline, readCwd, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("scan: --repo= skipped", !found.includes(116), found);
  check("scan: value-less --repo skipped", !found.includes(117), found);
  check("scan: non-run token (status) ignored", !found.includes(118), found);
}

// ---- 11. CIM text path: quoted spaced --repo + request text ------------------
{
  const cimTable = new Map([
    [201, { cmd: `node C:\\x\\autopilot.mjs run --repo "${SPACE_REPO}"`, cwd: ELSEWHERE }],
    [202, { cmd: 'node C:\\x\\autopilot.mjs run "Fix --repo bug"', cwd: OTHER }],
    [203, { cmd: `node C:\\x\\autopilot.mjs run --repo ${REPO} "Fix --repo bug"`, cwd: ELSEWHERE }],
  ]);
  const readers = makeReaders({ table: cimTable });
  const foundSpace = findRepoLiveRuns(SPACE_REPO, { ...readers, selfPid: -1, platform: "win32", realpathSync: fakeRealpath });
  check("cim: quoted spaced --repo detected", foundSpace.includes(201), foundSpace);
  const foundMain = findRepoLiveRuns(REPO, { ...readers, selfPid: -1, platform: "win32", realpathSync: fakeRealpath });
  check("cim: quoted request --repo text not misparsed", !foundMain.includes(202), foundMain);
  check("cim: real --repo + quoted request detected", foundMain.includes(203), foundMain);
}

// ---- 12. self pid excluded ----------------------------------------------------
{
  const { readCmdline, readCwd } = makeReaders();
  const found = findRepoLiveRuns(REPO, {
    listPids: () => [105, 106],
    readCmdline, readCwd, selfPid: 105, platform: "linux", realpathSync: fakeRealpath,
  });
  check("self pid excluded", !found.includes(105) && found.includes(106), found);
}

// ---- 13. source pins: scans delegate the loop to the helper ------------
{
  const root = path.dirname(new URL(import.meta.url).pathname);
  const ap = fs.readFileSync(path.join(root, "autopilot.mjs"), "utf8");
  const owner = fs.readFileSync(path.join(root, "owner-pid.mjs"), "utf8");
  const procBody = ap.slice(ap.indexOf("function missionControlLiveRun"), ap.indexOf("MISSION_SCOPED_STATE_KEYS"));
  const cimCommentStart = ap.indexOf("// Windows fallback for missionControlLiveRun");
  const cimBody = ap.slice(cimCommentStart === -1 ? ap.indexOf("function cimLiveRun") : cimCommentStart, ap.indexOf("function stopLivePid"));
  const stopBody = ap.slice(ap.indexOf("function stopLivePid"), ap.indexOf("function signalPid"));
  check("proc scan calls the exported helper", procBody.includes("findRepoLiveRuns("), procBody.length);
  check("cim scan calls the exported helper", cimBody.includes("findRepoLiveRuns("), cimBody.length);
  check("proc substring attribution removed", !procBody.includes("cmd.includes(repo)") && !procBody.includes("cmd.includes(resolvedRepo)"));
  check("cim substring attribution removed", !cimBody.includes("cmd.includes(repo)") && !cimBody.includes("cmd.includes(resolvedRepo)"));
  check("loop/filter logic not duplicated in proc body",
    !procBody.includes("(run|resume|implement)") && !procBody.includes('cmd.includes("autopilot.mjs")'));
  check("loop/filter logic not duplicated in cim body",
    !cimBody.includes("(run|resume|implement)") && !cimBody.includes('cmd.includes("autopilot.mjs")'));
  check("cim keeps PowerShell -like filter", cimBody.includes("-like '*autopilot.mjs*'"));
  check("proc comment describes --repo/cwd realpath attribution",
    procBody.includes("--repo") && procBody.includes("realpath"));
  check("cim comment describes --repo realpath attribution",
    cimBody.includes("--repo") && cimBody.includes("realpath"));
  check("cim keeps single CIM query", (cimBody.match(/Get-CimInstance/g) || []).length === 1);
  check("cim feeds parsed pid->cmdline map as listPids/readCmdline",
    cimBody.includes("cmdByPid") && cimBody.includes("listPids") && cimBody.includes("readCmdline"));
  check("cim has no readCwd on win32", !cimBody.includes("readCwd") && !cimBody.includes("readlinkSync"));
  check("proc feeds readdir listPids with /proc readers",
    procBody.includes("readdirSync") && procBody.includes("readCmdline") && procBody.includes("readCwd")
    && procBody.includes("selfPid") && procBody.includes("platform"));
  check("proc keeps first-match", procBody.includes("found[0]"));
  check("cim keeps all-matches", cimBody.includes("return found"));
  check("helper owns the NUL token regex", owner.includes("(?:^|\\0)(?:run|resume|implement)(?:\\0|$)"));
  check("helper owns the whitespace token regex", owner.includes("(?:^|\\s)(?:run|resume|implement)(?:\\s|$)"));
  check("scans do not use OWNER_COMMAND_TOKEN",
    !procBody.includes("OWNER_COMMAND_TOKEN") && !cimBody.includes("OWNER_COMMAND_TOKEN"));
  check("stopLivePid shape unchanged",
    stopBody.includes("readOwnerPid") && stopBody.includes("verifyOwnerPid")
    && stopBody.includes("missionControlLiveRun()") && stopBody.includes("cimLiveRun()"));
  check("helper owns the autopilot.mjs cmdline filter", owner.includes('cmd.includes("autopilot.mjs")'));
}

// ---- 14. task 1.3 extra edge cases (all pass post-1.2, fake readers only) ---
{
  // --repo=<this repo> (= form counts as absent): cwd elsewhere not
  // attributed, cwd here attributed via cwd fallback.
  check("matcher: --repo= form cwd elsewhere not attributed",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run", `--repo=${REPO}`), ELSEWHERE, REPO, rpOpts) === false);
  check("matcher: --repo= form cwd here attributed via cwd",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run", `--repo=${REPO}`), REPO, REPO, rpOpts) === true);
  const eqTable = new Map([
    [301, { cmd: procCmd("node", "/x/autopilot.mjs", "run", `--repo=${REPO}`), cwd: ELSEWHERE }],
    [302, { cmd: procCmd("node", "/x/autopilot.mjs", "run", `--repo=${REPO}`), cwd: REPO }],
  ]);
  const eqReaders = makeReaders({ table: eqTable });
  const eqFound = findRepoLiveRuns(REPO, { ...eqReaders, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
  check("scan: --repo= cwd elsewhere not attributed", !eqFound.includes(301), eqFound);
  check("scan: --repo= cwd here attributed via cwd", eqFound.includes(302), eqFound);

  // Quoted spaced paths via exact `--repo <next-arg>`: /proc NUL next-arg
  // and CIM double-quoted next-arg both attributed to this repo.
  check("matcher: spaced /proc exact next-arg attributed",
    isLiveRunForRepo(procCmd("node", "/x/autopilot.mjs", "run", "--repo", SPACE_REPO), ELSEWHERE, SPACE_REPO, rpOpts) === true);
  check("matcher: spaced CIM quoted next-arg attributed",
    isLiveRunForRepo(`node C:\\x\\autopilot.mjs run --repo "${SPACE_REPO}"`, ELSEWHERE, SPACE_REPO, rpOpts) === true);
  {
    const spTable = new Map([
      [303, { cmd: procCmd("node", "/x/autopilot.mjs", "run", "--repo", SPACE_REPO), cwd: ELSEWHERE }],
    ]);
    const spReaders = makeReaders({ table: spTable });
    check("scan: spaced /proc exact next-arg attributed",
      findRepoLiveRuns(SPACE_REPO, { ...spReaders, selfPid: -1, platform: "linux", realpathSync: fakeRealpath }).includes(303));
    const cqTable = new Map([
      [304, { cmd: `node C:\\x\\autopilot.mjs run --repo "${SPACE_REPO}"`, cwd: ELSEWHERE }],
    ]);
    const cqReaders = makeReaders({ table: cqTable });
    check("scan: spaced CIM quoted next-arg attributed",
      findRepoLiveRuns(SPACE_REPO, { ...cqReaders, selfPid: -1, platform: "win32", realpathSync: fakeRealpath }).includes(304));
  }

  // Own pid excluded even when it is the sole match (both platforms).
  {
    const { readCmdline, readCwd } = makeReaders();
    check("scan: sole matching own pid excluded (linux)",
      findRepoLiveRuns(REPO, { listPids: () => [105], readCmdline, readCwd, selfPid: 105, platform: "linux", realpathSync: fakeRealpath }).length === 0);
    const cimOwn = new Map([
      [305, { cmd: `node C:\\x\\autopilot.mjs run --repo ${REPO}`, cwd: ELSEWHERE }],
    ]);
    const cimOwnReaders = makeReaders({ table: cimOwn });
    check("scan: sole matching own pid excluded (win32)",
      findRepoLiveRuns(REPO, { ...cimOwnReaders, selfPid: 305, platform: "win32", realpathSync: fakeRealpath }).length === 0);
  }

  // Non-run command tokens ignored even with --repo pointing here.
  {
    const tokTable = new Map([
      [306, { cmd: procCmd("node", "/x/autopilot.mjs", "status", "--repo", REPO), cwd: ELSEWHERE }],
      [307, { cmd: procCmd("node", "/x/autopilot.mjs", "full", "--repo", REPO), cwd: ELSEWHERE }],
      [308, { cmd: procCmd("node", "/x/autopilot.mjs", "stop", "--repo", REPO), cwd: ELSEWHERE }],
      [309, { cmd: `node C:\\x\\autopilot.mjs status --repo ${REPO}`, cwd: ELSEWHERE }],
    ]);
    const tokReaders = makeReaders({ table: tokTable });
    const tokLinux = findRepoLiveRuns(REPO, { ...tokReaders, selfPid: -1, platform: "linux", realpathSync: fakeRealpath });
    check("scan: status token ignored", !tokLinux.includes(306), tokLinux);
    check("scan: full token ignored (scan matches run|resume|implement only)", !tokLinux.includes(307), tokLinux);
    check("scan: stop token ignored", !tokLinux.includes(308), tokLinux);
    const tokWin = findRepoLiveRuns(REPO, { ...tokReaders, selfPid: -1, platform: "win32", realpathSync: fakeRealpath });
    check("scan: cim status token ignored", !tokWin.includes(309), tokWin);
  }
}

console.log(`\n${ok} passed, ${failed} failed`);
if(failed) process.exit(1);
