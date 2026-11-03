#!/usr/bin/env node
// Backlog #7 + #8: agy write roles get a per-run `--settings` file with
// command(...) grants, and a write-role PERMISSION_DENIED run never reaches
// the reviewer (fallback model, else an escalating stop naming the command).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {agyRelayExtraArgs, agyAllowRulesForRole, writeAgyAllowRule} from "./agy-events.mjs";
import {AGY_SETTINGS_RELATIVE_PATH} from "./adapter-drivers.mjs";
import {escalateIfRateLimited, deniedCommandOf} from "./planning-review-wiring.mjs";
import {decideRoleFallback} from "./role-fallback.mjs";

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-perm-home-"));
process.env.HOME = isolatedHome;

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
check("(a) planner allow contains command(*)", pAllow.includes("command(*)"), pAllow);
check("(a) planner allow contains scratch write_file rule", pAllow.includes(`write_file(${path.join(tmp, "run-p", "agy")}/)`), pAllow);
check("(a) global ~/.gemini untouched", !pFile.startsWith(path.join(os.homedir(), ".gemini")));

// (b) implementer with gate command
const implArgs = agyRelayExtraArgs({adapter: "antigravity", readOnly: false, roleName: "implementer", config, runDir: path.join(tmp, "run-i"), repo: tmp});
const iAllow = allowOf(implArgs[implArgs.indexOf("--settings") + 1]);
check("(b) implementer allow contains command(*)", iAllow.includes("command(*)"), iAllow);
check("(b) implementer allow contains scratch write_file rule", iAllow.includes(`write_file(${path.join(tmp, "run-i", "agy")}/)`), iAllow);
check("(b) planner and implementer write roles get identical command rules", JSON.stringify(agyAllowRulesForRole("planner", config)) === JSON.stringify(agyAllowRulesForRole("implementer", config)));
check("(b) write role gets exactly ['command(*)']", JSON.stringify(agyAllowRulesForRole("planner", config)) === JSON.stringify(["command(*)"]));

// (c) read-only run and other adapters unchanged
check("(c) read_only agy run gets no extra args", agyRelayExtraArgs({adapter: "antigravity", readOnly: true, roleName: "plan_reviewer", config, runDir: path.join(tmp, "run-r"), repo: tmp}).length === 0);
check("(c) read_only run writes no settings dir", !fs.existsSync(path.join(tmp, "run-r")));
check("(c) non-agy write run gets no extra args", agyRelayExtraArgs({adapter: "codex", readOnly: false, roleName: "planner", config, runDir: path.join(tmp, "run-c"), repo: tmp}).length === 0);

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

// ── Global settings merge & isolation tests ─────────────────────────────
// (a) user allow command(wc) + deny command(git push --force)
const homeA = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-a-"));
const globalDirA = path.join(homeA, ".gemini", "antigravity-cli");
fs.mkdirSync(globalDirA, {recursive: true});
const globalFileA = path.join(globalDirA, "settings.json");
const fakeGlobalA = {
  theme: "dark",
  editor: "cursor",
  permissions: {
    allow: ["command(wc)", "command(*)"], // command(*) is also in our rules -> test deduplication
    deny: ["command(git push --force)"],
    ask: ["command(reboot)"]
  }
};
fs.writeFileSync(globalFileA, JSON.stringify(fakeGlobalA, null, 2), "utf8");
const statBeforeA = fs.statSync(globalFileA);

const runDirA = path.join(tmp, "run-merge-a");
const extraArgsA = agyRelayExtraArgs({
  adapter: "antigravity",
  readOnly: false,
  roleName: "planner",
  config,
  runDir: runDirA,
  repo: tmp,
  homeDir: homeA
});
const settingsPathA = extraArgsA[extraArgsA.indexOf("--settings") + 1];
const parsedA = JSON.parse(fs.readFileSync(settingsPathA, "utf8"));

check("(a) merge: per-run settings has our rules", parsedA.permissions.allow.includes("command(*)") && parsedA.permissions.allow.includes(`write_file(${path.join(runDirA, "agy")}/)`), parsedA.permissions.allow);
check("(a) merge: per-run settings includes user allow command(wc)", parsedA.permissions.allow.includes("command(wc)"), parsedA.permissions.allow);
check("(a) merge: deduplication keeps command(*) exactly once", parsedA.permissions.allow.filter(r => r === "command(*)").length === 1);
check("(a) merge: our rules come first (command(*) before wc)", parsedA.permissions.allow.indexOf("command(*)") < parsedA.permissions.allow.indexOf("command(wc)"));
check("(a) merge: user deny list command(git push --force) preserved", Array.isArray(parsedA.permissions.deny) && parsedA.permissions.deny.includes("command(git push --force)"), parsedA.permissions.deny);
check("(a) merge: other permissions.* list keys (ask) copied unchanged", Array.isArray(parsedA.permissions.ask) && parsedA.permissions.ask.includes("command(reboot)"), parsedA.permissions.ask);
check("(a) merge: non-permission keys not copied", parsedA.theme === undefined && parsedA.editor === undefined && Object.keys(parsedA).length === 1 && parsedA.permissions !== undefined);

// (d) the real global file is never touched (mtime/absence unchanged in temp HOME)
const statAfterA = fs.statSync(globalFileA);
check("(d) global file is never touched (mtime unchanged)", statBeforeA.mtimeMs === statAfterA.mtimeMs && statBeforeA.size === statAfterA.size);
check("(d) global file content unchanged", fs.readFileSync(globalFileA, "utf8") === JSON.stringify(fakeGlobalA, null, 2));

// (b) no global file → only our rules, no crash
const homeB = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-b-"));
const runDirB = path.join(tmp, "run-merge-b");
let threwB = false;
let extraArgsB = null;
try {
  extraArgsB = agyRelayExtraArgs({
    adapter: "antigravity",
    readOnly: false,
    roleName: "planner",
    config,
    runDir: runDirB,
    repo: tmp,
    homeDir: homeB
  });
} catch {
  threwB = true;
}
check("(b) no global file: does not crash", !threwB && Array.isArray(extraArgsB));
const settingsPathB = extraArgsB ? extraArgsB[extraArgsB.indexOf("--settings") + 1] : null;
const parsedB = settingsPathB && fs.existsSync(settingsPathB) ? JSON.parse(fs.readFileSync(settingsPathB, "utf8")) : null;
check("(b) no global file: only our rules in allow", parsedB && parsedB.permissions && parsedB.permissions.allow.includes("command(*)") && parsedB.permissions.allow.includes(`write_file(${path.join(runDirB, "agy")}/)`));
check("(b) no global file: no deny list", parsedB && parsedB.permissions && parsedB.permissions.deny === undefined);
// (d) absence unchanged in temp HOME
const globalBPath = path.join(homeB, AGY_SETTINGS_RELATIVE_PATH);
check("(d) global file absence unchanged in temp HOME", !fs.existsSync(globalBPath));

// (c) invalid JSON global file → only our rules, no crash
const homeC = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-c-"));
const globalDirC = path.join(homeC, ".gemini", "antigravity-cli");
fs.mkdirSync(globalDirC, {recursive: true});
const globalFileC = path.join(globalDirC, "settings.json");
const invalidContentC = "{ this is invalid json :::";
fs.writeFileSync(globalFileC, invalidContentC, "utf8");
const statBeforeC = fs.statSync(globalFileC);

const runDirC = path.join(tmp, "run-merge-c");
let threwC = false;
let extraArgsC = null;
try {
  extraArgsC = agyRelayExtraArgs({
    adapter: "antigravity",
    readOnly: false,
    roleName: "planner",
    config,
    runDir: runDirC,
    repo: tmp,
    homeDir: homeC
  });
} catch {
  threwC = true;
}
check("(c) invalid JSON global file: does not crash", !threwC && Array.isArray(extraArgsC));
const settingsPathC = extraArgsC ? extraArgsC[extraArgsC.indexOf("--settings") + 1] : null;
const parsedC = settingsPathC && fs.existsSync(settingsPathC) ? JSON.parse(fs.readFileSync(settingsPathC, "utf8")) : null;
check("(c) invalid JSON global file: only our rules in allow", parsedC && parsedC.permissions && parsedC.permissions.allow.includes("command(*)") && parsedC.permissions.allow.includes(`write_file(${path.join(runDirC, "agy")}/)`));
check("(c) invalid JSON global file: no deny list", parsedC && parsedC.permissions && parsedC.permissions.deny === undefined);
// (d) invalid global file untouched
const statAfterC = fs.statSync(globalFileC);
check("(d) invalid global file untouched (mtime unchanged)", statBeforeC.mtimeMs === statAfterC.mtimeMs);
check("(d) invalid global file content unchanged", fs.readFileSync(globalFileC, "utf8") === invalidContentC);

// Direct writeAgyAllowRule with homeDir injection and AGY_HOME env override
const runDirDirect = path.join(tmp, "run-direct");
const directPath = writeAgyAllowRule(path.join(runDirDirect, "agy"), ["command(custom)"], {homeDir: homeA});
const parsedDirect = JSON.parse(fs.readFileSync(directPath, "utf8"));
check("writeAgyAllowRule directly merges global settings", parsedDirect.permissions.allow.includes("command(wc)") && parsedDirect.permissions.deny.includes("command(git push --force)"));

process.env.AGY_HOME = homeA;
const runDirEnv = path.join(tmp, "run-env");
const envPath = writeAgyAllowRule(path.join(runDirEnv, "agy"), ["command(envtest)"]);
const parsedEnv = JSON.parse(fs.readFileSync(envPath, "utf8"));
check("writeAgyAllowRule respects AGY_HOME env override", parsedEnv.permissions.allow.includes("command(wc)") && parsedEnv.permissions.deny.includes("command(git push --force)"));
delete process.env.AGY_HOME;

fs.rmSync(homeA, {recursive: true, force: true});
fs.rmSync(homeB, {recursive: true, force: true});
fs.rmSync(homeC, {recursive: true, force: true});
fs.rmSync(isolatedHome, {recursive: true, force: true});
fs.rmSync(tmp, {recursive: true, force: true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
