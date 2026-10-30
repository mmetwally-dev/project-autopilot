import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";

function run(bin,args,{cwd,encoding="utf8",input,env}={}){
  return spawnSync(bin,args,{cwd,encoding,input,env,stdio:"pipe",shell:false,maxBuffer:256*1024*1024});
}

export function gitExecutable(){
  const probe=process.platform==="win32"
    ? run("where.exe",["git"],{cwd:process.cwd()})
    : run("which",["git"],{cwd:process.cwd()});
  const first=(probe.stdout||"").split(/\r?\n/).map(x=>x.trim()).find(Boolean);
  return first||"git";
}

function hashBytes(data){return crypto.createHash("sha256").update(data).digest("hex");}

function gitOut(cwd,args){
  const r=run("git",args,{cwd});
  if(r.status!==0) throw new Error((r.stderr||r.stdout||"git failed").toString().trim());
  return r.stdout||Buffer.alloc(0);
}

// Same fail-closed contract as gitOut (a spawn error or an exit code outside
// allowedStatuses throws), but lets a caller name specific non-zero exits
// that are a legitimate, documented state rather than a failure — e.g. `git
// symbolic-ref -q HEAD` exiting 1 on a detached HEAD, or `git config --system
// --list` exiting 1 when no system config file exists.
function gitOutAllowing(cwd,args,allowedStatuses){
  const r=run("git",args,{cwd});
  if(!allowedStatuses.includes(r.status)) throw new Error((r.stderr||r.stdout||"git failed").toString().trim());
  return {status:r.status,stdout:r.stdout||Buffer.alloc(0)};
}

// A co-resident coding tool's own per-turn bookkeeping namespace: Codex CLI
// writes refs/codex/turn-diffs/** (plus loose objects) as its own undo/diff
// tracking, unrelated to any git mutation a worker or human would perform
// (confirmed via git for-each-ref in this checkout). Extend this list only if
// another co-resident tool is found doing the same thing; never widen it to a
// pattern broader than an exact prefix match.
// Residual risk (accepted): a worker could deliberately create a ref under
// refs/codex/... to evade this guard. That hole is much narrower than the one
// closed by the object-count check (the worker must know and target this one
// excluded namespace) and is the same class of trust decision as accepting a
// co-resident tool in the checkout at all.
export const IGNORED_REF_NAMESPACES = ["refs/codex/"];

function isIgnoredRefName(name){
  return IGNORED_REF_NAMESPACES.some(prefix=>name.startsWith(prefix));
}

function reflogFilesDigest(gitDir){
  const entries=[];
  const record=(label,file)=>{
    try{entries.push(`${label}:${hashBytes(fs.readFileSync(file))}`);}
    catch(error){
      if(error.code==="ENOENT"){entries.push(`${label}:ABSENT`);return;}
      throw error;
    }
  };
  record("HEAD",path.join(gitDir,"logs","HEAD"));
  const refsLogRoot=path.join(gitDir,"logs","refs");
  for(const relative of walkFilesRelative(refsLogRoot)){
    const label=`refs/${relative}`;
    if(isIgnoredRefName(label.split(path.sep).join("/"))) continue;
    record(label,path.join(refsLogRoot,relative));
  }
  return entries.sort().join("\n");
}

function walkFilesRelative(root){
  const results=[];
  const stack=[""];
  while(stack.length){
    const relativeDir=stack.pop();
    let entries;
    try{entries=fs.readdirSync(path.join(root,relativeDir),{withFileTypes:true});}catch{continue;}
    for(const entry of entries){
      const relative=relativeDir?path.join(relativeDir,entry.name):entry.name;
      if(entry.isDirectory())stack.push(relative);
      else results.push(relative);
    }
  }
  return results;
}

function expandTilde(p){
  if(p.startsWith("~/")||p==="~") return path.join(os.homedir(),p.slice(1));
  return p;
}

// Resolve a core.hooksPath value using Git's own pathname expansion.
// `git config --path <key>` handles ~, ~/..., and ~user/... expansion plus
// normalisation, which avoids reimplementing Git's user-database lookup.
// Falls back to expandTilde + path.resolve when --path is unavailable
// (Git < 2.31) or when the command fails for an unexpected reason.
function resolveGitPath(cwd,key){
  const r=run("git",["config","--path",key],{cwd});
  if(r.status===0){
    const resolved=(r.stdout||"").toString().trim();
    if(resolved) return resolved;
  }
  return null;
}

// Parse `git status --porcelain=v1 -z` output into entries. The -z form
// never quotes, so paths with spaces or non-ASCII bytes stay literal and
// compare directly against the -z `--name-only` dirty set (the non -z form
// would quote them — `"sp ace.txt"`, `"\303\251.txt"` — and a slice(3)
// comparison would never match, silently dropping real edits). A
// rename/copy entry spans TWO NUL-terminated tokens (`XY <to>` plus the
// bare `<from>` path); it is grouped into one entry so the pair is
// kept/dropped as a unit. Tokens without a leading `XY ` entry (only
// possible outside a consumed rename continuation) are returned with
// xy:null so the caller keeps them rather than dropping evidence.
export function parsePorcelainV1ZEntries(statusStdout){
  const entries=[];
  const tokens=String(statusStdout||"").split("\0");
  for(let i=0;i<tokens.length;i++){
    const tok=tokens[i];
    if(tok==="") continue;
    const m=/^(..) (.*)$/s.exec(tok);
    if(!m){ entries.push({xy:null,paths:[tok],toPath:tok,fromPath:null,raw:tok}); continue; }
    const xy=m[1];
    const toPath=m[2];
    let fromPath=null;
    if((xy[0]==="R"||xy[0]==="C"||xy[1]==="R"||xy[1]==="C")&&i+1<tokens.length&&tokens[i+1]!==""){
      fromPath=tokens[i+1];
      i++;
    }
    entries.push({xy,paths:fromPath!==null?[toPath,fromPath]:[toPath],toPath,fromPath});
  }
  return entries;
}

// EOL-phantom keep predicate for a parsed status entry. Untracked/ignored
// entries (`??`, `!!`) are never in the diff-HEAD set and are always kept;
// unparsed entries (xy:null) are kept fail-open so no evidence is dropped.
// A tracked entry is kept only when one of its paths is in the
// `git diff --ignore-cr-at-eol --name-only -z HEAD` dirty set; otherwise it
// is a CRLF-only phantom.
export function keepEntryAfterEolFilter(entry,eolDirtySet){
  if(entry.xy==="??"||entry.xy==="!!") return true;
  if(entry.xy===null||entry.xy===undefined) return true;
  return entry.paths.some(p=>eolDirtySet.has(p));
}

// Batch bounds for the limited diffs: keep every git invocation's argv well
// under the OS limit (~128 KB on Windows, more elsewhere) even with very long
// paths. Both are soft limits; a rename pair may push a batch one path over.
const SNAPSHOT_DIFF_PATHS_PER_BATCH=200;
const SNAPSHOT_DIFF_ARG_BYTES_PER_BATCH=30*1024;

function compareSnapshotPaths(a,b){
  // Git emits changed paths in byte order, not UTF-16 code-unit order.
  return Buffer.compare(Buffer.from(a,"utf8"),Buffer.from(b,"utf8"));
}

// Derive the tracked paths whose diff could contribute to the snapshot from
// `git status`: every entry that is not untracked (`??`) or ignored (`!!`),
// including both sides of a rename/copy. Root-level `.autopilot/` paths are
// excluded because the binary diff already excludes them via pathspec.
// A rename/copy pair must travel in one batch or the pair would degrade into
// separate delete+add hunks. Git sorts a pair at its NEW path, so the pair is
// anchored there (see snapshotDiffBatches) while its old path waits.
function snapshotDiffCandidates(entries){
  const candidates=new Set();
  const pairs=[];
  for(const entry of entries){
    if(entry.xy==="??"||entry.xy==="!!") continue;
    if(entry.xy===null||entry.xy===undefined) continue;
    const included=[];
    for(const p of entry.paths){
      if(String(p).startsWith(".autopilot/")) continue;
      candidates.add(p);
      included.push(p);
    }
    if(entry.fromPath!==null&&entry.fromPath!==undefined&&included.length===2){
      pairs.push([entry.toPath,entry.fromPath]);
    }
  }
  const pairFromByTo=new Map();
  const renameSources=new Set();
  for(const [to,from] of pairs){
    pairFromByTo.set(to,from);
    renameSources.add(from);
  }
  return {
    candidatePaths:[...candidates].sort(compareSnapshotPaths),
    pairFromByTo,
    renameSources
  };
}

function snapshotDiffBatches(sortedPaths,pairFromByTo,renameSources){
  const batches=[];
  const assigned=new Set();
  let i=0;
  while(i<sortedPaths.length){
    const batch=[];
    let bytes=0;
    const add=(p)=>{
      if(assigned.has(p)) return;
      assigned.add(p);
      batch.push(p);
      // ":(literal)" prefix plus the separating space.
      bytes+=Buffer.byteLength(p,"utf8")+11;
    };
    while(i<sortedPaths.length&&batch.length<SNAPSHOT_DIFF_PATHS_PER_BATCH&&(batch.length===0||bytes<SNAPSHOT_DIFF_ARG_BYTES_PER_BATCH)){
      const p=sortedPaths[i++];
      if(assigned.has(p)) continue;
      // A rename source is added by its destination's batch, at the position
      // Git would emit the pair.
      if(renameSources.has(p)) continue;
      add(p);
      const from=pairFromByTo.get(p);
      if(from!==undefined) add(from);
    }
    if(batch.length) batches.push(batch);
  }
  return batches;
}

function eolNormalizedFileHash(file){
  try{
    const buf=fs.readFileSync(file);
    if(buf.includes(0)) return hashBytes(buf);
    if(!buf.includes(13)) return hashBytes(buf);
    const out=[];
    for(let i=0;i<buf.length;i++){
      if(buf[i]===13&&buf[i+1]===10) continue;
      out.push(buf[i]);
    }
    return hashBytes(Buffer.from(out));
  }catch{return "MISSING";}
}

function fileHash(file){
  try{return hashBytes(fs.readFileSync(file));}catch{return "MISSING";}
}

// Gap 3: this snapshot supports exactly one topology — a single, non-bare
// working tree, with no linked worktrees and no submodules. Each
// alternative silently degrades what the snapshot can see rather than
// erroring: a bare repository has no working tree for status/index
// observation; a linked worktree shares refs through a common dir this
// snapshot does not resolve (and a SIBLING linked worktree of the same
// repository could mutate a shared ref without ever touching this cwd at
// all); a submodule carries its own independent Git directory this
// snapshot never inspects. Fail closed (throw, matching gitOut's contract)
// on any of them rather than silently proving less than a caller assumes.
export function assertSupportedTopology(cwd){
  const bare=gitOut(cwd,["rev-parse","--is-bare-repository"]).toString().trim();
  if(bare!=="false") throw new Error(`Unsupported Git topology: bare repository at ${cwd}.`);
  const gitDir=path.resolve(cwd,gitOut(cwd,["rev-parse","--absolute-git-dir"]).toString().trim());
  const commonDir=path.resolve(cwd,gitOut(cwd,["rev-parse","--git-common-dir"]).toString().trim());
  if(commonDir!==gitDir) throw new Error(`Unsupported Git topology: linked worktree at ${cwd} (git-dir ${gitDir} != common-dir ${commonDir}).`);
  const worktreeCount=gitOut(cwd,["worktree","list","--porcelain"]).toString("utf8").split(/\r?\n/).filter(line=>line.startsWith("worktree ")).length;
  if(worktreeCount!==1) throw new Error(`Unsupported Git topology: ${worktreeCount} worktrees registered for ${cwd} — remove extra worktrees (git worktree list / git worktree remove <path>) and run \`ap run\`.`);
  const submodules=gitOut(cwd,["submodule","status"]).toString("utf8").trim();
  if(submodules!=="") throw new Error(`Unsupported Git topology: submodule(s) present at ${cwd}.`);
}

export function gitSnapshot(startCwd){
  assertSupportedTopology(startCwd);
  // Every command and file path below is repository-relative, so all git
  // calls must run with the repository TOP LEVEL as git's working directory.
  // A cwd that is a subdirectory — e.g. an adhoc run's output dir under an
  // IGNORED .autopilot/ — makes `git ls-files --others --ignored --directory
  // -- . :(exclude).autopilot/**` abort ("fatal: git ls-files: internal
  // error - directory entry not superset of prefix", exit 128) because the
  // prefix sits inside the wholly-ignored, excluded .autopilot directory
  // entry; the identical command from the top level exits 0. Resolve once
  // and use it for the whole snapshot.
  const cwd=gitOut(startCwd,["rev-parse","--show-toplevel"]).toString().trim()||startCwd;
  // `-q --verify` exits 1 (silently) on an unborn HEAD (no commits yet) —
  // a legitimate repository state, not a failure.
  const headRev=gitOutAllowing(cwd,["rev-parse","-q","--verify","HEAD"],[0,1]);
  const head=headRev.status===0?headRev.stdout.toString().trim():"UNBORN";
  // HEAD's symbolic target: for-each-ref never emits HEAD (it is not under
  // refs/), so without this a `git checkout --detach <same-commit>` is
  // invisible even though `head` above is unchanged. `-q` exits 1 (silently)
  // when HEAD is detached.
  const symbolicRef=gitOutAllowing(cwd,["symbolic-ref","-q","HEAD"],[0,1]);
  const headSymbolic=symbolicRef.status===0?symbolicRef.stdout.toString().trim():"DETACHED";
  const refs=gitOut(cwd,["for-each-ref","--format=%(refname)%00%(objectname)%00%(symref)"]).toString("utf8")
    .split("\n").filter(line=>!isIgnoredRefName(line.split("\0")[0])).join("\n");
  // Config across every scope a mutation could land in: --local alone misses
  // a --worktree write and, more importantly, a --global/--system write
  // (e.g. a core.hooksPath override) — a direct guard-evasion path that
  // never touches this repository's own .git/config at all.
  // --local/--worktree always resolve inside a real repository. A --global
  // or --system config file routinely does not exist at all (a bare
  // CI/sandbox HOME, no /etc/gitconfig) — Git reports that as exit 128
  // ("fatal: unable to read config file ... No such file or directory"),
  // not as some parseable "empty" signal. Both a genuinely absent file (128)
  // and an empty-but-present one (older Git: 1, empty stdout) are legitimate
  // states here, not failures — the exit status itself is folded into the
  // captured value so a file coming into/out of existence is still visible
  // even when its content is identically empty either way.
  const configAllowedStatuses={"--local":[0],"--worktree":[0,1],"--global":[0,1,128],"--system":[0,1,128]};
  const config={};
  for(const scope of ["--local","--worktree","--global","--system"]){
    const cfg=gitOutAllowing(cwd,["config",scope,"--list"],configAllowedStatuses[scope]);
    config[scope]=`${cfg.status}:${cfg.stdout.toString("utf8")}`;
  }
  const gitDir=gitOut(cwd,["rev-parse","--absolute-git-dir"]).toString().trim();
  // In-progress sequencer state (merge/cherry-pick/revert/rebase). Porcelain
  // status carries no header line for any of this.
  const sequencerMarkers=["MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD","REBASE_HEAD","BISECT_LOG","rebase-merge","rebase-apply"];
  const sequencer=sequencerMarkers.map(name=>`${name}=${fs.existsSync(path.join(gitDir,name))?"1":"0"}`).join(",");
  // Administrative/pseudo-refs that for-each-ref does not include. These
  // are created by operations like `git merge` (ORIG_HEAD, AUTO_MERGE),
  // `git fetch` (FETCH_HEAD), and sequencer operations. Content matters:
  // `git update-ref ORIG_HEAD HEAD` succeeds silently but changes the repo.
  // Recursively digest rebase-merge/rebase-apply directories because they
  // contain state files (msgnum, onto, head-name, etc.) that matter.
  const pseudoRefs=["ORIG_HEAD","FETCH_HEAD","AUTO_MERGE","MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD","REBASE_HEAD","BISECT_HEAD","BISECT_LOG"];
  const pseudoRefEntries=pseudoRefs.map(name=>{
    const full=path.join(gitDir,name);
    try{
      const st=fs.lstatSync(full);
      if(st.isDirectory()){
        // Recursively digest directory contents
        const files=walkFilesRelative(full);
        const digests=files.map(f=>`${f}:${hashBytes(fs.readFileSync(path.join(full,f)))}`);
        return `${name}:dir:${digests.sort().join(",")}`;
      }
      return `${name}:file:${hashBytes(fs.readFileSync(full))}:mode=${st.mode}`;
    }catch(error){
      if(error.code==="ENOENT") return `${name}:ABSENT`;
      return `${name}:ERROR:${error.code}`;
    }
  }).join("\n");
  // Also recursively digest rebase-merge and rebase-apply directories
  const rebaseDirs=["rebase-merge","rebase-apply"];
  const rebaseDirDigests=rebaseDirs.map(dirName=>{
    const dirPath=path.join(gitDir,dirName);
    try{
      const st=fs.lstatSync(dirPath);
      if(!st.isDirectory()) return `${dirName}:NOT_DIR`;
      const files=walkFilesRelative(dirPath);
      const digests=files.map(f=>`${f}:${hashBytes(fs.readFileSync(path.join(dirPath,f)))}`);
      return `${dirName}:${digests.sort().join(",")}`;
    }catch(error){
      if(error.code==="ENOENT") return `${dirName}:ABSENT`;
      return `${dirName}:ERROR:${error.code}`;
    }
  }).join("\n");
  const administrativeDigest=[pseudoRefEntries,rebaseDirDigests].filter(Boolean).join("\n");
  // Reflogs: the primary record of ref mutation — a move-and-restore leaves
  // refs identical but always appends a new entry. Read the log files
  // directly rather than shelling out to `git reflog show` once per ref
  // (whose exit-code/format semantics differ across Git versions and across
  // "ref exists with no reflog yet" vs "ref does not exist").
  const reflogs=reflogFilesDigest(gitDir);
  // Object database: `git commit-tree` / `git hash-object -w` can create an
  // object with no ref ever pointing at it. count-objects is the cheap,
  // standard way to see the store grew even when refs/config/worktree did not.
  const objects=gitOut(cwd,["count-objects","-v"]).toString("utf8");

  // Index state: `git update-index --assume-unchanged` and `--skip-worktree`
  // modify per-file index flags without creating objects or changing refs.
  // `ls-files -v` outputs a status prefix per line: lowercase `h` = assume-
  // unchanged, lowercase `s` = skip-worktree, uppercase `H` = tracked normally,
  // `S` = skip-worktree (unmerged), `?` = untracked. This is the cheapest way
  // to see the index flags without parsing the index file binary format.
  const indexState=gitOut(cwd,["ls-files","-v"]).toString("utf8");
  // Hook contents: `.git/hooks/post-commit` (or any other hook) is never
  // visible through refs, config, status, or diff. A malicious or accidental
  // hook can run arbitrary code on every Git operation. Hash every hook file
  // including its mode (executable bit) so chmod +x changes the snapshot.
  // Symlinks are included because a symlinked hook is a valid and common
  // deployment pattern (e.g. from a package manager or shared config).
  const hookEntries=[];
  // Each entry: {dir: resolvedPath, label: stableIdentityForDigest}
  const hookDirs=[{dir:path.join(gitDir,"hooks"),label:"default"}];
  // core.hooksPath is a guard-evasion path: it redirects hook resolution to
  // an arbitrary directory that may be outside .git/hooks entirely. It can
  // be set at any config scope — local, worktree, global, or system — so
  // all four must be checked. A --global or --system hooksPath is
  // especially dangerous because it affects every repository and never
  // touches the repository's own .git/config.
  // Use `git config --path` to let Git perform pathname expansion (~, ~/...,
  // ~user/...) rather than reimplementing tilde/user-database resolution.
  const effectiveHooksPath=resolveGitPath(cwd,"core.hooksPath");
  if(effectiveHooksPath){
    // The effective path is what Git actually uses; label it with the raw
    // config value so the digest is stable across repository copies.
    // We'll refine the label below if we find a matching per-scope value.
    hookDirs.push({dir:effectiveHooksPath,label:"configured:effective"});
  }
  const hooksPathAllowedStatuses={"--local":[0,1,128],"--worktree":[0,1,128],"--global":[0,1,128],"--system":[0,1,128]};
  for(const scope of ["--local","--worktree","--global","--system"]){
    try{
      const hooksPathResult=gitOutAllowing(cwd,["config",scope,"core.hooksPath"],hooksPathAllowedStatuses[scope]);
      if(hooksPathResult.status===0){
        const configured=hooksPathResult.stdout.toString().trim();
        if(configured){
          const resolved=path.resolve(cwd,expandTilde(configured));
          // If this matches the effective path, upgrade its label to include
          // the scope and raw value (more informative for digest).
          const existing=hookDirs.find(h=>h.dir===resolved);
          if(existing){
            existing.label=`configured:${scope}:${configured}`;
          }else{
            hookDirs.push({dir:resolved,label:`configured:${scope}:${configured}`});
          }
        }
      }
    }catch{}
  }
  for(const {dir:hookDir,label:dirLabel} of hookDirs){
    try{
      for(const entry of fs.readdirSync(hookDir,{withFileTypes:true})){
        if(entry.isFile()||entry.isSymbolicLink()){
          const fullPath=path.join(hookDir,entry.name);
          try{
            const st=fs.lstatSync(fullPath);
            const isSymlink=st.isSymbolicLink();
            let targetMode=st.mode;
            let targetHash;
            let symlinkTarget=null;
            try{
              const realPath=fs.realpathSync(fullPath);
              targetHash=fileHash(realPath);
              const realStat=fs.statSync(realPath);
              targetMode=realStat.mode;
              if(isSymlink) symlinkTarget=realPath;
            }catch{
              targetHash=fileHash(fullPath);
              if(isSymlink){
                try{symlinkTarget=fs.readlinkSync(fullPath);}catch{}
              }
            }
            const targetPart=symlinkTarget!==null?`:target=${symlinkTarget}`:"";
            hookEntries.push(`${dirLabel}:${entry.name}:${targetHash}:mode=${targetMode}:symlink=${isSymlink}${targetPart}`);
          }catch{}
        }
      }
    }catch{}
  }
  const hooksDigest=hookEntries.sort().join("\n");
  // EOL-tolerant dirty set: `git status` reports a CRLF-only worktree
  // rewrite as modified even under `-c core.autocrlf=input`, while
  // `git diff --ignore-cr-at-eol` correctly reports it clean (mission 024).
  // Entries for tracked paths absent from this set are phantoms and are
  // dropped from the fingerprinted status. Untracked/ignored entries (`??`,
  // `!!`) are never in the diff-HEAD set and are always kept.
  //
  // Status runs FIRST so its tracked entries can bound both diffs to the
  // paths that actually changed. On a large checkout this turns two ~12 s
  // full-tree diffs into ~2 s limited diffs while producing byte-identical
  // output: a path not reported by status cannot contribute to `diff HEAD`.
  // Batches are sorted in Git's byte order and concatenated in that order so
  // the fingerprinted binary diff matches the full-tree run exactly.
  const rawStatus=gitOut(cwd,["-c","core.autocrlf=input","status","--porcelain=v1","-z","--untracked-files=all"]);
  const statusText=rawStatus.toString("utf8");
  const statusEntries=parsePorcelainV1ZEntries(statusText);
  const {candidatePaths,pairFromByTo,renameSources}=snapshotDiffCandidates(statusEntries);
  const eolDirtySet=new Set();
  const diffParts=[];
  for(const batch of snapshotDiffBatches(candidatePaths,pairFromByTo,renameSources)){
    // Literal pathspecs: a tracked filename containing glob metacharacters
    // must not pull an unrelated path into this batch (which would duplicate
    // that path's diff across batches).
    const pathspecs=batch.map(p=>`:(literal)${p}`);
    for(const rel of gitOut(cwd,["-c","core.autocrlf=input","diff","--ignore-cr-at-eol","--name-only","-z","HEAD","--",...pathspecs]).toString().split("\0")){
      if(rel) eolDirtySet.add(rel);
    }
    diffParts.push(gitOut(cwd,["-c","core.autocrlf=input","diff","--ignore-cr-at-eol","--no-ext-diff","--binary","HEAD","--",...pathspecs,":(exclude).autopilot/**"]));
  }
  // Preserve gitOut's historical type: Buffer.alloc(0) when the full-tree
  // command would have produced no bytes, otherwise its UTF-8 string. Parts
  // are already decoded per batch; concatenating decoded file diffs is
  // identical to decoding the same full output (no multi-byte sequence spans
  // two files).
  const diff=diffParts.some(part=>part.length>0)
    ?diffParts.map(part=>part.toString()).join("")
    :Buffer.alloc(0);
  const statusKept=[];
  for(const entry of statusEntries){
    if(entry.paths.some(p=>String(p).includes(".autopilot/"))) continue;
    if(entry.xy===null){
      // Ungrouped continuation token (should not happen outside renames
      // consumed above); keep it rather than drop evidence.
      statusKept.push(entry.raw);
      continue;
    }
    if(!keepEntryAfterEolFilter(entry,eolDirtySet)) continue;
    // Else: kept — either untracked/ignored or a real (non-phantom) change.
    statusKept.push(`${entry.xy} ${entry.toPath}`);
    if(entry.fromPath!==null) statusKept.push(entry.fromPath);
  }
  const statusFiltered=Buffer.from(statusKept.join("\0")+(statusKept.length?"\0":""));

  const fileSet=new Set([...eolDirtySet].filter(rel=>!rel.startsWith(".autopilot/")));
  // Untracked files come from the status already parsed above (`??` entries
  // under --untracked-files=all): byte-identical to `git ls-files --others
  // --exclude-standard` (plain, nested, spaces/unicode/newline names, nested
  // git repos reported as `sub/`, empty dirs omitted by both) without a
  // second full-tree walk.
  for(const entry of statusEntries){
    if(entry.xy==="??"&&!entry.toPath.startsWith(".autopilot/")) fileSet.add(entry.toPath);
  }
  // Ignored files: --directory reports a wholly-ignored dir as ONE entry
  // (e.g. `apps/web/.next/`) without descending, so git never walks
  // excluded dirs (.autopilot/ run dirs, scratch caches, node_modules).
  // Excluded-segment entries are dropped outright (never descended); any
  // other dir entry (e.g. an ignored agent-config dir like .opencode/) is
  // expanded via a scoped ls-files so the operator's "agent dirs stay
  // fingerprinted" rule still holds. The JS segment backstop keeps top-level
  // and nested excludes identical even where pathspec filtering differs.
  const excludePathspecs=[];
  for(const seg of SNAPSHOT_EXCLUDED_DIR_SEGMENTS){
    excludePathspecs.push(`:(exclude)${seg}/**`, `:(exclude)**/${seg}/**`);
  }
  const ignoredEntries=gitOut(cwd,["ls-files","--others","--ignored","-z","--exclude-standard","--directory","--",".",":(exclude).autopilot/**",...excludePathspecs]).toString().split("\0").filter(Boolean);
  const dirsToExpand=[];
  for(const rel of ignoredEntries){
    if(snapshotPathExcluded(rel)) continue;
    if(rel.endsWith("/")) dirsToExpand.push(rel);
    else fileSet.add(rel);
  }
  // Fail closed: an expansion error must stop the snapshot, never silently
  // drop the dir's files from the fingerprint (a write there during a
  // read-only stage would then go undetected).
  for(const dir of dirsToExpand){
    for(const rel of gitOut(cwd,["ls-files","--others","--ignored","-z","--exclude-standard","--",dir]).toString().split("\0").filter(Boolean)){
      if(snapshotPathExcluded(rel)) continue;
      fileSet.add(rel);
    }
  }
  const files={};
  for(const rel of [...fileSet].sort()){
    const full=path.join(cwd,rel);
    try{
      const st=fs.lstatSync(full);
      if(st.isDirectory()) continue;
      files[rel]={hash:eolNormalizedFileHash(full),mode:st.mode,type:st.isSymbolicLink()?"symlink":"file"};
    }catch{files[rel]={hash:"MISSING",mode:0,type:"missing"};}
  }

  const fingerprint=hashBytes(Buffer.from(JSON.stringify({
    head,headSymbolic,refs,config,sequencer,reflogs,objects,
    indexState,hooksDigest,administrativeDigest,
    status:statusFiltered.toString("utf8"),
    diff:diff.toString("utf8"),
    files
  })));
  return {head,headSymbolic,refs,config,sequencer,reflogs,objects,indexState,hooksDigest,administrativeDigest,status:statusFiltered,diff,files,fingerprint};
}

// Snapshot scope (backlog #9 / TASK-31). Single place defining which
// wholly-ignored directory segments are EXCLUDED from the fingerprint.
// Framework build caches (node_modules, .next, .turbo, .nuxt, .svelte-kit,
// .parcel-cache, .vite) and build/coverage OUTPUT dirs (dist, build,
// coverage, .nyc_output, out, .cache, __pycache__, .pytest_cache, target) are
// never expanded or hashed: on a real repo they were hundreds of files / MBs
// per snapshot. Playwright/browser artifact dirs (.playwright-mcp,
// playwright-report, test-results) are deliberately NOT listed: a verifier's
// screenshots/traces may hold sensitive data and must stay visible to
// snapshot diffing (test-security-hardening.mjs). Applied to
// IGNORED entries only — a TRACKED file under dist/ etc. is still covered by
// status/diff. Agent-config dirs (.opencode, .claude, ...) are deliberately
// NOT listed: they stay fingerprinted to catch writes by read-only roles.
export const SNAPSHOT_EXCLUDED_DIR_SEGMENTS = Object.freeze([
  "node_modules", ".next", ".turbo", ".nuxt", ".svelte-kit",
  ".parcel-cache", ".vite",
  "dist", "build", "coverage", ".nyc_output", "out", ".cache", "__pycache__", ".pytest_cache",
  "target"
]);

function snapshotPathExcluded(rel){
  if(rel === ".autopilot/" || rel.startsWith(".autopilot/")) return true;
  const segments=String(rel).split("/");
  return segments.some(seg=>SNAPSHOT_EXCLUDED_DIR_SEGMENTS.includes(seg));
}

// Protected agent config dirs (backlog #9 / TASK-31). Operator decision:
// these stay FINGERPRINTED — a write there during a read-only stage stops
// the run. Used by formatRelayPolicyViolation() below.
export const PROTECTED_AGENT_DIRS = Object.freeze([
  ".agent", ".commandcode", ".opencode", ".mimocode", ".claude"
]);

function isProtectedAgentPath(rel){
  const norm=String(rel||"").replace(/\\/g,"/");
  return PROTECTED_AGENT_DIRS.some(dir=>norm===dir||norm.startsWith(dir+"/"));
}

// Human-readable escalation message for relay policy violations (TASK-31
// step 3). For read_only_violation it names the touched path(s) from
// touchedFiles and annotates paths under a protected agent directory.
// Falls back to the legacy message for any other violation or when no
// touched files are known, so existing consumers are unaffected.
export function formatRelayPolicyViolation(violation, touchedFiles){
  const code=String(violation||"unknown");
  const files=Array.isArray(touchedFiles)?touchedFiles.filter(Boolean).map(String):[];
  if(code!=="read_only_violation"||files.length===0){
    return `Relay policy violation: ${code}. STOP — human intervention required.`;
  }
  const MAX_LISTED=10;
  const listed=files.slice(0,MAX_LISTED).map(p=>{
    const slash=String(p).replace(/\\/g,"/");
    return isProtectedAgentPath(slash)?`${p} (protected agent directory)`:p;
  });
  const extra=files.length>MAX_LISTED?`, +${files.length-MAX_LISTED} more`:"";
  return `Relay policy violation: ${code} — write in ${listed.join(", ")}${extra}. STOP — human intervention required.`;
}
// TASK-28: evidence for `git_commit_detected`. Fixed field order for
// describeGitStateChange(). makeRelayResult()'s administrative-state
// comparison iterates this same constant instead of a hand-written `||`
// chain, so a field added to the check later is automatically covered by
// the evidence too.
export const GIT_STATE_FIELDS = Object.freeze([
  "head","headSymbolic","refs","config","sequencer","reflogs",
  "objects","indexState","hooksDigest","administrativeDigest"
]);

const GIT_STATE_LINE_CAP = 50;
const GIT_STATE_LINE_MAX_CHARS = 500;
const GIT_STATE_MAX_BYTES = 64 * 1024;

// Tested against the KEY name only (the part before `=`), never the value,
// so `user.name`/`user.email` stay readable. Deliberately over-masks (e.g.
// `user.signingkey`, `http.sslKey`): losing a harmless value costs less
// than storing a secret. Only the value is masked; the key stays readable.
const GIT_CONFIG_SECRET_KEY = /token|password|passwd|secret|credential|auth|key|extraheader|cookie/i;

function redactGitConfigValue(key,value){
  const text=String(value??"");
  // Credentials embedded in URLs: `https://user:token@host` -> `https://***@host`.
  const withoutUrlCreds=text.replace(/:\/\/[^/\s@]+@/g,"://***@");
  if(GIT_CONFIG_SECRET_KEY.test(String(key??""))) return "***";
  return withoutUrlCreds;
}

function splitGitStateLines(text){
  if(text==null||text==="") return [];
  const parts=String(text).split("\n");
  // A trailing newline is a terminator, not an extra empty line.
  if(parts.length&&parts[parts.length-1]==="") parts.pop();
  return parts;
}

function truncateGitStateLine(line){
  const text=String(line);
  return text.length>GIT_STATE_LINE_MAX_CHARS?text.slice(0,GIT_STATE_LINE_MAX_CHARS)+"…":text;
}

// Multiset diff so a duplicated line is never lost: `removed` holds lines
// in before but not after, `added` holds lines in after but not before,
// with multiplicity preserved on both sides.
function diffGitStateLines(beforeLines,afterLines){
  const beforeCounts=new Map();
  for(const line of beforeLines) beforeCounts.set(line,(beforeCounts.get(line)??0)+1);
  const afterCounts=new Map();
  for(const line of afterLines) afterCounts.set(line,(afterCounts.get(line)??0)+1);
  const removed=[];
  for(const [line,count] of beforeCounts){
    const stillThere=afterCounts.get(line)??0;
    for(let i=0;i<count-stillThere;i++) removed.push(line);
  }
  const added=[];
  for(const [line,count] of afterCounts){
    const wasThere=beforeCounts.get(line)??0;
    for(let i=0;i<count-wasThere;i++) added.push(line);
  }
  return {added,removed};
}

// Redacted, scope-prefixed config lines, e.g. `--global: core.hookspath=…`.
// One entry per scope line; the exit-status prefix (`0:`, `1:`, `128:`)
// that gitSnapshot stores per scope is structural, not a config value.
function redactedGitConfigLines(config){
  const lines=[];
  for(const scope of ["--local","--worktree","--global","--system"]){
    const raw=config?.[scope];
    if(raw==null) continue;
    const text=String(raw);
    const sep=text.indexOf(":");
    const content=sep>=0?text.slice(sep+1):text;
    for(const line of splitGitStateLines(content)){
      const eq=line.indexOf("=");
      if(eq<0){ lines.push(`${scope}: ${line}`); continue; }
      const key=line.slice(0,eq);
      lines.push(`${scope}: ${key}=${redactGitConfigValue(key,line.slice(eq+1))}`);
    }
  }
  return lines;
}

// Raw (unredacted) per-field value used for DETECTION. Identical to the old
// `||` chain in makeRelayResult(): `config` compares exactly as
// `JSON.stringify(before.config)!==JSON.stringify(after.config)` did, so
// redaction can never change the verdict — it only affects stored evidence.
function gitStateFieldRaw(field,snapshot){
  if(field==="config") return JSON.stringify(snapshot?.config??null);
  return String(snapshot?.[field]??"");
}

// Pure: no git calls, no file system, no clock. Two identical snapshots
// return `[]`. One entry per differing field, in GIT_STATE_FIELDS order:
// `{field, added, removed, addedCount, removedCount, truncated}`.
export function describeGitStateChange(before,after){
  const entries=[];
  for(const field of GIT_STATE_FIELDS){
    if(gitStateFieldRaw(field,before)===gitStateFieldRaw(field,after)) continue;
    let added;
    let removed;
    if(field==="head"||field==="headSymbolic"){
      removed=[String(before?.[field]??"")];
      added=[String(after?.[field]??"")];
    }else if(field==="config"){
      ({added,removed}=diffGitStateLines(redactedGitConfigLines(before?.config),redactedGitConfigLines(after?.config)));
    }else{
      ({added,removed}=diffGitStateLines(
        splitGitStateLines(String(before?.[field]??"")),
        splitGitStateLines(String(after?.[field]??""))
      ));
    }
    const addedCount=added.length;
    const removedCount=removed.length;
    entries.push({
      field,
      added:added.slice(0,GIT_STATE_LINE_CAP).map(truncateGitStateLine),
      removed:removed.slice(0,GIT_STATE_LINE_CAP).map(truncateGitStateLine),
      addedCount,
      removedCount,
      truncated:added.length>GIT_STATE_LINE_CAP||removed.length>GIT_STATE_LINE_CAP
    });
  }
  // Whole-payload bound: while the serialized form exceeds 64 KB, drop
  // `added`/`removed` from the largest entries first and mark them
  // truncated. Field names and exact counts are never dropped.
  const serializedBytes=()=>Buffer.byteLength(JSON.stringify(entries),"utf8");
  while(serializedBytes()>GIT_STATE_MAX_BYTES){
    let victim=null;
    let victimSize=-1;
    for(const entry of entries){
      if(!entry.added.length&&!entry.removed.length) continue;
      const size=Buffer.byteLength(JSON.stringify(entry.added)+JSON.stringify(entry.removed),"utf8");
      if(size>victimSize){ victimSize=size; victim=entry; }
    }
    if(!victim) break;
    victim.added=[];
    victim.removed=[];
    victim.truncated=true;
  }
  return entries;
}

// Redacted full snapshot for `git-guard/snapshot-{before,after}.json`: the
// ten administrative fields only — never `diff`, `files` or `status`,
// which are large and belong to the tree check. Same redaction as the
// evidence diff; the per-scope exit-status prefix is preserved.
export function redactedGitSnapshot(snapshot){
  const config={};
  for(const scope of ["--local","--worktree","--global","--system"]){
    const raw=snapshot?.config?.[scope];
    if(raw==null) continue;
    const text=String(raw);
    const sep=text.indexOf(":");
    if(sep<0){ config[scope]=text; continue; }
    const status=text.slice(0,sep);
    const redacted=splitGitStateLines(text.slice(sep+1)).map((line)=>{
      const eq=line.indexOf("=");
      if(eq<0) return line;
      return `${line.slice(0,eq+1)}${redactGitConfigValue(line.slice(0,eq),line.slice(eq+1))}`;
    });
    config[scope]=redacted.length?`${status}:${redacted.join("\n")}`:`${status}:`;
  }
  return {
    head:String(snapshot?.head??""),
    headSymbolic:String(snapshot?.headSymbolic??""),
    refs:String(snapshot?.refs??""),
    config,
    sequencer:String(snapshot?.sequencer??""),
    reflogs:String(snapshot?.reflogs??""),
    objects:String(snapshot?.objects??""),
    indexState:String(snapshot?.indexState??""),
    hooksDigest:String(snapshot?.hooksDigest??""),
    administrativeDigest:String(snapshot?.administrativeDigest??"")
  };
}
export function touchedFilesBetween(before,after,cwd){
  const set=new Set();
  const beforeFiles=before.files||{};
  const afterFiles=after.files||{};
  for(const rel of new Set([...Object.keys(beforeFiles),...Object.keys(afterFiles)])){
    if(rel.startsWith(".autopilot/"))continue;
    if(JSON.stringify(beforeFiles[rel]||null)!==JSON.stringify(afterFiles[rel]||null)) set.add(rel);
  }
  if(before.head!==after.head && before.head){
    try{
      // EOL-tolerant like gitSnapshot's fileSet: a CR-only blob difference
      // between the two commits is not a worktree change the role made.
      for(const p of gitOut(cwd,["-c","core.autocrlf=input","diff","--ignore-cr-at-eol","--name-only","-z",`${before.head}..${after.head}`]).toString().split("\0").filter(Boolean)){
        if(!p.startsWith(".autopilot/"))set.add(p);
      }
    }catch{}
  }
  return [...set].sort();
}
// Ref/history-mutating subcommands. Deliberately broader than {commit, push}:
// commit-tree + update-ref can create a commit object and move a branch without
// ever calling "git commit", so the old two-entry blocklist was bypassable.
export const BLOCKED_SUBCOMMANDS = new Set([
  "commit","commit-tree","push","update-ref","symbolic-ref","replace",
  "filter-branch","fast-import","reset","merge","rebase","cherry-pick",
  "revert","tag","branch","notes"
]);

// TASK 6 (review round 2): the ONLY environment names any guard-started process
// may inherit. Interpreter/loader controls — NODE_OPTIONS, NODE_PATH,
// LD_PRELOAD, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH, ... —
// are consumed by the interpreter/loader BEFORE a single line of guard code
// runs, so a guard that starts Node with the caller's environment cannot defend
// itself from inside Node: a preload can simply `process.exit(0)` and make a
// scoped deny hook read as "allowed". The fix is to reduce the environment to
// an explicit allowlist (never a blacklist of known-bad names, which is always
// incomplete) before the interpreter is started, in every place the guard
// starts a process: the POSIX PATH shim, the Windows shim, the deny hooks, and
// the git identity probes. GIT_DIR/GIT_WORK_TREE stay listed because git itself
// honours them for locating a repository and the scoping decision must see
// exactly what git would see; everything else is dropped.
// The guard's OWN enforcement carrier is on the list too, and only these names:
// the hook configuration `guardedEnv` installs (GIT_CONFIG_*), the prompt
// switch, and the guard-log pointer the execution envelope path-maps. A caller
// that strips them loses hook coverage — but Layer 1 and the host-side
// fingerprint check still stand — while a caller that forges them cannot gain
// anything: Layer 1's decision is computed from the filesystem, not from them.
export const GUARD_ENV_ALLOWLIST = Object.freeze([
  "PATH","HOME","TMPDIR","TEMP","TMP","LANG","LC_ALL","LC_CTYPE",
  "USER","LOGNAME","USERNAME","SHELL","TERM",
  "SystemRoot","windir","SystemDrive","COMSPEC","PATHEXT",
  "USERPROFILE","HOMEDRIVE","HOMEPATH","APPDATA","LOCALAPPDATA","ProgramData",
  "ProgramFiles","NUMBER_OF_PROCESSORS","PROCESSOR_ARCHITECTURE","COMPUTERNAME",
  "GIT_DIR","GIT_WORK_TREE",
  "GIT_TERMINAL_PROMPT","GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0","GIT_CONFIG_VALUE_0","GIT_CONFIG_KEY_1","GIT_CONFIG_VALUE_1",
  "GIT_CONFIG_KEY_2","GIT_CONFIG_VALUE_2","GIT_CONFIG_KEY_3","GIT_CONFIG_VALUE_3",
  "GIT_CONFIG_KEY_4","GIT_CONFIG_VALUE_4","GIT_CONFIG_KEY_5","GIT_CONFIG_VALUE_5",
  "GIT_CONFIG_KEY_6","GIT_CONFIG_VALUE_6","GIT_CONFIG_KEY_7","GIT_CONFIG_VALUE_7",
  "AUTOPILOT_GIT_GUARD_LOG","AUTOPILOT_NO_GIT_MUTATIONS"
]);

// POSIX-sh prologue that defines autopilot_guard_exec(). Emitted verbatim into
// the PATH shim and into every deny hook, so the two can never drift. Starts
// Node under `env -i` with only GUARD_ENV_ALLOWLIST, and re-adds GIT_DIR /
// GIT_WORK_TREE only when they are actually SET (an empty GIT_DIR is not the
// same thing as an absent one, and git would misread it). Returns 1 — the
// caller's fail-closed path — when no usable `env` can be found.
function gitGuardEnvPrologue(envBinary){
  // GIT_DIR/GIT_WORK_TREE are handled separately below, so they are not part of
  // the unconditional operand list. Everything else on the allowlist is emitted
  // here; an unset name becomes empty, which those names tolerate.
  const operandNames=GUARD_ENV_ALLOWLIST.filter(name=>name!=="GIT_DIR"&&name!=="GIT_WORK_TREE");
  const operandLines=[];
  for(let i=0;i<operandNames.length;i+=5){
    // Git for Windows runs hooks under MSYS sh, which exposes Windows env names
    // UPPERCASED (SYSTEMROOT, WINDIR); the mixed-case name is empty there and
    // node.exe would crash without SystemRoot. Fall back to the uppercase name
    // (both empty on POSIX, so behaviour there is unchanged).
    operandLines.push("    "+operandNames.slice(i,i+5).map(name=>name===name.toUpperCase()?`"${name}=$${name}"`:`"${name}=\${${name}:-$${name.toUpperCase()}}"`).join(" ")+" \\");
  }
  return [
    "AUTOPILOT_GUARD_ENV_BIN='"+(envBinary||"")+"'",
    "autopilot_guard_exec() {",
    "  _agn_node=\"$1\"; _agn_script=\"$2\"; shift 2",
    "  _agn_env_bin=\"$AUTOPILOT_GUARD_ENV_BIN\"",
    "  if [ -z \"$_agn_env_bin\" ] || [ ! -x \"$_agn_env_bin\" ]; then _agn_env_bin=$(command -v env 2>/dev/null); fi",
    "  if [ -z \"$_agn_env_bin\" ] || [ ! -x \"$_agn_env_bin\" ]; then return 1; fi",
    "  exec \"$_agn_env_bin\" -i \\",
    ...operandLines,
    "    /bin/sh -c 'node_bin=\"$1\"; guard=\"$2\"; shift 2",
    "gflag=\"$1\"; gval=\"$2\"; wflag=\"$3\"; wval=\"$4\"; shift 4",
    "if [ \"$gflag\" = x ]; then GIT_DIR=\"$gval\"; export GIT_DIR; fi",
    "if [ \"$wflag\" = x ]; then GIT_WORK_TREE=\"$wval\"; export GIT_WORK_TREE; fi",
    "exec \"$node_bin\" \"$guard\" \"$@\"' autopilot-guard \"$_agn_node\" \"$_agn_script\" \"${GIT_DIR+x}\" \"${GIT_DIR-}\" \"${GIT_WORK_TREE+x}\" \"${GIT_WORK_TREE-}\" \"$@\"",
    "}"
  ].join("\n");
}

// Fast-path sibling of autopilot_guard_exec: the same `env -i` +
// GUARD_ENV_ALLOWLIST sanitized environment, but execs the baked real git
// instead of Node. Emitted ONLY into the Unix PATH shim (never the deny
// hooks, which stay byte-identical), so read-only git subcommands skip the
// ~600 ms Node startup while running exactly the binary and environment the
// Node wrapper would have used.
function gitGuardRealGitExecPrologue(realGit){
  const operandNames=GUARD_ENV_ALLOWLIST.filter(name=>name!=="GIT_DIR"&&name!=="GIT_WORK_TREE");
  const operandLines=[];
  for(let i=0;i<operandNames.length;i+=5){
    operandLines.push("    "+operandNames.slice(i,i+5).map(name=>`"${name}=$${name}"`).join(" ")+" \\");
  }
  return [
    "AUTOPILOT_GUARD_REAL_GIT="+shellLiteral(realGit),
    "autopilot_guard_exec_git() {",
    "  _agg_env_bin=\"$AUTOPILOT_GUARD_ENV_BIN\"",
    "  if [ -z \"$_agg_env_bin\" ] || [ ! -x \"$_agg_env_bin\" ]; then _agg_env_bin=$(command -v env 2>/dev/null); fi",
    "  if [ -z \"$_agg_env_bin\" ] || [ ! -x \"$_agg_env_bin\" ]; then return 1; fi",
    "  exec \"$_agg_env_bin\" -i \\",
    ...operandLines,
    "    /bin/sh -c 'git_bin=\"$1\"; shift 1",
    "gflag=\"$1\"; gval=\"$2\"; wflag=\"$3\"; wval=\"$4\"; shift 4",
    "if [ \"$gflag\" = x ]; then GIT_DIR=\"$gval\"; export GIT_DIR; fi",
    "if [ \"$wflag\" = x ]; then GIT_WORK_TREE=\"$wval\"; export GIT_WORK_TREE; fi",
    "exec \"$git_bin\" \"$@\"' autopilot-guard \"$AUTOPILOT_GUARD_REAL_GIT\" \"${GIT_DIR+x}\" \"${GIT_DIR-}\" \"${GIT_WORK_TREE+x}\" \"${GIT_WORK_TREE-}\" \"$@\"",
    "}"
  ].join("\n");
}

// 20 Phase 1 task 1.1 — dash-compatible strict read-only fast-path classifier
// emitted into the POSIX PATH shim (never the deny hooks, which stay as they
// are). `_apg_fast` drops the single leading `-c core.autocrlf=input` pair the
// Node wrapper's stripOverridingConfigArgs removes too, so the exec'd git sees
// the same argv as the wrapper's spawnSync call, then admits the
// unconditional read-only subcommands plus the narrowly classified `config`,
// `symbolic-ref`, `worktree list`, `cat-file` and `diff`/`log`/`show` read
// shapes. Every other subcommand/token returns 1 so the shim falls through to
// the Node wrapper. Each branch scans its own argv with an explicit `--`-aware
// loop, because a `case` pattern cannot be built from a variable holding
// alternatives (`a|b` from `$var` is matched literally).
export function gitGuardFastPathShellFragment(){
  return [
    "# --- strict read-only fast path -------------------------------------",
    "_apg_fast() {",
    "  if [ \"${1:-}\" = \"-c\" ] && [ \"${2:-}\" = \"core.autocrlf=input\" ]; then",
    "    shift 2",
    "  fi",
    "  _apg_fast_sub=\"${1:-}\"",
    "  case \"$_apg_fast_sub\" in",
    "    status|rev-parse|ls-files|count-objects|for-each-ref)",
    "      autopilot_guard_exec_git \"$@\" || return 2",
    "      return 0",
    "      ;;",
    "    config)",
    "      _apg_cfg_ok=0",
    "      _apg_cfg_bad=0",
    "      _apg_cfg_operands=0",
    "      _apg_cfg_first=\"\"",
    "      _apg_cfg_action=\"\"",
    "      _apg_cfg_seen=0",
    "      _apg_cfg_sep=0",
    "      for _apg_cfg_arg in \"$@\"; do",
    "        if [ \"$_apg_cfg_seen\" = 0 ]; then",
    "          _apg_cfg_seen=1",
    "          continue",
    "        fi",
    "        if [ \"$_apg_cfg_sep\" = 1 ]; then",
    "          _apg_cfg_operands=$((_apg_cfg_operands+1))",
    "          if [ \"$_apg_cfg_operands\" = 1 ]; then _apg_cfg_first=\"$_apg_cfg_arg\"; fi",
    "          continue",
    "        fi",
    "        if [ \"$_apg_cfg_arg\" = \"--\" ]; then",
    "          _apg_cfg_sep=1",
    "          continue",
    "        fi",
    "        case \"$_apg_cfg_arg\" in",
    "          --get|--get-all|--get-regexp|--get-urlmatch|--list|-l)",
    "            if [ -n \"$_apg_cfg_action\" ]; then _apg_cfg_bad=1; fi",
    "            _apg_cfg_action=\"$_apg_cfg_arg\"",
    "            ;;",
    "          --local|--global|--system|--worktree|--path|--show-origin|--show-scope|--name-only|--null|-z|--includes|--no-includes)",
    "            ;;",
    "          -*)",
    "            _apg_cfg_bad=1",
    "            ;;",
    "          *)",
    "            _apg_cfg_operands=$((_apg_cfg_operands+1))",
    "            if [ \"$_apg_cfg_operands\" = 1 ]; then _apg_cfg_first=\"$_apg_cfg_arg\"; fi",
    "            ;;",
    "        esac",
    "      done",
    "      if [ \"$_apg_cfg_bad\" = 0 ]; then",
    "        case \"$_apg_cfg_action\" in",
    "          --list|-l)",
    "            if [ \"$_apg_cfg_operands\" -eq 0 ]; then _apg_cfg_ok=1; fi",
    "            ;;",
    "          --get|--get-all|--get-regexp)",
    "            if [ \"$_apg_cfg_operands\" -ge 1 ] && [ \"$_apg_cfg_operands\" -le 2 ]; then _apg_cfg_ok=1; fi",
    "            ;;",
    "          --get-urlmatch)",
    "            if [ \"$_apg_cfg_operands\" -eq 2 ]; then _apg_cfg_ok=1; fi",
    "            ;;",
    "          \"\")",
    "            if [ \"$_apg_cfg_operands\" -eq 1 ]; then",
    "              case \"$_apg_cfg_first\" in",
    "                -*) ;;",
    "                ?*.?*) _apg_cfg_ok=1 ;;",
    "              esac",
    "            fi",
    "            ;;",
    "        esac",
    "      fi",
    "      if [ \"$_apg_cfg_ok\" = 1 ]; then",
    "        autopilot_guard_exec_git \"$@\" || return 2",
    "        return 0",
    "      fi",
    "      ;;",
    "    symbolic-ref)",
    "      _apg_sym_ok=0",
    "      _apg_sym_bad=0",
    "      _apg_sym_operands=0",
    "      _apg_sym_operand=\"\"",
    "      _apg_sym_seen=0",
    "      for _apg_sym_arg in \"$@\"; do",
    "        if [ \"$_apg_sym_seen\" = 0 ]; then",
    "          _apg_sym_seen=1",
    "          continue",
    "        fi",
    "        case \"$_apg_sym_arg\" in",
    "          --quiet|-q|--short|--no-recurse)",
    "            ;;",
    "          -*)",
    "            _apg_sym_bad=1",
    "            ;;",
    "          *)",
    "            _apg_sym_operands=$((_apg_sym_operands+1))",
    "            _apg_sym_operand=\"$_apg_sym_arg\"",
    "            ;;",
    "        esac",
    "      done",
    "      if [ \"$_apg_sym_bad\" = 0 ] && [ \"$_apg_sym_operands\" -eq 1 ]; then",
    "        case \"$_apg_sym_operand\" in",
    "          HEAD|refs/?*) _apg_sym_ok=1 ;;",
    "        esac",
    "      fi",
    "      if [ \"$_apg_sym_ok\" = 1 ]; then",
    "        autopilot_guard_exec_git \"$@\" || return 2",
    "        return 0",
    "      fi",
    "      ;;",
    "    worktree)",
    "      if [ \"${2:-}\" = \"list\" ]; then",
    "        autopilot_guard_exec_git \"$@\" || return 2",
    "        return 0",
    "      fi",
    "      ;;",
    "    cat-file)",
    "      _apg_cat_ok=0",
    "      _apg_cat_bad=0",
    "      _apg_cat_operands=0",
    "      _apg_cat_seen=0",
    "      _apg_cat_sep=0",
    "      for _apg_cat_arg in \"$@\"; do",
    "        if [ \"$_apg_cat_seen\" = 0 ]; then",
    "          _apg_cat_seen=1",
    "          continue",
    "        fi",
    "        if [ \"$_apg_cat_sep\" = 1 ]; then",
    "          _apg_cat_operands=$((_apg_cat_operands+1))",
    "          continue",
    "        fi",
    "        if [ \"$_apg_cat_arg\" = \"--\" ]; then",
    "          _apg_cat_sep=1",
    "          continue",
    "        fi",
    "        case \"$_apg_cat_arg\" in",
    "          -t|-s|-e|-p|--batch|--batch=*|--batch-check|--batch-check=*|--batch-all-objects|--buffer|--unordered|--allow-unknown-type|--follow-symlinks|--use-mailmap)",
    "            ;;",
    "          -*)",
    "            _apg_cat_bad=1",
    "            ;;",
    "          *)",
    "            _apg_cat_operands=$((_apg_cat_operands+1))",
    "            ;;",
    "        esac",
    "      done",
    "      if [ \"$_apg_cat_bad\" = 0 ] && [ \"$_apg_cat_operands\" -ge 1 ]; then",
    "        _apg_cat_ok=1",
    "      fi",
    "      if [ \"$_apg_cat_ok\" = 1 ]; then",
    "        autopilot_guard_exec_git \"$@\" || return 2",
    "        return 0",
    "      fi",
    "      ;;",
    "    diff|log|show)",
    "      _apg_dls_ok=0",
    "      _apg_dls_bad=0",
    "      _apg_dls_seen=0",
    "      _apg_dls_sep=0",
    "      for _apg_dls_arg in \"$@\"; do",
    "        if [ \"$_apg_dls_seen\" = 0 ]; then",
    "          _apg_dls_seen=1",
    "          continue",
    "        fi",
    "        if [ \"$_apg_dls_sep\" = 1 ]; then",
    "          continue",
    "        fi",
    "        if [ \"$_apg_dls_arg\" = \"--\" ]; then",
    "          _apg_dls_sep=1",
    "          continue",
    "        fi",
    "        case \"$_apg_dls_arg\" in",
    "          --output*|--ext*|--text*)",
    "            _apg_dls_bad=1",
    "            ;;",
    "        esac",
    "      done",
    "      if [ \"$_apg_dls_bad\" = 0 ]; then",
    "        _apg_dls_ok=1",
    "      fi",
    "      if [ \"$_apg_dls_ok\" = 1 ]; then",
    "        autopilot_guard_exec_git \"$@\" || return 2",
    "        return 0",
    "      fi",
    "      ;;",
    "  esac",
    "  return 1",
    "}"
  ].join("\n");
}

// Windows .cmd shim fast list: exactly the five unconditional read-only
// subcommands the Unix classifier admits without inspecting any further
// argument. Every form that needs an argv check (diff/log/show, cat-file,
// config, symbolic-ref, worktree) stays on the Node wrapper, because cmd.exe
// cannot express the POSIX option/operand rules. Compare with `_apg_fast` in
// gitGuardFastPathShellFragment().
export const GIT_GUARD_WINDOWS_FAST_SUBCOMMANDS=["status","rev-parse","ls-files","count-objects","for-each-ref"];

// Windows equivalent for the .cmd shim. cmd.exe cannot express an allowlist as
// a static environment, so it enumerates the current environment and deletes
// every name that is not on the list. Delayed expansion is used only to carry a
// presence flag; values containing `!` are not forwarded by cmd anyway.
function windowsShimSanitizer(){
  const names=GUARD_ENV_ALLOWLIST.join(" ");
  return [
    "@echo off",
    "setlocal enabledelayedexpansion",
    "for /f \"delims==\" %%A in ('set 2^>nul') do (",
    "  set \"_agn_keep=\"",
    `  for %%B in (${names}) do if /i "%%A"=="%%B" set "_agn_keep=1"`,
    "  if not defined _agn_keep set \"%%A=\"",
    ")"
  ].join("\r\n");
}

// 024 Phase 4 task 4.1 — Layer-1 worktree-discarding path-restore classifier.
// Closure-free by design (parameters only; no module-scope reads) so the
// generated PATH-shim wrapper can embed this function's source verbatim via
// `.toString()`, exactly like normalizeGuardPath/isOutsideProtectedIdentity.
// Returns a short form label when the invocation discards worktree content and
// null when it does not. checkout/restore/switch/stash deliberately stay
// OUTSIDE BLOCKED_SUBCOMMANDS — the decision here is by command FORM, after
// the wrapper's own -c/global-flag skipping (subcommandIndex), never by
// subcommand membership.
//   - checkout: "--"+paths blocks; -f/--force (incl. short clusters like -qf)
//     blocks even with zero/single branch operands; --detach/-b/-B/--orphan
//     (branch ops) and --help allow; >=2 operands (tree-ish + pathspec)
//     block; single "."-like blocks; single "-" / HEAD allows (branch
//     switch); any other single operand is a branch-vs-path ambiguity
//     resolved through isCommitRef (a rev-parse probe the wrapper supplies):
//     commit -> allow, else block.
//   - restore: worktree is the default, so any pathspec blocks, except the
//     index-only --staged form without --worktree, and --dry-run/--help.
//   - switch: a "--"+paths tail blocks, as does any force/discard form
//     (-f/--force/--discard-changes, incl. short-flag clusters like -qf);
//     plain branch switches allow.
//   - stash: bare/push/save/drop/clear/pop/apply/branch block (all discard or
//     rewrite worktree/stash state); list/show/--help allow (read-only).
export function classifyWorktreeDiscarding(argumentList,commandIndex,isCommitRef){
  if(typeof commandIndex!=="number"||commandIndex<0) return null;
  const subcommand=argumentList[commandIndex];
  if(subcommand!=="checkout"&&subcommand!=="restore"&&subcommand!=="switch"&&subcommand!=="stash") return null;
  const rest=argumentList.slice(commandIndex+1);
  const baseOf=(token)=>String(token).split("=")[0];
  const hasOpt=(...names)=>rest.some((token)=>names.indexOf(baseOf(token))>=0);
  if(subcommand==="checkout"){
    const sep=rest.indexOf("--");
    if(sep>=0&&rest.slice(sep+1).length>0) return "checkout -- <paths>";
    if(hasOpt("--help","-h")) return null;
    // Force forms discard every worktree change even when the target is a
    // branch (or absent): `checkout -f`, `checkout -f HEAD`,
    // `checkout --force <branch>`. Short-cluster spells (-qf, -bf) count.
    for(let i=0;i<rest.length;i+=1){
      const token=String(rest[i]);
      if(token==="--") break;
      if(token==="-f"||token==="--force"||token.indexOf("--force=")===0) return "checkout --force";
      if(/^\-[A-Za-z]+$/.test(token)&&token.indexOf("f")>=0) return "checkout --force";
    }
    if(hasOpt("--detach","-b","-B","--orphan")) return null;
    const operands=rest.filter((token)=>String(token).charAt(0)!=="-");
    if(operands.length>=2) return "checkout <tree-ish> <pathspec>";
    if(operands.length===0) return null;
    const op=String(operands[0]);
    if(op==="."||op==="./"||op.indexOf("./")===0||op.charAt(0)==="/"||op.indexOf(":/")===0) return "checkout <path>";
    if(op==="-"||op==="HEAD") return null;
    if(typeof isCommitRef==="function"){
      let isRef=false;
      try{isRef=isCommitRef(op)===true;}catch(e){isRef=false;}
      if(isRef) return null;
      return "checkout <path>";
    }
    return "checkout <path>";
  }
  if(subcommand==="restore"){
    if(hasOpt("--help","-h","--dry-run","-n")) return null;
    if(hasOpt("--staged")&&!hasOpt("--worktree","-W")) return null;
    const sep=rest.indexOf("--");
    if(sep>=0){
      if(rest.slice(sep+1).length>0) return "restore <paths>";
    }
    const tokens=sep>=0?rest.slice(0,sep):rest;
    const operands=[];
    for(let i=0;i<tokens.length;i+=1){
      const token=String(tokens[i]);
      if(token==="--source"||token==="-s"){i+=1;continue;}
      if(token.indexOf("--source=")===0) continue;
      if(token.charAt(0)==="-") continue;
      operands.push(token);
    }
    if(operands.length>0) return "restore <paths>";
    return null;
  }
  if(subcommand==="switch"){
    if(hasOpt("--help","-h")) return null;
    // Force/discard forms wipe worktree changes on a branch switch:
    // `switch -f <branch>`, `switch --force <branch>`,
    // `switch --discard-changes <branch>` (plus short clusters like -qf).
    for(let i=0;i<rest.length;i+=1){
      const token=String(rest[i]);
      if(token==="--") break;
      if(token==="-f"||token==="--force"||token.indexOf("--force=")===0) return "switch --discard-changes";
      if(token==="--discard-changes"||token.indexOf("--discard-changes=")===0) return "switch --discard-changes";
      if(/^\-[A-Za-z]+$/.test(token)&&token.indexOf("f")>=0) return "switch --discard-changes";
    }
    const sep=rest.indexOf("--");
    if(sep>=0&&rest.slice(sep+1).length>0) return "switch -- <paths>";
    return null;
  }
  if(subcommand==="stash"){
    if(hasOpt("--help","-h")) return null;
    let sub2=null;
    for(let i=0;i<rest.length;i+=1){
      const token=String(rest[i]);
      if(token==="--"){
        if(rest.slice(i+1).length>0) return "stash -- <paths>";
        break;
      }
      if(token.charAt(0)==="-") continue;
      sub2=token;
      break;
    }
    if(sub2===null) return "stash";
    if(sub2==="list"||sub2==="show") return null;
    return "stash "+sub2;
  }
  return null;
}

// 024 Phase 4 task 4.1 — strip an agent-supplied `-c core.autocrlf=...`
// override that sits BEFORE the subcommand, so the pinned EOL value the guard
// installs (core.autocrlf=input) cannot be overridden past the wrapper parser.
// Closure-free (parameters only) for verbatim embedding. Only the exact key
// core.autocrlf (case-insensitive, optional whitespace around the `=`) is
// dropped: as a `-c <key>=<value>` pair, a stuck `-c<key>=<value>` token, a
// `--config-env <key>=<value>` pair, or a `--config-env=<key>=<value>` token;
// every other -c/--config-env pair passes through untouched, and anything
// at/after the subcommand index is never a global flag by construction.
// Uppercase -C takes a directory, never config, and is left alone.
export function stripOverridingConfigArgs(argumentList,commandIndex){
  const out=[];
  const end=(typeof commandIndex==="number"&&commandIndex>=0)?commandIndex:argumentList.length;
  for(let i=0;i<argumentList.length;i+=1){
    const token=argumentList[i];
    if(i<end&&token==="-c"){
      const value=argumentList[i+1];
      if(typeof value==="string"&&/^\s*core\.autocrlf\s*=/i.test(value)){i+=1;continue;}
      out.push(token);
      continue;
    }
    if(i<end&&token==="--config-env"){
      const value=argumentList[i+1];
      if(typeof value==="string"&&/^\s*core\.autocrlf\s*=/i.test(value)){i+=1;continue;}
      out.push(token);
      continue;
    }
    if(i<end&&typeof token==="string"&&token.indexOf("--config-env=")===0){
      if(/^\s*core\.autocrlf\s*=/i.test(token.slice("--config-env=".length))) continue;
      out.push(token);
      continue;
    }
    if(i<end&&typeof token==="string"&&token.length>2&&token.charAt(0)==="-"&&token.charAt(1)==="c"&&token.indexOf("=")>=0){
      if(/^\s*core\.autocrlf\s*=/i.test(token.slice(2))) continue;
    }
    out.push(token);
  }
  return out;
}

// 024 Phase 4 task 4.2 — per-run before-snapshot for the Layer-1
// worktree-restore guard. The orchestrator calls writeGuardBeforeSnapshot
// once per relay call (next to git-scope.conf); the generated wrapper reads
// the snapshot to tell the role's OWN touched files (current EOL-normalized
// bytes differ from the before hash) from FOREIGN files it never modified
// (bytes identical), denying restores of the latter while allowing the
// former. gitSnapshot().files covers only dirty/untracked/ignored files, so
// this enumerates `git ls-files --full-name` (every tracked file) instead —
// reusing the snapshot would make clean-vs-touched indistinguishable.
// Keys are repository-relative forward-slash paths so the snapshot stays
// valid wherever the worktree is mounted; the wrapper relativizes its own
// rev-parse root the same way. Throws fail-closed (matching gitOut's
// contract); a null scopeFile returns null because enforcement is already
// fail-closed there (no scope identity means every mutation denies anyway).
export function writeGuardBeforeSnapshot(scopeFile,cwd){
  if(typeof scopeFile!=="string"||!scopeFile) return null;
  const top=gitOut(cwd,["rev-parse","--show-toplevel"]).toString().trim();
  if(!top) throw new Error("Git guard: cannot record the before-snapshot (repository top level unresolved). Failing closed.");
  const raw=gitOut(cwd,["ls-files","-z","--full-name"]);
  const files={};
  for(const rel of raw.toString().split("\0").filter(Boolean)){
    files[rel]=eolNormalizedFileHash(path.join(top,rel.split("/").join(path.sep)));
  }
  const snapshotFile=path.join(path.dirname(scopeFile),"git-before-snapshot.json");
  fs.writeFileSync(snapshotFile,JSON.stringify({version:1,files}));
  return snapshotFile;
}

// 024 Phase 4 task 4.2 — extract the worktree pathspecs a
// classifyWorktreeDiscarding-flagged invocation would restore, or null when
// the form is broad/unparseable (fail closed). Closure-free (parameters only)
// for verbatim wrapper embedding. Only checkout/restore/switch yield
// pathspecs; stash and anything else return null (always deny).
export function extractRestorePathspecs(argumentList,commandIndex){
  if(typeof commandIndex!=="number"||commandIndex<0) return null;
  const subcommand=argumentList[commandIndex];
  if(subcommand!=="checkout"&&subcommand!=="restore"&&subcommand!=="switch") return null;
  const rest=argumentList.slice(commandIndex+1);
  const sep=rest.indexOf("--");
  // A force/discard flag makes the invocation unscoped: `checkout -f <branch>`
  // discards EVERY worktree change even though the operand names a branch, so
  // the operand must never be attributed to a single file (fail closed —
  // always deny, never consult the before-snapshot). Mirrors the force
  // detection in classifyWorktreeDiscarding, including short-flag clusters.
  const hasForceBeforeSep=(...names)=>{
    for(let i=0;i<rest.length;i+=1){
      const token=String(rest[i]);
      if(token==="--") break;
      if(names.indexOf(token)>=0) return true;
      if(token.indexOf("--force=")===0) return true;
      if(/^\-[A-Za-z]+$/.test(token)&&token.indexOf("f")>=0) return true;
    }
    return false;
  };
  if(sep>=0){
    if(subcommand==="checkout"&&hasForceBeforeSep("-f","--force")) return null;
    if(subcommand==="switch"&&(hasForceBeforeSep("-f","--force")||rest.slice(0,sep).some((token)=>String(token).indexOf("--discard-changes")===0))) return null;
    const tail=rest.slice(sep+1).map((token)=>String(token));
    return tail.length>0?tail:null;
  }
  if(subcommand==="restore"){
    const specs=[];
    for(let i=0;i<rest.length;i+=1){
      const token=String(rest[i]);
      if(token==="--source"||token==="-s"){i+=1;continue;}
      if(token.indexOf("--source=")===0) continue;
      if(token.charAt(0)==="-") continue;
      specs.push(token);
    }
    return specs.length>0?specs:null;
  }
  if(subcommand==="checkout"){
    // Force forms without `--` (e.g. `checkout -f <branch>`) discard the
    // whole worktree: fail closed, never attribute the operand to one file.
    if(hasForceBeforeSep("-f","--force")) return null;
    const operands=rest.filter((token)=>String(token).charAt(0)!=="-").map((token)=>String(token));
    if(operands.length>=2) return operands.slice(1);
    if(operands.length===1) return [operands[0]];
    return null;
  }
  return null;
}

// 024 Phase 4 task 4.2 — true when a single pathspec is too broad to
// attribute to one file (tree root, directories, globs, absolute or
// `:/`-magic paths). Closure-free for verbatim wrapper embedding. An
// existing on-disk directory is additionally treated as broad by the caller.
export function isBroadRestorePathspec(spec){
  const s=String(spec);
  if(s===""||s==="."||s==="./"||s.indexOf("./")===0||s===":"||s.indexOf(":/")===0) return true;
  if(s.charAt(0)==="/") return true;
  if(s.charAt(s.length-1)==="/") return true;
  if(s.indexOf("*")>=0||s.indexOf("?")>=0||s.indexOf("[")>=0||s.indexOf("{")>=0) return true;
  return false;
}

// 024 Phase 4 task 4.2 — wrapper-side before-snapshot verdict. Returns true
// only when EVERY restored pathspec names a file the role itself touched
// this run (current EOL-normalized bytes differ from the before hash, the
// role created it, or the role deleted it); anything else — foreign
// (untouched) files, broad pathpecs, directories, missing/unreadable
// snapshot, --git-dir/--work-tree redirection, unresolvable repository —
// returns false (deny, fail closed). Closure-free: every input arrives as a
// parameter (scopeFileHref is SCOPE_FILE.href, envAllowlist is
// GUARD_ENV_ALLOWLIST); only top-level wrapper bindings (fs, path,
// spawnSync, process, URL, Buffer via eolNormalizedFileHash) are used.
export function guardBeforeSnapshotAllows(argumentList,commandIndex,discardForm,scopeFileHref,realGit,envAllowlist){
  try{
    if(!discardForm) return false;
    if(typeof commandIndex!=="number"||commandIndex<0) return false;
    const subcommand=argumentList[commandIndex];
    if(subcommand!=="checkout"&&subcommand!=="restore"&&subcommand!=="switch") return false;
    // Unscoped force/discard forms (e.g. `checkout -f <branch>`) discard the
    // whole worktree: always deny, never consult the before-snapshot, even if
    // an operand happens to name a file the role created. Belt and suspenders
    // alongside extractRestorePathspecs returning null for these forms.
    if(discardForm==="checkout --force"||discardForm==="switch --discard-changes") return false;
    const specs=extractRestorePathspecs(argumentList,commandIndex);
    if(!specs||specs.length===0) return false;
    for(let i=0;i<specs.length;i+=1){
      if(isBroadRestorePathspec(specs[i])) return false;
    }
    if(process.env&&((typeof process.env.GIT_DIR==="string"&&process.env.GIT_DIR)||(typeof process.env.GIT_WORK_TREE==="string"&&process.env.GIT_WORK_TREE))) return false;
    let snapshot=null;
    try{
      const snapshotUrl=new URL("./git-before-snapshot.json",scopeFileHref);
      snapshot=JSON.parse(fs.readFileSync(snapshotUrl,"utf8"));
    }catch(e){return false;}
    const files=(snapshot&&snapshot.files)||null;
    if(!files||typeof files!=="object") return false;
    let probeCwd=null;
    try{probeCwd=process.cwd();}catch(e){return false;}
    for(let i=0;i<argumentList.length;i+=1){
      const token=argumentList[i];
      if(token==="--git-dir"||token==="--work-tree") return false;
      if(typeof token==="string"&&(token.indexOf("--git-dir=")===0||token.indexOf("--work-tree=")===0)) return false;
      if(token==="-C"){
        const target=argumentList[i+1];
        if(typeof target==="string"&&target) probeCwd=path.resolve(probeCwd,target);
        i+=1;
      }
    }
    const allowNames={};
    const list=Array.isArray(envAllowlist)?envAllowlist:[];
    for(let k=0;k<list.length;k+=1){allowNames[String(list[k]).toUpperCase()]=true;}
    const probeEnv={};
    const srcEnv=process.env||{};
    for(const name of Object.keys(srcEnv)){
      if(allowNames[String(name).toUpperCase()]) probeEnv[name]=srcEnv[name];
    }
    let root=null;
    try{
      const r=spawnSync(realGit,["rev-parse","--show-toplevel"],{stdio:["ignore","pipe","pipe"],timeout:5000,env:probeEnv,shell:false,cwd:probeCwd});
      if(r.status!==0) return false;
      root=String(r.stdout||"").trim();
      if(!root) return false;
    }catch(e){return false;}
    for(let i=0;i<specs.length;i+=1){
      const absolute=path.resolve(probeCwd,String(specs[i]));
      let relative=path.relative(root,absolute).split(path.sep).join("/");
      if(relative===""||relative==="."||relative.indexOf("..")===0) return false;
      try{
        const st=fs.statSync(absolute);
        if(st.isDirectory()) return false;
      }catch(e){}
      const beforeHash=Object.prototype.hasOwnProperty.call(files,relative)?files[relative]:undefined;
      let current="MISSING";
      try{current=eolNormalizedFileHash(absolute);}catch(e){current="MISSING";}
      if(beforeHash===undefined){
        if(current==="MISSING") return false;
        continue;
      }
      if(current==="MISSING") continue;
      if(current!==beforeHash) continue;
      return false;
    }
    return true;
  }catch(e){return false;}
}

export function createGitMutationGuard(runDir,repositoryRoot=null){
  const guardDir=path.join(runDir,"git-guard");
  fs.mkdirSync(guardDir,{recursive:true});
  const logFile=path.join(guardDir,"blocked.log");
  const realGit=gitExecutable();

  // --- Layer 1: PATH shim -----------------------------------------------
  // Catches the common case (agent invokes plain "git ..." and relies on PATH).
  // Known gap: if the agent resolves an absolute git path itself, this layer
  // is skipped entirely. Layer 2 below does not depend on PATH at all.
  //
  // TASK 15.6J exception: the exact read-only `symbolic-ref` HEAD query is
  // structurally exempted (see isSafeSymbolicRefQuery in the generated
  // wrapper). symbolic-ref STAYS in BLOCKED_SUBCOMMANDS — the exemption is a
  // narrow allow-after-parse, never a reclassification.
  // Backlog #24: a guard never logs into another guard's log. The shim writes
  // only to the blocked.log beside itself (resolved at run time, so it holds when
  // the guard dir is mounted elsewhere); an inherited AUTOPILOT_GIT_GUARD_LOG from
  // an outer session is ignored. The one exception is the null device, which
  // explicitWrapperSource() sets on purpose to drop the orchestrator's own entries.
  const wrapper=path.join(guardDir,"git-guard.mjs");
  const blockedList=JSON.stringify([...BLOCKED_SUBCOMMANDS]);
  fs.writeFileSync(wrapper,`import fs from "node:fs"; import path from "node:path"; import {spawnSync} from "node:child_process"; import crypto from "node:crypto"; import {fileURLToPath} from "node:url";\nconst SCOPE_FILE=new URL("./git-scope.conf",import.meta.url);const GUARD_LOG=(()=>{const inherited=process.env.AUTOPILOT_GIT_GUARD_LOG;if(typeof inherited===\"string\"&&(process.platform===\"win32\"?inherited.toUpperCase()===\"NUL\":inherited===\"/dev/null\"))return inherited;return fileURLToPath(new URL(\"./blocked.log\",import.meta.url));})();const REAL_GIT=${JSON.stringify(realGit)};const GUARD_ENV_ALLOWLIST=${JSON.stringify(GUARD_ENV_ALLOWLIST)};if(process.argv[2]==="--autopilot-hook-scope-check"){let allow=false;try{allow=classifyGuardTarget(process.cwd(),SCOPE_FILE,process.env,REAL_GIT)==="outside";}catch{allow=false;}process.exit(allow?0:1);}\nif(process.argv[2]===\"--autopilot-hook-target\"){let t=\"unproven\";try{t=classifyGuardTarget(process.cwd(),SCOPE_FILE,process.env,REAL_GIT);}catch{}process.stdout.write(t);process.exit(0);}\nconst args=process.argv.slice(2);\nconst blocked=new Set(${blockedList});\nconst GLOBAL_VALUE_FLAGS=new Set(["-C","-c","--git-dir","--work-tree","--namespace","--super-prefix","--config-env"]);\nconst GLOBAL_VALUE_PREFIXES=[\"--git-dir=\",\"--work-tree=\",\"--namespace=\",\"--super-prefix=\",\"--config-env=\"];\nconst SAFE_SYMBOLIC_REF_OPTIONS=new Set([\"--quiet\",\"-q\",\"--short\",\"--no-recurse\"]);\nfunction isSafeSymbolicRefQuery(argumentList,commandIndex){\nlet operand=null;\nfor(let i=commandIndex+1;i<argumentList.length;i+=1){\nconst token=argumentList[i];\nif(token.startsWith(\"-\")){if(!SAFE_SYMBOLIC_REF_OPTIONS.has(token))return false;continue;}\nif(operand!==null)return false;\noperand=token;\n}\nreturn operand===\"HEAD\"||(typeof operand===\"string\"&&operand.startsWith(\"refs/\")&&operand.length>5);\n}\nconst MUTATING_BRANCH=new Set(["-d","-D","-m","-M","-c","-C","-f","--force","--delete","--move","--copy","--set-upstream-to","-u","--unset-upstream"]);\nconst READONLY_BRANCH_QUERY=new Set(["--list","-l","--show-current","--contains","--no-contains","--merged","--no-merged","--points-at","--format","-v","--verbose","-a","--all","-r","--remotes","--column","--sort"]);\nlet subcommandIndex=-1;\nfor(let index=0;index<args.length;index+=1){\n  const argument=args[index];\n  if(GLOBAL_VALUE_FLAGS.has(argument)){index+=1;continue;}\n  if(GLOBAL_VALUE_PREFIXES.some(prefix=>argument.startsWith(prefix)))continue;\n  if(argument.startsWith("-"))continue;\n  subcommandIndex=index;\n  break;\n}\nconst subcommand=subcommandIndex>=0?args[subcommandIndex]:null;\nlet readOnlyBranch=false;\nif(subcommand==="branch"){\n  const rest=args.slice(subcommandIndex+1);\n  readOnlyBranch=rest.some(a=>READONLY_BRANCH_QUERY.has(a.split("=")[0]))||(rest.every(a=>a.startsWith("-"))&&rest.every(a=>!MUTATING_BRANCH.has(a.split("=")[0])));\n}\nconst safeSymbolicRefQuery=subcommand===\"symbolic-ref\"&&subcommandIndex>=0&&isSafeSymbolicRefQuery(args,subcommandIndex);\nconst guardBlocks=!!(subcommand && blocked.has(subcommand) && !(subcommand===\"branch\"&&readOnlyBranch) && !safeSymbolicRefQuery);\nlet allowOutsideProtected=false;\nlet blockTarget="unproven";\nconst sanitizedArgs=stripOverridingConfigArgs(args,subcommandIndex);\nlet discardForm=null;\ntry{discardForm=classifyWorktreeDiscarding(args,subcommandIndex,function(operand){try{const allowNames={};for(let k=0;k<GUARD_ENV_ALLOWLIST.length;k+=1){allowNames[String(GUARD_ENV_ALLOWLIST[k]).toUpperCase()]=true;}const probeEnv={};const srcEnv=process.env||{};for(const name of Object.keys(srcEnv)){if(allowNames[String(name).toUpperCase()]){probeEnv[name]=srcEnv[name];}}const r=spawnSync(REAL_GIT,["rev-parse","--verify","--quiet",String(operand)+"^{commit}"],{stdio:["ignore","pipe","pipe"],timeout:5000,env:probeEnv,shell:false});return r.status===0;}catch(e){return false;}});}catch(e){discardForm=null;}\nif((guardBlocks||discardForm)&&SCOPE_FILE){\n  let probeCwd=process.cwd();\n  let gitDirOverride=null;\n  let workTreeOverride=null;\n  for(let index=0;index<args.length;index+=1){\n    const argument=args[index];\n    if(argument==="-C"){const target=args[index+1];if(typeof target==="string"&&target)probeCwd=path.resolve(probeCwd,target);index+=1;continue;}\n    if(argument==="--git-dir"){gitDirOverride=args[index+1];index+=1;continue;}\n    if(argument.startsWith("--git-dir=")){gitDirOverride=argument.slice("--git-dir=".length);continue;}\n    if(argument==="--work-tree"){workTreeOverride=args[index+1];index+=1;continue;}\n    if(argument.startsWith("--work-tree=")){workTreeOverride=argument.slice("--work-tree=".length);continue;}\n  }\n  const probeEnv={...process.env};\n  if(typeof gitDirOverride==="string"&&gitDirOverride)probeEnv.GIT_DIR=gitDirOverride;\n  if(typeof workTreeOverride==="string"&&workTreeOverride)probeEnv.GIT_WORK_TREE=workTreeOverride;\n  try{const wrappedClassification=classifyGuardTarget(probeCwd,SCOPE_FILE,probeEnv,REAL_GIT);allowOutsideProtected=wrappedClassification==="outside";blockTarget=allowOutsideProtected?"unproven":wrappedClassification;}catch{allowOutsideProtected=false;blockTarget="unproven";}\n}\nlet snapshotAllowsRestore=false;\ntry{if(discardForm&&!guardBlocks&&!allowOutsideProtected){snapshotAllowsRestore=guardBeforeSnapshotAllows(args,subcommandIndex,discardForm,SCOPE_FILE.href,REAL_GIT,GUARD_ENV_ALLOWLIST)===true;}}catch{snapshotAllowsRestore=false;}\nif((guardBlocks||discardForm)&&!allowOutsideProtected&&!snapshotAllowsRestore){\n  fs.appendFileSync(GUARD_LOG,JSON.stringify({time:new Date().toISOString(),args:args,layer:"path-shim",subcommand:subcommand,reason:discardForm?"worktree-restore":"history-ref-mutation",form:discardForm||subcommand,target:blockTarget})+"\\n");\n  console.error("AUTOPILOT GIT GUARD: '"+subcommand+"' is forbidden ("+(discardForm?"worktree restore":"history/ref mutation")+").");\n  process.exit(97);\n}\nconst env={...process.env};\nconst result=spawnSync(REAL_GIT,sanitizedArgs,{stdio:"inherit",shell:false,env});\nif(result.error){console.error(result.error.message);process.exit(127);}\nprocess.exit(result.status??1);\n`);
  // TASK 6: embed the Layer-1 scoping helpers. Function declarations are
  // hoisted, so the wrapper body above can call them; all are closure-free by
  // design. The GUARD_ENV_ALLOWLIST they consult is emitted at the TOP of the
  // wrapper (not here) — a `const` appended after the body would still be in its
  // temporal dead zone when the body runs, which would make every decision fail
  // closed.
  fs.appendFileSync(wrapper,"\n"+normalizeGuardPath.toString()+"\n"+isOutsideProtectedIdentity.toString()+"\n"+classifyGuardTarget.toString()+"\n"+classifyWorktreeDiscarding.toString()+"\n"+stripOverridingConfigArgs.toString()+"\n"+hashBytes.toString()+"\n"+eolNormalizedFileHash.toString()+"\n"+extractRestorePathspecs.toString()+"\n"+isBroadRestorePathspec.toString()+"\n"+guardBeforeSnapshotAllows.toString()+"\n");

  // TASK 6 (review round 2): the environment is reduced to an explicit
  // allowlist BEFORE Node is started, in both shims and in every deny hook. The
  // shim cannot rely on the guard code to do this: NODE_OPTIONS/LD_PRELOAD et
  // al. are applied by the interpreter before any guard code runs.
  const envBinary=(()=>{
    const probe=process.platform==="win32"?run("where.exe",["env"],{cwd:process.cwd()}):run("which",["env"],{cwd:process.cwd()});
    return (probe.stdout||"").split(/\r?\n/).map(x=>x.trim()).find(Boolean)||"";
  })();
  const envPrologue=gitGuardEnvPrologue(envBinary);
  if(process.platform!=="win32"){
    const unixShim=path.join(guardDir,"git");
    // Read-only fast path: gitGuardFastPathShellFragment() renders the strict
    // POSIX classifier into the shim. It drops one leading
    // `-c core.autocrlf=input` pair (mirroring stripOverridingConfigArgs),
    // then execs the baked real git for the five unconditional reads plus the
    // narrow config / symbolic-ref / worktree-list / cat-file / diff-log-show
    // shapes that pass its argv checks. Anything else returns 1 and falls
    // through to the Node wrapper for the full decision; a fast attempt whose
    // sanitized environment cannot be built returns 2 and fails closed with
    // exit 97. Layer 2 (hooks) is unchanged and applies to every git run,
    // fast path included.
    fs.writeFileSync(unixShim,`#!/bin/sh\n# AUTOPILOT GIT GUARD — PATH shim. Fails closed if the sanitized environment\n# cannot be built (autopilot_guard_exec returns non-zero).\n${envPrologue}\n${gitGuardRealGitExecPrologue(realGit)}\n${gitGuardFastPathShellFragment()}\n_apg_fast "$@"\n_apg_fast_status=$?\nif [ "$_apg_fast_status" = 0 ]; then\n  exit 0\nfi\nif [ "$_apg_fast_status" != 1 ]; then\n  echo "AUTOPILOT GIT GUARD: refusing to run without a sanitized environment." >&2\n  exit 97\nfi\nautopilot_guard_exec "${process.execPath}" "$(dirname "$0")/git-guard.mjs" "$@" || {\n  echo "AUTOPILOT GIT GUARD: refusing to run without a sanitized environment." >&2\n  exit 97\n}\nexit 97\n`);
    fs.chmodSync(unixShim,0o755);
  } else {
    // Windows: only the five unconditional read-only subcommands skip Node.
    // %~1 comparison in cmd is case-sensitive (no /i), so only an exact match
    // takes the fast path; every subcommand that needs an argv check
    // (diff/log/show, cat-file, config, symbolic-ref, worktree) falls through
    // to the Node wrapper. The windowsShimSanitizer() loop above has already
    // reduced this process environment to GUARD_ENV_ALLOWLIST, so the baked
    // real git runs under exactly the sanitized environment the Node wrapper
    // would inherit. Arguments are forwarded verbatim via %* exactly as the
    // Node path receives them. Layer 2 (hooks) is unchanged.
    const fast = GIT_GUARD_WINDOWS_FAST_SUBCOMMANDS
      .map(sub=>`if "%~1"=="${sub}" goto :apg_fast\r\n`).join("");
    fs.writeFileSync(path.join(guardDir,"git.cmd"),`${windowsShimSanitizer()}\r\n${fast}"${process.execPath}" "${wrapper}" %*\r\nexit /b %errorlevel%\r\n:apg_fast\r\n"${realGit}" %*\r\nexit /b %errorlevel%\r\n`);
  }
  const explicitWrapper=path.join(guardDir,"git-guard-explicit.mjs");
  fs.writeFileSync(explicitWrapper,explicitWrapperSource(wrapper));

  // --- Layer 2: git hooks via env-scoped core.hooksPath ------------------
  // GIT_CONFIG_COUNT/KEY/VALUE (git >= 2.31) override repo config for this
  // process tree only, without touching .git/config. Any "git" binary the
  // agent calls (PATH-resolved or absolute path) will honor these hooks,
  // because hooks fire based on git's own config resolution, not on how the
  // binary was located. reference-transaction is the catch-all: it fires for
  // *any* ref update (branch move, tag, commit-tree+update-ref combo, merge,
  // rebase, cherry-pick, ...), not just plain "commit"/"push".
  //
  // SCOPE (TASK 15.6I): reference-transaction enforcement protects ONLY the
  // official repository identities recorded in git-scope.conf (canonical
  // worktree root, per-worktree git dir, common git dir, linked-worktree
  // metadata). A transaction whose git directory resolves conclusively
  // outside every protected identity is allowed silently (this is what lets
  // an external tool's `git init` with an outside GIT_DIR succeed).
  //
  // SCOPE (TASK 6): the Layer-1 PATH-shim subcommand blocklist and the four
  // deny hooks below (pre-commit, pre-push, pre-rebase, pre-merge-commit) are
  // now scoped by the SAME protected identity — see isOutsideProtectedIdentity
  // and the wrapper's --autopilot-hook-scope-check mode. They no longer deny
  // globally; anything unresolved still denies. Without this, a disposable
  // fixture repository's own `git init`/`git commit` (run by a read-only role's
  // test suite) was blocked as if it targeted the protected repo.
  const hooksDir=path.join(guardDir,"hooks");
  fs.mkdirSync(hooksDir,{recursive:true});
  const trustedHookLog=shellLiteral(logFile);
  for(const hook of ["pre-commit","pre-push","pre-rebase","pre-merge-commit"]){
    const p=path.join(hooksDir,hook);
    fs.writeFileSync(p,denyHook(hook,trustedHookLog,envPrologue));
    fs.chmodSync(p,0o755);
  }
  // Protected identity comes from trusted guard-creation data (resolved here
  // via git itself, stored in a guard-dir file the hook reads path-relatively
  // like blocked.log). It is NEVER taken from process environment, so a
  // child/model cannot relocate or shrink it with GIT_DIR, GIT_WORK_TREE,
  // GIT_CONFIG_* or AUTOPILOT_* overrides. repositoryRoot==null — or a root
  // whose identity cannot be resolved (not a repository, unreadable git dir)
  // — leaves no identity file behind, and the hook fails closed (denies every
  // prepared transaction with reason missing-identity) when the file is
  // missing, unreadable or malformed. Failing closed at ENFORCEMENT time
  // (rather than throwing here) preserves the long-standing contract that
  // guard creation itself never validates the repository: callers that only
  // need the guard's filesystem shape / environment (e.g. envelope path
  // mapping tests over non-repo fixtures) keep working, while no ref
  // transaction can ever slip through unidentified.
  let scopeFile=null;
  let protectedIdentity=null;
  if(repositoryRoot){
    try{
      protectedIdentity=resolveProtectedGitIdentity(repositoryRoot);
      scopeFile=path.join(guardDir,"git-scope.conf");
      fs.writeFileSync(scopeFile,renderGitScopeFile(protectedIdentity));
    }catch{
      scopeFile=null;
      protectedIdentity=null;
    }
  }
  const refTxnHook=path.join(hooksDir,"reference-transaction");
  fs.writeFileSync(refTxnHook,referenceTransactionHookSource());
  fs.chmodSync(refTxnHook,0o755);

  return {
    guardDir,logFile,realGit,hooksDir,wrapper:explicitWrapper,pathShimWrapper:wrapper,
    repositoryRoot:repositoryRoot?path.resolve(repositoryRoot):null,
    scopeFile,protectedIdentity,
    prependPath:(process.env.PATH?guardDir+path.delimiter+process.env.PATH:guardDir)
  };
}

function explicitWrapperSource(pathShimWrapper){
  const pathShimTarget=JSON.stringify(pathShimWrapper);
  return `import {spawnSync} from "node:child_process";\nconst childEnvironment={...process.env,AUTOPILOT_GIT_GUARD_LOG:process.platform==="win32"?"NUL":"/dev/null"};\nconst guardProcess=spawnSync(process.execPath,[${pathShimTarget},...process.argv.slice(2)],{stdio:"inherit",shell:false,env:childEnvironment});\nif(guardProcess.error){console.error(guardProcess.error.message);process.exit(127);}\nprocess.exit(guardProcess.status??1);\n`;
}

function denyHook(hook,trustedHookLog,envPrologue){
  // Path-relative to the hook: <guard>/hooks/<hook> -> <guard>/*. Works on the
  // host and when the guard dir is bind-mounted into the bubblewrap envelope;
  // never redirectable via child environment.
  //
  // TASK 6: these hooks (pre-commit/pre-push/pre-rebase/pre-merge-commit) used
  // to deny unconditionally, which meant a disposable fixture repository's own
  // `git commit` was blocked even though the reference-transaction hook and
  // Layer 1 correctly scope to the protected identity. They now consult the
  // SAME shared scoping decision (the shim's --autopilot-hook-scope-check mode,
  // which embeds isOutsideProtectedIdentity) and deny only when the target is
  // not provably outside the protected repository — so anything unresolved
  // still denies, exactly as before.
  //
  // TASK 6 (review round 2): Node is started through autopilot_guard_exec, which
  // reduces the environment to GUARD_ENV_ALLOWLIST first. Starting Node with the
  // hook's own environment let a caller-supplied NODE_OPTIONS preload exit 0
  // during --autopilot-hook-scope-check and turn a protected push into an
  // allowed one. If the sanitized environment cannot be built, the hook denies
  // (the `&&` never fires).
  return `#!/bin/sh\n${envPrologue}\nCHECK="$(dirname "$0")/../git-guard.mjs"\nT=unproven\nif [ -f "$CHECK" ]; then\n  ( autopilot_guard_exec "${process.execPath}" "$CHECK" --autopilot-hook-scope-check ) >/dev/null 2>&1 && exit 0\n  T=$( ( autopilot_guard_exec "${process.execPath}" "$CHECK" --autopilot-hook-target ) 2>/dev/null )\n  case "$T" in protected|outside) ;; *) T=unproven;; esac\nfi\nLOG="$(dirname "$0")/../blocked.log"\necho '{"layer":"hook","hook":"${hook}","target":"'"$T"'"}' >> "$LOG"\necho "AUTOPILOT GIT GUARD: blocked by ${hook} hook" >&2\nexit 1\n`;
}

// Canonical form shared by the Node side (scope-file writer) and the shell
// side (reference-transaction hook, which reimplements the same steps — see
// referenceTransactionHookSource). Both sides MUST agree byte-for-byte:
// backslashes become forward slashes, a leading MSYS-style "/c/..." drive
// becomes "c:/...", drive letters fold to lowercase, trailing slashes are
// stripped, and on case-insensitive platforms (win32/darwin, decided at
// guard creation and stored as foldCase) the whole string folds to lowercase.
export function normalizeGuardPath(candidate,foldCase){
  let s=String(candidate).replace(/\\/g,"/");
  const msys=s.match(/^\/([A-Za-z])\/(.*)$/);
  if(msys) s=`${msys[1].toLowerCase()}:/${msys[2]}`;
  else {
    const drive=s.match(/^([A-Za-z]):(\/.*)?$/);
    if(drive) s=`${drive[1].toLowerCase()}:${drive[2]||"/"}`;
  }
  while(s.length>1&&s.endsWith("/")) s=s.slice(0,-1);
  if(s==="") s="/";
  if(foldCase) s=s.toLowerCase();
  return s;
}

// TASK 6 — Layer-1 scoping decision, shared with the generated PATH-shim
// wrapper, which embeds this function's source verbatim (its declaration is
// therefore kept closure-free: parameters plus the module-level `fs`,
// `spawnSync` and `normalizeGuardPath` only; the wrapper imports the first two
// and embeds the third alongside it). Returns true ONLY when the invocation's
// OWN target repository resolves conclusively and lies outside every protected
// identity recorded in `scopeFile`. Every missing/unreadable/malformed scope
// file, every unresolvable or uncanonicalizable target, and every overlap
// returns false — which the caller treats as "protected" and blocks exactly as
// it did before this change. This mirrors the shell hook's
// norm/canon/protected_hit rules (referenceTransactionHookSource); the two
// MUST agree.
//
// `cwdForRevParse` is the directory git itself would run in (already resolved
// through any leading `-C`), `environment` is the environment git would see
// (already carrying any `--git-dir`/`--work-tree`/`GIT_DIR`/`GIT_WORK_TREE`
// override), and `gitBinary` is the BAKED real git executable supplied by the
// caller. The binary is never taken from the child's environment (a
// child-controlled interpreter could forge the probe answers and then delegate
// to real git with the guard's hooks stripped) and never PATH-resolved (which
// at enforcement time would re-enter the shim itself). Every probe is bounded
// by PROBE_TIMEOUT_MS, and the probe environment is sanitized to just the two
// repository-locating variables git itself honours, so no other child-supplied
// variable can redirect identity resolution.
export function isOutsideProtectedIdentity(cwdForRevParse,scopeFile,environment,gitBinary){
  return classifyGuardTarget(cwdForRevParse,scopeFile,environment,gitBinary)==="outside";
}

// Same probes and rules as isOutsideProtectedIdentity, as a three-state
// classification so the blocked.log entry can say WHY the call was denied.
// "outside" — target resolved conclusively and lies outside every protected
// identity; "protected" — target resolved and overlaps a protected identity
// (equal, nested either way); "unproven" — missing/malformed scope file,
// empty protected identity, probe timeout, or unresolvable target. Only
// "outside" is ever allowed through — the two deny categories never widen
// what counts as outside. This function is closure-free like its siblings so
// the PATH-shim wrapper can embed its source verbatim next to theirs.
export function classifyGuardTarget(cwdForRevParse,scopeFile,environment,gitBinary){
  const platformFold=process.platform==="win32"||process.platform==="darwin";
  // Trust path: the executable is the BAKED real git handed in by the caller,
  // or nothing. It is never resolved from the child's environment — a
  // child-controlled interpreter could otherwise answer the probes with a
  // forged identity and then delegate to real git with the guard's hooks
  // stripped. With no usable binary every probe fails and we fail closed.
  const binary=typeof gitBinary==="string"&&gitBinary?gitBinary:"";
  // Every probe is bounded: an unbounded spawnSync would be a hang path the
  // caller could use to stall the guard (and therefore the whole role).
  const PROBE_TIMEOUT_MS=10000;
  // The probe environment is the same explicit GUARD_ENV_ALLOWLIST the shell
  // side uses — an allowlist, never a blacklist of known-bad names (which is
  // always incomplete: NODE_OPTIONS, LD_PRELOAD, DYLD_*, GIT_COMMON_DIR,
  // GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES,
  // GIT_CEILING_DIRECTORIES, GIT_DISCOVERY_ACROSS_FILESYSTEM, GIT_INDEX_FILE,
  // GIT_NAMESPACE, GIT_PREFIX, GIT_CONFIG_*, and every AUTOPILOT_* variable are
  // all simply not on it). GIT_DIR/GIT_WORK_TREE are on it because git itself
  // honours them and the decision must match what git would do; they are
  // already folded into `environment` by the caller.
  const allowedNames=new Set(GUARD_ENV_ALLOWLIST.map(name=>name.toUpperCase()));
  const probeBase={};
  for(const [name,value] of Object.entries(environment||{})){
    if(allowedNames.has(name.toUpperCase())) probeBase[name]=value;
  }
  // --- Scope file. Missing/unreadable/malformed is never "safe": fail closed.
  let text;
  try{text=fs.readFileSync(scopeFile,"utf8");}
  catch{return "unproven";}
  const lines=String(text).split(/\r?\n/);
  let sawHeader=false;
  let fold=platformFold;
  let protectedGitDir=null;
  let protectedCommon=null;
  const protectedEntries=[];
  for(const raw of lines){
    const line=raw.trim();
    if(!line||line.startsWith("#")) continue;
    if(!sawHeader){
      if(line==="v1 fold=0"){sawHeader=true;fold=false;continue;}
      if(line==="v1 fold=1"){sawHeader=true;fold=true;continue;}
      return "unproven";
    }
    const eq=line.indexOf("=");
    if(eq<1) return "unproven";
    const key=line.slice(0,eq);
    const value=line.slice(eq+1);
    if(key!=="root"&&key!=="gitdir"&&key!=="common"&&key!=="wtpath"&&key!=="wtgit") return "unproven";
    if(!value) return "unproven";
    if(!(value.startsWith("/")||/^[A-Za-z]:\//.test(value))) return "unproven";
    if(key==="gitdir") protectedGitDir=value;
    if(key==="common") protectedCommon=value;
    protectedEntries.push(value);
  }
  if(!sawHeader||!protectedGitDir||!protectedCommon) return "unproven";
  let scopeDir;
  try{scopeDir=fs.realpathSync(scopeFile).replace(/[\\/][^\\/]*$/,"");}
  catch{return "unproven";}
  // --- Positive proof that the protected repository can be NAMED in this
  // process's coordinate system. The scope file records guard-creation-time
  // paths; inside the bubblewrap envelope the repository is remounted (e.g.
  // /workspace/repository), so those host paths no longer resolve to anything.
  // The guard's OWN directory is the one identity that survives that remap: for
  // every production caller it lives inside the protected repository, so
  // resolving the repository that physically contains it yields the protected
  // identity in whatever coordinate system this process sees. If neither the
  // recorded host paths nor the guard directory can name a protected
  // repository, nothing can be proven "outside" and we fail closed.
  const scopeEntriesExist=protectedEntries.some((entry)=>{try{return fs.existsSync(entry);}catch{return false;}});
  // The ambient probe must describe the repository that physically contains
  // the guard directory, so the caller's GIT_DIR/GIT_WORK_TREE are dropped too.
  const ambientEnv={...probeBase};
  delete ambientEnv.GIT_DIR;
  delete ambientEnv.GIT_WORK_TREE;
  const ambient=(args)=>{
    const r=spawnSync(binary,args,{cwd:scopeDir,env:ambientEnv,timeout:PROBE_TIMEOUT_MS,encoding:"utf8",stdio:["ignore","pipe","pipe"],shell:false});
    return r.status===0?String(r.stdout||"").trim():"";
  };
  const ambientEntries=[];
  for(const candidate of [
    ambient(["rev-parse","--path-format=absolute","--absolute-git-dir"]),
    ambient(["rev-parse","--path-format=absolute","--git-common-dir"]),
    ambient(["rev-parse","--show-toplevel"])
  ]){
    if(!candidate) continue;
    try{ambientEntries.push(normalizeGuardPath(fs.realpathSync(candidate),fold));}
    catch{ /* unresolvable ambient path: simply not added */ }
  }
  if(!scopeEntriesExist&&!ambientEntries.length) return "unproven";
  for(const entry of ambientEntries) protectedEntries.push(entry);
  // --- Resolve THIS invocation's target exactly as git would resolve it.
  const probe=(args)=>{
    const r=spawnSync(binary,args,{cwd:cwdForRevParse,env:{...probeBase},timeout:PROBE_TIMEOUT_MS,encoding:"utf8",stdio:["ignore","pipe","pipe"],shell:false});
    return {status:r.status,stdout:(r.stdout||"").trim()};
  };
  const gitDirProbe=probe(["rev-parse","--path-format=absolute","--absolute-git-dir"]);
  if(gitDirProbe.status!==0||!gitDirProbe.stdout) return "unproven";
  const commonProbe=probe(["rev-parse","--path-format=absolute","--git-common-dir"]);
  if(commonProbe.status!==0||!commonProbe.stdout) return "unproven";
  // --show-toplevel legitimately fails for a bare repository; mirroring the
  // hook, an absent toplevel is simply "no worktree identity" — it is only
  // consulted when present.
  const topProbe=probe(["rev-parse","--show-toplevel"]);
  const canonical=(candidate)=>{
    try{return normalizeGuardPath(fs.realpathSync(candidate),fold);}
    catch{return null;}
  };
  const resolved=[];
  for(const candidate of [gitDirProbe.stdout,commonProbe.stdout]){
    const normalized=canonical(candidate);
    if(normalized===null) return "unproven";
    resolved.push(normalized);
  }
  if(topProbe.status===0&&topProbe.stdout){
    const normalized=canonical(topProbe.stdout);
    if(normalized===null) return "unproven";
    resolved.push(normalized);
  }
  // --- Containment, identical to the hook's protected_hit: equal, candidate
  // nested under a protected entry, or a protected entry nested under the
  // candidate (a parent directory that contains the protected repository).
  for(const candidate of resolved){
    for(const protectedEntry of protectedEntries){
      if(candidate===protectedEntry||candidate.startsWith(protectedEntry+"/")||protectedEntry.startsWith(candidate+"/")) return "protected";
    }
  }
  return "outside";
}

// Resolve the protected git identities for the official repository. Throws
// (fail closed at guard creation) when any identity cannot be resolved — a
// guard that cannot name what it protects must not exist. Returned paths are
// realpath-resolved (symlinks/junctions eliminated at creation time; the
// hook re-resolves at enforcement time) and pre-normalized with
// normalizeGuardPath so the shell hook only has to repeat normalization,
// never invent it.
export function resolveProtectedGitIdentity(repositoryRoot){
  const cwd=path.resolve(repositoryRoot);
  const fail=(what,detail)=>{throw new Error(`Git guard: cannot resolve protected repository identity at ${cwd} (${what}${detail?`: ${detail}`:""}). Failing closed.`);};
  let gitDirRaw;
  try{gitDirRaw=gitOut(cwd,["rev-parse","--absolute-git-dir"]).toString().trim();}
  catch(error){fail("git-dir",error?.message);}
  if(!gitDirRaw) fail("git-dir","empty rev-parse output");
  let commonRaw=null;
  try{commonRaw=gitOut(cwd,["rev-parse","--path-format=absolute","--git-common-dir"]).toString().trim();}
  catch{commonRaw=null;}
  if(!commonRaw){
    try{commonRaw=path.resolve(cwd,gitOut(cwd,["rev-parse","--git-common-dir"]).toString().trim());}
    catch(error){fail("common-dir",error?.message);}
  }
  // --show-toplevel legitimately fails for bare repositories (no worktree);
  // null root simply means "no worktree identity to protect", not an error.
  let topRaw=null;
  try{
    const top=gitOutAllowing(cwd,["rev-parse","--show-toplevel"],[0,1,128]);
    if(top.status===0&&top.stdout.toString().trim()) topRaw=top.stdout.toString().trim();
  }catch(error){fail("worktree-root",error?.message);}
  const foldCase=(process.platform==="win32"||process.platform==="darwin")?1:0;
  const real=(p,what)=>{
    try{return normalizeGuardPath(fs.realpathSync(p),foldCase);}
    catch(error){fail(what,`${p}: ${error?.message}`);}
  };
  const identity={version:1,foldCase,root:topRaw?real(topRaw,"worktree-root"):null,gitDir:real(gitDirRaw,"git-dir"),commonDir:real(commonRaw,"common-dir"),worktrees:[]};
  // Linked-worktree metadata: every registered worktree contributes its
  // worktree path and its per-worktree git dir. Worktrees added AFTER guard
  // creation are still covered because their git dirs always live under the
  // protected common dir (<common>/worktrees/<name>), which the hook checks
  // by containment.
  let porcelain;
  try{porcelain=gitOut(cwd,["worktree","list","--porcelain"]).toString("utf8");}
  catch(error){fail("worktree-list",error?.message);}
  const seen=new Set([identity.root,identity.gitDir].filter(Boolean));
  for(const line of porcelain.split(/\r?\n/)){
    if(!line.startsWith("worktree ")) continue;
    const wtPath=line.slice("worktree ".length).trim();
    if(!wtPath) continue;
    let wtGit;
    try{wtGit=gitOut(wtPath,["rev-parse","--absolute-git-dir"]).toString().trim();}
    catch{fail("linked-worktree-git-dir",wtPath);}
    const normPath=real(wtPath,"linked-worktree-path");
    const normGit=real(wtGit,"linked-worktree-git-dir");
    if(seen.has(normPath+":"+normGit)) continue;
    seen.add(normPath+":"+normGit);
    identity.worktrees.push({path:normPath,gitDir:normGit});
  }
  if(!identity.gitDir||!identity.commonDir) fail("empty-identity","gitdir/common missing after canonicalization");
  return identity;
}

export function renderGitScopeFile(identity){
  if(!identity||identity.version!==1||!identity.gitDir||!identity.commonDir) throw new Error("Git guard: refusing to render an incomplete protected identity. Failing closed.");
  const lines=[`v1 fold=${identity.foldCase?1:0}`];
  if(identity.root) lines.push(`root=${identity.root}`);
  lines.push(`gitdir=${identity.gitDir}`);
  lines.push(`common=${identity.commonDir}`);
  for(const wt of identity.worktrees||[]){
    if(!wt.path||!wt.gitDir) throw new Error("Git guard: refusing to render an incomplete linked-worktree identity. Failing closed.");
    lines.push(`wtpath=${wt.path}`);
    lines.push(`wtgit=${wt.gitDir}`);
  }
  return lines.join("\n")+"\n";
}

// TASK 16 — sandbox-side protected identity for the Layer-1 scope check.
//
// Inside the bubblewrap envelope the repository is remounted at
// `/workspace/repository` while the guard directory itself lives under the
// sibling `/workspace/scratch` bind, so neither the host paths recorded in
// `git-scope.conf` (`fs.existsSync(entry)` is false for all of them) nor the
// A2 ambient guard-dir probe (no enclosing repository under the scratch
// mount) can name a protected repository — and `isOutsideProtectedIdentity`
// fails closed for every commit-family subcommand. This helper records the
// sandbox-side repository path as an ADDITIONAL `root=` entry alongside (not
// instead of) the host paths `resolveProtectedGitIdentity()` already wrote,
// so the existing `scopeEntriesExist`-equivalent proof succeeds inside the
// sandbox exactly as it does on the host.
//
// Additive data only: the appended entry is consumed by the EXISTING
// containment loop in `isOutsideProtectedIdentity` (equal-or-nested-either-
// direction) with no changes to that logic, matching A2's "ambient probe is
// best-effort and can only ever add protected entries, never subtract" rule.
//
// The key name is not a free choice: the scope-file parser rejects any line
// whose key isn't exactly root/gitdir/common/wtpath/wtgit, so a new key
// would fail the whole parse closed. Only `root=` is appended: the file
// already carries real `gitdir=`/`common=` lines satisfying the parser's
// completeness check, and recording a guessed sandbox git-dir/common-dir
// would be actively wrong for a linked worktree (its git-dir lives under
// the main repo's common dir, elsewhere). `root=` makes no structural claim
// about internal git layout; a linked-worktree target stays protected
// either way (its --show-toplevel candidate still matches `root=`
// directly, and an unresolvable git-dir/common-dir candidate keeps the
// function's own "candidate required, unresolvable -> block" rule).
//
// `sandboxRepositoryPath` is supplied by trusted orchestrator code (the
// envelope's own `sandbox.repository`, threaded through `runRelay` in
// `autopilot.mjs`), never derived from child-controlled environment or
// arguments — same trust model as `REAL_GIT` in TASK-6/A3.
//
// Fail-closed contract: throws (before any write) when `scopeFile` is
// missing/unreadable, when `sandboxRepositoryPath` isn't an absolute path,
// or when it contains `\n`/`\r` (the scope-file format is one `key=value`
// per line; an embedded newline would forge a second, attacker-shaped
// line). Every rejection leaves the scope file byte-for-byte unmodified —
// no partial write from a failed call. An unwritable scope file likewise
// throws via the append itself.
export function appendGuardScopeRoot(scopeFile, sandboxRepositoryPath){
  if(typeof sandboxRepositoryPath!=="string"||!sandboxRepositoryPath) throw new Error("Git guard: refusing to append an empty sandbox repository path. Failing closed.");
  if(sandboxRepositoryPath.includes("\n")||sandboxRepositoryPath.includes("\r")) throw new Error("Git guard: refusing to append a sandbox repository path containing a line break. Failing closed.");
  if(typeof scopeFile!=="string"||!scopeFile) throw new Error("Git guard: refusing to append a sandbox scope entry without a scope file. Failing closed.");
  // Normalize to the scope file's canonical form BEFORE validating: the
  // parser only accepts values starting with `/` or `X:/`, so a native
  // `C:\...` spelling appended verbatim would poison the whole file into
  // fail-closed (blocking even previously-working host invocations). The
  // shared normalizeGuardPath keeps this consistent with how the host
  // entries were written and how invocation candidates are canonicalized;
  // for the production literal (`/workspace/repository`) it is the identity.
  const normalized=normalizeGuardPath(sandboxRepositoryPath,process.platform==="win32"||process.platform==="darwin");
  if(!(normalized.startsWith("/")||/^[A-Za-z]:\//.test(normalized))) throw new Error(`Git guard: refusing to append a non-absolute sandbox repository path (${sandboxRepositoryPath}). Failing closed.`);
  let previous;
  try{
    previous=fs.readFileSync(scopeFile,"utf8");
  }catch(error){
    throw new Error(`Git guard: cannot append sandbox scope entry (scope file missing/unreadable at ${scopeFile}). Failing closed.`);
  }
  const separator=previous.length&&!previous.endsWith("\n")&&!previous.endsWith("\r")?"\n":"";
  fs.appendFileSync(scopeFile,`${separator}root=${normalized}\n`);
}

// POSIX-sh source for the repository-scoped reference-transaction hook.
// Embedded as an array join (never a JS template literal) so shell `$`
// sequences pass through untouched. Runs under /bin/sh (dash) on Linux and
// Git-for-Windows sh on native Windows: no bashisms, no jq, no node.
//
// Decision (prepared state only; committed/aborted always exit 0):
//  1. Load git-scope.conf via the hook's own directory (trusted, path-
//     relative — never from environment). Missing/unreadable/malformed ->
//     deny (fail closed).
//  2. Fast path: `git rev-parse` resolves the transaction's git dir, common
//     dir and (unless bare) worktree. Each is canonicalized (symlinks,
//     junctions, `..`, MSYS/Windows spelling) and normalized exactly like
//     normalizeGuardPath. Git-dir/common-dir overlap with any protected
//     identity always denies. When both are external, a protected worktree
//     denies only a transaction that actually supplied ref input; an empty
//     prepared transaction is administrative bookkeeping in the external
//     repository and must not be reclassified by GIT_WORK_TREE.
//  3. Init path: rev-parse FAILS while `git init` creates a repository
//     (no HEAD exists yet at the prepared instant — verified empirically).
//     Then only an EXPLICIT external GIT_DIR (env or --git-dir flag, which
//     git exports as GIT_DIR to hooks) naming a git dir conclusively
//     outside every protected identity may proceed — this is precisely the
//     external-snapshot `git init` mechanism. No GIT_DIR, unresolvable
//     GIT_DIR, or overlap -> deny. A plain `git init` inside the official
//     worktree (nested repository) therefore stays blocked.
// A ref transaction mutates refs inside a GIT DIR, so scoping is git-dir
// centric: the ambient cwd/worktree of an explicit-external-GIT_DIR init is
// deliberately NOT consulted (the tool's cwd is routinely inside the
// official worktree and git writes no refs there). For an already-resolved
// repository, ref input distinguishes an external empty administrative
// transaction from a ref update whose worktree identity must still protect
// the official repository.
function referenceTransactionHookSource(){
  const sh=[
    "#!/bin/sh",
    "# AUTOPILOT GIT GUARD — reference-transaction, scoped to the official",
    "# repository identities in git-scope.conf. Fail closed on anything",
    "# unresolved, malformed, ambiguous or overlapping. See relay-guards.mjs.",
    "if [ \"$1\" != \"prepared\" ]; then",
    "  exit 0",
    "fi",
    "# Consume stdin before invoking helpers: child processes must never race",
    "# Git for the prepared ref records. A final record without a newline is",
    "# still transaction input; only immediate EOF is empty.",
    "REF_TXN_STDIN_HAS_DATA=0",
    "REF_TXN_LINE=\"\"",
    "if IFS= read -r REF_TXN_LINE; then",
    "  REF_TXN_STDIN_HAS_DATA=1",
    "elif [ -n \"$REF_TXN_LINE\" ]; then",
    "  REF_TXN_STDIN_HAS_DATA=1",
    "fi",
    "while IFS= read -r REF_TXN_LINE || [ -n \"$REF_TXN_LINE\" ]; do",
    "  REF_TXN_STDIN_HAS_DATA=1",
    "  REF_TXN_LINE=\"\"",
    "done",
    "HOOK_DIR=$(dirname \"$0\")",
    "IDENT=\"$HOOK_DIR/../git-scope.conf\"",
    "LOG=\"$HOOK_DIR/../blocked.log\"",
    "clean() {",
    "  printf '%s' \"$1\" | tr -d '\\n\"' 2>/dev/null",
    "}",
    "deny() {",
    "  R=$(clean \"$1\")",
    "  C=$(clean \"$2\")",
    "  M=$(clean \"$3\")",
    "  T=unproven",
    "  if [ \"$R\" = \"protected-ref\" ]; then T=protected; fi",
    "  printf '%s\\n' \"{\\\"layer\\\":\\\"hook\\\",\\\"hook\\\":\\\"reference-transaction\\\",\\\"scope\\\":\\\"official\\\",\\\"reason\\\":\\\"$R\\\",\\\"gitDir\\\":\\\"$C\\\",\\\"match\\\":\\\"$M\\\",\\\"target\\\":\\\"$T\\\"}\" >> \"$LOG\"",
    "  echo \"AUTOPILOT GIT GUARD: ref update blocked (reference-transaction)\" >&2",
    "  exit 1",
    "}",
    "norm() {",
    "  N=$(printf '%s' \"$1\" | tr '\\\\' '/')",
    "  case \"$N\" in",
    "    /[A-Za-z]/*)",
    "      D=$(printf '%s' \"$N\" | cut -c2 | tr 'A-Z' 'a-z')",
    "      R=$(printf '%s' \"$N\" | cut -c3-)",
    "      N=\"$D:/$R\"",
    "      ;;",
    "  esac",
    "  case \"$N\" in",
    "    [A-Za-z]:/*)",
    "      D=$(printf '%s' \"$N\" | cut -c1 | tr 'A-Z' 'a-z')",
    "      R=$(printf '%s' \"$N\" | cut -c2-)",
    "      N=\"$D$R\"",
    "      ;;",
    "  esac",
    "  while :; do",
    "    case \"$N\" in",
    "      */) N=${N%/};;",
    "      *) break;;",
    "    esac",
    "  done",
    "  if [ -z \"$N\" ]; then N=\"/\"; fi",
    "  if [ \"$FOLD\" = \"1\" ]; then N=$(printf '%s' \"$N\" | tr 'A-Z' 'a-z'); fi",
    "  printf '%s' \"$N\"",
    "}",
    "canon() {",
    "  P=\"$1\"",
    "  if command -v realpath >/dev/null 2>&1; then",
    "    R=$(realpath \"$P\" 2>/dev/null) && { printf '%s' \"$R\"; return 0; }",
    "  fi",
    "  if command -v readlink >/dev/null 2>&1; then",
    "    R=$(readlink -f \"$P\" 2>/dev/null) && { printf '%s' \"$R\"; return 0; }",
    "  fi",
    "  if R=$(cd \"$P\" 2>/dev/null && pwd -P 2>/dev/null); then",
    "    printf '%s' \"$R\"; return 0",
    "  fi",
    "  return 1",
    "}",
    "protected_hit() {",
    "  C=\"$1\"",
    "  HIT=\"\"",
    "  while IFS= read -r P || [ -n \"$P\" ]; do",
    "    if [ -z \"$P\" ]; then continue; fi",
    "    THIS=\"\"",
    "    if [ \"$C\" = \"$P\" ]; then THIS=\"$P\";",
    "    else",
    "      case \"$C\" in \"$P\"/*) THIS=\"$P\";; esac",
    "      if [ -z \"$THIS\" ]; then",
    "        case \"$P\" in \"$C\"/*) THIS=\"$P\";; esac",
    "      fi",
    "    fi",
    "    if [ -n \"$THIS\" ]; then HIT=\"$THIS\"; break; fi",
    "  done <<AUTOPILOT_SCOPE_EOF",
    "$PROTECTED",
    "AUTOPILOT_SCOPE_EOF",
    "  printf '%s' \"$HIT\"",
    "}",
    "check_candidate() {",
    "  M=$(protected_hit \"$1\")",
    "  if [ -n \"$M\" ]; then deny \"protected-ref\" \"$1\" \"$M\"; fi",
    "}",
    "if [ ! -f \"$IDENT\" ]; then",
    "  deny \"missing-identity\"",
    "fi",
    "FOLD=\"\"",
    "PROOT=\"\"",
    "PGIT=\"\"",
    "PCOMMON=\"\"",
    "PROTECTED=\"\"",
    "FIRST=1",
    "while IFS= read -r line || [ -n \"$line\" ]; do",
    "  case \"$line\" in ''|\\#*) continue;; esac",
    "  if [ \"$FIRST\" = \"1\" ]; then",
    "    FIRST=0",
    "    case \"$line\" in",
    "      \"v1 fold=0\") FOLD=\"0\";;",
    "      \"v1 fold=1\") FOLD=\"1\";;",
    "      *) deny \"malformed-identity\";;",
    "    esac",
    "    continue",
    "  fi",
    "  key=${line%%=*}",
    "  val=${line#*=}",
    "  case \"$key\" in",
    "    root|gitdir|common|wtpath|wtgit) ;;",
    "    *) deny \"malformed-identity\";;",
    "  esac",
    "  if [ -z \"$val\" ]; then deny \"malformed-identity\"; fi",
    "  case \"$val\" in",
    "    /*|[A-Za-z]:/*) ;;",
    "    *) deny \"malformed-identity\";;",
    "  esac",
    "  case \"$key\" in",
    "    root) PROOT=\"$val\";;",
    "    gitdir) PGIT=\"$val\";;",
    "    common) PCOMMON=\"$val\";;",
    "  esac",
    "  PROTECTED=\"$PROTECTED$val",
    "\"",
    "done < \"$IDENT\"",
    "if [ \"$FIRST\" = \"1\" ]; then deny \"malformed-identity\"; fi",
    "if [ -z \"$PGIT\" ] || [ -z \"$PCOMMON\" ]; then deny \"malformed-identity\"; fi",
    "if RGIT_RAW=$(git rev-parse --path-format=absolute --absolute-git-dir 2>/dev/null); then",
    "  RCOMMON_RAW=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || deny \"unresolved-common\"",
    "  RTOP_RAW=$(git rev-parse --show-toplevel 2>/dev/null || true)",
    "  CGIT=$(canon \"$RGIT_RAW\") || deny \"unresolved-gitdir\"",
    "  CGIT=$(norm \"$CGIT\")",
    "  CCOMMON=$(canon \"$RCOMMON_RAW\") || deny \"unresolved-common\"",
    "  CCOMMON=$(norm \"$CCOMMON\")",
    "  CTOP=\"\"",
    "  if [ -n \"$RTOP_RAW\" ]; then",
    "    CTOP=$(canon \"$RTOP_RAW\") || deny \"unresolved-top\"",
    "    CTOP=$(norm \"$CTOP\")",
    "  fi",
    "  if [ -z \"$CGIT\" ] || [ -z \"$CCOMMON\" ]; then deny \"unresolved-gitdir\"; fi",
    "  check_candidate \"$CGIT\"",
    "  check_candidate \"$CCOMMON\"",
    "  if [ -n \"$CTOP\" ] && [ \"$REF_TXN_STDIN_HAS_DATA\" = \"1\" ]; then check_candidate \"$CTOP\"; fi",
    "  exit 0",
    "fi",
    "if [ -z \"${GIT_DIR:-}\" ]; then",
    "  deny \"unresolved-gitdir\"",
    "fi",
    "ORIG=\"$PWD\"",
    "if [ -n \"${GIT_PREFIX:-}\" ]; then ORIG=\"$ORIG/$GIT_PREFIX\"; fi",
    "case \"$GIT_DIR\" in",
    "  /*|[A-Za-z]:/*) ABS_G=\"$GIT_DIR\";;",
    "  *) ABS_G=\"$ORIG/$GIT_DIR\";;",
    "esac",
    "CG=$(canon \"$ABS_G\") || deny \"unresolved-gitdir\"",
    "CG=$(norm \"$CG\")",
    "if [ -z \"$CG\" ]; then deny \"unresolved-gitdir\"; fi",
    "check_candidate \"$CG\"",
    "exit 0",
    ""
  ];
  return sh.join("\n");
}

function shellLiteral(candidate){
  return "'" + String(candidate).replace(/\\/g,"/").replace(/'/g,"'\"'\"'") + "'";
}

// TASK-39 + backlog #14(b): the blocked-git-call classification shared by
// both loops. #14(b) only forgives HARMLESS blocked commands (a read-only
// query, `worktree add/list`, `stash list/show`, ...). A blocked attempt to
// change history or the tree is still a policy violation even though the
// guard prevented the change: the agent TRIED to commit/push/reset/...
//
// Guard log entries (path-shim layer) carry `subcommand` (e.g. "commit",
// "worktree", "stash") plus `args`/`form`; hook entries carry only
// layer/hook/target. A missing subcommand is therefore treated as mutating
// (fail closed) — the hook only fires on a ref update.
//
// When every blocked entry is harmless AND the project repo is verifiably
// unchanged (HEAD, refs AND indexState identical to the pre-run snapshot;
// `repoChanged` carries the full snapshot diff when the caller has it), the
// blocked attempt is a WARNING on the run (recorded + shown), not a relay
// policy violation. `fixtureGitBlocksOnlyUnproven` keeps its narrower
// meaning (every entry target:"unproven", i.e. a fixture repo outside the
// project). Anything that actually changed the repo, a detected commit, an
// unreadable guard log, or a real read-only violation stays fatal.
const HISTORY_OR_TREE_MUTATING_SUBCOMMANDS = new Set([
  "commit","push","reset","rebase","merge","cherry-pick","revert","am",
  "checkout","switch","restore","tag","update-ref","branch","stash","clean",
  "gc","prune","rm","mv","add","apply","filter-branch","replace","notes",
]);
const HARMLESS_STASH_ACTIONS = new Set(["list","show"]);
const MUTATING_NOTES_ACTIONS = new Set(["add","remove"]);
const MUTATING_BRANCH_FLAGS = new Set(["-d","-D","-m","-M","-c","-C","-f","--force","--delete","--move","--copy","--set-upstream-to","-u","--unset-upstream"]);

// True when a blocked.log entry names a command that would change history or
// the tree. Read-only stash actions are the one carve-out; `branch`/`config`
// etc. only reach blocked.log when the guard already decided they mutate
// (read-only branch queries are passed through), so they count as mutating.
function blockedEventMutatesRepo(event){
  if(!event || typeof event!=="object") return true;
  const subcommand=String(event.subcommand||"").toLowerCase();
  if(!subcommand) return true;
  if(!HISTORY_OR_TREE_MUTATING_SUBCOMMANDS.has(subcommand)) return false;
  const args=Array.isArray(event.args)?event.args.map((value)=>String(value).toLowerCase()):[];
  if(subcommand==="stash"){
    const stashIndex=args.indexOf("stash");
    const action=stashIndex>=0?args.slice(stashIndex+1).find((value)=>!value.startsWith("-"))||"":String(event.form||"").toLowerCase();
    return !HARMLESS_STASH_ACTIONS.has(action);
  }
  if(subcommand==="notes"){
    const notesIndex=args.indexOf("notes");
    const action=notesIndex>=0?args.slice(notesIndex+1).find((value)=>!value.startsWith("-"))||"":String(event.form||"").toLowerCase();
    return action === "" || MUTATING_NOTES_ACTIONS.has(action);
  }
  if(subcommand==="branch"){
    // The guard passes read-only branch queries through, so a logged branch
    // command is normally mutating; only an explicit read-only query flag
    // downgrades it. No recognised action/flags stays fail-closed.
    return args.some((value)=>MUTATING_BRANCH_FLAGS.has(value.split("=")[0])) || !args.some((value)=>["--list","-l","--show-current","--contains","--no-contains","--merged","--no-merged","--points-at","--format","-v","--verbose","-a","--all","-r","--remotes","--column","--sort"].includes(value.split("=")[0]));
  }
  return true;
}

export function classifyGitBlocks(guardEvents,{commitDetected,readOnlyViolation,guardLogUnavailable,before,after,repoChanged}={}){
  if(commitDetected) return {policyViolation:"git_commit_detected",fixtureGitBlocksOnlyUnproven:false,blockedNoMutation:false};
  if(guardEvents.length>0){
    const allBlocksUnproven=guardEvents.every(e=>e && e.target==="unproven");
    const allBlocksHarmless=guardEvents.every((e)=>!blockedEventMutatesRepo(e));
    const repoUnchanged=typeof repoChanged==="boolean"
      ? !repoChanged
      : before.head===after.head && before.refs===after.refs && before.indexState===after.indexState;
    if(allBlocksHarmless && repoUnchanged && !readOnlyViolation) return {policyViolation:null,fixtureGitBlocksOnlyUnproven:allBlocksUnproven,blockedNoMutation:true};
    return {policyViolation:"git_mutation_blocked",fixtureGitBlocksOnlyUnproven:false,blockedNoMutation:false};
  }
  if(guardLogUnavailable) return {policyViolation:"guard_log_unavailable",fixtureGitBlocksOnlyUnproven:false,blockedNoMutation:false};
  if(readOnlyViolation) return {policyViolation:"read_only_violation",fixtureGitBlocksOnlyUnproven:false,blockedNoMutation:false};
  return {policyViolation:null,fixtureGitBlocksOnlyUnproven:false,blockedNoMutation:false};
}

export function readGuardLog(logFile){
  if(!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile,"utf8").split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return {raw:line};}});
}

export function sessionFromOutput(output){
  const text=String(output||"");
  const jsonKeys=[/"session[_-]?id"\s*:\s*"([^"]+)"/gi,/"sessionId"\s*:\s*"([^"]+)"/gi];
  for(const re of jsonKeys){let m; let last=""; while((m=re.exec(text))) last=m[1]; if(last)return last;}
  const patterns=[/session(?:[_ -]?id)?\s*[:=]\s*([A-Za-z0-9._:-]{8,})/gi,/conversation(?:[_ -]?id)?\s*[:=]\s*([A-Za-z0-9._:-]{8,})/gi];
  for(const re of patterns){let m; let last=""; while((m=re.exec(text))) last=m[1]; if(last)return last;}
  return null;
}

export function roleSession(state,roleName){
  state.sessions=state.sessions||{};
  return state.sessions[roleName]?.sessionId||null;
}

export function saveRoleSession(state,roleName,sessionId,meta={}){
  state.sessions=state.sessions||{};
  if(sessionId) state.sessions[roleName]={sessionId,...meta,updatedAt:new Date().toISOString()};
}

export function clearRoleSession(state,roleName){
  state.sessions=state.sessions||{};
  delete state.sessions[roleName];
}

export const SAFE_ENV_NAMES = new Set([
  "PATH","Path","PATHEXT","HOME","USER","USERNAME","USERPROFILE","HOMEDRIVE","HOMEPATH",
  "TEMP","TMP","TMPDIR","PWD","INIT_CWD","NODE_ENV","CI","LANG","LC_ALL","LC_CTYPE",
  "SHELL","COMSPEC","SystemRoot","WINDIR","APPDATA","LOCALAPPDATA","TERM","TERM_PROGRAM",
  "PORT","HOST","HOSTNAME","DISPLAY","CI","FORCE_COLOR","NO_COLOR"
]);

export function filteredProcessEnv(allowlist=[]){
  const out={};
  const allowed=new Set([...SAFE_ENV_NAMES,...allowlist.map(String)]);
  for(const [key,value] of Object.entries(process.env)){
    if(allowed.has(key)) out[key]=value;
  }
  return out;
}

export function guardedEnv(guard,extra={},allowlist=[]){
  const environment={
    ...filteredProcessEnv(allowlist),
    ...extra,
    AUTOPILOT_GIT_GUARD_LOG:guard.logFile,
    AUTOPILOT_REAL_GIT:guard.realGit,
    AUTOPILOT_NO_GIT_MUTATIONS:"1",
    GIT_TERMINAL_PROMPT:"0",
    GIT_CONFIG_COUNT:guard.repositoryRoot?"3":"2",
    GIT_CONFIG_KEY_0:"core.hooksPath",
    GIT_CONFIG_VALUE_0:guard.hooksDir,
    ...(guard.repositoryRoot?{GIT_CONFIG_KEY_1:"safe.directory",GIT_CONFIG_VALUE_1:guard.repositoryRoot}:{}),
    // 024 2.1: pin core.autocrlf=input so role git agrees with a Windows CRLF
    // checkout (phantom whole-file diffs otherwise read as dirty).
    ...(guard.repositoryRoot?{GIT_CONFIG_KEY_2:"core.autocrlf",GIT_CONFIG_VALUE_2:"input"}:{GIT_CONFIG_KEY_1:"core.autocrlf",GIT_CONFIG_VALUE_1:"input"})
  };
  return withGuardedPath(environment,guard.prependPath);
}

function withGuardedPath(environment,prependPath){
  const withoutPath=Object.fromEntries(Object.entries(environment).filter(([name])=>name.toLowerCase()!=="path"));
  return {...withoutPath,[process.platform==="win32"?"Path":"PATH"]:prependPath};
}

export function guardedCommandEnv(guard,extra={},allowlist=[]){
  return guardedEnv(guard,extra,allowlist);
}
