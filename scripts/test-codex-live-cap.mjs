#!/usr/bin/env node
import { accumulateUsage, accumulateCodexUsage, finalVerdictPrinted } from "./adapter-drivers.mjs";
import { checkCapBreach, evaluateTokenCeiling, growingTerm } from "./per-task-budget.mjs";
import { priceCell, turnsCell } from "./watch-report.mjs";

function check(name, cond, detail) {
  if (!cond) {
    console.error(`FAIL: ${name}${detail !== undefined ? ` - got: ${JSON.stringify(detail)}` : ""}`);
    process.exit(1);
  }
  console.log(`PASS: ${name}`);
}

// -----------------------------------------------------------------------------
// (1) Codex stream with 31 command item.completed and no turn.completed
//     -> accumulateUsage gives turns 31 (partial) and checkCapBreach with perTaskMaxTurns 30 -> breach
// -----------------------------------------------------------------------------
const events31Commands = [];
for (let i = 1; i <= 31; i++) {
  events31Commands.push({
    type: "item.completed",
    item: { type: "command_execution", command: `echo ${i}`, exit_code: 0 },
  });
}

const partialUsage = accumulateUsage("codex", events31Commands);
check("(1) accumulateUsage returns partial usage when commands completed but no turn.completed", partialUsage !== null, partialUsage);
check("(1) partial usage reports turns 31", partialUsage?.turns === 31, partialUsage?.turns);
check("(1) partial usage marked with usagePartial: true", partialUsage?.usagePartial === true, partialUsage?.usagePartial);
check("(1) partial usage token fields are 0",
  partialUsage?.input === 0 &&
  partialUsage?.output === 0 &&
  partialUsage?.cacheRead === 0 &&
  partialUsage?.cacheCreation === 0,
  partialUsage);

const breach31 = checkCapBreach({ usage: partialUsage, perTaskMaxTurns: 30, perTaskMaxTokens: 50000 });
check("(1) checkCapBreach with perTaskMaxTurns 30 fires turns breach", breach31?.type === "turns", breach31?.type);
check("(1) checkCapBreach breach used matches turns 31", breach31?.used === 31, breach31?.used);
check("(1) checkCapBreach breach limit matches perTaskMaxTurns 30", breach31?.limit === 30, breach31?.limit);

// -----------------------------------------------------------------------------
// (2) 30 commands + an agent_message with AUTOPILOT_REVIEW= -> turns 30, no breach
// -----------------------------------------------------------------------------
const events30CommandsAndVerdict = [];
for (let i = 1; i <= 30; i++) {
  events30CommandsAndVerdict.push({
    type: "item.completed",
    item: { type: "command_execution", command: `echo ${i}`, exit_code: 0 },
  });
}
events30CommandsAndVerdict.push({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: 'Review complete.\nAUTOPILOT_REVIEW={"decision":"PASS","findings":[]}',
  },
});

const usage30 = accumulateUsage("codex", events30CommandsAndVerdict);
check("(2) accumulateUsage ignores agent_message so turns is exactly 30", usage30?.turns === 30, usage30?.turns);

const breach30 = checkCapBreach({ usage: usage30, perTaskMaxTurns: 30, perTaskMaxTokens: 50000 });
check("(2) checkCapBreach with 30 turns and limit 30 gives no breach", breach30 === null, breach30);

// -----------------------------------------------------------------------------
// (3) 31 commands then verdict printed then turn.completed
//     -> the "no breach after verdict" guard holds (test the guard function you add)
// -----------------------------------------------------------------------------
const events31VerdictThenTurn = [
  ...events31Commands,
  {
    type: "item.completed",
    item: {
      type: "agent_message",
      text: 'Review done.\nAUTOPILOT_REVIEW={"decision":"PASS","findings":[]}',
    },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 800,
      cache_write_input_tokens: 0,
      output_tokens: 150,
      reasoning_output_tokens: 20,
    },
  },
];

check("(3) guard recognizes verdict in decoded events",
  finalVerdictPrinted(events31VerdictThenTurn) === true,
  finalVerdictPrinted(events31VerdictThenTurn));

check("(3) guard recognizes verdict in stdout text chunk",
  finalVerdictPrinted([], 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}') === true,
  finalVerdictPrinted([], 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}'));

check("(3) guard recognizes implementer final result line",
  finalVerdictPrinted([], 'AUTOPILOT_TASK_RESULT={"status":"passed","summary":"all done"}') === true,
  finalVerdictPrinted([], 'AUTOPILOT_TASK_RESULT={"status":"passed","summary":"all done"}'));

check("(3) guard returns false when no verdict printed",
  finalVerdictPrinted(events31Commands, "running command step 31...") === false,
  finalVerdictPrinted(events31Commands, "running command step 31..."));

// -----------------------------------------------------------------------------
// (4) Partial usage does not trigger the token cap and is not shown as 0 tokens
//     (WATCH-REPORT tokens cell "-")
// -----------------------------------------------------------------------------
const ceilingCheck = evaluateTokenCeiling({ usage: partialUsage, maxTokens: 100 });
check("(4) evaluateTokenCeiling is unenforceable for partial usage", ceilingCheck.enforceable === false, ceilingCheck.enforceable);
check("(4) evaluateTokenCeiling is not exceeded for partial usage", ceilingCheck.exceeded === false, ceilingCheck.exceeded);
check("(4) evaluateTokenCeiling reason is usage_unavailable for partial usage", ceilingCheck.reason === "usage_unavailable", ceilingCheck.reason);

const capBreachTokenCheck = checkCapBreach({ usage: partialUsage, perTaskMaxTurns: 50, perTaskMaxTokens: 100 });
check("(4) checkCapBreach does not trigger token cap on partial usage", capBreachTokenCheck === null, capBreachTokenCheck);

check("(4) growingTerm returns null for partial usage", growingTerm(partialUsage) === null, growingTerm(partialUsage));

const runningRun = {
  id: "r-test",
  status: "running",
  usage: partialUsage,
};
check("(4) WATCH-REPORT priceCell renders '-' for partial usage (never '0' or '~0')",
  priceCell(runningRun) === "-",
  priceCell(runningRun));

const completedRun = {
  id: "r-test",
  status: "completed",
  usage: partialUsage,
};
check("(4) WATCH-REPORT priceCell renders '-' even if run completed with partial usage",
  priceCell(completedRun) === "-",
  priceCell(completedRun));

check("(4) WATCH-REPORT turnsCell renders '31' for partial usage turns",
  turnsCell(runningRun) === "31",
  turnsCell(runningRun));

console.log("ALL CODEX LIVE CAP TESTS PASSED");
