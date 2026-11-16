#!/usr/bin/env node
import assert from "node:assert/strict";
import { stopIfBriefExceedsCap } from "./autopilot.mjs";

console.log("Running stop-capped-first-turn tests (#9)...");

// Test 1: Fake role whose first turn exceeds the cap limit
{
  let diedMessage = null;
  const s = { phase: "implementing" };
  const c = { policy: { caps: { fake_role: { max_tokens: 250000, wrap_up_at_tokens: 225000 } } } };
  const result = {
    capped: { type: "tokens", used: 286091, limit: 225000 },
    usage: { turns: 1, maxSingleTurnContext: 286091 },
  };

  const stopped = stopIfBriefExceedsCap({
    result,
    subject: "SpecKit code review",
    role: "fake_role",
    contScope: "task:speckit:phase-4:code_reviewer",
    s,
    c,
    dieFn: (msg) => {
      diedMessage = msg;
    },
  });

  assert.equal(stopped, true, "Should return true indicating brief exceeded cap");
  assert.ok(diedMessage, "dieFn should be called");
  assert.ok(
    diedMessage.includes(
      "SpecKit code review: the brief alone is 286K tokens, above the fake_role cap 250K — a new session cannot make progress. Shrink the brief or raise caps.fake_role.max_tokens."
    ),
    `Expected escalation message but got: ${diedMessage}`
  );
  assert.ok(diedMessage.includes("STOP — human intervention required."), "Should include STOP marker");
  assert.ok(
    diedMessage.includes("Resume: ap reset --scope task:speckit:phase-4:code_reviewer then ap run"),
    "Should include Resume hint"
  );
  assert.equal(s.phase, "escalated", "State phase should be escalated");
  assert.equal(s.lastContinuation?.scope, "task:speckit:phase-4:code_reviewer");
  console.log("PASS: fake role first turn exceeding cap escalates with required message");
}

// Test 2: Role capped after several turns (turns > 1) still continues (does NOT escalate)
{
  let diedMessage = null;
  const s = { phase: "implementing" };
  const c = { policy: { caps: { code_reviewer: { max_tokens: 250000, wrap_up_at_tokens: 225000 } } } };
  const result = {
    capped: { type: "tokens", used: 240000, limit: 225000 },
    usage: { turns: 5, maxSingleTurnContext: 240000 },
  };

  const stopped = stopIfBriefExceedsCap({
    result,
    subject: "Code review",
    role: "code_reviewer",
    contScope: "task:standalone:phase-0:code_reviewer",
    s,
    c,
    dieFn: (msg) => {
      diedMessage = msg;
    },
  });

  assert.equal(stopped, false, "Should return false when turns > 1");
  assert.equal(diedMessage, null, "dieFn should NOT be called when turns > 1");
  assert.equal(s.phase, "implementing", "State phase should NOT be escalated");
  console.log("PASS: role capped after several turns (turns > 1) continues as today");
}

// Test 3: First turn capped on turns limit with small context does NOT escalate
{
  let diedMessage = null;
  const s = { phase: "implementing" };
  const c = { policy: { caps: { planner: { max_turns: 30, max_tokens: 200000, wrap_up_at_tokens: 180000 } } } };
  const result = {
    capped: { type: "turns", used: 1, limit: 1 },
    usage: { turns: 1, maxSingleTurnContext: 5000 },
  };

  const stopped = stopIfBriefExceedsCap({
    result,
    subject: "Planner",
    role: "planner",
    contScope: "task:standalone:planning:planner",
    s,
    c,
    dieFn: (msg) => {
      diedMessage = msg;
    },
  });

  assert.equal(stopped, false, "Should return false when first turn context is small");
  assert.equal(diedMessage, null, "dieFn should NOT be called");
  console.log("PASS: first turn with small context does not escalate");
}

// Test 4: First turn exceeding wrap-up limit even if below max_tokens
{
  let diedMessage = null;
  const s = { phase: "implementing" };
  const c = { policy: { caps: { implementer: { max_tokens: 200000, wrap_up_at_tokens: 180000 } } } };
  const result = {
    capped: { type: "tokens", used: 185000, limit: 180000 },
    usage: { turns: 1, maxSingleTurnContext: 185000 },
  };

  const stopped = stopIfBriefExceedsCap({
    result,
    subject: "Standalone task T1",
    role: "implementer",
    contScope: "task:standalone:phase-0:T1",
    s,
    c,
    dieFn: (msg) => {
      diedMessage = msg;
    },
  });

  assert.equal(stopped, true, "Should return true when exceeding wrap-up limit at turn 1");
  assert.ok(diedMessage.includes("Standalone task T1: the brief alone is 185K tokens, above the implementer cap 200K"));
  console.log("PASS: first turn exceeding wrap-up limit escalates");
}

// Test 5: Custom role with explicit cap
{
  let diedMessage = null;
  const s = { phase: "implementing" };
  const c = { policy: { caps: { custom_worker: { max_tokens: 300000, wrap_up_at_tokens: 280000 } } } };
  const result = {
    capped: { type: "tokens", used: 310000, limit: 300000 },
    usage: { turns: 1, maxSingleTurnContext: 310000 },
  };

  const stopped = stopIfBriefExceedsCap({
    result,
    subject: "Custom task",
    role: "custom_worker",
    contScope: "task:custom:1",
    s,
    c,
    dieFn: (msg) => {
      diedMessage = msg;
    },
  });

  assert.equal(stopped, true);
  assert.ok(diedMessage.includes("Custom task: the brief alone is 310K tokens, above the custom_worker cap 300K"));
  console.log("PASS: custom role with explicit cap reports cap");
}

// Test 6: Default fallback when role limits are default
{
  let diedMessage = null;
  const s = { phase: "implementing" };
  const result = {
    capped: { type: "tokens", used: 215000, limit: 200000 },
    usage: { turns: 1, maxSingleTurnContext: 215000 },
  };

  const stopped = stopIfBriefExceedsCap({
    result,
    subject: "Default task",
    role: "worker",
    contScope: "task:default:1",
    s,
    c: {},
    dieFn: (msg) => {
      diedMessage = msg;
    },
  });

  assert.equal(stopped, true);
  assert.ok(diedMessage.includes("Default task: the brief alone is 215K tokens, above the worker cap 200K"));
  console.log("PASS: default fallback role reports default 200K cap");
}

console.log("All stop-capped-first-turn tests PASSED!");
