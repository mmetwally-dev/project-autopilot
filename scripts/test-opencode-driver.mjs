#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {canonicalJson, capabilityValueIsValid} from "./capability-contract.mjs";
import {adapterDriver, accumulateUsage, USAGE_PRICE_WEIGHTS} from "./adapter-drivers.mjs";
import {resolveAdapterTransport} from "./adapter-transport.mjs";
import {classifyBinary, binaryAdmission} from "./execution-envelope.mjs";
import {validateAdapterContract} from "./agent-contract.mjs";

let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};

// ---- 1. Manifest-wide validation (every adapter, including legacy ones) ----
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(skillRoot, "adapters", "agents.json"), "utf8")).adapters;
for (const [id, adapter] of Object.entries(manifest)) {
  const v = validateAdapterContract(id, adapter);
  check(`manifest-wide contract validation passes for '${id}'`, v.ok);
}
check("opencode is contract v2 with a registered driver",
  manifest.opencode?.contract_version === 2 && manifest.opencode?.driver === "opencode");

// ---- 2. Driver resolution ----
const driver = adapterDriver("opencode");
check("opencode driver is registered at contract version 2",
  driver?.id === "opencode" && driver?.contractVersion === 2);
if (process.platform !== "win32") {
  const symlinkRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "opencode-driver-symlink-"));
  const symlink = path.join(symlinkRoot, "opencode");
  try {
    fs.symlinkSync(process.execPath, symlink);
    check("native launcher symlinks resolve to the executable target used inside the envelope",
      driver.resolveBinary(symlink) === fs.realpathSync(process.execPath));
  } finally {
    fs.rmSync(symlinkRoot, {recursive: true, force: true});
  }
}

check("OpenCode manifest declares the exact release-backed Zen provider destinations",
  canonicalJson([...manifest.opencode.provider_egress.profiles["opencode-zen"].destinations]
    .sort((a, b) => a.host.localeCompare(b.host))) === canonicalJson([
    {host: "models.opencode.ai", port: 443},
    {host: "opencode.ai", port: 443}
  ]));
check("OpenCode home config and auth inputs are declared for narrow read-only mounting",
  canonicalJson(manifest.opencode.permission_files) === canonicalJson([
    "~/.config/opencode/config.json",
    "~/.config/opencode/opencode.json",
    "~/.config/opencode/opencode.jsonc",
    "~/.local/share/opencode/auth.json"
  ]));

// ---- 3. Invocation construction (live-verified flags) ----
const write = driver.buildInvocation({binary: "/usr/bin/env", mode: "write"});
check("write mode: run --format json --auto (permission UX only)",
  canonicalJson(write.args) === canonicalJson(["run", "--print-logs", "--format", "json", "--auto"]));
const plan = driver.buildInvocation({binary: "/usr/bin/env", mode: "read"});
check("read mode: run --format json --agent autopilot_readonly (not native \"plan\": its built-in deny-wins permission model cannot be overridden to allow sanctioned scratch writes)",
  canonicalJson(plan.args) === canonicalJson(["run", "--print-logs", "--format", "json", "--agent", "autopilot_readonly"]));
const selected = driver.buildInvocation({binary: "/usr/bin/env", mode: "scratch", model: "opencode/hy3-free", reasoning: "high", trustedEnvelope: true});
check("scratch+trusted: --auto kept, model/variant selections appended",
  selected.args.includes("--model") && selected.args.includes("opencode/hy3-free")
  && selected.args.includes("--variant") && selected.args.includes("high"));
assert.throws(() => driver.trustedEnvelopeArgs(["--version"]), /requires 'run'/);
check("trusted-envelope mapping validates shape only (no invented sandbox flag)", true);

// ---- 4. Resolver authority: resolver output === builder output, stdin verbatim ----
// Precondition: the bare "opencode" name must resolve on this machine. Where
// it doesn't (e.g. inside a review sandbox without opencode on PATH) the
// resolver correctly fails closed (binary_target_missing → unavailable), so
// asserting availability there would couple the test to ambient PATH. Skip
// instead; the fail-closed path itself is covered by test-binary-
// classification and test-transport-authority.
const admissionProbe = binaryAdmission(classifyBinary(driver.resolveBinary("opencode")));
if (!admissionProbe.admitted) {
  console.log(`SKIP resolver-authority section: 'opencode' is not admittable here (${admissionProbe.detail || admissionProbe.reason}); the fail-closed path is covered by test-binary-classification and test-transport-authority`);
} else for (const request of [
  {binary: "opencode", cwd: "/tmp", scratchDir: null, model: "m1", reasoning: "high", mode: "write", stdin: "prompt-A"},
  {binary: "opencode", cwd: "/workspace/repository", scratchDir: "/workspace/scratch", model: null, reasoning: null, mode: "scratch", trustedEnvelope: true, stdin: ""}
]) {
  const label = `mode=${request.mode}${request.trustedEnvelope ? "+trusted" : ""}`;
  const direct = driver.buildInvocation({...request});
  const resolved = resolveAdapterTransport({driver, profile: null, request});
  check(`${label}: resolver invocation === builder invocation`,
    resolved.available === true && canonicalJson(resolved.invocation) === canonicalJson({binary: direct.binary, args: direct.args.map(String)}));
  check(`${label}: stdin preserved verbatim`, resolved.stdin === (request.stdin ?? ""));
}

// ---- 5. Live event-shape decoder fixtures (captured from native 1.18.22) ----
const fixtures = [
  JSON.stringify({type: "step_start", part: {type: "step-start"}}),
  JSON.stringify({type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"PASS","findings":["x"]}'}}),
  JSON.stringify({type: "tool_use", part: {type: "tool", tool: "bash", state: {status: "completed", input: {command: "exit 3"}, metadata: {output: "", exit: 3}}}}),
  JSON.stringify({type: "tool_use", part: {type: "tool", tool: "read", state: {status: "error", error: "File not found: /tmp/x", input: {filePath: "/tmp/x"}}}}),
  "not-json-noise"
].join("\n");
const events = driver.decodeEvents(fixtures, "");
check("decoder parses NDJSON and preserves noise as unparsed_stdout",
  events.filter(e => e.type === "unparsed_stdout").length === 1 && events.filter(e => e.type === "text").length >= 1);

// ---- 6. Observer semantics over captured shapes ----
const probe = {root: "/repo", productionWritePath: "/repo/production.txt", outsideWritePath: "/outside.txt", timeoutScriptPath: "/repo/t.mjs"};
const toolEvent = (tool, state) => ({type: "tool_use", part: {type: "tool", tool, state}});

// bash exit 0 vs exit 3 through metadata.exit
const successEvents = [toolEvent("bash", {status: "completed", input: {command: "true"}, metadata: {exit: 0}})];
check("successful shell command: command_attempted only",
  JSON.stringify(driver.observe(successEvents, probe).map(o => o.type)) === JSON.stringify(["command_attempted"]));
const failedEvents = [toolEvent("bash", {status: "completed", input: {command: "exit 3"}, metadata: {exit: 3}})];
check("non-zero shell exit surfaces command_failed despite completed status",
  driver.observe(failedEvents, probe).some(o => o.type === "command_failed"));

// read observed carries trusted output; failed read does not
const readObs = driver.observe([toolEvent("read", {status: "completed", input: {filePath: "/repo/in"}, output: "<content>nonce</content>"})], probe);
check("repository read produces attempted+observed with trusted output",
  readObs.some(o => o.type === "file_read_attempted") && readObs.some(o => o.type === "file_read_observed" && String(o.output || "").includes("nonce")));
check("failed read does not emit file_read_observed",
  !driver.observe([toolEvent("read", {status: "error", error: "File not found"})], probe).some(o => o.type === "file_read_observed"));

// writes: production vs outside targeting; blocked vs failed
const writeAttempted = driver.observe([toolEvent("write", {status: "completed", input: {filePath: "/repo/production.txt", content: "x"}})], probe);
check("production write produces write_attempted (+no blocked on success)",
  writeAttempted.some(o => o.type === "write_attempted") && !writeAttempted.some(o => o.type === "write_blocked"));
const outsideDenied = driver.observe([toolEvent("write", {status: "error", error: "permission denied", input: {filePath: "/outside.txt"}})], probe);
check("denied outside write emits attempt+block",
  outsideDenied.some(o => o.type === "outside_write_attempted") && outsideDenied.some(o => o.type === "outside_write_blocked"));
check("non-denied production write failure emits write_failed",
  driver.observe([toolEvent("write", {status: "error", error: "disk full", input: {filePath: "/repo/production.txt"}})], probe).some(o => o.type === "write_failed"));

// git mutation detection + guard-wrapper block markers
const gitEvents = [toolEvent("bash", {status: "completed", input: {command: 'node "/repo/.guard/git-guard.mjs" -C "/repo" commit --allow-empty -m x'}, metadata: {output: "AUTOPILOT GIT GUARD: forbidden", exit: 1}})];
const gitObs = driver.observe(gitEvents, {...probe, gitGuardWrapperPath: "/repo/.guard/git-guard.mjs"});
check("git mutation attempt detected; guard wrapper + marker yields block",
  gitObs.some(o => o.type === "git_mutation_attempted") && gitObs.some(o => o.type === "git_mutation_blocked"));

// timeout child start via script reference
check("timeout script reference marks child start",
  driver.observe([toolEvent("bash", {status: "completed", input: {command: 'node "/repo/t.mjs" a b c'}, metadata: {exit: 0}})], probe).some(o => o.type === "timeout_child_command_started"));

// Revised denial boundary (TASK-18): write/outside_write/git denials map to
// *_blocked, and a TERMINAL bash denial additionally maps to permission_denied.
// The earlier comment here called permission_denied "Codex-specific", which the
// code never enforced — this check only ever asserted write_blocked IS emitted,
// never that permission_denied is absent.
check("denied write maps to blocked vocabulary, never silent success",
  (() => {
    const o = driver.observe([toolEvent("write", {status: "error", error: "not permitted by policy", input: {filePath: "/repo/production.txt"}})], probe);
    return o.some(x => x.type === "write_blocked") && !o.some(x => x.status === undefined && x.type === "write_observed");
  })());

// ---- 6b. Bash denial vocabulary: terminal denials only ----
const deniedBash = {status: "error", error: "The user rejected permission to use this specific tool call.", input: {command: "ls -la /workspace/scratch; cat /proc/self/mountinfo"}};

// Run 26's exact shape: the denied bash call is the last thing in the run.
const run26Observed = driver.observe([toolEvent("bash", deniedBash)], probe);
check("run 26's terminal denied bash call emits permission_denied alongside command_attempted/command_failed",
  run26Observed.some(o => o.type === "permission_denied")
  && run26Observed.some(o => o.type === "command_attempted")
  && run26Observed.some(o => o.type === "command_failed"));

check("a bash failure with no denial-shaped text does not emit permission_denied",
  !driver.observe([toolEvent("bash", {status: "error", error: "exit status 1", input: {command: "false"}})], probe).some(o => o.type === "permission_denied"));

// state.error only — merged output/prose that merely mentions permissions is
// not a denial.
check("permission wording in state.output alone does not emit permission_denied",
  !driver.observe([toolEvent("bash", {status: "error", error: "exit status 1", output: "the fixture documents a permission denied mode", input: {command: "cat doc"}})], probe).some(o => o.type === "permission_denied"));

// Both suppression cases, asserted separately: a denial the role recovered from
// must not be tagged, or it would outrank the role's own verdict.
check("a denial followed by a later successful tool call does not emit permission_denied",
  !driver.observe([
    toolEvent("bash", {...deniedBash, error: "permission denied"}),
    toolEvent("read", {status: "completed", input: {filePath: "/repo/in"}, output: "content"})
  ], probe).some(o => o.type === "permission_denied"));

check("a denial followed by later verdict-bearing agent text does not emit permission_denied",
  !driver.observe([
    toolEvent("bash", {...deniedBash, error: "permission denied"}),
    {type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":["x"]}'}}
  ], probe).some(o => o.type === "permission_denied"));

// Mission 022 phase 2 task 2.3: recovered-denial suppression holds on every
// new strict-denial branch (read, write/edit/patch/multiedit), not just bash
// above — all branches share terminalDenial(), so a denial the role worked
// around stays untagged everywhere.
check("a read denial followed by a later successful tool call does not emit permission_denied",
  (() => {
    const o = driver.observe([
      toolEvent("read", {status: "error", error: "permission denied", input: {filePath: "/repo/in"}}),
      toolEvent("read", {status: "completed", input: {filePath: "/repo/in"}, output: "content"})
    ], probe);
    return o.some(x => x.type === "file_read_attempted") && !o.some(x => x.type === "permission_denied");
  })());

check("a read denial followed by later verdict-bearing agent text does not emit permission_denied",
  !driver.observe([
    toolEvent("read", {status: "error", error: "permission denied", input: {filePath: "/repo/in"}}),
    {type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":["x"]}'}}
  ], probe).some(o => o.type === "permission_denied"));

check("a write/edit denial followed by a later successful tool call does not emit permission_denied",
  ["write", "edit", "patch", "multiedit"].every(tool =>
    driver.observe([
      toolEvent(tool, {status: "error", error: "permission denied", input: {filePath: "/repo/production.txt"}}),
      toolEvent("bash", {status: "completed", input: {command: "true"}, metadata: {exit: 0}})
    ], probe).some(o => o.type === "permission_denied") === false
  ));

check("a write denial followed by later verdict-bearing agent text does not emit permission_denied",
  (() => {
    const o = driver.observe([
      toolEvent("write", {status: "error", error: "not permitted by policy", input: {filePath: "/repo/production.txt"}}),
      {type: "text", part: {type: "text", text: 'AUTOPILOT_REVIEW={"decision":"PASS","findings":["x"]}'}}
    ], probe);
    return o.some(x => x.type === "write_blocked") && !o.some(x => x.type === "permission_denied");
  })());

// ---- 6c. Read denial vocabulary: strict terminal denials only ----
check("a genuinely-failed read with strict denial text emits file_read_attempted plus permission_denied",
  (() => {
    const o = driver.observe([toolEvent("read", {status: "error", error: "permission denied", input: {filePath: "/repo/in"}})], probe);
    return o.some(x => x.type === "file_read_attempted") && o.some(x => x.type === "permission_denied");
  })());

check("a failed read without denial text emits no permission_denied",
  (() => {
    const o = driver.observe([toolEvent("read", {status: "error", error: "File not found: /repo/in", input: {filePath: "/repo/in"}})], probe);
    return o.some(x => x.type === "file_read_attempted") && !o.some(x => x.type === "permission_denied");
  })());

// ---- 6d. Write/edit denial vocabulary: strict terminal denials only ----
// Genuine terminal denials (single tool event, no auto-reject stderr
// correlation) emit permission_denied alongside the existing blocked
// vocabulary; non-denial failures and output-only prose do not.
check("a denied production write emits write_blocked plus permission_denied",
  (() => {
    const o = driver.observe([toolEvent("write", {status: "error", error: "permission denied", input: {filePath: "/repo/production.txt"}})], probe);
    return o.some(x => x.type === "write_attempted") && o.some(x => x.type === "write_blocked") && o.some(x => x.type === "permission_denied");
  })());

check("a denied outside write emits outside_write_blocked plus permission_denied",
  (() => {
    const o = driver.observe([toolEvent("write", {status: "error", error: "not permitted by policy", input: {filePath: "/outside.txt"}})], probe);
    return o.some(x => x.type === "outside_write_attempted") && o.some(x => x.type === "outside_write_blocked") && o.some(x => x.type === "permission_denied");
  })());

check("denied edit/patch/multiedit variants emit permission_denied while keeping blocked vocabulary",
  ["edit", "patch", "multiedit"].every(tool =>
    driver.observe([toolEvent(tool, {status: "error", error: "permission denied", input: {filePath: "/repo/production.txt"}})], probe)
      .some(x => x.type === "permission_denied")
  ) && ["edit", "patch", "multiedit"].every(tool =>
    driver.observe([toolEvent(tool, {status: "error", error: "permission denied", input: {filePath: "/repo/production.txt"}})], probe)
      .some(x => x.type === "write_blocked")
  ));

check("a non-denial write failure emits no permission_denied",
  (() => {
    const o = driver.observe([toolEvent("write", {status: "error", error: "disk quota exceeded", input: {filePath: "/repo/production.txt"}})], probe);
    return o.some(x => x.type === "write_failed") && !o.some(x => x.type === "permission_denied");
  })());

check("permission wording in state.output alone does not emit permission_denied on the write branch",
  !driver.observe([toolEvent("write", {status: "error", error: "disk quota exceeded", output: "note: permission denied handling documented", input: {filePath: "/repo/production.txt"}})], probe).some(o => o.type === "permission_denied"));

// ---- 6f. Strict/loose boundary regression (mission 022 part 1, phase 3.1) ----
// The observer's loose `blocked` regex (/denied|permission|not permitted/
// read-only|blocked/i, error+output) drives *_blocked vocabulary only; the
// permission_denied decision uses the strict OPENCODE_DENIAL_TEXT
// (/permission denied|rejected permission|not permitted|blocked by policy/i,
// state.error only) via the shared terminalDenial(). Loose-only error text —
// matching `blocked` but none of the strict phrases — must never emit
// permission_denied on any branch. All cases below are single terminal tool
// events with in-sandbox paths and no stderr, so the auto-reject demotion
// cannot explain the zero permission_denied.
check("read branch: loose-regex-only error prose emits no permission_denied",
  (() => {
    const o = driver.observe([toolEvent("read", {status: "error", error: "access denied: EACCES reading cache", input: {filePath: "/repo/in"}})], probe);
    return o.some(x => x.type === "file_read_attempted") && !o.some(x => x.type === "permission_denied");
  })());

check("bash branch: loose-regex-only error prose emits no permission_denied",
  (() => {
    const o = driver.observe([toolEvent("bash", {status: "error", error: "operation blocked by admin: exit status 1", input: {command: "cat doc"}})], probe);
    return o.some(x => x.type === "command_attempted") && o.some(x => x.type === "command_failed") && !o.some(x => x.type === "permission_denied");
  })());

check("write branch: loose-regex-only error prose keeps write_blocked with zero permission_denied",
  (() => {
    const o = driver.observe([toolEvent("write", {status: "error", error: "EACCES: read-only filesystem, retrying with fallback", input: {filePath: "/repo/production.txt"}})], probe);
    return o.some(x => x.type === "write_attempted") && o.some(x => x.type === "write_blocked") && !o.some(x => x.type === "permission_denied");
  })());

check("read branch: strict denial text in state.output alone emits no permission_denied",
  !driver.observe([toolEvent("read", {status: "error", error: "File not found: /repo/in", output: "note: permission denied handling documented", input: {filePath: "/repo/in"}})], probe).some(o => o.type === "permission_denied"));

check("genuinely-failed strict denials emit permission_denied on read/bash/write branches",
  ["read", "bash", "write"].every(tool => {
    const input = tool === "bash" ? {command: "cat doc"} : {filePath: "/repo/production.txt"};
    const state = tool === "read" ? {status: "error", error: "permission denied", input} : {status: "error", error: "not permitted by policy", input};
    return driver.observe([toolEvent(tool, state)], probe).some(x => x.type === "permission_denied");
  }));

// ---- 6e. Auto-rejected out-of-sandbox refusal: non-terminal warning, never permission_denied ----
// Live shape (mission 021 run 18-verifier-bd5860b5): the bash tool event
// carries only the generic "The user rejected permission to use this
// specific tool call." in state.error, while the explanation
// ("permission requested: external_directory (...); auto-rejecting") arrives
// on process stderr — decoded by decodeEvents() into {type:"stderr"} events.
const autoRejectStderr = driver.decodeEvents("", "permission requested: external_directory (/tmp/*); auto-rejecting\n");
check("auto-reject stderr line decodes to a stderr event",
  autoRejectStderr.length === 1 && autoRejectStderr[0].type === "stderr");

const run18Bash = toolEvent("bash", {status: "error", error: "The user rejected permission to use this specific tool call.", input: {command: "cat /tmp/verify-021-T3-oneliner.sh"}});
const run18Observed = driver.observe([run18Bash, ...autoRejectStderr], probe);
check("run 18 replay: auto-rejected bash refusal emits command_attempted plus a warning and zero permission_denied",
  run18Observed.some(o => o.type === "command_attempted")
  && run18Observed.some(o => o.type === "out_of_sandbox_auto_reject_warning")
  && !run18Observed.some(o => o.type === "permission_denied"));

check("run 18 replay without the stderr line stays a terminal bash denial",
  (() => {
    const o = driver.observe([run18Bash], probe);
    return o.some(x => x.type === "permission_denied") && !o.some(x => x.type === "out_of_sandbox_auto_reject_warning");
  })());

// Task 1.4 precedence: a write/edit auto-reject is demoted too — it keeps
// outside_write_blocked but emits zero permission_denied.
const autoRejectWrite = toolEvent("write", {status: "error", error: "The user rejected permission to use this specific tool call.", input: {filePath: "/outside.txt"}});
check("auto-rejected outside write (stderr-correlated) keeps outside_write_blocked with zero permission_denied",
  (() => {
    const o = driver.observe([autoRejectWrite, ...autoRejectStderr], probe);
    return o.some(x => x.type === "outside_write_attempted")
      && o.some(x => x.type === "outside_write_blocked")
      && o.some(x => x.type === "out_of_sandbox_auto_reject_warning")
      && !o.some(x => x.type === "permission_denied");
  })());

check("auto-rejected outside write (input-path-only, no stderr) keeps outside_write_blocked with zero permission_denied",
  (() => {
    const o = driver.observe([autoRejectWrite], probe);
    return o.some(x => x.type === "outside_write_blocked")
      && o.some(x => x.type === "out_of_sandbox_auto_reject_warning")
      && !o.some(x => x.type === "permission_denied");
  })());

check("auto-rejected outside edit variant is demoted while keeping blocked vocabulary",
  (() => {
    const o = driver.observe([toolEvent("edit", {status: "error", error: "The user rejected permission to use this specific tool call.", input: {filePath: "/outside.txt"}})], probe);
    return o.some(x => x.type === "outside_write_blocked")
      && o.some(x => x.type === "out_of_sandbox_auto_reject_warning")
      && !o.some(x => x.type === "permission_denied");
  })());

check("auto-rejected outside read (stderr-correlated) yields file_read_attempted plus a warning and zero permission_denied",
  (() => {
    const o = driver.observe([toolEvent("read", {status: "error", error: "The user rejected permission to use this specific tool call.", input: {filePath: "/outside.txt"}}), ...autoRejectStderr], probe);
    return o.some(x => x.type === "file_read_attempted")
      && o.some(x => x.type === "out_of_sandbox_auto_reject_warning")
      && !o.some(x => x.type === "permission_denied");
  })());

check("a genuine outside-write policy denial without auto-reject correlation stays terminal",
  (() => {
    const o = driver.observe([toolEvent("write", {status: "error", error: "not permitted by policy", input: {filePath: "/outside.txt"}})], probe);
    return o.some(x => x.type === "outside_write_blocked")
      && o.some(x => x.type === "permission_denied")
      && !o.some(x => x.type === "out_of_sandbox_auto_reject_warning");
  })());

// ---- 7. Fail-closed unsupported capabilities ----
const declared = manifest.opencode.declared_capabilities;
check("declared capabilities are conservative and valid",
  Object.entries(declared).every(([id, value]) => capabilityValueIsValid(id, value)));
check("no isolation/safety claims declared (containment belongs to envelope certification)",
  !Object.keys(declared).some(id => id.startsWith("isolation.") || id.startsWith("safety.")));
check("no browser claims declared", !Object.keys(declared).some(id => id.startsWith("browser.")));

// ---- 8. Final-text extraction (OpenCode shape) feeds the canonical parser ----
import {finalAgentText} from "./adapter-drivers.mjs";
import {parseReviewContract, classifyObservedFailure} from "./failure-contract.mjs";
const sentinel = 'AUTOPILOT_REVIEW={"decision":"PASS","findings":["nonce"]}';
const opencodeTextEvents = [
  {type: "tool_use", part: {type: "tool", tool: "bash", state: {status: "completed", input: {command: "true"}, metadata: {exit: 0}}}},
  {type: "text", part: {type: "text", text: `work summary\n${sentinel}`}}
];
check("finalAgentText extracts OpenCode text-part prose",
  finalAgentText(opencodeTextEvents, "").includes(sentinel));
check("extracted OpenCode sentinel parses to a valid PASS verdict",
  parseReviewContract(finalAgentText(opencodeTextEvents, "")).verdict.decision === "PASS");
// Codex/AGY shapes remain collected (no regression)
check("codex agent_message shape still collected",
  finalAgentText([{type: "agent_message", text: "codex-final"}], "") === "codex-final");
check("agy result.response shape still collected",
  finalAgentText([{result: {response: "agy-final"}}], "") === "agy-final");

// ---- 9. End-to-end: an observed terminal denial classifies as a denied failure ----
check("run 26's observed set classifies as non-retryable PERMISSION_DENIED",
  (() => {
    const observedFailure = classifyObservedFailure({evidence: run26Observed, exitCode: 0, stderr: ""});
    return observedFailure?.class === "PERMISSION_DENIED"
      && observedFailure.domain === "adapter"
      && observedFailure.retryable === false;
  })());

// The new emission must not reclassify every missing sentinel as a denial: a
// clean exit with no denial and no verdict stays STRUCTURED_OUTPUT_MISSING
// (run 15's shape).
check("a clean exit with no denial and no sentinel still classifies as STRUCTURED_OUTPUT_MISSING",
  (() => {
    const observed = driver.observe([toolEvent("bash", {status: "completed", input: {command: "true"}, metadata: {exit: 0}})], probe);
    const observedFailure = classifyObservedFailure({evidence: observed, exitCode: 0, stderr: ""});
    return observedFailure === null
      && parseReviewContract("I'll stop polling now and wait for the background task notification.").failure?.class === "STRUCTURED_OUTPUT_MISSING";
  })());

// ---- 10. Per-invocation token-usage accumulation (TASK-19 phase 0 task 0a) ----
const stepFinish = tokens => ({type: "step_finish", part: {type: "step-finish", tokens}});
const opencodeUsageEvents = [
  {type: "step_start", part: {type: "step-start"}},
  stepFinish({input: 100, output: 20, reasoning: 5, cache: {read: 10, write: 0}}),
  {type: "text", part: {type: "text", text: "intermediate prose"}},
  stepFinish({input: 50, output: 8, reasoning: 0, cache: {read: 0, write: 200}})
];
const opencodeUsage = accumulateUsage("opencode", opencodeUsageEvents);
check("opencode usage: two step_finish events accumulate into two turns",
  opencodeUsage?.turns === 2);
check("opencode usage: input/cacheRead/cacheCreation sum across steps",
  opencodeUsage?.input === 150 && opencodeUsage?.cacheRead === 10 && opencodeUsage?.cacheCreation === 200);
check("opencode usage: reasoning tokens fold into output, not a fifth field",
  opencodeUsage?.output === 33 && !("reasoning" in opencodeUsage));
check("opencode usage: price-weighted figure matches the named weight constants",
  Math.abs(opencodeUsage.priceWeighted - (150 * USAGE_PRICE_WEIGHTS.input + 200 * USAGE_PRICE_WEIGHTS.cacheCreation + 10 * USAGE_PRICE_WEIGHTS.cacheRead + 33 * USAGE_PRICE_WEIGHTS.output)) < 1e-9);

const opencodeNoUsageEvents = [{type: "step_start", part: {type: "step-start"}}, {type: "text", part: {type: "text", text: "no step_finish here"}}];
check("opencode usage: a stream with no step_finish event returns null, never a zeroed object",
  accumulateUsage("opencode", opencodeNoUsageEvents) === null);

// Per-turn context tracking: maxSingleTurnContext is the largest single-step
// input+cache.read+cache.write footprint (current context size, not the
// cumulative total).
check("opencode usage: existing two-step fixture reports maxSingleTurnContext 250",
  opencodeUsage?.maxSingleTurnContext === 250, opencodeUsage?.maxSingleTurnContext);
const threeStepEvents = [
  stepFinish({input: 30000, output: 1, reasoning: 0, cache: {read: 5000, write: 0}}),
  stepFinish({input: 40000, output: 1, reasoning: 0, cache: {read: 5000, write: 5000}}),
  stepFinish({input: 15000, output: 1, reasoning: 0, cache: {read: 5000, write: 0}})
];
const threeStepUsage = accumulateUsage("opencode", threeStepEvents);
check("opencode usage: 3 steps of 35K, 50K, 20K give maxSingleTurnContext 50K",
  threeStepUsage?.turns === 3 && threeStepUsage?.maxSingleTurnContext === 50000, threeStepUsage);

// Real Claude Code stream-json shape: one `assistant` event per content block,
// each repeating its message.id and usage (thinking + tool_use of msg_1 below).
const claudeAssistant = (id, usage, block = "text") => ({type: "assistant", message: {id, role: "assistant", content: [{type: block}], usage}});
const msg1 = {input_tokens: 40, output_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 0};
const msg2 = {input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 300};
const claudeLiveEvents = [
  claudeAssistant("msg_1", msg1, "thinking"),
  claudeAssistant("msg_1", msg1, "tool_use"),
  claudeAssistant("msg_2", msg2, "text")
];
const claudeLive = accumulateUsage("claude", claudeLiveEvents);
check("claude usage (live): one turn per message.id, repeated content-block events are not double-counted",
  claudeLive?.turns === 2 && claudeLive?.input === 45 && claudeLive?.output === 15
  && claudeLive?.cacheCreation === 300 && claudeLive?.cacheRead === 300);
// The terminal result event carries the session's cumulative usage (streamed
// output_tokens are partial) — authoritative once present, never added on top.
const claudeUsageEvents = [...claudeLiveEvents,
  {type: "result", subtype: "success", is_error: false, result: "done", num_turns: 2,
    usage: {input_tokens: 45, output_tokens: 900, cache_creation_input_tokens: 300, cache_read_input_tokens: 300}}];
const claudeUsage = accumulateUsage("claude", claudeUsageEvents);
check("claude usage (final): the result event's cumulative usage and num_turns replace the streamed sums",
  claudeUsage?.turns === 2 && claudeUsage?.input === 45 && claudeUsage?.output === 900
  && claudeUsage?.cacheCreation === 300 && claudeUsage?.cacheRead === 300);
check("claude usage (live): maxSingleTurnContext is the per-message max (340), not a cumulative sum",
  claudeLive?.maxSingleTurnContext === 340, claudeLive?.maxSingleTurnContext);
check("claude usage (final): maxSingleTurnContext still comes from the per-message samples (340), never the cumulative result total (645)",
  claudeUsage?.maxSingleTurnContext === 340, claudeUsage?.maxSingleTurnContext);

check("usage: a driverless/unsupported adapter (e.g. codex) records null, never 0",
  accumulateUsage("codex", claudeUsageEvents) === null
  && accumulateUsage("antigravity", opencodeUsageEvents) === null
  && accumulateUsage("cursor", []) === null);

if (failures) {
  console.error(`${failures} OpenCode driver check(s) failed.`);
  process.exit(1);
}
console.log("OpenCode contract-v2 driver tests passed");
