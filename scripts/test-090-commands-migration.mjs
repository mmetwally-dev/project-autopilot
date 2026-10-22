#!/usr/bin/env node
// Dot-name migration: install/refresh removes the previously generated
// old-format command files (exact names only) and keeps user files.
// Run: node scripts/test-090-commands-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installAgentCommands, legacyCommandRelPaths, removeLegacyCommandFiles } from "./agent-command-registry.mjs";

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-090-migrate-"));
const seed = (repo, rel, body = "x\n") => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
try {
  // Fake PATH with claude + opencode binaries.
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  for (const b of ["claude", "opencode"]) {
    fs.writeFileSync(path.join(bin, b), "#!/bin/sh\n", { mode: 0o755 });
  }

  const repo = path.join(tmp, "repo");
  const legacy = legacyCommandRelPaths();
  for (const rel of legacy) seed(repo, rel, "old\n");
  seed(repo, ".claude/commands/mine.md", "user\n");
  seed(repo, ".opencode/command/ap-custom.md", "user\n");
  seed(repo, ".opencode/command/other.md", "user\n");

  const result = installAgentCommands(repo, { pathEnv: bin });
  check("[migrate] every legacy generated file removed",
    legacy.every((rel) => !fs.existsSync(path.join(repo, rel))),
    legacy.filter((rel) => fs.existsSync(path.join(repo, rel))).join(","));
  check("[migrate] result reports every migrated legacy path", result.migrated.length === legacy.length, `${String(result.migrated.length)} of ${legacy.length}`);
  check("[migrate] empty legacy .claude/commands/ap dir removed",
    !fs.existsSync(path.join(repo, ".claude/commands/ap")), "");
  check("[migrate] unrelated user files kept",
    [".claude/commands/mine.md", ".opencode/command/ap-custom.md", ".opencode/command/other.md"]
      .every((rel) => fs.readFileSync(path.join(repo, rel), "utf8") === "user\n"), "");
  check("[migrate] new dot-named files written",
    fs.existsSync(path.join(repo, ".claude/commands/ap.plan.md"))
    && fs.existsSync(path.join(repo, ".opencode/command/ap.plan-review.md")), "");

  // Non-empty legacy ap/ dir keeps dir + user file.
  const repo2 = path.join(tmp, "repo2");
  seed(repo2, ".claude/commands/ap/plan.md", "old\n");
  seed(repo2, ".claude/commands/ap/mine.md", "user\n");
  const removed = removeLegacyCommandFiles(repo2);
  check("[migrate] ap/ dir with a user file is kept, generated file removed",
    removed.length === 1
    && !fs.existsSync(path.join(repo2, ".claude/commands/ap/plan.md"))
    && fs.existsSync(path.join(repo2, ".claude/commands/ap/mine.md")), JSON.stringify(removed));

  // Idempotent on a clean repo.
  check("[migrate] second run migrates nothing",
    installAgentCommands(repo, { pathEnv: bin }).migrated.length === 0, "");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
