#!/usr/bin/env node
// Backlog #92: antigravity slash commands via skills dirs
// (.agents/skills/ap.<cmd>/SKILL.md). Real-fs fixtures under $TMPDIR.
// Run: node scripts/test-agy-skill-commands.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COMMAND_FILES,
  SKILL_GENERATED_MARKER,
  getAgentEntry,
  installAgentCommands,
  renderAgentCommands,
} from "./agent-command-registry.mjs";
import { planUninstall, executeUninstall } from "./uninstall.mjs";

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${String(detail).slice(0, 300)}`}`);
  if (!ok) failed++;
};

const tmp = process.env.TMPDIR || os.tmpdir();
// Backlog open #7: agy skills render every command EXCEPT the user-only
// mission-control pair stop/cancel (skills are model-invocable, no opt-out).
const excluded = getAgentEntry("antigravity").excludedCommands ?? [];
const names = COMMAND_FILES.map((c) => c.name).filter((n) => !excluded.includes(n));
const manifest = { antigravity: { binary: "agy" }, claude: { binary: "claude" }, opencode: { binary: "opencode" } };

function fixture() {
  const repo = fs.mkdtempSync(path.join(tmp, "ap-agy-skills-"));
  const bin = path.join(repo, "fakebin");
  fs.mkdirSync(bin);
  for (const b of ["agy"]) {
    fs.writeFileSync(path.join(bin, b), "#!/bin/sh\n", { mode: 0o755 });
  }
  return { repo, pathEnv: bin };
}
const skillsDir = (repo) => path.join(repo, ".agents", "skills");

// ── Render ──
{
  const rendered = renderAgentCommands("antigravity");
  check("[render] eight skill files at .agents/skills/ap.<cmd>/SKILL.md",
    JSON.stringify(rendered.map((r) => r.relPath).sort())
    === JSON.stringify(names.map((n) => `.agents/skills/ap.${n}/SKILL.md`).sort()),
    JSON.stringify(rendered.map((r) => r.relPath)));
  check("[render] user-only stop/cancel are never rendered for agy",
    !rendered.some((r) => /ap\.(stop|cancel)\//.test(r.relPath))
    && names.length === 8,
    JSON.stringify(rendered.map((r) => r.relPath)));
  const plan = rendered.find((r) => r.relPath === ".agents/skills/ap.plan/SKILL.md");
  check("[render] frontmatter has name + description and marker",
    plan.content.startsWith("---\nname: ap.plan\ndescription: \"Step 1 only: give a request → write a reviewed plan + task list, then stop\"\n---\n")
    && plan.content.includes(SKILL_GENERATED_MARKER), plan.content);
  check("[render] body carries the stage command with <arguments> placeholder",
    plan.content.includes("`ap run --stage planning <arguments>`") && !plan.content.includes("$ARGUMENTS"), plan.content);
  const run = rendered.find((r) => r.relPath === ".agents/skills/ap.run/SKILL.md");
  check("[render] full-pipeline skill has no --stage", run.content.includes("`ap run <arguments>`"), run.content);
  const adhoc = rendered.find((r) => r.relPath === ".agents/skills/ap.code-review/SKILL.md");
  check("[render] adhoc skill uses its invocation", adhoc.content.includes("`ap code-review <arguments>`"), adhoc.content);
}

// ── Claude / opencode unchanged ──
{
  const cl = renderAgentCommands("claude").find((r) => r.relPath === ".claude/commands/ap.plan.md");
  check("[unchanged] claude ap.plan.md byte-identical",
    cl.content === "---\ndescription: \"Step 1 only: give a request → write a reviewed plan + task list, then stop\"\n---\n\nap run --stage planning $ARGUMENTS\n", cl.content);
  const oc = renderAgentCommands("opencode").find((r) => r.relPath === ".opencode/command/ap.run.md");
  check("[unchanged] opencode ap.run.md byte-identical",
    oc.content === "---\ndescription: \"Do the whole job: give a request → plan, code, review, test until done\"\n---\n\nap run $ARGUMENTS\n", oc.content);
}

// ── Install: idempotent, user skills untouched ──
{
  const { repo, pathEnv } = fixture();
  try {
    fs.mkdirSync(path.join(skillsDir(repo), "project-autopilot"), { recursive: true });
    fs.writeFileSync(path.join(skillsDir(repo), "project-autopilot", "SKILL.md"), "mine\n");
    fs.mkdirSync(path.join(skillsDir(repo), "ap.plan"), { recursive: true });
    fs.writeFileSync(path.join(skillsDir(repo), "ap.plan", "SKILL.md"), "user-owned ap.plan\n");
    const first = installAgentCommands(repo, { manifest, pathEnv });
    check("[install] detects antigravity only", JSON.stringify(first.detected) === '["antigravity"]', JSON.stringify(first.detected));
    check("[install] user skill with same name is not overwritten",
      fs.readFileSync(path.join(skillsDir(repo), "ap.plan", "SKILL.md"), "utf8") === "user-owned ap.plan\n");
    const ok = names.filter((n) => n !== "plan").every((n) => {
      const p = path.join(skillsDir(repo), `ap.${n}`, "SKILL.md");
      return fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(SKILL_GENERATED_MARKER);
    });
    check("[install] other seven generated skill files written", ok);
    const snap = () => JSON.stringify(
      fs.readdirSync(skillsDir(repo)).sort().map((d) => [d, fs.readFileSync(path.join(skillsDir(repo), d, "SKILL.md"), "utf8")]),
    );
    const before = snap();
    installAgentCommands(repo, { manifest, pathEnv });
    check("[install] refresh is idempotent", snap() === before);
    check("[install] project-autopilot skill untouched",
      fs.readFileSync(path.join(skillsDir(repo), "project-autopilot", "SKILL.md"), "utf8") === "mine\n");

    // ── Uninstall: only generated dirs, user skills kept ──
    fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
    executeUninstall(planUninstall(repo, {}));
    check("[uninstall] generated skill dirs removed",
      names.filter((n) => n !== "plan").every((n) => !fs.existsSync(path.join(skillsDir(repo), `ap.${n}`))));
    check("[uninstall] user ap.plan and project-autopilot skills kept",
      fs.existsSync(path.join(skillsDir(repo), "ap.plan", "SKILL.md"))
      && fs.existsSync(path.join(skillsDir(repo), "project-autopilot", "SKILL.md")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

// ── Uninstall drops an otherwise-empty .agents/skills/ ──
{
  const { repo, pathEnv } = fixture();
  try {
    installAgentCommands(repo, { manifest, pathEnv });
    fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
    executeUninstall(planUninstall(repo, {}));
    check("[uninstall] empty .agents/skills removed", !fs.existsSync(skillsDir(repo)));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
