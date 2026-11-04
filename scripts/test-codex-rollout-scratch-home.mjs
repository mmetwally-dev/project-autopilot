#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findCodexRollout,
  codexUsageFromRollout,
  deleteCodexRollout,
  reconcileCodexRolloutUsage,
  reconcileLiveCodexRolloutUsage
} from "./codex-rollout.mjs";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS ${name}`);
    return true;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-codex-scratch-test-"));
const fakeHome = path.join(tmpRoot, "fake-home");
const fakeCodexHome = path.join(fakeHome, ".codex");
fs.mkdirSync(fakeCodexHome, { recursive: true });
const canaryFile = path.join(fakeCodexHome, "canary.txt");
fs.writeFileSync(canaryFile, "untouched-home-canary\n");

const origHome = process.env.HOME;
const origCodexHome = process.env.CODEX_HOME;
process.env.HOME = fakeHome;
process.env.CODEX_HOME = fakeCodexHome;

try {
  // ── (1) Rollout under fake scratch home is found and deleted at run-end, ~/.codex not touched ──
  const fakeScratchDir = path.join(tmpRoot, "fake-scratch");
  const scratchCodexHome = path.join(fakeScratchDir, ".autopilot-home", ".codex");
  const d = new Date("2026-11-04T12:00:00Z");
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const sessionDir = path.join(scratchCodexHome, "sessions", y, m, day);
  fs.mkdirSync(sessionDir, { recursive: true });

  const threadId1 = "scratch-thread-id-001";
  const rolloutFile1 = path.join(sessionDir, `rollout-2026-11-04T12-00-00-${threadId1}.jsonl`);

  const event1 = {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 300,
          cached_input_tokens: 50,
          output_tokens: 40
        },
        last_token_usage: {
          input_tokens: 150
        }
      }
    }
  };
  const event2 = {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 200,
          output_tokens: 120
        },
        last_token_usage: {
          input_tokens: 450
        },
        model_context_window: 200000
      }
    }
  };
  fs.writeFileSync(rolloutFile1, `${JSON.stringify(event1)}\n${JSON.stringify(event2)}\n`);

  const found = findCodexRollout({
    threadId: threadId1,
    codexHome: [scratchCodexHome, fakeCodexHome],
    startedAt: d
  });
  check("findCodexRollout finds rollout in fake scratch home", found === rolloutFile1, { actual: found, expected: rolloutFile1 });

  const foundViaScratchDir = findCodexRollout({
    threadId: threadId1,
    scratchDir: fakeScratchDir,
    startedAt: d
  });
  check("findCodexRollout finds rollout via scratchDir", foundViaScratchDir === rolloutFile1, { actual: foundViaScratchDir, expected: rolloutFile1 });

  const initialUsage = {
    input: 0,
    cacheCreation: 0,
    cacheRead: 0,
    output: 0,
    turns: 5,
    maxSingleTurnContext: null,
    usagePartial: true
  };

  const finalUsage = reconcileCodexRolloutUsage({
    threadId: threadId1,
    codexHome: [scratchCodexHome, fakeCodexHome],
    startedAt: d,
    usage: initialUsage
  });

  check("final usage input from scratch rollout (1000 - 200 = 800)", finalUsage?.input === 800, { actual: finalUsage?.input, expected: 800 });
  check("final usage cacheRead from scratch rollout (200)", finalUsage?.cacheRead === 200, { actual: finalUsage?.cacheRead, expected: 200 });
  check("final usage output from scratch rollout (120)", finalUsage?.output === 120, { actual: finalUsage?.output, expected: 120 });
  check("final usage maxSingleTurnContext from scratch rollout (450)", finalUsage?.maxSingleTurnContext === 450, { actual: finalUsage?.maxSingleTurnContext, expected: 450 });
  check("final usage contextWindow from scratch rollout (200000)", finalUsage?.contextWindow === 200000, { actual: finalUsage?.contextWindow, expected: 200000 });
  check("final usage turns preserved (5)", finalUsage?.turns === 5, { actual: finalUsage?.turns, expected: 5 });
  check("final usage usagePartial is false", finalUsage?.usagePartial === false, { actual: finalUsage?.usagePartial, expected: false });
  check("rollout file in scratch home was deleted after run-end reconciliation", fs.existsSync(rolloutFile1) === false, { actual: fs.existsSync(rolloutFile1), expected: false });

  // Ensure ~/.codex (fakeCodexHome) was NOT touched
  check("canary in fake CODEX_HOME still exists untouched", fs.existsSync(canaryFile) === true, { actual: fs.existsSync(canaryFile), expected: true });
  const fakeHomeEntries = fs.readdirSync(fakeCodexHome);
  check("fake CODEX_HOME contains only the canary file", fakeHomeEntries.length === 1 && fakeHomeEntries[0] === "canary.txt", { actual: fakeHomeEntries, expected: ["canary.txt"] });

  // ── (2) Live update helper picks up token_count line appended mid-run ──
  const liveRolloutFile = path.join(tmpRoot, "live-rollout.jsonl");
  const liveTc1 = {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 250,
          cached_input_tokens: 50,
          output_tokens: 30
        },
        last_token_usage: {
          input_tokens: 120
        }
      }
    }
  };
  fs.writeFileSync(liveRolloutFile, `${JSON.stringify(liveTc1)}\n`);

  const liveUsage1 = {
    input: 0,
    cacheCreation: 0,
    cacheRead: 0,
    output: 0,
    turns: 2,
    maxSingleTurnContext: null,
    usagePartial: true
  };

  const liveRes1 = reconcileLiveCodexRolloutUsage(liveUsage1, liveRolloutFile);
  check("live update step 1: input is 200 (250 - 50)", liveRes1?.input === 200, { actual: liveRes1?.input, expected: 200 });
  check("live update step 1: cacheRead is 50", liveRes1?.cacheRead === 50, { actual: liveRes1?.cacheRead, expected: 50 });
  check("live update step 1: output is 30", liveRes1?.output === 30, { actual: liveRes1?.output, expected: 30 });
  check("live update step 1: maxSingleTurnContext is 120", liveRes1?.maxSingleTurnContext === 120, { actual: liveRes1?.maxSingleTurnContext, expected: 120 });
  check("live update step 1: turns preserved at 2", liveRes1?.turns === 2, { actual: liveRes1?.turns, expected: 2 });
  check("live update step 1: usagePartial remains true", liveRes1?.usagePartial === true, { actual: liveRes1?.usagePartial, expected: true });

  // Mid-run: append second token_count line to rollout file
  const liveTc2 = {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 800,
          cached_input_tokens: 150,
          output_tokens: 90
        },
        last_token_usage: {
          input_tokens: 380
        },
        model_context_window: 128000
      }
    }
  };
  fs.appendFileSync(liveRolloutFile, `${JSON.stringify(liveTc2)}\n`);

  // Stream advanced to turn 4
  const liveUsage2 = {
    ...liveRes1,
    turns: 4
  };

  const liveRes2 = reconcileLiveCodexRolloutUsage(liveUsage2, liveRolloutFile);
  check("live update step 2: input picks up appended line (800 - 150 = 650)", liveRes2?.input === 650, { actual: liveRes2?.input, expected: 650 });
  check("live update step 2: cacheRead picks up appended line (150)", liveRes2?.cacheRead === 150, { actual: liveRes2?.cacheRead, expected: 150 });
  check("live update step 2: output picks up appended line (90)", liveRes2?.output === 90, { actual: liveRes2?.output, expected: 90 });
  check("live update step 2: maxSingleTurnContext picks up appended line (380)", liveRes2?.maxSingleTurnContext === 380, { actual: liveRes2?.maxSingleTurnContext, expected: 380 });
  check("live update step 2: contextWindow is 128000", liveRes2?.contextWindow === 128000, { actual: liveRes2?.contextWindow, expected: 128000 });
  check("live update step 2: live turn count updated to 4", liveRes2?.turns === 4, { actual: liveRes2?.turns, expected: 4 });
  check("live update step 2: usagePartial remains true", liveRes2?.usagePartial === true, { actual: liveRes2?.usagePartial, expected: true });
  // Price weighted: 650 * 1 + 0 * 1.25 + 150 * 0.1 + 90 * 5 = 650 + 15 + 450 = 1115
  check("live update step 2: priceWeighted is 1115", liveRes2?.priceWeighted === 1115, { actual: liveRes2?.priceWeighted, expected: 1115 });

  // Missing rollout handling
  const fallbackRes = reconcileLiveCodexRolloutUsage(liveUsage2, "/nonexistent/rollout.jsonl");
  check("missing rollout in live update keeps input 200", fallbackRes?.input === 200, { actual: fallbackRes?.input, expected: 200 });
  check("missing rollout in live update keeps turns 4", fallbackRes?.turns === 4, { actual: fallbackRes?.turns, expected: 4 });
  check("missing rollout in live update keeps usagePartial true", fallbackRes?.usagePartial === true, { actual: fallbackRes?.usagePartial, expected: true });

  // Object signature
  const objRes = reconcileLiveCodexRolloutUsage({ usage: liveUsage2, rolloutFile: liveRolloutFile });
  check("object signature returns input 650", objRes?.input === 650, { actual: objRes?.input, expected: 650 });
  check("object signature returns output 90", objRes?.output === 90, { actual: objRes?.output, expected: 90 });
  check("object signature returns turns 4", objRes?.turns === 4, { actual: objRes?.turns, expected: 4 });
  check("object signature returns usagePartial true", objRes?.usagePartial === true, { actual: objRes?.usagePartial, expected: true });

} finally {
  process.env.HOME = origHome;
  if (origCodexHome !== undefined) process.env.CODEX_HOME = origCodexHome;
  else delete process.env.CODEX_HOME;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All codex rollout scratch home checks passed.");
