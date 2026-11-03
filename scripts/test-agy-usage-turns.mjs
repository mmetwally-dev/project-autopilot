import assert from "node:assert/strict";
import {decodeAgyEvents, accumulateAgyUsage} from "./agy-events.mjs";
import {accumulateUsage} from "./adapter-drivers.mjs";

const CID = "00000000-0000-0000-0000-000000000001";
const initLine = JSON.stringify({
  event: "init",
  conversation_id: CID,
  init: {cwd: "/generic/repo", tools: ["run_command", "write_to_file", "view_file"], permission_mode: "request-review"}
});
const userInput = cid => JSON.stringify({
  event: "step_update",
  step_update: {conversation_id: cid, step_index: 0, state: "DONE", step_type: "user_input"}
});
const agentResponse = (cid, index, usage, state = "DONE") => JSON.stringify({
  event: "step_update",
  step_update: {conversation_id: cid, step_index: index, state, step_type: "agent_response", text_delta: "step done\n", duration_seconds: 1, usage}
});
const toolStep = (cid, index, tool_name) => JSON.stringify({
  event: "step_update",
  step_update: {conversation_id: cid, step_index: index, state: "DONE", step_type: "tool", tool_name, tool_info: {name: tool_name}}
});
const resultLine = (cid, result) => JSON.stringify({event: "result", result: {conversation_id: cid, ...result}});

const STEP_USAGE = {input_tokens: 100, output_tokens: 10, thinking_tokens: 2, cache_read_tokens: 20, total_tokens: 132};

// ── Test 1: N=5 agent_response steps + terminal result num_turns 1 → turns 5; token totals unchanged
{
  const lines = [
    initLine,
    userInput(CID),
    agentResponse(CID, 1, STEP_USAGE),
    toolStep(CID, 2, "view_file"),
    agentResponse(CID, 3, STEP_USAGE),
    toolStep(CID, 4, "run_command"),
    agentResponse(CID, 5, STEP_USAGE),
    toolStep(CID, 6, "run_command"),
    agentResponse(CID, 7, STEP_USAGE),
    toolStep(CID, 8, "write_to_file"),
    agentResponse(CID, 9, STEP_USAGE),
    resultLine(CID, {
      status: "SUCCESS",
      response: "finished task\n",
      duration_seconds: 15,
      num_turns: 1,
      usage: {input_tokens: 2500, output_tokens: 120, thinking_tokens: 30, cache_read_tokens: 450, total_tokens: 3100}
    })
  ];

  const events = decodeAgyEvents(lines.join("\n"), "");
  const usage = accumulateAgyUsage(events);
  assert.ok(usage !== null, "accumulateAgyUsage must return non-null usage object");
  assert.equal(usage.turns, 5, `turns must be 5 from distinct agent_response steps, got ${usage.turns}`);
  assert.equal(usage.input, 2500, `token input must remain cumulative terminal input (2500), got ${usage.input}`);
  assert.equal(usage.output, 150, `token output must fold output_tokens + thinking_tokens (120+30=150), got ${usage.output}`);
  assert.equal(usage.cacheRead, 450, `token cacheRead must remain cumulative terminal cache_read_tokens (450), got ${usage.cacheRead}`);
  assert.equal(usage.cacheCreation, 0, `token cacheCreation must be 0, got ${usage.cacheCreation}`);

  // Also verify driver dispatch through accumulateUsage
  const driverUsage = accumulateUsage("antigravity", events);
  assert.deepEqual(driverUsage, usage, "accumulateUsage('antigravity', events) must match accumulateAgyUsage");
}

// ── Test 2: no steps + num_turns 3 → turns 3; token totals unchanged
{
  const lines = [
    initLine,
    userInput(CID),
    resultLine(CID, {
      status: "SUCCESS",
      response: "completed without model steps\n",
      duration_seconds: 5,
      num_turns: 3,
      usage: {input_tokens: 3000, output_tokens: 200, thinking_tokens: 40, cache_read_tokens: 600, total_tokens: 3840}
    })
  ];

  const events = decodeAgyEvents(lines.join("\n"), "");
  const usage = accumulateAgyUsage(events);
  assert.ok(usage !== null, "accumulateAgyUsage must return non-null usage object when terminal usage is present");
  assert.equal(usage.turns, 3, `turns must be 3 from terminal num_turns when no steps were seen, got ${usage.turns}`);
  assert.equal(usage.input, 3000, `token input must match terminal usage input (3000), got ${usage.input}`);
  assert.equal(usage.output, 240, `token output must match terminal usage output (200+40=240), got ${usage.output}`);
  assert.equal(usage.cacheRead, 600, `token cacheRead must match terminal usage cacheRead (600), got ${usage.cacheRead}`);
  assert.equal(usage.cacheCreation, 0, `token cacheCreation must be 0, got ${usage.cacheCreation}`);

  const driverUsage = accumulateUsage("antigravity", events);
  assert.deepEqual(driverUsage, usage, "accumulateUsage('antigravity', events) must match accumulateAgyUsage");
}

console.log("test-agy-usage-turns: ALL CHECKS PASSED");
