#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntimeResult } from "./agent-contract.mjs";
import { failure } from "./failure-contract.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`PASS ${name}`);
    return true;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
};

const baseInvocation = {
  requested: { model: "m", reasoning: "high", variant: null },
  args: ["run"],
  cliAccepted: true
};

// 1. Capped run: signal SIGKILL, status null, capped set
// Must produce processStatus "capped", and failure must not be PROCESS_EXIT_NONZERO (null).
{
  const res = buildRuntimeResult({
    roleName: "planner",
    role: { model: "m", adapter: "antigravity" },
    adapterId: "antigravity",
    adapter: { binary: "agy" },
    processResult: { status: null, signal: "SIGKILL" },
    output: "partial output",
    invocation: baseInvocation,
    startedAt: "2026-11-04T00:00:00Z",
    finishedAt: "2026-11-04T00:01:00Z",
    sessionId: "sid-1",
    touchedFiles: [],
    policy: { violation: null },
    failure: failure("PROCESS_EXIT_NONZERO", "adapter", true),
    capped: { type: "turns", used: 31, limit: 30 }
  });

  check(
    "capped run: processStatus is capped",
    res.processStatus === "capped",
    res.processStatus
  );
  check(
    "capped run: failure is null (no PROCESS_EXIT_NONZERO attached)",
    res.failure === null,
    res.failure
  );
}

// 1b. Capped run with a real failure (e.g. RATE_LIMITED) preserves the failure
{
  const rateLimitFailure = failure("RATE_LIMITED", "infrastructure", false);
  const res = buildRuntimeResult({
    roleName: "planner",
    role: { model: "m", adapter: "antigravity" },
    adapterId: "antigravity",
    adapter: { binary: "agy" },
    processResult: { status: null, signal: "SIGKILL" },
    output: "",
    invocation: baseInvocation,
    startedAt: "2026-11-04T00:00:00Z",
    finishedAt: "2026-11-04T00:01:00Z",
    sessionId: "sid-1",
    touchedFiles: [],
    policy: { violation: null },
    failure: rateLimitFailure,
    capped: { type: "turns", used: 31, limit: 30 }
  });

  check(
    "capped run: real failure class preserved",
    res.failure?.class === "RATE_LIMITED",
    res.failure?.class
  );
  check(
    "capped run with real failure: processStatus is capped",
    res.processStatus === "capped",
    res.processStatus
  );
}

// 2. Never-started process: status null, signal null, no events/observations
// Must produce processStatus "failed_start"
{
  const res = buildRuntimeResult({
    roleName: "planner",
    role: { model: "m", adapter: "antigravity" },
    adapterId: "antigravity",
    adapter: { binary: "agy" },
    processResult: { status: null, signal: null, error: new Error("spawn ENOENT") },
    output: "",
    invocation: baseInvocation,
    startedAt: "2026-11-04T00:00:00Z",
    finishedAt: "2026-11-04T00:00:01Z",
    sessionId: null,
    touchedFiles: [],
    policy: { violation: null },
    failure: failure("PROCESS_START_FAILED", "adapter", true),
    observations: []
  });

  check(
    "never-started process: processStatus is failed_start",
    res.processStatus === "failed_start",
    res.processStatus
  );
}

// 3. Non-cap SIGKILL: status null, signal SIGKILL, capped not set
// Must produce processStatus "failed" (not failed_start!)
{
  const res = buildRuntimeResult({
    roleName: "planner",
    role: { model: "m", adapter: "antigravity" },
    adapterId: "antigravity",
    adapter: { binary: "agy" },
    processResult: { status: null, signal: "SIGKILL" },
    output: "some output",
    invocation: baseInvocation,
    startedAt: "2026-11-04T00:00:00Z",
    finishedAt: "2026-11-04T00:00:05Z",
    sessionId: "sid-2",
    touchedFiles: [],
    policy: { violation: null },
    failure: failure("PROCESS_EXIT_NONZERO", "adapter", true)
  });

  check(
    "non-cap SIGKILL: processStatus is failed",
    res.processStatus === "failed",
    res.processStatus
  );
}

// 4. Exit 0: status 0, signal null
// Must produce processStatus "completed"
{
  const res = buildRuntimeResult({
    roleName: "planner",
    role: { model: "m", adapter: "antigravity" },
    adapterId: "antigravity",
    adapter: { binary: "agy" },
    processResult: { status: 0, signal: null },
    output: "all done",
    invocation: baseInvocation,
    startedAt: "2026-11-04T00:00:00Z",
    finishedAt: "2026-11-04T00:00:10Z",
    sessionId: "sid-3",
    touchedFiles: [],
    policy: { violation: null },
    failure: null
  });

  check(
    "exit 0: processStatus is completed",
    res.processStatus === "completed",
    res.processStatus
  );
}

if (failures > 0) {
  console.error(`FAILED (${failures} failure(s))`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
