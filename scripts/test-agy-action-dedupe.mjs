#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observe } from "./run-observability.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`PASS ${name}`);
    return true;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-agy-dedupe-"));

try {
  // 1. ACTIVE + DONE of one step_index -> exactly 1 ACTION line in progress.log
  const dir1 = path.join(tmpDir, "run1");
  const cid1 = "conv-dedupe-1";

  observe(dir1, {
    last: JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: cid1,
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "git status -s" } }
      }
    })
  });

  observe(dir1, {
    last: JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: cid1,
        step_index: 1,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "git status -s" } }
      }
    })
  });

  const lines1 = fs.readFileSync(path.join(dir1, "progress.log"), "utf8")
    .split(/\r?\n/)
    .filter(l => l.includes("ACTION |"));

  check(
    "ACTIVE+DONE of one step_index: exactly 1 ACTION line",
    lines1.length === 1,
    lines1.length
  );
  check(
    "ACTIVE+DONE of one step_index: correct TOOL and command in line",
    lines1[0]?.includes("TOOL=run_command | git status -s") === true,
    lines1[0]
  );

  // 2. Two distinct steps (step_index: 1 and 2) -> exactly 2 ACTION lines
  const dir2 = path.join(tmpDir, "run2");
  const cid2 = "conv-dedupe-2";

  observe(dir2, {
    last: JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: cid2,
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "git status -s" } }
      }
    })
  });
  observe(dir2, {
    last: JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: cid2,
        step_index: 1,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "git status -s" } }
      }
    })
  });
  observe(dir2, {
    last: JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: cid2,
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: { parameters: { target_file: "scripts/setup.mjs" } }
      }
    })
  });
  observe(dir2, {
    last: JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: cid2,
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: { parameters: { target_file: "scripts/setup.mjs" } }
      }
    })
  });

  const lines2 = fs.readFileSync(path.join(dir2, "progress.log"), "utf8")
    .split(/\r?\n/)
    .filter(l => l.includes("ACTION |"));

  check(
    "two distinct steps: exactly 2 ACTION lines",
    lines2.length === 2,
    lines2.length
  );
  check(
    "two distinct steps: step 1 action present",
    lines2[0]?.includes("TOOL=run_command | git status -s") === true,
    lines2[0]
  );
  check(
    "two distinct steps: step 2 action present",
    lines2[1]?.includes("TOOL=write_to_file | scripts/setup.mjs") === true,
    lines2[1]
  );

  // 3. OpenCode tool event unchanged
  const dir3 = path.join(tmpDir, "run3");
  observe(dir3, {
    last: JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        state: { input: { command: "npm test" } }
      }
    })
  });

  const lines3 = fs.readFileSync(path.join(dir3, "progress.log"), "utf8")
    .split(/\r?\n/)
    .filter(l => l.includes("ACTION |"));

  check(
    "opencode tool event: exactly 1 ACTION line",
    lines3.length === 1,
    lines3.length
  );
  check(
    "opencode tool event: correct TOOL and command",
    lines3[0]?.includes("TOOL=bash | npm test") === true,
    lines3[0]
  );

  // 4. Claude tool event unchanged
  const dir4 = path.join(tmpDir, "run4");
  observe(dir4, {
    last: JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: "/repo/src/a.mjs" }
        }]
      }
    })
  });

  const lines4 = fs.readFileSync(path.join(dir4, "progress.log"), "utf8")
    .split(/\r?\n/)
    .filter(l => l.includes("ACTION |"));

  check(
    "claude tool event: exactly 1 ACTION line",
    lines4.length === 1,
    lines4.length
  );
  check(
    "claude tool event: correct TOOL and path",
    lines4[0]?.includes("TOOL=read | /repo/src/a.mjs") === true,
    lines4[0]
  );
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

if (failures > 0) {
  console.error(`FAILED (${failures} failure(s))`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
