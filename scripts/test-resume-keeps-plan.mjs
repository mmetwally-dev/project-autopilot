#!/usr/bin/env node
// Test resumeStageFor helper and run-dispatch wiring (backlog #4).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resumeStageFor } from "./skill-copy.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// a. {command:{name:"plan",stopAfter:"planning"}, phase:"planning"} + no request/stage -> "planning"
{
  const state = { command: { name: "plan", stopAfter: "planning" }, phase: "planning" };
  const resEmpty = resumeStageFor(state, {});
  check("a1: plan + planning with empty args -> planning", resEmpty === "planning", resEmpty);
  const resNoArgs = resumeStageFor(state);
  check("a2: plan + planning with no options object -> planning", resNoArgs === "planning", resNoArgs);
  const resNullStageBlankReq = resumeStageFor(state, { request: "", stage: null });
  check("a3: plan + planning with blank request and null stage -> planning", resNullStageBlankReq === "planning", resNullStageBlankReq);
}

// b. same with phase "escalated", step "planning-write-boundary-violation" -> "planning"
{
  const state = { command: { name: "plan", stopAfter: "planning" }, phase: "escalated", step: "planning-write-boundary-violation" };
  const res = resumeStageFor(state, {});
  check("b: plan + escalated with planning step -> planning", res === "planning", res);
}

// c. same state but request "new work" -> null; stage "implement" -> null
{
  const state = { command: { name: "plan", stopAfter: "planning" }, phase: "planning" };
  const resReq = resumeStageFor(state, { request: "new work" });
  check("c1: request 'new work' -> null", resReq === null, resReq);
  const resStage = resumeStageFor(state, { stage: "implement" });
  check("c2: stage 'implement' -> null", resStage === null, resStage);
}

// d. command {name:"run",stopAfter:null}, phase "planning" -> null
{
  const state = { command: { name: "run", stopAfter: null }, phase: "planning" };
  const res = resumeStageFor(state, {});
  check("d: run command with planning phase -> null", res === null, res);
}

// e. command plan but phase "tasks_ready" (planning finished) -> null; phase "implementing" -> null; phase "escalated" with step "implement" -> null
{
  const sTasksReady = { command: { name: "plan", stopAfter: "planning" }, phase: "tasks_ready" };
  const resTasksReady = resumeStageFor(sTasksReady, {});
  check("e1: phase tasks_ready -> null", resTasksReady === null, resTasksReady);

  const sImplementing = { command: { name: "plan", stopAfter: "planning" }, phase: "implementing" };
  const resImplementing = resumeStageFor(sImplementing, {});
  check("e2: phase implementing -> null", resImplementing === null, resImplementing);

  const sEscalatedImpl = { command: { name: "plan", stopAfter: "planning" }, phase: "escalated", step: "implement" };
  const resEscalatedImpl = resumeStageFor(sEscalatedImpl, {});
  check("e3: phase escalated with step implement -> null", resEscalatedImpl === null, resEscalatedImpl);
}

// f. state with no command field -> null
{
  const sNoCmd = { phase: "planning" };
  const resNoCmd = resumeStageFor(sNoCmd, {});
  check("f1: state with no command field -> null", resNoCmd === null, resNoCmd);

  const resNull = resumeStageFor(null, {});
  check("f2: null state -> null", resNull === null, resNull);
}

// g. source check: scripts/autopilot.mjs contains `activeStage=parsed.stage??resumeStage??null` and the "Resuming as `ap plan`" line.
{
  const autopilotSrc = fs.readFileSync(path.join(__dirname, "autopilot.mjs"), "utf8");
  const hasActiveStage = autopilotSrc.includes("activeStage=parsed.stage??resumeStage??null");
  check("g1: scripts/autopilot.mjs contains activeStage=parsed.stage??resumeStage??null", hasActiveStage, hasActiveStage);
  const logMsg = "Resuming as `ap plan` (this mission was started with ap plan; it stops after planning). To implement, run `ap run` again once planning is done.";
  const hasLog = autopilotSrc.includes(logMsg);
  check("g2: scripts/autopilot.mjs contains Resuming as `ap plan` log", hasLog, hasLog);
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All resume-keeps-plan checks passed.");

