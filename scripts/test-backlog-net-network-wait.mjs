#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyObservedFailure,
  recordFailureBudget,
  NETWORK_UNAVAILABLE_PATTERNS,
  PROVIDER_NETWORK_PATTERNS,
  ERRNO_NETWORK_PATTERNS,
} from "./failure-contract.mjs";
import {
  waitForNetworkRecovery,
  applyNetworkWaitExhaustedEvidence,
  __networkWaitHooks,
  NETWORK_WAIT_BACKOFF_SECONDS,
  DEFAULT_NETWORK_WAIT_MINUTES,
} from "./network-wait.mjs";
import { decideEscalationName } from "./escalation-naming.mjs";
import { resolvePlanningReviewAttempt, escalateIfRateLimited } from "./planning-review-wiring.mjs";
import { DEFAULTS } from "./config-layout.mjs";
import { validateNewConfig } from "./config-validation.mjs";
import { appendWatchEvent } from "./watch-events.mjs";
import { buildReportModel, renderReport } from "./watch-report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function check(label, condition, detail) {
  assert.ok(condition, detail ? `${label}: ${JSON.stringify(detail)}` : label);
  console.log(`PASS ${label}`);
}

// ── 1. Classify two real adapter network failures (claude EAI_AGAIN, codex routing) ─
// Inline fixtures: the exact lines the adapters printed.
{
  const c59 = classifyObservedFailure({
    exitCode: 1,
    status: "failed",
    stdout: '{"type":"system","subtype":"api_retry","attempt":10}\n{"type":"result","is_error":true,"result":"API Error: Can\'t reach the API server — check your internet or DNS (EAI_AGAIN)"}\n',
    stderr: "",
    output: "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)",
    adapter: "claude",
    driverless: false,
    evidence: [],
  });
  check("run59 (claude EAI_AGAIN) -> NETWORK_UNAVAILABLE", c59?.class === "NETWORK_UNAVAILABLE", c59);
  check("run59 domain is infrastructure", c59?.domain === "infrastructure", c59);
  check("run59 retryable is false", c59?.retryable === false, c59);

  const c60 = classifyObservedFailure({
    exitCode: 1,
    status: "failed",
    stdout: [1, 2, 3, 4, 5].map((n) => `{"type":"error","message":"Reconnecting... ${n}/5 (workspace routing discovery failed)"}`).join("\n") + "\n",
    stderr: "",
    output: "WARNING: proceeding, even though we could not create PATH aliases",
    adapter: "codex",
    driverless: false,
    evidence: [],
  });
  check("run60 (codex routing discovery failed) -> NETWORK_UNAVAILABLE", c60?.class === "NETWORK_UNAVAILABLE", c60);
  check("run60 domain is infrastructure", c60?.domain === "infrastructure", c60);
  check("run60 retryable is false", c60?.retryable === false, c60);
}

// ── 2. All adapters & exported pattern lists + false-positive/regression pins ─
{
  check("PROVIDER_NETWORK_PATTERNS exported", Array.isArray(PROVIDER_NETWORK_PATTERNS) && PROVIDER_NETWORK_PATTERNS.length === 4);
  check("ERRNO_NETWORK_PATTERNS exported", Array.isArray(ERRNO_NETWORK_PATTERNS) && ERRNO_NETWORK_PATTERNS.length === 7);
  check("NETWORK_UNAVAILABLE_PATTERNS is exported concatenation",
    Array.isArray(NETWORK_UNAVAILABLE_PATTERNS) &&
    NETWORK_UNAVAILABLE_PATTERNS.length === PROVIDER_NETWORK_PATTERNS.length + ERRNO_NETWORK_PATTERNS.length);

  const samples = [
    "getaddrinfo EAI_AGAIN api.anthropic.com",
    "getaddrinfo ENOTFOUND api.openai.com",
    "connect ECONNREFUSED 104.18.0.1:443",
    "read ECONNRESET",
    "connect ETIMEDOUT 104.18.0.1:443",
    "API Error: Can't reach the API server",
    "Please check your internet or DNS settings",
    "Reconnecting... 5/5 (workspace routing discovery failed)",
    "stream disconnected before completion",
    "error sending request for url (https://chatgpt.com/backend-api/ps/mcp)",
    "connect: network is unreachable",
  ];
  for (const adapter of ["claude", "codex", "opencode", "antigravity"]) {
    for (const sample of samples) {
      const f = classifyObservedFailure({
        exitCode: 1,
        status: "failed",
        stdout: "",
        stderr: sample,
        output: "",
        adapter,
        driverless: false,
        evidence: [],
      });
      assert.equal(f?.class, "NETWORK_UNAVAILABLE", `${adapter} should classify "${sample}" as NETWORK_UNAVAILABLE, got ${f?.class}`);
    }
  }
  console.log("PASS all 11 patterns classify as NETWORK_UNAVAILABLE for all 4 adapters");

  // (a) Regression pin: exitCode undefined with permission/invalid-model stderr still classifies as before.
  const undefPerm = classifyObservedFailure({ stderr: "permission denied by policy", evidence: [] });
  check("(a) exitCode undefined + permission stderr -> PERMISSION_DENIED", undefPerm?.class === "PERMISSION_DENIED", undefPerm);
  const undefInvalidModel = classifyObservedFailure({ stderr: "invalid model selection: foo", evidence: [] });
  check("(a) exitCode undefined + invalid model stderr -> INVOCATION_MISMATCH", undefInvalidModel?.class === "INVOCATION_MISMATCH", undefInvalidModel);

  // (b) Failed run whose stdout contains local ECONNREFUSED and "error sending request" but clean stderr/finalMessage -> NOT NETWORK_UNAVAILABLE.
  const stdoutToolLog = classifyObservedFailure({
    exitCode: 1,
    status: "failed",
    stdout: "test log: connect ECONNREFUSED 127.0.0.1:54321\nerror sending request to local mock",
    stderr: "",
    finalMessage: "",
    output: "",
    adapter: "codex",
    driverless: false,
    evidence: [],
  });
  check("(b) failed run with ECONNREFUSED 127.0.0.1 & error sending request only in stdout -> NOT NETWORK_UNAVAILABLE",
    stdoutToolLog?.class === "PROCESS_EXIT_NONZERO", stdoutToolLog);

  // (c) stderr local ECONNREFUSED -> SERVER_UNAVAILABLE; stderr remote EAI_AGAIN -> NETWORK_UNAVAILABLE.
  const localRefused = classifyObservedFailure({
    exitCode: 1,
    status: "failed",
    stdout: "",
    stderr: "connect ECONNREFUSED 127.0.0.1:3000",
    adapter: "claude",
    evidence: [],
  });
  check("(c) stderr connect ECONNREFUSED 127.0.0.1:3000 -> SERVER_UNAVAILABLE",
    localRefused?.class === "SERVER_UNAVAILABLE" && localRefused.retryable === true, localRefused);

  const remoteEai = classifyObservedFailure({
    exitCode: 1,
    status: "failed",
    stdout: "",
    stderr: "getaddrinfo EAI_AGAIN api.anthropic.com",
    adapter: "claude",
    evidence: [],
  });
  check("(c) stderr getaddrinfo EAI_AGAIN api.anthropic.com -> NETWORK_UNAVAILABLE",
    remoteEai?.class === "NETWORK_UNAVAILABLE" && remoteEai.retryable === false, remoteEai);

  // No false positive on successful run mentioning EAI_AGAIN in content.
  const okRun = classifyObservedFailure({
    exitCode: 0,
    status: "completed",
    stdout: "Explaining EAI_AGAIN and workspace routing discovery failed in docs",
    stderr: "ECONNRESET mentioned in test log",
    output: "Handled EAI_AGAIN, ENOTFOUND, and Can't reach the API server",
    finalMessage: "All done; EAI_AGAIN is a DNS retryable error.",
    adapter: "claude",
    driverless: false,
    evidence: [],
  });
  check("successful run mentioning EAI_AGAIN -> null (no false positive)", okRun === null, okRun);
}

// ── 3. Budget untouched ─────────────────────────────────────────────────────
{
  const state = {};
  const policy = { failure_budgets: { adapterRetryBudget: 3, infrastructureRetryBudget: 3 } };
  const netFailure = classifyObservedFailure({
    exitCode: 1,
    status: "failed",
    output: "API Error: Can't reach the API server (EAI_AGAIN)",
    adapter: "claude",
    evidence: [],
  });
  const rec = recordFailureBudget(state, policy, netFailure, "mission");
  check("recordFailureBudget does not allow retry via budget", rec.allowed === false && rec.used === 0, rec);
  check("infrastructureRetryBudget:mission left unset", state.failureBudgets?.["infrastructureRetryBudget:mission"] === undefined, state.failureBudgets);
  check("adapterRetryBudget left unset", Object.keys(state.failureBudgets || {}).length === 0, state.failureBudgets);
}

// ── 4. Wait/backoff schedule, limit, DNS early retry, watch event & report ──
{
  const savedHooks = { ...__networkWaitHooks };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-net-wait-"));
  const missionDir = path.join(tmpDir, ".autopilot", "missions", "009-net-test");
  fs.mkdirSync(missionDir, { recursive: true });

  try {
    let fakeNow = 1_795_000_000_000;
    const sleeps = [];
    let probeShouldPass = false;
    let probeCalls = 0;

    __networkWaitHooks.now = () => fakeNow;
    __networkWaitHooks.sleep = async (ms) => {
      sleeps.push(ms);
      fakeNow += ms;
    };
    __networkWaitHooks.probe = async () => {
      probeCalls += 1;
      return probeShouldPass;
    };

    const config = { advanced: { network_wait_minutes: 60 } };
    const state = { mission: "009-net-test", phase: "planning", step: "plan_review" };
    const netResult = {
      status: "failed",
      role: "plan_reviewer",
      adapter: "claude",
      model: "opus",
      failure: classifyObservedFailure({
        exitCode: 1,
        status: "failed",
        output: "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)",
        adapter: "claude",
        evidence: [],
      }),
    };

    // Capture console.log
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    let waitState = null;
    const stepTotals = [];
    try {
      // Run until limit (60 min) is reached
      for (let i = 0; i < 30; i++) {
        const beforeSleeps = sleeps.length;
        const res = await waitForNetworkRecovery({
          result: netResult,
          config,
          state,
          roleName: "plan_reviewer",
          adapter: "claude",
          model: "opus",
          waitState,
          persistState: false,
          appendWatchEvent,
          missionDir,
        });
        waitState = res.waitState;
        if (res.action === "escalate") {
          check("escalates at 60 min limit", res.maxWaitMin === 60 && res.elapsedMs >= 60 * 60_000, res);
          break;
        }
        assert.equal(res.action, "retry");
        const stepSlept = sleeps.slice(beforeSleeps).reduce((a, b) => a + b, 0);
        stepTotals.push(stepSlept);
      }
    } finally {
      console.log = origLog;
    }

    // Verify backoff schedule: 30s, 60s, 120s, 300s, 300s, ...
    check("backoff starts at 30s, 60s, 120s, 300s",
      stepTotals[0] === 30_000 && stepTotals[1] === 60_000 && stepTotals[2] === 120_000 && stepTotals[3] === 300_000,
      stepTotals.slice(0, 5));
    check("total waited equals 60 minutes (3,600,000 ms)",
      stepTotals.reduce((a, b) => a + b, 0) === 60 * 60_000,
      stepTotals.reduce((a, b) => a + b, 0));
    check("state.networkWait cleaned up after wait", state.networkWait === undefined, state.networkWait);
    check("clear log line printed",
      logs.some((l) => /^network unavailable \(.+EAI_AGAIN.+\) — waiting 30s before retrying plan_reviewer \(0\/60 min\)$/.test(l)),
      logs[0]);
    check("DNS probe was invoked between sleep chunks", probeCalls > 0, probeCalls);

    // Watch events & WATCH-REPORT
    const eventsPath = path.join(missionDir, "watch-events.jsonl");
    const events = fs.readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check("watch-events.jsonl recorded network_wait events",
      events.length > 0 && events[0].type === "operator" && events[0].reason === "network_wait" && events[0].role === "plan_reviewer",
      events[0]);

    const model = buildReportModel({
      state: { ...state, networkWait: { role: "plan_reviewer", elapsedMin: 1, maxWaitMin: 60 } },
      runs: [],
      events,
    });
    const report = renderReport(model);
    check("WATCH-REPORT shows network_wait in Events and active status",
      report.includes("NETWORK WAIT") && report.includes("waiting for network (1/60 min, retrying plan_reviewer)"),
      report.slice(0, 600));

    // (d) Probe always true -> waits the full 300s step (no early retry)
    probeShouldPass = true;
    const alwaysTrueSleeps = [];
    __networkWaitHooks.sleep = async (ms) => {
      alwaysTrueSleeps.push(ms);
      fakeNow += ms;
    };
    __networkWaitHooks.probe = async () => true;
    const fullRes = await waitForNetworkRecovery({
      result: netResult,
      config,
      state,
      roleName: "implementer",
      adapter: "codex",
      waitState: { startedAtMs: fakeNow - 10 * 60_000, attempt: 3 }, // 300s step
      persistState: false,
    });
    check("(d) probe always true waits full 300s step (no early retry)",
      fullRes.action === "retry" && fullRes.early === false && alwaysTrueSleeps.reduce((a, b) => a + b, 0) === 300_000,
      { fullRes, alwaysTrueSleeps });

    // (d) Probe false then true -> early retry on fail->ok transition
    const transitionSleeps = [];
    let transitionCall = 0;
    __networkWaitHooks.sleep = async (ms) => {
      transitionSleeps.push(ms);
      fakeNow += ms;
    };
    __networkWaitHooks.probe = async () => {
      transitionCall += 1;
      return transitionCall >= 2; // 1st probe false, 2nd probe true
    };
    const earlyRes = await waitForNetworkRecovery({
      result: netResult,
      config,
      state,
      roleName: "implementer",
      adapter: "codex",
      waitState: { startedAtMs: fakeNow - 10 * 60_000, attempt: 3 }, // 300s step
      persistState: false,
    });
    check("(d) probe false then true breaks 300s wait early (60s)",
      earlyRes.action === "retry" && earlyRes.early === true && transitionSleeps.length === 2 && transitionSleeps.reduce((a, b) => a + b, 0) === 60_000,
      { earlyRes, transitionSleeps });
  } finally {
    Object.assign(__networkWaitHooks, savedHooks);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 5. Escalation message & resolvePlanningReviewAttempt wiring ─────────────
{
  const savedHooks = { ...__networkWaitHooks };
  try {
    let fakeNow = 1_795_000_000_000;
    __networkWaitHooks.now = () => fakeNow;
    __networkWaitHooks.sleep = async (ms) => { fakeNow += ms; };
    __networkWaitHooks.probe = async () => false;

    const netFailure = classifyObservedFailure({
      exitCode: 1,
      status: "failed",
      output: "workspace routing discovery failed",
      adapter: "codex",
      evidence: [],
    });
    const initial = {
      status: "failed",
      role: "plan_reviewer",
      adapter: "codex",
      model: "gpt-5.6-sol",
      failure: netFailure,
    };

    const state = { mission: "009-net-escalate", phase: "planning", step: "plan_review", failureBudgets: {} };
    let rerunCount = 0;
    let fatalMsg = null;
    await resolvePlanningReviewAttempt(
      { advanced: { network_wait_minutes: 1 }, policy: { failure_budgets: { adapterRetryBudget: 3, infrastructureRetryBudget: 3 } } },
      state,
      "speckit-gate-review",
      initial,
      async () => {
        rerunCount += 1;
        return initial;
      },
      {
        fatal: (m) => { fatalMsg = m; },
        saveState: () => {},
        escalatePrefix: "SpecKit gate review-tasks plan re-review",
      }
    );

    check("resolvePlanningReviewAttempt retried during 1-min window (30s + 30s)", rerunCount === 2, rerunCount);
    check("state.step is network_unavailable_escalation", state.step === "network_unavailable_escalation", state);
    check("escalation message includes 'network unavailable for 1 min:' and 'ap run'",
      typeof fatalMsg === "string" && fatalMsg.includes("network unavailable for 1 min:") && fatalMsg.includes("ap run"),
      fatalMsg);
    check("zero adapter/infra budget spent after escalation",
      Object.keys(state.failureBudgets).length === 0,
      state.failureBudgets);

    // Direct decideEscalationName check
    const exhausted = applyNetworkWaitExhaustedEvidence(initial, 60, "Can't reach the API server (EAI_AGAIN)");
    const naming = decideEscalationName({
      failureClass: "NETWORK_UNAVAILABLE",
      retryable: false,
      used: 0,
      limit: 0,
      budget: null,
      evidence: exhausted.failure.evidence,
    });
    check("decideEscalationName formats network_unavailable_escalation",
      naming.step === "network_unavailable_escalation" &&
      naming.detail.includes("network unavailable for 60 min:") &&
      naming.detail.includes("ap run"),
      naming);

    // escalateIfRateLimited with network_wait_minutes: 0
    const state0 = { phase: "planning", step: "spec" };
    let fatal0 = null;
    const esc0 = escalateIfRateLimited(
      { advanced: { network_wait_minutes: 0 } },
      state0,
      "speckit-gate-review",
      applyNetworkWaitExhaustedEvidence(initial, 0, "EAI_AGAIN"),
      { fatal: (m) => { fatal0 = m; }, saveState: () => {}, escalatePrefix: "SpecKit" }
    );
    check("escalateIfRateLimited handles NETWORK_UNAVAILABLE", esc0 === true && state0.step === "network_unavailable_escalation" && fatal0.includes("network unavailable for 0 min:"), { esc0, state0, fatal0 });
  } finally {
    Object.assign(__networkWaitHooks, savedHooks);
  }
}

// ── 6. Config default, schema, validation, and docs ─────────────────────────
{
  check("DEFAULT_NETWORK_WAIT_MINUTES is 60", DEFAULT_NETWORK_WAIT_MINUTES === 60);
  check("NETWORK_WAIT_BACKOFF_SECONDS starts with 30, 60, 120, 300",
    JSON.stringify(NETWORK_WAIT_BACKOFF_SECONDS) === JSON.stringify([30, 60, 120, 300]),
    NETWORK_WAIT_BACKOFF_SECONDS);
  check("DEFAULTS.advanced.network_wait_minutes === 60",
    DEFAULTS.advanced.network_wait_minutes === 60,
    DEFAULTS.advanced.network_wait_minutes);

  const valid = validateNewConfig({ advanced: { network_wait_minutes: 60 } });
  check("validateNewConfig accepts advanced.network_wait_minutes: 60", valid.errors.length === 0, valid.errors);

  const invalid = validateNewConfig({ advanced: { network_wait_minutes: -5 } });
  check("validateNewConfig rejects negative advanced.network_wait_minutes", invalid.errors.length > 0, invalid.errors);

  const docs = fs.readFileSync(path.join(repoRoot, "docs/configuration.md"), "utf8");
  check("docs/configuration.md documents advanced.network_wait_minutes", docs.includes("advanced.network_wait_minutes"));
}

console.log("test-backlog-net-network-wait: all checks passed");
