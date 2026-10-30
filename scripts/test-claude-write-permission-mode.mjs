#!/usr/bin/env node
// TASK 15.6A — Claude non-interactive write invocation regression test.
//
// Guards the real Native Windows failure where the Claude Planner was
// launched as `-p --output-format stream-json --verbose --input-format
// text --model sonnet` with NO write-capable permission mode: Claude
// exited 0 but reported that Write permission was not granted and produced
// no SpecKit artifacts.
//
// Required contract (least-privilege, no broad bypasses):
//   - Planner / Implementer (manifest `write`, driver mode write/scratch)
//     receive exactly `--permission-mode acceptEdits`.
//   - Plan Reviewer / Code Reviewer / Verifier (manifest `read_only`,
//     driver mode read_only) use `--permission-mode default` with an explicit
//     read-only allow list (Read/Glob/Grep/Bash) — never plan mode, which
//     refuses the scratch hand-off note (backlog #2).
//   - No `--dangerously-skip-permissions`, `bypassPermissions`, or other
//     broad permission bypass may exist in the manifest or emitted argv.
//   - Plain-text stdin (`--input-format text`) and stream-json output are
//     unchanged; model/reasoning selection is unchanged.
//   - Unknown or duplicate permission modes fail closed.
//
// Pure invocation-shape checks (no CLI is launched): runs on every platform.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {applyAgentSelections, verifyAgentInvocation} from "./agent-invocation.mjs";
import {adapterDriver, CLAUDE_READ_ONLY_ALLOWED_TOOLS} from "./adapter-drivers.mjs";
import {validateAdapterContract} from "./agent-contract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "..");

const agents = JSON.parse(
  fs.readFileSync(path.join(skillRoot, "adapters", "agents.json"), "utf8")
).adapters;
const claude = agents.claude;
assert.ok(claude, "claude adapter must exist in agents.json");

const DANGEROUS = ["dangerously-skip-permissions", "bypasspermissions", "bypass-permissions"];
const hasDangerous = list =>
  list.map(String).some(arg => DANGEROUS.some(marker => arg.toLowerCase().includes(marker)));

const permissionModeOf = args => {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--permission-mode") values.push(args[i + 1]);
  }
  return values;
};

// ── 1. Manifest: write carries acceptEdits exactly once ────────────────────
assert.ok(Array.isArray(claude.write), "claude.write must be an array");
assert.deepEqual(
  permissionModeOf(claude.write),
  ["acceptEdits"],
  `claude.write manifest must contain exactly one --permission-mode acceptEdits, got: ${claude.write.join(" ")}`
);

// ── 2. Manifest: read_only uses default mode exactly once (never plan) ──────
assert.ok(Array.isArray(claude.read_only), "claude.read_only must be an array");
assert.deepEqual(
  permissionModeOf(claude.read_only),
  ["default"],
  `claude.read_only manifest must contain exactly one --permission-mode default, got: ${claude.read_only.join(" ")}`
);
assert.ok(!claude.read_only.includes("plan"), "claude.read_only manifest must not use plan mode");

// ── 2b. Manifest: read tools + Bash; no bare Write/Edit, no scratch rule yet ──
// The scratch-specific Write/Edit rules are injected at launch from the real
// scratch path (autopilot buildRelayArgs), never hard-coded in the manifest.
const allowedToolsOf = args => {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--allowedTools") continue;
    for (let j = i + 1; j < args.length && !String(args[j]).startsWith("--"); j += 1) values.push(args[j]);
  }
  return values;
};
assert.deepEqual(allowedToolsOf(claude.write), ["Bash"], "claude.write manifest must carry exactly one --allowedTools Bash");
assert.deepEqual(
  allowedToolsOf(claude.read_only),
  ["Read", "Glob", "Grep", "Bash"],
  `claude.read_only manifest must carry the read-only allow list, got: ${claude.read_only.join(" ")}`
);
assert.ok(!allowedToolsOf(claude.read_only).includes("Write"), "claude.read_only must not grant a bare Write tool");
assert.ok(!allowedToolsOf(claude.read_only).includes("Edit"), "claude.read_only must not grant a bare Edit tool");
assert.ok(!allowedToolsOf(claude.read_only).some(t => /^Write\(|^Edit\(/.test(t)), "claude.read_only manifest must not hard-code a scratch path rule");

// ── 3. Manifest: no dangerous bypass anywhere near claude ──────────────────
assert.ok(!hasDangerous(claude.write), "claude.write must not contain a dangerous permission bypass");
assert.ok(!hasDangerous(claude.read_only), "claude.read_only must not contain a dangerous permission bypass");
assert.ok(!hasDangerous(claude.probe || []), "claude.probe must not contain a dangerous permission bypass");

// ── 4. Manifest transport declarations unchanged ───────────────────────────
for (const [label, flags] of [["write", claude.write], ["read_only", claude.read_only]]) {
  assert.ok(
    flags.includes("--input-format") && flags[flags.indexOf("--input-format") + 1] === "text",
    `claude.${label} manifest must keep --input-format text`
  );
  assert.ok(
    flags.includes("--output-format") && flags[flags.indexOf("--output-format") + 1] === "stream-json",
    `claude.${label} manifest must keep --output-format stream-json`
  );
  assert.ok(flags.includes("-p"), `claude.${label} manifest must keep -p`);
  assert.ok(flags.includes("--verbose"), `claude.${label} manifest must keep --verbose`);
}

// ── 5. Contract still valid ────────────────────────────────────────────────
const contract = validateAdapterContract("claude", claude);
assert.ok(contract.ok, `claude adapter contract must be valid: ${contract.errors.join("; ")}`);

// ── 6. Real relay path per role (mirrors buildRelayArgs in autopilot.mjs) ──
// Planner + Implementer are write roles (readOnly=false); the three review
// roles are read-only (readOnly=true).
const roleCases = [
  {name: "planner", readOnly: false, expectedMode: "acceptEdits"},
  {name: "implementer", readOnly: false, expectedMode: "acceptEdits"},
  {name: "plan_reviewer", readOnly: true, expectedMode: "default"},
  {name: "code_reviewer", readOnly: true, expectedMode: "default"},
  {name: "verifier", readOnly: true, expectedMode: "default"},
];

for (const {name, readOnly, expectedMode} of roleCases) {
  const base = [...(readOnly ? claude.read_only : claude.write)];
  const role = {model: "sonnet", reasoning: "low", variant: null};
  const finalArgs = applyAgentSelections(base, role, claude);

  assert.deepEqual(
    permissionModeOf(finalArgs),
    [expectedMode],
    `${name}: final relay invocation must carry exactly one --permission-mode ${expectedMode}, got: ${finalArgs.join(" ")}`
  );
  assert.ok(!hasDangerous(finalArgs), `${name}: final invocation must not contain a dangerous bypass`);
  assert.ok(
    finalArgs.includes("--input-format") && finalArgs[finalArgs.indexOf("--input-format") + 1] === "text",
    `${name}: final invocation must keep --input-format text`
  );
  assert.ok(
    finalArgs.includes("--output-format") && finalArgs[finalArgs.indexOf("--output-format") + 1] === "stream-json",
    `${name}: final invocation must keep --output-format stream-json`
  );
  assert.ok(
    finalArgs.includes("--model") && finalArgs[finalArgs.indexOf("--model") + 1] === "sonnet",
    `${name}: model selection must remain --model sonnet`
  );
  assert.ok(
    finalArgs.includes("--effort") && finalArgs[finalArgs.indexOf("--effort") + 1] === "low",
    `${name}: reasoning selection must remain --effort low`
  );
  const verification = verifyAgentInvocation(finalArgs, role, claude);
  assert.ok(verification.ok, `${name}: verifyAgentInvocation must pass: ${verification.errors.join("; ")}`);
}

// ── 7. Driver-level path (scripts/adapter-drivers.mjs) ─────────────────────
// ── 2c. Foreground-only: both modes disable background tasks ──
const FG_SETTINGS = '{"env":{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"}}';
const foregroundOnlyOf = args => {
  const at = args.indexOf("--disallowedTools");
  const settingsAt = args.indexOf("--settings");
  return {
    disallowed: at >= 0 ? [args[at + 1], args[at + 2]] : [],
    followedByFlag: at >= 0 && String(args[at + 3]).startsWith("--"),
    settings: settingsAt >= 0 ? args[settingsAt + 1] : null
  };
};
const mfw = foregroundOnlyOf(claude.write);
assert.deepEqual(mfw.disallowed, ["Monitor", "TaskStop"], "claude.write manifest must disallow Monitor and TaskStop");
assert.ok(mfw.followedByFlag, "claude.write manifest: --disallowedTools list must be followed by a flag (variadic)");
assert.equal(mfw.settings, FG_SETTINGS, "claude.write manifest must disable background tasks via --settings env");
const mfr = foregroundOnlyOf(claude.read_only);
assert.deepEqual(mfr.disallowed, ["Monitor", "TaskStop"], "claude.read_only manifest must disallow Monitor and TaskStop");
assert.ok(mfr.followedByFlag, "claude.read_only manifest: --disallowedTools list must be followed by a flag (variadic)");
assert.equal(mfr.settings, FG_SETTINGS, "claude.read_only manifest must disable background tasks via --settings env");

const driver = adapterDriver("claude");
assert.ok(driver, 'adapterDriver("claude") must resolve to a driver');

for (const [mode, expectedMode] of [["write", "acceptEdits"], ["scratch", "acceptEdits"], ["read_only", "default"]]) {
  const invocation = driver.buildInvocation({binary: "claude", mode, model: "sonnet", reasoning: "low", args: []});
  assert.deepEqual(
    permissionModeOf(invocation.args),
    [expectedMode],
    `driver buildInvocation(mode=${mode}) must emit exactly one --permission-mode ${expectedMode}, got: ${invocation.args.join(" ")}`
  );
  assert.ok(!hasDangerous(invocation.args), `driver mode=${mode} must not contain a dangerous bypass`);
  assert.deepEqual(
    allowedToolsOf(invocation.args),
    mode === "read_only" ? [...CLAUDE_READ_ONLY_ALLOWED_TOOLS] : ["Bash"],
    `driver mode=${mode} --allowedTools mismatch: ${invocation.args.join(" ")}`
  );
  if (mode === "read_only") {
    assert.ok(!allowedToolsOf(invocation.args).includes("Write"), "driver read_only must not grant a bare Write tool");
    assert.ok(!allowedToolsOf(invocation.args).includes("Edit"), "driver read_only must not grant a bare Edit tool");
  }
  const at = invocation.args.indexOf("--allowedTools");
  const firstAfterAllowed = at + 1 + allowedToolsOf(invocation.args).length;
  assert.ok(String(invocation.args[firstAfterAllowed]).startsWith("--"), `driver mode=${mode}: --allowedTools list must be followed by another flag (variadic)`);
  const fg = foregroundOnlyOf(invocation.args);
  assert.deepEqual(fg.disallowed, ["Monitor", "TaskStop"], `driver mode=${mode} must disallow Monitor and TaskStop`);
  assert.ok(fg.followedByFlag, `driver mode=${mode}: --disallowedTools must be followed by a flag`);
  assert.equal(fg.settings, FG_SETTINGS, `driver mode=${mode} must disable background tasks via --settings env`);
  assert.ok(
    invocation.args.includes("--input-format") && invocation.args[invocation.args.indexOf("--input-format") + 1] === "text",
    `driver mode=${mode} must keep --input-format text`
  );
  assert.ok(
    invocation.args.includes("--output-format") && invocation.args[invocation.args.indexOf("--output-format") + 1] === "stream-json",
    `driver mode=${mode} must keep --output-format stream-json`
  );
  assert.ok(
    invocation.args.includes("--model") && invocation.args[invocation.args.indexOf("--model") + 1] === "sonnet",
    `driver mode=${mode} must keep --model sonnet`
  );
  assert.ok(
    invocation.args.includes("--effort") && invocation.args[invocation.args.indexOf("--effort") + 1] === "low",
    `driver mode=${mode} must keep --effort low`
  );
}

// ── 7b. Driver read_only scratch grant: only the named scratch tree ────────
{
  const invocation = driver.buildInvocation({binary: "claude", mode: "read_only", model: "sonnet", reasoning: "low", args: [], scratchDir: "/workspace/scratch"});
  const tools = allowedToolsOf(invocation.args);
  assert.ok(tools.includes("Write(//workspace/scratch/**)"), `driver read_only must grant Write only under the scratch dir, got: ${invocation.args.join(" ")}`);
  assert.ok(tools.includes("Edit(//workspace/scratch/**)"), `driver read_only must grant Edit only under the scratch dir, got: ${invocation.args.join(" ")}`);
  assert.ok(!tools.includes("Write") && !tools.includes("Edit"), "driver read_only must not grant bare Write/Edit");
  assert.ok(!tools.some(t => /^Write\(|^Edit\(/.test(t) && !t.includes("/workspace/scratch/")), "driver read_only Write/Edit must stay inside the scratch dir");
  const noScratch = driver.buildInvocation({binary: "claude", mode: "read_only", model: "sonnet", reasoning: "low", args: []});
  assert.ok(!allowedToolsOf(noScratch.args).some(t => /^Write\(|^Edit\(/.test(t)), "driver read_only without a scratch dir must not grant any write rule");
}

// ── 8. Fail-closed: unknown modes ───────────────────────────────────────────
for (const badMode of ["read", "bogus", "", null, undefined]) {
  assert.throws(
    () => driver.buildInvocation({binary: "claude", mode: badMode, model: "sonnet", reasoning: "low", args: []}),
    /Unknown Claude invocation mode|pre-existing --permission-mode/,
    `driver must fail closed for unknown mode ${JSON.stringify(badMode)}`
  );
}

// ── 9. Fail-closed: duplicate / conflicting pre-supplied flag ───────────────
for (const [mode, smuggled] of [["write", "plan"], ["write", "acceptEdits"], ["read_only", "plan"], ["read_only", "acceptEdits"]]) {
  assert.throws(
    () => driver.buildInvocation({binary: "claude", mode, model: "sonnet", reasoning: "low", args: ["--permission-mode", smuggled]}),
    /pre-existing --permission-mode/,
    `driver must fail closed when request.args already carries --permission-mode ${smuggled} (mode=${mode})`
  );
}

console.log("test-claude-write-permission-mode: ALL CHECKS PASSED");
