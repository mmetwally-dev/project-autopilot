// Runs the REAL gates() from autopilot.mjs for the app_server tests. The
// working directory is the throwaway repo; argv[2] is a JSON file with the
// runtime config ({gates:{...}}). Prints the gate result as one RESULT: line.
import fs from "node:fs";
import {gatesForTests} from "../autopilot.mjs";

const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const result = await gatesForTests(cfg, {phaseIndex: 0});
console.log("RESULT:" + JSON.stringify({ok: result.ok, command: result.command, reason: result.reason, tail: result.tail, logFile: result.logFile}));
process.exit(0);
