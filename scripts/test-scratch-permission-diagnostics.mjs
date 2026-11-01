#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {classifyLiveRunFailure, isLiveRunSkip} from "./live-run-diagnostics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

// quota text -> skip
{
  const r = classifyLiveRunFailure("AI_APICallError: Free usage limit reached");
  check("quota text => skip", r.skip === true, r);
  check("quota text => reason present", typeof r.reason === "string" && r.reason.length > 0, r);
}
// provider.no-route -> skip
{
  const r = classifyLiveRunFailure("Model unavailable: deepseek/deepseek-flash (provider.no-route)");
  check("provider.no-route => skip", r.skip === true, r);
}
// ECONNRESET -> skip
{
  const r = classifyLiveRunFailure("fetch failed: ECONNRESET");
  check("ECONNRESET => skip", r.skip === true, r);
}
// unrelated -> fail (not skip)
{
  const r = classifyLiveRunFailure("SyntaxError in autopilot.mjs");
  check("unrelated SyntaxError => not skip", r.skip === false, r);
  check("unrelated => reason null", r.reason === null, r);
}

// additional provider-side cases
check("Model unavailable alone => skip", classifyLiveRunFailure("Model unavailable").skip === true);
check("Unexpected server error => skip", classifyLiveRunFailure("Unexpected server error").skip === true);
check("ETIMEDOUT => skip", classifyLiveRunFailure("ETIMEDOUT").skip === true);
check("fetch failed => skip", classifyLiveRunFailure("fetch failed").skip === true);
check("IDLE_HANG kill => skip", classifyLiveRunFailure("IDLE_HANG: planner produced no output, ran no command and wrote no file for 15 min").skip === true);
check("mere watchdog mention => not skip", classifyLiveRunFailure("the idle-hang watchdog was armed").skip === false);
check("IDLE_HANG (max silence) => skip", classifyLiveRunFailure("IDLE_HANG (max silence): no progress for 30 min").skip === true);

// empty => not skip
check("empty => not skip", classifyLiveRunFailure("").skip === false);
check("null => not skip", classifyLiveRunFailure(null).skip === false);

// object input
check("object with stderr ECONNRESET => skip", classifyLiveRunFailure({stderr: "ECONNRESET"}).skip === true);
check("object with progress log => skip", classifyLiveRunFailure({progress: "provider.no-route"}).skip === true);

// isLiveRunSkip helper
check("isLiveRunSkip quota", isLiveRunSkip("Free usage limit reached") === true);
check("isLiveRunSkip unrelated", isLiveRunSkip("SyntaxError in autopilot.mjs") === false);

// mutation-ish: classifier must not always return same value
check("not constant true", classifyLiveRunFailure("SyntaxError in autopilot.mjs").skip !== classifyLiveRunFailure("ECONNRESET").skip);

// static wiring
const scratchSource = fs.readFileSync(path.join(here, "test-opencode-scratch-permission.mjs"), "utf8");
check("scratch imports classifier module", scratchSource.includes("live-run-diagnostics.mjs"), "missing import");

if (failures) {
  console.error(`${failures} diagnostic check(s) failed.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
