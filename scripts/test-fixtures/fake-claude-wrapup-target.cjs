#!/usr/bin/env node
// Disposable fake Claude CLI for test-wrapup-turn.mjs (Backlog #8), reached
// through fake-claude-launcher.sh copied next to it as "claude.com".
// First launch (no --resume): emits a session id, streams enough assistant
// turns to trip the low turn cap and writes NO hand-off note.
// Resumed launch (--resume <id>, the orchestrator's wrap-up turn): writes the
// note at the scratch path named after "Write your hand-off note NOW to" and
// records the resumed session id beside it.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("fake-claude 1.0.0\n");
  process.exit(0);
}
const resumeIdx = args.indexOf("--resume");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { stdin += chunk; });
process.stdin.on("end", () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const emit = object => process.stdout.write(JSON.stringify({session_id: "fixture-claude-session", ...object}) + "\n");
  const usage = {input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  (async () => {
    if (resumeIdx !== -1) {
      const match = /Write your hand-off note NOW to (\S+)/.exec(stdin);
      if (match) {
        const notePath = match[1].replace(/[.,;:]+$/, "");
        fs.writeFileSync(notePath, "1. Done — none.\n2. Found — WRAPUP-RESUME-MARKER written by the resumed session.\n3. Next — continue the review.\n4. Dead ends — none.\n");
        fs.writeFileSync(path.join(path.dirname(notePath), "wrapup-resume.json"), JSON.stringify({resumeId: args[resumeIdx + 1], notePath, argv: args}));
      }
      emit({type: "assistant", message: {id: "msg-w1", usage, content: [{type: "text", text: "note written"}]}});
      emit({type: "result", result: "note written"});
      process.exit(0);
    }
    for (let i = 1; i <= 6; i += 1) {
      emit({type: "assistant", message: {id: `msg-${i}`, usage, content: [{type: "text", text: "working"}]}});
      await sleep(30);
    }
    await sleep(8000);
    emit({type: "result", result: "AUTOPILOT_REVIEW={\"decision\":\"PASS\",\"findings\":[]}"});
    process.exit(0);
  })();
});
