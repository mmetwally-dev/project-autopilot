#!/usr/bin/env node
// Mission 090 task 2.5: uninstall removes rendered agent command files.
// Covers: `.autopilot/` present -> existing rendered files are planned as
// deletes and executed away; `.autopilot/` absent -> nothing removed (early
// return stays); missing files are not planned. Real-fs fixtures under
// $TMPDIR, never inside the repo.
// Run: node scripts/test-090-uninstall-commands.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allCommandRelPaths, legacyCommandRelPaths, renderAgentCommands } from "./agent-command-registry.mjs";
import { planUninstall, executeUninstall } from "./uninstall.mjs";

const tmpBase = process.env.TMPDIR || os.tmpdir();

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

function makeRepo(prefix) {
  return fs.mkdtempSync(path.join(tmpBase, `ap-090-uninstall-cmds-${prefix}-`));
}

function seedAutopilot(repo) {
  fs.mkdirSync(path.join(repo, ".autopilot", "missions"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), "{}\n");
}

function seedCommandFiles(repo, rels) {
  for (const rel of rels) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, rel.startsWith(".agents/skills/") ? renderAgentCommands("antigravity").find((r) => r.relPath === rel).content : `rendered ${rel}\n`);
  }
}

const ALL = allCommandRelPaths();
check("precondition: registry lists ten claude + ten opencode + eight antigravity skill files (stop/cancel excluded for agy, open #7)",
  ALL.length === 28
  && ALL.filter((r) => r.startsWith(".claude/commands/ap.") && r.endsWith(".md")).length === 10
  && ALL.filter((r) => r.startsWith(".opencode/command/ap.") && r.endsWith(".md")).length === 10
  && ALL.filter((r) => r.startsWith(".agents/skills/ap.") && r.endsWith("/SKILL.md")).length === 8
  && !ALL.some((r) => r.includes("ap.stop") && r.startsWith(".agents/"))
  && !ALL.some((r) => r.includes("ap.cancel") && r.startsWith(".agents/")),
  JSON.stringify(ALL));

// ── Present: existing rendered files are planned + executed away ──
{
  const repo = makeRepo("present");
  try {
    seedAutopilot(repo);
    seedCommandFiles(repo, ALL);
    const plan = planUninstall(repo, {});
    check("present: setUp is true", plan.setUp === true, plan.setUp);
    for (const rel of ALL) {
      const abs = path.join(repo, rel);
      check(`present: delete planned for ${rel}`,
        plan.deletes.some((d) => d.path === abs), JSON.stringify(plan.deletes));
    }
    executeUninstall(plan);
    check("present: .autopilot removed", !fs.existsSync(path.join(repo, ".autopilot")));
    check("present: every rendered command file removed",
      ALL.every((rel) => !fs.existsSync(path.join(repo, rel))),
      ALL.filter((rel) => fs.existsSync(path.join(repo, rel))));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

// ── Present, no command files: pinned shape unchanged ──
{
  const repo = makeRepo("nocmds");
  try {
    seedAutopilot(repo);
    const plan = planUninstall(repo, {});
    const ap = path.join(repo, ".autopilot");
    check("no-files: only the recursive .autopilot delete",
      plan.deletes.length === 1 && plan.deletes[0].path === ap && plan.deletes[0].recursive === true,
      JSON.stringify(plan.deletes));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

// ── Present, partial files: only existing ones planned ──
{
  const repo = makeRepo("partial");
  try {
    seedAutopilot(repo);
    const subset = ALL.slice(0, 2);
    seedCommandFiles(repo, subset);
    const plan = planUninstall(repo, {});
    const planned = plan.deletes.map((d) => d.path);
    check("partial: existing files planned",
      subset.every((rel) => planned.includes(path.join(repo, rel))), JSON.stringify(planned));
    check("partial: missing files not planned",
      ALL.slice(2).every((rel) => !planned.includes(path.join(repo, rel))), JSON.stringify(planned));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

// ── keepMissions: command files still planned ──
{
  const repo = makeRepo("keep");
  try {
    seedAutopilot(repo);
    seedCommandFiles(repo, ALL);
    const plan = planUninstall(repo, { keepMissions: true });
    check("keep-missions: existing command files planned",
      ALL.every((rel) => plan.deletes.some((d) => d.path === path.join(repo, rel))),
      JSON.stringify(plan.deletes));
    executeUninstall(plan);
    check("keep-missions: command files removed",
      ALL.every((rel) => !fs.existsSync(path.join(repo, rel))), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

// ── Absent: command files present but .autopilot/ absent -> removes nothing ──
{
  const repo = makeRepo("absent");
  try {
    seedCommandFiles(repo, ALL);
    const plan = planUninstall(repo, {});
    check("absent: setUp is false", plan.setUp === false, plan.setUp);
    check("absent: no deletes", plan.deletes.length === 0, JSON.stringify(plan.deletes));
    check("absent: no edits", plan.edits.length === 0, "");
    check("absent: no moves", plan.moves.length === 0, "");
    executeUninstall(plan);
    check("absent: rendered files untouched",
      ALL.every((rel) => fs.existsSync(path.join(repo, rel))), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

// ── Legacy (pre-dot) files: removed by uninstall, user files kept ──
{
  const repo = makeRepo("legacy");
  try {
    seedAutopilot(repo);
    const legacy = legacyCommandRelPaths();
    seedCommandFiles(repo, legacy);
    seedCommandFiles(repo, [".opencode/command/ap-mine.md", ".opencode/command/other.md"]);
    executeUninstall(planUninstall(repo, {}));
    check("legacy: every old-format generated file removed",
      legacy.every((rel) => !fs.existsSync(path.join(repo, rel))),
      legacy.filter((rel) => fs.existsSync(path.join(repo, rel))));
    check("legacy: old .claude/commands/ap dir removed once empty",
      !fs.existsSync(path.join(repo, ".claude", "commands", "ap")), "");
    check("legacy: user files with non-generated names kept",
      fs.existsSync(path.join(repo, ".opencode/command/ap-mine.md"))
      && fs.existsSync(path.join(repo, ".opencode/command/other.md")), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
{
  const repo = makeRepo("legacy-userfile");
  try {
    seedAutopilot(repo);
    seedCommandFiles(repo, [".claude/commands/ap/plan.md", ".claude/commands/ap/mine.md"]);
    executeUninstall(planUninstall(repo, {}));
    check("legacy: ap/ dir with a user file keeps dir and file, removes generated",
      !fs.existsSync(path.join(repo, ".claude/commands/ap/plan.md"))
      && fs.existsSync(path.join(repo, ".claude/commands/ap/mine.md")), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
