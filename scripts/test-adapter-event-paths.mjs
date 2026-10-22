import assert from "node:assert/strict";
import {adapterDriver} from "./adapter-drivers.mjs";
import {equivalentEventPath, eventReferencesPath} from "./event-paths.mjs";

const root = String.raw`D:\Autopilot Certification\fixture with spaces\مسار`;
const readPath = String.raw`${root}\input\nonce.txt`;
const escapedReadPath = readPath.replace(/\\/g, "\\\\");

const pathReferences = [
  ["escaped Windows path", `Get-Content -LiteralPath '${escapedReadPath}'`],
  ["forward-slash equivalent", `type ${readPath.replace(/\\/g, "/")}`],
  ["relative path", String.raw`Get-Content '.\input\nonce.txt'`],
  ["normalized quoted path", `Get-Content '${root}\\input\\nested\\..\\nonce.txt'`],
  ["case-insensitive Windows path", `TYPE ${readPath.toUpperCase()}`]
];
for (const [label, command] of pathReferences) {
  assert.equal(eventReferencesPath(command, readPath, root), true, label);
}

const composed = String.raw`D:\Café\مسار\nonce.txt`;
const decomposed = composed.normalize("NFD").replace(/\\/g, "\\\\");
assert.equal(eventReferencesPath(decomposed, composed, String.raw`D:\Café\مسار`), true, "Unicode normalization must preserve path identity");
assert.equal(equivalentEventPath(String.raw`D:\Repo\sub\..\input\nonce.txt`, String.raw`d:/repo/input/nonce.txt`), true);

const serializedCommand = JSON.stringify({command: `Get-Content -LiteralPath '${escapedReadPath}'`});
const decodedCommand = JSON.parse(serializedCommand).command;
assert.equal(eventReferencesPath(decodedCommand, readPath, root), true, "JSON-escaped Windows event paths must survive decoding");

const unc = String.raw`\\wsl$\Ubuntu\home\user\fixture with spaces\مسار\nonce.txt`;
assert.equal(eventReferencesPath(unc.replace(/\\/g, "\\\\"), unc, String.raw`\\wsl$\Ubuntu\home\user`), true, "well-formed escaped UNC paths must normalize");
assert.equal(eventReferencesPath(String.raw`\\wsl"'$'"\Ubuntu\home\user\nonce.txt`, unc, String.raw`\\wsl$\Ubuntu\home\user`), false, "malformed shell quoting must not become trusted path evidence");

const probe = {
  root,
  readPath,
  productionWritePath: String.raw`${root}\output\boundary.txt`,
  outsideWritePath: String.raw`D:\Autopilot Certification\outside.txt`,
  timeoutScriptPath: String.raw`${root}\input\timeout-child.mjs`,
  gitGuardWrapperPath: String.raw`D:\Autopilot Certification\evidence\git-guard-explicit.mjs`
};
const driver = adapterDriver("codex");
const scratchInvocation = driver.buildInvocation({binary: "codex", cwd: root, scratchDir: null, model: null, reasoning: null, mode: "scratch"});
assert.deepEqual(scratchInvocation.args.slice(scratchInvocation.args.indexOf("--sandbox"), scratchInvocation.args.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
const readOnlyInvocation = driver.buildInvocation({binary: "codex", cwd: root, scratchDir: null, model: null, reasoning: null, mode: "read"});
assert.deepEqual(readOnlyInvocation.args.slice(readOnlyInvocation.args.indexOf("--sandbox"), readOnlyInvocation.args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
const trustedEnvelopeInvocation = driver.buildInvocation({binary: "codex", cwd: root, scratchDir: null, model: null, reasoning: null, mode: "read", trustedEnvelope: true});
assert.deepEqual(trustedEnvelopeInvocation.args.slice(trustedEnvelopeInvocation.args.indexOf("--sandbox"), trustedEnvelopeInvocation.args.indexOf("--sandbox") + 2), ["--sandbox", "danger-full-access"]);
const trustedRelayArgs = driver.trustedEnvelopeArgs(["exec", "--sandbox", "read-only", "--json"]);
assert.deepEqual(trustedRelayArgs, ["exec", "--sandbox", "danger-full-access", "--json"]);
assert.throws(() => driver.trustedEnvelopeArgs(["exec", "--json"]), /explicit sandbox option/);

const completedRead = driver.observe([{
  type: "item.completed",
  item: {type: "command_execution", command: `Get-Content '${escapedReadPath}'`, status: "completed", exit_code: 0, aggregated_output: "nonce"}
}], probe);
assert.ok(completedRead.some(event => event.type === "file_read_observed" && event.output === "nonce"), "a completed successful event is recorded as a file_read_observed diagnostics observation (B5: diagnostics-only; never grants repository.read)");

const startedRead = driver.observe([{
  type: "item.started",
  item: {type: "command_execution", command: String.raw`Get-Content '.\input\nonce.txt'`, status: "in_progress", exit_code: null}
}], probe);
assert.ok(startedRead.some(event => event.type === "file_read_attempted"));
assert.ok(!startedRead.some(event => event.type === "file_read_observed"), "an attempted read is not a successful read");

const blockedWrite = driver.observe([{
  type: "item.completed",
  item: {type: "command_execution", command: `Set-Content '${probe.productionWritePath}'`, status: "declined", exit_code: -1, aggregated_output: "blocked by policy"}
}], probe);
assert.ok(blockedWrite.some(event => event.type === "write_attempted"));
assert.ok(blockedWrite.some(event => event.type === "write_blocked"));
assert.ok(blockedWrite.some(event => event.type === "permission_denied"));

const envelopeFailedWrite = driver.observe([{
  type: "item.completed",
  item: {type: "file_change", changes: [{path: probe.productionWritePath, kind: "update"}], status: "failed"}
}], probe);
assert.ok(envelopeFailedWrite.some(event => event.type === "write_attempted"));
assert.ok(envelopeFailedWrite.some(event => event.type === "write_failed"), "a trusted failed tool event is recorded separately for core envelope corroboration");
assert.ok(!envelopeFailedWrite.some(event => event.type === "write_blocked"), "the adapter observer alone must not infer the safety mechanism");

const guardCommand = `node "${probe.gitGuardWrapperPath.replace(/\\/g, "\\\\")}" -C "${root}" commit --allow-empty -m certification-probe`;
const trustedGitBlock = driver.observe([{
  type: "item.completed",
  item: {type: "command_execution", command: guardCommand, status: "failed", exit_code: 1, aggregated_output: "AUTOPILOT GIT GUARD: 'commit' is forbidden (history/ref mutation)."}
}], probe);
assert.ok(trustedGitBlock.some(event => event.type === "git_mutation_attempted"));
assert.ok(trustedGitBlock.some(event => event.type === "git_mutation_blocked"), "the exact wrapper plus trusted process marker proves the Git block");

const auditWriteFailure = driver.observe([{
  type: "item.completed",
  item: {type: "command_execution", command: guardCommand, status: "failed", exit_code: 1, aggregated_output: "EPERM: operation not permitted, open blocked.log"}
}], probe);
assert.ok(auditWriteFailure.some(event => event.type === "git_mutation_attempted"));
assert.ok(!auditWriteFailure.some(event => event.type === "git_mutation_blocked"), "an audit-log EPERM alone must not certify Git isolation");

const trustedHookBlock = driver.observe([{
  type: "item.completed",
  item: {
    type: "command_execution",
    command: `git -C "${root}" commit --allow-empty -m certification-probe`,
    status: "failed",
    exit_code: 1,
    aggregated_output: "AUTOPILOT GIT GUARD: blocked by pre-commit hook"
  }
}], probe);
assert.ok(trustedHookBlock.some(event => event.type === "git_mutation_blocked"), "the process-scoped hook marker proves a direct Git block");

const trustedReadOnlyMountBlock = driver.observe([{
  type: "item.completed",
  item: {
    type: "command_execution",
    command: `git -C "${root}" commit --allow-empty -m certification-probe`,
    status: "failed",
    exit_code: 128,
    aggregated_output: "fatal: Unable to create '.git/index.lock': Read-only file system"
  }
}], probe);
assert.ok(trustedReadOnlyMountBlock.some(event => event.type === "git_mutation_blocked"), "a completed Git attempt denied by a read-only mount is trusted technical-block evidence");

// ---------------------------------------------------------------------
// Regression: permission_denied must never be inferred from a successful
// (exit 0) command's own output — only from trustworthy failure evidence
// (an explicit CLI-protocol denial status, or a genuinely failed event
// whose own error/output text names a real denial reason). A repository
// document a successful read merely happens to quote (e.g. domain text
// discussing permissions, or prose describing a read-only mode) must not be
// mistaken for the CLI's own outcome. See docs/REMINDERS-FOR-CURSOR-FINAL.md
// in the target my-app project for the exact real-world trigger text.
// ---------------------------------------------------------------------
const successfulReadWithPermissionProse = driver.observe([{
  type: "item.completed",
  item: {
    type: "command_execution",
    command: `Get-Content '${escapedReadPath}'`,
    status: "completed",
    exit_code: 0,
    aggregated_output: 'HTTP 403 with "Insufficient permissions to create emergency appointments."'
  }
}], probe);
assert.ok(successfulReadWithPermissionProse.some(event => event.type === "file_read_observed"), "the successful read is still observed");
assert.ok(!successfulReadWithPermissionProse.some(event => event.type === "permission_denied"), "successful command output containing 'Insufficient permissions' must not emit permission_denied");

const successfulCommandWithPermissionDeniedText = driver.observe([{
  type: "item.completed",
  item: {type: "command_execution", command: "cat notes.txt", status: "completed", exit_code: 0, aggregated_output: "note: a prior run logged 'Permission denied' before retrying and succeeding"}
}], probe);
assert.ok(!successfulCommandWithPermissionDeniedText.some(event => event.type === "permission_denied"), "successful command output containing 'Permission denied' must not emit permission_denied");

const successfulReadOnlyProse = driver.observe([{
  type: "item.completed",
  item: {type: "command_execution", command: `Get-Content '${escapedReadPath}'`, status: "completed", exit_code: 0, aggregated_output: "PowerSync is read-only in this release."}
}], probe);
assert.ok(!successfulReadOnlyProse.some(event => event.type === "permission_denied"), "successful command output merely describing a read-only mode must not emit permission_denied");

const genuinelyFailedPermissionDenied = driver.observe([{
  type: "item.completed",
  item: {type: "command_execution", command: `Set-Content '${probe.productionWritePath}'`, status: "failed", exit_code: 1, aggregated_output: "Permission denied"}
}], probe);
assert.ok(genuinelyFailedPermissionDenied.some(event => event.type === "permission_denied"), "a genuinely failed (nonzero exit) command whose own output names a real denial reason must still emit permission_denied");
assert.ok(genuinelyFailedPermissionDenied.some(event => event.type === "write_blocked"), "the genuine denial still blocks the write");

const explicitStructuredDenial = driver.observe([{
  type: "item.completed",
  item: {type: "command_execution", command: `Set-Content '${probe.outsideWritePath}'`, status: "declined", exit_code: -1, aggregated_output: ""}
}], probe);
assert.ok(explicitStructuredDenial.some(event => event.type === "permission_denied"), "an explicit CLI-protocol denial status ('declined') must still emit permission_denied even with no denial text in the output");
assert.ok(explicitStructuredDenial.some(event => event.type === "outside_write_blocked"), "the explicit structured denial still blocks the outside write");

console.log("adapter-neutral event path normalization and trusted success tests passed");
