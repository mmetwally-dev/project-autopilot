#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveCodexHomes,
  findCodexRollout,
  codexUsageFromRollout,
  deleteCodexRollout
} from "./codex-rollout.mjs";
import { resolveCodexHomes as autopilotResolveCodexHomes } from "./autopilot.mjs";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS ${name}`);
    return true;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-codex-home-test-"));
const runDir = path.join(tmpRoot, "runs", "177-code_reviewer");
const disposableScratch = path.join(tmpRoot, "disposable-scratch");

try {
  // 1. Verify helper export and signature
  check("resolveCodexHomes exported from codex-rollout.mjs", typeof resolveCodexHomes === "function");
  check("resolveCodexHomes re-exported from autopilot.mjs", typeof autopilotResolveCodexHomes === "function");

  // 2. Build fixture run layout: <runDir>/scratch/.autopilot-home/.codex/sessions/<y>/<m>/<d>/rollout-...-<thread>.jsonl
  const threadId = "01a1a965-fixture-thread-id";
  const startedAt = new Date("2026-11-05T04:49:36.000Z");
  const y = String(startedAt.getUTCFullYear());
  const m = String(startedAt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(startedAt.getUTCDate()).padStart(2, "0");

  const runScratchHome = path.join(runDir, "scratch", ".autopilot-home", ".codex");
  const sessionDir = path.join(runScratchHome, "sessions", y, m, d);
  fs.mkdirSync(sessionDir, { recursive: true });

  const rolloutFileName = `rollout-2026-11-05T04-49-36-${threadId}.jsonl`;
  const rolloutFilePath = path.join(sessionDir, rolloutFileName);

  const event1 = {
    timestamp: "2026-11-05T04:45:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 300000,
          cached_input_tokens: 250000,
          cache_write_input_tokens: 0,
          output_tokens: 1000,
          reasoning_output_tokens: 200,
          total_tokens: 301000
        },
        last_token_usage: {
          input_tokens: 50000,
          cached_input_tokens: 40000,
          cache_write_input_tokens: 0,
          output_tokens: 200,
          reasoning_output_tokens: 50,
          total_tokens: 50200
        },
        model_context_window: 475000
      }
    }
  };

  const event2 = {
    timestamp: "2026-11-05T04:49:36.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 760138,
          cached_input_tokens: 672640,
          cache_write_input_tokens: 0,
          output_tokens: 2669,
          reasoning_output_tokens: 632,
          total_tokens: 762807
        },
        last_token_usage: {
          input_tokens: 100647,
          cached_input_tokens: 97920,
          cache_write_input_tokens: 0,
          output_tokens: 359,
          reasoning_output_tokens: 223,
          total_tokens: 101006
        },
        model_context_window: 475000
      }
    }
  };

  fs.writeFileSync(rolloutFilePath, `${JSON.stringify(event1)}\n${JSON.stringify(event2)}\n`, "utf8");

  // 3. Separate "disposable" scratch directory without the rollout file
  fs.mkdirSync(disposableScratch, { recursive: true });
  const disposableHome = path.join(disposableScratch, ".autopilot-home", ".codex");

  // 4. Test home-list helper with disposable scratch and runDir
  const resolvedHomes = resolveCodexHomes({
    launchEnv: { HOME: path.join(tmpRoot, "child-home") },
    effectiveScratchDir: disposableScratch,
    dir: runDir
  });

  check("resolveCodexHomes includes run scratch home", resolvedHomes.includes(runScratchHome), {
    resolvedHomes,
    runScratchHome
  });

  check("resolveCodexHomes includes disposable scratch home", resolvedHomes.includes(disposableHome), {
    resolvedHomes,
    disposableHome
  });

  // 5. findCodexRollout with resolvedHomes FINDS the rollout file
  const foundWithResolved = findCodexRollout({
    threadId,
    codexHome: resolvedHomes,
    startedAt
  });
  check("findCodexRollout finds rollout with resolveCodexHomes list", foundWithResolved === rolloutFilePath, {
    actual: foundWithResolved,
    expected: rolloutFilePath
  });

  // 6. findCodexRollout with disposable-only list does NOT find the rollout file
  const disposableOnlyHomes = [disposableHome, path.join(tmpRoot, "fake-user-home", ".codex")];
  const foundDisposableOnly = findCodexRollout({
    threadId,
    codexHome: disposableOnlyHomes,
    startedAt
  });
  check("findCodexRollout returns null for disposable-only list", foundDisposableOnly === null, {
    actual: foundDisposableOnly
  });

  // 7. Verify codexUsageFromRollout parses token values correctly
  const parsedUsage = codexUsageFromRollout(foundWithResolved);
  check("codexUsageFromRollout parsed input matches 760138 - 672640 = 87498", parsedUsage?.input === 87498, {
    actual: parsedUsage?.input,
    expected: 87498
  });
  check("codexUsageFromRollout parsed cacheRead matches 672640", parsedUsage?.cacheRead === 672640, {
    actual: parsedUsage?.cacheRead,
    expected: 672640
  });
  check("codexUsageFromRollout parsed output matches 2669", parsedUsage?.output === 2669, {
    actual: parsedUsage?.output,
    expected: 2669
  });
  check("codexUsageFromRollout parsed contextWindow matches 475000", parsedUsage?.contextWindow === 475000, {
    actual: parsedUsage?.contextWindow,
    expected: 475000
  });
  check("codexUsageFromRollout parsed maxSingleTurnContext matches 100647", parsedUsage?.maxSingleTurnContext === 100647, {
    actual: parsedUsage?.maxSingleTurnContext,
    expected: 100647
  });

  // 8. Test role cases for resolveCodexHomes
  // (a) Writable roles: child's HOME searched first
  const writableChildHome = path.join(tmpRoot, "writable-child-home");
  const writableHomes = resolveCodexHomes({
    launchEnv: { HOME: writableChildHome },
    effectiveScratchDir: null,
    dir: null
  });
  check("writable role searches child's HOME/.codex first", writableHomes[0] === path.join(writableChildHome, ".codex"), {
    actualFirst: writableHomes[0],
    expected: path.join(writableChildHome, ".codex")
  });

  // (b) Read-only roles with disposable workspace: child's HOME + disposable scratch + runDir scratch
  const roDispHomes = resolveCodexHomes({
    launchEnv: { HOME: path.join(tmpRoot, "host-home") },
    effectiveScratchDir: disposableScratch,
    dir: runDir
  });
  check("read-only with disposable workspace includes child HOME/.codex", roDispHomes.includes(path.join(tmpRoot, "host-home", ".codex")));
  check("read-only with disposable workspace includes disposable scratch home", roDispHomes.includes(disposableHome));
  check("read-only with disposable workspace includes runDir scratch home", roDispHomes.includes(runScratchHome));

  // (c) Read-only roles without disposable workspace: runDir scratch is searched
  const roEnvelopeHomes = resolveCodexHomes({
    effectiveScratchDir: path.join(runDir, "scratch"),
    dir: runDir
  });
  check("read-only without disposable workspace includes runDir scratch home", roEnvelopeHomes.includes(runScratchHome));

  // 9. Source checks on autopilot.mjs
  const autopilotSrc = fs.readFileSync(path.join(process.cwd(), "scripts", "autopilot.mjs"), "utf8");

  // Check imports / exports
  check("autopilot.mjs imports resolveCodexHomes", /import\s*\{[^}]*resolveCodexHomes[^}]*\}\s*from\s*"\.\/codex-rollout\.mjs"/.test(autopilotSrc));
  check("autopilot.mjs exports resolveCodexHomes", /export\s*\{\s*resolveCodexHomes\s*\}/.test(autopilotSrc));

  // Locate runRelay body
  const runRelayIdx = autopilotSrc.indexOf("async function runRelay(");
  const runRelayEndIdx = autopilotSrc.indexOf("function guardedShell(", runRelayIdx);
  const runRelayBody = runRelayIdx !== -1 && runRelayEndIdx !== -1 ? autopilotSrc.slice(runRelayIdx, runRelayEndIdx) : "";
  check("runRelay function found in autopilot.mjs", runRelayBody.length > 0);

  // Live read site checks (~line 4165)
  const evaluateCapsIdx = runRelayBody.indexOf("const evaluateCaps=");
  const evaluateIdleIdx = runRelayBody.indexOf("const evaluateIdle=", evaluateCapsIdx);
  const evaluateCapsSlice = evaluateCapsIdx !== -1 && evaluateIdleIdx !== -1 ? runRelayBody.slice(evaluateCapsIdx, evaluateIdleIdx) : "";

  check("evaluateCaps live read calls resolveCodexHomes", evaluateCapsSlice.includes("resolveCodexHomes({launchEnv,effectiveScratchDir,dir})") || evaluateCapsSlice.includes("resolveCodexHomes("));
  check("evaluateCaps live read logs warning on error", evaluateCapsSlice.includes("[codex] rollout usage not read:"));

  // Final read site checks (~line 4440)
  const finalReadIdx = runRelayBody.indexOf("if(role.adapter===\"codex\"){", evaluateIdleIdx);
  const finalReadEndIdx = runRelayBody.indexOf("if(result?.failure?.class===", finalReadIdx);
  const finalReadSlice = finalReadIdx !== -1 && finalReadEndIdx !== -1 ? runRelayBody.slice(finalReadIdx, finalReadEndIdx) : "";

  check("final read site calls resolveCodexHomes", finalReadSlice.includes("resolveCodexHomes({launchEnv,effectiveScratchDir,dir})") || finalReadSlice.includes("resolveCodexHomes("));
  check("final read site logs warning on error", finalReadSlice.includes("[codex] rollout usage not read:"));
  check("final read runs before cleanupDisposableWorkspace", runRelayBody.indexOf("if(role.adapter===\"codex\"){", evaluateIdleIdx) < runRelayBody.indexOf("cleanupDisposableWorkspace();", evaluateIdleIdx));

  // 10. Deletion verification
  deleteCodexRollout(rolloutFilePath);
  check("deleteCodexRollout removes the rollout file", !fs.existsSync(rolloutFilePath));

} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll codex rollout home checks passed.");
