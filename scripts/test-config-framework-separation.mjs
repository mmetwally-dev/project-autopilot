import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {skillRoot as root} from "./paths.mjs";

const setup = fs.readFileSync(path.join(root, "scripts", "setup.mjs"), "utf8");

assert.doesNotMatch(
  setup,
  /No supported planning framework detected\./,
  "configuration must not reject a saved framework merely because its artifacts are absent"
);
assert.match(
  setup,
  /let\s+framework\s*=\s*current\?\.project\s*\?\.planning_framework\s*\|\|\s*["']{2}/s,
  "edit mode must initialize the framework from saved project configuration"
);
// The choice list moved into frameworkChoicesFor() (shared by the wizard and
// the reconfigure path, 2026-09-28); the old inline `if (!frameworkChoices
// .length) { … standalone … }` pin went stale with that refactor.
assert.match(
  setup,
  /function\s+frameworkChoicesFor\s*\([\s\S]*?choices\.push\(\s*\{\s*id:\s*["']standalone["'][\s\S]*?["']Continue without a planning framework["']/,
  "missing framework artifacts must retain the non-failing standalone choice"
);
assert.match(
  setup,
  /frameworkChoices\s*=\s*frameworkChoicesFor\(\s*["']{2}\s*,\s*detectedFrameworks\s*\)/,
  "the first-run wizard must build its choices through frameworkChoicesFor()"
);

console.log("config/framework separation test passed");
