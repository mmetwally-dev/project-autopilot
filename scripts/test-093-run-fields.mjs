#!/usr/bin/env node
// Mission 093 Part 1 task 2.3: run-scoped fields snapshotBeforeAt /
// snapshotAfterAt / sessionNumber.
// initRun seeds the trio (null when the run owns no snapshot/scope);
// updateRunSnapshots persists them mid-run without touching other keys;
// resolveSessionNumber maps a continuation scope to used-at-launch + 1 (null
// without a scope); finalizeRun keeps the trio and already persists the peak
// per-turn context usage.maxSingleTurnContext (asserted here, computed
// nowhere new). Autopilot source pins prove the before/after snapshot sites,
// the relay contScope threading, and the result.json path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRun, updateRunSnapshots, finalizeRun } from "./run-observability.mjs";
import { continuationBudgetKey, resolveSessionNumber } from "./per-task-budget.mjs";
import { callArgs, callOptions, optionKeys, importNames } from "./test-fixtures/source-scan.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};
const readStatus = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
const autopilotSource = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const historySource = fs.readFileSync(new URL("./run-history.mjs", import.meta.url), "utf8");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "093-run-fields-"));

// ── 1. initRun defaults: trio null, nothing fabricated ───────────────────
const dirBare = path.join(root, "bare");
initRun(dirBare, { role: "implementer", runId: "run-bare" });
{
  const st = readStatus(dirBare);
  check("bare: snapshotBeforeAt null", st.snapshotBeforeAt === null, st.snapshotBeforeAt);
  check("bare: snapshotAfterAt null", st.snapshotAfterAt === null, st.snapshotAfterAt);
  check("bare: sessionNumber null", st.sessionNumber === null, st.sessionNumber);
}

// ── 2. initRun persists supplied trio ────────────────────────────────────
const dirSeed = path.join(root, "seed");
initRun(dirSeed, {
  role: "implementer", runId: "run-seed",
  snapshotBeforeAt: "2026-10-15T10:00:00.000Z", snapshotAfterAt: null, sessionNumber: 2,
});
{
  const st = readStatus(dirSeed);
  check("seed: snapshotBeforeAt persisted", st.snapshotBeforeAt === "2026-10-15T10:00:00.000Z", st.snapshotBeforeAt);
  check("seed: snapshotAfterAt stays null", st.snapshotAfterAt === null, st.snapshotAfterAt);
  check("seed: sessionNumber persisted", st.sessionNumber === 2, st.sessionNumber);
}

// ── 3. updateRunSnapshots: before/after sites merge, nothing else moves ──
{
  const okBefore = updateRunSnapshots(dirSeed, { snapshotBeforeAt: "2026-10-15T10:00:00.000Z" });
  check("update: before-site returns true", okBefore === true, okBefore);
  const okAfter = updateRunSnapshots(dirSeed, { snapshotAfterAt: "2026-10-15T10:05:00.000Z" });
  check("update: after-site returns true", okAfter === true, okAfter);
  const st = readStatus(dirSeed);
  check("update: after persisted", st.snapshotAfterAt === "2026-10-15T10:05:00.000Z", st.snapshotAfterAt);
  check("update: before preserved", st.snapshotBeforeAt === "2026-10-15T10:00:00.000Z", st.snapshotBeforeAt);
  check("update: sessionNumber preserved", st.sessionNumber === 2, st.sessionNumber);
  check("update: role preserved", st.role === "implementer", st.role);
}

// ── 4. updateRunSnapshots: unknown keys ignored, empty/non-object no-op ──
{
  const ok = updateRunSnapshots(dirSeed, { model: "LEGACY-MUST-NOT-LAND", unknown: 1 });
  const st = readStatus(dirSeed);
  check("update: ignores legacy model key", !("model" in st), Object.keys(st));
  check("update: ignores unknown keys", !("unknown" in st), Object.keys(st));
  check("update: unknown-only patch returns false", ok === false, ok);
  check("update: empty patch is a no-op", updateRunSnapshots(dirSeed, {}) === false, null);
  check("update: non-object patch is a no-op", updateRunSnapshots(dirSeed, null) === false, null);
}

// ── 5. resolveSessionNumber: used-at-launch + 1, null without a scope ────
{
  check("session: null scope -> null", resolveSessionNumber({ continuationBudgets: {} }, null) === null, null);
  check("session: empty scope -> null", resolveSessionNumber({ continuationBudgets: {} }, "") === null, null);
  check("session: missing ledger -> 1", resolveSessionNumber({}, "task:standalone:phase-0:T1") === 1, null);
  const s2 = { continuationBudgets: { [continuationBudgetKey("task:standalone:phase-0:T1")]: 0 } };
  check("session: used 0 -> 1", resolveSessionNumber(s2, "task:standalone:phase-0:T1") === 1, s2);
  const s3 = { continuationBudgets: { [continuationBudgetKey("task:standalone:phase-0:T1")]: 2 } };
  check("session: used 2 -> 3", resolveSessionNumber(s3, "task:standalone:phase-0:T1") === 3, s3);
  const sBad = { continuationBudgets: { [continuationBudgetKey("task:x")]: "nope" } };
  check("session: non-integer ledger degrades to 1, never fabricated", resolveSessionNumber(sBad, "task:x") === 1, sBad);
}

// ── 6. finalizeRun: trio survives + peak per-turn context persisted ──────
{
  const dirFin = path.join(root, "fin");
  initRun(dirFin, {
    role: "implementer", runId: "run-fin",
    snapshotBeforeAt: "2026-10-15T10:00:00.000Z", snapshotAfterAt: "2026-10-15T10:05:00.000Z", sessionNumber: 1,
  });
  const startedAt = readStatus(dirFin).started_at;
  finalizeRun(dirFin, {
    status: "completed", exitCode: 0, decision: "PASS", startedAt,
    usage: { input: 100, cacheRead: 200, cacheCreation: 0, output: 10, turns: 3, maxSingleTurnContext: 50000 },
  });
  const st = readStatus(dirFin);
  check("finalize: snapshotBeforeAt survives", st.snapshotBeforeAt === "2026-10-15T10:00:00.000Z", st.snapshotBeforeAt);
  check("finalize: snapshotAfterAt survives", st.snapshotAfterAt === "2026-10-15T10:05:00.000Z", st.snapshotAfterAt);
  check("finalize: sessionNumber survives", st.sessionNumber === 1, st.sessionNumber);
  check("finalize: peak per-turn context persisted", st.usage?.maxSingleTurnContext === 50000, st.usage);
}

// ── 7. Autopilot wiring pins ─────────────────────────────────────────────
// Option-presence checks (extra options / ordering tolerated).
const initRunOpts = callArgs(autopilotSource, "initRun(dir,{").map(callOptions);
const hasOpts = (optsText, keys, exact = []) => {
  const k = optionKeys(optsText);
  return keys.every((x) => k.includes(x)) && exact.every((e) => optsText.includes(e));
};
check("wire: seed initRun carries sessionNumber with null snapshots",
  initRunOpts.some((o) => !optionKeys(o).includes("pid")
    && hasOpts(o, ["role", "runId", "...meta", "configuredModel", "resolvedModel", "modelMismatch", "sessionNumber", "snapshotBeforeAt", "snapshotAfterAt"],
      ["resolvedModel:null", "modelMismatch:null", "snapshotBeforeAt:null", "snapshotAfterAt:null"])));
check("wire: onStart re-init carries the trio forward",
  initRunOpts.some((o) => optionKeys(o).includes("pid")
    && hasOpts(o, ["pid", "role", "runId", "...meta", "configuredModel", "resolvedModel", "modelMismatch", "sessionNumber", "snapshotBeforeAt", "snapshotAfterAt"],
      ["resolvedModel:null", "modelMismatch:null", "snapshotAfterAt:null"])
    && !/snapshotBeforeAt:/.test(o)));
{
  const beforeIdx = autopilotSource.indexOf("const before=(()=>{");
  const beforeAtIdx = autopilotSource.indexOf("const snapshotBeforeAt=now();");
  check("wire: snapshotBeforeAt recorded at the before-snapshot",
    beforeIdx !== -1 && beforeAtIdx !== -1 && beforeIdx < beforeAtIdx, { beforeIdx, beforeAtIdx });
  const afterIdx = autopilotSource.indexOf("const after=gitSnapshot(cwd);");
  const afterAtIdx = autopilotSource.indexOf("const snapshotAfterAt=now();");
  check("wire: snapshotAfterAt recorded at the after-snapshot",
    afterIdx !== -1 && afterAtIdx !== -1 && afterIdx < afterAtIdx, { afterIdx, afterAtIdx });
}
check("wire: before-site persists via updateRunSnapshots",
  /updateRunSnapshots\(dir,\{snapshotBeforeStartedAt,snapshotBeforeAt\}\)/.test(autopilotSource));
check("wire: after-site persists via updateRunSnapshots",
  /updateRunSnapshots\(dir,\{snapshotAfterStartedAt,snapshotAfterAt\}\)/.test(autopilotSource));
check("wire: sessionNumber is used-at-launch + 1 via continuationBudgetKey",
  /resolveSessionNumber\(s,contScope[,)]/.test(autopilotSource)
  && importNames(autopilotSource, "./per-task-budget.mjs").includes("resolveSessionNumber"));
check("wire: relay/runRelay/relayAsync thread contScope",
  (() => {
    const runRelayOpts = callArgs(autopilotSource, "runRelay(roleName,").map(callOptions);
    const relayCall = runRelayOpts.find((o) => o.includes("alwaysSave:false"));
    // Every internal re-run (fallback + #112 session-retry) must thread contScope.
    const retryCalls = runRelayOpts.filter((o) => optionKeys(o).includes("__fallbackDepth"));
    const asyncCall = runRelayOpts.find((o) => o.includes("alwaysSave:true"));
    return !!relayCall && retryCalls.length >= 2 && !!asyncCall
      && hasOpts(relayCall, ["readOnly", "resume", "review", "persistState", "requirements", "taskFacts", "timeoutMs", "taskRef", "capEnabled", "contScope"])
      && retryCalls.every((o) => hasOpts(o, ["capEnabled", "contScope", "__fallbackDepth"]))
      && hasOpts(asyncCall, ["taskFacts", "taskRef", "timeoutMs", "capEnabled", "contScope"]);
  })());
check("wire: standalone attempt passes its continuation scope",
  /contScope:`task:standalone:phase-\$\{s\.phaseIndex\}:\$\{taskId\}`/.test(autopilotSource));
check("wire: speckit attempt passes its continuation scope",
  /contScope:`task:speckit:phase-\$\{s\.phaseIndex\}:\$\{taskId\}`/.test(autopilotSource));
check("wire: makeRelayResult carries the trio onto the result",
  callArgs(autopilotSource, "function makeRelayResult(").some((c) => hasOpts(callOptions(c), ["snapshotBeforeAt", "snapshotAfterAt", "sessionNumber", "planRevision", "carriedForwardTasks"], ["snapshotBeforeAt=null", "snapshotAfterAt=null", "sessionNumber=null"]))
  && /snapshotBeforeAt:snapshotBeforeAt\?\?null,/.test(autopilotSource)
  && /snapshotAfterAt:snapshotAfterAt\?\?null,/.test(autopilotSource)
  && /sessionNumber:sessionNumber\?\?null,/.test(autopilotSource));
check("wire: relay result passes the trio into makeRelayResult",
  callArgs(autopilotSource, "makeRelayResult(").some((c) => hasOpts(callOptions(c), ["modelResolution", "snapshotBeforeAt", "snapshotAfterAt", "sessionNumber", "planRevision", "carriedForwardTasks"], ["planRevision:planRevisionValue", "carriedForwardTasks:carriedForwardTasksValue"])));
check("wire: finalizeRun still persists the peak-context usage",
  /finalizeRun\(dir,\{status:capBreach\?"capped":result\.status,exitCode:p\.status,decision:result\.verdict\?\.decision\|\|null,startedAt:started,usage:result\.usage/.test(autopilotSource));
check("wire: run-history rendering has no run-scoped fields",
  !/snapshotBeforeAt|snapshotAfterAt|sessionNumber/.test(historySource));

fs.rmSync(root, { recursive: true, force: true });

if (failures.length) { console.error(`${failures.length} run-fields check(s) failed.`); process.exit(1); }
console.log("All run-fields checks passed.");
