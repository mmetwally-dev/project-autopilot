#!/usr/bin/env node
import fs from "node:fs";
import { runCappedFixSessions, runFinalReviewFixRounds } from "./final-review-fix-rounds.mjs";
import { resolveContinuationAllowance } from "./per-task-budget.mjs";
import { callArgs, callOptions, functionBody } from "./test-fixtures/source-scan.mjs";

// Backlog #14: final-review fix-round implementer launches run capped and
// continue on a cap breach, like phase-task implementer sessions.
let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

// ── Source wiring ──
const helperBody = functionBody(src, "async function runCappedFinalFixImplementer(");
const implCalls = callArgs(helperBody, 'relay("implementer",');
check("the single fix-round relay passes capEnabled:true, a contScope and a taskRef",
  implCalls.length === 1
  && callOptions(implCalls[0]).includes("capEnabled:true")
  && callOptions(implCalls[0]).includes("contScope:scopeKey")
  && callOptions(implCalls[0]).includes("taskRef"));
check("scope key is final-fix:<framework>:round-<n>", helperBody.includes("`final-fix:${framework}:round-${round}`"));
const standaloneBody = functionBody(src, "async function runStandaloneFinalReviewFixRounds(");
check("standalone fix pass goes through the capped helper with its framework",
  standaloneBody.includes('runCappedFinalFixImplementer(c,s,{framework:"standalone",round,')
  && !standaloneBody.includes('relay("implementer"'));
const speckitStart = src.indexOf("const speckitFinalFix=await runFinalReviewFixRounds(");
const speckitBlock = src.slice(speckitStart, speckitStart + 4000);
check("SpecKit fix pass goes through the capped helper with its framework",
  speckitStart > 0 && speckitBlock.includes('runCappedFinalFixImplementer(c,s,{framework:"speckit",round,')
  && !speckitBlock.includes('relay("implementer"'));
check("every runFinalReviewFixRounds caller is covered (two helpers' call sites only)",
  [...src.matchAll(/await runFinalReviewFixRounds\(/g)].length === 2);
const bareImplementerRelays = [...src.matchAll(/relay(?:Async)?\("implementer",/g)].length;
check("no implementer relay remains without capEnabled (task x2, GSD, fix helper)",
  bareImplementerRelays === 4
  && [...callArgs(src, 'relay("implementer",'), ...callArgs(src, 'relayAsync("implementer",')].every((call) => callOptions(call).includes("capEnabled:true")));

// ── Behaviour ──
const cappedResult = (n) => ({ status: "completed", capped: { type: "turns", used: 41, limit: 40 }, touchedFiles: [`f${n}.mjs`], workDigest: `digest ${n}` });
const doneResult = { status: "completed", touchedFiles: ["a.mjs"], finalMessage: "done" };
const quiet = () => {};

{
  const state = {};
  const seenDeadEnds = [];
  const queue = [cappedResult(1), cappedResult(2), doneResult];
  const result = await runCappedFixSessions({
    state, policy: {}, scopeKey: "final-fix:speckit:round-1", log: quiet,
    launch: async ({ deadEnds }) => { seenDeadEnds.push(deadEnds.length); return queue.shift(); },
  });
  check("capped sessions continue until a session ends uncapped", result === doneResult && queue.length === 0);
  check("each continuation sees the dead ends of the earlier capped sessions", JSON.stringify(seenDeadEnds) === "[0,1,2]");
  check("continuation ledger and dead ends are cleared after the round", !state.continuationBudgets || Object.keys(state.continuationBudgets).length === 0);
}

{
  const state = {};
  const allowance = resolveContinuationAllowance({});
  let launches = 0;
  const result = await runCappedFixSessions({
    state, policy: {}, scopeKey: "final-fix:standalone:round-1", log: quiet,
    launch: async () => { launches += 1; return cappedResult(launches); },
  });
  check("allowance exhaustion stops launching after allowance+1 sessions", launches === allowance + 1);
  check("exhausted allowance returns a failed fix result", result.status === "failed" && Boolean(result.capped));
}

{
  const state = {};
  const logs = [];
  let launches = 0;
  const result = await runCappedFixSessions({
    state, policy: { continuation_allowance: 1 }, scopeKey: "final-fix:standalone:round-2", log: (m) => logs.push(m),
    launch: async () => { launches += 1; return cappedResult(launches); },
  });
  check("a policy-configured allowance of 1 gives exactly 2 sessions", launches === 2 && result.status === "failed");
  check("continue and exhaust messages are logged", logs.length === 2 && /continuing as session 2 of 2/.test(logs[0]) && /ending the fix round as failed/.test(logs[1]));
}

{
  // Through runFinalReviewFixRounds: an exhausted fix session is a failed fix
  // pass inside the existing round accounting, never an extra escalation path.
  const state = {};
  const review = { status: "completed", review: { decision: "FAIL", findings: ["bug in src/a.mjs"] } };
  let reviews = 0;
  const outcome = await runFinalReviewFixRounds({
    state, policy: { final_review_fix_rounds: 1 }, initialReview: review, initialFindings: ["bug in src/a.mjs"],
    deps: {
      buildFixBrief: () => "",
      runFixPass: ({ round }) => runCappedFixSessions({
        state, policy: {}, scopeKey: `final-fix:standalone:round-${round}`, log: quiet,
        launch: async () => cappedResult(round),
      }),
      runGate: async () => null,
      runFinalReview: async () => { reviews += 1; return review; },
    },
  });
  check("failed capped fix round is accounted as one consumed round, then the budget escalates",
    state.finalReviewFixRoundsUsed === 1 && reviews === 1 && outcome.outcome === "escalate");
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("All final-fix-round cap checks passed");
