#!/usr/bin/env node
// Backlog #7 + #8: agy write roles get a per-run `--settings` file with
// command(...) grants, and a write-role PERMISSION_DENIED run never reaches
// the reviewer (fallback model, else an escalating stop naming the command).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {agyRelayExtraArgs, agyAllowRulesForRole} from "./agy-events.mjs";
import {escalateIfRateLimited, deniedCommandOf} from "./planning-review-wiring.mjs";
import {decideRoleFallback} from "./role-fallback.mjs";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`); }
}
const allowOf = file => JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-perm-"));
const config = {tests: {gate_commands: ["npx vitest run --exclude x"]}};

// (a) planner write run
const plannerArgs = agyRelayExtraArgs({adapter: "antigravity", readOnly: false, roleName: "planner", config, runDir: path.join(tmp, "run-p"), repo: tmp});
const pi = plannerArgs.indexOf("--settings");
const pFile = plannerArgs[pi + 1];
check("(a) planner argv has --settings <file>", pi >= 0 && typeof pFile === "string" && pFile.startsWith(path.join(tmp, "run-p")) && pFile.endsWith("settings.json"), plannerArgs);
check("(a) settings file exists", typeof pFile === "string" && fs.existsSync(pFile));
const pAllow = pFile && fs.existsSync(pFile) ? allowOf(pFile) : [];
check("(a) planner allows ls, grep, git diff", ["command(ls)", "command(grep)", "command(git diff)"].every(r => pAllow.includes(r)), pAllow);
check("(a) planner has no git commit/push", !pAllow.some(r => /git (commit|push)/.test(r)), pAllow);
check("(a) planner has no test runner (npm/npx)", !pAllow.includes("command(npm)") && !pAllow.includes("command(npx vitest)"), pAllow);
check("(a) global ~/.gemini untouched", !pFile.startsWith(path.join(os.homedir(), ".gemini")));

// (b) implementer with gate command
const implArgs = agyRelayExtraArgs({adapter: "antigravity", readOnly: false, roleName: "implementer", config, runDir: path.join(tmp, "run-i"), repo: tmp});
const iAllow = allowOf(implArgs[implArgs.indexOf("--settings") + 1]);
check("(b) implementer allows npx vitest and npm", iAllow.includes("command(npx vitest)") && iAllow.includes("command(npm)"), iAllow);
check("(b) implementer has git add but not commit/push/reset/checkout", iAllow.includes("command(git add)") && !iAllow.some(r => /git (commit|push|reset|checkout)/.test(r)), iAllow);
check("(b) rules function lists the same gate prefix", agyAllowRulesForRole("implementer", config).includes("command(npx vitest)"));

// (c) read-only run and other adapters unchanged
check("(c) read_only agy run gets no extra args", agyRelayExtraArgs({adapter: "antigravity", readOnly: true, roleName: "plan_reviewer", config, runDir: path.join(tmp, "run-r"), repo: tmp}).length === 0);
check("(c) read_only run writes no settings dir", !fs.existsSync(path.join(tmp, "run-r")));
check("(c) non-agy write run gets no extra args", agyRelayExtraArgs({adapter: "codex", readOnly: false, roleName: "planner", config, runDir: path.join(tmp, "run-c"), repo: tmp}).length === 0);

// (e) speckit scripts: per-file rules from real script files
const skRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sk-"));
fs.mkdirSync(path.join(skRepo, ".specify", "scripts", "bash"), {recursive: true});
fs.writeFileSync(path.join(skRepo, ".specify", "scripts", "bash", "check-prerequisites.sh"), "");
fs.writeFileSync(path.join(skRepo, ".specify", "scripts", "bash", "setup-plan.sh"), "");
const skRules = agyAllowRulesForRole("planner", config, {speckit: true, repo: skRepo});
check("(e) speckit rules include setup-plan exact", skRules.includes("command(.specify/scripts/bash/setup-plan.sh)"), skRules);
check("(e) speckit rules include setup-plan bash", skRules.includes("command(bash .specify/scripts/bash/setup-plan.sh)"), skRules);
check("(e) speckit rules include setup-plan dotted", skRules.includes("command(./.specify/scripts/bash/setup-plan.sh)"), skRules);
check("(e) speckit rules do not include old prefix", !skRules.includes("command(bash .specify/scripts)"), skRules);
const skArgs = agyRelayExtraArgs({adapter: "antigravity", readOnly: false, roleName: "planner", config, runDir: path.join(skRepo, "run-sk"), repo: skRepo});
const skAllow = allowOf(skArgs[skArgs.indexOf("--settings") + 1]);
check("(e) relay settings include setup-plan", skAllow.includes("command(.specify/scripts/bash/setup-plan.sh)"), skAllow);
// without .specify -> no .specify rules
const noSpecRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-nospec-"));
const noSpecRules = agyAllowRulesForRole("planner", config, {repo: noSpecRepo});
check("(e) no .specify rules without .specify", !noSpecRules.some(r => r.includes(".specify")), noSpecRules);

// (d) PERMISSION_DENIED write-role result: stop (no reviewer), fallback first
const denied = {
  status: "completed",
  failure: {class: "PERMISSION_DENIED", domain: "adapter", retryable: false, evidence: [
    {type: "permission_denied", reason: "denied_actions"},
    {type: "command_attempted", event: {step_update: {tool_info: {parameters: {CommandLine: "ls -la specs/010/"}}}}}
  ]}
};
check("(d) denied command is extracted", deniedCommandOf(denied.failure) === "ls -la specs/010/");
let stopMsg = null;
const state = {};
let threw = false;
try {
  escalateIfRateLimited({}, state, "t", denied, {fatal: m => { stopMsg = m; throw new Error("stop"); }, saveState: () => {}, escalatePrefix: "Standalone planner", writeRole: true});
} catch { threw = true; }
check("(d) write-role PERMISSION_DENIED stops the mission before any reviewer", threw && /PERMISSION_DENIED/.test(stopMsg || "") && /ls -la specs\/010\//.test(stopMsg || ""), stopMsg);
check("(d) state marked escalated", state.phase === "escalated", state);
check("(d) read-only/non-write callers are not affected", escalateIfRateLimited({}, {}, "t", denied, {fatal: () => { throw new Error("x"); }}) === false);
check("(d) other classes unaffected", escalateIfRateLimited({}, {}, "t", {failure: {class: "PROVIDER_ERROR", domain: "adapter"}}, {fatal: () => { throw new Error("x"); }, writeRole: true}) === false);
const withFallback = decideRoleFallback({role: "planner", roleConfig: {adapter: "antigravity", model: "a", fallbacks: [{adapter: "codex", model: "b"}]}, failureClass: "PERMISSION_DENIED"});
check("(d) a configured fallback is tried first", withFallback.action === "switch" && withFallback.next.model === "b", withFallback);
const noFallback = decideRoleFallback({role: "planner", roleConfig: {adapter: "antigravity", model: "a"}, failureClass: "PERMISSION_DENIED"});
check("(d) no fallback left -> escalate", noFallback.action === "escalate", noFallback);

// runRelay wiring (static): fallback gate and final stop are write-role only
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
check("(d) runRelay gates fallback on !readOnly PERMISSION_DENIED", /!readOnly&&result\?\.failure\?\.class==="PERMISSION_DENIED"&&result\.failure\.domain==="adapter"/.test(src));
check("(d) runRelay stops after fallbacks with writeRole:true", /if\(!readOnly && result\?\.failure\?\.class==="PERMISSION_DENIED"\)\{\s*escalateIfRateLimited\([\s\S]{0,200}?writeRole:true/.test(src));
check("(a) runRelay appends agy extra args", /args\.push\(\.\.\.agyRelayExtraArgs\(/.test(src));

fs.rmSync(tmp, {recursive: true, force: true});
fs.rmSync(skRepo, {recursive: true, force: true});
fs.rmSync(noSpecRepo, {recursive: true, force: true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
