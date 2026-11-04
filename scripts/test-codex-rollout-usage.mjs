#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adapterDriver, accumulateUsage, sessionIdFromEvents } from "./adapter-drivers.mjs";
import { growingTerm, evaluateTokenCeiling, checkCapBreach } from "./per-task-budget.mjs";
import { contextCell } from "./watch-report.mjs";
import { contextCellText } from "./run-history.mjs";
import {
  findCodexRollout,
  codexUsageFromRollout,
  deleteCodexRollout,
  reconcileCodexRolloutUsage
} from "./codex-rollout.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

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

// 1. codex argv no longer contains --ephemeral
{
  const driver = adapterDriver("codex");
  const inv = driver.buildInvocation({ mode: "write", cwd: "/workspace", binary: "codex" });
  check("codex argv no longer contains --ephemeral", !inv.args.includes("--ephemeral"), { args: inv.args });
  check("codex argv includes exec", inv.args[0] === "exec", { actual: inv.args[0] });
  check("codex argv includes --json", inv.args[1] === "--json", { actual: inv.args[1] });
}

// Setup temp CODEX_HOME
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-codex-rollout-test-"));
const codexHome = path.join(tmpRoot, ".codex");

try {
  const d = new Date("2026-11-04T12:00:00Z");
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");

  const sessionDir = path.join(codexHome, "sessions", y, m, day);
  fs.mkdirSync(sessionDir, { recursive: true });

  // 2. fixture CODEX_HOME with sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl holding two token_count events
  //    → codexUsageFromRollout returns the LAST totals
  const threadId1 = "01a1a178-8837-7ac0-995d-a49b117097ac";
  const rolloutFile1 = path.join(sessionDir, `rollout-2026-11-04T12-00-00-${threadId1}.jsonl`);

  const event1 = {
    timestamp: 1000,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 5
        }
      }
    }
  };
  const event2 = {
    timestamp: 2000,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 500,
          cached_input_tokens: 100,
          output_tokens: 80,
          reasoning_output_tokens: 10
        }
      }
    }
  };

  fs.writeFileSync(rolloutFile1, `${JSON.stringify(event1)}\n${JSON.stringify(event2)}\n`);

  const usage1 = codexUsageFromRollout(rolloutFile1);
  check("codexUsageFromRollout returns last input (500 - 100 = 400)", usage1?.input === 400, { actual: usage1?.input, expected: 400 });
  check("codexUsageFromRollout returns last cacheRead (100)", usage1?.cacheRead === 100, { actual: usage1?.cacheRead, expected: 100 });
  check("codexUsageFromRollout returns cacheCreation 0", usage1?.cacheCreation === 0, { actual: usage1?.cacheCreation, expected: 0 });
  check("codexUsageFromRollout returns last output (80)", usage1?.output === 80, { actual: usage1?.output, expected: 80 });
  // Price weighted: 400 * 1 + 0 * 1.25 + 100 * 0.1 + 80 * 5 = 400 + 10 + 400 = 810
  check("codexUsageFromRollout returns priceWeighted 810", usage1?.priceWeighted === 810, { actual: usage1?.priceWeighted, expected: 810 });

  // 3. capped stdout without turn.completed + that rollout → final usage from the rollout, usagePartial false
  //    and 4. the rollout file is deleted afterwards
  const threadId2 = "thread-capped-run-002";
  const rolloutFile2 = path.join(sessionDir, `rollout-2026-11-04T12-05-00-${threadId2}.jsonl`);
  const cappedRolloutEvent = {
    timestamp: 3000,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1200,
          cached_input_tokens: 300,
          output_tokens: 250,
          reasoning_output_tokens: 50
        }
      }
    }
  };
  fs.writeFileSync(rolloutFile2, `${JSON.stringify(cappedRolloutEvent)}\n`);

  const codexDriver = adapterDriver("codex");
  const cappedStdoutLines = [
    JSON.stringify({ type: "thread.started", thread_id: threadId2 }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution" } })
  ].join("\n");

  const cappedEvents = codexDriver.decodeEvents(cappedStdoutLines, "");
  const extractedThreadId2 = sessionIdFromEvents(cappedEvents);
  check("sessionIdFromEvents extracts threadId from thread.started", extractedThreadId2 === threadId2, { actual: extractedThreadId2, expected: threadId2 });

  const initialCappedUsage = accumulateUsage("codex", cappedEvents);
  check("initial capped usage has usagePartial true", initialCappedUsage?.usagePartial === true, { actual: initialCappedUsage?.usagePartial, expected: true });
  check("initial capped usage has input 0", initialCappedUsage?.input === 0, { actual: initialCappedUsage?.input, expected: 0 });
  check("initial capped usage has turns 2", initialCappedUsage?.turns === 2, { actual: initialCappedUsage?.turns, expected: 2 });

  const reconciledCappedUsage = reconcileCodexRolloutUsage({
    threadId: extractedThreadId2,
    codexHome,
    startedAt: d,
    usage: initialCappedUsage
  });

  check("final usage input from rollout (1200 - 300 = 900)", reconciledCappedUsage?.input === 900, { actual: reconciledCappedUsage?.input, expected: 900 });
  check("final usage cacheRead from rollout (300)", reconciledCappedUsage?.cacheRead === 300, { actual: reconciledCappedUsage?.cacheRead, expected: 300 });
  check("final usage output from rollout (250)", reconciledCappedUsage?.output === 250, { actual: reconciledCappedUsage?.output, expected: 250 });
  check("final usage turns preserved (2)", reconciledCappedUsage?.turns === 2, { actual: reconciledCappedUsage?.turns, expected: 2 });
  // Price weighted: 900 * 1 + 0 * 1.25 + 300 * 0.1 + 250 * 5 = 900 + 30 + 1250 = 2180
  check("final usage priceWeighted matches rollout (2180)", reconciledCappedUsage?.priceWeighted === 2180, { actual: reconciledCappedUsage?.priceWeighted, expected: 2180 });
  check("final usage usagePartial is false", reconciledCappedUsage?.usagePartial === false, { actual: reconciledCappedUsage?.usagePartial, expected: false });
  check("the rollout file is deleted afterwards", fs.existsSync(rolloutFile2) === false, { exists: fs.existsSync(rolloutFile2) });

  // 4. completed run with turn.completed → usage from turn.completed and the rollout still deleted
  const threadId3 = "thread-completed-run-003";
  const rolloutFile3 = path.join(sessionDir, `rollout-2026-11-04T12-10-00-${threadId3}.jsonl`);
  const completedRolloutEvent = {
    timestamp: 4000,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 99999,
          cached_input_tokens: 0,
          output_tokens: 99999,
          reasoning_output_tokens: 0
        }
      }
    }
  };
  fs.writeFileSync(rolloutFile3, `${JSON.stringify(completedRolloutEvent)}\n`);

  const completedStdoutLines = [
    JSON.stringify({ type: "thread.started", thread_id: threadId3 }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution" } }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 350,
        cached_input_tokens: 50,
        cache_write_input_tokens: 10,
        output_tokens: 45
      }
    })
  ].join("\n");

  const completedEvents = codexDriver.decodeEvents(completedStdoutLines, "");
  const extractedThreadId3 = sessionIdFromEvents(completedEvents);
  const initialCompletedUsage = accumulateUsage("codex", completedEvents);
  check("initial completed usage has input 300", initialCompletedUsage?.input === 300, { actual: initialCompletedUsage?.input, expected: 300 });
  check("initial completed usage has usagePartial falsy", !initialCompletedUsage?.usagePartial, { actual: initialCompletedUsage?.usagePartial });

  const reconciledCompletedUsage = reconcileCodexRolloutUsage({
    threadId: extractedThreadId3,
    codexHome,
    startedAt: d,
    usage: initialCompletedUsage
  });

  check("completed run keeps usage from turn.completed input (300)", reconciledCompletedUsage?.input === 300, { actual: reconciledCompletedUsage?.input, expected: 300 });
  check("completed run keeps usage from turn.completed output (45)", reconciledCompletedUsage?.output === 45, { actual: reconciledCompletedUsage?.output, expected: 45 });
  check("completed run still deletes the rollout file", fs.existsSync(rolloutFile3) === false, { exists: fs.existsSync(rolloutFile3) });

  // 5. missing rollout → usagePartial stays, no throw
  const missingUsageInitial = {
    input: 0,
    cacheCreation: 0,
    cacheRead: 0,
    output: 0,
    turns: 5,
    maxSingleTurnContext: null,
    usagePartial: true,
    priceWeighted: 0
  };
  let threw = false;
  let missingResult = null;
  try {
    missingResult = reconcileCodexRolloutUsage({
      threadId: "nonexistent-thread-id-004",
      codexHome,
      startedAt: d,
      usage: missingUsageInitial
    });
  } catch {
    threw = true;
  }
  check("missing rollout does not throw", threw === false, { threw });
  check("missing rollout keeps usagePartial true", missingResult?.usagePartial === true, { actual: missingResult?.usagePartial, expected: true });
  check("missing rollout keeps input 0", missingResult?.input === 0, { actual: missingResult?.input, expected: 0 });

  // Test crossing midnight lookup
  const lateNightStart = new Date("2026-11-04T23:58:00Z");
  const nextDayDir = path.join(codexHome, "sessions", "2026", "11", "05");
  fs.mkdirSync(nextDayDir, { recursive: true });
  const midnightThreadId = "thread-midnight-005";
  const midnightRolloutFile = path.join(nextDayDir, `rollout-2026-11-05T00-02-00-${midnightThreadId}.jsonl`);
  fs.writeFileSync(midnightRolloutFile, `${JSON.stringify(event1)}\n`);

  const foundMidnight = findCodexRollout({
    threadId: midnightThreadId,
    codexHome,
    startedAt: lateNightStart
  });
  check("findCodexRollout finds rollout in next day's date folder (crossed midnight)", foundMidnight === midnightRolloutFile, { actual: foundMidnight, expected: midnightRolloutFile });
  deleteCodexRollout(midnightRolloutFile);
  check("deleteCodexRollout deleted midnight rollout file", fs.existsSync(midnightRolloutFile) === false, { exists: fs.existsSync(midnightRolloutFile) });

  // 6. Rollout with three token_count events
  //    → maxSingleTurnContext = the largest last_token_usage.input_tokens
  //    → records model_context_window (contextWindow)
  //    → report CONTEXT cell shows it for a codex run
  //    → cap works with growingTerm
  const threadIdThree = "thread-three-events-006";
  const rolloutFileThree = path.join(sessionDir, `rollout-2026-11-04T12-30-00-${threadIdThree}.jsonl`);

  const tc1 = {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 25000,
          cached_input_tokens: 10000,
          cache_write_input_tokens: 0,
          output_tokens: 150,
          reasoning_output_tokens: 20,
          total_tokens: 25150
        },
        last_token_usage: {
          input_tokens: 15000,
          cached_input_tokens: 10000,
          cache_write_input_tokens: 0,
          output_tokens: 150,
          reasoning_output_tokens: 20,
          total_tokens: 15150
        },
        model_context_window: 258400
      }
    }
  };

  const tc2 = {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 55000,
          cached_input_tokens: 30000,
          cache_write_input_tokens: 0,
          output_tokens: 350,
          reasoning_output_tokens: 45,
          total_tokens: 55350
        },
        last_token_usage: {
          input_tokens: 27684,
          cached_input_tokens: 21248,
          cache_write_input_tokens: 0,
          output_tokens: 179,
          reasoning_output_tokens: 0,
          total_tokens: 27863
        },
        model_context_window: 258400
      }
    }
  };

  const tc3 = {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 79007,
          cached_input_tokens: 50432,
          cache_write_input_tokens: 0,
          output_tokens: 476,
          reasoning_output_tokens: 67,
          total_tokens: 79483
        },
        last_token_usage: {
          input_tokens: 22000,
          cached_input_tokens: 18000,
          cache_write_input_tokens: 0,
          output_tokens: 126,
          reasoning_output_tokens: 22,
          total_tokens: 22126
        },
        model_context_window: 258400
      }
    }
  };

  fs.writeFileSync(rolloutFileThree, `${JSON.stringify(tc1)}\n${JSON.stringify(tc2)}\n${JSON.stringify(tc3)}\n`);

  const usageThree = codexUsageFromRollout(rolloutFileThree);
  check("three token_count events → maxSingleTurnContext = largest last_token_usage.input_tokens (27684)", usageThree?.maxSingleTurnContext === 27684, { actual: usageThree?.maxSingleTurnContext, expected: 27684 });
  check("three token_count events records contextWindow 258400", usageThree?.contextWindow === 258400, { actual: usageThree?.contextWindow, expected: 258400 });
  check("three token_count events last input is 28575 (79007 - 50432)", usageThree?.input === 28575, { actual: usageThree?.input, expected: 28575 });
  check("three token_count events last cacheRead is 50432", usageThree?.cacheRead === 50432, { actual: usageThree?.cacheRead, expected: 50432 });
  check("three token_count events last output is 476", usageThree?.output === 476, { actual: usageThree?.output, expected: 476 });

  // Reconcile codex run with rollout
  const initialThreeRunUsage = {
    input: 0,
    cacheCreation: 0,
    cacheRead: 0,
    output: 0,
    turns: 3,
    maxSingleTurnContext: null,
    usagePartial: true,
    priceWeighted: 0
  };
  const reconciledThree = reconcileCodexRolloutUsage({
    threadId: threadIdThree,
    codexHome,
    startedAt: d,
    usage: initialThreeRunUsage
  });

  check("reconciled usage has maxSingleTurnContext 27684", reconciledThree?.maxSingleTurnContext === 27684, { actual: reconciledThree?.maxSingleTurnContext, expected: 27684 });
  check("reconciled usage has contextWindow 258400", reconciledThree?.contextWindow === 258400, { actual: reconciledThree?.contextWindow, expected: 258400 });
  check("reconciled rollout file deleted", fs.existsSync(rolloutFileThree) === false, { exists: fs.existsSync(rolloutFileThree) });

  // Watch-report contextCell and run-history contextCellText with rollout
  const codexRun = { status: "completed", usage: reconciledThree };
  const cellWatch = contextCell(codexRun);
  const cellHistory = contextCellText(codexRun);
  check("report CONTEXT cell shows real value for codex run (27.7K)", cellWatch === "27.7K", { actual: cellWatch, expected: "27.7K" });
  check("run-history contextCellText shows real value for codex run (27.7K)", cellHistory === "27.7K", { actual: cellHistory, expected: "27.7K" });

  // Cap / growingTerm with real number
  const growing = growingTerm(reconciledThree);
  check("growingTerm returns 27684 for codex run with rollout", growing === 27684, { actual: growing, expected: 27684 });
  const ceilingBreach = evaluateTokenCeiling({ usage: reconciledThree, maxTokens: 25000 });
  check("evaluateTokenCeiling fires when cap (25000) < maxSingleTurnContext (27684)", ceilingBreach.exceeded === true && ceilingBreach.growing === 27684, ceilingBreach);
  const ceilingOk = evaluateTokenCeiling({ usage: reconciledThree, maxTokens: 30000 });
  check("evaluateTokenCeiling passes when cap (30000) > maxSingleTurnContext (27684)", ceilingOk.exceeded === false && ceilingOk.growing === 27684, ceilingOk);
  const breachRecord = checkCapBreach({ usage: reconciledThree, perTaskMaxTurns: 10, perTaskMaxTokens: 25000 });
  check("checkCapBreach fires token breach with used 27684 and limit 25000", breachRecord?.type === "tokens" && breachRecord?.used === 27684 && breachRecord?.limit === 25000, breachRecord);

  // No rollout → stays null and "-"
  const noRolloutUsage = {
    input: 100,
    cacheCreation: 0,
    cacheRead: 20,
    output: 30,
    turns: 2,
    maxSingleTurnContext: null,
    usagePartial: false,
    priceWeighted: 150
  };
  const reconciledNoRollout = reconcileCodexRolloutUsage({
    threadId: "nonexistent-thread-no-rollout",
    codexHome,
    startedAt: d,
    usage: noRolloutUsage
  });
  check("no rollout → maxSingleTurnContext stays null", reconciledNoRollout?.maxSingleTurnContext === null, { actual: reconciledNoRollout?.maxSingleTurnContext, expected: null });
  const noRolloutRun = { status: "completed", usage: reconciledNoRollout };
  check("no rollout → report CONTEXT cell renders '-'", contextCell(noRolloutRun) === "-", { actual: contextCell(noRolloutRun), expected: "-" });
  check("no rollout → run-history contextCellText renders '-'", contextCellText(noRolloutRun) === "-", { actual: contextCellText(noRolloutRun), expected: "-" });
  check("no rollout → growingTerm returns null", growingTerm(reconciledNoRollout) === null, { actual: growingTerm(reconciledNoRollout) });

} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

// 7. Verify autopilot.mjs wiring
{
  check("autopilot.mjs imports findCodexRollout", autopilotSource.includes("findCodexRollout"), { imported: autopilotSource.includes("findCodexRollout") });
  check("autopilot.mjs imports codexUsageFromRollout", autopilotSource.includes("codexUsageFromRollout"), { imported: autopilotSource.includes("codexUsageFromRollout") });
  check("autopilot.mjs imports deleteCodexRollout", autopilotSource.includes("deleteCodexRollout"), { imported: autopilotSource.includes("deleteCodexRollout") });

  const runRelayIdx = autopilotSource.indexOf("async function runRelay(");
  const runRelayEndIdx = autopilotSource.indexOf("function guardedShell(", runRelayIdx);
  const runRelayBody = runRelayIdx !== -1 && runRelayEndIdx !== -1 ? autopilotSource.slice(runRelayIdx, runRelayEndIdx) : "";

  check("runRelay body found in autopilot.mjs", runRelayBody.length > 0);
  check("runRelay checks role.adapter === \"codex\"", runRelayBody.includes('role.adapter==="codex"') || runRelayBody.includes('role.adapter === "codex"'));
  check("runRelay calls findCodexRollout", runRelayBody.includes("findCodexRollout("));
  check("runRelay calls codexUsageFromRollout", runRelayBody.includes("codexUsageFromRollout("));
  check("runRelay calls deleteCodexRollout", runRelayBody.includes("deleteCodexRollout("));
}

if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All codex rollout usage checks passed.");
