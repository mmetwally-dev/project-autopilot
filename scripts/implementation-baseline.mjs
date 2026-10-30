// TASK 13 / Problem B (+ correction pass): a durable, non-mutating
// implementation baseline so Code Reviewer/Verifier/final-review prompts
// see only the delta a mission actually created, never a repository's
// pre-existing dirty state (modified, deleted, staged, or untracked files
// that were already there before the mission started).
//
// Deliberately does NOT use git commit/stash/reset/restore/checkout, and
// never touches Git refs or the index: the baseline is a plain filesystem
// snapshot (a copy of whatever was already dirty/untracked, taken with
// `git status --porcelain`) plus a manifest recorded under
// .autopilot/baseline/<key>/. The delta is then computed with
// `git diff --no-index`, which is pure filesystem comparison and never
// reads or writes the repository's Git state at all.
//
// Idempotent capture (ensureBaseline never re-snapshots once a manifest
// exists) is what makes this safe across retries and process resume: a
// failed attempt's partial changes are never absorbed into a "new"
// baseline, because the baseline for a given key is captured exactly once,
// before that key's first attempt ever ran. Callers MUST namespace `key` by
// the caller's own stable mission identity (see sanitizeKeySegment) — this
// module has no concept of "which mission" on its own, and two different
// keys are always two completely independent baselines.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
// The NUL byte git status --porcelain -z uses as its field separator.
const NUL_CHAR = String.fromCharCode(0);

// Stable, minimal prompt-contract delimiters. Reviewer/verifier prompts wrap
// the scoped delta between these exact markers so callers (and tests) can
// locate the delta reliably without depending on the surrounding
// human-readable prose, which is free to change. `scope` is a short,
// uppercase tag ("PHASE" or "MISSION") identifying which baseline produced
// the delta — never repository content, so it is always safe to embed
// literally.
export function scopedDeltaBeginMarker(scope) {
  return `<<<AUTOPILOT_SCOPED_DELTA_BEGIN:${scope}>>>`;
}
export const SCOPED_DELTA_END_MARKER = "<<<AUTOPILOT_SCOPED_DELTA_END>>>";

// TASK 15.6F: recursive worktree entry listing for the git-invisible-phase
// guard (scripts/autopilot.mjs). Returns the sorted repo-relative paths of
// every entry under the repository root — files and symlinks as-is,
// directories with a trailing "/" so that an EMPTY directory still counts
// as an entry. Git cannot represent empty directories, so such a directory
// never surfaces in gitSnapshot/touchedFilesBetween/scopedDelta; this
// listing is the complementary authority that proves the worktree itself
// changed while the Git-observable delta stayed empty. Skips the top-level
// .git tree (VCS internals, never implementation content) and the
// top-level .autopilot tree (orchestrator bookkeeping — the same exclusion
// the git snapshot applies). Never follows symlinks (lstat only), so link
// loops and escapes can neither hang nor mislead it. Pure: never mutates.
// Throws on I/O errors; callers treat a throw as "unknown" and proceed
// exactly as before — the guard fires only on positive evidence.
export function listWorktreeEntries(repo) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, {withFileTypes: true});
    } catch (e) {
      throw new Error(`implementation-baseline: failed to list '${abs}': ${e.message}`);
    }
    for (const e of entries) {
      if (rel === "" && (e.name === ".git" || e.name === ".autopilot")) continue;
      const entryRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) {
        out.push(entryRel);
        continue;
      }
      if (e.isDirectory()) {
        out.push(`${entryRel}/`);
        walk(path.join(abs, e.name), entryRel);
        continue;
      }
      out.push(entryRel);
    }
  };
  walk(path.resolve(repo), "");
  return out.sort();
}

// Turns arbitrary caller-supplied identity text (e.g. a mission name derived
// from a planner-authored feature directory) into a single path-safe
// filesystem segment: only [A-Za-z0-9._-], collapsed, never empty, never
// literally "." or ".." (which alone could otherwise resolve to a parent
// directory once joined with path.join). This is the ONLY sanctioned way to
// turn caller identity into part of a baseline directory name — never
// interpolate raw caller text into a path directly.
export function sanitizeKeySegment(raw) {
  const text = String(raw ?? "").trim();
  let sanitized = text.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") sanitized = "unknown";
  return sanitized.slice(0, 200);
}

function git(repo, args) {
  const r = spawnSync("git", args, {cwd: repo, encoding: "utf8", shell: false});
  if (r.error) {
    throw new Error(`implementation-baseline: failed to run 'git ${args.join(" ")}' in ${repo}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`implementation-baseline: 'git ${args.join(" ")}' in ${repo} exited ${r.status}: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout || "";
}

// Parses `git status --porcelain=v1 -z --untracked-files=all` output. -z
// gives NUL-separated, byte-exact (unquoted/unescaped) paths — required for
// paths with spaces or non-ASCII characters. A rename/copy entry (X or Y is
// R/C) is followed by one extra NUL-terminated field: the original path.
function parsePorcelainZ(output) {
  const parts = output.split(NUL_CHAR);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (raw === "") continue;
    const x = raw[0], y = raw[1];
    const entryPath = raw.slice(3);
    const isRenameOrCopy = x === "R" || x === "C" || y === "R" || y === "C";
    let origPath = null;
    if (isRenameOrCopy) { i += 1; origPath = parts[i] ?? null; }
    entries.push({x, y, path: entryPath, origPath});
  }
  return entries;
}

// The orchestrator's own bookkeeping directory (config, state, run logs,
// and this very baseline cache) is never implementation content — it must
// never be captured as baseline dirt or surfaced as part of a delta, even
// in a fixture repo with no .gitignore for it.
function isAutopilotOwnPath(rel) {
  return rel === ".autopilot" || rel.startsWith(".autopilot/");
}

// One canonical validator for declared deliverable paths (Task 3 v8).
// LLM-authored content (<!-- autopilot-deliverable: --> / ## Deliverables)
// can contain traversal/absolute/symlink-escaping paths. Validate fail-closed
// before any fs.* mutation. Mirrors assertSafeMissionName's resolve+boundary
// check, plus absolute/UNC/drive/root/.autopilot/symlink-ancestor checks.
export function validateDeclaredPath(repo, mission, rawPath){
  const relNorm = String(rawPath ?? "").replace(/\\/g,"/").trim().replace(/^\.\//,"");
  if(!relNorm || relNorm==="." || relNorm===".." || relNorm==="/") {
    const e=new Error(`UNSAFE_DELIVERABLE_PATH: declared deliverable "${rawPath}" is empty or a directory sentinel`);
    e.code="UNSAFE_DELIVERABLE_PATH"; throw e;
  }
  if(/^(?:\/|\\\\|\/\/)/.test(relNorm) || /^[A-Za-z]:/.test(relNorm)){
    const e=new Error(`UNSAFE_DELIVERABLE_PATH: declared deliverable "${rawPath}" is absolute (POSIX/UNC/Windows drive)`);
    e.code="UNSAFE_DELIVERABLE_PATH"; throw e;
  }
  const resolved = path.resolve(repo, relNorm);
  const boundary = path.resolve(repo) + path.sep;
  const repoRoot = path.resolve(repo);
  if(resolved!==repoRoot && !resolved.startsWith(boundary)){
    const e=new Error(`UNSAFE_DELIVERABLE_PATH: declared deliverable "${rawPath}" escapes the repository`);
    e.code="UNSAFE_DELIVERABLE_PATH"; throw e;
  }
  const rel = path.relative(repo, resolved).replace(/\\/g,"/");
  if(!rel || rel==="." || rel==="/") {
    const e=new Error(`UNSAFE_DELIVERABLE_PATH: declared deliverable "${rawPath}" resolves to repository root`);
    e.code="UNSAFE_DELIVERABLE_PATH"; throw e;
  }
  if(rel.startsWith(".autopilot/")){
    if(!mission || typeof mission!=="string" || !mission) {
      const e=new Error(`UNSAFE_DELIVERABLE_PATH: declared deliverable "${rawPath}" inside .autopilot requires a mission context`);
      e.code="UNSAFE_DELIVERABLE_PATH"; throw e;
    }
    const prefix = `.autopilot/missions/${mission}/`;
    if(!rel.startsWith(prefix)){
      const e=new Error(`UNSAFE_DELIVERABLE_PATH: declared deliverable "${rawPath}" inside .autopilot outside current mission`);
      e.code="UNSAFE_DELIVERABLE_PATH"; throw e;
    }
    const inner = rel.slice(prefix.length);
    if(!inner || inner==="PLAN.md" || inner==="TASKS.md" || inner==="state.json" || inner.startsWith("runs/") || inner.startsWith("baseline/")){
      const e=new Error(`UNSAFE_DELIVERABLE_PATH: declared deliverable "${rawPath}" targets reserved .autopilot path`);
      e.code="UNSAFE_DELIVERABLE_PATH"; throw e;
    }
  }
  // Walk ancestors of resolved, tolerating nonexistent future segments (ENOENT → continue),
  // but reject any existing symlink parent (Node reports Windows junctions as symlinks).
  const segments = rel.split("/").filter(Boolean);
  let cur = repoRoot;
  for(let i=0;i<segments.length-1;i++){
    cur = path.join(cur, segments[i]);
    let st;
    try{ st = fs.lstatSync(cur); }catch(e){ if(e.code==="ENOENT") continue; throw e; }
    if(st.isSymbolicLink()){
      const e=new Error(`UNSAFE_DELIVERABLE_PATH: declared deliverable "${rawPath}" has symlink ancestor ${path.relative(repo,cur)}`);
      e.code="UNSAFE_DELIVERABLE_PATH"; throw e;
    }
  }
  return rel;
}

function statusEntries(repo) {
  const all = parsePorcelainZ(git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
    .filter(entry => !isAutopilotOwnPath(entry.path) && !(entry.origPath && isAutopilotOwnPath(entry.origPath)));
  // EOL-tolerant filter (mission 024): `git status` reports a CRLF-only
  // worktree rewrite as modified even under `-c core.autocrlf=input`,
  // while `git diff --ignore-cr-at-eol` correctly reports it clean. Drop
  // tracked paths absent from the ignore-cr dirty set; untracked (`??`)
  // entries are never in the diff-HEAD set and are always kept. Fail open
  // (return unfiltered) when the probe itself fails — the guard fires only
  // on positive evidence, never on an unreadable signal.
  let eolDirty = null;
  try {
    eolDirty = new Set(git(repo, ["-c", "core.autocrlf=input", "diff", "--ignore-cr-at-eol", "--name-only", "-z", "HEAD"]).split(NUL_CHAR).filter(Boolean));
  } catch { return all; }
  return all.filter(entry => {
    if (entry.x === "?" && entry.y === "?") return true;
    if (eolDirty.has(entry.path)) return true;
    if (entry.origPath && eolDirty.has(entry.origPath)) return true;
    return false;
  });
}

function baselineDir(repo, key) {
  return path.join(repo, ".autopilot", "baseline", key);
}
function manifestPath(repo, key) {
  return path.join(baselineDir(repo, key), "manifest.json");
}

// The repo-relative path of the NEAREST ancestor of `rel` that is a symlink
// in the working tree, or null. lstat only, so links are never followed.
// A path under a symlink is not an independent working-tree entry: the
// symlink itself is the only real thing on disk, and Git can still report
// tracked paths beneath it (e.g. committed on Windows with
// core.symlinks=false) as deleted/untracked. Capture and diff must therefore
// represent the symlink once and skip its descendants, never read a file
// "through" the link.
function symlinkAncestor(repo, rel) {
  const segments = String(rel).split("/").filter(Boolean);
  let cur = repo;
  let curRel = "";
  for (let i = 0; i < segments.length - 1; i++) {
    curRel = curRel ? `${curRel}/${segments[i]}` : segments[i];
    cur = path.join(cur, segments[i]);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
      throw new Error(`implementation-baseline: failed to inspect '${cur}': ${e.message}`);
    }
    if (st.isSymbolicLink()) return curRel;
  }
  return null;
}

// The kind of whatever already occupies a baseline snapshot path, or null if
// nothing does. Defensive: a previous interrupted capture can leave stale
// snapshot entries behind (the manifest is written last), and recreating a
// symlink on top of an existing directory otherwise fails with a raw EEXIST.
function existingSnapshotKind(snapshotPath) {
  let st;
  try {
    st = fs.lstatSync(snapshotPath);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw new Error(`implementation-baseline: failed to inspect baseline snapshot '${snapshotPath}': ${e.message}`);
  }
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "directory";
  if (st.isFile()) return "file";
  return "other";
}

function snapshotConflictError(rel, snapshotPath, existingKind) {
  return new Error(
    `implementation-baseline: refusing to overwrite existing baseline snapshot '${snapshotPath}' for repository path '${rel}' (found ${existingKind}). ` +
    `This usually means the working tree has a symlink at or above '${rel}' while Git tracks regular file(s) beneath that path ` +
    `(for example commits made on Windows with core.symlinks=false); the symlink must be recorded once as a symlink and its descendants skipped, ` +
    `never captured as separate files through the link.`
  );
}

// Symlink-safe classification of a filesystem path: NEVER follows a
// symlink to inspect what it points to. Returns one of:
//   {kind:"absent"}                 -- nothing at this path
//   {kind:"file"}                   -- a regular file
//   {kind:"symlink", target:"..."}  -- a symlink and its OWN link text
//                                       (never the pointed-to file's content)
//   {kind:"dir"} | {kind:"other"}   -- unsupported for baseline purposes
function classifyEntry(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (e) {
    if (e.code === "ENOENT") return {kind: "absent"};
    throw new Error(`implementation-baseline: failed to inspect '${abs}': ${e.message}`);
  }
  if (st.isSymbolicLink()) return {kind: "symlink", target: fs.readlinkSync(abs)};
  if (st.isFile()) return {kind: "file"};
  if (st.isDirectory()) return {kind: "dir"};
  return {kind: "other"};
}

// Captures the CURRENT dirty/untracked state as the baseline for `key`, but
// only the first time it is called for that key — every later call
// (a retry of the same phase, or a resumed process) is a no-op, so a
// failed attempt's own changes are never folded into the baseline. A
// baseline directory WITHOUT manifest.json is an incomplete capture (the
// manifest is written last), so its stale snapshot copies are discarded and
// recaptured rather than layered on top of; a complete baseline is never
// deleted or recreated.
export function ensureBaseline(repo, key, opts={}) {
  const mission = opts.mission ?? null;
  const rawDeclared = Array.isArray(opts.declaredPaths) ? opts.declaredPaths : [];
  // Validate all declared paths BEFORE any filesystem mutation; fail-closed.
  const declaredPaths = [...new Set(rawDeclared.map(p=>validateDeclaredPath(repo, mission, p)))].sort();
  const manifestFile = manifestPath(repo, key);
  if (fs.existsSync(manifestFile)) {
    // If manifest exists, verify declaration set matches; declaration change after capture is a hard stop.
    const existing = readManifest(manifestFile);
    const storedDeclared = existing.declaredPaths || [];
    if(JSON.stringify(storedDeclared) !== JSON.stringify(declaredPaths)){
      const e=new Error(`DECLARATION_MISMATCH: declaredPaths changed after baseline ${key} was captured`);
      e.code="DECLARATION_MISMATCH"; throw e;
    }
    return false;
  }
  const dir = baselineDir(repo, key);
  const filesDir = path.join(dir, "files");
  // No manifest means an interrupted capture (manifest.json is written
  // LAST). Its snapshot copies may include stale REAL directories where a
  // symlink now belongs, which would otherwise collide on resume. Discard
  // the incomplete snapshot and capture cleanly from the working tree.
  fs.rmSync(filesDir, {recursive: true, force: true});
  const entries = {};
  for (const entry of statusEntries(repo)) {
    recordBaselineEntry(repo, filesDir, entries, entry.path);
    if (entry.origPath) recordBaselineEntry(repo, filesDir, entries, entry.origPath);
  }
  // Snapshot declared deliverables even when git status wouldn't list them (ignored).
  for(const rel of declaredPaths){
    recordBaselineEntry(repo, filesDir, entries, rel);
  }
  fs.mkdirSync(dir, {recursive: true});
  let baseHead = null;
  try{ baseHead = git(repo, ["rev-parse", "HEAD"]).trim() || null; }catch{ baseHead = null; }
  const manifest = {version:2, declaredPaths, entries, baseHead};
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  return true;
}

// TASK-23: whether a baseline manifest exists for `key`. A review is a
// re-review only when the previous revision's snapshot exists; a missing
// snapshot (hand-deleted, older mission) falls back to a whole-phase
// review, never a crash.
export function hasBaseline(repo, key) {
  return fs.existsSync(manifestPath(repo, key));
}

// Backlog #40 (b): the HEAD recorded when a baseline was captured, or null
// for a key that was never captured / predates the field.
export function baselineBaseHead(repo, key) {
  const file = manifestPath(repo, key);
  if (!fs.existsSync(file)) return null;
  try{ return readManifest(file).baseHead ?? null; }catch{ return null; }
}

// Backlog #40 (a): compare the baseline's recorded HEAD with today's HEAD.
// Pure read; callers decide when to warn (once per baseline key).
export function headMovedSinceBaseline(repo, key) {
  const baseHead = baselineBaseHead(repo, key);
  if (!baseHead) return {baseHead: null, head: null, moved: false};
  let head = null;
  try{ head = git(repo, ["rev-parse", "HEAD"]).trim() || null; }catch{ return {baseHead, head: null, moved: false}; }
  return {baseHead, head, moved: Boolean(head && head !== baseHead)};
}

// Backlog #40: operator commits made while a phase is paused change the
// repository HEAD but not the baseline copies, so the phase delta later
// contains those commits as if the implementer authored them. Re-apply
// `git diff <baseline HEAD>..HEAD -- <file>` to the stored copy of every
// baseline file and record the new HEAD. The worktree is never modified;
// only the baseline snapshot moves. Files whose patch does not apply are
// reported and left untouched (the old copy keeps the delta truthful for
// that file), and the whole baseline directory is backed up first.
export function rebaseBaselineOntoHead(repo, key, {nowIso = new Date().toISOString()} = {}) {
  const manifestFile = manifestPath(repo, key);
  if (!fs.existsSync(manifestFile)) {
    return {ok: true, rebased: false, reason: "no-baseline", baseHead: null, head: null, files: [], deleted: [], skipped: [], declaredPaths: []};
  }
  const manifest = readManifest(manifestFile);
  let head = null;
  try{ head = git(repo, ["rev-parse", "HEAD"]).trim() || null; }catch{ head = null; }
  if (!head) return {ok: true, rebased: false, reason: "no-head", baseHead: manifest.baseHead||null, head: null, files: [], deleted: [], skipped: [], declaredPaths: manifest.declaredPaths||[]};
  if (!manifest.baseHead) {
    // Pre-#40 manifest: the old HEAD is unknowable, so no patch can be
    // derived. Record today's HEAD so the next rebase is exact.
    fs.writeFileSync(manifestFile, JSON.stringify({...manifest, version:2, declaredPaths: manifest.declaredPaths||[], baseHead: head}, null, 2));
    return {ok: true, rebased: false, reason: "no-base-head", baseHead: null, head, files: [], deleted: [], skipped: [], declaredPaths: manifest.declaredPaths||[]};
  }
  if (manifest.baseHead === head) {
    return {ok: true, rebased: false, reason: "already-at-head", baseHead: manifest.baseHead, head, files: [], deleted: [], skipped: [], declaredPaths: manifest.declaredPaths||[]};
  }
  const dir = baselineDir(repo, key);
  const backup = `${dir}.backup-${sanitizeKeySegment(nowIso)}`;
  try{ fs.cpSync(dir, backup, {recursive: true}); }
  catch(e){ return {ok: false, reason: `backup failed: ${e.message}`, baseHead: manifest.baseHead, head, files: [], deleted: [], skipped: [], declaredPaths: manifest.declaredPaths||[]}; }
  const files = [];
  const deleted = [];
  const skipped = [];
  // Only paths whose content changed between the baseline HEAD and today's
  // HEAD can make an operator commit look like phase work. Apply that patch
  // to the stored copy: present at HEAD -> store HEAD's content; absent at
  // HEAD -> remove the copy (a committed deletion). A path in the baseline
  // that HEAD did not change is left exactly as captured (pre-existing dirt
  // that the operator has not committed yet must stay invisible).
  let changed = [];
  try {
    changed = git(repo, ["diff", "--name-only", "-z", "--no-renames", `${manifest.baseHead}..${head}`])
      .split(NUL_CHAR).filter(Boolean);
  } catch (e) {
    return {ok: false, reason: `base..HEAD diff failed: ${e.message}`, baseHead: manifest.baseHead, head, files: [], deleted: [], skipped: [], declaredPaths: manifest.declaredPaths||[]};
  }
  for (const rel of changed) {
    const entry = manifest.entries?.[rel];
    if (!entry || entry.type !== "file") continue;
    const snapshot = path.join(dir, "files", rel);
    const headText = spawnSync("git", ["show", `${head}:${rel}`], {cwd: repo, encoding: "utf8", shell: false});
    if (headText.status !== 0) {
      if (fs.existsSync(snapshot)) {
        try { fs.rmSync(snapshot, {force: true}); deleted.push(rel); }
        catch (e) { skipped.push({path: rel, reason: `delete failed: ${e.message}`}); }
      }
      continue;
    }
    if (!fs.existsSync(snapshot)) { skipped.push({path: rel, reason: "baseline copy is missing"}); continue; }
    fs.writeFileSync(snapshot, headText.stdout);
    files.push(rel);
  }
  fs.writeFileSync(manifestFile, JSON.stringify({...manifest, version:2, declaredPaths: manifest.declaredPaths||[], baseHead: head}, null, 2));
  return {ok: true, rebased: true, reason: null, baseHead: manifest.baseHead, head, files, deleted, skipped, backup: path.relative(repo, backup), declaredPaths: manifest.declaredPaths||[]};
}

// TASK-23: remove a whole baseline key directory (manifest + snapshot
// copies). Force: removing a key that was never captured, or whose
// manifest was already deleted, is a no-op rather than an error.
export function removeBaseline(repo, key) {
  fs.rmSync(baselineDir(repo, key), {recursive: true, force: true});
}

function readManifest(file){
  const raw = JSON.parse(fs.readFileSync(file,"utf8"));
  if(raw && typeof raw==="object" && raw.version===2 && Array.isArray(raw.declaredPaths) && raw.entries && typeof raw.entries==="object"){
    return {version:2, declaredPaths: [...raw.declaredPaths].sort(), entries: raw.entries, baseHead: typeof raw.baseHead==="string"?raw.baseHead:null};
  }
  // v1: flat path->entry map, no version key
  if(raw && typeof raw==="object" && !Array.isArray(raw) && !("version" in raw)){
    return {version:1, declaredPaths:[], entries: raw};
  }
  const e=new Error(`UNKNOWN_MANIFEST_VERSION: ${file} is neither v1 (flat map) nor v2 (versioned). Corrupted or unsupported manifest.`);
  e.code="UNKNOWN_MANIFEST_VERSION"; throw e;
}

function recordBaselineEntry(repo, filesDir, manifest, rel) {
  if (manifest[rel]) return;
  // Deterministic regardless of the order paths arrive in: any path under a
  // working-tree symlink collapses to that symlink (captured once); the
  // descendant itself is never recorded as a separate file through the link.
  const ancestor = symlinkAncestor(repo, rel);
  if (ancestor) {
    recordBaselineEntry(repo, filesDir, manifest, ancestor);
    return;
  }
  const abs = path.join(repo, rel);
  const classified = classifyEntry(abs);
  if (classified.kind === "absent") {
    manifest[rel] = {type: "absent"};
    return;
  }
  if (classified.kind === "file") {
    const snapshotPath = path.join(filesDir, rel);
    const existing = existingSnapshotKind(snapshotPath);
    if (existing && existing !== "file") {
      throw snapshotConflictError(rel, snapshotPath, existing);
    }
    manifest[rel] = {type: "file"};
    fs.mkdirSync(path.dirname(snapshotPath), {recursive: true});
    fs.copyFileSync(abs, snapshotPath);
    return;
  }
  if (classified.kind === "symlink") {
    // Record only the link's OWN target text, and recreate an actual
    // symlink object (never a copy of whatever it points to) at the
    // snapshot location. git's own diff machinery is symlink-aware — it
    // compares link text via lstat/readlink and never dereferences — so
    // handing this snapshot symlink straight to `git diff --no-index`
    // later compares target strings safely, with no code in this module
    // ever opening the pointed-to file on either side.
    const snapshotPath = path.join(filesDir, rel);
    const existing = existingSnapshotKind(snapshotPath);
    if (existing) {
      let existingTarget = null;
      try { existingTarget = fs.readlinkSync(snapshotPath); } catch { /* not a link */ }
      if (existing === "symlink" && existingTarget === classified.target) {
        manifest[rel] = {type: "symlink", target: classified.target};
        return;
      }
      throw snapshotConflictError(rel, snapshotPath, existing);
    }
    manifest[rel] = {type: "symlink", target: classified.target};
    fs.mkdirSync(path.dirname(snapshotPath), {recursive: true});
    fs.symlinkSync(classified.target, snapshotPath);
    return;
  }
  // Directories, sockets, FIFOs, devices, etc. are not meaningful baseline
  // content, and silently mis-copying or ignoring them could hide real
  // repository state. Fail closed instead.
  throw new Error(`implementation-baseline: unsupported filesystem entry type for baseline capture: '${rel}' (${classified.kind})`);
}

// Pure filesystem diff (git diff --no-index) — never reads/writes the
// repository's Git index, refs, or working-tree state, and (like all of
// git's own diff machinery) never dereferences a symlink to read its
// target's content; it compares the symlink's own link text instead. Valid
// outcomes are ONLY exit 0 (identical) and exit 1 (differences found) — any
// other exit code, or a spawn failure, is a real error and must not be
// treated as "no difference".
function diffNoIndex(repo, leftAbs, rightAbs) {
  const left = leftAbs || NULL_DEVICE;
  const right = rightAbs || NULL_DEVICE;
  const r = spawnSync("git", ["-c", "core.autocrlf=input", "diff", "--no-index", "--no-ext-diff", "--ignore-cr-at-eol", "--", left, right], {cwd: repo, encoding: "utf8", shell: false});
  if (r.error) {
    throw new Error(`implementation-baseline: failed to run 'git diff --no-index' comparing '${left}' and '${right}': ${r.error.message}`);
  }
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`implementation-baseline: 'git diff --no-index' comparing '${left}' and '${right}' exited ${r.status} (only 0/1 are valid): ${(r.stderr || r.stdout || "").trim()}`);
  }
  return (r.stdout || "").trim();
}

// The abs path to hand to diffNoIndex for the BASELINE side of a manifest
// entry — works uniformly for "file" and "symlink" (both are physically
// recreated under the snapshot directory at capture time), or null (meaning
// /dev/null / NUL: nothing existed at baseline) for "absent".
function baselineDiffSide(dir, rel, baseEntry) {
  if (!baseEntry || baseEntry.type === "absent") return null;
  if (baseEntry.type === "file" || baseEntry.type === "symlink") return path.join(dir, "files", rel);
  throw new Error(`implementation-baseline: unrecognized baseline entry type for '${rel}': ${baseEntry.type}`);
}

// The abs path to hand to diffNoIndex for the CURRENT side of a path — null
// (absent) if nothing is there now, the real path for a file or symlink
// (git diff --no-index handles both directly, safely, without
// dereferencing), or a thrown error for anything else.
function currentDiffSide(currentAbs) {
  const c = classifyEntry(currentAbs);
  if (c.kind === "absent") return null;
  if (c.kind === "file" || c.kind === "symlink") return currentAbs;
  throw new Error(`implementation-baseline: unsupported filesystem entry type while computing delta: '${currentAbs}' (${c.kind})`);
}

// Returns only the diff created SINCE the baseline for `key` was captured.
// Iterates the UNION of every path recorded in the baseline manifest and
// every path the CURRENT `git status` reports — never current status
// alone, which would silently miss a path that was dirty/untracked at
// baseline and has since been fully reverted to match HEAD (or, for a
// baseline-time deleted tracked file, fully restored) — such paths no
// longer show up in `git status` at all, yet the change from "baseline
// state" to "current state" is real and must be surfaced.
//   - a path untouched since baseline (byte-identical, or an unchanged
//     pre-existing dirty/untracked/deleted/symlink state) contributes
//     nothing;
//   - a path already dirty/untracked/deleted/a-symlink at baseline that has
//     since changed further (including being fully reverted, or a deleted
//     file being restored) contributes only that additional change (diffed
//     against its OWN baseline snapshot, never against HEAD);
//   - a path clean at baseline and now dirty contributes its ordinary
//     HEAD-relative diff;
//   - a brand-new untracked file (no baseline entry) contributes a full
//     "added file" diff.
// Returns "" only when nothing has changed since baseline at all. Throws
// rather than ever silently returning "" because Git itself failed.
export function scopedDeltaChunks(repo, key, opts={}) {
  const mission = opts.mission ?? null;
  const rawDeclared = Array.isArray(opts.declaredPaths) ? opts.declaredPaths : [];
  const declaredPaths = [...new Set(rawDeclared.map(p=>validateDeclaredPath(repo, mission, p)))].sort();
  const manifestFile = manifestPath(repo, key);
  let manifestEntries={};
  let storedDeclared=[];
  if(fs.existsSync(manifestFile)){
    const m = readManifest(manifestFile);
    manifestEntries = m.entries || {};
    storedDeclared = m.declaredPaths || [];
    // Declaration set must match what was captured; new declaration must not reinterpret old baseline.
    if(m.version===2 && JSON.stringify(storedDeclared) !== JSON.stringify(declaredPaths)){
      const e=new Error(`DECLARATION_MISMATCH: declaredPaths changed after baseline ${key} was captured`);
      e.code="DECLARATION_MISMATCH"; throw e;
    }
    // v1 manifests have no declaredPaths; allow empty declaredPaths only, otherwise mismatch.
    if(m.version===1 && declaredPaths.length>0){
      const e=new Error(`DECLARATION_MISMATCH: declaredPaths added after v1 baseline ${key} was captured`);
      e.code="DECLARATION_MISMATCH"; throw e;
    }
  }
  const dir = baselineDir(repo, key);
  const entries = statusEntries(repo);
  const statusByPath = new Map(entries.map(e => [e.path, e]));
  const allPaths = new Set([...Object.keys(manifestEntries), ...entries.map(e => e.path), ...declaredPaths]);
  const chunks = [];
  for (const rel of allPaths) {
    // A path under a working-tree symlink is represented by that symlink
    // alone (see recordBaselineEntry). Git status still lists the tracked
    // files beneath such a path as deleted/untracked, and diffing them
    // "through" the link would invent changes that are really just the
    // pre-existing symlink-vs-tracked-files shape. The symlink's own entry
    // (if any) is processed normally below.
    if (symlinkAncestor(repo, rel)) continue;
    const baseEntry = manifestEntries[rel] || null;
    const currentAbs = path.join(repo, rel);

    if (baseEntry) {
      const baseAbs = baselineDiffSide(dir, rel, baseEntry);
      const rightAbs = currentDiffSide(currentAbs);
      if (!baseAbs && !rightAbs) continue;
      const d = diffNoIndex(repo, baseAbs, rightAbs);
      if (d) chunks.push({path: rel, text: d});
      continue;
    }
    // Not in the manifest: clean at baseline time.
    const entry = statusByPath.get(rel);
    if (entry) {
      const isUntracked = entry.x === "?" && entry.y === "?";
      if (isUntracked) {
        const rightAbs = currentDiffSide(currentAbs);
        if (!rightAbs) continue;
        const d = diffNoIndex(repo, null, rightAbs);
        if (d) chunks.push({path: rel, text: d});
        continue;
      }
      // Tracked and clean at baseline: ordinary HEAD-relative diff is already
      // correct (baseline content === HEAD content for a path that wasn't
      // dirty at baseline time). EOL-tolerant (mission 024): CRLF-only
      // rewrites must stay invisible here exactly as in gitSnapshot.
      const headDiff = (git(repo, ["-c", "core.autocrlf=input", "diff", "--ignore-cr-at-eol", "--no-ext-diff", "--", rel]) + git(repo, ["-c", "core.autocrlf=input", "diff", "--ignore-cr-at-eol", "--no-ext-diff", "--cached", "--", rel])).trim();
      if (headDiff) chunks.push({path: rel, text: headDiff});
      continue;
    }
    // Declared path with no manifest entry and no git status entry: check filesystem directly
    // (e.g., ignored file that is now present but was absent at baseline, or vice versa)
    const curKind = classifyEntry(currentAbs);
    if(curKind.kind==="absent") continue;
    if(curKind.kind==="file" || curKind.kind==="symlink"){
      const d = diffNoIndex(repo, null, currentAbs);
      if(d) chunks.push({path: rel, text: d});
    }
  }
  return chunks;
}

export function scopedDelta(repo, key, opts={}) {
  return scopedDeltaChunks(repo, key, opts).map(c => c.text).join("\n");
}
