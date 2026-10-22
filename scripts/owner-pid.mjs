// Owner PID file (mission 041, Phase 1 task 1.1).
//
// A repo-scoped liveness marker: `<repo>/.autopilot/owner.pid`, written by a
// `run`/`resume`/`implement`/`full` process at start and removed when it exits.
// `stopLivePid()` (task 1.3) checks it first, before the /proc and CIM scans.
//
// This logic lives here — not inline in `scripts/autopilot.mjs` — because that
// module executes its CLI `main()` at import, so no unit test can import
// helpers from it. `autopilot.mjs` imports and re-exports these five helpers,
// which is the wiring task 1.3 builds on.
//
// Verification rule (same repo rule as `missionControlLiveRun` in
// `autopilot.mjs`): PID alive, writer platform matches reader platform, and
// the process cmdline runs `autopilot.mjs run|resume|implement|full` with THIS
// repo given as `--repo <repo>` OR as the process cwd (realpath-normalized).
// When the process cwd cannot be read (native Windows/CIM has no /proc), the
// repo check is satisfied by the PID file's own repo-scoped location: PID
// alive + same platform + autopilot.mjs run|resume|implement|full = live.
//
// `verifyOwnerPid()` NEVER deletes the file itself. A `false` result splits
// two ways for the caller: cross-platform mismatch (reader platform !== writer
// platform) must fall through WITHOUT deletion; same-platform dead-PID or
// cmdline mismatch is stale and the caller removes it via `removeOwnerPid()`.
// An `"unknown"` result (win32, cmdline unreadable) must ALSO fall through
// without deletion — and must NOT be treated as live either. Compare with
// `=== true` / `=== "unknown"`, never by truthiness.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {atomicWriteFileSync} from "./atomic-state-write.mjs";

// Commands that own the PID file. Note `full` is included: the /proc and CIM
// scans in `autopilot.mjs` predate it and match only run|resume|implement.
const OWNER_COMMANDS = "(?:run|resume|implement|full)";

// One token of an owner command in either cmdline encoding: NUL-separated
// (Linux /proc `<pid>/cmdline`) or space-separated (Windows CIM
// `Win32_Process.CommandLine`). `\x00` is written explicitly rather than `\0`
// so the intent survives any strict-mode reading of the escape.
const OWNER_COMMAND_TOKEN = new RegExp(`(?:^|[\\x00\\s])${OWNER_COMMANDS}(?:[\\x00\\s]|$)`);

// The `--repo <path>` value out of either cmdline encoding (NUL-separated
// /proc argv or space-separated CIM text, where paths with spaces arrive
// double-quoted). Null when the flag is absent (run from inside the repo).
function cmdlineRepoValue(cmd){
  const tokens=[];
  const re=/"([^"]*)"|(\S+)/g;
  let m;
  const norm=String(cmd).replace(/\x00/g," ");
  while((m=re.exec(norm))) tokens.push(m[1]!==undefined?m[1]:m[2]);
  for(let i=0;i<tokens.length;i++){
    if(tokens[i]==="--repo"&&i+1<tokens.length) return tokens[i+1];
    if(tokens[i].startsWith("--repo=")) return tokens[i].slice("--repo=".length);
  }
  return null;
}

// Repo-scoped PID file location. Pure string mapping, like `siblingTempPath`.
export function ownerPidPath(repo){
  return path.join(repo,".autopilot","owner.pid");
}

// Default PID liveness: same rule as `pidAlive()` in `autopilot.mjs` (a Linux
// zombie reads as dead; EPERM reads as alive). Exported so tests can use the
// real check deterministically against their own pid.
export function ownerPidAlive(pid){
  if(!Number.isInteger(pid)||pid<=0) return false;
  if(process.platform!=="win32"){
    try{
      const stat=fs.readFileSync(`/proc/${pid}/stat`,"utf8");
      const state=stat.slice(stat.lastIndexOf(")")+1).trim().split(/\s+/)[0];
      if(state==="Z") return false;
    }catch{ /* no /proc entry here: fall through to kill(0) */ }
  }
  try{ process.kill(pid,0); return true; }
  catch(e){ return e?.code==="EPERM"; }
}

// Default cmdline reader: /proc text on POSIX, single-pid CIM query on
// native Windows (/proc is absent there — a bare /proc read would return
// null for every live run and let callers delete a live claim as stale).
// Never throws; returns string|null. Accepts the reader platform as an
// optional second argument so tests can exercise the Windows path on any
// host (production callers pass nothing and the host platform applies).
function defaultReadCmdline(pid,platform){
  const readerPlatform=platform??process.platform;
  if(readerPlatform==="win32") return defaultReadCmdlineWindows(pid);
  try{ return fs.readFileSync(`/proc/${pid}/cmdline`,"utf8"); }
  catch{ return null; }
}

// Native Windows cmdline for one pid via CIM (same query style as
// `cimLiveRun` in `autopilot.mjs`, narrowed with -Filter to the single
// pid). Best-effort: null when PowerShell/CIM is unavailable or the pid
// is gone. Never throws.
function defaultReadCmdlineWindows(pid){
  if(!Number.isInteger(pid)||pid<=0) return null;
  try{
    const r=spawnSync("powershell",["-NoProfile","-Command",
      `((Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine)`],
      {encoding:"utf8",shell:false,timeout:15000});
    if(!r||r.status!==0) return null;
    const out=(r.stdout||"").trim();
    return out||null;
  }catch{ return null; }
}

// Default cwd reader. THROWS when unreadable (absent /proc on Windows, ESRCH,
// EPERM) — the throw is the signal `verifyOwnerPid` treats as "cwd cannot be
// read", i.e. the Windows/CIM case that falls back to repo-scoped liveness.
function defaultReadCwd(pid){
  return fs.readlinkSync(`/proc/${pid}/cwd`);
}

// Atomically write `{pid, platform, wslDistro?}` for `pid` in `repo`.
// `wslDistro` is recorded only when known (WSL_DISTRO_NAME set); it is
// informational — verification matches on `platform` only.
export function writeOwnerPid(pid,repo,opts={}){
  if(!Number.isInteger(pid)||pid<=0){
    throw new TypeError(`writeOwnerPid requires a positive integer pid, received ${String(pid)}`);
  }
  const platform=opts.platform??process.platform;
  const record={pid,platform};
  const distro=opts.wslDistro??process.env.WSL_DISTRO_NAME??null;
  if(distro) record.wslDistro=distro;
  atomicWriteFileSync(ownerPidPath(repo),JSON.stringify(record));
  return record;
}

// Parsed PID-file object, or null when the file is missing, unreadable, or
// not a JSON object. A present-but-shape-wrong object is returned as-is;
// `verifyOwnerPid` judges it (missing/non-integer pid ⇒ false).
export function readOwnerPid(repo){
  let raw;
  try{ raw=fs.readFileSync(ownerPidPath(repo),"utf8"); }
  catch{ return null; }
  try{
    const obj=JSON.parse(raw);
    if(!obj||typeof obj!=="object"||Array.isArray(obj)) return null;
    return obj;
  }catch{ return null; }
}

// True only for a verified-live owner: PID alive, writer platform matches the
// reader platform, and the cmdline runs `autopilot.mjs run|resume|implement|
// full` attributed to `repo` via `--repo` (realpath-normalized, same rule as
// `missionControlLiveRun`) or via process cwd — or, when the cwd cannot be
// read, via the PID file's repo-scoped location alone.
//
// Windows/unreadable-cmdline verdict: when the reader platform is win32 and
// the cmdline cannot be read (CIM unavailable), returns the string
// `"unknown"` — NOT false. Callers must treat `"unknown"` as neither live
// nor stale: fall through to the /proc+CIM scans WITHOUT deleting the file
// (a live run's claim must never be deleted on an unreadable cmdline). On
// POSIX an unreadable cmdline for an alive pid is a stale-shaped record and
// stays false. `verifyOwnerPid(...) === true` is live, `=== false` is
// not-live (stale-eligible when same-platform), `=== "unknown"` is
// do-not-delete. Only `=== true` means live — never truthiness-test the
// result, since `"unknown"` is truthy.
//
// Injectable seams (production callers omit all of them): `platform` (reader
// platform, default `process.platform`), `isAlive(pid)`, `readCmdline(pid)`
// (string|null), `readCwd(pid)` (string, or throws when unreadable). The seams
// exist because ES module bindings cannot be monkey-patched across module
// boundaries — tests inject a Windows-style cmdline/cwd provider instead.
// The default `readCmdline` receives `(pid, readerPlatform)` so it can take
// the CIM path when the simulated reader is win32.
export function verifyOwnerPid(pidObj,repo,opts={}){
  if(!pidObj||typeof pidObj!=="object") return false;
  const pid=pidObj.pid;
  if(!Number.isInteger(pid)||pid<=0) return false;
  // Cross-platform mismatch is never live AND never stale: the caller must
  // fall through to the /proc+CIM scans without deleting the file.
  const readerPlatform=opts.platform??process.platform;
  if(pidObj.platform!==readerPlatform) return false;
  const isAlive=opts.isAlive??ownerPidAlive;
  let alive=false;
  try{ alive=isAlive(pid); }catch{ alive=false; }
  if(!alive) return false;
  const readCmdline=opts.readCmdline??defaultReadCmdline;
  let cmd=null;
  try{ cmd=readCmdline(pid,readerPlatform); }catch{ cmd=null; }
  if(typeof cmd!=="string"||!cmd){
    // Native Windows without a readable cmdline (CIM unavailable): the claim
    // cannot be verified either way. Report "unknown" so callers fall
    // through WITHOUT deleting a possibly-live run's PID file. POSIX keeps
    // false: /proc should be readable there, so null is stale-shaped.
    if(readerPlatform==="win32") return "unknown";
    return false;
  }
  if(!cmd.includes("autopilot.mjs")) return false;
  if(!OWNER_COMMAND_TOKEN.test(cmd)) return false;
  let resolvedRepo=null;
  try{ resolvedRepo=fs.realpathSync(repo); }catch{ resolvedRepo=repo; }
  if(cmd.includes(repo)||(resolvedRepo&&cmd.includes(resolvedRepo))) return true;
  // The writer may spell the repo through a symlink the reader resolved (or
  // vice versa), which the substring check above misses. Compare the --repo
  // value itself realpath-normalized on both sides before falling back to cwd.
  const writerRepo=cmdlineRepoValue(cmd);
  if(writerRepo){
    if(writerRepo===repo||writerRepo===resolvedRepo) return true;
    try{
      const resolvedWriter=fs.realpathSync(writerRepo);
      if(resolvedWriter===repo||resolvedWriter===resolvedRepo) return true;
    }catch{ /* writer path gone: fall through to the cwd check */ }
  }
  const readCwd=opts.readCwd??defaultReadCwd;
  let cwd=null;
  let cwdReadable=true;
  try{ cwd=readCwd(pid); }catch{ cwdReadable=false; }
  if(!cwdReadable||typeof cwd!=="string"||!cwd){
    // Cwd cannot be read (Windows/CIM): the PID file is itself scoped to this
    // repo, so alive + same platform + owner command = live.
    return true;
  }
  return cwd===repo||(resolvedRepo!=null&&cwd===resolvedRepo);
}

// Idempotent removal. With `{ifPid}` only the file recording that exact pid
// is removed (a refusing second run must not delete the first run's file);
// returns true when a file was removed, false when kept or already absent.
// Never throws for a missing file.
export function removeOwnerPid(repo,opts={}){
  const wanted=opts.ifPid;
  if(wanted!==undefined&&wanted!==null){
    const cur=readOwnerPid(repo);
    if(!cur||cur.pid!==wanted) return false;
  }
  try{
    fs.rmSync(ownerPidPath(repo),{force:true});
    return true;
  }catch{ return false; }
}

// ---------------------------------------------------------------------------
// Mission 064 Phase 1 task 1.1: repo-scoped live-scan helpers.
//
// `parseLiveScanRepoValue` is the scan's OWN `--repo` parser (deliberately
// separate from `cmdlineRepoValue` above, which stays byte-unchanged): for
// NUL-separated /proc cmdlines it splits on `\x00` and takes the element
// after an exact `--repo` element; for CIM text (no NULs) it uses
// quote-aware whitespace splitting and the same exact-match rule. Both
// paths mirror `autopilot.mjs:75` (`process.argv.indexOf("--repo")`): a
// `--repo=<path>` token counts as ABSENT, and a value-less trailing
// `--repo` (no next element) counts as ABSENT (null).
//
// `isLiveRunForRepo(cmd,cwd,repo)` is the per-process repo attribution:
// `--repo` value realpath-compared on both sides (relative values resolved
// against the target cwd when readable, else undeterminable ⇒ false), else
// the target cwd realpath-compared; undeterminable (unreadable cwd with no
// absolute `--repo`) ⇒ false. Pure string/equality logic — never substring
// `includes` — so `<repo>-other` prefix siblings and script-path
// containment do not attribute. Never touches real processes; the only
// filesystem touch is the injectable `realpathSync` (default
// `fs.realpathSync`, best-effort with identity fallback).
//
// `findRepoLiveRuns(repo,{listPids,readCmdline,readCwd,selfPid,platform,
// realpathSync})` owns the scan loop: it applies the `autopilot.mjs`
// cmdline filter on the /proc path plus the per-platform
// run|resume|implement token filter, then delegates repo attribution to
// `isLiveRunForRepo`. All I/O is injected; defaults never touch real
// processes (empty pid list, null cmdline, throwing cwd).
function liveScanIsAbsolute(p){
  if(typeof p!=="string"||!p) return false;
  try{ if(path.isAbsolute(p)) return true; }catch{ /* fall through */ }
  try{ if(path.win32.isAbsolute(p)) return true; }catch{ /* fall through */ }
  return false;
}

function liveScanRealpath(p,realpathSync){
  try{ return realpathSync(p); }catch{ return p; }
}

// Own `--repo` parser for the live scan (see header). Returns the raw
// `--repo` value string, or null when absent (`--repo=` and value-less
// `--repo` count as absent).
export function parseLiveScanRepoValue(cmd){
  const s=String(cmd??"");
  if(!s) return null;
  if(s.includes("\x00")){
    const parts=s.split("\x00");
    for(let i=0;i<parts.length;i++){
      if(parts[i]==="--repo"){
        const next=parts[i+1];
        if(next!==undefined&&next!=="") return next;
        return null;
      }
    }
    return null;
  }
  const tokens=[];
  const re=/"([^"]*)"|(\S+)/g;
  let m;
  while((m=re.exec(s))) tokens.push(m[1]!==undefined?m[1]:m[2]);
  for(let i=0;i<tokens.length;i++){
    if(tokens[i]==="--repo"){
      if(i+1<tokens.length) return tokens[i+1];
      return null;
    }
  }
  return null;
}

// Per-process repo attribution. `cmd` is the raw cmdline (NUL-separated
// /proc text or CIM text), `cwd` is the already-read target cwd string or
// null/undefined when unreadable, `repo` is the target repo path.
// `opts.realpathSync` defaults to `fs.realpathSync`. Returns boolean.
export function isLiveRunForRepo(cmd,cwd,repo,opts={}){
  if(typeof cmd!=="string"||!cmd) return false;
  if(typeof repo!=="string"||!repo) return false;
  const realpathSync=opts.realpathSync??fs.realpathSync;
  const resolvedRepo=liveScanRealpath(repo,realpathSync);
  const writerRepo=parseLiveScanRepoValue(cmd);
  if(writerRepo!==null&&writerRepo!==undefined){
    let candidate=writerRepo;
    if(!liveScanIsAbsolute(candidate)){
      if(typeof cwd!=="string"||!cwd) return false;
      candidate=path.resolve(cwd,candidate);
    }
    const resolvedCandidate=liveScanRealpath(candidate,realpathSync);
    return resolvedCandidate===repo||resolvedCandidate===resolvedRepo;
  }
  if(typeof cwd!=="string"||!cwd) return false;
  const resolvedCwd=liveScanRealpath(cwd,realpathSync);
  return resolvedCwd===repo||resolvedCwd===resolvedRepo;
}

// Pure scan loop over an injected process list. `listPids()` returns an
// array of pids; `readCmdline(pid)` returns string|null (never throws out);
// `readCwd(pid)` returns a string or throws when unreadable; `selfPid` is
// excluded; `platform` selects the token filter (`linux`/POSIX ⇒ NUL
// regex + `autopilot.mjs` cmdline filter, `win32` ⇒ whitespace regex).
// Returns the matching pids (first-match order preserved; caller decides
// first-match vs all-matches).
export function findRepoLiveRuns(repo,opts={}){
  const listPids=opts.listPids??(()=>[]);
  const readCmdline=opts.readCmdline??(()=>null);
  const readCwd=opts.readCwd??(()=>{ throw new Error("unreadable"); });
  const selfPid=opts.selfPid??process.pid;
  const platform=opts.platform??process.platform;
  const realpathSync=opts.realpathSync??fs.realpathSync;
  const isProc=platform!=="win32";
  let pids=[];
  try{ pids=listPids()??[]; }catch{ return []; }
  const found=[];
  for(const pid of pids){
    if(pid===selfPid) continue;
    if(!Number.isInteger(pid)) continue;
    let cmd=null;
    try{ cmd=readCmdline(pid); }catch{ continue; }
    if(typeof cmd!=="string"||!cmd) continue;
    if(isProc){
      if(!cmd.includes("autopilot.mjs")) continue;
      if(!/(?:^|\0)(?:run|resume|implement)(?:\0|$)/.test(cmd)) continue;
    }else{
      if(!cmd.includes("autopilot.mjs")) continue;
      if(!/(?:^|\s)(?:run|resume|implement)(?:\s|$)/.test(cmd)) continue;
    }
    let cwd=null;
    try{
      const raw=readCwd(pid);
      if(typeof raw==="string"&&raw) cwd=raw;
      else cwd=null;
    }catch{ cwd=null; }
    let match=false;
    try{ match=isLiveRunForRepo(cmd,cwd,repo,{realpathSync}); }catch{ continue; }
    if(match) found.push(pid);
  }
  return found;
}
