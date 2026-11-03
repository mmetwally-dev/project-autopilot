#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  decodeLiveProgress,
  renderLiveProgress,
  decodeProgressEntry,
  decodeActivityJson,
} from "./watch-report.mjs";

const failures = [];
function check(name, pass, detail) {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    console.error(`FAIL ${name}`, detail ?? "");
    failures.push(name);
  }
}

// ── 1. Real Codex progress.log fixture (run 103) ───────────────────────────
{
  const fixturePath = path.resolve("scripts/test-fixtures/codex-progress/progress.log");
  assert.ok(fs.existsSync(fixturePath), `fixture must exist at ${fixturePath}`);
  const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");
  check("fixture has 15 lines", lines.length === 15, lines.length);

  const entries = decodeLiveProgress({ progress: lines });
  check("entries decoded", entries.length > 0, entries.length);

  // Contains at least 5 command entries
  const cmdEntries = entries.filter((e) => e.kind === "command");
  check("contains at least 5 command entries", cmdEntries.length >= 5, cmdEntries.length);

  // Assert one exact command text you see in the fixture
  const exactCommand = "git status --short; ls /usr/bin/pwsh /opt/microsoft/powershell/7/pwsh; sed -n '1,220p' specs/001-sample-feature/tasks.md";
  const hasExact = cmdEntries.some((e) => e.text === exactCommand);
  check("assert exact command text from fixture", hasExact, cmdEntries.map((c) => c.text));

  // Another exact command from fixture: mkdir with single quotes stripped
  const exactCurl = "mkdir -p /workspace/scratch/pwsh-review; curl -fL --max-time 60 -o /workspace/scratch/pwsh-review/powershell.tar.gz https://github.com/PowerShell/PowerShell/releases/download/v7.4.6/powershell-7.4.6-linux-x64.tar.gz";
  const hasCurl = cmdEntries.some((e) => e.text === exactCurl);
  check("assert curl command text with outer quotes stripped", hasCurl, cmdEntries.map((c) => c.text));

  // No agent_message text survives
  const hasAgentMessage = entries.some((e) =>
    e.text.includes("I’ll check each previous finding") ||
    e.text.includes("speckit-analyze") ||
    e.text.includes("agent_message")
  );
  check("no agent_message text in entries", !hasAgentMessage, entries);

  // INTERRUPTED entry with "received SIGTERM"
  const interrupted = entries.find((e) => e.kind === "INTERRUPTED");
  check("INTERRUPTED entry present", !!interrupted, entries);
  check("INTERRUPTED text is 'received SIGTERM'", interrupted?.text === "received SIGTERM", interrupted?.text);

  // Rendered LIVE PROGRESS section
  const rendered = renderLiveProgress({
    status: "RUNNING",
    current: { kind: "run" },
    liveProgress: entries,
  });
  check("rendered header present", rendered.includes("=== LIVE PROGRESS (last 10 actions) ==="));
  check("rendered contains command kind", /command\s+git status --short;/.test(rendered), rendered);
  check("rendered contains INTERRUPTED line", /INTERRUPTED\s+received SIGTERM/.test(rendered), rendered);
  check("rendered contains no agent_message prose", !rendered.includes("I’ll check each previous finding"), rendered);
}

// ── 2. Claude stream-json tool_use decoding ─────────────────────────────────
{
  const claudeBashLine = '2026-11-03T16:00:00+03:00  ACTIVITY | STREAM=stdout | BYTES=150 | LAST={"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git diff --stat"}}]}}';
  const decodedBash = decodeProgressEntry(claudeBashLine);
  check("claude Bash decodes to bash kind", decodedBash?.kind === "bash", decodedBash);
  check("claude Bash decodes to command text", decodedBash?.text === "git diff --stat", decodedBash);

  const claudeReadLine = '2026-11-03T16:00:05+03:00  ACTIVITY | STREAM=stdout | BYTES=160 | LAST={"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"scripts/watch-report.mjs"}}]}}';
  const decodedRead = decodeProgressEntry(claudeReadLine);
  check("claude Read decodes to read kind", decodedRead?.kind === "read", decodedRead);
  check("claude Read decodes to file_path text", decodedRead?.text === "scripts/watch-report.mjs", decodedRead);

  const claudeGrepLine = '2026-11-03T16:00:10+03:00  ACTIVITY | STREAM=stdout | BYTES=180 | LAST={"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"out_of_sandbox_auto_reject","path":"scripts"}}]}}';
  const decodedGrep = decodeProgressEntry(claudeGrepLine);
  check("claude Grep decodes to grep kind", decodedGrep?.kind === "grep", decodedGrep);
  check("claude Grep decodes to pattern text", decodedGrep?.text === "out_of_sandbox_auto_reject", decodedGrep);

  const claudeProseLine = '2026-11-03T16:00:15+03:00  ACTIVITY | STREAM=stdout | BYTES=100 | LAST={"type":"assistant","message":{"content":[{"type":"text","text":"Checking repository diff..."}]}}';
  const decodedProse = decodeProgressEntry(claudeProseLine);
  check("claude text-only assistant message dropped", decodedProse === null, decodedProse);
}

// ── 3. OpenCode tool part unchanged ─────────────────────────────────────────
{
  const opencodeToolLine = '2026-11-03T16:01:00+03:00  ACTIVITY | LAST={"part":{"type":"tool","tool":"bash","state":{"input":{"command":"git status --porcelain | head -n 50"}}}}';
  const decodedOpencode = decodeProgressEntry(opencodeToolLine);
  check("opencode tool decodes to bash kind", decodedOpencode?.kind === "bash", decodedOpencode);
  check("opencode tool decodes to command text", decodedOpencode?.text === "git status --porcelain | head -n 50", decodedOpencode);

  const opencodeNoiseLine = '2026-11-03T16:01:05+03:00  ACTIVITY | LAST={"part":{"type":"step_start"}}';
  const decodedNoise = decodeProgressEntry(opencodeNoiseLine);
  check("opencode step_start dropped", decodedNoise === null, decodedNoise);
}

// ── 4. Codex file_change, patch, and error items ───────────────────────────
{
  const fileChangeLine = '2026-11-03T16:02:00+03:00  ACTIVITY | STREAM=stdout | BYTES=120 | LAST={"type":"item.started","item":{"id":"item_fc","type":"file_change","path":"scripts/watch-report.mjs"}}';
  const decodedFc = decodeProgressEntry(fileChangeLine);
  check("codex file_change decodes to edit kind", decodedFc?.kind === "edit", decodedFc);
  check("codex file_change decodes to file path", decodedFc?.text === "scripts/watch-report.mjs", decodedFc);

  const errorLine = '2026-11-03T16:02:10+03:00  ACTIVITY | STREAM=stdout | BYTES=130 | LAST={"type":"item.completed","item":{"id":"item_err","type":"error","message":"rate limit exceeded"}}';
  const decodedErr = decodeProgressEntry(errorLine);
  check("codex error decodes to WARN kind", decodedErr?.kind === "WARN", decodedErr);
  check("codex error decodes to message", decodedErr?.text === "⚠ rate limit exceeded", decodedErr);
}

// ── 5. Truncated JSON regex fallback ────────────────────────────────────────
{
  const truncatedLine = '2026-11-03T16:03:00+03:00  ACTIVITY | STREAM=stdout | BYTES=450 | LAST={"type":"item.started","item":{"id":"item_trunc","type":"command_execution","command":"/bin/bash -lc \\"sed -n \'220,420p\' specs/001-sample-feature/tasks.md; sed -n \'478,560p\' specs/010-dynamic-cli';
  const decodedTrunc = decodeProgressEntry(truncatedLine);
  check("truncated line decodes via regex fallback", decodedTrunc?.kind === "command", decodedTrunc);
  check("truncated line strips /bin/bash -lc and quotes", decodedTrunc?.text?.startsWith("sed -n '220,420p'"), decodedTrunc?.text);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll live-progress-codex checks passed.");
}
