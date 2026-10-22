import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Files under the live repository's .autopilot/ that no test may modify.
// state.json is deliberately NOT hashed: the orchestrator itself runs the
// suite as its phase gate and legitimately writes .autopilot/state.json while
// the suite runs, so watching it would fail every gate.
// config.meta.json is tracked by presence only: the migration that creates it
// is itself the signal that a test loaded and migrated the live config.
export const LIVE_GUARD_HASHED_FILES = ["config.json"];
export const LIVE_GUARD_META_FILE = "config.meta.json";

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// Snapshot the live .autopilot/ files. A file that does not exist records
// null (absent), so a test creating it is reported as a change.
export function snapshotLiveFiles(root) {
  const autoDir = path.join(String(root), ".autopilot");
  const hashed = {};
  for (const name of LIVE_GUARD_HASHED_FILES) {
    const filePath = path.join(autoDir, name);
    try {
      hashed[name] = sha256File(filePath);
    } catch (error) {
      if (error && error.code === "ENOENT") hashed[name] = null;
      else throw error;
    }
  }
  return {
    hashed,
    metaExists: fs.existsSync(path.join(autoDir, LIVE_GUARD_META_FILE)),
  };
}

// Absolute paths of live files that changed between two snapshots, in a
// stable order. An absent -> present or present -> absent transition counts
// as a change, and so does a newly appeared config.meta.json.
export function changedLiveFiles(root, before, after) {
  const autoDir = path.join(String(root), ".autopilot");
  const changed = [];
  for (const name of LIVE_GUARD_HASHED_FILES) {
    if (before.hashed[name] !== after.hashed[name]) changed.push(path.join(autoDir, name));
  }
  if (!before.metaExists && after.metaExists) changed.push(path.join(autoDir, LIVE_GUARD_META_FILE));
  return changed;
}

export function suiteGuardLine(filePath) {
  return `SUITE GUARD: a test modified the live repository file ${filePath} — tests must use temp repos`;
}
