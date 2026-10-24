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
  /function\s+frameworkChoicesFor\s*\([\s\S]*?const choices = \[\{\s*id:\s*["']standalone["'][\s\S]*?standaloneChoiceLabel\s*\(/,
  "missing framework artifacts must retain the non-failing standalone choice"
);
assert.match(
  setup,
  /Standalone — Autopilot writes the plan itself/,
  "the standalone choice must explain what Autopilot writes"
);
assert.match(
  setup,
  /Standalone — Autopilot writes the plan itself: a PLAN\.md \(the plan\) and\\n   TASKS\.md \(the task list\) for each mission/,
  "the standalone label must be the exact short wording"
);
assert.doesNotMatch(setup, /ignore \$\{|Standalone — ignore/, "no 'ignore <framework>' standalone variant may exist");
assert.match(
  setup,
  /frameworkChoices\s*=\s*frameworkChoicesFor\(\s*current\?\.project\?\.planning_framework\s*\|\|\s*["']{2}\s*,\s*detectedFrameworks\s*\)/,
  "the first-run wizard must build its choices through frameworkChoicesFor(), carrying a saved framework"
);
assert.match(
  setup,
  /\.filter\(x => x\.id !== "gsd"\)/,
  "GSD must be filtered out of the framework choices (backlog #4)"
);
assert.doesNotMatch(
  setup,
  /choices\.push\(\{\s*id:\s*["']gsd["']/,
  "GSD must never be offered as a new framework choice"
);
assert.match(
  setup,
  /if \(currentFramework === "gsd"\) \{[\s\S]*?id: "gsd",[\s\S]*?current value \(not yet reviewed\)/,
  "a saved GSD config keeps its current value, marked not yet reviewed"
);
assert.match(
  setup,
  /✓ Standalone: built in — Autopilot writes the plan itself \(PLAN\.md \+ TASKS\.md per mission\)/,
  "framework availability must show the built-in Standalone first"
);
assert.match(
  setup,
  /· GSD: found \(\.planning\/\) — support comes in a future version/,
  "a detected .planning/ must be reported as found but not yet supported"
);

console.log("config/framework separation test passed");
