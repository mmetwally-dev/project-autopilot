import assert from "node:assert/strict";
import {validateAdapterContract, discoverAgentContract, buildInvocationRecord, buildRuntimeResult} from "./agent-contract.mjs";

const adapter = {binary: "fake", probe: ["--version"], write: ["run"], read_only: ["plan"], model_flag: "--model", effort_flag: "--effort", variant_flag: null, model_discovery: "manual"};
assert.equal(validateAdapterContract("fake", adapter).ok, true);
assert.equal(validateAdapterContract("bad", {binary: "x"}).ok, false);
assert.equal(validateAdapterContract("bad-v2", {...adapter, contract_version: 2}).ok, false, "v2 requires a driver and capability declaration");

const unsupported = await discoverAgentContract("fake", {...adapter, model_discovery: "manual"});
assert.equal(unsupported.models.status, "unsupported");

const invocation = buildInvocationRecord({role: {model: "m", reasoning: "high", variant: null}, adapterId: "fake", adapter, args: ["run", "--model", "m", "--effort", "high"], verification: {ok: true, errors: []}});
assert.equal(invocation.requested.model, "m");
assert.equal(invocation.verifiedBeforeLaunch, true);
const result = buildRuntimeResult({roleName: "planner", role: {model: "m", reasoning: "high"}, adapterId: "fake", adapter, processResult: {status: 0, signal: null}, output: "ok", invocation, startedAt: "a", finishedAt: "b", sessionId: null, touchedFiles: ["x.js"], policy: {violation: null}});
assert.equal(result.schema, "autopilot-relay.result.v3");
assert.deepEqual(result.contract, {status: "not_required", error: null});
assert.equal(result.verdict.status, "not_applicable");
assert.equal(result.execution.requested.reasoning, "high");
assert.deepEqual(result.touchedFiles, ["x.js"]);
console.log("agent contract tests passed");
