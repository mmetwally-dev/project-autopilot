#!/usr/bin/env node
// Mission 090 task 2.1: per-agent command-file registry assertions.
// Covers: exactly the fixed in/omitted agent list with sources/reasons,
// rendered plan/implement/review/verify/run plus plan-review/code-review/
// verify-file files as flat `.claude/commands/ap.<cmd>.md` invoking `ap run --stage …`
// (adhoc files invoke `ap <plan-review|code-review|verify-file>`) (+ `$ARGUMENTS`
// passthrough, run.md with no `--stage`), a shared branch-free render, and
// room for one more command file later.
// Run: node scripts/test-090-command-registry.mjs
import {
  AGENT_REGISTRY,
  COMMAND_FILES,
  allCommandRelPaths,
  commandRelPath,
  getAgentEntry,
  includedAgents,
  legacyCommandRelPaths,
  renderAgentCommands,
  renderCommandFile,
} from "./agent-command-registry.mjs";

let failed = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

// ── Fixed agent list: one included, four omitted, with sources ──
check("[registry] exactly five agent entries",
  AGENT_REGISTRY.length === 5, JSON.stringify(AGENT_REGISTRY.map((e) => e.agent)));
check("[registry] claude, opencode and antigravity are the included agents",
  JSON.stringify(includedAgents()) === JSON.stringify(["claude", "opencode", "antigravity"]),
  JSON.stringify(includedAgents()));
const claude = getAgentEntry("claude");
check("[registry] claude entry carries dir/format/argument data + source",
  claude !== null
  && claude.status === "included"
  && claude.commandsDir === ".claude/commands"
  && claude.fileNamePrefix === "ap."
  && /frontmatter/.test(`${claude.format} ${claude.template}`)
  && claude.argumentSyntax === "$ARGUMENTS"
  && /^backlog item lines 50-73/.test(claude.source ?? ""),
  JSON.stringify(claude));
const oc = getAgentEntry("opencode");
check("[registry] opencode entry: flat ap. dot names under .opencode/command + verified source",
  oc !== null
  && oc.status === "included"
  && oc.commandsDir === ".opencode/command"
  && oc.fileNamePrefix === "ap."
  && /frontmatter/.test(`${oc.format} ${oc.template}`)
  && oc.argumentSyntax === "$ARGUMENTS"
  && /ap\.plan/.test(oc.source ?? ""),
  JSON.stringify(oc));
{
  const ocRendered = renderAgentCommands("opencode");
  check("[render] opencode renders .opencode/command/ap.{plan,implement,review,verify,run,plan-review,code-review,verify-file,stop,cancel}.md",
    JSON.stringify(ocRendered.map((r) => r.relPath).sort())
    === JSON.stringify(["implement", "plan", "review", "run", "verify", "plan-review", "code-review", "verify-file", "stop", "cancel"].map((n) => `.opencode/command/ap.${n}.md`).sort()),
    JSON.stringify(ocRendered.map((r) => r.relPath)));
  const plan = ocRendered.find((r) => r.file === "ap.plan.md");
  check("[render] opencode ap.plan.md has frontmatter, stage and $ARGUMENTS",
    plan !== undefined && plan.content.startsWith("---\ndescription:")
    && plan.content.includes("ap run --stage planning $ARGUMENTS"),
    JSON.stringify(plan));
}
const omittedExpectations = [
  ["codex", "0.150.1", "no verifiable custom-prompt loader", "~/.codex/prompts"],
  ["cursor", ".cursor/commands", "not verifiable offline"],
];
for (const [agent, ...fragments] of omittedExpectations) {
  const entry = getAgentEntry(agent);
  check(`[registry] ${agent} omitted with reason`,
    entry !== null
    && entry.status === "omitted"
    && typeof entry.reason === "string"
    && fragments.every((fragment) => entry.reason.includes(fragment)),
    JSON.stringify(entry));
}
check("[registry] unknown agent resolves to null",
  getAgentEntry("bogus-agent") === null, "");

// ── Rendered claude command files ──
const rendered = renderAgentCommands("claude");
const byFile = Object.fromEntries(rendered.map((r) => [r.file, r]));
check("[render] exactly plan/implement/review/verify/run/plan-review/code-review/verify-file/stop/cancel files",
  JSON.stringify(Object.keys(byFile).sort())
  === JSON.stringify(["ap.cancel.md", "ap.code-review.md", "ap.implement.md", "ap.plan-review.md", "ap.plan.md", "ap.review.md", "ap.run.md", "ap.stop.md", "ap.verify-file.md", "ap.verify.md"]),
  JSON.stringify(Object.keys(byFile)));
const stageExpectations = [
  ["ap.plan.md", "planning"],
  ["ap.implement.md", "implement"],
  ["ap.review.md", "review"],
  ["ap.verify.md", "verify"],
  ["ap.run.md", null],
];
for (const [file, stage] of stageExpectations) {
  const entry = byFile[file];
  check(`[render] ${file} lives under .claude/commands/`,
    entry !== undefined && entry.relPath === `.claude/commands/${file}`,
    JSON.stringify(entry?.relPath));
  const wantsInvocation = stage === null ? "ap run " : `ap run --stage ${stage}`;
  check(`[render] ${file} invokes \`${wantsInvocation.trim()}\``,
    entry !== undefined && entry.content.includes(wantsInvocation),
    JSON.stringify(entry?.content));
  if (stage !== null) {
    check(`[render] ${file} carries no other --stage value`,
      ["planning", "implement", "review", "verify"]
        .filter((s) => s !== stage)
        .every((s) => !entry.content.includes(`--stage ${s}`)),
      JSON.stringify(entry?.content));
  } else {
    check("[render] run.md passes no --stage flag",
      entry !== undefined && !entry.content.includes("--stage"),
      JSON.stringify(entry?.content));
  }
  check(`[render] ${file} passes $ARGUMENTS through`,
    entry !== undefined && entry.content.includes("$ARGUMENTS"),
    JSON.stringify(entry?.content));
  check(`[render] ${file} uses description frontmatter`,
    entry !== undefined
    && entry.content.startsWith("---\n")
    && entry.content.includes("description:"),
    JSON.stringify(entry?.content.slice(0, 80)));
}

// ── Adhoc command files (mission 091 task 3.1): explicit invocation ──
const invocationExpectations = [
  ["ap.plan-review.md", "ap plan-review"],
  ["ap.code-review.md", "ap code-review"],
  ["ap.verify-file.md", "ap verify-file"],
];
for (const [file, invocation] of invocationExpectations) {
  const entry = byFile[file];
  check(`[render] ${file} lives under .claude/commands/`,
    entry !== undefined && entry.relPath === `.claude/commands/${file}`,
    JSON.stringify(entry?.relPath));
  check(`[render] ${file} invokes \`${invocation}\``,
    entry !== undefined && entry.content.includes(invocation),
    JSON.stringify(entry?.content));
  check(`[render] ${file} passes no --stage flag`,
    entry !== undefined && !entry.content.includes("--stage"),
    JSON.stringify(entry?.content));
  check(`[render] ${file} passes $ARGUMENTS through`,
    entry !== undefined && entry.content.includes("$ARGUMENTS"),
    JSON.stringify(entry?.content));
  check(`[render] ${file} uses description frontmatter`,
    entry !== undefined
    && entry.content.startsWith("---\n")
    && entry.content.includes("description:"),
    JSON.stringify(entry?.content.slice(0, 80)));
}

// ── Byte-identical snapshot of the original five renders ──
// Guards the invocation branch: the stage-based files must render exactly
// as before mission 091 added the adhoc entries.
{
  const snapshot = {
    "ap.plan.md": "---\ndescription: \"Step 1 only: give a request → write a reviewed plan + task list, then stop\"\n---\n\nap run --stage planning $ARGUMENTS\n",
    "ap.implement.md": "---\ndescription: \"Step 2 only: code the next part of the plan, then stop (no review)\"\n---\n\nap run --stage implement $ARGUMENTS\n",
    "ap.review.md": "---\ndescription: \"Step 3 only: review the code just written, then stop\"\n---\n\nap run --stage review $ARGUMENTS\n",
    "ap.verify.md": "---\ndescription: \"Step 4 only: test the code just reviewed and tick its tasks done\"\n---\n\nap run --stage verify $ARGUMENTS\n",
    "ap.run.md": "---\ndescription: \"Do the whole job: give a request → plan, code, review, test until done\"\n---\n\nap run $ARGUMENTS\n",
  };
  for (const [file, expected] of Object.entries(snapshot)) {
    check(`[snapshot] ${file} renders byte-identical`,
      byFile[file] !== undefined && byFile[file].content === expected,
      JSON.stringify(byFile[file]?.content));
  }
}

// ── Frontmatter description is a quoted YAML scalar in every rendered file ──
// A plain scalar may not contain ": " ("Mission: …") — strict YAML (agy
// >=1.3.6 skill frontmatter, Claude/opencode frontmatter) rejects it.
for (const r of rendered) {
  const descLine = r.content.split("\n").find((l) => l.startsWith("description:"));
  check(`[yaml] ${r.file} description is a double-quoted scalar`,
    descLine !== undefined && /^description: "(?:[^"\\]|\\.)*"$/.test(descLine),
    JSON.stringify(descLine));
}

// ── Shared render: no per-agent branches, data-driven ──
check("[render] renderCommandFile names no agent",
  ["claude", "codex", "opencode", "cursor", "antigravity", "cursor-agent", "agy"]
    .every((name) => !renderCommandFile.toString().includes(name)),
  "");
{
  // A synthetic agent entry renders through the same code path.
  const synthetic = {
    agent: "future-agent",
    status: "included",
    commandsDir: ".future/commands/ap",
    format: "markdown-frontmatter",
    template: "description-frontmatter",
    argumentSyntax: "$ARGUMENTS",
  };
  const out = renderCommandFile(synthetic, COMMAND_FILES[0]);
  check("[render] synthetic entry renders via shared path",
    out.includes("ap run --stage planning")
    && out.includes("$ARGUMENTS")
    && commandRelPath(synthetic, COMMAND_FILES[0]) === ".future/commands/ap/plan.md",
    JSON.stringify(out));
}

// ── Room for one more command file later ──
{
  const extended = [
    ...COMMAND_FILES,
    Object.freeze({
      name: "extra",
      file: "extra.md",
      description: "A future command file",
      stage: null,
    }),
  ];
  const out = renderAgentCommands("claude", extended);
  check("[extensible] one more command file renders without restructuring",
    out.length === COMMAND_FILES.length + 1
    && out.some((r) => r.file === "ap.extra.md" && r.relPath === ".claude/commands/ap.extra.md"),
    JSON.stringify(out.map((r) => r.file)));
}

// ── Legacy layout (migration data) ──
{
  const legacy = legacyCommandRelPaths();
  check("[legacy] 20 exact old-format names (claude ap/ dir + opencode ap- prefix)",
    legacy.length === 20
    && legacy.includes(".claude/commands/ap/plan.md")
    && legacy.includes(".claude/commands/ap/verify-file.md")
    && legacy.includes(".opencode/command/ap-plan-review.md")
    && legacy.every((r) => !/\/ap\.[a-z-]+\.md$/.test(r)),
    JSON.stringify(legacy));
}

// ── Backlog open #7: user-only stop/cancel mission-control commands ──
{
  const stop = byFile["ap.stop.md"];
  check("[stop] ap.stop.md invokes `ap stop --yes`",
    stop !== undefined && stop.content.includes("ap stop --yes $ARGUMENTS")
    && !stop.content.includes("--stage"),
    JSON.stringify(stop?.content));
  const cancel = byFile["ap.cancel.md"];
  check("[cancel] ap.cancel.md invokes `ap cancel --yes`",
    cancel !== undefined && cancel.content.includes("ap cancel --yes $ARGUMENTS")
    && !cancel.content.includes("--stage"),
    JSON.stringify(cancel?.content));
  check("[userOnly] both carry the user-only descriptions",
    /"Pause the running mission \(continue later with ap\.run\)"/.test(stop?.content ?? "")
    && /"End the current mission for good"/.test(cancel?.content ?? ""),
    JSON.stringify([stop?.content ?? "", cancel?.content ?? ""]));
  check("[userOnly] claude files carry disable-model-invocation: true frontmatter",
    stop?.content.startsWith("---\ndescription: \"Pause the running mission (continue later with ap.run)\"\ndisable-model-invocation: true\n---\n")
    && cancel?.content.startsWith("---\ndescription: \"End the current mission for good\"\ndisable-model-invocation: true\n---\n"),
    JSON.stringify([stop?.content, cancel?.content]));
  check("[userOnly] interactive mission commands stay out of the registry",
    !COMMAND_FILES.some((c) => ["setup", "config", "uninstall", "reset", "rebase"].includes(c.name)),
    JSON.stringify(COMMAND_FILES.map((c) => c.name)));
  const ocStop = renderAgentCommands("opencode").find((r) => r.file === "ap.stop.md");
  check("[userOnly] opencode ap.stop.md has no disable-model-invocation row (commands are user-typed only)",
    ocStop !== undefined && !ocStop.content.includes("disable-model-invocation"),
    JSON.stringify(ocStop?.content));
  // Antigravity: skills are model-invocable with no opt-out — excluded.
  const agyNames = renderAgentCommands("antigravity").map((r) => r.relPath);
  check("[exclude] antigravity renders eight files with no stop/cancel",
    agyNames.length === 8
    && !agyNames.includes(".agents/skills/ap.stop/SKILL.md")
    && !agyNames.includes(".agents/skills/ap.cancel/SKILL.md"),
    JSON.stringify(agyNames));
  check("[exclude] antigravity entry pins its excludedCommands",
    JSON.stringify(getAgentEntry("antigravity").excludedCommands) === JSON.stringify(["stop", "cancel"]),
    JSON.stringify(getAgentEntry("antigravity").excludedCommands));
  check("[exclude] allCommandRelPaths carries the exclusion",
    allCommandRelPaths().filter((r) => /ap\.(stop|cancel)/.test(r)).every((r) => r.startsWith(".claude/commands/") || r.startsWith(".opencode/command/")),
    JSON.stringify(allCommandRelPaths()));
}

// ── Omitted agents refuse to render ──
for (const [agent] of omittedExpectations) {
  let threw = false;
  try {
    renderAgentCommands(agent);
  } catch {
    threw = true;
  }
  check(`[render] ${agent} refuses to render`, threw, "");
}

console.log(failed ? `${failed} of ${ran} case(s) failed.` : `all ${ran} case(s) passed.`);
process.exit(failed ? 1 : 0);
