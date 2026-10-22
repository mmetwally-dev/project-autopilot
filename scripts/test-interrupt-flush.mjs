#!/usr/bin/env node
import fs from "node:fs";

// Backlog 003#31: a killed mission must flush final run/report state.
// autopilot.mjs runs main() on import, so this is a static wiring test
// (same pattern as test-adapter-transport / test-transport-authority):
// the SIGTERM/SIGINT flush is installed once, marks the tracked active run
// INTERRUPTED, refreshes the watch report, then re-raises the signal with
// default disposition. Flush-primitive behavior itself is covered by
// test-run-recovery.mjs (markInterrupted idempotency).
let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

check("SIGTERM flush installed", /process\.on\(\s*"SIGTERM"/.test(src));
check("SIGINT flush installed", /process\.on\(\s*"SIGINT"/.test(src));
check("flush installed once (install guard)", /interruptFlushInstalled/.test(src));
check("flush marks the tracked run interrupted", /markInterrupted\(activeRunDir/.test(src));
check("flush refreshes the watch report", /refreshWatchReport\(activeRelayState\)/.test(src));
check("flush is one-shot then re-raises with default disposition",
  /removeListener\(\s*"SIGTERM"[^]*process\.kill\(process\.pid,\s*signal\)/.test(src));
check("markInterrupted imported from run-recovery", /markInterrupted/.test(src) && /from\s+"\.\/run-recovery\.mjs"/.test(src));
check("active run dir tracked in runRelay", /activeRunDir\s*=\s*dir/.test(src));
check("active relay state tracked in runRelay", /activeRelayState\s*=\s*s/.test(src));
check("exactly one process.on('exit') hook that only refreshes",
  (src.match(/process\.on\s*\(\s*["']exit["']/g) || []).length === 1 && /process\.on\s*\(\s*["']exit["']\s*,\s*\(\s*\)\s*=>\s*\{\s*if\s*\(\s*activeRelayState\s*\)\s*refreshWatchReport\s*\(\s*activeRelayState\s*\)\s*;\s*\}\s*\)/.test(src));

if (failures) {
  console.error(`${failures} interrupt-flush check(s) failed.`);
  process.exit(1);
}
console.log("interrupt flush tests passed");
