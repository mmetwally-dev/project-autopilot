#!/usr/bin/env node
// Backlog #8: Out-of-repo denied write same-model retry & free model daily quota reset.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  isOutOfRepoWritePermissionDenied,
  isPathInsideRepo,
  isPathInCliDataDir,
  extractAgyDeniedActionPaths,
  decideDeniedWriteRetry,
} from "./agy-events.mjs";

const HOME = os.homedir();

import {
  markExhausted,
  isExhausted,
  pruneExhausted,
  staleStickyFallback,
  stampStickyFallback,
  nextResetTime,
  DEFAULT_DAILY_RESET_TIME,
  FREE_QUOTA_REASON,
  resolveEffectiveRoleModel,
} from "./role-fallback.mjs";

import {
  validateAdvancedConfig,
  validateNewConfig,
} from "./config-validation.mjs";

import {
  toRuntimeConfig,
  toNewLayoutConfig,
} from "./config-layout.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

console.log("Starting test-backlog-8-out-of-repo-fallback...");

// =========================================================================
// 1. Path checking helpers: isPathInsideRepo & isPathInCliDataDir
// =========================================================================
{
  assert.equal(isPathInsideRepo("src/index.js", repoRoot), true);
  assert.equal(isPathInsideRepo("package.json", repoRoot), true);
  assert.equal(isPathInsideRepo(path.join(repoRoot, "sub/file.txt"), repoRoot), true);

  assert.equal(isPathInsideRepo(`${HOME}/.gemini/antigravity-cli/brain`, repoRoot), false);
  assert.equal(isPathInsideRepo("/tmp/scratch.txt", repoRoot), false);
  assert.equal(isPathInsideRepo("../outside.js", repoRoot), false);

  const customCliDir = `${HOME}/.gemini/antigravity-cli`;
  assert.equal(isPathInCliDataDir(`${HOME}/.gemini/antigravity-cli/brain/../..`, customCliDir), true);
  assert.equal(isPathInCliDataDir(`${HOME}/.gemini/antigravity-cli/logs/run.log`, customCliDir), true);
  assert.equal(isPathInCliDataDir(path.join(repoRoot, "src/index.js"), customCliDir), false);
  assert.equal(isPathInCliDataDir("src/index.js", customCliDir, repoRoot), false);

  console.log("PASS 1: path inside repo and cli data dir detection");
}

// =========================================================================
// 2. extractAgyDeniedActionPaths
// =========================================================================
{
  const events = [
    {
      step_update: {
        step_type: "tool",
        tool_name: "write_file",
        tool_info: {
          name: "write_file",
          parameters: {Path: `${HOME}/.gemini/antigravity-cli/brain/artifacts/doc.md`},
        },
      },
    },
  ];

  const extracted = extractAgyDeniedActionPaths(["write_file"], events);
  assert.equal(extracted.allResolved, true);
  assert.deepEqual(extracted.paths, [`${HOME}/.gemini/antigravity-cli/brain/artifacts/doc.md`]);

  // Action string carrying path directly in parentheses
  const direct = extractAgyDeniedActionPaths(["write_file(/tmp/out.txt)"], []);
  assert.equal(direct.allResolved, true);
  assert.deepEqual(direct.paths, ["/tmp/out.txt"]);

  // Unresolvable action
  const unresolvable = extractAgyDeniedActionPaths(["unknown_action"], []);
  assert.equal(unresolvable.allResolved, false);
  assert.deepEqual(unresolvable.paths, []);

  console.log("PASS 2: extractAgyDeniedActionPaths handles tool_info and inline paths");
}

// =========================================================================
// 3. isOutOfRepoWritePermissionDenied
// =========================================================================
{
  const makeResult = (paths = [], actions = ["write_file"]) => ({
    status: "failed",
    failure: {
      class: "PERMISSION_DENIED",
      domain: "adapter",
      retryable: false,
      evidence: [
        {
          type: "permission_denied",
          reason: "denied_actions",
          actions,
          paths,
          targets: paths,
        },
      ],
    },
    observations: [
      {
        type: "permission_denied",
        paths,
        targets: paths,
      },
    ],
  });

  // Out-of-repo CLI data dir
  const outOfRepoRes = makeResult([`${HOME}/.gemini/antigravity-cli/brain/../..`]);
  assert.equal(isOutOfRepoWritePermissionDenied(outOfRepoRes, repoRoot, []), true);

  // Out-of-repo arbitrary path
  const outOfRepoArbitrary = makeResult(["/var/data/output.txt"]);
  assert.equal(isOutOfRepoWritePermissionDenied(outOfRepoArbitrary, repoRoot, []), true);

  // In-repo write denied -> false
  const inRepoRes = makeResult([path.join(repoRoot, "src/index.js")]);
  assert.equal(isOutOfRepoWritePermissionDenied(inRepoRes, repoRoot, []), false);

  // Mixed: one in-repo, one out-of-repo -> false
  const mixedRes = makeResult([`${HOME}/.gemini/antigravity-cli/brain`, path.join(repoRoot, "package.json")]);
  assert.equal(isOutOfRepoWritePermissionDenied(mixedRes, repoRoot, []), false);

  // No path resolved -> false
  const noPathRes = {
    status: "failed",
    failure: {
      class: "PERMISSION_DENIED",
      domain: "adapter",
      retryable: false,
      evidence: [{type: "permission_denied", actions: ["write_file"]}],
    },
    observations: [{type: "permission_denied", actions: ["write_file"]}],
  };
  assert.equal(isOutOfRepoWritePermissionDenied(noPathRes, repoRoot, []), false);

  // Non-PERMISSION_DENIED -> false
  const rateLimitRes = {
    status: "failed",
    failure: {class: "RATE_LIMITED", domain: "infrastructure"},
  };
  assert.equal(isOutOfRepoWritePermissionDenied(rateLimitRes, repoRoot, []), false);

  console.log("PASS 3: isOutOfRepoWritePermissionDenied classification");
}

// =========================================================================
// 4. decideDeniedWriteRetry (pure decision function extracted from runRelay)
// =========================================================================
{
  const scratchDir = "/repo/.autopilot/scratch";

  // 4a. First out-of-repo denied write: retry on same model with note, no fallback
  const outOfRepoResult1 = {
    status: "failed",
    failure: {
      class: "PERMISSION_DENIED",
      domain: "adapter",
      evidence: [{
        type: "permission_denied",
        paths: [`${HOME}/.gemini/antigravity-cli/brain/artifact`],
      }],
    },
    observations: [{
      type: "permission_denied",
      paths: [`${HOME}/.gemini/antigravity-cli/brain/artifact`],
    }],
  };

  const decision1 = decideDeniedWriteRetry({
    result: outOfRepoResult1,
    repo: repoRoot,
    events: [],
    retries: {},
    taskKey: "T080",
    scratch: scratchDir,
  });
  assert.equal(decision1.retry, true);
  assert.equal(decision1.nextRetries["T080"], 1);
  assert.equal(decision1.note, `Write only inside the repository; your scratch dir is ${scratchDir}.`);
  console.log("PASS 4a: first out-of-repo denied write yields retry:true with scratch note");

  // 4b. Second out-of-repo denied write for the SAME task: retry:false (leads to fallback)
  const outOfRepoResult2 = {
    status: "failed",
    failure: {
      class: "PERMISSION_DENIED",
      domain: "adapter",
      evidence: [{
        type: "permission_denied",
        paths: [`${HOME}/.gemini/antigravity-cli/brain/artifact2`],
      }],
    },
    observations: [{
      type: "permission_denied",
      paths: [`${HOME}/.gemini/antigravity-cli/brain/artifact2`],
    }],
  };

  const decision2 = decideDeniedWriteRetry({
    result: outOfRepoResult2,
    repo: repoRoot,
    events: [],
    retries: decision1.nextRetries,
    taskKey: "T080",
    scratch: scratchDir,
  });
  assert.equal(decision2.retry, false);
  assert.equal(decision2.note, null);
  assert.equal(decision2.nextRetries["T080"], 1);
  console.log("PASS 4b: second out-of-repo denied write yields retry:false");

  // 4c. In-repo denied write: retry:false (immediate fallback)
  const inRepoResult = {
    status: "failed",
    failure: {
      class: "PERMISSION_DENIED",
      domain: "adapter",
      evidence: [{
        type: "permission_denied",
        paths: [path.join(repoRoot, "src/index.js")],
      }],
    },
    observations: [{
      type: "permission_denied",
      paths: [path.join(repoRoot, "src/index.js")],
    }],
  };
  const decision3 = decideDeniedWriteRetry({
    result: inRepoResult,
    repo: repoRoot,
    events: [],
    retries: {},
    taskKey: "T081",
    scratch: scratchDir,
  });
  assert.equal(decision3.retry, false);
  assert.equal(decision3.note, null);
  console.log("PASS 4c: in-repo denied write yields retry:false");

  // 4d. Denied write with unknown/missing path or readOnly: retry:false
  const noPathResult = {
    status: "failed",
    failure: {
      class: "PERMISSION_DENIED",
      domain: "adapter",
      evidence: [{type: "permission_denied", actions: ["write_file"]}],
    },
    observations: [{type: "permission_denied", actions: ["write_file"]}],
  };
  const decision4 = decideDeniedWriteRetry({
    result: noPathResult,
    repo: repoRoot,
    events: [],
    retries: {},
    taskKey: "T082",
    scratch: scratchDir,
  });
  assert.equal(decision4.retry, false);
  assert.equal(decision4.note, null);

  const readOnlyDecision = decideDeniedWriteRetry({
    result: outOfRepoResult1,
    repo: repoRoot,
    events: [],
    retries: {},
    taskKey: "T083",
    scratch: scratchDir,
    readOnly: true,
  });
  assert.equal(readOnlyDecision.retry, false);
  assert.equal(readOnlyDecision.note, null);
  console.log("PASS 4d: denied write without path and readOnly yield retry:false");
}

// =========================================================================
// 5. nextResetTime calculation
// =========================================================================
{
  // Construct date at 2026-11-18 19:38 local
  const base1 = new Date(2026, 10, 18, 19, 38, 0, 0).getTime();
  const reset1 = nextResetTime(base1, "03:00");
  const dReset1 = new Date(reset1);
  assert.equal(dReset1.getFullYear(), 2026);
  assert.equal(dReset1.getMonth(), 10);
  assert.equal(dReset1.getDate(), 19);
  assert.equal(dReset1.getHours(), 3);
  assert.equal(dReset1.getMinutes(), 0);

  // Construct date at 2026-11-19 02:59 local (before 03:00)
  const base2 = new Date(2026, 10, 19, 2, 59, 0, 0).getTime();
  const reset2 = nextResetTime(base2, "03:00");
  const dReset2 = new Date(reset2);
  assert.equal(dReset2.getDate(), 19);
  assert.equal(dReset2.getHours(), 3);

  // Construct date at 2026-11-19 03:00 local (at reset time) -> advances to next day
  const base3 = new Date(2026, 10, 19, 3, 0, 0, 0).getTime();
  const reset3 = nextResetTime(base3, "03:00");
  const dReset3 = new Date(reset3);
  assert.equal(dReset3.getDate(), 20);
  assert.equal(dReset3.getHours(), 3);

  // Custom reset time "05:30"
  const base4 = new Date(2026, 10, 19, 4, 0, 0, 0).getTime();
  const reset4 = nextResetTime(base4, "05:30");
  const dReset4 = new Date(reset4);
  assert.equal(dReset4.getDate(), 19);
  assert.equal(dReset4.getHours(), 5);
  assert.equal(dReset4.getMinutes(), 30);

  console.log("PASS 5: nextResetTime calculation for same-day and next-day boundaries");
}

// =========================================================================
// 6. isExhausted, pruneExhausted & staleStickyFallback with daily reset
// =========================================================================
{
  const P = {adapter: "opencode", model: "deepseek-v4.1-flash-free"};
  const F = {adapter: "opencode", model: "beam-free"};
  const roleConfig = {...P, fallbacks: [F]};

  const tExhausted = new Date(2026, 10, 18, 19, 38, 0, 0).getTime();
  const tBeforeReset = new Date(2026, 10, 19, 2, 55, 0, 0).getTime();
  const tAfterReset = new Date(2026, 10, 19, 3, 5, 0, 0).getTime();

  // Mark model exhausted with free quota
  const exhausted = markExhausted({}, P, "implementer", new Date(tExhausted).toISOString(), {quota: "free"});
  assert.equal(exhausted["opencode/deepseek-v4.1-flash-free"].reason, "RATE_LIMITED");
  assert.equal(exhausted["opencode/deepseek-v4.1-flash-free"].quota, "free");

  // 6a. Before daily reset time: model remains exhausted
  const isExhBefore = isExhausted(exhausted, P, {daily_reset_time: "03:00"}, tBeforeReset);
  assert.equal(isExhBefore, true, "model must remain exhausted before daily reset");

  const prunedBefore = pruneExhausted(exhausted, {daily_reset_time: "03:00"}, tBeforeReset);
  assert.equal(Object.keys(prunedBefore).length, 1);

  // 6b. After daily reset time: model is NO LONGER exhausted
  const isExhAfter = isExhausted(exhausted, P, {daily_reset_time: "03:00"}, tAfterReset);
  assert.equal(isExhAfter, false, "model must not be exhausted after daily reset");

  const prunedAfter = pruneExhausted(exhausted, {daily_reset_time: "03:00"}, tAfterReset);
  assert.equal(Object.keys(prunedAfter).length, 0, "pruneExhausted must drop expired free quota model");

  // 6c. Sticky fallback clearance
  const stickyFallback = stampStickyFallback(F, roleConfig, new Date(tExhausted).toISOString(), FREE_QUOTA_REASON);
  assert.equal(stickyFallback.reason, FREE_QUOTA_REASON);

  // Stale check before reset -> null
  const staleBefore = staleStickyFallback({
    role: "implementer",
    roleConfig,
    activeModel: stickyFallback,
    policy: {daily_reset_time: "03:00"},
    nowMs: tBeforeReset,
  });
  assert.equal(staleBefore, null, "sticky fallback must stay active before reset");

  // Stale check after reset -> stale
  const staleAfter = staleStickyFallback({
    role: "implementer",
    roleConfig,
    activeModel: stickyFallback,
    policy: {daily_reset_time: "03:00"},
    nowMs: tAfterReset,
  });
  assert.notEqual(staleAfter, null, "sticky fallback must be declared stale after reset");
  assert.equal(staleAfter.why, "age");
  assert.match(staleAfter.message, /daily quota reset at 03:00/);

  // 6d. Effective model resolution restores primary after clearing sticky fallback
  const restored = resolveEffectiveRoleModel(roleConfig, null);
  assert.equal(restored.model, P.model, "configured primary model restored after sticky clear");

  console.log("PASS 6: isExhausted, pruneExhausted, staleStickyFallback before and after daily reset");
}

// =========================================================================
// 7. Config key validation: daily_reset_time
// =========================================================================
{
  // Valid formats
  assert.deepEqual(validateAdvancedConfig({daily_reset_time: "03:00"}), []);
  assert.deepEqual(validateAdvancedConfig({daily_reset_time: "00:00"}), []);
  assert.deepEqual(validateAdvancedConfig({daily_reset_time: "23:59"}), []);

  // Invalid formats
  const inv1 = validateAdvancedConfig({daily_reset_time: "24:00"});
  assert.equal(inv1.length, 1);
  assert.match(inv1[0], /HH:MM/);

  const inv2 = validateAdvancedConfig({daily_reset_time: "03:60"});
  assert.equal(inv2.length, 1);

  const inv3 = validateAdvancedConfig({daily_reset_time: "3:00"});
  assert.equal(inv3.length, 1);

  const inv4 = validateAdvancedConfig({daily_reset_time: 1234});
  assert.equal(inv4.length, 1);

  // Runtime config mapping
  const runtimeCfg = toRuntimeConfig({
    schema_version: "4.0",
    advanced: {
      daily_reset_time: "04:30",
    },
  });
  assert.equal(runtimeCfg.policy.daily_reset_time, "04:30");

  // Default layout mapping
  const defaultLayout = toNewLayoutConfig({});
  assert.equal(defaultLayout.advanced.daily_reset_time, "03:00");
  const defaultRuntime = toRuntimeConfig(defaultLayout);
  assert.equal(defaultRuntime.policy.daily_reset_time, "03:00");

  // Migration / new layout mapping from legacy
  const newLayout = toNewLayoutConfig({
    schema_version: "3.0",
    policy: {
      daily_reset_time: "05:00",
    },
  });
  assert.equal(newLayout.advanced.daily_reset_time, "05:00");

  console.log("PASS 7: config validation and layout mapping for daily_reset_time");
}

// =========================================================================
// 8. Task cursor loop integration verification (Standalone + SpecKit)
// =========================================================================
{
  const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

  // Verify syncStickyFallback is called in both task cursors:
  // Standalone loop:
  const standaloneMatch = /runStandaloneImplementation[\s\S]*?syncStickyFallback\(s,c,"implementer"\)/.test(autopilotSource);
  assert.equal(standaloneMatch, true, "runStandaloneImplementation must syncStickyFallback for implementer");

  // SpecKit loop:
  const specKitMatch = /runImplementation[\s\S]*?syncStickyFallback\(s,c,"implementer"\)/.test(autopilotSource);
  assert.equal(specKitMatch, true, "runImplementation must syncStickyFallback for implementer");

  // Verify outOfRepoDeniedRetries is declared in MISSION_SCOPED_STATE_KEYS:
  assert.match(autopilotSource, /"outOfRepoDeniedRetries"/);

  // Verify clearAllSpentCounters clears outOfRepoDeniedRetries:
  assert.match(autopilotSource, /if\(s\.outOfRepoDeniedRetries\)\s*s\.outOfRepoDeniedRetries=\{\}/);

  console.log("PASS 8: both task cursor loops and state management verified in autopilot.mjs");
}

// =========================================================================
// 9. End-to-end mission tests with fake antigravity adapter harness
// =========================================================================
{
  function resolveSafeScratch() {
    const home = os.homedir();
    const brainDir = path.join(home, ".gemini", "antigravity-cli", "brain");
    try {
      if (fs.existsSync(brainDir)) {
        const conv = fs.readdirSync(brainDir).find(d => !d.startsWith("."));
        if (conv) {
          const scratch = path.join(brainDir, conv, "scratch");
          fs.mkdirSync(scratch, {recursive: true});
          return scratch;
        }
      }
    } catch {}
    return process.env.TMPDIR || os.tmpdir();
  }

  const scratchBase = resolveSafeScratch();
  const testTmpBase = path.join(scratchBase, "ap-b8-test-" + Date.now());
  fs.mkdirSync(testTmpBase, {recursive: true});
  const savedTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = testTmpBase;

  const {
    makeFixtureRepo,
    makeFixtureBin,
    writeConfig,
    runAutopilot,
    readObservedEvents,
  } = await import("./test-fixtures/workflow-order-harness.mjs");

  function makeFakeAgyScript(scenario) {
    return `#!${process.execPath}
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("antigravity 1.0.0\\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write("gemini-2.5-pro\\nfallback-model\\n");
  process.exit(0);
}

let stdinData = "";
try {
  stdinData = fs.readFileSync(0, "utf8");
} catch {}

const scenario = ${JSON.stringify(scenario)};

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

const CID = "fake-cid-1";
emit({event: "init", conversation_id: CID, init: {cwd: process.cwd(), tools: ["run_command", "write_file"]}});
emit({event: "step_update", step_update: {conversation_id: CID, step_index: 0, state: "DONE", step_type: "user_input"}});

const modelIdx = args.indexOf("--model");
const currentModel = modelIdx >= 0 ? args[modelIdx + 1] : "";

if (scenario === "in-repo-denied") {
  if (currentModel === "fallback-model") {
    emit({
      event: "step_update",
      step_update: {
        conversation_id: CID,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "fallback model completed successfully\\n",
        usage: {input_tokens: 10, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20}
      }
    });
    emit({
      event: "result",
      result: {
        conversation_id: CID,
        status: "SUCCESS",
        response: "implementer ok\\nAUTOPILOT_TASK_RESULT={\\"summary\\":\\"implementer ok\\",\\"taskLocalCheck\\":{\\"command\\":\\"true\\",\\"status\\":\\"passed\\",\\"exitCode\\":0,\\"summary\\":\\"fixture\\"}}\\n",
        num_turns: 1,
        usage: {input_tokens: 10, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20}
      }
    });
    process.exit(0);
  } else {
    emit({
      event: "step_update",
      step_update: {
        conversation_id: CID,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "attempting in-repo write\\n",
        usage: {input_tokens: 10, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20}
      }
    });
    emit({
      event: "step_update",
      step_update: {
        conversation_id: CID,
        step_index: 2,
        state: "ERROR",
        step_type: "tool",
        tool_name: "write_file",
        tool_info: {
          name: "write_file",
          parameters: {Path: "src/index.js"},
          error: {type: "DENIED", message: "Permission denied: 1 tool call was denied (denied_actions: [write_file(src/index.js)])"}
        }
      }
    });
    emit({
      event: "result",
      result: {
        conversation_id: CID,
        status: "ERROR",
        response: "",
        error: "Permission denied: 1 tool call was denied (denied_actions: [write_file(src/index.js)])",
        denied_actions: ["write_file(src/index.js)"],
        duration_seconds: 1,
        num_turns: 1,
        usage: {input_tokens: 10, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20}
      }
    });
    process.exit(1);
  }
} else {
  // out-of-repo scenario
  const hasScratchNote = stdinData.includes("Write only inside the repository");
  if (!hasScratchNote) {
    emit({
      event: "step_update",
      step_update: {
        conversation_id: CID,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "attempting out-of-repo write\\n",
        usage: {input_tokens: 10, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20}
      }
    });
    emit({
      event: "step_update",
      step_update: {
        conversation_id: CID,
        step_index: 2,
        state: "ERROR",
        step_type: "tool",
        tool_name: "write_file",
        tool_info: {
          name: "write_file",
          parameters: {Path: "/home/dev/.gemini/antigravity-cli/brain/scratch.txt"},
          error: {type: "DENIED", message: "Permission denied: 1 tool call was denied (denied_actions: [write_file(/home/dev/.gemini/antigravity-cli/brain/scratch.txt)])"}
        }
      }
    });
    emit({
      event: "result",
      result: {
        conversation_id: CID,
        status: "ERROR",
        response: "",
        error: "Permission denied: 1 tool call was denied (denied_actions: [write_file(/home/dev/.gemini/antigravity-cli/brain/scratch.txt)])",
        denied_actions: ["write_file(/home/dev/.gemini/antigravity-cli/brain/scratch.txt)"],
        duration_seconds: 1,
        num_turns: 1,
        usage: {input_tokens: 10, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20}
      }
    });
    process.exit(1);
  } else {
    emit({
      event: "step_update",
      step_update: {
        conversation_id: CID,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "retrying write within repo with scratch note\\n",
        usage: {input_tokens: 10, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20}
      }
    });
    emit({
      event: "result",
      result: {
        conversation_id: CID,
        status: "SUCCESS",
        response: "implementer ok\\nAUTOPILOT_TASK_RESULT={\\"summary\\":\\"implementer ok\\",\\"taskLocalCheck\\":{\\"command\\":\\"true\\",\\"status\\":\\"passed\\",\\"exitCode\\":0,\\"summary\\":\\"fixture\\"}}\\n",
        num_turns: 1,
        usage: {input_tokens: 10, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20}
      }
    });
    process.exit(0);
  }
}
`;
  }

  function setupMission(prefix, scenario) {
    const repo = makeFixtureRepo(prefix);
    const binDir = makeFixtureBin(prefix);

    const fakeAgy = path.join(binDir, "agy");
    fs.writeFileSync(fakeAgy, makeFakeAgyScript(scenario));
    fs.chmodSync(fakeAgy, 0o755);
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(binDir, "agy.cmd"), `@echo off\r\n"${process.execPath}" "${fakeAgy}" %*\r\nexit /b %errorlevel%\r\n`);
    }

    writeConfig(repo, {planningFramework: "standalone"});
    const configFile = path.join(repo, ".autopilot", "config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    config.roles.implementer = {
      adapter: "antigravity",
      model: "gemini-2.5-pro",
      fallbacks: [{adapter: "antigravity", model: "fallback-model"}],
      model_source: "manual",
      model_verified_at: new Date().toISOString(),
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

    fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(repo, ".autopilot-test-scenario"), scenario);
    fs.writeFileSync(path.join(repo, ".autopilot", ".autopilot-test-scenario"), scenario);

    const mission = "001-backlog-8";
    const planFile = path.join(repo, ".autopilot", "missions", mission, "PLAN.md");
    const tasksFile = path.join(repo, ".autopilot", "missions", mission, "TASKS.md");
    fs.mkdirSync(path.dirname(planFile), {recursive: true});
    fs.writeFileSync(planFile, "# Plan\n\nObjective: backlog-8 probe.\n\nTasks: ./TASKS.md\n");
    fs.writeFileSync(tasksFile, "## Phase 1: General\n\n- [ ] Do fixture task\n");
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
      version: 1,
      phase: "tasks_ready",
      step: "tasks_ready",
      phaseIndex: 0,
      attempt: 1,
      mission,
      planningRequest: "backlog-8 probe",
    }, null, 2));

    return {repo, binDir};
  }

  try {
    // 9a. Out-of-repo denied write: same model runs twice, brief has scratch note, activeRoleModels has no fallback
    {
      const {repo, binDir} = setupMission("oor", "out-of-repo");
      runAutopilot(repo, binDir, {request: "backlog-8 probe", timeoutMs: 30000});

      const events = readObservedEvents(repo);
      const implEvents = events.filter(e => e.role === "implementer");
      assert.equal(implEvents.length, 2, "must have exactly 2 implementer runs (initial + same-model retry)");

      const run1 = JSON.parse(fs.readFileSync(implEvents[0].file, "utf8"));
      const run2 = JSON.parse(fs.readFileSync(implEvents[1].file, "utf8"));

      // Assert the same model ran twice
      assert.equal(run1.model, "gemini-2.5-pro", "first run ran primary model");
      assert.equal(run2.model, "gemini-2.5-pro", "second run ran same primary model");
      assert.equal(run1.status, "failed", "first run failed (out-of-repo write denied)");
      assert.equal(run2.status, "completed", "second run completed successfully");

      // Assert second brief contains "Write only inside the repository"
      const brief2 = fs.readFileSync(path.join(path.dirname(implEvents[1].file), "brief.txt"), "utf8");
      assert.match(brief2, /Write only inside the repository/, "second brief must instruct to write only inside repo");

      // Assert activeRoleModels has no fallback
      const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
      assert.equal(state.activeRoleModels?.implementer, undefined, "activeRoleModels must have no fallback for implementer");
      assert.ok(state.outOfRepoDeniedRetries, "outOfRepoDeniedRetries recorded in state");

      console.log("PASS 9a: e2e out-of-repo denied write retries same model with scratch note, no fallback");
    }

    // 9b. In-repo denied write: falls back to fallback-model
    {
      const {repo, binDir} = setupMission("ir", "in-repo-denied");
      runAutopilot(repo, binDir, {request: "backlog-8 probe", stage: "implement", timeoutMs: 30000});

      const events = readObservedEvents(repo);
      const implEvents = events.filter(e => e.role === "implementer");
      assert.equal(implEvents.length, 2, "must have exactly 2 implementer runs (initial + fallback retry)");

      const run1 = JSON.parse(fs.readFileSync(implEvents[0].file, "utf8"));
      const run2 = JSON.parse(fs.readFileSync(implEvents[1].file, "utf8"));

      // Assert first run used primary, second run used fallback model
      assert.equal(run1.model, "gemini-2.5-pro", "first run ran primary model");
      assert.equal(run2.model, "fallback-model", "second run ran fallback model");
      assert.equal(run1.status, "failed", "first run failed (in-repo write denied)");
      assert.equal(run2.status, "completed", "second run completed on fallback model");

      // Assert activeRoleModels has fallback
      const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
      assert.equal(state.activeRoleModels?.implementer?.model, "fallback-model", "activeRoleModels records fallback model");

      console.log("PASS 9b: e2e in-repo denied write triggers fallback model switch");
    }
  } finally {
    if (savedTmpDir !== undefined) {
      process.env.TMPDIR = savedTmpDir;
    } else {
      delete process.env.TMPDIR;
    }
    try {
      fs.rmSync(testTmpBase, {recursive: true, force: true});
    } catch {}
  }
}

console.log("\nALL BACKLOG #8 TESTS PASSED SUCCESSFULLY.");
