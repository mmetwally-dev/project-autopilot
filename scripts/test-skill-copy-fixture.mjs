// Proves the shared `copySkillCanonical` helper (scripts/test-fixtures/skill-copy.mjs)
// used by test-runtime-mode-launcher.mjs, test-runtime-mode-router.mjs, and
// test-setup-runtime-mode-selection.mjs: excludes exactly the runtime/project
// state directories it must never leak into a disposable fixture copy, while
// preserving every real skill source file (including legitimate new
// top-level entries this test has no prior knowledge of) and never matching
// on a substring (a real entry that merely contains an excluded name, e.g.
// `.autopilot-like`, must still be copied).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {copySkillCanonical, SKILL_COPY_EXCLUDED_TOP_LEVEL_DIRS} from "./test-fixtures/skill-copy.mjs";

const src = fs.mkdtempSync(path.join(os.tmpdir(), "ap-skillcopy-src-"));
const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ap-skillcopy-dest-"));
try {
  // Excluded runtime/project state — must never be copied.
  for (const dir of SKILL_COPY_EXCLUDED_TOP_LEVEL_DIRS) {
    fs.mkdirSync(path.join(src, dir), {recursive: true});
    fs.writeFileSync(path.join(src, dir, "marker.txt"), `state from ${dir}`);
  }

  // Real skill source directories that must be preserved, with nested content.
  const preserved = ["scripts", "test-fixtures", "adapters", "bin", "contracts", "references", "docs", "manifests"];
  for (const dir of preserved) {
    fs.mkdirSync(path.join(src, dir), {recursive: true});
    fs.writeFileSync(path.join(src, dir, "keep.txt"), `real content from ${dir}`);
  }
  // A legitimate top-level file (not a directory).
  fs.writeFileSync(path.join(src, "SKILL.md"), "# skill doc");
  // A legitimate NEW top-level entry the helper has no special knowledge of —
  // an exclude-list (not an allow-list) must preserve this automatically.
  fs.mkdirSync(path.join(src, "some-future-directory"), {recursive: true});
  fs.writeFileSync(path.join(src, "some-future-directory", "keep.txt"), "future content");
  // Substring trap: a legitimate entry whose name merely CONTAINS an excluded
  // name must still be copied — the match must be exact top-level-name only.
  fs.mkdirSync(path.join(src, ".autopilot-like"), {recursive: true});
  fs.writeFileSync(path.join(src, ".autopilot-like", "keep.txt"), "not actually excluded");
  fs.mkdirSync(path.join(src, "not.autopilot"), {recursive: true});
  fs.writeFileSync(path.join(src, "not.autopilot", "keep.txt"), "also not actually excluded");

  copySkillCanonical(src, dest);

  for (const dir of SKILL_COPY_EXCLUDED_TOP_LEVEL_DIRS) {
    assert.ok(!fs.existsSync(path.join(dest, dir)), `excluded directory "${dir}" must not be copied`);
  }
  for (const dir of preserved) {
    const copied = path.join(dest, dir, "keep.txt");
    assert.ok(fs.existsSync(copied), `preserved directory "${dir}" must be copied`);
    assert.equal(fs.readFileSync(copied, "utf8"), `real content from ${dir}`);
  }
  assert.equal(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"), "# skill doc");
  assert.equal(fs.readFileSync(path.join(dest, "some-future-directory", "keep.txt"), "utf8"), "future content", "a legitimate new top-level entry must be preserved (exclude-list, not allow-list)");
  assert.equal(fs.readFileSync(path.join(dest, ".autopilot-like", "keep.txt"), "utf8"), "not actually excluded", "substring match on an excluded name must not exclude an unrelated entry");
  assert.equal(fs.readFileSync(path.join(dest, "not.autopilot", "keep.txt"), "utf8"), "also not actually excluded", "substring match on an excluded name must not exclude an unrelated entry");

  console.log("skill-copy fixture tests passed");
} finally {
  fs.rmSync(src, {recursive: true, force: true});
  fs.rmSync(dest, {recursive: true, force: true});
}
