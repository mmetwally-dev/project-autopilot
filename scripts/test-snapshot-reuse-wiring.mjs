#!/usr/bin/env node
// Mission 084 Phase 2 tasks 2.1+2.2+2.3+2.4 — snapshot-reuse wiring test.
// Static assertions: runRelay's before-site consults the snapshot reuse
// cache first (collectSnapshotGuards + decideSnapshotReuse against the
// previous after-snapshot, reusing cached.snapshot on allow, else a fresh
// gitSnapshot), with "snapshot reused" / reason logging; and the after-site
// (after makeRelayResult) stores the fresh after-snapshot only on clean
// relays, clearing with a logged reason and storing nothing on policy
// violation / read-only breach (scenario g). Later phase-2 tasks extend
// this file with invalidation assertions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importNames, functionBody, enclosingBlock } from "./test-fixtures/source-scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

let passed = 0;
function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`ok - ${label}`);
  } else {
    console.error(`FAIL - ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
    process.exitCode = 1;
  }
}

// Text from idx to the end of its enclosing block / from the block start to idx.
const afterWithinBlock = (idx) => { const b = enclosingBlock(autopilotSource, idx); return b ? autopilotSource.slice(idx, b.end) : ""; };
// levels: how many block levels to widen (the neutralize die() sits in a nested `if` inside the block that does the clear).
const beforeWithinBlock = (idx, levels = 1) => {
  let b = enclosingBlock(autopilotSource, idx);
  for (let l = 1; b && l < levels; l++) b = enclosingBlock(autopilotSource, b.start);
  return b ? autopilotSource.slice(b.start, idx) : "";
};

// The before-site lives inside runRelay, after the guard is created.
const guardIdx = autopilotSource.indexOf("createGitMutationGuard(effectiveScratchDir||dir,effectiveCwd)");
const beforeIdx = autopilotSource.indexOf("collectSnapshotGuards(cwd)");
// "Within the enclosing block" instead of a fixed char window.
const beforeBlockRange = beforeIdx !== -1 ? enclosingBlock(autopilotSource, beforeIdx) : null;
const beforeBlock = beforeBlockRange ? autopilotSource.slice(beforeBlockRange.start, beforeBlockRange.end) : "";
check("before-site: runRelay creates the git mutation guard", guardIdx !== -1);
check("before-site: runRelay consults the cache via collectSnapshotGuards(cwd)", beforeIdx !== -1);
check("before-site: cache consultation sits after guard creation", guardIdx !== -1 && beforeIdx > guardIdx);

check(
  "before-site: autopilot.mjs imports the cache helpers from snapshot-reuse-cache.mjs",
  ["collectSnapshotGuards", "decideSnapshotReuse", "getSnapshotCacheKey", "getCachedSnapshot"].every((n) => importNames(autopilotSource, "./snapshot-reuse-cache.mjs").includes(n))
);
check(
  "before-site: cache key lookup via getSnapshotCacheKey(",
  beforeIdx !== -1 && autopilotSource.indexOf("getSnapshotCacheKey(cwd)", beforeIdx) !== -1
);
check(
  "before-site: previous after-snapshot read via getCachedSnapshot(",
  beforeIdx !== -1 && autopilotSource.indexOf("getCachedSnapshot(", beforeIdx) !== -1
);
check(
  "before-site: reuse gate via decideSnapshotReuse(",
  beforeIdx !== -1 && autopilotSource.indexOf("decideSnapshotReuse(", beforeIdx) !== -1
);
check(
  "before-site: reuses the cached snapshot object on allow",
  beforeIdx !== -1 && /cached\?\.snapshot/.test(beforeBlock)
);
check(
  "before-site: direct gitSnapshot( fallback stays inside runRelay after guard creation",
  guardIdx !== -1 &&
    (() => {
      const freshIdx = autopilotSource.indexOf("return gitSnapshot(cwd);", beforeIdx);
      return freshIdx !== -1 && freshIdx > guardIdx;
    })()
);
check(
  "before-site: logs the reuse outcome ('snapshot reused')",
  autopilotSource.includes("snapshot reused")
);
check(
  "before-site: logs the fresh reason on doubt",
  /\[snapshot-reuse\] fresh snapshot:/.test(autopilotSource)
);

// The after-site lives after makeRelayResult: store the fresh
// after-snapshot only on clean relays; on policy violation / read-only
// breach clear the cache with a logged reason and store nothing.
const resultIdx = autopilotSource.indexOf("const result=makeRelayResult(");
// Rest of the enclosing runRelay body after the makeRelayResult site.
const runRelayBody = functionBody(autopilotSource, "function runRelay(");
const afterWindow = resultIdx !== -1 && runRelayBody.includes("const result=makeRelayResult(")
  ? runRelayBody.slice(runRelayBody.indexOf("const result=makeRelayResult(")) : "";
check("after-site: makeRelayResult site exists", resultIdx !== -1);
check(
  "after-site: autopilot.mjs imports the cache store helpers",
  ["setCachedSnapshot", "clearSnapshotReuseCache", "makeCacheEntry"].every((n) => importNames(autopilotSource, "./snapshot-reuse-cache.mjs").includes(n))
);
check(
  "after-site: stores the fresh after-snapshot via setCachedSnapshot(",
  afterWindow.includes("setCachedSnapshot(")
);
check(
  "after-site: builds the entry via makeCacheEntry(",
  afterWindow.includes("makeCacheEntry(")
);
check(
  "after-site: stores the fresh after snapshot object",
  /makeCacheEntry\(\s*cwd\s*,\s*after\s*\)/.test(afterWindow)
);
check(
  "after-site: clears the cache via clearSnapshotReuseCache( on violation",
  afterWindow.includes("clearSnapshotReuseCache(")
);
check(
  "after-site: gates the store on the relay policy violation",
  /result\.policyViolation/.test(afterWindow)
);
check(
  "after-site: gates the store on the read-only breach",
  /result\.readOnlyViolation/.test(afterWindow)
);
check(
  "after-site: violating relays clear with a logged previous-policy-violation reason",
  /previous policy violation/.test(afterWindow)
);
check(
  "after-site: clean relays log the after-snapshot store",
  afterWindow.includes("cached after-snapshot")
);
check(
  "after-site: violating path stores nothing (clear sits in the if, store in the else)",
  (() => {
    const clearIdx = afterWindow.indexOf("clearSnapshotReuseCache(");
    const storeIdx = afterWindow.indexOf("setCachedSnapshot(");
    if (clearIdx === -1 || storeIdx === -1) return false;
    const between = afterWindow.slice(clearIdx, storeIdx);
    return clearIdx < storeIdx && /}else\{/.test(between);
  })()
);

if (process.exitCode) {
  console.error(`\nsnapshot-reuse wiring (before-site) FAILED`);
} else {
  console.log(`\nsnapshot-reuse wiring (before-site): ${passed} checks passed`);
}

// Mission 084 Phase 2 task 2.3 — cache invalidation at phase re-baselines
// (both expectedWorkingFingerprint sites — never reuse across a
// re-baseline, scenario c) and retry pauses (maybeRetryPause, scenario d).
// Each site clears via clearSnapshotReuseCache( with a logged reason.
{
  // Retry-pause site: maybeRetryPause clears with a logged reason.
  const pauseIdx = autopilotSource.indexOf("async function maybeRetryPause(");
  const pauseWindow = functionBody(autopilotSource, "async function maybeRetryPause(");
  check("re-baseline: maybeRetryPause site exists", pauseIdx !== -1);
  check(
    "re-baseline: retry-pause site clears the cache via clearSnapshotReuseCache(",
    pauseWindow.includes("clearSnapshotReuseCache(")
  );
  check(
    "re-baseline: retry-pause clear carries a logged retry-pause reason",
    /retry pause/.test(pauseWindow) && /cache cleared.*retry pause/.test(pauseWindow)
  );

  // Phase re-baseline sites: every expectedWorkingFingerprint assignment is
  // followed (within a short window) by a clear with a logged re-baseline
  // reason.
  const marker = "s.expectedWorkingFingerprint=gitSnapshot(repo).fingerprint";
  const sites = [];
  let from = 0;
  for (;;) {
    const at = autopilotSource.indexOf(marker, from);
    if (at === -1) break;
    sites.push(at);
    from = at + marker.length;
  }
  check("re-baseline: both expectedWorkingFingerprint sites exist", sites.length === 2, sites.length);
  sites.forEach((at, i) => {
    const window = afterWithinBlock(at);
    check(
      `re-baseline: site ${i + 1} clears the cache via clearSnapshotReuseCache(`,
      window.includes("clearSnapshotReuseCache(")
    );
    check(
      `re-baseline: site ${i + 1} clears with a logged expectedWorkingFingerprint re-baseline reason`,
      /expectedWorkingFingerprint re-baseline/.test(window) &&
        /cache cleared.*expectedWorkingFingerprint re-baseline/.test(window)
    );
  });
}

if (process.exitCode) {
  console.error(`\nsnapshot-reuse wiring FAILED`);
} else {
  console.log(`\nsnapshot-reuse wiring: ${passed} checks passed`);
}

// Mission 084 Phase 2 task 2.4 — cache invalidation at gates
// (runGatesInCwd, scenario a) and orchestrator tracked writes
// (standalone + SpecKit mark_tasks via setTaskCheckboxes, plus SpecKit
// checkbox writes via applyTaskCheckboxStates, scenario b). Each site
// clears via clearSnapshotReuseCache( with a logged reason. State writes
// under .autopilot/ (saveState) stay exempt: they touch no tracked files.
{
  // Gates site: runGatesInCwd clears with a logged gates reason.
  const gatesIdx = autopilotSource.indexOf("function runGatesInCwd(");
  const gatesWindow = functionBody(autopilotSource, "function runGatesInCwd(");
  check("gates: runGatesInCwd site exists", gatesIdx !== -1);
  check(
    "gates: runGatesInCwd clears the cache via clearSnapshotReuseCache(",
    gatesWindow.includes("clearSnapshotReuseCache(")
  );
  check(
    "gates: gate clear carries a logged gates-run reason",
    /gates ran between runs/.test(gatesWindow) &&
      /cache cleared.*gates ran between runs/.test(gatesWindow)
  );

  // Gates site (fix round 2/2): the main async gates(c,s) runner used by
  // the standalone and SpecKit loops right before the read-only verifier
  // relay also clears up front with the same logged reason — gate writes
  // to ignored or already-dirty files leave guard hashes unchanged, so a
  // stale pre-gate before-snapshot must never be reused.
  const mainGatesIdx = autopilotSource.indexOf("async function gates(c,s)");
  const mainGatesWindow = functionBody(autopilotSource, "async function gates(c,s)");
  check("gates: async gates(c,s) site exists", mainGatesIdx !== -1);
  check(
    "gates: async gates(c,s) clears the cache via clearSnapshotReuseCache(",
    mainGatesWindow.includes("clearSnapshotReuseCache(")
  );
  check(
    "gates: async gates(c,s) clear carries a logged gates-run reason",
    /gates ran between runs/.test(mainGatesWindow) &&
      /cache cleared.*gates ran between runs/.test(mainGatesWindow)
  );
  check(
    "gates: async gates(c,s) clears before its command loop",
    (() => {
      if (mainGatesIdx === -1) return false;
      const clearIdx = mainGatesWindow.indexOf("clearSnapshotReuseCache(");
      const loopIdx = mainGatesWindow.indexOf("for(const command of c.gates.commands)");
      return clearIdx !== -1 && loopIdx !== -1 && clearIdx < loopIdx;
    })()
  );

  // mark_tasks sites: every setTaskCheckboxes(phaseTasks,true) call is
  // followed (within a short window) by a clear with a logged
  // mark_tasks reason — one standalone, one SpecKit.
  const markMarker = "const marked=setTaskCheckboxes(phaseTasks,true);";
  const markSites = [];
  {
    let from = 0;
    for (;;) {
      const at = autopilotSource.indexOf(markMarker, from);
      if (at === -1) break;
      markSites.push(at);
      from = at + markMarker.length;
    }
  }
  check("mark_tasks: both setTaskCheckboxes sites exist", markSites.length === 2, markSites.length);
  markSites.forEach((at, i) => {
    const window = afterWithinBlock(at);
    check(
      `mark_tasks: site ${i + 1} clears the cache via clearSnapshotReuseCache(`,
      window.includes("clearSnapshotReuseCache(")
    );
    check(
      `mark_tasks: site ${i + 1} clears with a logged mark_tasks reason`,
      /mark_tasks tracked write/.test(window) &&
        /cache cleared.*mark_tasks tracked write/.test(window)
    );
  });
  check(
    "mark_tasks: standalone site keeps its verification-PASS failure message",
    markSites.length === 2 &&
      afterWithinBlock(markSites[0]).includes("Standalone task checkbox marking failed")
  );
  check(
    "mark_tasks: SpecKit site keeps its verification-PASS failure message",
    markSites.length === 2 &&
      afterWithinBlock(markSites[1]).includes("SpecKit task checkbox marking failed")
  );

  // SpecKit checkbox writes: the post-implementer neutralize reconcile,
  // the crash-recovery reconcile, and the shared policy-die helper each
  // clear with a logged orchestrator-tracked-write reason.
  const speckitNeutralize = autopilotSource.indexOf("SpecKit task checkbox validation failed while neutralizing");
  const neutralizeWindow =
    speckitNeutralize !== -1 ? beforeWithinBlock(speckitNeutralize, 2) : "";
  check("checkbox: SpecKit neutralize site exists", speckitNeutralize !== -1);
  check(
    "checkbox: SpecKit neutralize clears via clearSnapshotReuseCache(",
    neutralizeWindow.includes("clearSnapshotReuseCache(")
  );
  check(
    "checkbox: SpecKit neutralize clear carries a logged tracked-write reason",
    /orchestrator tracked write/.test(neutralizeWindow) &&
      /cache cleared.*orchestrator tracked write/.test(neutralizeWindow)
  );

  const recoveryMarker = "const reconciled=applyTaskCheckboxStates(s.pendingCheckboxSnapshot.tasks);";
  const recoveryIdx = autopilotSource.indexOf(recoveryMarker);
  const recoveryWindow = recoveryIdx !== -1 ? afterWithinBlock(recoveryIdx) : "";
  check("checkbox: SpecKit crash-recovery site exists", recoveryIdx !== -1);
  check(
    "checkbox: SpecKit crash-recovery clears via clearSnapshotReuseCache(",
    recoveryWindow.includes("clearSnapshotReuseCache(")
  );
  check(
    "checkbox: SpecKit crash-recovery clear carries a logged tracked-write reason",
    /orchestrator tracked write/.test(recoveryWindow) &&
      /cache cleared.*orchestrator tracked write/.test(recoveryWindow)
  );

  const helperIdx = autopilotSource.indexOf("function reconcileTaskCheckboxesBeforePolicyDie(");
  const helperWindow = helperIdx !== -1 ? autopilotSource.slice(helperIdx, helperIdx + 1000) : "";
  check("checkbox: policy-die reconcile helper exists", helperIdx !== -1);
  check(
    "checkbox: policy-die helper clears via clearSnapshotReuseCache(",
    helperWindow.includes("clearSnapshotReuseCache(")
  );
  check(
    "checkbox: policy-die helper clear carries a logged tracked-write reason",
    /orchestrator tracked write/.test(helperWindow) &&
      /cache cleared.*orchestrator tracked write/.test(helperWindow)
  );

  // .autopilot/ writes stay exempt: saveState (atomic state.json write)
  // never touches the snapshot reuse cache.
  const saveStateLine = autopilotSource.split("\n").find((l) => l.includes("const saveState=")) || "";
  check("exempt: saveState site exists", saveStateLine !== "");
  check(
    "exempt: saveState (.autopilot/ write) never clears the cache",
    !saveStateLine.includes("clearSnapshotReuseCache(")
  );
}

// Mission 084 Phase 3 task 3.1 — both loops (standalone + SpecKit) route
// through the wired relay before/after sites. The before-site
// (collectSnapshotGuards/decideSnapshotReuse) and after-site
// (setCachedSnapshot/clearSnapshotReuseCache) both live inside runRelay;
// both per-task loops reach them via relay("implementer",...) which
// delegates to runRelay(. Pin: relay() delegates to runRelay(, the
// standalone loop window (runStandaloneImplementation) holds its own
// relay("implementer" site (with the "Standalone" reconcile marker), and
// the SpecKit loop window (runImplementation past the standalone/gsd
// early-returns) holds its own relay("implementer" site (with the
// "SpecKit" reconcile marker) — so cache use is pinned on both paths and
// neither loop can bypass the wired sites without failing this test.
{
  const relayIdx = autopilotSource.indexOf("function relay(roleName,task,c,s,options={})");
  const relayWindow = relayIdx !== -1 ? autopilotSource.slice(relayIdx, relayIdx + 800) : "";
  check("loops: relay() helper exists", relayIdx !== -1);
  check(
    "loops: relay() delegates to the wired runRelay(",
    relayWindow.includes("runRelay(")
  );

  const standaloneIdx = autopilotSource.indexOf("async function runStandaloneImplementation(c,s)");
  const standaloneEnd = autopilotSource.indexOf("async function runImplementation(c)", standaloneIdx);
  const standaloneWindow =
    standaloneIdx !== -1
      ? autopilotSource.slice(standaloneIdx, standaloneEnd !== -1 ? standaloneEnd : standaloneIdx + 120000)
      : "";
  check("loops: runStandaloneImplementation loop exists", standaloneIdx !== -1);
  check(
    "loops: standalone loop routes implementer work through relay(",
    standaloneWindow.includes('await relay("implementer"')
  );
  check(
    "loops: standalone relay site is the Standalone loop (not the SpecKit twin)",
    standaloneWindow.includes('"Standalone"') &&
      standaloneWindow.indexOf('await relay("implementer"') !== -1
  );

  const implIdx = autopilotSource.indexOf("async function runImplementation(c)");
  const implWindow = implIdx !== -1 ? autopilotSource.slice(implIdx) : "";
  const gsdReturn = implWindow.indexOf("return await runGsdImplementation(c,s);");
  const speckitWindow = gsdReturn !== -1 ? implWindow.slice(gsdReturn) : implWindow;
  check("loops: runImplementation (SpecKit path) exists", implIdx !== -1);
  check(
    "loops: SpecKit loop routes implementer work through relay(",
    speckitWindow.includes('await relay("implementer"')
  );
  check(
    "loops: SpecKit relay site is the SpecKit loop (not the standalone twin)",
    speckitWindow.includes('"SpecKit"') &&
      speckitWindow.indexOf('await relay("implementer"') !== -1
  );
  check(
    "loops: both loops share the single wired runRelay before-site",
    (standaloneWindow.match(/await relay\("implementer"/g) || []).length >= 1 &&
      (speckitWindow.match(/await relay\("implementer"/g) || []).length >= 1 &&
      autopilotSource.indexOf("collectSnapshotGuards(cwd)") !== -1 &&
      autopilotSource.indexOf("async function runRelay(") !== -1
  );
}

if (process.exitCode) {
  console.error(`\nsnapshot-reuse wiring (task 3.1) FAILED`);
} else {
  console.log(`\nsnapshot-reuse wiring (task 3.1): ${passed} checks passed`);
}

// Mission 084 Phase 3 task 3.2 — read-only/policy verdict inputs are
// unchanged: the verdict call sites still receive full snapshot objects
// (before/after), and any doubt path takes a fresh snapshot. The reuse
// cache only swaps WHICH snapshot object the before-site binds — it never
// narrows what the verdict sees, and a fresh gitSnapshot(cwd) backs every
// doubt path plus the after-site.
{
  // makeRelayResult still destructures full before/after snapshot objects.
  const sigIdx = autopilotSource.indexOf("function makeRelayResult({");
  const sigWindow = sigIdx !== -1 ? autopilotSource.slice(sigIdx, sigIdx + 600) : "";
  check("verdict-shape: makeRelayResult signature exists", sigIdx !== -1);
  check(
    "verdict-shape: makeRelayResult still takes full before/after snapshot objects",
    /before,after/.test(sigWindow)
  );

  // Verdict derivations inside makeRelayResult consume before/after objects.
  const relayBody = sigIdx !== -1 ? autopilotSource.slice(sigIdx, sigIdx + 4000) : "";
  check(
    "verdict-shape: touchedFiles verdict still receives (before,after,cwd)",
    relayBody.includes("touchedFilesBetween(before,after,cwd)")
  );
  check(
    "verdict-shape: read-only verdict still compares before/after fingerprints",
    relayBody.includes("before.fingerprint!==after.fingerprint")
  );
  check(
    "verdict-shape: git-state evidence still receives (before,after)",
    relayBody.includes("describeGitStateChange(before,after)")
  );
  check(
    "verdict-shape: policy classification still receives before,after",
    /classifyGitBlocks\(guardEvents,\{[^}]*before,after[^}]*\}\)/.test(relayBody)
  );

  // Relay call site passes the before/after objects through (shorthand, not
  // fingerprints or narrowed projections).
  const callIdx = autopilotSource.indexOf("const result=makeRelayResult({");
  const callWindow = callIdx !== -1 ? autopilotSource.slice(callIdx, callIdx + 600) : "";
  check("verdict-shape: makeRelayResult call site exists", callIdx !== -1);
  check(
    "verdict-shape: call site still passes full before,after snapshot objects",
    /before,after/.test(callWindow)
  );

  // The after-site verdict input is always a fresh snapshot, never reused.
  const afterDecl = callIdx !== -1 ? autopilotSource.slice(Math.max(0, callIdx - 800), callIdx) : "";
  check(
    "verdict-shape: after verdict input is a fresh gitSnapshot(cwd), never cached.snapshot",
    afterDecl.includes("const after=gitSnapshot(cwd);") && !/cached\?\.snapshot/.test(afterDecl)
  );

  // Any doubt path takes a fresh snapshot: the guard-collection catch and
  // the reuse-denied fallthrough both return gitSnapshot(cwd) with a logged
  // fresh reason.
  const doubtIdx = autopilotSource.indexOf("const before=(()=>{");
  const doubtWindow = doubtIdx !== -1 ? autopilotSource.slice(doubtIdx, doubtIdx + 1400) : "";
  check("fresh-on-doubt: before-site doubt block exists", doubtIdx !== -1);
  check(
    "fresh-on-doubt: guard-collection failure path takes a fresh snapshot with a logged reason",
    /guard collection failed/.test(doubtWindow) && doubtWindow.includes("return gitSnapshot(cwd);")
  );
  check(
    "fresh-on-doubt: reuse-denied path falls through to a fresh gitSnapshot(cwd)",
    (() => {
      const first = doubtWindow.indexOf("return gitSnapshot(cwd);");
      if (first === -1) return false;
      const denyLog = doubtWindow.indexOf("[snapshot-reuse] fresh snapshot:");
      return denyLog !== -1 && denyLog < first;
    })()
  );
  check(
    "fresh-on-doubt: after-site stores the fresh after object via makeCacheEntry(cwd,after)",
    (callIdx !== -1 ? autopilotSource.slice(callIdx, callIdx + 1300) : "").includes("makeCacheEntry(cwd,after)")
  );
}

if (process.exitCode) {
  console.error(`\nsnapshot-reuse wiring (task 3.2) FAILED`);
} else {
  console.log(`\nsnapshot-reuse wiring (task 3.2): ${passed} checks passed`);
}

// Mission 084 fix round 1/2 — topology enforcement on the snapshot-reuse
// path: the reuse branch must call assertSupportedTopology(cwd) before
// returning cached.snapshot, so a worktree registered within the reuse
// window (HEAD/index/status unchanged) still fails closed before spawn
// instead of launching and only failing at the after-snapshot.
{
  const relayGuardsSource = fs.readFileSync(path.join(here, "relay-guards.mjs"), "utf8");
  check(
    "topology-reuse: relay-guards.mjs exports assertSupportedTopology",
    /export\s+function\s+assertSupportedTopology\s*\(/.test(relayGuardsSource)
  );
  check(
    "topology-reuse: autopilot.mjs imports assertSupportedTopology from relay-guards.mjs",
    /import\s*\{[^}]*\bassertSupportedTopology\b[^}]*\}\s*from\s*["']\.\/relay-guards\.mjs["']/.test(autopilotSource)
  );
  const reuseIdx = autopilotSource.indexOf("const before=(()=>{");
  const reuseWindow = reuseIdx !== -1 ? autopilotSource.slice(reuseIdx, reuseIdx + 1600) : "";
  const assertIdx = reuseWindow.indexOf("assertSupportedTopology(cwd)");
  const returnIdx = reuseWindow.indexOf("return cached.snapshot;");
  check("topology-reuse: reuse branch exists", reuseIdx !== -1 && returnIdx !== -1);
  check(
    "topology-reuse: reuse branch calls assertSupportedTopology(cwd) before returning cached.snapshot",
    assertIdx !== -1 && returnIdx !== -1 && assertIdx < returnIdx
  );
  check(
    "topology-reuse: reuse gate still via decideSnapshotReuse(",
    reuseWindow.includes("decideSnapshotReuse(")
  );
}

if (process.exitCode) {
  console.error(`\nsnapshot-reuse wiring (topology-reuse) FAILED`);
} else {
  console.log(`\nsnapshot-reuse wiring (topology-reuse): ${passed} checks passed`);
}
