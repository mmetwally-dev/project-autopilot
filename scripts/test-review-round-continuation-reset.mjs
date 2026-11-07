#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  continuationBudgetKey,
  consumeContinuation,
  clearContinuationRound,
} from "./per-task-budget.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

// (a) unit: state with continuationBudgets[key]=3 and rolloverDeadEnds[key]=[...]
// -> clearContinuationRound returns true and both are gone; a second call returns false;
// another scope's key is untouched.
{
  const scopeA = "task:standalone:phase-0:code_reviewer";
  const scopeB = "task:standalone:phase-0:verifier";
  const keyA = continuationBudgetKey(scopeA);
  const keyB = continuationBudgetKey(scopeB);

  const state = {
    continuationBudgets: {
      [keyA]: 3,
      [keyB]: 5,
    },
    rolloverDeadEnds: {
      [keyA]: [{generation: 3, reason: "capped"}],
      [keyB]: [{generation: 1, reason: "incomplete"}],
    },
  };

  const firstCall = clearContinuationRound(state, scopeA);
  check("unit: clearContinuationRound returns true when entries exist", firstCall === true);
  check("unit: continuationBudgets key deleted", !(keyA in state.continuationBudgets));
  check("unit: rolloverDeadEnds key deleted", !(keyA in state.rolloverDeadEnds));
  check("unit: other scope continuationBudgets untouched", state.continuationBudgets[keyB] === 5);
  check("unit: other scope rolloverDeadEnds untouched", Array.isArray(state.rolloverDeadEnds[keyB]) && state.rolloverDeadEnds[keyB].length === 1);

  const secondCall = clearContinuationRound(state, scopeA);
  check("unit: second call returns false", secondCall === false);
}

// (b) the backlog sequence with consumeContinuation(limit 2) + clearContinuationRound:
// capped(used1), capped(used2), verdict -> clear, fix, capped -> used is 1 and allowed is true.
{
  const scope = "task:speckit:phase-0:code_reviewer";
  const policy = {caps: {code_reviewer: {max_turns: 22, extra_sessions: 2}}};
  const state = {};

  const c1 = consumeContinuation(state, policy, scope, 2);
  check("backlog sequence: session 1 capped used is 1", c1.used === 1);
  check("backlog sequence: session 1 capped allowed is true", c1.allowed === true);

  const c2 = consumeContinuation(state, policy, scope, 2);
  check("backlog sequence: session 2 capped used is 2", c2.used === 2);
  check("backlog sequence: session 2 capped allowed is true", c2.allowed === true);

  const cleared = clearContinuationRound(state, scope);
  check("backlog sequence: clearContinuationRound on verdict returns true", cleared === true);

  // Fix applied, new review round starts, capped session:
  const c3 = consumeContinuation(state, policy, scope, 2);
  check("backlog sequence: post-fix session 1 capped used is 1", c3.used === 1);
  check("backlog sequence: post-fix session 1 capped allowed is true", c3.allowed === true);
}

// (c) source check that autopilot.mjs calls clearContinuationRound for code_reviewer
// and verifier in BOTH the standalone and speckit loops (4 call sites, assert each scope string appears near a call).
{
  const autopilotPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "autopilot.mjs");
  const src = fs.readFileSync(autopilotPath, "utf8");

  const expectedScopes = [
    "`task:standalone:phase-${s.phaseIndex}:code_reviewer`",
    "`task:standalone:phase-${s.phaseIndex}:verifier`",
    "`task:speckit:phase-${s.phaseIndex}:code_reviewer`",
    "`task:speckit:phase-${s.phaseIndex}:verifier`",
  ];

  for (const expScope of expectedScopes) {
    // Find all occurrences of expScope and verify at least one is near clearContinuationRound
    let foundNearCall = false;
    let pos = 0;
    while ((pos = src.indexOf(expScope, pos)) !== -1) {
      const windowAround = src.slice(Math.max(0, pos - 100), pos + expScope.length + 100);
      if (windowAround.includes("clearContinuationRound")) {
        foundNearCall = true;
        break;
      }
      pos += expScope.length;
    }
    check(`source check: clearContinuationRound called with ${expScope}`, foundNearCall);
  }

  const matches = src.match(/clearContinuationRound\s*\(/g) || [];
  check("source check: at least 4 call sites in autopilot.mjs", matches.length >= 4, {count: matches.length});
}

console.log(failures === 0 ? "test-review-round-continuation-reset: OK" : `test-review-round-continuation-reset: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
