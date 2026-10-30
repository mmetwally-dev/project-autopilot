import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The folder holding package.json/bin/scripts of the running ap. Derived from
// this module's own import.meta.url (the module ships inside that folder), so
// it never depends on the caller's cwd.
export function skillCopyRoot(scriptUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(scriptUrl)), "..");
}

// How this copy was installed: inside a node_modules tree (npm-global), a Git
// checkout (.git next to package.json), or any other copied skill folder.
export function skillCopyMode(root = skillCopyRoot()) {
  const resolved = path.resolve(root);
  if (resolved.split(/[\\/]/).includes("node_modules")) return "npm-global";
  try {
    if (fs.statSync(path.join(resolved, ".git")).isDirectory()) return "dev-checkout";
  } catch { /* no .git directory */ }
  return "skill-folder";
}

// The identity the watch report prints: the copy's package version, install
// mode and root path. Never throws: a missing/unreadable package.json leaves
// the version null rather than inventing one.
export function skillCopyInfo(root = skillCopyRoot()) {
  const resolved = path.resolve(root);
  let version = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(resolved, "package.json"), "utf8"));
    if (typeof pkg?.version === "string" && pkg.version) version = pkg.version;
  } catch { /* version stays null */ }
  return { version, mode: skillCopyMode(resolved), path: resolved };
}

// Record the running copy on the mission state.json the watch report reads.
// Called at mission run start; mutates and returns the state object.
export function recordSkillCopy(state, info = skillCopyInfo()) {
  if (!state || typeof state !== "object") return state;
  state.skill = { version: info.version, mode: info.mode, path: info.path };
  return state;
}

// Record the entry command (and the stage it stops after, null = full loop) on
// the mission state at run start; the watch report prints it.
export function recordCommand(state, name, stopAfter = null) {
  state.command = { name, stopAfter };
  return state;
}
