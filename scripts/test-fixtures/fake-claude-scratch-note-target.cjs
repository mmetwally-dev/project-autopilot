#!/usr/bin/env node
// Disposable fake Claude CLI used by test-claude-readonly-scratch-note.mjs
// (via fake-claude-launcher.sh, copied/renamed to "claude.com" at test
// setup time). CommonJS on purpose: the launcher target has a ".com"
// extension, which Node loads through its CJS loader.
//
// Proves the backlog #2 contract end to end:
//   - the read-only role runs in default mode with an explicit allow list;
//   - its only Write/Edit grants are inside the scratch mount, so the
//     repository itself stays unwritable;
//   - it can write its scratch hand-off note, and the wrap-up path finds
//     that fresh note (note_fresh) instead of overwriting it with the
//     orchestrator fallback.
//
// The fake streams enough distinct assistant messages to trip a low turn
// cap, then stays alive so the cap monitor's wrap-up branch can run.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);

function fail(reason) {
  process.stderr.write("fake-claude-scratch-note: CONTRACT VIOLATION: " + reason + "\n");
  process.exit(1);
}

function allowedToolsOf(argv) {
  const tools = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--allowedTools") continue;
    for (let j = i + 1; j < argv.length && !String(argv[j]).startsWith("--"); j += 1) tools.push(argv[j]);
  }
  return tools;
}

if (args.includes("--version")) {
  process.stdout.write("fake-claude 1.0.0\n");
  process.exit(0);
}

const modeIndex = args.indexOf("--permission-mode");
if (modeIndex === -1 || args[modeIndex + 1] !== "default") {
  fail("expected exactly --permission-mode default, got: " + JSON.stringify(args));
}

const allowed = allowedToolsOf(args);
for (const tool of ["Read", "Glob", "Grep", "Bash"]) {
  if (!allowed.includes(tool)) fail("missing read-only allow tool " + tool + ": " + JSON.stringify(allowed));
}
if (!allowed.includes("Write(//workspace/scratch/**)") || !allowed.includes("Edit(//workspace/scratch/**)")) {
  fail("missing scratch-only Write/Edit rules: " + JSON.stringify(allowed));
}
if (allowed.includes("Write") || allowed.includes("Edit")) {
  fail("bare Write/Edit must never be granted in read-only mode: " + JSON.stringify(allowed));
}
for (const rule of allowed) {
  if (/^(Write|Edit)\(/.test(rule) && !rule.startsWith("Write(//workspace/scratch/") && !rule.startsWith("Edit(//workspace/scratch/")) {
    fail("write rule escaped the scratch mount: " + rule);
  }
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { stdin += chunk; });
process.stdin.on("end", () => {
  const trimmed = stdin.trimStart();
  if (!trimmed.startsWith("ROLE=plan_reviewer")) {
    fail("expected the plan_reviewer prompt, got: " + JSON.stringify(trimmed.slice(0, 80)));
  }
  const noteMatch = /(?:hand-off note at)\s+(\S+\.md)/.exec(stdin)
    || /(\/\S*standalone-planning-plan_reviewer\.md)/.exec(stdin);
  if (!noteMatch) fail("prompt did not name the scratch hand-off note path");
  const notePath = noteMatch[1];

  let repoWriteRefused = false;
  try {
    fs.writeFileSync(path.join(process.cwd(), "E2E-REPO-WRITE-MUST-FAIL.txt"), "must not be writable\n");
  } catch {
    repoWriteRefused = true;
  }

  const note = [
    "1. Done — none (fixture).",
    "2. Found — E2E-SCRATCH-NOTE-MARKER proves the reviewer can write its note.",
    "3. Next — continue the review from this note.",
    "4. Dead ends — plan mode refused this write (backlog #2).",
    "",
  ].join("\n");
  fs.writeFileSync(notePath, note);
  fs.writeFileSync(path.join(path.dirname(notePath), "e2e-observation.json"), JSON.stringify({
    argv: args,
    allowedTools: allowed,
    cwd: process.cwd(),
    notePath,
    noteWritten: fs.existsSync(notePath),
    repoWriteRefused,
    stdinLength: stdin.length
  }, null, 2));

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  (async () => {
    for (let i = 1; i <= 6; i += 1) {
      process.stdout.write(JSON.stringify({
        type: "assistant",
        message: {
          id: `msg-${i}`,
          usage: {input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0},
          content: [{type: "text", text: "working"}]
        }
      }) + "\n");
      await sleep(30);
    }
    await sleep(8000);
    process.stdout.write(JSON.stringify({type: "result", result: "AUTOPILOT_REVIEW={\"decision\":\"PASS\",\"findings\":[]}"}) + "\n");
    process.exit(0);
  })().catch(error => fail("async failure: " + (error?.message || error)));
});
