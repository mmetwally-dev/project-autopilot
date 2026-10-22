#!/usr/bin/env node
// Disposable fake Claude CLI used by test-claude-stdin-contract.mjs
// (via fake-claude-launcher.sh, copied/renamed to "claude.com" at test
// setup time) to prove the real Claude relay path declares
// --input-format text and delivers stdin as plain text, not stream-json.
//
// This reproduces the observed real failure this test guards against:
// Claude Code CLI 2.x rejects "--input-format stream-json" when the
// caller actually writes a plain-text prompt to stdin instead of a
// stream-json envelope ("Error parsing streaming input line
// (type=unknown, 18 chars): SyntaxError"). If the manifest regresses
// to declaring stream-json input while Autopilot keeps sending
// plain-text stdin, this fake CLI fails exactly the way the real one
// did, and the mission below fails with it.
"use strict";
const args = process.argv.slice(2);

function fail(reason) {
  process.stderr.write("fake-claude: CONTRACT VIOLATION: " + reason + "\n");
  process.exit(1);
}

if (args.includes("--version")) {
  process.stdout.write("fake-claude 1.0.0\n");
  process.exit(0);
}

const inputFormatIndex = args.indexOf("--input-format");
if (inputFormatIndex === -1) fail("no --input-format flag was passed");
const inputFormatValue = args[inputFormatIndex + 1];
if (inputFormatValue === "stream-json") {
  fail("received --input-format stream-json; the adapter must declare --input-format text for plain-text stdin");
}
if (inputFormatValue !== "text") {
  fail("unexpected --input-format value: " + JSON.stringify(inputFormatValue));
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { stdin += chunk; });
process.stdin.on("end", () => {
  const trimmed = stdin.trimStart();
  if (trimmed === "") fail("stdin was empty; expected the plain-text mission prompt");
  if (trimmed[0] === "{" || trimmed[0] === "[") fail("stdin looked JSON-encoded; expected plain text");
  if (!trimmed.startsWith("ROLE=")) fail("stdin did not start with ROLE=; expected the plain-text mission prompt");

  const report = {
    argv: args,
    stdinFirstLine: trimmed.split(/\r?\n/, 1)[0],
    stdinLength: stdin.length
  };
  const reviewLine = "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: [JSON.stringify(report)]});
  process.stdout.write(JSON.stringify({type: "agent_message", text: reviewLine}) + "\n");
  process.exit(0);
});
