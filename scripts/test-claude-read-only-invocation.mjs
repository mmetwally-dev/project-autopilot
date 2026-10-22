#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {applyAgentSelections, verifyAgentInvocation} from "./agent-invocation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "..");

// Load the real adapter manifest exactly the way autopilot.mjs does.
const agents = JSON.parse(
  fs.readFileSync(path.join(skillRoot, "adapters", "agents.json"), "utf8")
).adapters;

const claude = agents.claude;
assert.ok(claude, "claude adapter must exist in agents.json");
assert.ok(Array.isArray(claude.read_only), "claude.read_only must be an array");

// ── 1. Manifest structural check ────────────────────────────────────────
// Verify that the raw manifest array (before selections) already contains
// --verbose. This catches a reversion of the agents.json fix.
const readOnlyFlags = claude.read_only;
assert.ok(
  readOnlyFlags.includes("--verbose"),
  "claude.read_only manifest must include --verbose"
);
assert.ok(
  readOnlyFlags.includes("--output-format") &&
    readOnlyFlags[readOnlyFlags.indexOf("--output-format") + 1] === "stream-json",
  "claude.read_only manifest must include --output-format stream-json"
);
assert.ok(
  readOnlyFlags.includes("--input-format") &&
    readOnlyFlags[readOnlyFlags.indexOf("--input-format") + 1] === "text",
  "claude.read_only manifest must include --input-format text"
);
assert.ok(
  !(readOnlyFlags.includes("--input-format") &&
    readOnlyFlags[readOnlyFlags.indexOf("--input-format") + 1] === "stream-json"),
  "claude.read_only manifest must NOT declare --input-format stream-json (stdin is delivered as plain text)"
);
assert.ok(
  readOnlyFlags.includes("--permission-mode") &&
    readOnlyFlags[readOnlyFlags.indexOf("--permission-mode") + 1] === "plan",
  "claude.read_only manifest must include --permission-mode plan"
);

// ── 2. Contract validation still passes ─────────────────────────────────
// The manifest must remain a valid adapter contract after the change.
const {validateAdapterContract} = await import("./agent-contract.mjs");
const contract = validateAdapterContract("claude", claude);
assert.ok(contract.ok, `claude adapter contract must be valid: ${contract.errors.join("; ")}`);

// ── 3. Behavioral test: exercise the REAL invocation construction path ───
// Reproduce exactly what buildRelayArgs() in autopilot.mjs does:
//   let args = [...(readOnly ? a.read_only : a.write)];
//   args = applyAgentSelections(args, role, a);
// Then verify the output contains all required flags.

const readOnlyRoles = [
  {name: "plan_reviewer", model: "sonnet", reasoning: "low"},
  {name: "code_reviewer",  model: "sonnet", reasoning: "low"},
  {name: "verifier",       model: "sonnet", reasoning: "low"},
];

for (const {name, model, reasoning} of readOnlyRoles) {
  // Replicate buildRelayArgs read_only path + applyAgentSelections
  const args = [...claude.read_only];
  const role = {model, reasoning, variant: null};
  const finalArgs = applyAgentSelections(args, role, claude);

  assert.ok(
    finalArgs.includes("--verbose"),
    `${name}: final invocation must include --verbose, got: ${finalArgs.join(" ")}`
  );
  assert.ok(
    finalArgs.includes("--output-format") &&
      finalArgs[finalArgs.indexOf("--output-format") + 1] === "stream-json",
    `${name}: final invocation must include --output-format stream-json`
  );
  assert.ok(
    finalArgs.includes("--input-format") &&
      finalArgs[finalArgs.indexOf("--input-format") + 1] === "text",
    `${name}: final invocation must include --input-format text`
  );
  assert.ok(
    !(finalArgs.includes("--input-format") &&
      finalArgs[finalArgs.indexOf("--input-format") + 1] === "stream-json"),
    `${name}: final invocation must NOT include --input-format stream-json`
  );
  assert.ok(
    finalArgs.includes("--permission-mode") &&
      finalArgs[finalArgs.indexOf("--permission-mode") + 1] === "plan",
    `${name}: final invocation must include --permission-mode plan`
  );
  assert.ok(
    finalArgs.includes("--model") &&
      finalArgs[finalArgs.indexOf("--model") + 1] === model,
    `${name}: final invocation must include --model ${model}`
  );
  assert.ok(
    finalArgs.includes("--effort") &&
      finalArgs[finalArgs.indexOf("--effort") + 1] === reasoning,
    `${name}: final invocation must include --effort ${reasoning}`
  );

  // verifyAgentInvocation must also pass (no arg conflicts)
  const verification = verifyAgentInvocation(finalArgs, role, claude);
  assert.ok(
    verification.ok,
    `${name}: verifyAgentInvocation must pass: ${verification.errors.join("; ")}`
  );
}

// ── 4. Verify the argument ordering matches the real argv ────────────────
// The original real invocation (with the input-format bug) was:
//   -p --output-format stream-json --input-format stream-json --permission-mode plan --model sonnet --effort low
// With the fix, --input-format is followed by "text", and --verbose still
// appears between --input-format and --permission-mode.
const reviewerArgs = applyAgentSelections([...claude.read_only], {model: "sonnet", reasoning: "low", variant: null}, claude);
const verboseIdx = reviewerArgs.indexOf("--verbose");
const inputFormatIdx = reviewerArgs.indexOf("--input-format");
const permissionModeIdx = reviewerArgs.indexOf("--permission-mode");
assert.equal(
  reviewerArgs[inputFormatIdx + 1],
  "text",
  `--input-format must be followed by "text", got: ${reviewerArgs.join(" ")}`
);
assert.ok(
  verboseIdx > inputFormatIdx && verboseIdx < permissionModeIdx,
  `--verbose must appear between --input-format and --permission-mode (verbose=${verboseIdx}, inputFormat=${inputFormatIdx}, permissionMode=${permissionModeIdx})`
);

// ── 5. Claude write invocation must also declare plain-text stdin ────────
assert.ok(Array.isArray(claude.write), "claude.write must be an array");
assert.ok(
  claude.write.includes("--input-format") &&
    claude.write[claude.write.indexOf("--input-format") + 1] === "text",
  "claude.write manifest must include --input-format text"
);
assert.ok(
  !(claude.write.includes("--input-format") &&
    claude.write[claude.write.indexOf("--input-format") + 1] === "stream-json"),
  "claude.write manifest must NOT declare --input-format stream-json"
);
assert.ok(
  claude.write.includes("--output-format") &&
    claude.write[claude.write.indexOf("--output-format") + 1] === "stream-json",
  "claude.write manifest must include --output-format stream-json"
);
assert.ok(
  claude.write.includes("--verbose"),
  "claude.write manifest must include --verbose"
);

const writeArgs = applyAgentSelections([...claude.write], {model: "sonnet", reasoning: "low", variant: null}, claude);
assert.ok(
  writeArgs.includes("--input-format") &&
    writeArgs[writeArgs.indexOf("--input-format") + 1] === "text",
  `claude write final invocation must include --input-format text, got: ${writeArgs.join(" ")}`
);
assert.ok(
  writeArgs.includes("--output-format") &&
    writeArgs[writeArgs.indexOf("--output-format") + 1] === "stream-json",
  `claude write final invocation must include --output-format stream-json, got: ${writeArgs.join(" ")}`
);
assert.ok(
  writeArgs.includes("--verbose"),
  `claude write final invocation must include --verbose, got: ${writeArgs.join(" ")}`
);
const writeVerification = verifyAgentInvocation(writeArgs, {model: "sonnet", reasoning: "low", variant: null}, claude);
assert.ok(
  writeVerification.ok,
  `claude write: verifyAgentInvocation must pass: ${writeVerification.errors.join("; ")}`
);

// ── 6. Driver-level direct invocation path (claudeInvocation) ────────────
// Exercise scripts/adapter-drivers.mjs directly to make sure the low-level
// invocation builder (used outside buildRelayArgs) also emits plain-text
// stdin declarations for both write and read-only requests.
const {adapterDriver} = await import("./adapter-drivers.mjs");
const claudeDriver = adapterDriver("claude");
assert.ok(claudeDriver, "adapterDriver(\"claude\") must resolve to a driver");
for (const mode of ["write", "read_only"]) {
  // Mode alone decides the permission flag; callers must not pre-supply
  // --permission-mode (the driver fails closed on duplicates).
  const invocation = claudeDriver.buildInvocation({
    binary: "claude",
    mode,
    model: "sonnet",
    reasoning: "low",
    args: []
  });
  assert.ok(
    invocation.args.includes("--input-format") &&
      invocation.args[invocation.args.indexOf("--input-format") + 1] === "text",
    `driver claudeInvocation(${mode}) must include --input-format text, got: ${invocation.args.join(" ")}`
  );
  assert.ok(
    !(invocation.args.includes("--input-format") &&
      invocation.args[invocation.args.indexOf("--input-format") + 1] === "stream-json"),
    `driver claudeInvocation(${mode}) must NOT include --input-format stream-json`
  );
}

console.log("test-claude-read-only-invocation: ALL CHECKS PASSED");
