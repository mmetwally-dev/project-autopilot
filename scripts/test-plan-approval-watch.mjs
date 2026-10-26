#!/usr/bin/env node
// Mission 099 — watch report visibility for the plan-approval pause.
import { buildReportModel, classifyStatus } from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const AT = "2026-10-19T10:00:00+00:00";
const EXPECTED_STOP = "AWAITING PLAN APPROVAL at 2026-10-19 10:00:00 — run `ap run` to approve and continue";

// ── 3.1: paused status wins before owner liveness ───────────────────────────
{
  const paused = classifyStatus({ phase: "plan_approval", step: "approve_plan", planApproval: { status: "awaiting", at: AT } });
  check("paused: status PAUSED", paused.status === "PAUSED", paused);
  check("paused: timestamp from planApproval.at", paused.at === AT, paused.at);
  check("paused: stop line", paused.stopLine === EXPECTED_STOP, paused.stopLine);

  const withOwner = classifyStatus(
    { phase: "plan_approval", planApproval: { status: "awaiting", at: AT } },
    { ownerAlive: true },
  );
  check("paused: owner liveness does not override", withOwner.status === "PAUSED", withOwner.status);

  const noAt = classifyStatus({ phase: "plan_approval", planApproval: { status: "awaiting" } });
  check("paused: no timestamp still pauses", noAt.status === "PAUSED" && noAt.at === null, noAt);
  check("paused: stop line without timestamp", noAt.stopLine === "AWAITING PLAN APPROVAL — run `ap run` to approve and continue", noAt.stopLine);

  const model = buildReportModel({ state: { phase: "plan_approval", planApproval: { status: "awaiting", at: AT } }, runs: [], events: [], phases: [], policy: {}, now: AT });
  check("paused: report model status", model.status === "PAUSED", model.status);
  check("paused: report model stop line", model.stopLine === EXPECTED_STOP, model.stopLine);
  check("paused: report model stage PLANNING", model.stage === "PLANNING", model.stage);
}

// ── 3.1: other statuses unchanged ───────────────────────────────────────────
{
  check("running: implementing stays RUNNING", classifyStatus({ phase: "implementing" }, { ownerAlive: true }).status === "RUNNING");
  const stopped = classifyStatus({ phase: "implementing" }, { ownerAlive: false });
  check("stopped: owner gone stays STOPPED", stopped.status === "STOPPED" && stopped.orchestratorNotRunning === true, stopped);
  check("complete: stays COMPLETED", classifyStatus({ phase: "complete" }).status === "COMPLETED");
  check("idle: stays STOPPED", classifyStatus({ phase: "idle" }).status === "STOPPED");
  check("escalated: stays ESCALATED", classifyStatus({ phase: "escalated" }).status === "ESCALATED");
  const cancelled = classifyStatus({ phase: "cancelled", lastCancelled: { at: AT, reason: "operator" } });
  check("cancelled: stays CANCELLED", cancelled.status === "CANCELLED" && cancelled.stopLine.includes("CANCELLED at 2026-10-19 10:00:00"), cancelled);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall plan-approval watch checks passed");
