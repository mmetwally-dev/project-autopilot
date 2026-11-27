#!/usr/bin/env node
// Backlog rv #5 tests: capped opencode run ending on step_start never leaks raw
// NDJSON into finalMessage, earlier text part is preserved, claude result event
// still wins, and sentinels appearing only in raw output are still detected.
import fs from "node:fs";
import {
  adapterDriver,
  finalAgentText,
  finalVerdictPrinted,
} from "./adapter-drivers.mjs";
import { parseReviewContract } from "./failure-contract.mjs";
import { parseTaskResultContract } from "./task-result-contract.mjs";

let passed = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) {
    console.log(`PASS ${name}`);
    passed += 1;
    return;
  }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

const opencode = adapterDriver("opencode");
const claude = adapterDriver("claude");

// ── 1. Captured opencode stream ending on step_start with NO text part → "" ──
{
  const rawStream = [
    JSON.stringify({ type: "step_start", timestamp: 1763720001000, sessionID: "ses_164", part: { id: "p1", type: "step-start" } }),
    JSON.stringify({ type: "tool_use", timestamp: 1763720002000, sessionID: "ses_164", part: { id: "p2", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "workflow.ts" } } } }),
    JSON.stringify({ type: "step_start", timestamp: 1763720003000, sessionID: "ses_164", part: { id: "p3", type: "step-start" } }),
  ].join("\n");
  const events = opencode.decodeEvents(rawStream, "");
  check("opencode stream ending on step_start decoded 3 events", events.length === 3, events.length);
  check("finalAgentText(events, rawStream) returns '' (never raw NDJSON step_start)",
    finalAgentText(events, rawStream) === "",
    finalAgentText(events, rawStream));
  check("finalAgentText(events, '') returns ''",
    finalAgentText(events, "") === "",
    finalAgentText(events, ""));
  // Even if events were empty and fallback was raw NDJSON, never return raw NDJSON
  check("finalAgentText([], rawStream) returns '' (never raw NDJSON)",
    finalAgentText([], rawStream) === "",
    finalAgentText([], rawStream));
}

// ── 2. Opencode stream with an earlier text part followed by step_start → that text ──
{
  const rawStream = [
    JSON.stringify({ type: "step_start", timestamp: 1763720001000, sessionID: "ses_165" }),
    JSON.stringify({ type: "text", timestamp: 1763720002000, sessionID: "ses_165", part: { id: "t1", type: "text", text: "First interim update" } }),
    JSON.stringify({ type: "text", timestamp: 1763720003000, sessionID: "ses_165", part: { id: "t2", type: "text", text: "Finished editing precheck.ts; running tests next." } }),
    JSON.stringify({ type: "step_start", timestamp: 1763720004000, sessionID: "ses_165" }),
  ].join("\n");
  const events = opencode.decodeEvents(rawStream, "");
  check("opencode stream with earlier text part returns the last decoded text part",
    finalAgentText(events, rawStream) === "Finished editing precheck.ts; running tests next.",
    finalAgentText(events, rawStream));
}

// ── 3. Claude terminal result event still wins over earlier assistant text ──
{
  const rawStream = [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Interim assistant text" }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: "Authoritative final claude result" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Later non-result text" }] } }),
  ].join("\n");
  const events = claude.decodeEvents(rawStream, "");
  check("claude result event still wins over assistant text blocks",
    finalAgentText(events, rawStream) === "Authoritative final claude result",
    finalAgentText(events, rawStream));
}

// ── 4. Sentinel only in raw output is still detected & preserved through fallback ──
{
  const rawTaskSentinel = 'AUTOPILOT_TASK_RESULT={"summary":"done","taskLocalCheck":{"command":"npm test","status":"passed","exitCode":0,"summary":"ok"}}';
  const rawReviewSentinel = 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}';

  check("events [] + plain AUTOPILOT_TASK_RESULT fallback returned unchanged",
    finalAgentText([], rawTaskSentinel) === rawTaskSentinel,
    finalAgentText([], rawTaskSentinel));

  const mixedStream = [
    JSON.stringify({ type: "step_start", timestamp: 1763720001000, sessionID: "ses_166" }),
    JSON.stringify({ type: "tool_use", timestamp: 1763720002000, sessionID: "ses_166", part: { id: "p1", type: "tool", tool: "read", state: { status: "completed" } } }),
    rawTaskSentinel,
    JSON.stringify({ type: "step_start", timestamp: 1763720003000, sessionID: "ses_166" }),
  ].join("\n");
  const mixedEvents = opencode.decodeEvents(mixedStream, "");
  const mixedOut = finalAgentText(mixedEvents, mixedStream);
  check("NDJSON lines + plain sentinel line (no text events) returns only the sentinel line",
    mixedOut === rawTaskSentinel,
    mixedOut);
  check("parseTaskResultContract parses sentinel extracted from mixed NDJSON fallback",
    parseTaskResultContract(mixedOut).ok === true);

  check("finalVerdictPrinted detects AUTOPILOT_TASK_RESULT when only in raw output",
    finalVerdictPrinted([], rawTaskSentinel) === true);
  check("finalVerdictPrinted detects AUTOPILOT_REVIEW when only in raw output",
    finalVerdictPrinted([], rawReviewSentinel) === true);
  check("parseTaskResultContract parses raw AUTOPILOT_TASK_RESULT",
    parseTaskResultContract(rawTaskSentinel).ok === true);
  check("parseReviewContract parses raw AUTOPILOT_REVIEW when normalizedOutput is empty",
    parseReviewContract("" || rawReviewSentinel).verdict?.decision === "PASS");
}

// ── 5. Wiring in scripts/autopilot.mjs ──
{
  const autoSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  check("autopilot.mjs passes raw out as fallback to finalAgentText for driver adapters",
    autoSrc.includes("const normalizedOutput=driver?finalAgentText(events,out):out;"));
  check("autopilot.mjs still writes raw output to stdout.log",
    autoSrc.includes('write(path.join(dir,"stdout.log"),out);'));
  check("autopilot.mjs parseReviewContract falls back to raw out when normalizedOutput is empty",
    autoSrc.includes("const reviewContract=review?parseReviewContract(normalizedOutput||out):null;"));
  check("autopilot.mjs finalVerdictPrinted still receives raw capStdout",
    autoSrc.includes("if(finalVerdictPrinted(capEvents,capStdout)) return;"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("backlog #5 capped finalMessage tests passed");
