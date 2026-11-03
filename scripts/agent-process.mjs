import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// npm-generated .cmd/.bat shims invoke the real binary via an embedded path,
// e.g.  "%dp0%\node_modules\opencode-ai\bin\opencode.exe"  %*
// Resolve that target so we can run the executable directly instead of
// bouncing through cmd.exe, which cannot use a UNC cwd (e.g. \\wsl$\...).
function shimTarget(binary){
  if(!/\.(cmd|bat)$/i.test(binary)) return null;
  try{
    const content=fs.readFileSync(binary,'utf8');
    const m=content.match(/(?:"|')?([^"'\r\n]*node_modules[^"'\r\n]*\.(?:exe|com))(?:"|')?/i);
    if(!m) return null;
    let target=m[1].replace(/%dp0%/gi,path.dirname(binary)).replace(/%\w+%/g,'').replace(/\\/g,path.sep);
    if(!path.isAbsolute(target)) target=path.join(path.dirname(binary),target);
    if(fs.existsSync(target)) return target;
  }catch{}
  return null;
}

// Returns {launcher, target}: `launcher` is the actual file where.exe found
// (an .exe/.com, or an npm .cmd/.bat shim); `target` is what should actually
// be spawned — the shim's resolved executable when `launcher` is a shim with
// a resolvable target, otherwise `launcher` itself. Both are reported so the
// resolution cache can later re-verify a shim still points at the same
// target (see resolveAgentBinary below) without re-spawning where.exe.
function resolveWindowsBinary(binary){
  const directCandidates=[`${binary}.exe`,`${binary}.com`,`${binary}.cmd`,`${binary}.bat`,binary];
  const found=[];
  const collect=candidates=>{
    for(const c of candidates){
      __resolveCacheTestHooks.probeCount++;
      const check=spawnSync('where.exe',[c],{encoding:'utf8',stdio:['ignore','pipe','ignore'],shell:false});
      if(check.status===0){
        found.push(...String(check.stdout||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean));
      }
    }
  };
  collect([binary,...directCandidates]);
  const score=p=>/\.(exe|com)$/i.test(p)?0:/\.(cmd|bat)$/i.test(p)?1:2;
  const seen=new Set();
  const candidates=[];
  for(const p of found){ if(!seen.has(p)){ seen.add(p); candidates.push(p); } }
  // Rank resolved real executables ahead of their shims so the process runs
  // with the caller's cwd preserved even when it is a UNC path.
  const sorted=candidates.map(p=>{
    const target=shimTarget(p);
    return {original:p,target:target||p,score:target?0:score(p)};
  });
  sorted.sort((a,b)=>a.score-b.score || String(a.original).localeCompare(String(b.original)));
  if(sorted.length) return {launcher:sorted[0].original,target:sorted[0].target};
  return {launcher:binary,target:binary};
}

// POSIX has no shim indirection here — `which` resolves directly to the
// binary that would run, so launcher and target are the same path.
function resolveAgentBinaryPosix(binary){
  __resolveCacheTestHooks.probeCount++;
  const r=spawnSync('which',[binary],{encoding:'utf8',stdio:['ignore','pipe','ignore'],shell:false});
  if(r.status===0){
    const first=String(r.stdout||'').split(/\r?\n/).map(s=>s.trim()).find(Boolean);
    if(first) return {launcher:first,target:first};
  }
  return {launcher:binary,target:binary};
}

// Per-process resolution cache (Windows E2E shared-latency fix): resolution
// re-invokes where.exe (up to 6 subprocess spawns) or which (1 spawn) on
// EVERY call, even though the answer cannot legitimately change within one
// `ap run` process unless PATH, PATHEXT, or the current working directory
// themselves change mid-process — the only three inputs this resolution
// depends on (no per-call env/options are consulted anywhere above).
// Measured at ~27.5% of a representative Windows mission's wall-clock time,
// purely from redoing identical work on every role invocation (see the
// Windows-E2E-shared-latency diagnosis this fixes).
//
// This is a PATH-RESOLUTION cache, not a binary-trust/identity cache: it
// only remembers where a name currently resolves to, and re-derives that
// on every hit cheaply enough (local fs checks, no subprocess) that a
// changed answer is never silently served stale. It makes no claim about
// the resolved file's identity, contents, or trustworthiness beyond "this
// is the path where.exe/which would currently report".
//
// Cache key is built from binary + PATH + PATHEXT + cwd via JSON.stringify
// of a 4-element array (never raw string concatenation, which could
// collide or embed control bytes) — a deliberate change to any of the four
// during the process's lifetime is observed as a cache miss and triggers a
// fresh resolution — never served a stale answer computed before the
// change.
//
// Only a SUCCESSFUL resolution (a real candidate was actually found,
// distinct from the raw `binary` argument returned as a not-found
// fallback) is ever cached — a lookup that found nothing is never cached,
// so a binary that becomes available later in the same process (installed,
// or PATH corrected) is resolved fresh on its very next call rather than
// being permanently remembered as "missing".
//
// Every cache HIT re-verifies, with cheap local fs calls only (no
// subprocess spawn), that:
//   1. the launcher (the file where.exe/which actually found) still exists,
//   2. the target (what would be spawned) still exists, and
//   3. when the launcher is an npm .cmd/.bat shim, re-reading it still
//      resolves to the same target — so a shim whose content was rewritten
//      to point somewhere else (retargeted) is detected and the entry is
//      evicted, never served stale.
// Any of these failing evicts the entry and falls through to a full,
// fresh resolution.
const resolveCache=new Map();
function resolveCacheKey(binary){
  return JSON.stringify([binary,process.env.PATH||'',process.env.PATHEXT||'',process.cwd()]);
}
function isCacheEntryFresh(entry){
  let launcherExists=false,targetExists=false;
  try{ launcherExists=fs.existsSync(entry.launcher); }catch{}
  if(!launcherExists) return false;
  try{ targetExists=fs.existsSync(entry.target); }catch{}
  if(!targetExists) return false;
  if(/\.(cmd|bat)$/i.test(entry.launcher)){
    const freshTarget=shimTarget(entry.launcher)||entry.launcher;
    if(freshTarget!==entry.target) return false;
  }
  return true;
}
// Test-only introspection — never read by any production code path. Lets
// tests assert a cache hit genuinely avoided a real where.exe/which spawn
// (not merely that the returned value happened to match), and lets each
// test start from a clean cache with no cross-test leakage.
export const __resolveCacheTestHooks={
  probeCount:0,
  resetForTests(){ resolveCache.clear(); this.probeCount=0; }
};

export function resolveAgentBinary(binary){
  const key=resolveCacheKey(binary);
  const cached=resolveCache.get(key);
  if(cached!==undefined){
    if(isCacheEntryFresh(cached)) return cached.target;
    resolveCache.delete(key);
  }
  const {launcher,target}=process.platform==='win32'?resolveWindowsBinary(binary):resolveAgentBinaryPosix(binary);
  if(target!==binary) resolveCache.set(key,{launcher,target});
  return target;
}

function quoteCmdArg(arg){
  const s=String(arg);
  if(!/[\s"&|<>^()%!]/.test(s)) return s;
  return '"'+s.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';
}

function winShimInvocation(binary,args){
  const ext=/\.(cmd|bat)$/i.test(binary);
  if(!ext) return null;
  const comspec=process.env.ComSpec||process.env.COMSPEC||'C:\\Windows\\System32\\cmd.exe';
  const command=[binary,...args].map(quoteCmdArg).join(' ');
  return {bin:comspec,args:['/d','/s','/c',command]};
}

export function spawnAgentSync(binary,args,opts={}){
  const resolved=resolveAgentBinary(binary);
  const shim=process.platform==='win32'?winShimInvocation(resolved,args):null;
  if(shim) return spawnSync(shim.bin,shim.args,{...opts,shell:false});
  return spawnSync(resolved,args,{...opts,shell:false});
}

export function spawnAgent(binary,args,opts={}){
  const resolved=resolveAgentBinary(binary);
  const shim=process.platform==='win32'?winShimInvocation(resolved,args):null;
  if(shim) return spawn(shim.bin,shim.args,{...opts,shell:false});
  return spawn(resolved,args,{...opts,shell:false});
}

// Codex npm-layout resolution: when `codex` resolves to the npm launcher
// `.../@openai/codex/bin/codex.js`, the native binary + its siblings live
// in a platform package under <pkg>/node_modules/@openai/codex-<platform>-<arch>/
// (or <pkg>/vendor/<triple>/bin/ for older layouts). Return that native path;
// otherwise return the original resolved path unchanged.
const CODEX_PLATFORM_PACKAGE = {
  linux: { x64: "codex-linux-x64", arm64: "codex-linux-arm64" },
  darwin: { x64: "codex-darwin-x64", arm64: "codex-darwin-arm64" },
  win32: { x64: "codex-win32-x64", arm64: "codex-win32-arm64" },
};
const CODEX_TARGET_TRIPLE = {
  linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
  darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
};

function codexBinaryName() {
  return process.platform === "win32" ? "codex.exe" : "codex";
}

function findCodexNativeBinary(pkgRoot) {
  const binaryName = codexBinaryName();
  const expectedTriple = (CODEX_TARGET_TRIPLE[process.platform] || {})[process.arch] || null;
  const roots = new Set();
  const platformPkg = (CODEX_PLATFORM_PACKAGE[process.platform] || {})[process.arch];
  if (platformPkg) roots.add(path.join(pkgRoot, "node_modules", "@openai", platformPkg));
  try {
    const scopeDir = path.join(pkgRoot, "node_modules", "@openai");
    if (fs.existsSync(scopeDir)) {
      for (const entry of fs.readdirSync(scopeDir)) {
        if (entry.startsWith("codex-") && entry !== "codex") {
          roots.add(path.join(scopeDir, entry));
        }
      }
    }
  } catch {}
  const candidates = [];
  for (const root of roots) {
    const vendorDir = path.join(root, "vendor");
    if (!fs.existsSync(vendorDir)) continue;
    let triples = [];
    try { triples = fs.readdirSync(vendorDir); } catch {}
    for (const triple of triples) {
      const cand = path.join(vendorDir, triple, "bin", binaryName);
      if (fs.existsSync(cand)) candidates.push({ path: cand, triple });
    }
  }
  // older layouts: <pkg>/vendor/<triple>/bin/codex
  const oldVendor = path.join(pkgRoot, "vendor");
  if (fs.existsSync(oldVendor)) {
    let triples = [];
    try { triples = fs.readdirSync(oldVendor); } catch {}
    for (const triple of triples) {
      const cand = path.join(oldVendor, triple, "bin", binaryName);
      if (fs.existsSync(cand)) candidates.push({ path: cand, triple });
    }
  }
  if (candidates.length === 0) return null;
  if (expectedTriple) {
    const preferred = candidates.find(c => c.triple === expectedTriple);
    if (preferred) return preferred.path;
  }
  return candidates[0].path;
}

export function resolveCodexNativeBinary(binary) {
  const resolved = resolveAgentBinary(binary);
  let realPath;
  try { realPath = fs.realpathSync(resolved); } catch { return resolved; }
  if (path.basename(realPath) !== "codex.js") return resolved;
  const pkgRoot = path.resolve(path.dirname(realPath), "..");
  const native = findCodexNativeBinary(pkgRoot);
  if (native) {
    try { return fs.realpathSync(native); } catch { return native; }
  }
  return resolved;
}
