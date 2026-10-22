// Backlog #14 (`ap uninstall`) — project-scoped teardown core.
//
// `planUninstall` is PURE: it reads only through an injected `fs`, performs no
// writes, and returns the full `{projectPath,setUp,deletes,edits,moves}` plan
// the CLI prints before confirming. `executeUninstall(plan,fs)` is the single
// writer: it applies every move, then every delete, then every edit, in that
// order (an archive move must land before `.autopilot/` — the thing holding the
// moved `missions/` directory — is deleted).
//
// The `.autopilot/` line setup appended to `.gitignore` (see `setup.mjs`
// `ensureAutopilotGitignored`) is removed by EXACT line match only: no whole-file
// rewrite, no loose pattern, and the file's existing EOL style is preserved. An
// emptied `.gitignore` is kept as an empty file rather than deleted.
import fsDefault from "node:fs";
import path from "node:path";
import { allCommandRelPaths, getAgentEntry, isGeneratedSkillContent, legacyCommandRelPaths, LEGACY_COMMAND_LAYOUTS } from "./agent-command-registry.mjs";

const AUTOPILOT_DIR = ".autopilot";
const MISSIONS_DIR = "missions";
// The exact trimmed line setup writes; a line matching only loosely (a
// substring, a path like `foo/.autopilot/`, or `.autopilot` with no slash) is
// a user line and must be left untouched.
const GITIGNORE_LINE = `${AUTOPILOT_DIR}/`;

function pickFs(fs) {
  return fs && typeof fs.existsSync === "function" ? fs : fsDefault;
}

function dateStamp(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return d.toISOString().slice(0, 10);
}

// Remove every exact `.autopilot/` line, preserving the file's EOL style and
// its trailing newline. Returns {changed, before, after}. `changed` is false
// when no exact line existed, so the caller can skip emitting an edit (and a
// caller-driven overwrite never touches a file that needs no change).
function rewriteGitignoreRemoveAutopilot(content) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r\n|\r|\n/);
  const found = lines.some((line) => line.trim() === GITIGNORE_LINE);
  if (!found) return {changed: false, before: content, after: content, eol};
  const kept = lines.filter((line) => line.trim() !== GITIGNORE_LINE);
  // Drop a lone trailing empty element an earlier trailing newline produced so
  // the rejoin re-establishes the trailing newline instead of duplicating it.
  if (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  // An emptied file stays present and empty (no re-added trailing newline).
  const after = kept.length ? kept.join(eol) + eol : "";
  return {changed: true, before: content, after, eol};
}

// Every top-level `deletes` entry needed to wipe `.autopilot/` while honouring
// `keepMissions`. When missions are kept, each other entry is deleted
// recursively and `.autopilot/` itself is removed last, non-recursively — by
// then the `missions/` move has already vacated it, so it is empty.
function planDeletes(projectPath, keepMissions, fs) {
  if (!keepMissions) return [{path: projectPath, recursive: true}];
  const deletes = [];
  let entries = [];
  try {
    entries = fs.readdirSync(projectPath, {withFileTypes: true});
  } catch {
    // Unreadable/missing: fall back to the whole-directory recursive delete.
    return [{path: projectPath, recursive: true}];
  }
  for (const entry of entries) {
    if (entry.name === MISSIONS_DIR) continue;
    deletes.push({path: path.join(projectPath, entry.name), recursive: true});
  }
  deletes.push({path: projectPath, recursive: false});
  return deletes;
}

export function planUninstall(repo, {keepMissions = false, fs = fsDefault, now = new Date()} = {}) {
  const io = pickFs(fs);
  const projectPath = path.join(repo, AUTOPILOT_DIR);
  const setUp = io.existsSync(projectPath);
  if (!setUp) return {projectPath, setUp: false, deletes: [], edits: [], moves: []};

  const moves = [];
  const missions = path.join(projectPath, MISSIONS_DIR);
  if (keepMissions && io.existsSync(missions)) {
    const base = `autopilot-missions-archive-${dateStamp(now)}`;
    let candidate = base;
    let suffix = 2;
    while (io.existsSync(path.join(repo, candidate))) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    moves.push({from: missions, to: path.join(repo, candidate)});
  }

  const edits = [];
  const gitignore = path.join(repo, ".gitignore");
  if (io.existsSync(gitignore)) {
    const before = io.readFileSync(gitignore, "utf8");
    const {changed, after} = rewriteGitignoreRemoveAutopilot(before);
    if (changed) edits.push({path: gitignore, before, after});
  }

  const deletes = planDeletes(projectPath, keepMissions, io);
  // Mission 090 task 2.5: remove rendered agent command files (registry
  // paths) that exist on disk. Existence-checked via `io` so a repo without
  // command files keeps the pinned deletes shape; the absent-`.autopilot/`
  // early return above stays so nothing is removed when not set up.
  const skillEntry = getAgentEntry("antigravity");
  const skillsDirAbs = path.join(repo, skillEntry.commandsDir);
  const removedSkillDirs = new Set();
  for (const rel of allCommandRelPaths()) {
    const abs = path.join(repo, rel);
    if (!io.existsSync(abs)) continue;
    if (rel.startsWith(`${skillEntry.commandsDir}/`)) {
      // Generated skill dir: removed only when its file carries the generated
      // marker and the dir holds nothing else (user skills are never touched).
      const dir = path.dirname(abs);
      try {
        if (isGeneratedSkillContent(io.readFileSync(abs, "utf8")) && io.readdirSync(dir).length === 1) {
          deletes.push({path: abs, recursive: false});
          deletes.push({path: dir, recursive: false});
          removedSkillDirs.add(dir);
        }
      } catch {
        // Unreadable: leave it.
      }
      continue;
    }
    deletes.push({path: abs, recursive: false});
  }
  try {
    const entries = io.readdirSync(skillsDirAbs);
    if (removedSkillDirs.size && entries.every((e) => removedSkillDirs.has(path.join(skillsDirAbs, e)))) {
      deletes.push({path: skillsDirAbs, recursive: false});
    }
  } catch {
    // Absent skills dir: nothing to drop.
  }
  // Legacy (pre-dot) generated command files: exact names only, plus the
  // old `.claude/commands/ap/` dir when nothing but those files was in it.
  const legacyPresent = new Set();
  for (const rel of legacyCommandRelPaths()) {
    const abs = path.join(repo, rel);
    if (io.existsSync(abs)) {
      deletes.push({path: abs, recursive: false});
      legacyPresent.add(abs);
    }
  }
  for (const layout of LEGACY_COMMAND_LAYOUTS) {
    if (!layout.removeDirIfEmpty) continue;
    const dir = path.join(repo, layout.dir);
    try {
      const entries = io.readdirSync ? io.readdirSync(dir) : [];
      if (entries.length && entries.every((e) => legacyPresent.has(path.join(dir, e)))) {
        deletes.push({path: dir, recursive: false});
      }
    } catch {
      // Absent dir: nothing to remove.
    }
  }
  return {projectPath, setUp: true, deletes, edits, moves};
}

// Single side-effecting boundary. Order is load-bearing: moves first (the
// archive must exist before the directory that still contains `missions/`
// is removed), then deletes, then file edits.
export function executeUninstall(plan, {fs = fsDefault} = {}) {
  const io = pickFs(fs);
  if (!plan) return;
  for (const move of plan.moves || []) {
    io.mkdirSync(path.dirname(move.to), {recursive: true});
    io.renameSync(move.from, move.to);
  }
  for (const del of plan.deletes || []) {
    if (del.recursive) {
      io.rmSync(del.path, {recursive: true, force: true});
    } else {
      // A non-recursive entry is a directory the plan expects to be empty by
      // now (`.autopilot/` once `missions/` moved out and every sibling was
      // deleted). `rmSync` WITHOUT `recursive` unlinks files only and throws
      // ERR_FS_EISDIR on a directory, so an empty directory goes through
      // `rmdirSync`; a lone file (ENOTDIR) through `unlinkSync`.
      try { io.rmdirSync(del.path); } catch { io.unlinkSync(del.path); }
    }
  }
  for (const edit of plan.edits || []) {
    io.writeFileSync(edit.path, edit.after);
  }
}
