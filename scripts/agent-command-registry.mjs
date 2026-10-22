// Per-agent command-file registry for `/ap.*` slash commands (SpecKit-style
// dot names, identical in every CLI: /ap.plan, /ap.run, /ap.plan-review ...).
//
// Data-driven registry: each agent entry carries its commands dir, file
// format/template fields, and argument syntax; a single shared render
// function turns (agent entry x command file) into file content. Adding a
// new agent costs one registry entry; adding a command file costs one
// COMMAND_FILES entry — no render/setup restructuring.
//
// Fixed dispositions (asserted in scripts/test-090-command-registry.mjs):
//   claude INCLUDED (.claude/commands/ap.<cmd>.md -> /ap.plan ...)
//   opencode INCLUDED (.opencode/command/ap.<cmd>.md -> /ap.plan ...; the
//     command name is the flat filename, like SpecKit's speckit.plan.md)
//   codex OMITTED (0.150.1 has no verifiable custom-prompt loader)
//   cursor OMITTED (no CLI/docs available offline to verify the format)
//   antigravity INCLUDED via skills dirs (.agents/skills/ap.<cmd>/SKILL.md ->
//     /ap.plan ...; agy 1.3.4 does not expand .agent/workflows/*.md but runs
//     a skill as /<name>, dotted names accepted, and the typed arguments
//     reach the model — verified live, see the entry's source). A skill body
//     is read by the model, not substituted, so the argument placeholder is
//     prose (`<arguments>`), and every generated file carries
//     SKILL_GENERATED_MARKER so install/uninstall touch only generated dirs.
//
// Legacy (pre-dot) generated names are listed in LEGACY_COMMAND_LAYOUTS so
// install / setup refresh / uninstall can remove exactly those files.

// Command files rendered per included agent. `stage` is the `ap run --stage`
// value; null means the full-pipeline command (no `--stage` flag). Kept as a
// plain list so one more file can be appended later without restructuring.
export const COMMAND_FILES = Object.freeze([
  Object.freeze({
    name: "plan",
    file: "plan.md",
    description: "Step 1 only: give a request → write a reviewed plan + task list, then stop",
    stage: "planning",
  }),
  Object.freeze({
    name: "implement",
    file: "implement.md",
    description: "Step 2 only: code the next part of the plan, then stop (no review)",
    stage: "implement",
  }),
  Object.freeze({
    name: "review",
    file: "review.md",
    description: "Step 3 only: review the code just written, then stop",
    stage: "review",
  }),
  Object.freeze({
    name: "verify",
    file: "verify.md",
    description: "Step 4 only: test the code just reviewed and tick its tasks done",
    stage: "verify",
  }),
  Object.freeze({
    name: "run",
    file: "run.md",
    description: "Do the whole job: give a request → plan, code, review, test until done",
    stage: null,
  }),
  Object.freeze({
    name: "plan-review",
    file: "plan-review.md",
    description: "Review a plan file you give (separate from any mission)",
    invocation: "ap plan-review",
  }),
  Object.freeze({
    name: "code-review",
    file: "code-review.md",
    description: "Review code you point to: commit, range, diff or folder",
    invocation: "ap code-review",
  }),
  Object.freeze({
    name: "verify-file",
    file: "verify-file.md",
    description: "Check the code against a list of requirements you give",
    invocation: "ap verify-file",
  }),
  // Backlog open #7: user-only mission-control pair. The typed slash
  // command IS the confirmation (the invocation already carries --yes, so
  // the spawned ap never re-prompts); `userOnly` keeps the MODEL from
  // triggering them — Claude Code gets `disable-model-invocation: true`
  // frontmatter (terminated at render time by the agent entry's
  // userOnlyFrontmatter row), opencode commands are user-typed only by
  // design (nothing extra needed), and antigravity skills are model-
  // invocable on demand with no known opt-out, so these two are EXCLUDED
  // for agy via the entry's excludedCommands list (never generated there).
  Object.freeze({
    name: "stop",
    file: "stop.md",
    description: "Pause the running mission (continue later with ap.run)",
    invocation: "ap stop --yes",
    userOnly: true,
  }),
  Object.freeze({
    name: "cancel",
    file: "cancel.md",
    description: "End the current mission for good",
    invocation: "ap cancel --yes",
    userOnly: true,
  }),
]);

// Per-agent command-file data. `status` is "included" or "omitted";
// included entries carry rendering data (commandsDir, format, template,
// argumentSyntax), omitted entries carry the reason instead.
export const AGENT_REGISTRY = Object.freeze([
  Object.freeze({
    agent: "claude",
    status: "included",
    source: "backlog item lines 50-73; flat `.claude/commands/ap.<cmd>.md` -> `/ap.<cmd>`",
    commandsDir: ".claude/commands",
    fileNamePrefix: "ap.",
    format: "markdown-frontmatter",
    template: "description-frontmatter",
    argumentSyntax: "$ARGUMENTS",
    // Backlog open #7: row text rendered into a command file's frontmatter
    // when the command is `userOnly` (no agent-name branch in the renderer).
    userOnlyFrontmatter: "disable-model-invocation: true",
  }),
  Object.freeze({
    agent: "opencode",
    status: "included",
    source: "opencode 1.18.35 (~/.opencode/bin/opencode): loader globs `{command,commands}/**/*.md` per config dir and names a command by its path minus the `command/` prefix, so the flat file `ap.plan.md` is `/ap.plan` (same as SpecKit's speckit.plan.md); `$ARGUMENTS` in the template",
    commandsDir: ".opencode/command",
    fileNamePrefix: "ap.",
    format: "markdown-frontmatter",
    template: "description-frontmatter",
    argumentSyntax: "$ARGUMENTS",
  }),
  Object.freeze({
    agent: "codex",
    status: "omitted",
    reason: "codex 0.150.1 (/usr/local/bin/codex) has no verifiable custom-prompt loader: no `~/.codex/prompts` string in the binary and the directory does not exist on this host, so the file format cannot be verified (and prompts would be user-global, not repo-scoped)",
  }),
  Object.freeze({
    agent: "cursor",
    status: "omitted",
    reason: "the `.cursor/commands` format is not verifiable offline: no Cursor CLI is installed and no local docs or schema document it",
  }),
  Object.freeze({
    agent: "antigravity",
    status: "included",
    source: "agy 1.3.4 (~/.local/bin/agy), verified live in a scratch repo with stdin stream-json (--mode plan): skills load from <repo>/.agents/skills/<name>/SKILL.md and run as /<name>; the dotted name `ap.probe` is accepted; `/ap.probe hello world 42` reached the model as `hello world 42` (it replied ARGS=hello world 42, and a command body ran `ap run --stage planning hello world 42`). Skill bodies are NOT substituted (a literal $ARGUMENTS confused the model), so the body tells the model to substitute `<arguments>` itself. .agent/workflows/*.md is not expanded (deprecated)",
    commandsDir: ".agents/skills",
    fileNamePrefix: "ap.",
    format: "skill-frontmatter",
    layout: "skill-dir",
    skillFile: "SKILL.md",
    argumentSyntax: "<arguments>",
    // Backlog open #7: agy skills are model-invocable on demand with no
    // known opt-out, so the user-only mission-control pair is never
    // generated for antigravity (risking the model stopping/cancelling a
    // mission on its own; claude/opencode carry these two instead).
    excludedCommands: Object.freeze(["stop", "cancel"]),
  }),
]);

export function getAgentEntry(agent) {
  return AGENT_REGISTRY.find((entry) => entry.agent === String(agent)) ?? null;
}

export function includedAgents() {
  return AGENT_REGISTRY.filter((entry) => entry.status === "included").map(
    (entry) => entry.agent,
  );
}

// Previously generated (pre-dot) layouts. Only these exact names are ever
// removed by the migration; any other file in these dirs is user data.
export const LEGACY_COMMAND_LAYOUTS = Object.freeze([
  Object.freeze({ agent: "claude", dir: ".claude/commands/ap", prefix: "", removeDirIfEmpty: true }),
  Object.freeze({ agent: "opencode", dir: ".opencode/command", prefix: "ap-", removeDirIfEmpty: false }),
]);

// Repo-relative legacy paths (pure).
export function legacyCommandRelPaths(commandFiles = COMMAND_FILES) {
  const out = [];
  for (const layout of LEGACY_COMMAND_LAYOUTS) {
    for (const commandFile of commandFiles) {
      out.push(`${layout.dir}/${layout.prefix}${commandFile.file}`);
    }
  }
  return out;
}

// Delete the legacy generated files that exist under `repo` (exact names
// only), then the legacy `ap/` dir when it is left empty. Returns the
// removed repo-relative paths. Never throws on a missing file.
export function removeLegacyCommandFiles(repo, commandFiles = COMMAND_FILES) {
  const repoRoot = path.resolve(repo ?? ".");
  const removed = [];
  for (const rel of legacyCommandRelPaths(commandFiles)) {
    const abs = path.join(repoRoot, rel);
    try {
      if (fs.lstatSync(abs).isFile()) {
        fs.unlinkSync(abs);
        removed.push(rel);
      }
    } catch {
      // Absent or unreadable: nothing to migrate.
    }
  }
  for (const layout of LEGACY_COMMAND_LAYOUTS) {
    if (!layout.removeDirIfEmpty) continue;
    try {
      fs.rmdirSync(path.join(repoRoot, layout.dir)); // only succeeds when empty
    } catch {
      // Non-empty (user files) or absent: keep.
    }
  }
  return removed;
}

// Repo-relative output path for one rendered command file.
export function commandRelPath(agentEntry, commandFile) {
  if (agentEntry.layout === "skill-dir") {
    return `${agentEntry.commandsDir}/${agentEntry.fileNamePrefix ?? ""}${commandFile.name}/${agentEntry.skillFile ?? "SKILL.md"}`;
  }
  return `${agentEntry.commandsDir}/${agentEntry.fileNamePrefix ?? ""}${commandFile.file}`;
}

// Marker written into every generated skill file; only files carrying it are
// ever overwritten or removed (a user skill that happens to share a name is
// left alone).
export const SKILL_GENERATED_MARKER = "<!-- generated by project-autopilot: do not edit; refreshed by `ap setup`/`ap commands` -->";

export function isGeneratedSkillContent(content) {
  return typeof content === "string" && content.includes(SKILL_GENERATED_MARKER);
}

// Frontmatter scalars are strict YAML: a plain (unquoted) scalar may not
// contain ": " (e.g. "Mission: write the plan"), and agy >=1.3.6 parses the
// skill frontmatter strictly — so every description is rendered as a
// double-quoted YAML scalar.
function yamlQuoted(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Command files excluded for one agent entry (per-agent exclude list —
// backlog open #7 keeps model-invocable agy skills from gaining the
// user-only mission-control stops).
export function commandsForAgent(agentEntry, commandFiles = COMMAND_FILES) {
  const excluded = agentEntry?.excludedCommands ?? [];
  return commandFiles.filter((commandFile) => !excluded.includes(commandFile.name));
}

// Shared render: builds file content from the entry's template fields and
// the command's invocation (adhoc commands carry an explicit `invocation`
// string) or stage (the original five `ap run` files) only — no per-agent
// branches. Unknown formats fall back to the same Markdown frontmatter
// shape the registry verifies.
export function renderCommandFile(agentEntry, commandFile) {
  const invocation =
    commandFile.invocation !== undefined && commandFile.invocation !== null
      ? `${commandFile.invocation} ${agentEntry.argumentSyntax}`
      : commandFile.stage === null || commandFile.stage === undefined
        ? `ap run ${agentEntry.argumentSyntax}`
        : `ap run --stage ${commandFile.stage} ${agentEntry.argumentSyntax}`;
  if (agentEntry.format === "skill-frontmatter") {
    return [
      "---",
      `name: ${agentEntry.fileNamePrefix ?? ""}${commandFile.name}`,
      `description: ${yamlQuoted(commandFile.description)}`,
      "---",
      SKILL_GENERATED_MARKER,
      "",
      "Run this shell command from the repository root, replacing `<arguments>` with the arguments the user typed after the slash command (nothing if none were given), then report its output:",
      "",
      `\`${invocation}\``,
      "",
    ].join("\n");
  }
  const lines = [
    "---",
    `description: ${yamlQuoted(commandFile.description)}`,
    ...(commandFile.userOnly && agentEntry.userOnlyFrontmatter
      ? [agentEntry.userOnlyFrontmatter]
      : []),
    "---",
    "",
    invocation,
    "",
  ];
  return lines.join("\n");
}

// Render every command file for one included agent. Accepts an optional
// command list (defaults to COMMAND_FILES) so a future file needs only a
// new list entry; the entry's excludedCommands are always dropped (open #7).
// Returns [{file, relPath, content}]. Throws for unknown or omitted agents.
export function renderAgentCommands(agent, commandFiles = COMMAND_FILES) {
  const entry = typeof agent === "string" ? getAgentEntry(agent) : agent;
  if (!entry || entry.status !== "included") {
    throw new Error(
      `Usage error: no included command registry entry for agent (${String(typeof agent === "string" ? agent : entry?.agent)}).`,
    );
  }
  return commandsForAgent(entry, commandFiles).map((commandFile) => ({
    file: entry.layout === "skill-dir"
      ? `${entry.fileNamePrefix ?? ""}${commandFile.name}/${entry.skillFile ?? "SKILL.md"}`
      : `${entry.fileNamePrefix ?? ""}${commandFile.file}`,
    relPath: commandRelPath(entry, commandFile),
    content: renderCommandFile(entry, commandFile),
  }));
}

// ── Task 2.2: install helper ────────────────────────────────────────────
// Detected = the agent's `adapters/agents.json` binary resolvable on PATH.
// Only PATH-detected INCLUDED agents get files; omitted agents never render
// (renderAgentCommands throws for them), no matter what is on PATH.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_SKILL_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function loadAgentsManifest(skillRoot = REGISTRY_SKILL_ROOT) {
  return JSON.parse(
    fs.readFileSync(path.join(skillRoot, "adapters", "agents.json"), "utf8"),
  ).adapters;
}

export function agentBinary(agent, manifest) {
  const agents = manifest ?? loadAgentsManifest();
  return agents?.[String(agent)]?.binary ?? null;
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isBinaryOnPath(
  binary,
  { pathEnv = process.env.PATH ?? "" } = {},
) {
  if (!binary || typeof binary !== "string") return false;
  if (binary.includes("/") || binary.includes("\\")) {
    return isExecutableFile(binary);
  }
  const delimiter = process.platform === "win32" ? ";" : ":";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.COM;.CMD;.BAT").split(";").map((e) => e.toLowerCase())
      : [""];
  for (const dir of String(pathEnv).split(delimiter)) {
    if (!dir) continue;
    if (process.platform === "win32") {
      for (const ext of extensions) {
        const candidate = path.join(dir, binary + ext.toLowerCase());
        try {
          if (fs.existsSync(candidate)) return true;
        } catch {
          // Treat an unreadable PATH entry as a miss, never a crash.
        }
      }
      try {
        if (fs.existsSync(path.join(dir, binary))) return true;
      } catch {
        // Miss — keep scanning.
      }
    } else {
      const candidate = path.join(dir, binary);
      try {
        if (fs.existsSync(candidate) && isExecutableFile(candidate)) return true;
      } catch {
        // Miss — keep scanning.
      }
    }
  }
  return false;
}

export function isAgentDetected(
  agent,
  { manifest, pathEnv = process.env.PATH ?? "", skillRoot } = {},
) {
  const agents = manifest ?? loadAgentsManifest(skillRoot ?? REGISTRY_SKILL_ROOT);
  const binary = agents?.[String(agent)]?.binary;
  if (!binary) return false;
  return isBinaryOnPath(binary, { pathEnv });
}

// Included agents whose manifest binary resolves on PATH.
export function detectedAgents(
  { manifest, pathEnv = process.env.PATH ?? "", skillRoot } = {},
) {
  return includedAgents().filter((agent) =>
    isAgentDetected(agent, { manifest, pathEnv, skillRoot }),
  );
}

// Every repo-relative rendered path across included agents (for uninstall
// planning and tests). Pure. Per-agent exclusions apply (open #7).
export function allCommandRelPaths(commandFiles = COMMAND_FILES) {
  const out = [];
  for (const agent of includedAgents()) {
    const entry = getAgentEntry(agent);
    for (const commandFile of commandsForAgent(entry, commandFiles)) {
      out.push(commandRelPath(entry, commandFile));
    }
  }
  return out;
}

// Resolve `--repo <path>` exactly like the other ap routes: the value after
// `--repo`, defaulting to the cwd. `--repo=` form counts as absent.
export function resolveRepoFromArgs(
  argv,
  { cwd = process.cwd() } = {},
) {
  const idx = argv.indexOf("--repo");
  const raw = idx !== -1 ? (argv[idx + 1] || ".") : cwd;
  return path.resolve(raw);
}

// Write/refresh command files for PATH-detected included agents only.
// Idempotent: plain overwrites of identical content, no appends — a re-run
// refreshes without duplicates. Returns {repo, detected, written}.
export function installAgentCommands(
  repo,
  { manifest, pathEnv = process.env.PATH ?? "", skillRoot } = {},
) {
  const repoRoot = path.resolve(repo ?? ".");
  const agents = manifest ?? loadAgentsManifest(skillRoot ?? REGISTRY_SKILL_ROOT);
  const detected = includedAgents().filter((agent) =>
    isAgentDetected(agent, { manifest: agents, pathEnv }),
  );
  // Migration: drop the old-format generated files before writing new ones.
  const migrated = removeLegacyCommandFiles(repoRoot);
  const written = [];
  for (const agent of detected) {
    const agentEntry = getAgentEntry(agent);
    for (const rendered of renderAgentCommands(agent)) {
      const abs = path.join(repoRoot, rendered.relPath);
      if (agentEntry.layout === "skill-dir") {
        // Never clobber a user's own skill of the same name.
        try {
          if (!isGeneratedSkillContent(fs.readFileSync(abs, "utf8"))) continue;
        } catch {
          // Absent: write it.
        }
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, rendered.content);
      written.push(rendered.relPath);
    }
  }
  return { repo: repoRoot, detected, written, migrated };
}

function printInstallUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/agent-command-registry.mjs install [--repo <path>]",
      "",
      "Writes agent slash-command files for PATH-detected agents only.",
    ].join("\n"),
  );
}

const __isMainGuard =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (__isMainGuard) {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  if (subcommand === "install") {
    const repo = resolveRepoFromArgs(argv.slice(1));
    const result = installAgentCommands(repo);
    for (const rel of result.migrated) {
      console.log(`removed legacy ${rel}`);
    }
    for (const rel of result.written) {
      console.log(`wrote ${rel}`);
    }
    if (result.detected.length === 0) {
      console.log("no PATH-detected agents with command files; nothing written.");
    }
  } else {
    printInstallUsage();
    process.exit(2);
  }
}
