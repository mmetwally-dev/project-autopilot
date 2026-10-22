import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as standalone from "../adapters/standalone.mjs";

// Test C-readonly: detect()/state()/tasks() make zero filesystem changes,
// even with a legacy `.autopilot/standalone/PLAN.md` present. They must never
// migrate, create, delete, or modify anything — migration lives exclusively
// in `ensureStandaloneMigrated` (wired into write-capable entry points only).
function snapshotTree(root) {
  const entries = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) {
        entries.set(`dir:${rel}`, "dir");
        walk(full);
      } else {
        const st = fs.statSync(full);
        entries.set(`file:${rel}`, `${st.mtimeMs}:${st.size}:${fs.readFileSync(full, "utf8")}`);
      }
    }
  };
  walk(root);
  return [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-standalone-readonly-"));
try {
  // Seed a legacy fixed-path plan, as a pre-fix repo would have.
  const legacyFile = path.join(root, ".autopilot", "standalone", "PLAN.md");
  const legacyText = "# Plan\n\n- [ ] Add login\n- [ ] Verify login\n";
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, legacyText);

  // planPath builds the per-mission path, never the legacy fixed path.
  assert.equal(
    standalone.planPath(root, "001-demo"),
    path.join(root, ".autopilot", "missions", "001-demo", "PLAN.md")
  );

  // Static guard: the adapter must not reference the legacy path, mission
  // resolution, or migration — nor perform writes outside markDone.
  const src = fs.readFileSync(fileURLToPath(new URL("../adapters/standalone.mjs", import.meta.url)), "utf8");
  assert.match(src, /"\.autopilot",\s*"missions"/);
  assert.ok(!src.includes('"standalone","PLAN') && !src.includes("'standalone'"), "legacy fixed path must be gone");
  assert.ok(!src.includes("resolveStandaloneMission"), "adapter must not resolve missions");
  assert.ok(!src.includes("ensureStandaloneMigrated"), "adapter must not migrate");
  assert.ok(!src.includes("renameSync"), "adapter must not move files");

  // Read-only calls over a repo with ONLY a legacy plan: zero filesystem changes.
  const before = snapshotTree(root);
  assert.equal(standalone.detect(root, "001-demo"), false);
  assert.deepEqual(standalone.tasks(root, "001-demo"), []);
  let s = standalone.state(root, "001-demo");
  assert.equal(s.status, "missing");
  // Unresolved mission (no live request, nothing persisted) also reads clean.
  assert.equal(standalone.detect(root), false);
  assert.deepEqual(standalone.tasks(root), []);
  s = standalone.state(root);
  assert.equal(s.status, "missing");
  const after = snapshotTree(root);
  assert.deepEqual(after, before, "detect/state/tasks modified the filesystem");
  assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyText, "legacy plan was touched");
  assert.ok(!fs.existsSync(path.join(root, ".autopilot", "missions")), "missions dir was created");
  assert.ok(!fs.existsSync(path.join(root, ".autopilot", "MIGRATION.md")), "migration log was created");

  // Per-mission happy path: reads/writes scope to the given mission only.
  const missionPlanFile = standalone.planPath(root, "001-demo");
  const missionTasksFile = standalone.tasksPath(root, "001-demo");
  fs.mkdirSync(path.dirname(missionPlanFile), { recursive: true });
  fs.writeFileSync(missionPlanFile, "# Plan\n\nObjective: demo\n");
  fs.writeFileSync(missionTasksFile, "## Phase 1: General\n\n- [ ] Add login\n- [ ] Verify login\n");
  assert.equal(standalone.detect(root, "001-demo"), true);
  assert.equal(standalone.detect(root, "002-other"), false);
  assert.equal(standalone.tasks(root, "001-demo").length, 2);
  assert.equal(standalone.tasks(root, "002-other").length, 0);
  s = standalone.state(root, "001-demo");
  assert.equal(s.status, "partial");
  assert.equal(s.planFile, missionPlanFile);
  assert.equal(s.tasksFile, missionTasksFile);
  standalone.markDone(root, "001-demo", 3);
  assert.equal(standalone.tasks(root, "001-demo")[0].done, true);
  assert.equal(standalone.tasks(root, "001-demo")[1].done, false);
  assert.equal(standalone.state(root, "001-demo").entryIndex, 1);
  // No cross-mission bleed, legacy file still byte-identical.
  assert.ok(!fs.existsSync(standalone.planPath(root, "002-other")));
  assert.ok(!fs.existsSync(standalone.tasksPath(root, "002-other")));
  assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyText);

  // planPath fails closed on an unsanitized/traversal mission string instead
  // of silently building a path that escapes `.autopilot/missions` — it must
  // never trust `mission` (documented above as "resolved exclusively by the
  // caller") to already be safe.
  assert.throws(
    () => standalone.planPath(root, "../../../outside"),
    /UNSAFE_MISSION_NAME/,
  );
  assert.throws(
    () => standalone.detect(root, "../../../outside"),
    /UNSAFE_MISSION_NAME/,
  );
  assert.ok(
    !fs.existsSync(path.resolve(root, "..", "..", "outside")),
    "nothing must be written outside the repo",
  );

  console.log("standalone readonly tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
