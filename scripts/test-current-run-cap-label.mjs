#!/usr/bin/env node
// Test for CURRENT RUN usage line cap labeling (backlog #4).
// Asserts that token cap is placed next to the single-turn context number,
// turn cap is placed next to turns when known, and "of <cap> cap" is NEVER
// printed right after the total weighted usage number.

import { buildReportModel, renderCurrentRun } from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

// ── 1. Backlog #4 case: usage 356,494, context 85,048, cap 200K, turns 21 with cap 30
{
  const state = {
    mission: "002-sample-mission",
    phase: "planning",
    step: "plan",
    phaseIndex: 0,
    attempt: 1,
    planningStartedAt: "2026-11-03T21:00:00+03:00",
  };
  const runs = [
    run({
      id: "110-planner-abc12345",
      role: "planner",
      phase: "1",
      attempt: "1",
      taskRef: "planning",
      status: "running",
      started_at: "2026-11-03T21:00:00+03:00",
      usage: {
        input: 107392,
        cacheRead: 1035419,
        output: 29112,
        turns: 21,
        maxSingleTurnContext: 85048,
        priceWeighted: 356494,
      },
    }),
  ];
  const policy = {
    caps: {
      planner: { max_tokens: 200000, max_turns: 30 },
    },
  };
  const model = buildReportModel({ state, runs, policy, now: "2026-11-03T21:10:00+03:00" });
  const current = renderCurrentRun(model);
  const usageLine = current.split("\n").find((l) => l.startsWith("usage so far:")) || "";

  check(
    "usage line contains 'context ~85.0K of 200K cap'",
    usageLine.includes("context ~85.0K of 200K cap"),
    usageLine
  );
  check(
    "usage line does NOT match /356\\.5K of 200K cap/",
    !/356\.5K of 200K cap/.test(usageLine),
    usageLine
  );
  check(
    "usage line contains '21 of 30 turns'",
    usageLine.includes("21 of 30 turns"),
    usageLine
  );
  check(
    "full usage line matches expected layout",
    usageLine === "usage so far:   ~356.5K tokens · context ~85.0K of 200K cap · 21 of 30 turns",
    usageLine
  );
}

// ── 2. Turn cap absent: turns renders as 'N turns'
{
  const state = { mission: "002-sample-mission", phase: "planning", step: "plan", phaseIndex: 0, attempt: 1 };
  const runs = [
    run({
      id: "110-planner-abc12345",
      role: "planner",
      status: "running",
      started_at: "2026-11-03T21:00:00+03:00",
      usage: {
        turns: 21,
        maxSingleTurnContext: 85048,
        priceWeighted: 356494,
      },
    }),
  ];
  const policy = {
    caps: {
      planner: { max_tokens: 200000 },
    },
  };
  const model = buildReportModel({ state, runs, policy, now: "2026-11-03T21:10:00+03:00" });
  const current = renderCurrentRun(model);
  const usageLine = current.split("\n").find((l) => l.startsWith("usage so far:")) || "";

  check(
    "without turn cap: line contains '21 turns'",
    usageLine.includes("21 turns"),
    usageLine
  );
  check(
    "without turn cap: line contains 'context ~85.0K of 200K cap'",
    usageLine.includes("context ~85.0K of 200K cap"),
    usageLine
  );
  check(
    "full line without turn cap",
    usageLine === "usage so far:   ~356.5K tokens · context ~85.0K of 200K cap · 21 turns",
    usageLine
  );
}

// ── 3. Token cap absent: context renders as 'context ~85.0K'
{
  const state = { mission: "002-sample-mission", phase: "planning", step: "plan", phaseIndex: 0, attempt: 1 };
  const runs = [
    run({
      id: "110-planner-abc12345",
      role: "planner",
      status: "running",
      started_at: "2026-11-03T21:00:00+03:00",
      usage: {
        turns: 21,
        maxSingleTurnContext: 85048,
        priceWeighted: 356494,
      },
    }),
  ];
  const policy = { caps: {} };
  const model = buildReportModel({ state, runs, policy, now: "2026-11-03T21:10:00+03:00" });
  const current = renderCurrentRun(model);
  const usageLine = current.split("\n").find((l) => l.startsWith("usage so far:")) || "";

  check(
    "without token cap: line contains 'context ~85.0K'",
    usageLine.includes("context ~85.0K"),
    usageLine
  );
  check(
    "without token cap: line does NOT contain 'cap'",
    !usageLine.includes("cap"),
    usageLine
  );
  check(
    "full line without caps",
    usageLine === "usage so far:   ~356.5K tokens · context ~85.0K · 21 turns",
    usageLine
  );
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All current-run cap label checks passed.");
