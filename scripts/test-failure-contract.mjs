import assert from "node:assert/strict";
import fs from "node:fs";
import {AUTO_REJECT_WARNING_TYPE, classifyLinkedResult, classifyObservedFailure, reclassifySilentOpenCodeFailure, failure, parseReviewContract, recordFailureBudget, selectAttemptFailure, shouldRefusePassForLinkedResults} from "./failure-contract.mjs";
import {validateTaskResult} from "./role-progress-commit.mjs";
import {decidePlanningReview} from "./planning-review-decision.mjs";
import {decideEscalationName} from "./escalation-naming.mjs";

const missing = parseReviewContract("review completed without a sentinel");
assert.equal(missing.contract.status, "invalid");
assert.equal(missing.verdict.status, "unavailable");
assert.equal(missing.failure.domain, "adapter");
assert.equal(missing.failure.class, "STRUCTURED_OUTPUT_MISSING");
assert.equal(missing.failure.retryable, true);

const valid = parseReviewContract('noise\nAUTOPILOT_REVIEW={"decision":"PASS","findings":[]}');
assert.equal(valid.contract.status, "valid");
assert.equal(valid.verdict.decision, "PASS");

// Complete sentinel decision table — recognition is anchored to complete
// response records on the final non-empty line of result.response.
const invalidClass = result => {
  assert.equal(result.contract.status, "invalid");
  assert.equal(result.verdict.status, "unavailable");
  assert.equal(result.failure.class, "STRUCTURED_OUTPUT_INVALID");
  assert.equal(result.failure.domain, "adapter");
  assert.equal(result.failure.retryable, true);
  return result;
};
const sentinel = 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":["x"]}';
const malformed = parseReviewContract("AUTOPILOT_REVIEW={\"decision\":");
invalidClass(malformed);
assert.equal(parseReviewContract("AUTOPILOT_REVIEW=[1,2").failure.class, "STRUCTURED_OUTPUT_INVALID"); // unbalanced JSON
invalidClass(parseReviewContract('AUTOPILOT_REVIEW={"decision":"MAYBE","findings":[]}')); // wrong decision value
invalidClass(parseReviewContract('AUTOPILOT_REVIEW={"decision":"PASS"}')); // findings not an array
invalidClass(parseReviewContract(`${sentinel}\nAUTOPILOT_REVIEW={"decision":"PASS","findings":[]}`)); // >1 marker
invalidClass(parseReviewContract(`AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}\ntrailing response content`)); // not final line
invalidClass(parseReviewContract(`${sentinel} and then some`)); // object does not consume the line
assert.equal(parseReviewContract(`noise\n${sentinel}\n`).contract.status, "valid"); // trailing whitespace only is fine
// Prose echoes and occurrences inside JSON finding strings never count as markers.
assert.equal(parseReviewContract(`The agent wrote: AUTOPILOT_REVIEW is required.\n${sentinel}`).contract.status, "valid");
assert.equal(parseReviewContract(`   ${sentinel}`).contract.status, "valid"); // leading whitespace allowed
assert.equal(parseReviewContract(sentinel.replace("findings\":[\"x\"]", "findings\":[\"AUTOPILOT_REVIEW=\\\"\"]")).contract.status, "valid");
assert.equal(parseReviewContract("").failure.class, "STRUCTURED_OUTPUT_MISSING");
assert.equal(parseReviewContract(null).failure.class, "STRUCTURED_OUTPUT_MISSING");
assert.equal(parseReviewContract("").failure.domain, "adapter");
assert.equal(parseReviewContract("").failure.retryable, true);
assert.equal(parseReviewContract(null).failure.retryable, true);
// Line-80 path: balanced object consuming the line but not valid JSON.
invalidClass(parseReviewContract('AUTOPILOT_REVIEW={invalid}'));
// Unbalanced/truncated marker line is also retryable adapter INVALID.
{
  const unbalanced = parseReviewContract("AUTOPILOT_REVIEW=[1,2");
  assert.equal(unbalanced.failure.domain, "adapter");
  assert.equal(unbalanced.failure.retryable, true);
}
// Phase 5 integration smoke: the six parseReviewContract() failure paths,
// each pinned to its failure-contract.mjs line and expected class, plus a
// valid anchored record on the final line as the passing control. Every
// failure path must produce a retryable adapter-domain failure.
{
  const checkRetryableAdapter = (result, expectedClass) => {
    assert.equal(result.contract.status, "invalid");
    assert.equal(result.verdict.status, "unavailable");
    assert.equal(result.failure.class, expectedClass);
    assert.equal(result.failure.domain, "adapter");
    assert.equal(result.failure.retryable, true);
  };
  // Line 37 STRUCTURED_OUTPUT_MISSING: no marker line at all — including a
  // marker embedded mid-line in prose, which matches zero records.
  checkRetryableAdapter(parseReviewContract("review completed without a sentinel"), "STRUCTURED_OUTPUT_MISSING");
  checkRetryableAdapter(
    parseReviewContract('prose AUTOPILOT_REVIEW={"decision":"PASS","findings":[]} more prose'),
    "STRUCTURED_OUTPUT_MISSING"
  );
  // Line 39 STRUCTURED_OUTPUT_INVALID: marker line with unbalanced/truncated JSON.
  checkRetryableAdapter(parseReviewContract('AUTOPILOT_REVIEW={"decision":'), "STRUCTURED_OUTPUT_INVALID");
  // Line 40 STRUCTURED_OUTPUT_INVALID: two complete sentinels on different lines.
  checkRetryableAdapter(
    parseReviewContract(`${sentinel}\nAUTOPILOT_REVIEW={"decision":"PASS","findings":[]}`),
    "STRUCTURED_OUTPUT_INVALID"
  );
  // Line 47 STRUCTURED_OUTPUT_INVALID: one valid record followed by trailing non-empty text.
  checkRetryableAdapter(
    parseReviewContract('AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}\ntrailing response content'),
    "STRUCTURED_OUTPUT_INVALID"
  );
  // Line 51 STRUCTURED_OUTPUT_INVALID: complete record with a non-PASS/FAIL
  // decision or non-array findings.
  checkRetryableAdapter(parseReviewContract('AUTOPILOT_REVIEW={"decision":"MAYBE","findings":[]}'), "STRUCTURED_OUTPUT_INVALID");
  checkRetryableAdapter(parseReviewContract('AUTOPILOT_REVIEW={"decision":"PASS"}'), "STRUCTURED_OUTPUT_INVALID");
  // Line 80 STRUCTURED_OUTPUT_INVALID: complete record with unparsable JSON.
  checkRetryableAdapter(parseReviewContract("AUTOPILOT_REVIEW={invalid}"), "STRUCTURED_OUTPUT_INVALID");
  // Passing control: valid anchored record on the final line.
  const control = parseReviewContract('noise\nAUTOPILOT_REVIEW={"decision":"PASS","findings":[]}');
  assert.equal(control.contract.status, "valid");
  assert.equal(control.verdict.decision, "PASS");
  assert.equal(control.failure, null);
}

// Phase 5 budget-exhaustion proof: STRUCTURED_OUTPUT_MISSING exhausts the
// adapter retry budget, then decidePlanningReview escalates with honest
// budget-exhaustion naming.
{
  const budgetState = {};
  const budgetPolicy = {failure_budgets: {adapterRetryBudget: 2}};
  const observedFailure = parseReviewContract("").failure;
  assert.equal(observedFailure.class, "STRUCTURED_OUTPUT_MISSING");
  assert.equal(observedFailure.retryable, true);
  recordFailureBudget(budgetState, budgetPolicy, observedFailure, "planning_review");
  const exhausted = recordFailureBudget(budgetState, budgetPolicy, observedFailure, "planning_review");
  const decision = decidePlanningReview({failure: observedFailure, budget: exhausted, scope: "planning_review"});
  assert.equal(decision.action, "escalate");
  assert.equal(decision.code, "PLANNING_REVIEW_BUDGET_EXHAUSTED");
  const naming = decideEscalationName({failureClass: "STRUCTURED_OUTPUT_MISSING", retryable: true, used: 2, limit: 2, budget: "adapterRetryBudget"});
  assert.equal(naming.step, "adapterRetryBudget_exhausted");
  assert.equal(naming.detail, "adapterRetryBudget exhausted (2/2)");
}


const permission = classifyObservedFailure({exitCode: 1, stdout: "", stderr: "MCP permission denied", evidence: [{type: "permission_denied"}]});
assert.equal(permission.domain, "adapter");
assert.equal(permission.class, "PERMISSION_DENIED");
assert.equal(permission.retryable, false);

// Policy/read-only violations are non-retryable (policy domain).
for (const [violation, expectedClass] of [
  ["read_only_violation", "READ_ONLY_VIOLATION"],
  ["git_mutation_blocked", "GIT_MUTATION_BLOCKED"],
  ["git_commit_detected", "GIT_COMMIT_DETECTED"],
]) {
  const policyViolationFailure = classifyObservedFailure({policyViolation: violation, evidence: []});
  assert.equal(policyViolationFailure.class, expectedClass);
  assert.equal(policyViolationFailure.domain, "policy");
  assert.equal(policyViolationFailure.retryable, false);
}
const timeout = classifyObservedFailure({exitCode: null, timedOut: true});
assert.equal(timeout.domain, "infrastructure");
// Precedence correction: timeout now outranks structured evidence, not the
// other way around. A killed-mid-run process's collected evidence is
// inherently partial/unreliable — trusting a "permission denied" conclusion
// from data a timeout may have truncated is exactly the kind of misplaced
// authority this whole classifier rewrite removes elsewhere (Mission 001
// runs 27-28). Timeout is the more certain, authoritative signal.
const timeoutBeforePermission = classifyObservedFailure({exitCode: null, timedOut: true, evidence: [{type: "permission_denied"}]});
assert.equal(timeoutBeforePermission.class, "TIMEOUT");
assert.equal(timeoutBeforePermission.domain, "infrastructure");

const verification = failure("VERIFICATION_REJECTED", "verification", true);
assert.equal(selectAttemptFailure({results: [{failure: verification}, {failure: permission}]}), permission, "adapter failure must not be charged to verification");
const state = {};
const policy = {failure_budgets: {implementationFailureBudget: 3, verificationFailureBudget: 2, adapterRetryBudget: 2, infrastructureRetryBudget: 4}};
const firstVerification = recordFailureBudget(state, policy, verification, "task:1");
assert.equal(firstVerification.allowed, true);
const secondVerification = recordFailureBudget(state, policy, verification, "task:1");
assert.equal(secondVerification.allowed, false);
const adapterBudget = recordFailureBudget(state, policy, failure("PROCESS_EXIT_NONZERO", "adapter", true), "adapter:codex:verifier");
assert.equal(adapterBudget.used, 1);
assert.equal(state.failureBudgets["verificationFailureBudget:task:1"], 2);
assert.equal(state.failureBudgets["adapterRetryBudget:adapter:codex:verifier"], 1);

// Legacy Run-27 replay (Mission 001): a PERMISSION_DENIED failure evidenced
// ONLY by file_read_* observations sitting on a genuinely completed,
// policy-clean result is stale noise, not a failure. Paired with a
// reclassified Run-28 RATE_LIMITED sibling, the stale adapter-domain failure
// must not win by domain priority and escalate the mission.
const legacyRun27 = {
  role: "implementer", status: "completed", policy: {violation: null},
  failure: failure("PERMISSION_DENIED", "adapter", false, [
    {type: "file_read_attempted", source: "cli_event"},
    {type: "file_read_observed", source: "cli_event"}
  ])
};
const reclassifiedRun28 = {
  role: "code_reviewer", status: "failed", policy: {violation: null},
  failure: failure("RATE_LIMITED", "infrastructure", true, [{type: "rate_limited"}])
};
assert.equal(selectAttemptFailure({results: [legacyRun27]}), null, "legacy Run-27-shaped failure alone selects nothing");
assert.equal(selectAttemptFailure({results: [legacyRun27, reclassifiedRun28]}).class, "RATE_LIMITED", "reclassified Run 28 wins over legacy Run 27");
// A reviewer FAIL verdict on a completed result still survives (its findings
// are plain strings, exempt by class, not by evidence type).
const reviewerFailOnCompleted = {
  role: "code_reviewer", status: "completed", policy: {violation: null},
  failure: failure("IMPLEMENTATION_REJECTED", "implementation", true, ["something is wrong"])
};
assert.equal(selectAttemptFailure({results: [reviewerFailOnCompleted]}).class, "IMPLEMENTATION_REJECTED", "reviewer FAIL verdict survives on completed");
// A trusted structured failure on a completed result still survives.
const trustedOnCompleted = {
  role: "implementer", status: "completed", policy: {violation: null},
  failure: failure("PERMISSION_DENIED", "adapter", false, [{type: "permission_denied"}])
};
assert.equal(selectAttemptFailure({results: [trustedOnCompleted]}).class, "PERMISSION_DENIED", "trusted structured failure survives on completed");

// Nonzero-exit stderr text fallback applies to registered adapters too
// (stdout is never scanned for any adapter).
const registeredStderrPath = classifyObservedFailure({exitCode: 2, stdout: "", stderr: "cat: x: No such file or directory", evidence: [], driverless: false});
assert.equal(registeredStderrPath.class, "PATH_UNSUPPORTED");
assert.equal(registeredStderrPath.retryable, false);
const registeredStderrServer = classifyObservedFailure({exitCode: 1, stdout: "", stderr: "connect ECONNREFUSED 127.0.0.1:443", evidence: [], driverless: false});
assert.equal(registeredStderrServer.class, "SERVER_UNAVAILABLE");
assert.equal(registeredStderrServer.retryable, true);
const registeredStdoutPath = classifyObservedFailure({exitCode: 2, stdout: "cat: x: No such file or directory", stderr: "", evidence: [], driverless: false});
assert.equal(registeredStdoutPath.class, "PROCESS_EXIT_NONZERO", "stdout path text never classifies, even for registered adapters");
// Structured events take precedence over stderr text: the Run-28 shape.
const structuredBeatsText = classifyObservedFailure({exitCode: 1, stdout: "", stderr: "cat: x: No such file or directory", evidence: [{type: "rate_limited"}], driverless: false});
assert.equal(structuredBeatsText.class, "RATE_LIMITED");
assert.equal(classifyObservedFailure({evidence:[{type:'rate_limited'}]}).retryable, false);
// RATE_LIMITED never consumes the infrastructure budget: recording one
// returns allowed:false and leaves the budget key unset.
{
  const rlState = {};
  const rlPolicy = {failure_budgets: {infrastructureRetryBudget: 2}};
  const rlFailure = classifyObservedFailure({evidence: [{type: 'rate_limited'}]});
  assert.equal(rlFailure.class, "RATE_LIMITED");
  const rlRecorded = recordFailureBudget(rlState, rlPolicy, rlFailure, "mission");
  assert.equal(rlRecorded.allowed, false);
  assert.equal(rlState.failureBudgets?.['infrastructureRetryBudget:mission'], undefined);
}
// Fallback evidence text is bounded so transcripts never accumulate in state.
const longStderr = `cat: ${"y".repeat(2000)}: No such file or directory`;
const boundedFallback = classifyObservedFailure({exitCode: 2, stdout: "", stderr: longStderr, evidence: [], driverless: false});
const fallbackEntry = boundedFallback.evidence.find(e => e?.source === "stderr_text_fallback");
assert.ok(fallbackEntry.text.length <= 501, `fallback snippet bounded, got ${fallbackEntry.text.length}`);

// Backlog #41 (TASK-35): the idle-hang watchdog's class. A session the
// watchdog kills is a retryable infrastructure failure like TIMEOUT, so it
// consumes infrastructureRetryBudget through the normal path.
{
  const idle = failure("IDLE_HANG", "infrastructure", true, [{source: "relay", message: "IDLE_HANG: implementer (opencode, m) produced no output, ran no command and wrote no file for 10 min"}]);
  assert.equal(idle.class, "IDLE_HANG");
  assert.equal(idle.domain, "infrastructure");
  assert.equal(idle.retryable, true);
  const budgetState = {};
  const budgetPolicy = {failure_budgets: {infrastructureRetryBudget: 2}};
  assert.equal(recordFailureBudget(budgetState, budgetPolicy, idle, "task:idle").allowed, true);
  assert.equal(recordFailureBudget(budgetState, budgetPolicy, idle, "task:idle").allowed, false);
  assert.equal(budgetState.failureBudgets["infrastructureRetryBudget:task:idle"], 2);
}

// Mission 022 phase 2 task 2.2: the Phase 2.1 non-terminal out-of-sandbox
// auto-reject warning stays out of the PERMISSION_DENIED classification and
// surfaces to the retry prompt instead.
assert.equal(AUTO_REJECT_WARNING_TYPE, "out_of_sandbox_auto_reject_warning");
{
  const warningEvidence = [{type: AUTO_REJECT_WARNING_TYPE, tool: "write", path: "/tmp/outside.txt"}];
  // Warning-only observation on a clean exit: no failure at all — the relay
  // mapping then falls through to the missing-sentinel retryable path.
  assert.equal(
    classifyObservedFailure({exitCode: 0, stdout: "", stderr: "", evidence: warningEvidence}),
    null,
    "warning-only clean exit classifies to null"
  );
  const missingSentinel = parseReviewContract("");
  assert.equal(missingSentinel.failure.class, "STRUCTURED_OUTPUT_MISSING");
  assert.equal(missingSentinel.failure.retryable, true);
  // Nonzero exit whose stderr carries the engine auto-reject line plus only
  // the warning observation: never PERMISSION_DENIED (generic retryable).
  const autoRejectStderr = "permission requested: external_directory (/tmp/outside.txt); auto-rejecting";
  const warned = classifyObservedFailure({exitCode: 1, stdout: "", stderr: autoRejectStderr, evidence: warningEvidence});
  assert.notEqual(warned.class, "PERMISSION_DENIED", "auto-reject stderr never classifies PERMISSION_DENIED");
  assert.equal(warned.class, "PROCESS_EXIT_NONZERO");
  assert.equal(warned.retryable, true);
  // A warning alongside genuine permission_denied structured evidence still
  // classifies PERMISSION_DENIED non-retryable — the guard skips only the
  // stderr text fallback, never the structured branch.
  const genuine = classifyObservedFailure({exitCode: 1, stdout: "", stderr: autoRejectStderr, evidence: [...warningEvidence, {type: "permission_denied"}]});
  assert.equal(genuine.class, "PERMISSION_DENIED");
  assert.equal(genuine.retryable, false);
}
// Retry-prompt + relay-path source probes: the warning observation text
// reaches the relay() prompt at the buildTaskPrompt/taskRetryFindings/
// resumeNote assembly in both loops, and both loops funnel through the
// shared runRelay() -> classifyObservedFailure() call site.
{
  const autopilotSource = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  // Helper definition renders warning observations (tool + path/command)
  // into a bounded retry note; the warning type constant matches the
  // failure-contract export above.
  assert.ok(autopilotSource.includes("function autoRejectRetryNote("), "autoRejectRetryNote helper defined");
  assert.ok(autopilotSource.includes("OUT_OF_SANDBOX_AUTO_REJECT_WARNING_TYPE"), "warning type constant present");
  assert.ok(autopilotSource.includes("out_of_sandbox_auto_reject_warning"), "warning type value present");
  assert.ok(autopilotSource.includes("observation?.type!==OUT_OF_SANDBOX_AUTO_REJECT_WARNING_TYPE"), "helper reads warning observations");
  // Both per-task relay("implementer", ...) prompt assemblies (standalone +
  // speckit) append the warning note to the
  // buildTaskPrompt/taskRetryFindings/resumeNote assembly.
  const relayPromptSites = autopilotSource.split("\n").filter(line => line.includes('relay("implementer",') && line.includes("autoRejectNote"));
  assert.equal(relayPromptSites.length, 2, `both loops surface autoRejectNote to the relay prompt, got ${relayPromptSites.length}`);
  for (const site of relayPromptSites) {
    assert.ok(site.includes("${promptBuilt.text}${taskRetryFindings}${resumeNote}${autoRejectNote}"), "warning note appended to the relay prompt");
  }
  // Shared funnel: standalone implementer/code_reviewer/verifier relays and
  // speckit verifier relays go through relayAsync -> runRelay, and runRelay
  // classifies via classifyObservedFailure.
  assert.ok(autopilotSource.includes("async function relayAsync(roleName"), "relayAsync defined");
  assert.ok(autopilotSource.includes("return runRelay(roleName,task,"), "relayAsync funnels through runRelay");
  assert.ok(autopilotSource.includes('relayAsync("implementer",'), "implementer relays via relayAsync");
  assert.ok(autopilotSource.includes('relayAsync("verifier",'), "verifier relays via relayAsync");
  assert.ok(/const observedFailure=reclassifySilentOpenCodeFailure\(classifyObservedFailure\(/.test(autopilotSource), "runRelay classifies via classifyObservedFailure and the opencode silent-limit guard");
  // failure-contract.mjs keeps the guard: warning type export plus the
  // stderr-pattern skip in the permission text fallback.
  const contractSource = fs.readFileSync(new URL("./failure-contract.mjs", import.meta.url), "utf8");
  assert.ok(contractSource.includes("AUTO_REJECT_WARNING_TYPE"), "warning type export present");
  assert.ok(contractSource.includes("autoRejectStderrPattern"), "auto-reject stderr pattern present");
  assert.ok(contractSource.includes("isAutoRejectStderr"), "stderr fallback guard present");
}
// Mission 022 part 1 phase 3.2: terminal write/edit denial versus missing
// sentinel. A terminal write/edit denial observed set (blocked vocabulary
// plus permission_denied from the observer's terminalDenial() path) must
// classify PERMISSION_DENIED non-retryable — never STRUCTURED_OUTPUT_MISSING
// — while a clean exit with no denial and no sentinel still takes the
// missing-sentinel path (observed null + STRUCTURED_OUTPUT_MISSING).
{
  const writeDenial = classifyObservedFailure({exitCode: 1, stdout: "", stderr: "", evidence: [{type: "write_attempted"}, {type: "write_blocked"}, {type: "permission_denied"}]});
  assert.equal(writeDenial.class, "PERMISSION_DENIED");
  assert.equal(writeDenial.domain, "adapter");
  assert.equal(writeDenial.retryable, false);
  assert.notEqual(writeDenial.class, "STRUCTURED_OUTPUT_MISSING");
  const editDenial = classifyObservedFailure({exitCode: 1, stdout: "", stderr: "", evidence: [{type: "write_attempted", tool: "edit"}, {type: "write_blocked", tool: "edit"}, {type: "permission_denied", tool: "edit"}]});
  assert.equal(editDenial.class, "PERMISSION_DENIED");
  assert.equal(editDenial.domain, "adapter");
  assert.equal(editDenial.retryable, false);
  assert.notEqual(editDenial.class, "STRUCTURED_OUTPUT_MISSING");
  // The relay mapping layers content failure separately: a denied run's
  // observed PERMISSION_DENIED wins even when the sentinel is also missing.
  const relayDenied = writeDenial || parseReviewContract("").failure;
  assert.equal(relayDenied.class, "PERMISSION_DENIED");
  // Clean exit with no denial and no sentinel: no observed process failure,
  // so the relay falls through to the retryable missing-sentinel path.
  const cleanObserved = classifyObservedFailure({exitCode: 0, stdout: "", stderr: "", evidence: [{type: "write_attempted"}]});
  assert.equal(cleanObserved, null);
  const cleanMissing = parseReviewContract("");
  assert.equal(cleanMissing.failure.class, "STRUCTURED_OUTPUT_MISSING");
  assert.equal(cleanMissing.failure.retryable, true);
  const relayClean = cleanObserved || cleanMissing.failure;
  assert.equal(relayClean.class, "STRUCTURED_OUTPUT_MISSING");
}
// Mission 025 task 1.2 (backlog #28, .autopilot/tasks/backlog.md:686-699):
// normalized PASS-refusal predicate. The mission-023 fixture — three parallel
// linked integration tests killed by timeout (exit 124) under `timeout 420`
// with a PASS verdict — is now REFUSED: exit 124, timedOut, or a signal
// classifies as the "timed-out" reason and any other non-zero exit as the
// "failed" reason. Refusal triggers when status is not 0 (including null) or
// when a signal or timedOut is present.
{
  const fixtureUrl = new URL("./test-fixtures/mission-023-pass-on-124.json", import.meta.url);
  const fixture = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
  assert.equal(fixture.verdict.decision, "PASS");
  assert.equal(fixture.linkedResults.length, 3);
  for (const result of fixture.linkedResults) {
    assert.equal(result.status, 124);
    assert.equal(result.exitCode, 124);
  }
  // The fixture's three 124s refuse PASS with the timed-out reason.
  const fixtureRefusal = shouldRefusePassForLinkedResults(fixture.linkedResults);
  assert.equal(fixtureRefusal?.refuse, true);
  assert.equal(fixtureRefusal.reason, "timed-out");
  assert.equal(fixtureRefusal.index, 0);
  // Any other non-zero exit refuses with the failed reason.
  const nonZero = shouldRefusePassForLinkedResults([{command: "node scripts/x.mjs", status: 1, exitCode: 1, signal: null, timedOut: false}]);
  assert.equal(nonZero?.refuse, true);
  assert.equal(nonZero.reason, "failed");
  // A timedOut flag refuses with the timed-out reason even when the code is 0/null.
  const timedOut = shouldRefusePassForLinkedResults([{command: "node scripts/y.mjs", status: null, exitCode: null, signal: null, timedOut: true}]);
  assert.equal(timedOut?.refuse, true);
  assert.equal(timedOut.reason, "timed-out");
  // Status null with a kill signal refuses with the timed-out reason.
  const killed = shouldRefusePassForLinkedResults([{command: "node scripts/z.mjs", status: null, exitCode: null, signal: "SIGTERM", timedOut: false}]);
  assert.equal(killed?.refuse, true);
  assert.equal(killed.reason, "timed-out");
  // Per-record predicate agrees on each input class.
  assert.equal(classifyLinkedResult({status: 124, exitCode: 124, signal: null, timedOut: false}).reason, "timed-out");
  assert.equal(classifyLinkedResult({status: 2, exitCode: 2, signal: null, timedOut: false}).reason, "failed");
  assert.equal(classifyLinkedResult({status: null, exitCode: null, signal: null, timedOut: true}).reason, "timed-out");
  assert.equal(classifyLinkedResult({status: null, exitCode: null, signal: "SIGKILL", timedOut: false}).reason, "timed-out");
  assert.equal(classifyLinkedResult({status: 1, exitCode: 1, signal: null, timedOut: false}).reason, "failed");
  // Conflicting exit fields: no field wins — any present 124/non-zero refuses.
  assert.equal(classifyLinkedResult({status: 0, exitCode: 124, signal: null, timedOut: false}).reason, "timed-out");
  assert.equal(classifyLinkedResult({status: 124, exitCode: 0, signal: null, timedOut: false}).reason, "timed-out");
  assert.equal(shouldRefusePassForLinkedResults([{command: "node scripts/conflict.mjs", status: 0, exitCode: 124, signal: null, timedOut: false}]).reason, "timed-out");
  // Status null with no signal and no timeout still refuses (status is not 0),
  // classified as failed — there is no timeout evidence.
  assert.equal(classifyLinkedResult({status: null, exitCode: null, signal: null, timedOut: false}).reason, "failed");
  // Clean results accept PASS: null refusal for a lone clean record, for all
  // clean, and for empty/missing input.
  assert.equal(classifyLinkedResult({status: 0, exitCode: 0, signal: null, timedOut: false}), null);
  assert.equal(shouldRefusePassForLinkedResults([{status: 0, signal: null, timedOut: false}]), null);
  assert.equal(shouldRefusePassForLinkedResults([]), null);
  assert.equal(shouldRefusePassForLinkedResults(null), null);
  // First failing record wins and carries its command.
  const mixed = shouldRefusePassForLinkedResults([
    {command: "node scripts/ok.mjs", status: 0, signal: null, timedOut: false},
    {command: "node scripts/bad.mjs", status: 3, exitCode: 3, signal: null, timedOut: false},
  ]);
  assert.equal(mixed?.refuse, true);
  assert.equal(mixed.reason, "failed");
  assert.equal(mixed.index, 1);
  assert.equal(mixed.command, "node scripts/bad.mjs");
  console.log("mission-023 repro: three linked results exit 124 with a PASS verdict — refused (timed-out)");
}
// Mission 031 phase 3 task 3.2: INCOMPLETE is a valid review decision
// alongside PASS/FAIL, and the read-only commit check allows it.
{
  const incomplete = parseReviewContract('AUTOPILOT_REVIEW={"decision":"INCOMPLETE","findings":["still checking"]}');
  assert.equal(incomplete.contract.status, "valid");
  assert.equal(incomplete.verdict.status, "available");
  assert.equal(incomplete.verdict.decision, "INCOMPLETE");
  assert.deepEqual(incomplete.verdict.findings, ["still checking"]);
  assert.equal(incomplete.failure, null);
  // PASS/FAIL still valid; MAYBE still invalid (pinned above, re-asserted here).
  assert.equal(parseReviewContract('AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}').verdict.decision, "PASS");
  assert.equal(parseReviewContract('AUTOPILOT_REVIEW={"decision":"FAIL","findings":["x"]}').verdict.decision, "FAIL");
  assert.equal(parseReviewContract('AUTOPILOT_REVIEW={"decision":"MAYBE","findings":[]}').contract.status, "invalid");
  // Read-only commit check allows INCOMPLETE for codeReviewer/verifier roles.
  const expected = {role: "codeReviewer", runId: "run-1", revision: 1, phaseTaskDigest: "digest", deltaDigest: "delta", taskId: "t1"};
  const base = {role: "codeReviewer", runId: "run-1", revision: 1, phaseTaskDigest: "digest", deltaDigest: "delta", taskId: "t1", status: "completed", facts: {summary: "reviewed t1"}};
  assert.equal(validateTaskResult(expected, {...base, decision: "INCOMPLETE"}).ok, true);
  assert.equal(validateTaskResult(expected, {...base, decision: "PASS"}).ok, true);
  assert.equal(validateTaskResult(expected, {...base, decision: "FAIL"}).ok, true);
  assert.equal(validateTaskResult(expected, {...base, decision: "MAYBE"}).ok, false);
  assert.equal(validateTaskResult(expected, {...base, decision: undefined}).ok, false);
  console.log("incomplete decision: parseReviewContract accepts INCOMPLETE and read-only commit check allows it");
}
// Backlog #42: an opencode nonzero exit with no answer — or limit text in its
// own stderr — is a provider limit, not an adapter crash.
{
  const crashed = failure("PROCESS_EXIT_NONZERO", "adapter", true, [{source: "relay"}]);
  const silent = reclassifySilentOpenCodeFailure(crashed, {adapter: "opencode", output: "", stderr: ""});
  assert.equal(silent.class, "RATE_LIMITED");
  assert.equal(silent.domain, "infrastructure");
  assert.equal(silent.retryable, false);
  assert.equal(silent.evidence.at(-1).source, "opencode_silent_provider_limit");
  assert.equal(silent.evidence.at(-1).noOutput, true);
  const quota = reclassifySilentOpenCodeFailure(crashed, {adapter: "opencode", output: "", stderr: "ERROR 429 too many requests"});
  assert.equal(quota.class, "RATE_LIMITED");
  assert.equal(quota.evidence.at(-1).limitText, true);
  assert.equal(reclassifySilentOpenCodeFailure(crashed, {adapter: "opencode", output: "partial answer", stderr: "Error: config invalid"}).class, "PROCESS_EXIT_NONZERO");
  assert.equal(reclassifySilentOpenCodeFailure(crashed, {adapter: "claude", output: "", stderr: ""}).class, "PROCESS_EXIT_NONZERO");
  assert.equal(reclassifySilentOpenCodeFailure(null, {adapter: "opencode", output: ""}), null);
  console.log("opencode silent provider limit: reclassified RATE_LIMITED, real crashes untouched");
}
console.log("failure taxonomy, unavailable verdict, and separate budget tests passed");
