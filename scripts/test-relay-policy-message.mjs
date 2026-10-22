#!/usr/bin/env node
// TASK-31 step 3: read-only escalation message names the touched path(s)
// and flags protected agent directories, in both the standalone and the
// SpecKit loops.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {formatRelayPolicyViolation, PROTECTED_AGENT_DIRS} from "./relay-guards.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// ---- 1. Unit behavior ----
{
  const msg = formatRelayPolicyViolation("read_only_violation", [".agent/foo.json"]);
  check("protected .agent path named with annotation",
    msg.includes(".agent/foo.json") && msg.includes("protected agent directory"), msg);
  check("violation code present", msg.includes("read_only_violation"), msg);
  check("stop suffix present", /STOP — human intervention required/.test(msg), msg);
}
for (const dir of [".agent", ".commandcode", ".opencode", ".mimocode", ".claude"]) {
  const msg = formatRelayPolicyViolation("read_only_violation", [`${dir}/x.json`]);
  check(`protected dir ${dir}/ annotated`, msg.includes("protected agent directory"), msg);
}
{
  const msg = formatRelayPolicyViolation("read_only_violation", ["src/app.js"]);
  check("non-protected path named without annotation",
    msg.includes("src/app.js") && !msg.includes("protected agent directory"), msg);
}
{
  const msg = formatRelayPolicyViolation("read_only_violation", ["src/app.js", ".opencode/cfg.json"]);
  check("mixed list names both, annotates only the protected one",
    msg.includes("src/app.js") && msg.includes(".opencode/cfg.json (protected agent directory)"), msg);
}
{
  const msg = formatRelayPolicyViolation("git_commit_detected", [".agent/foo.json"]);
  check("non-read-only violation falls back to legacy message",
    msg === "Relay policy violation: git_commit_detected. STOP — human intervention required.", msg);
}
{
  const msg = formatRelayPolicyViolation("read_only_violation", []);
  check("empty touched files falls back to legacy message",
    msg === "Relay policy violation: read_only_violation. STOP — human intervention required.", msg);
}
{
  check("all five protected dirs exported",
    [".agent", ".commandcode", ".opencode", ".mimocode", ".claude"].every(d => PROTECTED_AGENT_DIRS.includes(d)),
    [...PROTECTED_AGENT_DIRS].join(","));
}

// ---- 2. Both loops escalate through the formatter ----
{
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(dir, "autopilot.mjs"), "utf8");
  check("autopilot imports formatRelayPolicyViolation",
    src.includes("formatRelayPolicyViolation"));
  // Per-task sites (standalone + speckit twins share this exact text).
  const perTask = src.split("die(formatRelayPolicyViolation(s.relayPolicyViolation, taskImpl.touchedFiles))").length - 1;
  check("standalone AND speckit per-task loops use the formatter (taskImpl x2)",
    perTask >= 2, `found ${perTask}`);
  // Aggregate impl sites (standalone uses pendingStandaloneCheckboxSnapshot,
  // speckit uses pendingCheckboxSnapshot — both must be covered).
  const agg = src.split("die(formatRelayPolicyViolation(s.relayPolicyViolation, impl.touchedFiles))").length - 1;
  check("standalone AND speckit aggregate loops use the formatter (impl x2)",
    agg >= 2, `found ${agg}`);
  const standaloneIdx = src.indexOf("pendingStandaloneCheckboxSnapshot");
  const speckitIdx = src.indexOf("delete s.pendingCheckboxSnapshot");
  check("standalone loop region formats the violation",
    standaloneIdx !== -1 && src.slice(0, standaloneIdx + 2000).includes("formatRelayPolicyViolation"));
  check("speckit loop region formats the violation",
    speckitIdx !== -1 && src.slice(speckitIdx).includes("formatRelayPolicyViolation"));
  check("reviewer escalations format the violation",
    src.includes("die(formatRelayPolicyViolation(s.relayPolicyViolation, rv.touchedFiles))"));
  check("verifier escalations format the violation",
    src.includes("die(formatRelayPolicyViolation(s.relayPolicyViolation, vv.touchedFiles))"));
  // Exact example shape from the task spec.
  const example = formatRelayPolicyViolation("read_only_violation", [".agent/foo.json"]);
  check("matches spec example shape",
    example === "Relay policy violation: read_only_violation — write in .agent/foo.json (protected agent directory). STOP — human intervention required.",
    example);
}

if (failures) {
  console.error(`${failures} relay-policy-message check(s) failed.`);
  process.exit(1);
}
console.log("relay-policy-message regression tests passed");
