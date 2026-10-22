// Shared disposable-skill-copy helper for tests that need a real, on-disk
// copy of the skill to run a subprocess against (test-runtime-mode-launcher.mjs,
// test-runtime-mode-router.mjs, test-setup-runtime-mode-selection.mjs all had
// their own byte-identical copy of this). A test fixture copy exists to give
// a subprocess a real `scripts/`/`adapters/`/`bin/` tree to run against — it
// must never drag along this checkout's own runtime/project state
// (`.autopilot`, `.agent`, `.claude`) or its git/dependency directories
// (`.git`, `node_modules`), which are large, irrelevant to what's under test,
// and would leak this repo's actual mission history into a disposable copy.
//
// Exact top-level directory names only (not a substring/glob match): a
// legitimate file or directory that merely contains one of these names
// (e.g. `scripts/test-fixtures/.autopilot-fixture/`) must still be copied.
export const SKILL_COPY_EXCLUDED_TOP_LEVEL_DIRS = new Set([
  ".git",
  ".autopilot",
  ".agent",
  ".claude",
  "node_modules",
]);

import fs from "node:fs";
import path from "node:path";

export function copySkillCanonical(root, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(root)) {
    if (SKILL_COPY_EXCLUDED_TOP_LEVEL_DIRS.has(entry)) continue;
    fs.cpSync(path.join(root, entry), path.join(dest, entry), { recursive: true, force: true });
  }
}
