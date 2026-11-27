#!/usr/bin/env node
// Backlog #3: agy out-of-workspace path slip -> PATH_OUTSIDE_WORKSPACE (model
// domain, retryable), same-model retry with exact abs path, second slip falls
// back as today, in-repo denial stays PERMISSION_DENIED, and brief carries
// absolute hand-off path + agy path instruction.
import assert from "node:assert/strict";
import path from "node:path";
import {
  observeAgyEvents,
  decideDeniedWriteRetry,
  resolveHandoffPathsInBrief,
  agyPathInstruction,
} from "./agy-events.mjs";
import {classifyObservedFailure} from "./failure-contract.mjs";
import {buildTaskPrompt} from "./role-progress-prompt.mjs";
import {handoffNoteRelPath} from "./per-task-budget.mjs";

const REPO = "/home/dev/projects/SampleApp";
const SCRATCH = "/home/dev/projects/SampleApp/.autopilot/runs/r113/scratch";
const MISSION = "008-tenant-provisioning-management";
const HANDOFF_DIR = path.join(REPO, ".autopilot", "missions", MISSION, "handoff");
const HANDOFF_NOTE_ABS = path.join(REPO, handoffNoteRelPath(MISSION, "T015"));
const PROBE = {readPath: "", productionWritePath: "", outsideWritePath: "", root: REPO, scratchDir: SCRATCH, handoffDir: HANDOFF_DIR};

function makeDeniedWriteEvents(badPath) {
  return [
    {event: "init", conversation_id: "c1", init: {cwd: REPO, tools: ["write_file"]}},
    {
      event: "step_update",
      step_update: {
        conversation_id: "c1",
        step_index: 1,
        state: "ERROR",
        step_type: "tool",
        tool_name: "write_file",
        tool_info: {
          name: "write_file",
          parameters: {Path: badPath},
          error: {type: "DENIED", message: `Permission denied: write_file(${badPath})`},
        },
      },
    },
    {
      event: "result",
      result: {
        conversation_id: "c1",
        status: "ERROR",
        error: `Permission denied: 1 tool call was denied (denied_actions: [write_file(${badPath})])`,
        denied_actions: [`write_file(${badPath})`],
        num_turns: 1,
      },
    },
  ];
}

// 1. Out-of-workspace denied paths -> PATH_OUTSIDE_WORKSPACE (domain: "model", retryable: true)
const outsideCases = [
  "/home/home/dev/projects/SampleApp/.autopilot/missions/008-tenant-provisioning-management/handoff/T015.md",
  "/home/projects/SampleApp/.autopilot/missions/008-tenant-provisioning-management/handoff/T015.md",
  "/home/dev/.gemini/antigravity-cli/brain/conv-1/../../../../../home/dev/projects/SampleApp/.autopilot/missions/008-tenant-provisioning-management/handoff/T015.md",
  "brain/../../../../outside/T015.md",
];

for (const badPath of outsideCases) {
  const events = makeDeniedWriteEvents(badPath);
  const obs = observeAgyEvents(events, PROBE);
  assert.ok(obs.some((o) => o.type === "path_outside_workspace"), `expected path_outside_workspace for ${badPath}`);
  assert.ok(!obs.some((o) => o.type === "permission_denied"), `expected no permission_denied for ${badPath}`);

  const classified = classifyObservedFailure({
    exitCode: 1,
    stderr: "Permission denied",
    evidence: obs,
    adapter: "antigravity",
  });
  assert.equal(classified.class, "PATH_OUTSIDE_WORKSPACE", `class for ${badPath}`);
  assert.equal(classified.domain, "model", `domain for ${badPath}`);
  assert.equal(classified.retryable, true, `retryable for ${badPath}`);

  // First slip -> same-model retry with exact handoff abs path
  const result = {status: "failed", failure: classified, observations: obs};
  const first = decideDeniedWriteRetry({
    result,
    repo: REPO,
    events,
    retries: {},
    taskKey: "T015",
    scratch: SCRATCH,
    handoffNotePath: HANDOFF_NOTE_ABS,
    handoffDir: HANDOFF_DIR,
  });
  assert.equal(first.retry, true, `first slip should retry same model for ${badPath}`);
  assert.equal(first.nextRetries["T015"], 1);
  assert.ok(
    first.note.includes(`your write to ${badPath} was outside the workspace; the correct path is ${HANDOFF_NOTE_ABS}`),
    `retry note must name bad path and exact handoff abs path, got: ${first.note}`
  );

  // Second slip in the same task -> behave as today (retry: false -> fallback/escalate)
  const second = decideDeniedWriteRetry({
    result,
    repo: REPO,
    events,
    retries: first.nextRetries,
    taskKey: "T015",
    scratch: SCRATCH,
    handoffNotePath: HANDOFF_NOTE_ABS,
    handoffDir: HANDOFF_DIR,
  });
  assert.equal(second.retry, false, `second slip must not same-model retry for ${badPath}`);
  assert.equal(second.note, null);
}
console.log("PASS 1: outside-workspace agy denials -> PATH_OUTSIDE_WORKSPACE + same-model retry once, second slip falls back");

// 2. Denied path inside repo -> stays PERMISSION_DENIED (domain: "adapter", retryable: false)
{
  const inRepoPath = path.join(REPO, "apps/web/src/tenant.rules.ts");
  const events = makeDeniedWriteEvents(inRepoPath);
  const obs = observeAgyEvents(events, PROBE);
  assert.ok(obs.some((o) => o.type === "permission_denied"), "in-repo denial emits permission_denied");
  assert.ok(!obs.some((o) => o.type === "path_outside_workspace"), "in-repo denial never emits path_outside_workspace");

  const classified = classifyObservedFailure({
    exitCode: 1,
    stderr: "Permission denied",
    evidence: obs,
    adapter: "antigravity",
  });
  assert.equal(classified.class, "PERMISSION_DENIED");
  assert.equal(classified.domain, "adapter");
  assert.equal(classified.retryable, false);

  const retry = decideDeniedWriteRetry({
    result: {status: "failed", failure: classified, observations: obs},
    repo: REPO,
    events,
    retries: {},
    taskKey: "T015",
    scratch: SCRATCH,
    handoffNotePath: HANDOFF_NOTE_ABS,
    handoffDir: HANDOFF_DIR,
  });
  assert.equal(retry.retry, false, "in-repo denial must not same-model retry");
}
console.log("PASS 2: in-repo denial stays PERMISSION_DENIED/adapter/non-retryable");

// 3. Brief contains absolute hand-off path for agy and sandbox path for envelope adapters
{
  const roleProgress = {implementer: {status: "running", taskCursor: 0, currentTaskId: "T015", completedTaskIds: [], factsByTask: {}}};
  const built = buildTaskPrompt({
    framework: "standalone",
    mission: MISSION,
    phaseIndex: 0,
    phaseName: "Provisioning",
    phaseTotal: 1,
    revision: 1,
    role: "implementer",
    phaseTaskDigest: "digest-1",
    taskIds: ["T015"],
    tasks: [{text: "T015 Add tenant rules"}],
    currentTaskId: "T015",
    roleProgress,
    repoRoot: REPO,
    adapter: "antigravity",
  });
  assert.equal(built.ok, true, built.reason);
  assert.ok(built.text.includes(HANDOFF_NOTE_ABS), `agy brief must contain absolute hand-off path ${HANDOFF_NOTE_ABS}`);
  assert.ok(built.text.includes(agyPathInstruction(REPO)), "agy brief must contain never-build-relative-to-brain instruction");

  // Shared relay brief path resolver: host path for agy, sandbox path for envelope adapters
  const relBrief = `Keep a hand-off note at ${handoffNoteRelPath(MISSION, "T044")}.`;
  const hostResolved = resolveHandoffPathsInBrief(relBrief, {repoRoot: REPO, scratchDir: SCRATCH, useSandboxPaths: false});
  assert.ok(hostResolved.includes(path.join(REPO, handoffNoteRelPath(MISSION, "T044"))), `host resolved: ${hostResolved}`);

  const sandboxResolved = resolveHandoffPathsInBrief(relBrief, {repoRoot: REPO, scratchDir: SCRATCH, useSandboxPaths: true});
  assert.ok(sandboxResolved.includes(`/workspace/repository/${handoffNoteRelPath(MISSION, "T044")}`), `sandbox resolved: ${sandboxResolved}`);
}
console.log("PASS 3: brief contains absolute hand-off path + agy instruction, and sandbox path for envelope adapters");

console.log("\nALL BACKLOG #3 TESTS PASSED.");
