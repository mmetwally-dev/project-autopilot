#!/usr/bin/env node
// Backlog #22 (TASK-32): the capped-session handoff carries a decoded-events
// digest, never a raw NDJSON tail.
//
// The opencode fixture below is hand-built (repo-relative paths) in the exact
// live wire shape; the absolute-path case further down mirrors what mission
// 022's `runs/16-implementer-d8c9eac5/stdout.log` actually carries (`opencode run --format json`: {type, part:{type,tool,state}},
// verified against native 1.18.x in test-opencode-driver.mjs) with the same
// read/grep/glob/bash/edit mix the capped mission-022 generation emitted.
import {
  sessionWorkDigest, resolveHandoffMaxChars, deadEndTail,
  HANDOFF_MAX_CHARS_DEFAULT, HANDOFF_MIN_CHARS,
} from "./per-task-budget.mjs";
import {validatePolicyConfig} from "./config-validation.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

const toolUse = (tool, state) => ({type: "tool_use", part: {type: "tool", tool, state}});
const bashState = (command, exit) => ({status: "completed", input: {command}, metadata: {exit}});

// Mission-022-shaped opencode stream: reads with ranges, searches, commands
// (ok + failed), an edit, and NO text event (the capped case — killed
// mid-tool-calls, so finalAgentText would fall back to raw NDJSON).
const OPENCODE_022 = [
  {type: "step_start", part: {type: "step-start"}},
  toolUse("read", {status: "completed", input: {filePath: "TASKS.md"}}),
  toolUse("read", {status: "completed", input: {filePath: "scripts/autopilot.mjs", offset: 790, limit: 131}}),
  toolUse("read", {status: "completed", input: {filePath: "scripts/autopilot.mjs", offset: 1140, limit: 251}}),
  toolUse("grep", {status: "completed", input: {pattern: "buildTaskPrompt|taskRetryFindings", path: "autopilot.mjs"}}),
  toolUse("glob", {status: "completed", input: {pattern: "scripts/*.mjs"}}),
  toolUse("bash", bashState("git status --short", 0)),
  toolUse("bash", bashState("git diff --stat", 0)),
  toolUse("bash", bashState("node scripts/test-failure-contract.mjs", 1)),
  toolUse("edit", {status: "completed", input: {filePath: "scripts/failure-contract.mjs"}}),
  {type: "step_finish", part: {type: "step-finish", tokens: {input: 1, output: 1, reasoning: 0, cache: {read: 1, write: 0}}}},
];

const digest = sessionWorkDigest("opencode", OPENCODE_022);
check("opencode: reads listed with merged ranges",
  digest.includes("read: TASKS.md; scripts/autopilot.mjs:790-920,1140-1390"), digest);
check("opencode: searches listed with pattern and scope",
  digest.includes('searched: "buildTaskPrompt|taskRetryFindings" in autopilot.mjs'), digest);
check("opencode: commands listed with ok/failed",
  digest.includes("ran: git status --short (ok); git diff --stat (ok); node scripts/test-failure-contract.mjs (failed)"), digest);
check("opencode: edit listed", digest.includes("edited: scripts/failure-contract.mjs"), digest);
check("opencode: no JSON fragments (the mission-022 garbage shape)",
  !digest.includes('"type":') && !digest.includes("messageID") && !digest.includes("sessionID") && !digest.includes('{"'), digest);
check("opencode: no-text stream still yields a digest", digest.length > 0, digest);

// Live opencode reports ABSOLUTE paths (mission 022 replay:
// `/mnt/d/project-autopilot-dev/scripts/…`); the repo root must be stripped in
// both its Windows and WSL-mount forms, whichever the orchestrator runs from.
const ABSOLUTE = [
  toolUse("read", {status: "completed", input: {filePath: "/mnt/d/project-autopilot-dev/scripts/autopilot.mjs", offset: 790, limit: 131}}),
  toolUse("grep", {status: "completed", input: {pattern: "feedback", path: "/mnt/d/project-autopilot-dev/scripts"}}),
  toolUse("edit", {status: "completed", input: {filePath: "/mnt/d/project-autopilot-dev/scripts/failure-contract.mjs"}}),
];
for (const repoRoot of ["D:\\project-autopilot-dev", "d:/project-autopilot-dev/", "/mnt/d/project-autopilot-dev"]) {
  const d = sessionWorkDigest("opencode", ABSOLUTE, {repoRoot});
  check(`absolute paths: repo root stripped (repoRoot=${repoRoot})`,
    d.includes("read: scripts/autopilot.mjs:790-920") && d.includes('in scripts') && d.includes("edited: scripts/failure-contract.mjs")
    && !d.includes("project-autopilot-dev"), d);
}
check("absolute paths: a path outside the repo falls back to the drive-stripped form",
  sessionWorkDigest("opencode", [toolUse("read", {status: "completed", input: {filePath: "/mnt/d/other/x.mjs"}})], {repoRoot: "D:\\project-autopilot-dev"})
    .includes("read: other/x.mjs"));

// Same assertions over the Claude stream-json vocabulary.
const claudeMsg = (id, content) => ({
  type: "assistant",
  message: {id, role: "assistant", content, usage: {input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0}},
});
const CLAUDE = [
  claudeMsg("m1", [{type: "text", text: "classification done; next: wire warning into the retry prompt"}]),
  claudeMsg("m2", [{type: "tool_use", name: "Read", input: {file_path: "scripts/autopilot.mjs", offset: 790, limit: 131}}]),
  claudeMsg("m3", [{type: "tool_use", name: "Grep", input: {pattern: "out_of_sandbox_auto_reject", path: "scripts"}}]),
  claudeMsg("m4", [{type: "tool_use", name: "Bash", input: {command: "git diff --stat"}}]),
  claudeMsg("m5", [{type: "tool_use", name: "Edit", input: {file_path: "scripts/failure-contract.mjs"}}]),
];
const claudeDigest = sessionWorkDigest("claude", CLAUDE);
check("claude: edits/reads/searches/commands present",
  claudeDigest.includes("edited: scripts/failure-contract.mjs")
  && claudeDigest.includes("read: scripts/autopilot.mjs:790-920")
  && claudeDigest.includes('searched: "out_of_sandbox_auto_reject" in scripts')
  && claudeDigest.includes("ran: git diff --stat"), claudeDigest);
check("claude: last agent text carried (cut ~300)",
  claudeDigest.includes('last: "classification done; next: wire warning into the retry prompt"'), claudeDigest);
check("claude: no JSON fragments",
  !claudeDigest.includes('"type":') && !claudeDigest.includes("messageID") && !claudeDigest.includes('{"'), claudeDigest);

// Dedupe: the same read/command twice appears once (with a count).
const dupe = sessionWorkDigest("opencode", [
  toolUse("read", {status: "completed", input: {filePath: "scripts/autopilot.mjs", offset: 790, limit: 131}}),
  toolUse("read", {status: "completed", input: {filePath: "scripts/autopilot.mjs", offset: 790, limit: 131}}),
  toolUse("bash", bashState("git diff --stat", 0)),
  toolUse("bash", bashState("git diff --stat", 0)),
  toolUse("bash", bashState("git diff --stat", 0)),
]);
check("dedupe: repeated read appears once with merged range",
  dupe.includes("read: scripts/autopilot.mjs:790-920") && (dupe.match(/scripts\/autopilot\.mjs/g) || []).length === 1, dupe);
check("dedupe: repeated command appears once with a count",
  dupe.includes("git diff --stat (ok) x3"), dupe);

// Bounds: a huge stream stays within the limit and keeps Edits + Last text.
const huge = [];
for (let i = 0; i < 300; i += 1) {
  huge.push(toolUse("read", {status: "completed", input: {filePath: `scripts/file-${i}.mjs`, offset: i * 10, limit: 50}}));
  huge.push(toolUse("bash", bashState(`node scripts/probe-${i}.mjs --flag with some extra arguments`, 0)));
}
huge.push(toolUse("edit", {status: "completed", input: {filePath: "scripts/failure-contract.mjs"}}));
huge.push({type: "text", part: {type: "text", text: "final classification note for the next session"}});
const hugeDigest = sessionWorkDigest("opencode", huge);
check("bounds: huge stream stays within the default limit",
  hugeDigest.length <= HANDOFF_MAX_CHARS_DEFAULT, hugeDigest.length);
check("bounds: Edits made survives the flood",
  hugeDigest.includes("edited: scripts/failure-contract.mjs"), hugeDigest.slice(0, 500));
check("bounds: Last agent text survives the flood",
  hugeDigest.includes('last: "final classification note for the next session"'), hugeDigest.slice(-400));

// Unknown adapter → "".
check("unknown adapter yields empty digest",
  sessionWorkDigest("codex", OPENCODE_022) === "" && sessionWorkDigest("cursor", CLAUDE) === "" && sessionWorkDigest("nope", []) === "");

// Format: compact one-line-per-section shape, ;-separated, no prose, no JSON.
const shapeLines = digest.split("\n");
check("format: one line per section in order (edited/read/searched/ran)",
  shapeLines.length === 4
  && shapeLines[0].startsWith("edited: ") && shapeLines[1].startsWith("read: ")
  && shapeLines[2].startsWith("searched: ") && shapeLines[3].startsWith("ran: "), shapeLines);
check("format: ;-separated items, no JSON braces",
  shapeLines.every((l) => !l.includes("{") && !l.includes("}")));

// Config: policy.handoff_max_chars shortens the entry; absent uses 2000;
// invalid is rejected by validation.
check("config: default limit is 2000",
  HANDOFF_MAX_CHARS_DEFAULT === 2000 && resolveHandoffMaxChars({}) === 2000);
check("config: operator value 800 shortens the entry",
  resolveHandoffMaxChars({handoff_max_chars: 800}) === 800
  && deadEndTail({files: ["a.txt"], outputTail: "y".repeat(1500), maxChars: resolveHandoffMaxChars({handoff_max_chars: 800})}).length <= 800);
check("config: invalid value falls back to the default, never unbounded",
  resolveHandoffMaxChars({handoff_max_chars: 100}) === 2000
  && resolveHandoffMaxChars({handoff_max_chars: "lots"}) === 2000);
check("config: validation rejects below the floor, accepts the default and above",
  validatePolicyConfig({handoff_max_chars: 499}).valid === false
  && validatePolicyConfig({handoff_max_chars: 500}).valid === true
  && validatePolicyConfig({handoff_max_chars: 2000}).valid === true
  && validatePolicyConfig({}).valid === true);
check("config: handoff floor is 500", HANDOFF_MIN_CHARS === 500);

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
