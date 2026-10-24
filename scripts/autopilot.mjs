#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import tty from "node:tty";
import {spawnSync,spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {spawnAgent} from "./agent-process.mjs";
import {randomUUID} from "node:crypto";
import * as speckit from "../adapters/speckit.mjs";
import * as gsd from "../adapters/gsd.mjs";
import * as standalone from "../adapters/standalone.mjs";
import { specKitState, gsdState } from "../adapters/planning-state.mjs";
import { createGitMutationGuard, appendGuardScopeRoot, writeGuardBeforeSnapshot, guardedEnv, guardedCommandEnv, gitSnapshot, assertSupportedTopology, touchedFilesBetween, sessionFromOutput, roleSession, saveRoleSession, clearRoleSession, readGuardLog, describeGitStateChange, redactedGitSnapshot, formatRelayPolicyViolation, parsePorcelainV1ZEntries, keepEntryAfterEolFilter, classifyGitBlocks } from "./relay-guards.mjs";
import { collectSnapshotGuards, decideSnapshotReuse, getCachedSnapshot, getSnapshotCacheKey, setCachedSnapshot, clearSnapshotReuseCache, makeCacheEntry } from "./snapshot-reuse-cache.mjs";
import { createShellGuard, logShellDecision, networkIsolationPrefix } from "./shell-guard.mjs";
import { runGuardedCommand } from "./guarded-command.mjs";
import {loadAndMigrateConfig} from "./config-migration.mjs";
import {validateNewConfig} from "./config-validation.mjs";
import {verifyDenylistFindings, effectiveVerifyDenylist, speckitTaskDenylistFindings, verifyLengthFindings, speckitTaskVerifyLengthFindings, verifyShardFindings, speckitTaskVerifyShardFindings, phaseTaskCountFindings, unrecognizedAnnotationFindings, MAX_PHASE_TASKS} from "./verify-denylist.mjs";
import {atomicWriteFileSync} from "./atomic-state-write.mjs";
import {readResetRequests,enqueueResetRequest,removeResetRequest,removeAllResetRequests} from "./reset-request-queue.mjs";
import {PLAN_REVISION_RESET_SCOPE,PLAN_REVISION_RESET_KEY,clearPlanRevisionCounter,planRevisionResetRequest,applyPendingPlanRevisionReset} from "./reset-plan-revision.mjs";
import {ownerPidPath, writeOwnerPid, readOwnerPid, verifyOwnerPid, removeOwnerPid, findRepoLiveRuns} from "./owner-pid.mjs";
export {ownerPidPath, writeOwnerPid, readOwnerPid, verifyOwnerPid, removeOwnerPid};
// Exported for offline tests that must build the production manifest argv with
// the real builder (buildRelayArgs -> resolveAdapterTransport call shape) and
// assert the stdin stream-json flags reach every agy child, not just the ones
// spawned through a mode-driven buildInvocation.
export {buildRelayArgs as buildRelayArgsForTests, gates as gatesForTests};
// Exported for offline tests: backlog #1(a) warn-only preflight for OpenCode
// models that vanished from the live list.
export {openCodeSandboxModelWarnings as openCodeSandboxModelWarningsForTests};

// F2b #23b: test-callable handler that records an orchestrator_exit event
// without re-raising the signal. Accepts (signal, repo, state) or an options
// object. Never throws.
export function appendOrchestratorExitEvent(missionDir, signal) {
  try {
    if (!missionDir) return;
    appendWatchEvent(String(missionDir), { type: "orchestrator_exit", signal: signal || "SIGTERM", at: new Date().toISOString() });
  } catch {}
}

import {skillRoot} from "./paths.mjs";
import {cleanMissionScratch} from "./mission-scratch-cleanup.mjs";
import {planningArtifactDigest,canSkipPlanningStateReview} from "./planning-artifact-digest.mjs";
import {planUninstall, executeUninstall} from "./uninstall.mjs";
import { applyAgentSelections, verifyAgentInvocation } from "./agent-invocation.mjs";
import { validateAdapterContract, buildInvocationRecord, buildRuntimeResult } from "./agent-contract.mjs";
import { verifierTask, remapRepositoryPaths, formatLinkedTestDurations, formatHeavySuiteNoParallelNote } from "./verifier-brief.mjs";
import { discoverPlaywrightRuntime } from "./playwright-runtime.mjs";
import {parseReviewContract, classifyObservedFailure, reclassifySilentOpenCodeFailure, verdictFailure, failure, recordFailureBudget, selectAttemptFailure, clearStaleStandaloneBudgets, shouldRefusePassForEvidence, linkedVerifyCommandsForPhase, reviewerLinkedToolResults} from "./failure-contract.mjs";
import {isPlanningReviewRetryFramework} from "./planning-review-decision.mjs";
import {decideEscalationName} from "./escalation-naming.mjs";
import {deriveGsdUnitResetRecord, applyCarriedGsdReset} from "./gsd-unit-reset.mjs";
import {resolvePlanningReviewAttempt as resolvePlanningReviewAttemptWired, escalateIfRateLimited} from "./planning-review-wiring.mjs";
import {evaluateStandaloneReview, createStandaloneCheckpoint, artifactDigest as planningReviewArtifactDigest,
  STANDALONE_PLANNER_POSITION, STANDALONE_REVIEWER_POSITION,
  evaluateSpeckitGateReview, createSpeckitCheckpoint, manifestForGate, isReviewerPosition,
  SPECKIT_INITIAL_REVIEW, SPECKIT_PLANNER_REVISION, SPECKIT_POST_REVISION_REVIEW} from "./planning-review-checkpoint.mjs";
import {preflightConfig} from "./preflight.mjs";
import {planModeModelWarnings} from "./plan-mode-model-note.mjs";
import {spawnRelayChild} from "./subprocess-relay.mjs";
import {adapterDriver, finalAgentText, sessionIdFromEvents, accumulateUsage, recordRunModel, runModelPatch} from "./adapter-drivers.mjs";
import {mergeTaskFacts} from "./task-requirements.mjs";
import {buildRoleRequirements, requirementFailure} from "./role-requirements.mjs";
import { classifyPlanningRequest } from "./planning-request.mjs";
import { appendWatchEvent } from "./watch-events.mjs";
import { listSpecKitFeatureDirNames, evaluatePlanningWriteBoundary, CLAUDE_MD_MARKER_BEGIN, CLAUDE_MD_MARKER_END } from "./planning-boundary.mjs";
import { validatePlanningStagePostcondition, formatPostconditionError } from "./speckit-planning-postconditions.mjs";
import { initRun, observe, finalizeRun, formatDuration, updateRunUsage, updateRunModel, updateRunSnapshots } from "./run-observability.mjs";
import { changedFilesStat } from "./changed-files-stat.mjs";
import { guardRelay, relayGuardEnabled } from "./relay-guard.mjs";
import { nextRunSeq, writeWatchReportFile, listRunsOldestNewest, watchRunsDir, staleRunningNote } from "./run-history.mjs";
import { updateSummary, updateSummaryForRunDir, scopeForRunDir } from "./watch-summary.mjs";
import { recoverStaleRuns, markInterrupted } from "./run-recovery.mjs";
import { recordCodeReviewRound, clearCodeReviewHistory, codeReviewerRoundLines, implementerEarlierRoundsText, codeReviewScopeKey } from "./code-review-rounds.mjs";
import { scheduleEscalation, pendingEscalationModel, consumeEscalationFor, formatEscalationLog, recordVerifierRound, clearVerifierHistory, verifierRoundLines } from "./escalation-model.mjs";
import { recordPlanReviewRound, seedPlanReviewHistory, clearPlanReviewHistory, planReviewerRoundLines, plannerEarlierRoundsText } from "./plan-review-rounds.mjs";
import { saveReviewFeedback, loadReviewFeedback, clearReviewFeedback, clearReviewFeedbackByPrefix, feedbackText } from "./review-feedback.mjs";
import { taskLabel, recordFindingTasks, loadFindingTasks, carryDecision, findingsForTask, renderHandledFindings, fixPassBriefExcerpts, clearFindingTasks, clearFindingTasksByPrefix, FINDING_TASKS_STATE_KEY } from "./finding-task-locality.mjs";
import { runFinalReviewFixRounds, parseGateGreenFiles, isNoWorkPerformed, isReviewerFeedbackFixPass, buildNoWorkAnswerSection } from "./final-review-fix-rounds.mjs";
import { classifyGateFailures, parseGateFailures, taskLinkedTestFiles, formatGateFailureEscalation } from "./gate-failure-locality.mjs";
import { importsDeltaFile } from "./gate-locality-imports.mjs";
import { checkGateBaseline } from "./gate-baseline-locality.mjs";
import { findUnexpectedScratchFiles, unexpectedNewFilesNote } from "./scratch-file-locality.mjs";
import {mapPathIntoEnvelope, SANDBOX_HOME} from "./execution-envelope.mjs";
import {resolveAdapterTransport} from "./adapter-transport.mjs";
import {ensureBaseline, hasBaseline, removeBaseline, scopedDelta, scopedDeltaChunks, sanitizeKeySegment, scopedDeltaBeginMarker, SCOPED_DELTA_END_MARKER, listWorktreeEntries, rebaseBaselineOntoHead, headMovedSinceBaseline} from "./implementation-baseline.mjs";
import {buildStandaloneHandoff, boundedDeltaBody, MISSION_FINAL_SECURITY_LINE, formatOperatorPhaseEdits, parseIncompleteSignal, parsePlanningIncompleteSignal, parseFoundEntries, sanitizeSummary, truncationWarning, reviewTruncationResult, formatGateResult, resolveGateDurations} from "./standalone-handoff.mjs";
import {applyRedGateOverride, persistRedGateOverride} from "./verifier-red-gate-override.mjs";
import {handlePlanningContinuation, planningNoProgressTouchedFiles, clearPlanningContinuations, hasSpentPlanningContinuations, PLANNING_CONTINUATION_SCOPES} from "./planning-continuation.mjs";
import {ensurePhaseBriefForCheckpoint, phaseBriefRelativePath} from "./role-progress-brief.mjs";
import {buildTaskPrompt, taskDisplayRef, reviewTaskRef, allPhaseTaskRef, readOnlyHandoffNoteReminder} from "./role-progress-prompt.mjs";
import {stableTaskIds} from "./role-progress-ids.mjs";
import {prepareTaskInvocation, commitTaskResult, evaluateCrashResume} from "./role-progress-commit.mjs";
import {attributionMap, changedPaths as attributedChangedPaths, detectWorkAhead} from "./task-attribution.mjs";
import {parseTaskResultContract} from "./task-result-contract.mjs";
import {taskSizingRuleText, taskSizeReviewText, resolveTaskSizeTargetTurns, resolvePerTaskLimits, resolvePerRoleLimits, checkCapBreach, capUnitLabel, growingTerm, evaluateCapGraceWindow, checkWrapupTrigger, sessionStoreRelDir, sessionStoreSandboxSubpath, consumeContinuation, clearTaskContinuation, recordRolloverDeadEnd, readRolloverDeadEnds, clearRolloverDeadEnds, deadEndTail, sessionWorkDigest, resolveHandoffMaxChars, resolveHandoffNoteMaxChars, resolveHandoffWrapupTokens, handoffNoteRelPath, continuationBudgetKey, CONTINUATION_BUDGET_KEY_PREFIX, resolveContinuationAllowance, RELAY_TIMEOUT_DEFAULT_MS, HANDOFF_WRAPUP_TOKENS_DEFAULT, PER_ROLE_WRAPUP_TOKENS_DEFAULT, WRAPUP_MAX_TURNS, WRAPUP_TIMEOUT_MS, SESSION_STORE_WARN_BYTES, recordGenerationProgress, resolveNoProgressGenerations, clearNoProgress, noProgressDisplayLabel, handoffNoteCitedExcerpts, resolveIdleHangMs, resolveFirstOutputMs, resolveMaxSilenceMs, isHandoffNoteFresh, buildOrchestratorFallbackNote, scratchHandoffNotePath, SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, pickFresherHandoffNote, handoffBudgetReminder, mergeFallbackWithPreviousNote, resolveBackstopRawTokens, evaluateBackstopBreach, recordBackstopFiring, readBackstopFirings, clearBackstopFirings, backstopLedgerKey, evaluateBackstopEscalation, handleRoleBackstopFiring, resolveSessionNumber} from "./per-task-budget.mjs";
import {createIdleWatch, noteIdleOutput, noteIdleStdoutChunk, noteIdleStderrText, evaluateIdleWatch, formatIdleHangMessage, formatRateLimitedMessage, adapterMarkerFor, extractSessionIdFromChunk, noteIdleSessionId, IDLE_HANG_KILL_GRACE_MS} from "./idle-hang-watchdog.mjs";
import {deriveRoleDeadline, collectRoleSamples, ROLE_DEADLINE_FLOOR_MS} from "./role-deadline.mjs";
import {assembleAdapterLaunchPlan} from "./launch-plan.mjs";
import {ensureOpenCodeCacheSeeded, acquireOpenCodeCachePin, releaseOpenCodeCachePin, defaultOpenCodeCacheRoot, openCodeSandboxCatalog} from "./opencode-cache.mjs";
import {cleanStaleOpencodeLibs} from "./tmp-so-cleanup.mjs";
import {assembleAgentEnvironment} from "./agent-environment.mjs";
import {extendFallbackWithFree, markTriedFreeModel} from "./free-fallback-discovery.mjs";
import {discoverModelCatalog} from "./model-discovery.mjs";
import {runFailedBeforeFirstStep, isSessionNotFound, storedSessionMatches} from "./session-reset.mjs";
import {failedRunDidWork, appendFailureHandoff} from "./failure-handoff.mjs";
import {decideRoleFallback, resolveEffectiveRoleModel, formatRoleFallbackLog, decideRoleFallbackRetry, stampStickyFallback, staleStickyFallback, markExhausted, isExhausted, skipExhaustedRoleModel} from "./role-fallback.mjs";
import {setTaskCheckboxes, applyTaskCheckboxStates} from "./speckit-task-state.mjs";
import {CHECKPOINT_STATE_KEY, createCheckpoint, validateCheckpoint, isCheckpointForPhase, resumeStage, isApprovalReuseStage, phaseTaskDigest, deltaDigest, evaluatePlanningGate, decideTransition, emptyRoleProgress, retryPauseStageOf, shouldRetryPause, getCachedGateResult, setCachedGateResult, recordContinuationGateResult, takeContinuationGateResult, clearContinuationGateResult, getLastGateResult, recordLastGateResult} from "./phase-stage-checkpoint.mjs";
import {validatePendingCheckboxSnapshot} from "./pending-checkbox-snapshot.mjs";
import {rebasePhaseCheckpointDrift} from "./phase-delta-rebase.mjs";
import {buildSecurityChecklistSection} from "./security-checklist.mjs";
import {createReviewerWorkspace, disposableCopyArgs} from "./reviewer-workspace.mjs";
import {resolveWindowsVerifierPlaywrightBridge} from "./windows-verifier-playwright-bridge.mjs";
import {opencodeRuntimeConfigOverride} from "./opencode-runtime-config.mjs";
import {sanitizeMissionName, missionOverride, parseRunArgs, PLACEHOLDER_REQUEST, hasUsableRequest, stripSpecNumber, missionSeqOf, stripSeqPrefix, nextMissionSeq, existingMissionSeqForName, nameFromRequest, missionFor, missionDirFor, migrationLog, resolveStandaloneMission, ensureStandaloneMigrated, ensureStandaloneSplit, validateStandaloneSnapshot} from "./mission-naming.mjs";
import {guardStage} from "./stage-guards.mjs";
import {findAnchoredTests, formatAnchoredTestsSection} from "./anchored-tests.mjs";

// Backlog #96(a): brief section listing scripts/test-*.mjs that anchor on text
// the phase delta so far removed/changed. Best-effort: any failure -> "".
function anchoredTestsSection(chunks){
  try{
    const diffText=(chunks||[]).map(c=>`diff --git a/${c.path} b/${c.path}\n${c.text}`).join("\n");
    if(!diffText.trim()) return "";
    const dir=path.join(repo,"scripts");
    const testFiles=fs.readdirSync(dir).filter(f=>/^test-.*\.mjs$/.test(f)).map(f=>({path:`scripts/${f}`,text:fs.readFileSync(path.join(dir,f),"utf8")}));
    return formatAnchoredTestsSection(findAnchoredTests({diffText,testFiles}));
  }catch{ return ""; }
}

// TASK-12: SpecKit prompts keep their own prose but take the delta through the
// same bounded chunk fit Standalone's builder uses; trimming is always warned.
function speckitBoundedDelta(repo,key,kind){
  const {body,meta}=boundedDeltaBody(scopedDeltaChunks(repo,key),{kind,baselineKey:key});
  if(meta.truncated) console.warn(truncationWarning(meta));
  return body;
}

const repo=path.resolve(process.argv.includes("--repo")?process.argv[process.argv.indexOf("--repo")+1]||".":process.cwd());
const command=process.argv[2]||"status";
const commandArgs=process.argv.slice(3);
const cfgPath=path.join(repo,".autopilot","config.json");
const statePath=path.join(repo,".autopilot","state.json");
// Plain read from the skill's own adapters/ directory — no trusted-release
// bootstrap, no installer-owned install root required. This is the file
// this repo ships; nothing about reading it needs to be "verified."
const agents=JSON.parse(fs.readFileSync(path.join(skillRoot,"adapters","agents.json"),"utf8")).adapters;
let refreshHook=()=>{}; // no-op refresh hook, assigned to refreshWatchReport once available
for(const [id,a] of Object.entries(agents)){ const contract=validateAdapterContract(id,a); if(!contract.ok) die(`Invalid adapter contract:\n${contract.errors.map(e=>` - ${e}`).join("\n")}`); }

let activeRelayState=null; // track state during a relay for refresh hooks
const die=m=>{if(activeRelayState) refreshHook(activeRelayState,"die");console.error("ERROR:",m);process.exit(2)};
const read=p=>fs.readFileSync(p,"utf8");
const write=(p,s)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s)};
const exists=p=>fs.existsSync(path.join(repo,p));
const now=()=>new Date().toISOString();
const loadState=()=>fs.existsSync(statePath)?JSON.parse(read(statePath)):{version:1,phase:"idle",step:"idle",taskIndex:0,phaseIndex:0,attempt:0};
// Backlog #209: a detached `ap run "<new request>"` cannot know the mission
// name yet, so bin/ap.cjs logs to `.autopilot/orchestrator-<stamp>.log` and
// passes that path here. Move it into the mission directory as soon as the
// directory exists; the child's inherited log fd follows the inode, so output
// keeps landing in the moved file. An existing mission log is never replaced.
// The request guard keeps the move from running against the PREVIOUS mission
// while this child is still loading/validating state: the recorded request
// only matches once the live request has been adopted.
const detachedLogSource=process.env.AUTOPILOT_DETACHED_LOG||null;
const detachedLogRequest=process.env.AUTOPILOT_DETACHED_REQUEST||null;
const detachedPreviousMission=process.env.AUTOPILOT_DETACHED_PREVIOUS_MISSION||null;
let detachedLogLinked=false;
function linkDetachedOrchestratorLog(s){
  if(!detachedLogSource||detachedLogLinked) return;
  try{
    if(detachedLogRequest!==null && String(s?.planningRequest||"").trim()!==detachedLogRequest) return;
    const mission=missionDirFor(repo,s);
    if(!mission) return;
    // Before a new request is reset, state.mission still names the finished
    // mission; linking then would file the new log under the old mission.
    if(detachedPreviousMission&&mission===detachedPreviousMission) return;
    const dir=path.join(repo,".autopilot","missions",mission);
    if(!fs.existsSync(dir)) return;
    const target=path.join(dir,"orchestrator.log");
    if(fs.existsSync(target)) return;
    fs.renameSync(detachedLogSource,target);
    detachedLogLinked=true;
  }catch{}
}
const saveState=s=>{
  linkDetachedOrchestratorLog(s);
  atomicWriteFileSync(statePath,JSON.stringify({...s,updatedAt:now()},null,2));
};
// Helper: resolve the full mission watch-events directory path from state.
// Returns null when no mission is active. Watch writes must never break a run,
// so callers should wrap in try/catch (see refreshWatchReport at :919 pattern).
function getMissionWatchDir(s){
  const mission = missionDirFor(repo, s);
  return mission ? path.join(repo, ".autopilot", "missions", mission) : null;
}
// A mission only ever reaches phase:"complete"/step:"human_commit" AFTER
// every phase/task has already passed Implementation, Code Review,
// configured gates, and Verification (each adapter's implementation loop
// enforces that before calling this). By that point any in-progress
// pointer (which phase/task/wave is "current") or failure/recovery
// breadcrumb left over from an earlier — since-resolved — attempt or
// escalation is stale: a human reading state.json at this terminal point
// must never see a real mission reported as still incomplete or still
// failing. This is the ONLY place that clears them, and it runs ONLY on
// this exact success transition — an escalated/failed mission never calls
// this, so its real failure and recovery evidence (result.json, run
// history, s.checkpoint, s.lastReview, etc.) is untouched and preserved.
function finalizeMissionComplete(s){
  delete s.currentTask;
  delete s.currentPhase;
  delete s.currentWave;
  delete s.feedback;
  delete s.lastFailure;
  delete s.lastFailureBudget;
  delete s.taskMarkingError;
  delete s.relayPolicyViolation;
  delete s.gitInvisiblePhase;
  delete s.planningWriteBoundaryViolation;
  delete s.conflict;
  delete s.pendingCheckboxSnapshot;
  delete s.speckitPlanningCheckpoint;
  // TASK-14 Phase 7 task 24: the two planning-review resume-position
  // checkpoints are cleared here too, so a mission that completes by any path
  // — including one whose stale checkpoint was superseded by a later planning
  // attempt and never went through its own PASS-triggered clear — can never
  // leave either key in the terminal state.json a human reads.
  delete s.standalonePlanningReviewCheckpoint;
  delete s.speckitGateReviewCheckpoint;
  delete s[CHECKPOINT_STATE_KEY];
  // Mission 051 Phase 1 task 1.2: the final-review fix-round budget counter
  // (finalReviewFixRoundsUsed, see FINAL_REVIEW_FIX_ROUNDS_STATE_KEY in
  // scripts/final-review-fix-rounds.mjs) is cleared here too, so a mission
  // that completed after spending rounds can never leak a consumed budget
  // into the next mission run. Escalated/failed missions never reach this
  // function, so their counters and failure evidence are preserved.
  delete s.finalReviewFixRoundsUsed;
  // Mission 062 task 1.3: gate-green evidence (s.gateGreenFiles, sorted
  // array + s.gateGreenMission tie, see recordGateGreenFiles below) is
  // this mission's property too — never inherited by the next mission.
  delete s.gateGreenFiles;
  delete s.gateGreenMission;
  s.phase="complete";s.step="human_commit";
  saveState(s);
  // Success-only: free this mission's per-run scratch dirs. Never fails the mission.
  try{
    const m=missionDirFor(repo,s);
    if(m){
      const r=cleanMissionScratch(path.join(repo,".autopilot","missions",m));
      if(r.removed>0) console.log(`Cleaned scratch: ${r.removed} run(s), ${(r.bytes/1048576).toFixed(1)} MB freed`);
    }
  }catch(e){console.warn(`Warning: scratch cleanup failed: ${e.message}`)}
}
// ---------------------------------------------------------------------------
// Mission-control commands (F2): `ap cancel`, `ap stop` and `ap reset`.
//
// Cancel and reset are operator-only interventions on the ACTIVE mission's
// state file, and both refuse to act while an Autopilot run is alive. Stop
// is the exception: it exists precisely for the live case — it signals the
// live run to die but keeps the mission (kill + keep, resumable), never
// clearing state. The liveness check reads the verified owner PID file
// (`.autopilot/owner.pid`, written by the run itself at start) FIRST and
// falls back to the /proc scan (plus the CIM fallback on native Windows)
// when no live PID file claims the repo — the PID file is a verified claim
// (PID alive, writer platform matches, cmdline runs autopilot.mjs
// run|resume|implement|full for this repo), never a blind trust, and it is
// the only check that also sees `full` runs. stopLivePid() below is the
// single ground truth shared by `ap stop`, `ap cancel` and `ap reset`.
function missionControlLiveRun(){
  try{
    // Scope liveness to THIS repo via the pure scan loop in owner-pid.mjs:
    // --repo value realpath-compared on both sides (relative values resolved
    // against the target cwd when readable, else undeterminable), else the
    // target cwd realpath-compared; undeterminable skips the pid. Never
    // substring matching, so <repo>-other siblings and script-path
    // containment do not attribute. First match wins.
    const listPids=()=>fs.readdirSync("/proc").filter((e)=>/^\d+$/.test(e)).map(Number);
    const readCmdline=(pid)=>{ try{ return fs.readFileSync(`/proc/${pid}/cmdline`,"utf8"); }catch{ return null; } };
    const readCwd=(pid)=>fs.readlinkSync(`/proc/${pid}/cwd`);
    const found=findRepoLiveRuns(repo,{listPids,readCmdline,readCwd,selfPid:process.pid,platform:process.platform});
    return found.length?found[0]:null;
  }catch{ /* no /proc (native Windows): nothing to check against here */ }
  return null;
}
// Everything a mission owns that must not outlive it. Failure counters are
// deliberately NOT in this list: they are reset separately at each new-mission
// start by clearInheritedFailureCounters (the helper prints the run's single
// clear line), not by the debris drops that reuse this list.
const MISSION_SCOPED_STATE_KEYS=Object.freeze([
  "phaseExecutionCheckpoint","checkpoint","phaseCheckpointError",
  "currentPhase","currentTask","feedback","pendingCheckboxSnapshot",
  "lastFailure","lastFailureBudget","relayPolicyViolation",
  "standalonePlanningReviewCheckpoint","speckitGateReviewCheckpoint",
  // F3: both describe THIS mission's own outcome, so neither may outlive it.
  // `lastReview` surfaces in the watch report as if the next mission had been
  // reviewed; `planningStateReview` carries a stale `at`.
  "lastReview","planningStateReview",
  // F6: the token an unrecognised planner annotation died on.
  "unrecognisedRequirement",
  // The standalone twin of `pendingCheckboxSnapshot`: crash-recovery debris
  // from the dead mission, which the next standalone run would otherwise
  // reconcile against the NEW mission (F3).
  "pendingStandaloneCheckboxSnapshot",
  // TASK-20 step 1: finding→task locality recorded at a FAIL. It describes
  // THIS mission's own review, so `ap cancel` and a new request must drop it
  // with the review feedback it is paired with — a map that outlives its
  // findings is the stale-record bug class this codebase already paid for.
  FINDING_TASKS_STATE_KEY,
  // TASK-39 follow-up: the fixture-git-block warning is THIS mission's
  // property — shown in the next brief/WATCH-REPORT, never inherited.
  "fixtureGitBlockWarning","fixtureGitBlockWarningPhaseIndex","gitGuardWarning",
  // Mission 087 task 2.1: sticky per-role fallback model. Roles start on
  // their primary; a RATE_LIMITED run switches s.activeRoleModels[role] to
  // the next fallback (see the choke point after the idleBreach override
  // below). Mission-scoped so a new mission starts on primaries again.
  "activeRoleModels",
  // Pending #22: one-round escalation model bookkeeping + verifier round history.
  "escalationSwitches","escalationPending","verifierHistory",
  // Backlog #95: free models already rate-limited this mission (per role).
  "triedFreeModels",
  // Backlog #18: mission-wide models already found RATE_LIMITED by any role,
  // so no other role spends a run rediscovering the same exhaustion.
  "exhaustedModels",
  // Mission 063 task 1.1: operator-acknowledged phase-delta edits recorded by
  // `ap rebase`. They describe THIS mission's own drift acceptance, so a new
  // mission or cancel must drop them with the checkpoint they annotate.
  "operatorPhaseEdits"
]);
// F9: settle the INTENT before either crash-recovery reconcile validates a dead
// mission's debris.
//
// Both reconciles are fail-closed on purpose: a snapshot that EXISTS but is
// invalid (malformed, or bound to another mission/feature) stops the run for
// human intervention, because ignoring it would mean implicitly trusting
// whatever checkboxes an interrupted Implementer left on disk. That is right for
// a RESUME and exactly wrong for a NEW mission — the snapshot belongs to the
// mission the operator is abandoning, so validating it can only ever die
// ("Refusing to reconcile or trust on-disk checkboxes"), which made a new
// mission impossible without hand-editing state.json.
//
// The rule below is deliberately the same trim-compare the new-request decision
// applies, reused rather than re-derived so the two can never disagree; and it
// is the CHEAP half of that decision (no disk read, no planning-state probe), so
// a genuine resume — no supplied request, or the identical one — still falls
// through to the fail-closed reconcile untouched.
function suppliedRequestStartsNewMission(c,s){
  const rawRequest=process.env.AUTOPILOT_SPEC || c.project?.spec || "";
  return hasUsableRequest(rawRequest) && rawRequest.trim()!==String(s.planningRequest||"").trim();
}
// Drop the abandoned mission's owned state instead of validating it against the
// new mission. Reuses MISSION_SCOPED_STATE_KEYS rather than a hand-written list,
// and is idempotent with the new-request decision's own clear, so calling it at
// both reconciles cannot change what that decision later prints:
// newMissionTakeoverLines() is built from mission/missionSeq/phase/step/
// planningRequest and the failure counters, none of which are in that list.
function dropAbandonedMissionDebris(c,s){
  if(!suppliedRequestStartsNewMission(c,s)) return false;
  // Mission 055 Phase 1 task 1.2: planning continuation state counts as
  // debris too (reusing the shared hasSpentPlanningContinuations predicate —
  // no new predicate), so a mission whose only residue is spent planner
  // continuations still runs the clear instead of early-returning.
  const hadDebris=MISSION_SCOPED_STATE_KEYS.some(key=>key in s)||hasSpentPlanningContinuations(s);
  if(!hadDebris) return false;
  for(const key of MISSION_SCOPED_STATE_KEYS) delete s[key];
  clearPlanningContinuations(s);
  saveState(s);
  console.log("New request detected — the previous mission's crash-recovery debris is dropped, not validated against the new mission.");
  return true;
}
// Whether a human can answer a prompt. Uses tty.isatty(0), NEVER
// `process.stdin.isTTY`: touching `process.stdin` creates a tty.ReadStream
// that switches fd 0 to non-blocking, so the readSync below then fails
// instantly with EAGAIN — the prompt printed and "answered" itself with an
// empty "no" before the operator could type (seen on WSL2 for both
// `ap stop` and `ap cancel`).
function stdinIsInteractive(){
  try{ return tty.isatty(0); }catch{ return false; }
}
// A blocking single-line read from stdin. Used only by the mission-control
// confirmations (`ap cancel`, `ap stop`): each is a separate CLI process,
// so there is no event loop work to protect and no reason to pull in readline.
// Belt and braces: if fd 0 is non-blocking anyway (a parent left it so),
// EAGAIN means "no input yet", not "no" — wait and retry instead of
// returning an empty answer.
// A blank line that arrives within STALE_ENTER_MS of the prompt is the Enter
// that launched the command leaking through wsl.exe into the WSL pty (seen
// live: the prompt read "\n" before the operator typed anything, so `y` was
// never read and the stop aborted). Skip it and keep waiting for real input.
const STALE_ENTER_MS=250;
function readAnswerSync(){
  const buffer=Buffer.alloc(1024);
  const promptedAt=Date.now();
  for(;;){
    try{
      const bytes=fs.readSync(0,buffer,0,buffer.length,null);
      // The Windows console → wsl.exe bridge can prepend junk to the typed
      // answer (seen live: `y` arrived as "�y" — an invalid byte decoded
      // to U+FFFD). Drop escape sequences, control characters and U+FFFD so
      // only what the operator typed is matched.
      const answer=buffer.slice(0,bytes).toString("utf8")
        .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g,"")
        .replace(/[\u0000-\u001f\u007f�]/g,"")
        .trim();
      if(bytes>0&&answer===""&&Date.now()-promptedAt<STALE_ENTER_MS) continue;
      return answer;
    }catch(e){
      if(e?.code==="EAGAIN"){ sleepSyncMs(50); continue; }
      return "";
    }
  }
}
// Everything `ap cancel` would remove, printed BEFORE it removes anything.
function cancelPlanLines(s){
  const present=MISSION_SCOPED_STATE_KEYS.filter(key=>key in s);
  return [
    `  mission:      ${s.mission||"(none)"}${s.missionSeq?` (seq ${s.missionSeq})`:""}`,
    `  current:      ${s.phase||"unknown"} / ${s.step||"unknown"}`,
    `  will clear:   ${present.length?present.join(", "):"(nothing — already clear)"}`,
    "  will keep:    the mission directory (audit record), failure counters, your files, and the Git working tree (nothing is reverted)",
    "  will set:     phase/step = cancelled, lastCancelled{reason}"
  ];
}
// Printed BEFORE an open mission is abandoned by a new request. The takeover
// itself is deliberate and non-interactive (agents and background runs cannot
// answer a prompt, and a prompt would break `ap run <same request>` resuming),
// so the notice carries the weight: what is being thrown away, what survives,
// what the operator may have forgotten, and the two commands that are the
// alternative (`ap cancel`) or the repair (`ap reset`).
// Mission 055 Phase 1 task 1.2: display-only enumeration of the planning
// continuation entries present in state (for the takeover banner's cleared
// list). Not a predicate — the spent/not-spent decision always reuses the
// shared hasSpentPlanningContinuations() from planning-continuation.mjs.
function spentPlanningContinuationKeys(s){
  const keys=[];
  if(!s||typeof s!=="object") return keys;
  for(const scope of PLANNING_CONTINUATION_SCOPES){
    const budgetKey=continuationBudgetKey(scope);
    if(s.continuationBudgets&&typeof s.continuationBudgets==="object"&&budgetKey in s.continuationBudgets) keys.push(`continuationBudgets:${budgetKey}`);
    if(s.noProgressGenerations&&typeof s.noProgressGenerations==="object"&&budgetKey in s.noProgressGenerations) keys.push(`noProgressGenerations:${budgetKey}`);
    if(s.rolloverDeadEnds&&typeof s.rolloverDeadEnds==="object"&&budgetKey in s.rolloverDeadEnds) keys.push(`rolloverDeadEnds:${budgetKey}`);
    if(s.planningProgressDigests&&typeof s.planningProgressDigests==="object"&&scope in s.planningProgressDigests) keys.push(`planningProgressDigests:${scope}`);
    const ledgerKey=backstopLedgerKey(scope);
    if(s.backstopFirings&&typeof s.backstopFirings==="object"&&ledgerKey in s.backstopFirings) keys.push(`backstopFirings:${ledgerKey}`);
  }
  if(s.lastContinuation&&typeof s.lastContinuation==="object"
    &&PLANNING_CONTINUATION_SCOPES.includes(String(s.lastContinuation.scope||""))) keys.push(`lastContinuation:${s.lastContinuation.scope}`);
  return keys;
}
// Mission 060 Phase 1 task 1.1: a new mission must not inherit the previous
// mission's spent failure counters. Snapshots spent `failureBudgets` key
// names only (`lastFailure`/`lastFailureBudget` are already deleted upstream
// by `dropAbandonedMissionDebris` via `MISSION_SCOPED_STATE_KEYS` or by
// `cancelCommand`, so this helper neither snapshots nor deletes them),
// resets `failureBudgets` to {}, saves, and prints exactly one line.
function clearInheritedFailureCounters(s){
  const spent=Object.entries(s?.failureBudgets||{}).filter(([,value])=>Number(value)>0).map(([key])=>key);
  s.failureBudgets={};
  // Backlog #80: continuation allowances (and their rollover dead-ends) are
  // generic-keyed (phase-0, role names), so they must not leak either.
  const allowances=Object.keys(s?.continuationBudgets||{});
  s.continuationBudgets={};
  if(s.rolloverDeadEnds && typeof s.rolloverDeadEnds==="object") s.rolloverDeadEnds={};
  saveState(s);
  console.log(`Failure counters cleared for the new mission: ${spent.length?spent.join(", "):"none"}`);
  console.log(`Continuation allowances cleared for the new mission: ${allowances.length?allowances.join(", "):"none"}`);
}
function newMissionTakeoverLines(s,request,preClearedPlanningKeys=[]){
  const spent=Object.entries(s.failureBudgets||{}).filter(([,value])=>Number(value)>0);
  const clip=text=>{
    const value=String(text||"").trim();
    return value.length>110?`${value.slice(0,110)}…`:value;
  };
  const lines=[
    "==============================================================",
    "NEW REQUEST DETECTED WHILE A PREVIOUS MISSION IS STILL OPEN",
    "The open mission is being abandoned to start a new one.",
    "==============================================================",
    `  abandoning:  ${s.mission||"(unnamed)"}${s.missionSeq?` (seq ${s.missionSeq})`:""} — ${s.phase||"unknown"}/${s.step||"unknown"}`,
    `  its request: ${clip(s.planningRequest)||"(none recorded)"}`,
    `  new request: ${clip(request)||"(none)"}`,
    "  kept:        the abandoned mission's directory (audit record), and your files — the Git"
  ];
  lines.push("               working tree is NOT reverted and nothing is deleted");
  // Mission 055 Phase 1 task 1.2: spent planning continuation counters are
  // listed as cleared for the new mission. The failure-counter list below
  // names spent keys as cleared below (the helper line after the banner is
  // the run's only failure-counter clear line). Reuses the shared
  // hasSpentPlanningContinuations predicate (no new predicate); the key list
  // below is display-only enumeration, not a second predicate. The optional
  // preClearedPlanningKeys covers entries dropAbandonedMissionDebris already
  // cleared earlier in this same run (same shared predicate, snapshotted
  // before that clear) so the banner still reports what was reset.
  const planningSpent=hasSpentPlanningContinuations(s)||preClearedPlanningKeys.length>0;
  const planningKeys=[...preClearedPlanningKeys];
  for(const key of spentPlanningContinuationKeys(s)) if(!planningKeys.includes(key)) planningKeys.push(key);
  if(planningSpent){
    lines.push("  cleared:      planning continuation counters cleared for the new mission (planner/plan_reviewer start with a full allowance):");
    for(const key of planningKeys) lines.push(`                 ${key}`);
  }
  if(spent.length){
    lines.push("  failure counters: spent keys cleared below for the new mission:");
    for(const [key,value] of spent) lines.push(`                 ${key} = ${value}`);
  }else if(!planningSpent){
    lines.push("  counters:    none spent — the new mission starts with a clean failure budget.");
  }else{
    lines.push("  counters:    failure budget clean — no failure counters to clear.");
  }
  lines.push("  alternative: ap cancel   (stop the current mission instead of starting a new one)");
  lines.push("==============================================================");
  return lines;
}
function cancelCommand(args=[]){
  const yes=args.includes("--yes");
  const dryRun=args.includes("--dry-run");
  const reason=args.filter((value,index)=>!value.startsWith("--")&&args[index-1]!=="--repo").join(" ").trim();
  const s=loadState();
  // Liveness is ground truth and uses the same WSL-aware detector as
  // `ap stop`: a run living inside WSL is stopped where it runs instead of
  // being missed by a Windows-only check and orphaned past the cancel.
  const found=stopLivePid();
  if(found.ambiguous){
    console.error(`ap cancel: ${found.ambiguous.length} live runs match this repository (pids ${found.ambiguous.join(", ")}). Stop them by hand, then re-run cancel.`);
    return 1;
  }
  const pid=found.pid||null;
  // Nothing to cancel: same wording as `ap stop`, exit 0, nothing written.
  // A live run always proceeds to the plan (liveness is ground truth even if
  // the state file says idle).
  if(!pid){
    if(!fs.existsSync(statePath)||["idle","complete"].includes(s.phase)){
      console.log("No mission is running.");
      return 0;
    }
    if(s.phase==="cancelled"){
      console.log(`The mission${s.mission?` '${s.mission}'`:""} is already cancelled — nothing to cancel. \`ap run "<description>"\` starts a new mission.`);
      return 0;
    }
  }
  const previous={phase:s.phase||null,step:s.step||null,mission:s.mission||null};

  console.log(dryRun ? "ap cancel --dry-run — nothing will be changed. This is what a cancel would do:" : "ap cancel — this will END the active mission and clear its state:");
  for(const line of cancelPlanLines(s)) console.log(line);
  if(reason) console.log(`  reason:       ${reason}`);
  if(pid){
    const gentle=process.platform==="win32"?"taskkill /T (then /T /F)":"SIGTERM (then SIGKILL)";
    console.log(`  live run:     pid ${pid} — will be stopped first (${gentle}); the mission will NOT be resumable after cancel`);
  }
  if(dryRun) return 0;

  // Approve or reject both halves at once. Without a TTY there is nobody
  // to ask, so a scripted or piped cancel must say --yes explicitly rather
  // than killing and cancelling in silence.
  if(!yes){
    if(!stdinIsInteractive()){
      console.error("ap cancel: refusing to act without confirmation and stdin is not interactive. Re-run with --yes (or --dry-run to preview).");
      return 1;
    }
    process.stdout.write(pid
      ? `\nThis will STOP pid ${pid} and END the mission (no resume). Are you sure? [y/N] `
      : "\nCancel this mission? [y/N] ");
    const answer=readAnswerSync();
    if(!/^y(es)?$/i.test(answer)){
      console.log(`aborted — nothing was changed.${!/^n(o)?$/i.test(answer)?` (received ${JSON.stringify(answer)}, expected y or yes)`:""}`);
      return 1;
    }
  }

  // Stop-half first: the kill is verified dead before any state is cleared,
  // so a failed kill aborts with the mission fully intact. (A SIGTERM-flushed
  // state lands before the death we wait on, so the clear below can never
  // race the dying run's own flush.)
  if(pid){
    const killed=killLivePid(pid,"ap cancel");
    if(!killed.ok) return 1;
    sweepDeadRuns(s,pid,killed.method,"ap cancel");
  }

  for(const key of MISSION_SCOPED_STATE_KEYS) delete s[key];
  // Mission 055 Phase 1 task 1.2: a cancelled mission must not hand spent
  // planner continuations to the next mission — clear them with the rest.
  // Implementer keys and failureBudgets survive inside the helper.
  clearPlanningContinuations(s);
  s.phase="cancelled";s.step="cancelled";
  s.lastCancelled={at:now(),reason:reason||null,previousPhase:previous.phase,previousStep:previous.step,mission:previous.mission};
  saveState(s);
  try{ refreshWatchReport(s); }catch{ /* best-effort: a watch write must never break a cancel */ }
  console.log(`Cancelled the active mission${previous.mission?` '${previous.mission}'`:""} (was ${previous.phase||"unknown"}/${previous.step||"unknown"}).`);
  console.log("Failure counters were NOT cleared by cancel (they are kept now and cleared when the next new mission starts; use `ap reset` to zero counters within a mission).");
  console.log("The mission directory is kept as the record. `ap run \"<description>\"` now starts a new mission.");
  return 0;
}
// Backlog #14 task 1.2: `ap uninstall` — project-scoped teardown, modeled
// directly on `cancelCommand` above so the confirmation contract is identical:
// the full plan is printed first (project path + every delete/edit/move path),
// --dry-run prints the plan and writes nothing, --yes skips the y/N prompt, and
// a non-interactive stdin without --yes refuses with exit 1. It differs from
// cancel in WHAT it touches: no mission state is read or cleared, only this
// project's `.autopilot/` directory plus the exact `.autopilot/` line setup
// appended to `.gitignore` (the planning is delegated to the pure planner in
// scripts/uninstall.mjs, which is unit-tested against a fake fs).
// `--repo <path>` needs no parsing here: `repo` is already resolved from
// process.argv at module load, and uninstall takes no positional arguments.
function uninstallCommand(args=[]){
  const yes=args.includes("--yes");
  const dryRun=args.includes("--dry-run");
  const keepMissions=args.includes("--keep-missions");
  // Liveness is ground truth and reuses the same WSL-aware detector as
  // `ap cancel`/`ap stop`: a live run OWNS `.autopilot/` (its state, owner PID
  // file, checkpoints), so deleting the directory out from under it would race
  // the run — refuse instead of guessing.
  const found=stopLivePid();
  if(found.ambiguous){
    console.error(`ap uninstall: ${found.ambiguous.length} live runs match this repository (pids ${found.ambiguous.join(", ")}). Stop them by hand, then re-run uninstall.`);
    return 1;
  }
  if(found.pid){
    console.error(`ap uninstall: a live run (pid ${found.pid}) is using this project's .autopilot/. Stop it with \`ap stop\`, then re-run uninstall.`);
    return 1;
  }
  const plan=planUninstall(repo,{keepMissions});
  if(!plan.setUp){
    // Not set up here: nothing to remove, and — because main() dispatches this
    // BEFORE ensureFirstRun() — no setup wizard is launched in its place.
    console.log("Autopilot is not set up here.");
    return 0;
  }
  console.log(dryRun ? "ap uninstall --dry-run — nothing will be changed. This is what an uninstall would do:" : "ap uninstall — this will remove Autopilot from this project:");
  console.log(`  project:      ${plan.projectPath}`);
  for(const move of plan.moves) console.log(`  will archive: ${move.from} -> ${move.to}`);
  for(const del of plan.deletes) console.log(`  will delete:  ${del.path}${del.recursive?" (recursively)":""}`);
  for(const edit of plan.edits) console.log(`  will edit:    ${edit.path} (remove the exact \`.autopilot/\` line)`);
  if(keepMissions&&plan.moves.length===0) console.log("  note:         no .autopilot/missions/ directory to archive.");
  if(dryRun) return 0;

  // Approve the whole teardown at once. Without a TTY there is nobody to ask,
  // so a scripted or piped uninstall must say --yes explicitly rather than
  // deleting in silence.
  if(!yes){
    if(!stdinIsInteractive()){
      console.error("ap uninstall: refusing to act without confirmation and stdin is not interactive. Re-run with --yes (or --dry-run to preview).");
      return 1;
    }
    process.stdout.write("\nRemove Autopilot from this project? [y/N] ");
    const answer=readAnswerSync();
    if(!/^y(es)?$/i.test(answer)){
      console.log(`aborted — nothing was changed.${!/^n(o)?$/i.test(answer)?` (received ${JSON.stringify(answer)}, expected y or yes)`:""}`);
      return 1;
    }
  }

  // The single side-effecting boundary: moves (the missions archive) land
  // before the deletes that remove `.autopilot/`, and the `.gitignore` edit is
  // applied last.
  executeUninstall(plan);
  console.log(`Autopilot was removed from this project (${plan.projectPath} deleted).`);
  for(const move of plan.moves) console.log(`Missions archived to ${move.to}.`);
  for(const edit of plan.edits) console.log(`Removed the \`.autopilot/\` line from ${edit.path}.`);
  console.log("Nothing outside `.autopilot/` and that one `.gitignore` line was touched.");
  return 0;
}
// Grace period for the gentle half of `ap stop`: long enough for the live
// run's own SIGTERM/SIGINT flush (mark INTERRUPTED + rewrite the watch
// report, synchronously) to finish, short enough that an operator is not
// left waiting on a wedged process before the SIGKILL escalation.
const STOP_GRACE_MS = 10_000;
const STOP_POLL_MS = 250;
const STOP_KILL_WAIT_MS = 3_000;
// process.kill(pid, 0) liveness: ESRCH means dead; EPERM means alive but
// foreign-owned (still counts as alive — it must be waited on, never
// assumed gone). On Linux a zombie (defunct) reads as dead: it lingers only
// because its parent has not reaped it yet, and kill(pid, 0) succeeds on
// zombies — without this check a kill `ap stop` delivered itself looks
// ignored, escalating to SIGKILL for a corpse and then reporting failure.
function pidAlive(pid){
  if(!Number.isInteger(pid)||pid<=0) return false;
  if(process.platform!=="win32"){
    try{
      const stat=fs.readFileSync(`/proc/${pid}/stat`,"utf8");
      const state=stat.slice(stat.lastIndexOf(")")+1).trim().split(/\s+/)[0];
      if(state==="Z") return false;
    }catch{ /* no /proc entry here: fall through to kill(0) */ }
  }
  try{ process.kill(pid,0); return true; }
  catch(e){ return e?.code==="EPERM"; }
}
function sleepSyncMs(ms){
  try{ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.max(0,ms)); }catch{ /* sleep is best-effort */ }
}
function waitForDeath(pid,timeoutMs){
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    if(!pidAlive(pid)) return true;
    sleepSyncMs(STOP_POLL_MS);
  }
  return !pidAlive(pid);
}
// Windows fallback for missionControlLiveRun() (/proc is absent on native
// Windows): single CIM query listing node processes running autopilot.mjs
// run|resume|implement, attributed to THIS repo via --repo realpath
// comparison in the shared scan loop (findRepoLiveRuns in owner-pid.mjs).
// There is no cwd on win32/CIM, so no cwd reader is passed: an
// absolute --repo matching this repo attributes, anything undeterminable
// (relative --repo, no --repo) skips the pid. All matches returned
// (ambiguity resolved by the caller, never by guessing).
function cimLiveRun(){
  if(process.platform!=="win32") return [];
  let out="";
  try{
    const r=spawnSync("powershell",["-NoProfile","-Command","Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*autopilot.mjs*' } | ForEach-Object { Write-Output (\"$($_.ProcessId)|$($_.CommandLine)\") }"],{encoding:"utf8",shell:false,timeout:15000});
    if(!r||r.status!==0) return [];
    out=r.stdout||"";
  }catch{ return []; }
  const cmdByPid=new Map();
  for(const line of out.split(/\r?\n/)){
    const m=/^(\d+)\|(.*)$/.exec(line.trim());
    if(!m) continue;
    cmdByPid.set(Number(m[1]),m[2]);
  }
  const found=findRepoLiveRuns(repo,{listPids:()=>[...cmdByPid.keys()],readCmdline:(pid)=>cmdByPid.get(pid)??null,selfPid:process.pid,platform:"win32"});
  return found;
}
// The live pid for THIS repo, if exactly one can be attributed: the verified
// owner PID file (`.autopilot/owner.pid`) first, then the /proc scan, then
// the CIM fallback on Windows. A verified-live PID file (PID alive, writer
// platform matches, cmdline runs autopilot.mjs run|resume|implement|full for
// this repo) takes precedence — it is returned without consulting the scans.
// A same-platform stale file (dead PID or recycled cmdline) is removed here
// and the scans are consulted as fallback. A cross-platform file (writer
// platform !== reader platform) is never judged stale and never deleted — it
// falls through to the scans untouched. Ambiguous (never on POSIX — the /proc
// scan returns the first match) is reported, never resolved by guessing.
function stopLivePid(){
  // Owner PID file first (mission 041 task 1.3): the run itself claims the
  // repo at start, so a verified claim wins over the process-table scans.
  try{
    const owner=readOwnerPid(repo);
    const verdict=owner?verifyOwnerPid(owner,repo):false;
    if(owner&&verdict===true){
      if(Number.isInteger(owner.pid)&&owner.pid!==process.pid) return {pid:owner.pid};
    }else if(owner&&verdict==="unknown"){
      // Windows claim with an unreadable cmdline (CIM unavailable): neither
      // live nor stale — fall through to the scans WITHOUT deleting the
      // possibly-live run's PID file (mission 041 task 1.1).
    }else if(owner&&owner.platform===process.platform){
      // Same-platform but unverified (dead PID, recycled cmdline, or an
      // unreadable/shape-wrong record from this platform) is stale: clear it
      // and fall through to the scans. Cross-platform (writer !== reader) is
      // never stale — leave it for the scans to fall through to untouched
      // (same rule as the run-start guard in main()).
      try{ removeOwnerPid(repo); }catch{ /* stale cleanup is best-effort */ }
    }
  }catch{ /* PID file check is best-effort; fall through to the scans */ }
  const viaProc=missionControlLiveRun();
  if(viaProc) return {pid:viaProc};
  if(process.platform==="win32"){
    const cim=cimLiveRun();
    if(cim.length===1) return {pid:cim[0]};
    if(cim.length>1) return {ambiguous:cim};
  }
  return {};
}
// Returns "gone" when the pid vanished first, true when signalled,
// "escalate" when the gentle signal is undeliverable by construction (Windows
// console process with no shared console — taskkill without /F can only
// reach GUI message loops, so waiting out the grace period would burn 10s
// for a delivery that can never happen), and false when signalling failed
// (never throws — the caller decides). The taskkill exit code IS checked: a
// failed signal surfaces the clear "could not signal" message immediately,
// not only after the full wait as "still alive". A "process not found"
// failure means the pid raced us to the exit, which is the desired end
// state, so it reports "gone".
// Task 042-1.3: on POSIX the signal goes to the full process GROUP first
// (`-pid`), so a SIGTERM-ignoring adapter child dies with the run on the
// SIGKILL escalation. A pid that is not a group leader has no group by its
// id (`kill(-pid)` throws ESRCH) — fall back to the single PID there, and
// report "gone" only when the single-PID signal is ALSO ESRCH.
function signalPid(pid,force){
  if(process.platform==="win32"){
    let status=null, output="";
    try{
      const r=spawnSync("taskkill",force?["/PID",String(pid),"/T","/F"]:["/PID",String(pid),"/T"],{encoding:"utf8",shell:false,timeout:10000});
      status=r.status; output=`${r.stdout||""}${r.stderr||""}`;
    }catch{ return false; }
    if(status===0) return true;
    if(/not found/i.test(output)) return "gone";
    if(!force&&/forcefully/i.test(output)) return "escalate";
    return pidAlive(pid) ? false : "gone";
  }
  if(!Number.isInteger(pid)||pid<=0) return false;
  const sig=force?"SIGKILL":"SIGTERM";
  try{ process.kill(-pid,sig); return true; }
  catch(e){
    if(e?.code!=="ESRCH") return false;
    try{ process.kill(pid,sig); return true; }
    catch(e2){ return e2?.code==="ESRCH" ? "gone" : false; }
  }
}
function stopPlanLines(s,pid){
  const gentle=process.platform==="win32"?"taskkill /T (then /T /F)":"SIGTERM (then SIGKILL)";
  return [
    `  mission:      ${s.mission||"(none)"}${s.missionSeq?` (seq ${s.missionSeq})`:""}`,
    `  current:      ${s.phase||"unknown"} / ${s.step||"unknown"}`,
    `  live run:     pid ${pid}`,
    `  will do:      send ${gentle}; up to ${STOP_GRACE_MS/1000}s grace to flush state and exit`,
    "  will keep:    everything — mission state, checkpoints, counters, files, and the Git working tree",
    "  resume:       ap run (no message) continues where it stopped",
  ];
}
// Shared kill routine: the stop-half of `ap stop` and of `ap cancel`.
// Gentle signal, grace wait, force escalation, death verification.
// Prints progress and failures itself (tagged with `label`); returns
// {ok:true, method} on success (`method` is null when the pid was already
// gone) or {ok:false} after printing the reason. Never touches state.json
// — the caller owns whatever follows a successful kill.
function killLivePid(pid,label){
  const gentle=process.platform==="win32"?"taskkill /T":"SIGTERM";
  const force=process.platform==="win32"?"taskkill /T /F":"SIGKILL";
  let method=null;
  const first=signalPid(pid,false);
  if(first==="gone"){
    console.log(`pid ${pid} exited on its own before it could be signalled — nothing to stop.`);
    return {ok:true,method:null};
  }
  if(first===false){
    console.error(`${label}: could not signal pid ${pid} (foreign owner or missing permissions). State was NOT touched.`);
    return {ok:false};
  }
  if(first==="escalate"){
    console.log(`Graceful ${gentle} delivery is unavailable here (no shared console) — escalating straight to ${force}...`);
  }else{
    console.log(`Sent ${gentle} to pid ${pid}; waiting up to ${STOP_GRACE_MS/1000}s for it to flush state and exit...`);
    if(waitForDeath(pid,STOP_GRACE_MS)) method=gentle;
  }
  if(!method){
    if(signalPid(pid,true)===false){
      console.error(`${label}: pid ${pid} ignored ${gentle} and the ${force} escalation could not be delivered. State was NOT touched.`);
      return {ok:false};
    }else if(waitForDeath(pid,STOP_KILL_WAIT_MS)){
      method=force;
    }else{
      console.error(`${label}: pid ${pid} is still alive after ${force}. State was NOT touched; stop it by hand.`);
      return {ok:false};
    }
  }
  console.log(`pid ${pid} is gone (${method}).`);
  return {ok:true,method};
}
// Task 042-1.4: confirm a survivor PID still belongs to its run's adapter
// before SIGKILL. On Linux, read /proc/<pid>/stat starttime (field 22,
// ticks since boot), convert to an absolute start time with the boot time
// from /proc/stat (btime), and require it to fall within a small window
// around the run's recorded started_at (started_at - 2s .. + 5s). A PID
// whose start time falls outside that window is a recycled PID now owned
// by an unrelated process and must NOT be killed. Returns true when the
// PID is confirmed, false otherwise. On non-Linux POSIX (e.g. macOS)
// there is no /proc starttime to check, so survivors are treated as
// confirmed-live and killed, since PID reuse cannot be verified there
// and the run claims the PID (same policy as win32).
// Split out so the stale-PID path is unit-greppable without spawning.
function confirmedSurvivorPid(pid,startedAt){
  if(process.platform==="win32") return true;
  if(process.platform!=="linux") return true;
  if(!Number.isInteger(pid)||pid<=0) return false;
  let runStartMs=null;
  try{ runStartMs=new Date(startedAt).getTime(); }catch{ runStartMs=null; }
  if(!Number.isFinite(runStartMs)||runStartMs<=0) return false;
  let ticks=null;
  try{
    const stat=fs.readFileSync(`/proc/${pid}/stat`,"utf8");
    const after=stat.slice(stat.lastIndexOf(")")+1).trim().split(/\s+/);
    // Field 22 (starttime) is index 19 after the comm field is stripped.
    const raw=after[19];
    ticks=Number(raw);
    if(!Number.isFinite(ticks)||ticks<0) return false;
  }catch{ return false; }
  let clkTck=100;
  try{
    const r=spawnSync("getconf",["CLK_TCK"],{encoding:"utf8",shell:false,timeout:5000});
    const n=Number(String(r.stdout||"").trim());
    if(Number.isFinite(n)&&n>0) clkTck=n;
  }catch{ /* default 100 */ }
  let btimeSec=null;
  try{
    for(const line of fs.readFileSync("/proc/stat","utf8").split("\n")){
      const m=/^btime\s+(\d+)/.exec(line.trim());
      if(m){ btimeSec=Number(m[1]); break; }
    }
    if(!Number.isFinite(btimeSec)||btimeSec<=0) return false;
  }catch{ return false; }
  const procStartMs=btimeSec*1000+(ticks*1000/clkTck);
  return procStartMs>=runStartMs-2000&&procStartMs<=runStartMs+5000;
}
// Task 042-1.4: post-kill verification scan. After killLivePid() succeeds,
// any run still reporting status "running" with a LIVE pid is a surviving
// adapter process the owner-group kill did not reap (detached adapter
// groups). Each survivor is identity-checked via confirmedSurvivorPid()
// before SIGKILL: unconfirmed PIDs are reported as "stale PID reused,
// skipped" and left untouched (never killed, never marked). Confirmed
// survivors are SIGKILLed as a process group (same group path as
// signalPid), marked INTERRUPTED, and reported per-run with a
// "verified killed" summary line. Best-effort: never throws, never touches
// state.json — returns {killed, skipped}.
function verifyAndKillSurvivors(s,ownerPid,label){
  const result={killed:0,skipped:0};
  let runs=[];
  try{ runs=listRunsOldestNewest(watchRunsDir(repo,missionFor(repo,s))); }catch{ return result; }
  for(const r of runs){
    if(String(r.status||"")!=="running") continue;
    const pid=Number(r.pid);
    if(!Number.isInteger(pid)||pid<=0) continue;
    if(pid===process.pid) continue;
    if(!pidAlive(pid)) continue;
    let confirmed=true;
    try{ confirmed=confirmedSurvivorPid(pid,r.started_at); }catch{ confirmed=false; }
    if(!confirmed){
      console.log(`pid ${pid} (run ${r.dirName||r.id}): stale PID reused, skipped — not killed.`);
      result.skipped++;
      continue;
    }
    const first=signalPid(pid,true);
    if(first===false){
      console.error(`${label}: survivor pid ${pid} (run ${r.dirName||r.id}) could not be signalled; left alive.`);
      continue;
    }
    const dead=waitForDeath(pid,STOP_KILL_WAIT_MS);
    if(!dead){
      console.error(`${label}: survivor pid ${pid} (run ${r.dirName||r.id}) is still alive after SIGKILL; stop it by hand.`);
      continue;
    }
    try{ markInterrupted(r.dir,{reason:`${label}: survivor adapter pid ${pid} verified killed after owner pid ${ownerPid} terminated`}); }catch{ /* per-run best-effort */ }
    console.log(`run ${r.dirName||r.id} pid ${pid}: verified killed (survivor of owner pid ${ownerPid}).`);
    result.killed++;
  }
  return result;
}
// Sweep the runs we KNOW are dead (never live ones) after a kill and count
// them; the caller refreshes the watch report. Best-effort: a sweep failure
// must never break the command whose kill already succeeded.
function sweepDeadRuns(s,pid,method,label){
  let marked=0;
  try{
    for(const r of listRunsOldestNewest(watchRunsDir(repo,missionFor(repo,s)))){
      if(r.status==="running"&&!pidAlive(r.pid)){
        try{ if(markInterrupted(r.dir,{reason:`${label}: owner pid ${pid} terminated (${method||"already exited"})`}).marked) marked++; }catch{ /* per-run best-effort */ }
      }
    }
  }catch{ /* sweep is best-effort; the kill already succeeded */ }
  return marked;
}
function stopCommand(args=[]){
  const yes=args.includes("--yes");
  const dryRun=args.includes("--dry-run");
  const s=loadState();
  // Liveness is ground truth and is checked first: a live run is stopped
  // even if the state file disagrees about it.
  const found=stopLivePid();
  if(found.ambiguous){
    console.error(`ap stop: ${found.ambiguous.length} live runs match this repository (pids ${found.ambiguous.join(", ")}). Stop them by hand, then re-run.`);
    return 1;
  }
  if(!found.pid){
    const hasFile=fs.existsSync(statePath);
    if(!hasFile||["idle","complete"].includes(s.phase)){
      console.log("No mission is running.");
      return 0;
    }
    if(s.phase==="cancelled"){
      console.log(`The mission${s.mission?` '${s.mission}'`:""} is already cancelled — nothing is running. \`ap run "<description>"\` starts a new mission.`);
      return 0;
    }
    console.log(`The mission${s.mission?` '${s.mission}'`:""} exists but isn't running right now (${s.phase||"unknown"}/${s.step||"unknown"}). If you want to cancel it, use \`ap cancel\`.`);
    // The operator asked to stop THIS mission and the run it targeted is
    // already gone (crashed, killed elsewhere, or finished between the
    // liveness check and the kill): the mission still owns the stop intent,
    // so the watch stream records it as an operator stop with live:false —
    // the same convention `ap reset` uses on its idle path. Gated on the
    // mission directory already existing so a stop on a mission that never
    // materialised cannot invent one.
    const missionDir = getMissionWatchDir(s);
    try{ if (missionDir && fs.existsSync(missionDir)) appendWatchEvent(missionDir, { type: "operator", reason: "stop", scope: "mission", live: false }); }catch{}
    return 0;
  }
  const pid=found.pid;
  console.log(dryRun ? "ap stop --dry-run — nothing will be changed. This is what a stop would do:" : "ap stop — this will STOP the live run but KEEP the mission (resumable):");
  for(const line of stopPlanLines(s,pid)) console.log(line);
  if(dryRun) return 0;

  // Approve or reject, same contract as cancel: no TTY and no --yes = refuse.
  if(!yes){
    if(!stdinIsInteractive()){
      console.error("ap stop: refusing to act without confirmation and stdin is not interactive. Re-run with --yes (or --dry-run to preview).");
      return 1;
    }
    process.stdout.write("\nThis will stop the running run, and the mission will stay saved so you can continue later. Are you sure? [y/N] ");
    const answer=readAnswerSync();
    if(!/^y(es)?$/i.test(answer)){
      console.log(`aborted — nothing was changed.${!/^n(o)?$/i.test(answer)?` (received ${JSON.stringify(answer)}, expected y or yes)`:""}`);
      return 1;
    }
  }

  const killed=killLivePid(pid,"ap stop");
  if(!killed.ok) return 1;
  // Task 042-1.4: post-kill verification scan for surviving adapter
  // processes (detached groups the owner kill did not reap). Verified
  // survivors are SIGKILLed as a group; stale-PID runs are reported and
  // left untouched. Then sweep the runs we KNOW are dead (never live ones):
  // the SIGTERM path flushed itself already (no-op here), while a SIGKILL
  // escalation left running+dead runs that would otherwise confuse the next
  // `ap run` until the 10-minute startup recovery noticed. State.json
  // itself is untouched — kill + keep.
  const survivors=verifyAndKillSurvivors(s,pid,"ap stop");
  const marked=sweepDeadRuns(s,pid,killed.method,"ap stop");
  try{ refreshWatchReport(s); }catch{ /* best-effort: a watch write must never break a run */ }
  const missionDir = getMissionWatchDir(s);
  try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "stop", scope: "mission", live: true }); }catch{}
  console.log(`The mission is saved — \`ap run\` (no message) resumes where it stopped.${marked?` Marked ${marked} dead run(s) INTERRUPTED.`:""}${survivors.killed?` Verified killed ${survivors.killed} surviving adapter run(s).`:""}${survivors.skipped?` Skipped ${survivors.skipped} stale PID(s).`:""}`);
  return 0;
}
// Mission 063 task 1.2 (rev 3): changed files recorded on the operator-edit
// entry. The phase baseline is captured at phase start before the implementer
// runs, so a scoped delta against it contains the phase's own mission work
// and cannot isolate operator-only paths. Per review, the list is left empty
// (digests only) since operator-only paths cannot be determined; the helper
// still records note + time + old->new digests. Informational only — the
// brief header carries no review instruction.
function collectRebaseChangedFiles(s){
  return [];
}
// Backlog #40 (b): warn once per baseline when HEAD moved after capture (an
// operator commit during a pause), because those commits would otherwise
// appear in this phase's delta and the reviewer may call them unrelated work.
const headMovedWarned=new Set();
function warnHeadMovedSinceBaseline(s,key){
  if(!key||headMovedWarned.has(key)) return;
  headMovedWarned.add(key);
  const info=headMovedSinceBaseline(repo,key);
  if(!info.moved) return;
  console.warn(`HEAD moved since baseline ${key} was captured (${info.baseHead.slice(0,12)} -> ${info.head.slice(0,12)}). If an operator committed during a pause, run \`ap rebase\` so those commits do not appear as phase work.`);
}
// Backlog #40: the baseline key for the phase the mission is currently on.
// The identity expression matches the standalone/SpecKit capture sites.
function currentPhaseBaselineKey(s){
  const identity=s?.mission||s?.missionSeq||s?.speckitFeatureDir||"mission";
  const missionKey=`mission-${sanitizeKeySegment(identity)}`;
  return Number.isInteger(s?.phaseIndex)&&s.phaseIndex>=0?`${missionKey}-phase-${s.phaseIndex}`:missionKey;
}
// Backlog #40 (c): an `ap rebase --note` text rides every implementer/reviewer
// brief for the rest of the phase, so the operator's reason is visible where
// the work is judged, not only in the operator log.
function operatorPhaseNoteLine(s){
  const n=s?.operatorPhaseNote;
  if(!n||typeof n.text!=="string"||!n.text.trim()) return "";
  if(Number.isInteger(n.phaseIndex)&&Number.isInteger(s?.phaseIndex)&&n.phaseIndex!==s.phaseIndex) return "";
  return `Operator note: ${n.text.trim()} (from ap rebase)`;
}
// Mission 063 task 1.2: `ap rebase [--note "<why>"] [--yes]` — accept a
// recorded phase-checkpoint delta drift by re-pointing the stored checkpoint
// digest at the observed digest. Confirmation and live-refusal flow mirror
// `stopCommand` above: refuses while a run is live via stopLivePid()
// (ambiguous pids listed, non-zero exit, never kills, never queues), no TTY
// and no `--yes` means refuse, otherwise a y/N prompt via
// stdinIsInteractive()/readAnswerSync(). The mutation itself is delegated to
// the pure rebasePhaseCheckpointDrift() helper; this command only gathers
// inputs (note, changed files, freshly recomputed digest) and persists.
function rebaseCommand(args=[]){
  let note="";
  let yes=false;
  for(let i=0;i<args.length;i++){
    const a=args[i];
    if(a==="--yes"){ yes=true; continue; }
    if(a==="--note"){
      const next=args[i+1];
      note=(typeof next==="string"&&!next.startsWith("--"))?next:"";
      if(typeof next==="string"&&!next.startsWith("--")) i++;
      continue;
    }
    if(a.startsWith("--note=")){ note=a.slice("--note=".length); continue; }
  }
  const s=loadState();
  // Liveness is ground truth and is checked first: a live run is never
  // re-pointed under — refuse, never kill, never queue.
  const found=stopLivePid();
  if(found.ambiguous){
    console.error(`ap rebase: ${found.ambiguous.length} live runs match this repository (pids ${found.ambiguous.join(", ")}). Stop them by hand, then re-run rebase.`);
    return 1;
  }
  if(found.pid){
    console.error(`ap rebase: refusing to rebase while a run is live (pid ${found.pid}). Stop it first (\`ap stop\`), then re-run rebase. State was NOT touched.`);
    return 1;
  }
  const c=cfg();
  let err=s.phaseCheckpointError;
  let detectedDrift=false;
  if(err&&(typeof err!=="object"||Array.isArray(err))) err=null;
  if(!err){
    // #21: `ap rebase` must see drift by itself. When no error is recorded,
    // run the same checkpoint/delta check `ap run` performs on resume.
    let detected=null;
    try{
      detected=evaluateResumeBypass(c,s);
    }catch{ /* no usable checkpoint/config: still rebase the baseline */ }
    const decision=detected&&typeof detected==="object"?detected.decision:null;
    if(decision&&decision.action==="escalate"&&decision.code==="PHASE_CHECKPOINT_DRIFT"&&decision.evidence&&decision.evidence.reason==="delta drift"){
      err={code:decision.code,evidence:decision.evidence};
      detectedDrift=true;
    }
  }
  if(err&&err.code!=="PHASE_CHECKPOINT_DRIFT"){
    console.error(`ap rebase: refusing to rebase: phase checkpoint error is ${JSON.stringify(err.code??null)}, not "PHASE_CHECKPOINT_DRIFT". State was NOT touched.`);
    return 1;
  }
  const recordedReason=err&&err.evidence&&typeof err.evidence==="object"?err.evidence.reason:null;
  if(err){
    console.log("ap rebase — this will ACCEPT the recorded phase-checkpoint drift, re-point the stored checkpoint digest at the observed digest, and rebase the phase baseline onto HEAD:");
    console.log(`  mission:      ${s.mission||"(none)"}${s.missionSeq?` (seq ${s.missionSeq})`:""}`);
    console.log(`  current:      ${s.phase||"unknown"} / ${s.step||"unknown"}`);
    console.log(`  drift reason: ${JSON.stringify(recordedReason??null)}`);
  }else{
    console.log("ap rebase — no phase-checkpoint drift is recorded; rebasing the current phase baseline onto HEAD:");
    console.log(`  mission:      ${s.mission||"(none)"}${s.missionSeq?` (seq ${s.missionSeq})`:""}`);
    console.log(`  current:      ${s.phase||"unknown"} / ${s.step||"unknown"}`);
  }
  if(note) console.log(`  note:         ${note}`);
  if(!yes){
    if(!stdinIsInteractive()){
      console.error("ap rebase: refusing to act without confirmation and stdin is not interactive. Re-run with --yes.");
      return 1;
    }
    process.stdout.write("\nThis will re-point the phase checkpoint/baseline at the observed tree state. Are you sure? [y/N] ");
    const answer=readAnswerSync();
    if(!/^y(es)?$/i.test(answer)){
      console.log(`aborted — nothing was changed.${!/^n(o)?$/i.test(answer)?` (received ${JSON.stringify(answer)}, expected y or yes)`:""}`);
      return 1;
    }
  }
  let currentDeltaDigest=null;
  if(err){
    // Recompute today's delta through the same bypass the run path uses: only
    // a delta-drift escalation carries a fresh observed digest. Anything else
    // (resume, any other reason) means the tree is not in the recorded
    // drifted state — refuse without touching state.
    let bypass=null;
    try{
      bypass=evaluateResumeBypass(c,s);
    }catch(e){
      console.error(`ap rebase: refusing to rebase: could not recompute the current delta (${e?.message||e}). Run ap run, then ap rebase if it drifts again. State was NOT touched.`);
      return 1;
    }
    const decision=bypass&&typeof bypass==="object"?bypass.decision:null;
    if(!decision||decision.action!=="escalate"||decision.code!=="PHASE_CHECKPOINT_DRIFT"||!decision.evidence||decision.evidence.reason!=="delta drift"){
      console.error("ap rebase: refusing to rebase: the current tree is not in the recorded delta-drifted state. Run ap run, then ap rebase if it drifts again. State was NOT touched.");
      return 1;
    }
    currentDeltaDigest=decision.evidence.observedDeltaDigest;
    if(detectedDrift) s.phaseCheckpointError=err;
    const files=collectRebaseChangedFiles(s);
    const result=rebasePhaseCheckpointDrift(s,{files,note,at:now(),currentDeltaDigest});
    if(!result||!result.ok){
      console.error(`ap rebase: refusing to rebase: ${(result&&result.reason)||"the rebase helper refused"}. State was NOT touched.`);
      return 1;
    }
    console.log(`Rebased the phase checkpoint: delta digest ${result.record.expectedDeltaDigest} -> ${result.record.observedDeltaDigest}${files.length?` (${files.length} changed file(s) recorded)`:""}.`);
  }
  const baselineKey=currentPhaseBaselineKey(s);
  const baseline=rebaseBaselineOntoHead(repo,baselineKey);
  if(!baseline.ok){
    console.error(`ap rebase: the checkpoint was rebased in memory but the baseline could not be rebased: ${baseline.reason}. State was NOT saved.`);
    return 1;
  }
  if(baseline.rebased){
    // The baseline now excludes operator commits, so the phase delta shrank;
    // keep the checkpoint digest consistent with the new delta or the next
    // resume would immediately drift again.
    try{
      const nextDelta=scopedDelta(repo,baselineKey,{declaredPaths:baseline.declaredPaths});
      const cp=s[CHECKPOINT_STATE_KEY];
      if(cp&&typeof cp==="object") cp.deltaDigest=deltaDigest(nextDelta);
    }catch(e){
      console.error(`ap rebase: baseline rebased but the checkpoint digest could not be refreshed (${e?.message||e}); run ap run to confirm.`);
    }
  }
  if(note) s.operatorPhaseNote={text:note,at:now(),phaseIndex:Number.isInteger(s.phaseIndex)?s.phaseIndex:null};
  if(err||baseline.rebased||note) saveState(s);
  const missionDir = getMissionWatchDir(s);
  try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "rebase", scope: "phase-checkpoint", note: note || null, baseHead: baseline.baseHead||null, head: baseline.head||null, files: baseline.files.length }); }catch{}
  if(baseline.rebased){
    const skipped=baseline.skipped.length?`; ${baseline.skipped.length} file(s) skipped: ${baseline.skipped.map(x=>`${x.path} (${x.reason})`).join(", ")}`:"";
    const removed=baseline.deleted?.length?`; ${baseline.deleted.length} file(s) removed from the baseline: ${baseline.deleted.join(", ")}`:"";
    console.log(`Rebased baseline ${baselineKey} from ${baseline.baseHead} to ${baseline.head}: ${baseline.files.length} file(s) updated${removed}${skipped}. Backup: ${baseline.backup}.`);
  }else{
    console.log(`Baseline ${baselineKey}: nothing to rebase (${baseline.reason}).`);
  }
  console.log("`ap run` (no message) resumes.");
  return 0;
}
// Backlog #40 (d): `ap finding list` / `ap finding drop <n> [--scope <key>] [--note "<why>"] --yes`
// removes a reviewer finding the operator rejects, from the persisted
// feedback, the code/plan/verifier round history and the last failure
// evidence — instead of hand-editing state.json. The note is kept for audit.
function currentFindingKeys(s,scope){
  if(scope) return [scope];
  const keys=[];
  if(Number.isInteger(s.phaseIndex)){
    keys.push(`standalone-phase:${s.phaseIndex}`,`speckit-phase:${s.phaseIndex}`);
  }
  if(s.phase==="final_review") keys.push("final:standalone","final:speckit");
  return [...new Set(keys.filter(k=>typeof k==="string"&&k))];
}
function lastHistoryFindings(s,key){
  for(const histKey of ["codeReviewHistory","planReviewHistory","verifierHistory"]){
    const rounds=s?.[histKey]?.[key];
    if(!Array.isArray(rounds)) continue;
    for(let i=rounds.length-1;i>=0;i--){
      const list=rounds[i]?.findings;
      if(Array.isArray(list)&&list.length>0) return list;
    }
  }
  return [];
}
function currentFindingEntries(s,scope){
  const out=[];
  const seen=new Set();
  for(const key of currentFindingKeys(s,scope)){
    const feedback=loadReviewFeedback(s,key);
    const findings=feedback.length>0?feedback:lastHistoryFindings(s,key);
    for(const text of findings){
      const norm=String(text||"").toLowerCase().replace(/\s+/g," ").trim();
      if(!norm||seen.has(norm)) continue;
      seen.add(norm);
      out.push({key,text});
    }
  }
  return out;
}
function findingCommand(args=[]){
  const usage="usage: ap finding list|drop <n> [--scope <review-feedback-key>] [--note \"<why>\"] [--yes]";
  let sub=null,index=null,scope=null,note="",yes=false;
  for(let i=0;i<args.length;i++){
    const a=args[i];
    if(a==="--yes"){ yes=true; continue; }
    if(a==="--scope"){ scope=args[i+1]||null; i++; continue; }
    if(a.startsWith("--scope=")){ scope=a.slice(8); continue; }
    if(a==="--note"){ note=args[i+1]||""; i++; continue; }
    if(a.startsWith("--note=")){ note=a.slice(7); continue; }
    if(sub===null){ sub=a; continue; }
    if(index===null&&/^\d+$/.test(a)){ index=Number(a); continue; }
  }
  if((sub!=="list"&&sub!=="drop")||(sub==="drop"&&(!Number.isInteger(index)||index<1))){ console.error(usage); return 1; }
  const s=loadState();
  const entries=currentFindingEntries(s,scope);
  if(sub==="list"){
    if(entries.length===0){ console.log(`No open findings in ${scope?`scope ${scope}`:"the current phase's review feedback"}.`); return 0; }
    console.log(`Open review findings (${scope||"current phase"}):`);
    entries.forEach((entry,n)=>console.log(`  ${n+1}. ${entry.text}`));
    return 0;
  }
  const found=stopLivePid();
  if(found.ambiguous){
    console.error(`ap finding: ${found.ambiguous.length} live runs match this repository (pids ${found.ambiguous.join(", ")}). Stop them by hand, then re-run.`);
    return 1;
  }
  if(found.pid){
    console.error(`ap finding: refusing to edit findings while a run is live (pid ${found.pid}). Stop it first (\`ap stop\`), then re-run. State was NOT touched.`);
    return 1;
  }
  const listed=entries[index-1];
  if(!listed){
    console.error(`ap finding: no finding ${index} in ${scope?`scope ${scope}`:"the current phase's review feedback"}. State was NOT touched.`);
    return 1;
  }
  const target=listed.text;
  const norm=(text)=>String(text||"").toLowerCase().replace(/\s+/g," ").trim();
  const match=(text)=>{const x=norm(text),y=norm(target);return Boolean(x&&y&&(x===y||x.includes(y)||y.includes(x)));};
  console.log("ap finding drop — this removes the finding from persisted review feedback/history:");
  console.log(`  scope:   ${listed.key}`);
  console.log(`  finding: ${index}. ${target}`);
  if(note) console.log(`  note:    ${note}`);
  if(!yes){
    if(!stdinIsInteractive()){ console.error("ap finding: refusing to act without confirmation and stdin is not interactive. Re-run with --yes."); return 1; }
    process.stdout.write("\nRemove this finding? [y/N] ");
    if(!/^y(es)?$/i.test(readAnswerSync())){ console.log("aborted — nothing was changed."); return 1; }
  }
  let removed=0;
  for(const key of Object.keys(s.reviewFeedback||{})){
    const findings=loadReviewFeedback(s,key);
    const dropped=[];
    const kept=findings.filter((f,i)=>{ if(match(f)){ dropped.push(i); return false; } return true; });
    if(dropped.length===0) continue;
    removed+=findings.length-kept.length;
    saveReviewFeedback(s,key,kept);
    const record=s.reviewFindingTasks?.[key];
    if(record&&Array.isArray(record.entries)&&record.entries.length>=findings.length){
      const dropSet=new Set(dropped);
      record.entries=record.entries.filter((_,i)=>!dropSet.has(i));
    }
  }
  for(const histKey of ["codeReviewHistory","planReviewHistory","verifierHistory"]){
    const slots=s[histKey];
    if(!slots||typeof slots!=="object"||Array.isArray(slots)) continue;
    for(const key of Object.keys(slots)){
      const rounds=Array.isArray(slots[key])?slots[key]:[];
      for(const round of rounds){
        if(!round||typeof round!=="object") continue;
        if(Array.isArray(round.findings)){
          const kept=round.findings.filter((f)=>!match(f));
          removed+=round.findings.length-kept.length;
          round.findings=kept;
        }
        if(Array.isArray(round.previous)){
          const kept=round.previous.filter((p)=>!match(p?.finding));
          removed+=round.previous.length-kept.length;
          round.previous=kept;
        }
      }
    }
  }
  if(typeof s.feedback==="string"&&s.feedback.trim()){
    const lines=s.feedback.split("\n");
    const kept=lines.filter((line)=>!match(line));
    if(kept.length!==lines.length){ removed+=lines.length-kept.length; if(kept.join("\n").trim()) s.feedback=kept.join("\n"); else delete s.feedback; }
  }
  if(Array.isArray(s.lastFailure?.evidence)){
    const kept=s.lastFailure.evidence.filter((entry)=>!match(entry?.finding)&&!match(entry?.message));
    removed+=s.lastFailure.evidence.length-kept.length;
    s.lastFailure.evidence=kept;
  }
  s.operatorDroppedFindings=[...(Array.isArray(s.operatorDroppedFindings)?s.operatorDroppedFindings:[]),{finding:target,scope:listed.key,note:note||null,at:now()}].slice(-50);
  saveState(s);
  const missionDir=getMissionWatchDir(s);
  try{ if(missionDir) appendWatchEvent(missionDir,{type:"operator",reason:"finding-drop",scope:listed.key,note:note||null,finding:target.slice(0,200)}); }catch{}
  console.log(`Dropped the finding (${removed} occurrence(s) removed). \`ap run\` (no message) resumes.`);
  return 0;
}
// The live-reset side channel. A request is a SEPARATE FILE, never a state.json
// write: the orchestrator writes state whole-file at every stage and failure
// decision, so a concurrent write from a second process would be silently
// overwritten (a lost update — atomic writes prevent corruption, not clobbering).
function pendingResetPath(){ return path.join(repo,".autopilot","reset-request.json"); }
// Applied at the single failure-decision point in recordAttemptFailure(), i.e.
// inside the RUNNING mission, for the scope about to be recorded. That file now
// holds a QUEUE (scripts/reset-request-queue.mjs), so several `ap reset` requests
// for different budget keys can be armed at once; only the entries whose scope and
// budget key match the decision being recorded are applied, and every other
// entry stays queued until its own decision arrives.
function applyPendingBudgetReset(s,scope){
  applyPendingGlobalReset(s);
  // The WHOLE queue, not one request: many budget keys share one scope (every
  // infrastructure key uses `mission`; implementationFailureBudget and
  // verificationFailureBudget both use `task:<taskScope>`), so a single entry
  // per file would silently drop the operator's other armed resets.
  let requests=null;
  try{ requests=readResetRequests(pendingResetPath()); }catch{ return false; }
  if(!Array.isArray(requests)||requests.length===0) return false;
  let applied=0;
  for(const request of requests){
    // Match the BUDGET KEY and the scope of the decision about to be recorded:
    // `failureBudgets` is keyed `<budgetName>:<scope>` (e.g.
    // `infrastructureRetryBudget:mission`), while the scope alone is just
    // `mission`. `ap reset` writes both, taken from the recorded failure's own
    // `budget` + `scope`. A request for another scope (or another budget family
    // under a shared scope) stays queued until its own decision arrives.
    if(!request||request.scope!==scope) continue;
    const key=request.key;
    if(!key||!String(key).endsWith(`:${scope}`)) continue;
    const used=s.failureBudgets?.[key];
    // Nothing recorded yet → keep the request QUEUED rather than consuming it.
    // Otherwise an operator who arms a reset before the first failure would have it
    // spent on a counter that is already zero, doing nothing — and it would be gone
    // by the time the count actually mattered.
    if(!Number.isFinite(Number(used))||Number(used)<=0) continue;
    // The limit, for the LIVE path: `recordFailureBudget` has not run yet, so read it
    // the same way that function does — the budget name is the key's first segment
    // and the configured value wins over the built-in default. Unreadable config
    // renders as "?" rather than inventing a number.
    let limit=null;
    try{
      const name=String(key).split(":")[0];
      const configured=Number(cfg()?.policy?.failure_budgets?.[name]);
      if(Number.isInteger(configured)&&configured>0) limit=configured;
    }catch{ /* leave as "?" */ }
    delete s.failureBudgets[key];
    const f=s.lastFailure||null;
    s.lastReset={at:now(),scope:key,clearedUsed:used,clearedLimit:limit,
      failure:f?`${f.class}/${f.domain}`:null,role:f?.sourceRole||null,adapter:f?.adapter||null,appliedLive:true};
    // Only THIS key leaves the queue; every other queued request stays armed.
    // The file itself disappears only when this was its last entry.
    try{ removeResetRequest(pendingResetPath(),key); }catch{ /* best-effort */ }
    console.log(`[autopilot] live reset applied for '${key}': cleared ${used}/${limit??"?"} recorded use(s) — continuing instead of escalating.`);
    applied++;
  }
  return applied>0;
}
// Resolve what `ap reset` should clear. `failureBudgets` keys are
// `<budgetName>:<scope>` (e.g. `infrastructureRetryBudget:mission`), while
// `lastFailureBudget` carries `budget` and `scope` separately — so the full key
// must be rebuilt. The bare scope is kept as a last candidate so a state file
// whose map happens to be keyed by the scope alone still resolves.
function resetTargetKey(s,scopeArg){
  const budgets=s.failureBudgets||{};
  const has=key=>Object.prototype.hasOwnProperty.call(budgets,key);
  const recorded=s.lastFailureBudget||null;
  const candidates=[];
  if(scopeArg) candidates.push(scopeArg);
  if(recorded?.budget&&recorded?.scope) candidates.push(`${recorded.budget}:${recorded.scope}`);
  if(recorded?.scope) candidates.push(recorded.scope);
  const hit=candidates.find(has);
  // Queue-time scope must be derived from the KEY itself (`<budgetName>:<scope>`
  // → `<scope>`), matching `failureBudgetScope` at the failure decision — never
  // inherited from `lastFailureBudget.scope`, which may belong to an earlier
  // unrelated failure (e.g. infrastructure `mission` while queueing an
  // implementation `task:<taskScope>` reset). The apply-time matcher requires
  // `request.scope===decisionScope` and `key.endsWith(':'+scope)`.
  const scopeOfKey=(key)=>{ const k=String(key); const i=k.indexOf(":"); return i>=0?k.slice(i+1):k; };
  if(hit) return {key:hit,scope:scopeOfKey(hit)};
  const fallback=candidates.find(Boolean)||null;
  return fallback?{key:fallback,scope:scopeOfKey(fallback)}:{key:null,scope:null};
}
// Backlog #11: the GLOBAL form of `ap reset` (bare, no --scope). Clears every
// spent failure budget, every continuation allowance (+ no-progress counters),
// rollover dead-ends and the planning revision COUNTER only. reviewFeedback,
// stage position, checkpoints, hand-off notes and everything else are kept.
// Returns the list of cleared entries as display strings.
const GLOBAL_RESET_KEY="__global__";
function clearAllSpentCounters(s){
  const cleared=[];
  for(const [k,v] of Object.entries(s.failureBudgets||{})){
    if(Number(v)>0){ cleared.push(`failureBudgets:${k}=${v}`); }
    delete s.failureBudgets[k];
  }
  for(const [k,v] of Object.entries(s.continuationBudgets||{})){ cleared.push(`continuationBudgets:${k}=${v}`); delete s.continuationBudgets[k]; }
  for(const [k,v] of Object.entries(s.noProgressGenerations||{})){ delete s.noProgressGenerations[k]; }
  for(const [k,v] of Object.entries(s.rolloverDeadEnds||{})){ cleared.push(`rolloverDeadEnds:${k}${Array.isArray(v)?` (${v.length})`:""}`); delete s.rolloverDeadEnds[k]; }
  const rev=s.standalonePlanReview;
  if(rev&&typeof rev==="object"&&Object.prototype.hasOwnProperty.call(rev,"revision")){
    if(Number(rev.revision)>0) cleared.push(`standalonePlanReview.revision=${rev.revision}`);
    delete rev.revision;
  }
  delete s.lastContinuation;
  // Backlog #17: sticky role fallbacks are cleared too (roles return to their primary).
  for(const r of Object.keys(s.activeRoleModels||{})) cleared.push(`activeRoleModels:${r}`);
  if(s.activeRoleModels) s.activeRoleModels={};
  if(s.triedFreeModels) s.triedFreeModels={};
  // Backlog #18: the mission-wide exhausted-model list is spent state too.
  for(const k of Object.keys(s.exhaustedModels||{})) cleared.push(`exhaustedModels:${k}`);
  if(s.exhaustedModels) s.exhaustedModels={};
  return cleared;
}
function applyPendingGlobalReset(s){
  let requests=[];
  try{ requests=readResetRequests(pendingResetPath()); }catch{ return false; }
  if(!requests.some(r=>r&&r.global===true)) return false;
  const cleared=clearAllSpentCounters(s);
  try{ removeResetRequest(pendingResetPath(),GLOBAL_RESET_KEY); }catch{ /* best-effort */ }
  s.lastReset={at:now(),scope:"global",clearedUsed:cleared.length,clearedLimit:null,failure:null,role:null,adapter:null,appliedLive:true};
  console.log(`[autopilot] live global reset applied: cleared ${cleared.length?cleared.join(", "):"nothing spent"} — continuing instead of escalating.`);
  return true;
}
function resetGlobalCommand(s){
  const found=stopLivePid();
  const livePids=found.pid?[found.pid]:(Array.isArray(found.ambiguous)?found.ambiguous:[]);
  if(livePids.length){
    fs.mkdirSync(path.dirname(pendingResetPath()),{recursive:true});
    enqueueResetRequest(pendingResetPath(),{global:true,key:GLOBAL_RESET_KEY,scope:GLOBAL_RESET_KEY,at:now(),requestedBy:"ap reset",requestedPid:process.pid});
    const missionDir = getMissionWatchDir(s);
    try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "reset", scope: "global", live: true }); }catch{}
    console.log(`Global reset REQUESTED — ${livePids.length>1?`runs are alive (pids ${livePids.join(", ")})`:`a run is alive (pid ${livePids[0]})`}, so it is handed to that run.`);
    console.log("  Applies at its next failure or continuation decision, in the same process: every spent counter is cleared and the mission continues instead of escalating.");
    console.log("  Counters only; stage position and every other field are untouched.");
    return 0;
  }
  const stale=readResetRequests(pendingResetPath());
  try{ removeAllResetRequests(pendingResetPath()); }catch{ /* none */ }
  const cleared=clearAllSpentCounters(s);
  if(!cleared.length&&!stale.length){
    console.error("ap reset: nothing is spent anywhere (failureBudgets, continuationBudgets, rolloverDeadEnds, standalonePlanReview.revision). Nothing to clear. To target one key explicitly pass `--scope <key>`.");
    return 1;
  }
  s.lastReset={at:now(),scope:"global",clearedUsed:cleared.length,clearedLimit:null,failure:null,role:null,adapter:null,appliedLive:false};
  saveState(s);
  const missionDir = getMissionWatchDir(s);
  try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "reset", scope: "global", live: false }); }catch{}
  console.log(`Reset ALL spent counters (${cleared.length}):`);
  for(const c of cleared) console.log(`  cleared ${c}`);
  for(const old of stale) console.log(`  discarded a stale reset request for '${old?.key||old?.scope}' left behind by an earlier run.`);
  console.log("  counters only — stage position, checkpoints, hand-off notes, reviewFeedback and every other field are untouched.");
  console.log("  `ap run` (no message) now resumes the same mission at the same position.");
  return 0;
}
// Mission 086: the standalone plan-revision counter (`standalonePlanReview.revision`)
// has its own reset scope (`standalone-plan-revision`). Offline it clears ONLY
// the counter (findings, reviewFeedback, budgets and dead-ends are kept); live
// it queues a request consumed at the top of the runStandalonePlanning revision
// loop and just before its revision>=maxRevisions cap checks.
function resetPlanRevisionCommand(s){
  const found=stopLivePid();
  const livePids=found.pid?[found.pid]:(Array.isArray(found.ambiguous)?found.ambiguous:[]);
  if(livePids.length){
    fs.mkdirSync(path.dirname(pendingResetPath()),{recursive:true});
    enqueueResetRequest(pendingResetPath(),{...planRevisionResetRequest(s?.mission),at:now(),requestedBy:"ap reset",requestedPid:process.pid});
    const missionDir = getMissionWatchDir(s);
    try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "reset", scope: "plan-revision", live: true }); }catch{}
    console.log(`Reset REQUESTED for '${PLAN_REVISION_RESET_KEY}' — ${livePids.length>1?`runs are alive (pids ${livePids.join(", ")})`:`a run is alive (pid ${livePids[0]})`}, so it is handed to that run.`);
    console.log("  Applies at its next planning-revision decision, in the same process: the revision counter restarts instead of escalating.");
    console.log("  Revision counter only; findings, reviewFeedback and every other field are untouched.");
    return 0;
  }
  const stale=readResetRequests(pendingResetPath());
  try{ removeAllResetRequests(pendingResetPath()); }catch{ /* none */ }
  const before=s?.standalonePlanReview && typeof s.standalonePlanReview==="object" ? s.standalonePlanReview.revision : undefined;
  const cleared=clearPlanRevisionCounter(s);
  if(cleared===null&&!stale.length){
    console.error(`ap reset: '${PLAN_REVISION_RESET_KEY}' has no recorded revision. Nothing to clear (see \`standalonePlanReview.revision\` in state.json).`);
    return 1;
  }
  const used=Number(before);
  s.lastReset={at:now(),scope:PLAN_REVISION_RESET_KEY,clearedUsed:Number.isFinite(used)?used:(cleared??0),clearedLimit:null,failure:null,role:null,adapter:null,appliedLive:false};
  saveState(s);
  const missionDir = getMissionWatchDir(s);
  try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "reset", scope: "plan-revision", live: false }); }catch{}
  console.log(`Reset '${PLAN_REVISION_RESET_KEY}': cleared revision ${cleared??0}.`);
  for(const old of stale) console.log(`  discarded a stale reset request for '${old?.key||old?.scope}' left behind by an earlier run.`);
  console.log("  revision counter only — findings, reviewFeedback, stage position, checkpoints and every other field are untouched.");
  console.log("  `ap run` (no message) now resumes the same mission at the same position.");
  return 0;
}
// Backlog #17: `ap reset --scope fallback:<role>` clears that role's sticky
// fallback and tried-free list. Offline only: a live run would overwrite it.
function resetFallbackCommand(s,role){
  const found=stopLivePid();
  if(found.pid||(Array.isArray(found.ambiguous)&&found.ambiguous.length)){
    console.error(`ap reset: a run is alive — stop it first (\`ap stop\`), then \`ap reset --scope fallback:${role}\` (or a bare \`ap reset\`, which a live run applies itself).`);
    return 1;
  }
  const had=s.activeRoleModels?.[role]; const tried=s.triedFreeModels?.[role];
  // Backlog #18: only the entries THIS role marked exhausted are cleared.
  const exhaustedKeys=Object.entries(s.exhaustedModels||{}).filter(([,v])=>v?.by===role).map(([k])=>k);
  if(!role||(!had&&!(Array.isArray(tried)&&tried.length)&&!exhaustedKeys.length)){
    console.error(`ap reset: role '${role}' has no sticky fallback, tried-model list or exhausted models. Nothing to clear (see \`activeRoleModels\`, \`triedFreeModels\` and \`exhaustedModels\` in the state file).`);
    return 1;
  }
  if(s.activeRoleModels) delete s.activeRoleModels[role];
  if(s.triedFreeModels) delete s.triedFreeModels[role];
  if(s.exhaustedModels){
    s.exhaustedModels=Object.fromEntries(Object.entries(s.exhaustedModels).filter(([,v])=>v?.by!==role));
  }
  s.lastReset={at:now(),scope:`fallback:${role}`,clearedUsed:had?1:0,clearedLimit:null,failure:null,role,adapter:null,appliedLive:false};
  saveState(s);
  const missionDir = getMissionWatchDir(s);
  try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "reset", scope: "fallback", role, live: false }); }catch{}
  console.log(`Reset 'fallback:${role}': cleared ${had?`sticky fallback ${had.adapter}/${had.model}`:"no sticky fallback"}${Array.isArray(tried)&&tried.length?` and ${tried.length} tried model(s)`:""}${exhaustedKeys.length?` and ${exhaustedKeys.length} exhausted model(s)`:""}.`);
  console.log(`  ${role} runs on its configured primary again; every other field is untouched.`);
  console.log("  `ap run` (no message) now resumes the same mission at the same position.");
  return 0;
}
function resetCommand(scopeArg){
  const s=loadState();
  if(!scopeArg) return resetGlobalCommand(s);
  if(scopeArg.startsWith("fallback:")) return resetFallbackCommand(s,scopeArg.slice("fallback:".length));
  // Mission 086: the standalone plan-revision counter has its own scope —
  // checked before the continuation/failure resolution below so the
  // colon-free scope is never mistaken for a failure-budget key.
  if(scopeArg===PLAN_REVISION_RESET_SCOPE||scopeArg===PLAN_REVISION_RESET_KEY) return resetPlanRevisionCommand(s);
  // Backlog #27: an explicit continuation target (full key, scope without the
  // prefix, or bare task id) takes the continuation path. Failure budgets keep
  // their existing resolution untouched below.
  if(scopeArg){
    const cont=resetContinuationScope(s,scopeArg);
    if(cont.ambiguous){
      console.error(`ap reset: '${scopeArg}' matches ${cont.ambiguous.length} continuations: ${cont.ambiguous.join(", ")}. Pass the full scope to disambiguate.`);
      return 1;
    }
    if(cont.scope) return resetContinuationCommand(s,cont.scope);
  }
  const recorded=s.lastFailureBudget||null;
  const {key,scope}=resetTargetKey(s,scopeArg);
  if(key) return resetFailureCommand(s,recorded,key,scope);
  // Backlog #27: no failure target — after a *_task_not_converging escalation
  // the recorded continuation is the automatic target (recorded at escalation,
  // like lastFailureBudget).
  if(!scopeArg){
    const cont=resetContinuationScope(s,null);
    if(cont.scope) return resetContinuationCommand(s,cont.scope);
  }
  console.error("ap reset: nothing to target. Pass `--scope <scope>`:");
  console.error("  - a failure budget: the full budget key, or the scope `lastFailureBudget.budget`/`.scope` name in state.json;");
  console.error("  - a task's continuation (session allowance + dead-ends): `continuationAllowance:task:…`, `task:<framework>:phase-N:<taskId>`, or the bare task id (keys under `continuationBudgets` in state.json).");
  console.error("  - the standalone plan revision counter: `standalone-plan-revision` (standalonePlanReview.revision in state.json).");
  console.error("  - a role's sticky model fallback: `fallback:<role>` (activeRoleModels in the state file).");
  return 1;
}
// Backlog #27: resolve a continuation target. Accepted forms: the full key
// (`continuationAllowance:task:standalone:phase-1:<taskId>`), the scope
// without the prefix (`task:standalone:phase-1:<taskId>`), or the bare task
// id (when it names exactly one live continuation). With no scopeArg, the
// escalation-recorded lastContinuation is the automatic target. Returns
// {scope} or {scope:null} (plus {ambiguous} when a bare id matches several).
function resetContinuationScope(s,scopeArg){
  const present=new Set([...Object.keys(s.continuationBudgets||{}),...Object.keys(s.rolloverDeadEnds||{})]);
  const canon=k=>String(k).startsWith(CONTINUATION_BUDGET_KEY_PREFIX)?String(k).slice(CONTINUATION_BUDGET_KEY_PREFIX.length):String(k);
  const hasScope=scope=>present.has(continuationBudgetKey(scope));
  if(scopeArg){
    const raw=String(scopeArg);
    const want=canon(raw);
    if(hasScope(want)) return {scope:want};
    if(!raw.startsWith("task:") && !raw.includes(CONTINUATION_BUDGET_KEY_PREFIX)){
      const matches=[...new Set([...present].map(canon))].filter(sc=>sc.endsWith(`:${raw}`));
      if(matches.length===1) return {scope:matches[0]};
      if(matches.length>1) return {scope:null,ambiguous:matches};
    }
    return {scope:null};
  }
  const last=s.lastContinuation?.scope||null;
  if(last && hasScope(canon(last))) return {scope:canon(last)};
  return {scope:null};
}
// Backlog #27: clear a task's continuation allowance AND its dead ends. The
// hand-off note is deliberately KEPT (default): it is the useful resume
// context — the next run starts from the previous session's conclusions,
// while the generation counter and digest restart fresh.
function resetContinuationCommand(s,contScope){
  const fullKey=continuationBudgetKey(contScope);
  const found=stopLivePid();
  const livePids=found.pid?[found.pid]:(Array.isArray(found.ambiguous)?found.ambiguous:[]);
  if(livePids.length){
    // Live case: hand the request to the running mission — same side-channel
    // file as the failure-budget path. It applies at the next continuation
    // decision for this scope (maybeApplyPendingContinuationReset), so the
    // mission continues on a fresh allowance instead of escalating. QUEUED, so
    // a second `ap reset` for another key never clobbers the first.
    fs.mkdirSync(path.dirname(pendingResetPath()),{recursive:true});
    enqueueResetRequest(pendingResetPath(),{key:fullKey,scope:contScope,at:now(),requestedBy:"ap reset",requestedPid:process.pid});
    const missionDir = getMissionWatchDir(s);
    try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "reset", scope: "continuation", contScope, live: true }); }catch{}
    console.log(`Reset REQUESTED for '${fullKey}' (scope '${contScope}') — ${livePids.length>1?`runs are alive (pids ${livePids.join(", ")})`:`a run is alive (pid ${livePids[0]})`}, so it is handed to that run.`);
    console.log("  Applies at its next continuation decision for that scope, in the same process: the mission continues on a fresh allowance instead of escalating.");
    console.log("  Allowance + dead-ends only; stage position and every other field are untouched. The task hand-off note is kept.");
    return 0;
  }
  // Idle case: apply directly, and discard any stale request so a leftover can
  // never fire during some later run.
  const stale=readResetRequests(pendingResetPath());
  try{ removeAllResetRequests(pendingResetPath()); }catch{ /* none */ }
  const used=s.continuationBudgets?.[fullKey];
  const deadList=s.rolloverDeadEnds?.[fullKey];
  const deadCount=Array.isArray(deadList)?deadList.length:0;
  if(used===undefined && deadCount===0 && !stale.length){
    console.error(`ap reset: '${fullKey}' has no recorded allowance or dead-ends. Nothing to clear (see \`continuationBudgets\`/\`rolloverDeadEnds\` in state.json).`);
    return 1;
  }
  const owner=s.lastContinuation && s.lastContinuation.scope===contScope ? s.lastContinuation : null;
  const noteRel=owner?.mission && owner?.taskRef ? handoffNoteRelPath(owner.mission,owner.taskRef) : null;
  const noteKept=noteRel && fs.existsSync(path.join(repo,noteRel));
  if(used!==undefined && s.continuationBudgets) delete s.continuationBudgets[fullKey];
  if(deadList!==undefined && s.rolloverDeadEnds) delete s.rolloverDeadEnds[fullKey];
  clearNoProgress(s,contScope);
  clearLastContinuation(s,contScope);
  const limit=resolveContinuationAllowance(cfg()?.policy);
  s.lastReset={at:now(),scope:fullKey,clearedUsed:used??0,clearedLimit:limit,
    failure:null,role:null,adapter:null,appliedLive:false};
  saveState(s);
  const missionDir = getMissionWatchDir(s);
  try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "reset", scope: "continuation", contScope, live: false }); }catch{}
  console.log(`Reset '${fullKey}': cleared allowance ${used??0}/${limit} and ${deadCount} dead-end entr${deadCount===1?"y":"ies"}.`);
  console.log(noteKept
    ? `  kept the task hand-off note at ${noteRel} (notes are never cleared by reset).`
    : `  kept the task hand-off note (notes are never cleared by reset).`);
  for(const old of stale) console.log(`  discarded a stale reset request for '${old?.key||old?.scope}' left behind by an earlier run.`);
  console.log("  allowance + dead-ends only — stage position, checkpoints and every other field are untouched.");
  console.log("  `ap run` (no message) now resumes the same mission at the same position.");
  return 0;
}
// The failure-budget half of `ap reset` (unchanged behavior): resolve the
// recorded failure's own key or a named key, queue while live, apply while
// idle. Counters only — position, checkpoints and lastFailure survive.
function resetFailureCommand(s,recorded,key,scope){
  // WSL-aware ground truth (shared with stop/cancel): a /proc-only check would
  // miss a live run on native Windows and clear its counters underneath it —
  // the lost update the live path exists to prevent. Several matches (Windows
  // only) still queue safely: whichever run honors the request applies it to
  // this repo's mission.
  const found=stopLivePid();
  const livePids=found.pid?[found.pid]:(Array.isArray(found.ambiguous)?found.ambiguous:[]);
  if(livePids.length){
    // Live case: hand the request to the running mission. It applies inside the
    // SAME run at the next failure decision for this scope, so the mission
    // continues instead of escalating — no stop and no restart. QUEUED, so a
    // second `ap reset` for another key never clobbers the first.
    fs.mkdirSync(path.dirname(pendingResetPath()),{recursive:true});
    enqueueResetRequest(pendingResetPath(),{key,scope,at:now(),requestedBy:"ap reset",requestedPid:process.pid});
    const missionDir = getMissionWatchDir(s);
    try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "reset", scope: "failure-budget", key, live: true }); }catch{}
    console.log(`Reset REQUESTED for '${key}' (scope '${scope}') — ${livePids.length>1?`runs are alive (pids ${livePids.join(", ")})`:`a run is alive (pid ${livePids[0]})`}, so it is handed to that run.`);
    console.log("  Applies at its next failure decision for that scope, in the same process: the mission continues instead of escalating.");
    console.log("  Counters only; stage position and every other field are untouched.");
    return 0;
  }
  // Idle case: apply directly, and discard any stale request so a leftover can
  // never fire during some later run.
  const stale=readResetRequests(pendingResetPath());
  try{ removeAllResetRequests(pendingResetPath()); }catch{ /* none */ }
  const budgets=s.failureBudgets||{};
  const used=budgets[key];
  if(used===undefined && !stale.length){
    console.error(`ap reset: '${key}' has no recorded uses — neither a failure budget, a task continuation (session allowance/dead-ends), nor the standalone plan revision counter (\`standalone-plan-revision\`). Nothing to clear (see \`failureBudgets\`, \`continuationBudgets\` and \`standalonePlanReview.revision\` in state.json).`);
    return 1;
  }
  const f=s.lastFailure||null;
  const limit=recorded&&recorded.budget&&recorded.scope&&`${recorded.budget}:${recorded.scope}`===key?recorded.limit:null;
  if(used!==undefined) delete budgets[key];
  s.failureBudgets=budgets;
  s.lastReset={at:now(),scope:key,clearedUsed:used??0,clearedLimit:limit,
    failure:f?`${f.class}/${f.domain}`:null,role:f?.sourceRole||null,adapter:f?.adapter||null,appliedLive:false};
  saveState(s);
  const missionDir = getMissionWatchDir(s);
  try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "reset", scope: "failure-budget", key, live: false }); }catch{}
  console.log(`Reset '${key}': cleared ${used??0}/${limit??"?"} recorded use(s).`);
  if(f) console.log(`  overriding: ${f.class}/${f.domain}${f.sourceRole?` (role ${f.sourceRole})`:""}${f.adapter?` on ${f.adapter}`:""} — retryable=${f.retryable}`);
  for(const old of stale) console.log(`  discarded a stale reset request for '${old?.key||old?.scope}' left behind by an earlier run.`);
  console.log("  counters only — stage position, checkpoints and every other field are untouched.");
  console.log("  `ap run` (no message) now resumes the same mission at the same position.");
  return 0;
}
// Backlog #26 Step A: the task hand-off note. The implementer keeps it
// current at handoffNoteRelPath(mission, taskDisplayRef(...)); the next
// generation of the same task reads it at prompt build. Best-effort file IO
// only — a missing/unreadable note renders nothing, never a failure.
function readHandoffNote(missionName, taskRef){
  try{
    if(!missionName || !taskRef) return "";
    return fs.readFileSync(path.join(repo,handoffNoteRelPath(missionName,taskRef)),"utf8");
  }catch{ return ""; }
}
// Removed when the task completes (same sites that clear its continuation
// allowance and dead ends), so a later retry of a DIFFERENT attempt never
// inherits a stale note. Kept on escalation (post-mortem, like dead ends)
// and kept by `ap reset` (the note is the useful resume context).
// Backlog #32: quote the code the note's "Next" cites into the next brief, so
// the continuation edits from the quote instead of re-reading the file. Reads
// only repo-relative files inside the repo; best-effort, never a failure.
function handoffNoteExcerptsFor(missionName, taskRef){
  try{
    const note=readHandoffNote(missionName,taskRef);
    if(!note) return "";
    const root=path.resolve(repo);
    return handoffNoteCitedExcerpts(note,(rel)=>{
      const abs=path.resolve(root,rel);
      if(abs!==root && !abs.startsWith(root+path.sep)) return null;
      try{ return fs.readFileSync(abs,"utf8"); }catch{ return null; }
    });
  }catch{ return ""; }
}
// Mission 050 Phase 1 task 1.2: fix-pass excerpt reader + hand-off pointer,
// shared by the standalone and SpecKit taskRetryFindings assembly sites.
// The pointer names the buildTaskPrompt section that already renders the
// note, so the block never duplicates note text; fixPassBriefExcerpts
// supplies the orchestrator-read excerpts and ends with the single
// edit-first instruction.
const FIX_PASS_HANDOFF_POINTER='The prior hand-off note is in the "Hand-off note from the previous session" section above and is not repeated here.';
// Mission 050 final-review fix: the pointer is added only when the task has a
// hand-off note — a completed task's note is cleared, and pointing at a
// section that is not in the prompt misleads the fix pass.
function fixPassHandoffPointer(noteText){
  return typeof noteText==="string" && noteText.trim() ? `${FIX_PASS_HANDOFF_POINTER}\n` : "";
}
function fixPassBriefReadFile(rel){
  try{
    const root=path.resolve(repo);
    const abs=path.resolve(root,rel);
    if(abs!==root && !abs.startsWith(root+path.sep)) return null;
    try{ return fs.readFileSync(abs,"utf8"); }catch{ return null; }
  }catch{ return null; }
}
// Backlog #32: no-progress stop, shared by both loops' continuation sites. A
// generation that changed no project file counts; policy.no_progress_generations
// (default 2) consecutive ones escalate instead of burning the rest of the
// continuation allowance. Note + dead ends are kept (resume context).
// Mission 031 Phase 4 task 4.4: role-appropriate progress signal for
// read-only review roles (code_reviewer/verifier). Review generations never
// touch project files, so touchedFiles is always empty — instead progress is
// the Found section entry count in the role's handoff note growing (via
// parseFoundEntries). No note exists = no progress (empty signal, counts
// toward the no-progress limit). Per-scope last count is tracked on
// s.reviewFoundCounts; a generation whose count grew returns a non-empty
// synthetic signal so recordGenerationProgress resets the counter, otherwise
// empty so it counts. Pure IO except the state cache update; never throws.
function reviewNoProgressTouchedFiles(missionName, taskRef, contScope, s){
  let note="";
  try{ note=readHandoffNote(missionName, taskRef); }catch{ note=""; }
  if(!note) return [];
  let count=0;
  try{ count=parseFoundEntries(note); }catch{ count=0; }
  s.reviewFoundCounts = s.reviewFoundCounts && typeof s.reviewFoundCounts==="object" ? s.reviewFoundCounts : {};
  const prev = s.reviewFoundCounts[contScope];
  s.reviewFoundCounts[contScope]=count;
  if(typeof prev!=="number") return count>0 ? [`found:${count}`] : [];
  return count>prev ? [`found:${prev}->${count}`] : [];
}
function stopOnNoProgress(s,c,{framework,contScope,taskId,missionName,taskRef,touchedFiles,checkpoint,step}){
  const consecutive=recordGenerationProgress(s,contScope,touchedFiles);
  const limit=resolveNoProgressGenerations(c.policy);
  if(consecutive<limit) return;
  s.phase="escalated";s.step=step ?? `${framework}_task_no_progress`;
  s.phaseCheckpointError={code:"NO_PROGRESS",evidence:{taskId,consecutive,limit}};
  recordLastContinuation(s,{contScope,taskId,missionName,taskRef});
  s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
  if(step==="standalone_planning_no_progress"){
    die(`Standalone planner made no PLAN.md/TASKS.md change in ${consecutive} consecutive sessions (policy.no_progress_generations=${limit}). STOP — human intervention required: read the planning handoff note, then
Resume: ap reset --scope ${contScope} then ap run`);
  }
  // Backlog #74 (mission 068 Phase 1 task 1.2): display label from the pure
  // noProgressDisplayLabel helper — real task id wins, else a phase/role
  // label from taskRef, never "task null". Labels starting with "task(s) "
  // take the framework prefix (byte-identical implementer text); labels that
  // already carry the prefix (role fallbacks) are used directly.
  const noProgLabel=noProgressDisplayLabel({taskId,taskRef,framework});
  const noProgSubject=/^tasks?\s/i.test(noProgLabel)?`${framework==="speckit"?"SpecKit":"Standalone"} ${noProgLabel}`:noProgLabel;
  die(`${noProgSubject} changed no file in ${consecutive} consecutive sessions (policy.no_progress_generations=${limit}). STOP — human intervention required: read the task hand-off note, then
Resume: ap reset --scope ${contScope} then ap run`);
}
function clearHandoffNote(missionName, taskRef){
  try{
    if(!missionName || !taskRef) return false;
    fs.rmSync(path.join(repo,handoffNoteRelPath(missionName,taskRef)),{force:true});
    return true;
  }catch{ return false; }
}
// Backlog #34c (mission 027 Phase 2 task 2.3): fresh-note wrap-up skip. The
// cap/wrap-up trigger in runRelay() skips the wrap-up resume when the
// in-session hand-off note is already fresh (written at a milestone after
// the last project edit, within the bounded window): the note already holds
// the resume context, so a second wrap-up turn only burns tokens. Helpers
// live here (shared runRelay path, so both standalone and SpecKit loops are
// covered via taskRef). Best-effort file IO only — any unreadable input
// degrades to stale (wrap-up proceeds as today), never a failure.
// Newest project-file mtime under root. Skips .git/.autopilot/node_modules
// at every level (the note itself lives under .autopilot and must never
// count as a project edit). Returns null when nothing is statable.
function lastProjectEditMtimeMs(root=repo){
  let latest=null;
  const skip=new Set([".git",".autopilot","node_modules"]);
  const walk=(d)=>{
    let entries;
    try{ entries=fs.readdirSync(d,{withFileTypes:true}); }catch{ return; }
    for(const e of entries){
      const p=path.join(d,e.name);
      if(e.isDirectory()){
        if(skip.has(e.name)) continue;
        walk(p);
      }else if(e.isFile()){
        try{
          const mtime=fs.statSync(p).mtimeMs;
          if(Number.isFinite(mtime) && (latest===null || mtime>latest)) latest=mtime;
        }catch{}
      }
    }
  };
  try{ walk(path.resolve(root)); }catch{ return null; }
  return latest;
}
// Freshness of the task hand-off note for the wrap-up skip. Stats the note
// file (text + mtime), scans the project tree, and delegates the decision
// to the pure unit-tested isHandoffNoteFresh helper. Returns its
// {fresh, reason} shape directly.
function handoffNoteFreshnessForWrapUp(missionName, taskRef){
  try{
    if(!missionName || !taskRef) return {fresh:false,reason:"missing_note"};
    const abs=path.join(repo,handoffNoteRelPath(missionName,taskRef));
    let noteText=null, noteMtimeMs=null;
    try{
      noteText=fs.readFileSync(abs,"utf8");
      noteMtimeMs=fs.statSync(abs).mtimeMs;
    }catch{
      return {fresh:false,reason:"missing_note"};
    }
    return isHandoffNoteFresh({noteText,noteMtimeMs,lastProjectEditMtimeMs:lastProjectEditMtimeMs(repo),nowMs:Date.now()});
  }catch{
    return {fresh:false,reason:"missing_note"};
  }
}
// Backlog #34d (mission 027 Phase 3 task 3.2): end-of-task grace finishing
// evidence, scanned from decoded adapter events. The monitor looks only at
// the latest assistant text (for AUTOPILOT_TASK_RESULT line) and the latest
// bash command result (for verify-passed with exit 0 and non-zero pass count).
// Returns strict booleans only — the pure evaluateCapGraceWindow helper reads
// any non-boolean evidence as ambiguous (ineligible), so this must never
// return truthy non-booleans or nullish unknowns.
function capGraceFinishingEvidence(events){
  const evs = Array.isArray(events) ? events : [];
  // writingFinalResult: latest assistant text has a LINE whose trimStart
  // starts with AUTOPILOT_TASK_RESULT followed by \s*[:=]
  let writingFinalResult = false;
  let latestAssistantText = "";
  for (const event of evs) {
    if (event?.type === "text" && typeof event.part?.text === "string") {
      latestAssistantText = event.part.text;
    } else if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          latestAssistantText = block.text;
        }
      }
    } else if (event?.type === "result" && typeof event.result === "string") {
      latestAssistantText = event.result;
    }
  }
  if (latestAssistantText) {
    for (const line of latestAssistantText.split(/\r?\n/)) {
      const trimmed = line.trimStart();
      if (/^AUTOPILOT_TASK_RESULT\s*[:=]/.test(trimmed)) {
        writingFinalResult = true;
        break;
      }
    }
  }
  // verifyPassed: LATEST bash command result with finite exit, exit===0 AND
  // its output has a pass line matching tests?|checks? passed but NOT
  // "0 tests? passed" (exclude \b0\s+tests?\s+passed).
  let verifyPassed = false;
  let latestBashOutput = "";
  let latestBashExit = null;
  for (const event of evs) {
    if (event?.part?.tool === "bash") {
      const state = event.part.state || {};
      const meta = state.metadata || {};
      const exitValue = Number.isFinite(Number(meta.exit)) ? Number(meta.exit) : null;
      if (exitValue !== null) {
        latestBashExit = exitValue;
        const output = String(meta.output ?? state.output ?? "");
        latestBashOutput = output;
      }
    }
  }
  if (latestBashExit === 0 && latestBashOutput) {
    const passMatch = /(?:\btests?\s+passed\b|\bchecks?\s+passed\b)/i.exec(latestBashOutput);
    const zeroMatch = /\b0\s+tests?\s+passed\b/i.exec(latestBashOutput);
    if (passMatch && !zeroMatch) {
      verifyPassed = true;
    }
  }
  return {verifyPassed, writingFinalResult};
}
// Mission 022 phase 2 (task 2.2): render prior-attempt out-of-sandbox
// auto-reject warnings (scripts/adapter-drivers.mjs,
// out_of_sandbox_auto_reject_warning) into a bounded retry-prompt note.
// The warning is a non-terminal observation — never a PERMISSION_DENIED
// classification input (see scripts/failure-contract.mjs) — but the retried
// role still needs to know which path/command the engine auto-rejected so
// it does not retry it. Reads result.observations only; reviewer findings
// (feedback/taskRetryFindings) and resumeNote are assembled separately at
// the per-task relay() call sites below. Bounded: at most 5 entries, at
// most 2000 chars. Returns "" when no warning observation is present.
const OUT_OF_SANDBOX_AUTO_REJECT_WARNING_TYPE="out_of_sandbox_auto_reject_warning";
function autoRejectRetryNote(results=[]){
  const entries=[];
  for(const result of results){
    const observations=result?.observations;
    if(!Array.isArray(observations)) continue;
    for(const observation of observations){
      if(observation?.type!==OUT_OF_SANDBOX_AUTO_REJECT_WARNING_TYPE) continue;
      const tool=String(observation?.tool||"tool");
      const target=String(observation?.path||observation?.command||"").slice(0,300);
      entries.push(`- ${tool}${target?` ${target}`:""}: out-of-sandbox request auto-rejected (non-terminal); stay inside the sandbox`);
      if(entries.length>=5) break;
    }
    if(entries.length>=5) break;
  }
  if(!entries.length) return "";
  const note=`\n\nSandbox note from the previous attempt (non-terminal — the run continued):\n${entries.join("\n")}\nTreat every path/command above as outside the sandbox: do not retry it; complete the task with in-sandbox paths/commands only.`;
  return note.length>2000?note.slice(0,2000):note;
}
// Backlog #26 Step B (TASK-34): persistent per-task session store for
// implementer relays only. Host dir
// `.autopilot/missions/<mission>/sessions/<task-ref>/` (task-ref as in
// handoffNoteRelPath). The adapter's data dir alone is bound into the
// envelope (opencode `~/.local/share/opencode`, claude `~/.claude`) — never
// the whole HOME — so the session survives the relay process exit (today
// HOME is a tmpfs/scratch mount destroyed on exit). Under `.autopilot/` by
// construction, so the git snapshot/fingerprint exclusion covers it with no
// new rule. Deleted when the task completes (same sites as
// clearHandoffNote); kept on escalation (post-mortem, like the note).
// Windows-native (no envelope) path: sessions already persist there — the
// adapter runs against the real user HOME with no tmpfs — so this is a
// no-op that only ensures the dir exists for size accounting.
function sessionStoreHostDir(missionName, taskRef){
  if(!missionName || !taskRef) return null;
  return path.join(repo,sessionStoreRelDir(missionName,taskRef));
}
function ensureSessionStoreDir(missionName, taskRef){
  const dir=sessionStoreHostDir(missionName,taskRef);
  if(!dir) return null;
  try{ fs.mkdirSync(dir,{recursive:true}); return dir; }catch{ return null; }
}
function sessionStoreSizeBytes(missionName, taskRef){
  const dir=sessionStoreHostDir(missionName,taskRef);
  if(!dir) return null;
  let total=0;
  const walk=(d)=>{
    let entries;
    try{ entries=fs.readdirSync(d,{withFileTypes:true}); }catch{ return; }
    for(const e of entries){
      const p=path.join(d,e.name);
      if(e.isDirectory()) walk(p);
      else { try{ total+=fs.statSync(p).size; }catch{} }
    }
  };
  try{ walk(dir); return total; }catch{ return null; }
}
function clearSessionStore(missionName, taskRef){
  const dir=sessionStoreHostDir(missionName,taskRef);
  if(!dir) return false;
  try{ fs.rmSync(dir,{recursive:true,force:true}); return true; }catch{ return false; }
}
// Size guard: log the store size at task completion; warn above 50MB.
// Returns the size (bytes) or null when unknown. Never throws.
function logSessionStoreSize(missionName, taskRef){
  const bytes=sessionStoreSizeBytes(missionName,taskRef);
  if(bytes===null) return null;
  const mb=(bytes/1048576).toFixed(1);
  if(bytes>SESSION_STORE_WARN_BYTES){
    console.warn(`Session store for ${taskRef} holds ${mb} MB (above 50 MB) — full transcripts accumulate; deleted with the task.`);
  } else {
    console.log(`Session store for ${taskRef}: ${mb} MB.`);
  }
  return bytes;
}
// Backlog #27: the not-converging escalation records the task's continuation
// key on the state (like lastFailureBudget), so a bare `ap reset` afterwards
// targets that task's continuation automatically. Cleared when the task's
// continuation is cleared on success and never blocks anything else.
function recordLastContinuation(s,{contScope,taskId,missionName,taskRef}={}){
  s.lastContinuation={key:continuationBudgetKey(contScope),scope:contScope,taskId:taskId??null,mission:missionName??null,taskRef:taskRef??null,at:now()};
  const missionDir = getMissionWatchDir(s);
  try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "escalation", scope: "continuation", contScope, taskId: taskId ?? null, taskRef: taskRef ?? null }); }catch{}
}
function clearLastContinuation(s,contScope){
  if(s?.lastContinuation && (!contScope || s.lastContinuation.scope===contScope)) delete s.lastContinuation;
}
// Backlog #27: live application of a queued `ap reset --scope <continuation>`
// (same side-channel file as the failure-budget path). Called at every
// continuation decision (capped + voluntary, both loops) BEFORE consuming the
// next generation, so the mission continues on a fresh allowance instead of
// escalating. Walks the WHOLE queue (many budgets can be armed at once): a
// request for another scope stays queued; a request with nothing recorded yet
// stays queued rather than spent on zero.
function maybeApplyPendingContinuationReset(s,contScope){
  applyPendingGlobalReset(s);
  let requests=null;
  try{ requests=readResetRequests(pendingResetPath()); }catch{ return false; }
  if(!Array.isArray(requests)||requests.length===0) return false;
  const fullKey=continuationBudgetKey(contScope);
  let applied=0;
  for(const request of requests){
    if(!request) continue;
    if(request.scope!==contScope && request.key!==fullKey) continue;
    const used=s.continuationBudgets?.[fullKey];
    const deadList=s.rolloverDeadEnds?.[fullKey];
    const deadCount=Array.isArray(deadList)?deadList.length:0;
    if(used===undefined && deadCount===0) continue;
    if(s.continuationBudgets && used!==undefined) delete s.continuationBudgets[fullKey];
    if(s.rolloverDeadEnds && deadList!==undefined) delete s.rolloverDeadEnds[fullKey];
    if(s.noProgressGenerations) delete s.noProgressGenerations[fullKey];
    clearLastContinuation(s,contScope);
    // Only THIS entry leaves the queue; every other armed request stays queued,
    // and the file itself disappears only when this was its last entry.
    try{ removeResetRequest(pendingResetPath(),request.key??fullKey); }catch{ /* best-effort */ }
    console.log(`[autopilot] live reset applied for '${fullKey}': cleared allowance ${used??0} and ${deadCount} dead-end entr${deadCount===1?"y":"ies"} — continuing with a fresh allowance.`);
    applied++;
  }
  return applied>0;
}
// Real-time watch report — same direct-write principle as progress.log: the
// pipeline regenerates WATCH-REPORT.txt (next to the mission REPORT.md) when a
// run starts, streams output, finishes, or stale runs are recovered. No
// polling process to keep alive, so nothing for WSL to kill. Stream refreshes
// are throttled to 1/s; stream and start refreshes are throttled, finish always runs.
// watch write must never break a run.
let lastWatchRefresh=0;
function refreshWatchReport(s){
  try{ writeWatchReportFile(repo,missionFor(repo,s)); }catch{}
}
function throttledWatchRefresh(s){
  const t=Date.now();
  if(t-lastWatchRefresh<1000) return;
  lastWatchRefresh=t;
  refreshWatchReport(s);
}
// Test-only instrumentation: when AUTOPILOT_TEST_REFRESH_TRACE=<file> is set,
// each watch-refresh trigger below appends one tag line; no effect when unset.
function watchRefreshTrace(tag){
  const f=process.env.AUTOPILOT_TEST_REFRESH_TRACE;
  if(f) try{ fs.appendFileSync(f,`${tag}\n`); }catch{}
}
function refreshWatchReportTagged(s,tag){ watchRefreshTrace(tag); refreshWatchReport(s); }
refreshHook = (s,tag="hook") => { try { refreshWatchReportTagged(s,tag); } catch {} };
// Backlog 003#31: a killed mission never flushed final run/report state —
// refreshWatchReport() only fires from the live process, so a SIGTERM/SIGINT
// kill froze the run at its last snapshot (mission 006 run 17: RUNNING with
// a dead pid). runRelay() tracks the active run dir + state below and
// installs this one-shot flush: mark the active run INTERRUPTED (running-
// only and idempotent — finished runs are untouched), rewrite the watch
// report, then re-raise the signal with default disposition so exit codes
// stay conventional (143/130) and child semantics are unchanged versus the
// previous default kill. Synchronous only — a signal handler cannot await.
// SIGKILL stays uncatchable; the recoverStaleRuns() backstop at startup
// covers that path.
// Mission 090: parsed `ap run --stage` value (null = plain run), set by main().
let activeStage=null;
let activeRunDir=null;
// True only once THIS process wrote owner.pid (it owns the mission); gates the
// unexpected-error escalation so non-owner commands never touch state.json.
let ownsMission=false;
function orchestratorFatal(message){ const e=new Error(message); e.autopilotFatal=true; throw e; }
// Task 042-1.2: live adapter PID for the SIGTERM/SIGINT flush (set in
// runRelay()'s onStart, cleared when the relay settles). The relay child
// is spawned detached on POSIX, so this PID is also its process-group ID.
let activeChildPid=null;
let interruptFlushInstalled=false;
// Task 042-1.5: once SIGTERM/SIGINT arrives, no new role run may launch.
// Set in installInterruptFlush() before the flush; checked at runRelay()
// entry so a signal racing the next role start cannot spawn a new child.
let shuttingDown=false;
// Synchronous sleep for the signal handler uses sleepSyncMs() above (it cannot await): Atomics.wait
// Task 042-1.2: kill the live adapter process GROUP synchronously:
// SIGTERM the group, bounded wait, then SIGKILL the group. Best-effort
// throughout — a handler must never throw. Windows uses taskkill /T (/F
// for the escalation), which kills the child tree.
function killActiveProcessGroupSync(pid){
  if(!(typeof pid==="number"&&pid>0)) return;
  if(process.platform==="win32"){
    try{ spawnSync("taskkill",["/PID",String(pid),"/T"],{stdio:"ignore",timeout:5000,shell:false}); }catch{}
    sleepSyncMs(500);
    try{ spawnSync("taskkill",["/PID",String(pid),"/T","/F"],{stdio:"ignore",timeout:5000,shell:false}); }catch{}
    return;
  }
  try{ process.kill(-pid,"SIGTERM"); }catch{ try{ process.kill(pid,"SIGTERM"); }catch{} }
  sleepSyncMs(500);
  try{ process.kill(-pid,"SIGKILL"); }catch{ try{ process.kill(pid,"SIGKILL"); }catch{} }
}
function cleanupOwnerPid(){
  try{ removeOwnerPid(repo,{ifPid:process.pid}); }catch{}
}
function installInterruptFlush(){
  if(interruptFlushInstalled) return;
  interruptFlushInstalled=true;
  const flushAndReraise=(signal)=>{
    // Task 042-1.5: mark shutdown FIRST, before the flush, so any runRelay()
    // entry racing this signal refuses to spawn a new child.
    shuttingDown=true;
    // Task 042-1.2: kill the live adapter process group FIRST (SIGTERM,
    // bounded wait, SIGKILL — synchronous), so a SIGTERM-ignoring adapter
    // tree is gone before state is flushed and the signal re-raised.
    try{ killActiveProcessGroupSync(activeChildPid); }catch{}
    try{ if(activeRunDir) markInterrupted(activeRunDir,{reason:`received ${signal}`}); }catch{}
    // F2b #23b: record an orchestrator_exit event before exiting.
    try{
      const md = activeRelayState ? getMissionWatchDir(activeRelayState) : null;
      if (md) appendOrchestratorExitEvent(md, signal);
    }catch{}
    try{ if(activeRelayState) refreshWatchReport(activeRelayState); }catch{}
    try{ removeOwnerPid(repo,{ifPid:process.pid}); }catch{}
    process.removeListener("SIGTERM",onSigterm);
    process.removeListener("SIGINT",onSigint);
    process.removeListener("SIGHUP",onSighup);
    try{ process.kill(process.pid,signal); }
    catch{ process.exit(signal==="SIGINT"?130:(signal==="SIGHUP"?129:143)); }
  };
  const onSigterm=()=>flushAndReraise("SIGTERM");
  const onSigint=()=>flushAndReraise("SIGINT");
  const onSighup=()=>flushAndReraise("SIGHUP");
  process.on("SIGTERM",onSigterm);
  process.on("SIGINT",onSigint);
  process.on("SIGHUP",onSighup);
}
let watchRefreshInterval=null;
process.on("exit",()=>{ if(activeRelayState) refreshWatchReport(activeRelayState); });
const run=(bin,args,opts={})=>spawnSync(bin,args,{cwd:opts.cwd||repo,encoding:"utf8",input:opts.input,stdio:opts.capture?"pipe":"inherit",env:opts.env,shell:false});
// Sleep before a retry attempt so infrastructure failures (e.g. network drops
// that take 1-4 minutes to recover) do not burn every attempt into a dead
// connection. Delay is configurable via policy.retry_delay_ms (default 60s).
// `reason` names the failure class that caused the retry; the label says
// what the pause is for — never "transient", which mislabels functional
// re-runs. When no pause happens, this logs nothing.
async function retryDelay(c,attempt,reason=null){
  if(attempt<=1) return;
  const ms=c.policy?.retry_delay_ms ?? 60000;
  if(ms<=0) return;
  const detail=reason?` (infrastructure retry: ${reason})`:" (infrastructure retry)";
  console.log(`  Retry delay: waiting ${ms/1000}s before attempt ${attempt}${detail}...`);
  await new Promise(r=>setTimeout(r,ms));
}

// TASK-29: pause before relaunching `stage` only when the checkpoint carries
// a pending retry pause for exactly that stage — i.e. the last transition
// was a `retry` after an infrastructure/adapter failure. Functional
// re-runs (`restart`), re-reviews, and checkpoints from before the field
// existed relaunch with no pause and no log line. The pause applies once:
// the field is cleared (and the checkpoint persisted) as soon as the stage
// consumes it. A resume after a kill or interruption is never a `retry`
// transition, so it never pauses — acceptable: there is nothing transient
// being waited out, just a relaunch. Attempt numbering is untouched (the
// caller still increments s.attempt on every relaunch).
async function maybeRetryPause(c,s,checkpoint,stage){
  if(!shouldRetryPause(checkpoint,stage)) return;
  // Mission 084 Phase 2 task 2.3 — retry pause invalidates the snapshot
  // reuse cache: never reuse across a pause (gap activity caught by the
  // guard/short-gap rule, scenario d).
  try{
    clearSnapshotReuseCache("retry pause");
    console.log(`[snapshot-reuse] cache cleared: retry pause`);
  }catch(error){
    console.log(`[snapshot-reuse] cache clear skipped (${error?.message||error})`);
  }
  checkpoint.retryPauseStage=null;
  s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
  await retryDelay(c,s.attempt,s.lastFailure?.class??null);
}

function failureBudgetScope(observedFailure,taskScope,sourceResult){
  if(observedFailure.domain==="adapter") return `adapter:${sourceResult?.adapter||"unknown"}:${sourceResult?.role||"unknown"}`;
  if(observedFailure.domain==="infrastructure") return "mission";
  return `task:${taskScope}`;
}

function recordAttemptFailure(c,s,taskScope,results,gate,{persist=true}={}){
  let observedFailure=selectAttemptFailure({results,gate});
  if(!observedFailure) observedFailure=failure("INTERNAL_CONTRACT_ERROR","orchestrator",false,[{source:"attempt",message:"Attempt failed without a classified cause."}]);
  const sourceResult=results.find(result=>result?.failure===observedFailure)||null;
  observedFailure={...observedFailure,sourceRole:sourceResult?.role||null,adapter:sourceResult?.adapter||null};
  const scope=failureBudgetScope(observedFailure,taskScope,sourceResult);
  // A live `ap reset` request is honoured HERE, at the one decision point every
  // role's failure passes through, for the scope about to be recorded — so the
  // counter starts from zero and the mission retries instead of escalating.
  applyPendingBudgetReset(s,scope);
  const budget=recordFailureBudget(s,c.policy,observedFailure,scope);
  s.lastFailure=observedFailure;
  s.lastFailureBudget=budget;
  if(persist) saveState(s);
  return {failure:observedFailure,budget,scope};
}

// `returnEscalation` (backlog #86): hand back {...recorded,escalate:{step,message}}
// instead of dying, so a caller that owns its own escalation path (the
// final-review fix-round helper) reuses this single naming/detail site.
function enforceAttemptFailure(c,s,taskScope,results,gate,{returnEscalation=false}={}){
  const recorded=recordAttemptFailure(c,s,taskScope,results,gate);
  if(recorded.budget.allowed) return recorded;
  const naming=decideEscalationName({failureClass:recorded.failure.class,retryable:recorded.failure.retryable,used:recorded.budget.used,limit:recorded.budget.limit,budget:recorded.budget.budget,evidence:recorded.failure.evidence});
  const message=`${recorded.failure.domain}/${recorded.failure.class} (${recorded.scope}): ${naming.detail}; human intervention required.`;
  if(returnEscalation) return {...recorded,escalate:{step:naming.step,message}};
  s.phase="escalated";
  s.step=naming.step;
  saveState(s);
  die(message);
}
// TASK-14 (planning-review infra/functional split), call sites 1-2:
// classify-then-record-then-decide for a non-PASS `plan_reviewer` outcome.
// Takes the latest review result and a zero-argument re-invocation of the
// SAME reviewer call (reviewer only, fresh session), and resolves to the
// outcome the caller's unchanged behavior should evaluate:
// - Passthrough classes (PLANNING_REJECTED only, exactly the task 1 decision function's
//   passthrough set) skip recording entirely: returned unchanged, so the
//   caller's existing revision/escalation behavior runs byte-for-byte as
//   today and no such failure is ever recorded.
//   STRUCTURED_OUTPUT_MISSING and STRUCTURED_OUTPUT_INVALID are NOT
//   passthrough classes — they are retryable adapter failures recorded and
//   retried under the adapter budget via the path below.
// - Anything else is recorded ONCE via the generic recordAttemptFailure()
//   (never enforceAttemptFailure(), which would die() itself on budget
//   exhaustion instead of letting the decision function decide, and never
//   the lower-level recordFailureBudget() directly, which would duplicate
//   recordAttemptFailure()'s selection/enrichment/scope/persist logic),
//   then fed to the task 1 decision function: "retry" waits
//   retryDelay(c, budget.used + 1) and re-invokes the reviewer only;
//   "escalate" dies naming the failure's class and domain; "passthrough"
//   returns the outcome unchanged for the caller's existing behavior.
// `budget.used` counts failures already recorded at this scope INCLUDING the
// one just recorded (1 after the first failure); the upcoming attempt is one
// ordinal further (budget.used + 1, i.e. 2 after the first failure), which is
// what retryDelay() must receive — passing budget.used alone reproduces
// retryDelay()'s own attempt<=1 no-op on the very first retry, silently
// skipping the delay every time under the default two-attempt budget. Never
// s.attempt here: that counter is scoped to the implementation loop's
// phase-stage checkpoint and carries no meaning for plan-review retries.
// Delegates to scripts/planning-review-wiring.mjs: the classify-then-record-
// then-decide helper plus its FULL transitive local dependencies
// (recordAttemptFailure/failureBudgetScope/applyPendingBudgetReset/saveState/
// retryDelay/passthrough set) live there. This wrapper only injects the
// module-scope IO the wiring module must not close over — saveState/statePath,
// cfg()/cfgPath (config migration + validation), the reset-request file
// behind pendingResetPath()/repo, now() — alongside fatal replacing die().
async function resolvePlanningReviewAttempt(c,s,taskScope,reviewResult,rerunReviewer,{policyMessage,escalatePrefix}){
  return resolvePlanningReviewAttemptWired(c,s,taskScope,reviewResult,rerunReviewer,{
    policyMessage,escalatePrefix,fatal:die,
    saveState:(next)=>saveState(next),
    readResetRequests:()=>readResetRequests(pendingResetPath()),
    consumeResetRequest:(key)=>removeResetRequest(pendingResetPath(),key),
    getConfiguredBudget:(name)=>cfg()?.policy?.failure_budgets?.[name],
    now:()=>now()
  });
}
// TASK-14 Phase 5 (standalone resume-position checkpoint): pure wiring
// helpers over `scripts/planning-review-checkpoint.mjs`'s task 12
// evaluator. The checkpoint key itself missing/null is the SOLE absence
// case — never consulted here at all (the caller decides that before
// calling). A present object is always evaluated, never read as absent:
// structural/identity/path failures and reviewer-stage drift all escalate
// fail-closed with evidence via die(), never a silent planner fallback.
//
// Stage sensitivity (mirrors phase-stage-checkpoint.mjs's Implementer
// exemption): reviewer-pending validates content digests (Planner finished
// writing); planner-pending validates only version/identity/paths.
function standaloneReviewCheckpointRelPaths(mission){
  const planFile=standalone.planPath(repo,mission);
  const tasksFile=standalone.tasksPath(repo,mission);
  return {planFile,tasksFile,planRel:path.relative(repo,planFile),tasksRel:path.relative(repo,tasksFile)};
}
function readStandaloneReviewObserved(mission){
  const {planRel,tasksRel}=standaloneReviewCheckpointRelPaths(mission);
  let planContent=null,tasksContent=null;
  try{ planContent=fs.readFileSync(path.join(repo,planRel),"utf8"); }catch{ planContent=null; }
  try{ tasksContent=fs.readFileSync(path.join(repo,tasksRel),"utf8"); }catch{ tasksContent=null; }
  return {artifacts:[{path:planRel,content:planContent},{path:tasksRel,content:tasksContent}]};
}
function writeStandaloneReviewerPendingCheckpoint(s,mission){
  const {planRel,tasksRel}=standaloneReviewCheckpointRelPaths(mission);
  const planContent=fs.readFileSync(path.join(repo,planRel),"utf8");
  const tasksContent=fs.readFileSync(path.join(repo,tasksRel),"utf8");
  const digest=planningReviewArtifactDigest({artifacts:[{path:planRel,content:planContent},{path:tasksRel,content:tasksContent}]});
  s.standalonePlanningReviewCheckpoint=createStandaloneCheckpoint({
    framework:"standalone",mission,position:STANDALONE_REVIEWER_POSITION,
    artifacts:[planRel,tasksRel],artifactDigest:digest,at:now()
  });
}
function writeStandalonePlannerPendingCheckpoint(s,mission){
  const {planRel,tasksRel}=standaloneReviewCheckpointRelPaths(mission);
  s.standalonePlanningReviewCheckpoint=createStandaloneCheckpoint({
    framework:"standalone",mission,position:STANDALONE_PLANNER_POSITION,
    artifacts:[planRel,tasksRel],artifactDigest:null,at:now()
  });
}
// TASK-14 Phase 6 (SpecKit gate-review resume-position checkpoint): the same
// contract over the gate-specific artifact manifest (review-spec → spec;
// review-plan → spec+plan; review-tasks → spec+plan+tasks). Mission identity
// uses this codebase's established fallback chain so the value recorded here
// and the value checked on resume are always computed identically.
function speckitPlanningIdentity(s){
  return s?.mission||s?.missionSeq||s?.speckitFeatureDir||"mission";
}
function speckitGateArtifactRelPaths(feature,gate){
  const roles=manifestForGate(gate);
  if(!roles||!feature) return null;
  return roles.map(role=>path.join("specs",String(feature),`${role}.md`));
}
// Observed artifact state for the resume evaluator: exactly the gate-specific
// manifest. Contents are only needed at reviewer substages, so an unreadable
// file yields null content rather than fabricating an empty digest.
function readSpeckitGateObserved(feature,gate){
  const paths=speckitGateArtifactRelPaths(feature,gate)||[];
  return {artifacts:paths.map(rel=>{
    let content=null;
    try{ content=fs.readFileSync(path.join(repo,rel),"utf8"); }catch{ content=null; }
    return {path:rel,content};
  })};
}
// Persist one substage of the SpecKit gate-review checkpoint. A reviewer
// substage records a content digest (the Planner is done writing, so content
// is expected stable); planner_revision records none (the Planner is about to
// rewrite it). Returns false — writing nothing — when the gate, the feature
// or a required artifact cannot be resolved: a checkpoint built on missing
// content would fabricate integrity evidence, and dying here would convert a
// previously-working session into a hard failure.
function writeSpeckitGateCheckpoint(s,{feature,gate,gateIndex,substage}){
  const paths=speckitGateArtifactRelPaths(feature,gate);
  if(!paths){
    console.warn(`[autopilot] SpecKit gate ${JSON.stringify(gate)} checkpoint skipped: unresolved gate or feature directory.`);
    return false;
  }
  let digest=null;
  if(isReviewerPosition(substage)){
    const artifacts=[];
    for(const rel of paths){
      let content=null;
      try{ content=fs.readFileSync(path.join(repo,rel),"utf8"); }catch{ content=null; }
      if(content===null){
        console.warn(`[autopilot] SpecKit gate ${gate} checkpoint skipped: ${rel} is unreadable.`);
        return false;
      }
      artifacts.push({path:rel,content});
    }
    digest=planningReviewArtifactDigest({artifacts});
  }
  s.speckitGateReviewCheckpoint=createSpeckitCheckpoint({
    framework:"speckit",mission:speckitPlanningIdentity(s),feature,gate,gateIndex,substage,
    artifacts:paths,artifactDigest:digest,at:now()
  });
  return true;
}
// Regenerate the written run report after every delegated step so the
// report stays current mid-run. Best-effort: if the project has no
// .autopilot/report.mjs (feature not enabled there), do nothing.
function regenerateReport(){
  const script=path.join(repo,".autopilot","report.mjs");
  if(!fs.existsSync(script)) return;
  try{
    const r=spawnSync(process.execPath,[script],{cwd:repo,encoding:"utf8",stdio:"inherit",shell:false});
    if(r.status!==0) console.warn(`[autopilot] report regeneration exited ${r.status ?? "unknown"}`);
  }catch(e){
    console.warn("[autopilot] report regeneration failed (non-fatal):",e.message);
  }
}
const git=args=>(run("git",args,{capture:true}).stdout||"");
const diff=()=>git(["diff","--no-ext-diff"])+(git(["diff","--no-ext-diff","--cached"])||"");

function ensureFirstRun(){
  if(fs.existsSync(cfgPath)) return true;
  console.log("\nProject Autopilot: setup has not been configured for this project.");
  console.log("Starting Doctor/Setup automatically...\n");
  const r=spawnSync(process.execPath,[path.join(skillRoot,"scripts","setup.mjs"),"--wizard","--repo",repo],{cwd:repo,stdio:"inherit",shell:false});
  if(r.status!==0){
    die(`Setup did not complete (exit ${r.status ?? "unknown"}).`);
  }
  return fs.existsSync(cfgPath);
}

function cfg(){
  if(!ensureFirstRun()) die("Setup completed without creating .autopilot/config.json.");
  const migrated=loadAndMigrateConfig(cfgPath,{persist:true});
  if(migrated.changed && migrated.backupPath){
    console.log(`Config migrated to schema ${migrated.to}; backup: ${migrated.backupPath}`);
    if(migrated.removedCertificationFields) console.log("Removed unused certification/execution-plane-safety settings (no longer part of Project Autopilot). Roles, workflow, and model settings were preserved; no recertification is required.");
  }
  // A layout produced by migration may contain operator-added legacy keys that
  // the migration deliberately carries through; those are warnings. A
  // hand-written v4 config still fails on unknown keys.
  const validation=validateNewConfig(migrated.layout,{migrated:migrated.changed});
  if(!validation.valid){
    const backupNote=migrated.changed && migrated.backupPath
      ? `\nThe migrated config was already written to ${cfgPath}; the pre-migration file is at ${migrated.backupPath}.`
      : "";
    die("Configuration validation failed:\n" + validation.errors.map(e=>`  ✖ ${e}`).join("\n") + backupNote);
  }
  if(validation.warnings.length){
    console.log("Configuration warnings:");
    validation.warnings.forEach(w=>console.log(`  ⚠ ${w}`));
  }
  const c=migrated.config;
  validateSafetyConfig(c);
  validateRoleRuntimeConfig(c);
  return c;
}


// Structural only: this runs from cfg(), which every command (including the
// read-only `inspect`/`status` paths and every missionOverride() lookup) hits,
// sometimes many times per run. It must therefore never launch a CLI —
// whether the executable actually works is a live question answered exactly
// once, by preflightConfiguredRoles() below, immediately before the mission
// opens.
function validateRoleRuntimeConfig(c){
  const problems=[];
  for(const [roleName,role] of Object.entries(c.roles||{})){
    const a=agents[role.adapter];
    if(!a) problems.push(`${roleName}: unknown adapter '${role.adapter}'.`);
    else{
      if(role.model && !a.model_flag) problems.push(`${roleName}: configured model but adapter does not support model selection.`);
      if(role.reasoning && !a.effort_flag && !['config','model_suffix'].includes(a.effort_mode)) problems.push(`${roleName}: configured reasoning/effort but adapter does not support it.`);
      if(role.variant && !a.variant_flag && a.variant_mode !== 'model_suffix') problems.push(`${roleName}: configured variant but adapter does not support it.`);
      // Per-role fallback models (mission 087): each fallback entry's
      // adapter/model/reasoning/variant is checked against that entry's
      // adapter capabilities, mirroring the primary checks above.
      if(role.fallbacks !== undefined){
        if(!Array.isArray(role.fallbacks)) problems.push(`${roleName}.fallbacks: must be an array of {adapter, model, reasoning, variant} entries.`);
        else role.fallbacks.forEach((fb,i)=>{
          const label=`${roleName}.fallbacks[${i}]`;
          if(!fb || typeof fb !== "object" || Array.isArray(fb)){ problems.push(`${label}: must be an object with adapter/model/reasoning/variant.`); return; }
          const fa=agents[fb.adapter];
          if(!fa) problems.push(`${label}: unknown adapter '${fb.adapter}'.`);
          else{
            if(fb.model && !fa.model_flag) problems.push(`${label}: configured model but adapter does not support model selection.`);
            if(fb.reasoning && !fa.effort_flag && !['config','model_suffix'].includes(fa.effort_mode)) problems.push(`${label}: configured reasoning/effort but adapter does not support it.`);
            if(fb.variant && !fa.variant_flag && fa.variant_mode !== 'model_suffix') problems.push(`${label}: configured variant but adapter does not support it.`);
          }
        });
      }
      // Pending #22: optional escalation_model (planner/implementer), same capability checks.
      if(role.escalation_model !== undefined){
        const em=role.escalation_model, label=`${roleName}.escalation_model`;
        if(!em || typeof em !== "object" || Array.isArray(em)) problems.push(`${label}: must be an object with adapter/model/reasoning/variant.`);
        else{
          const ea=agents[em.adapter];
          if(!ea) problems.push(`${label}: unknown adapter '${em.adapter}'.`);
          else{
            if(!em.model) problems.push(`${label}: model is required.`);
            else if(!ea.model_flag) problems.push(`${label}: configured model but adapter does not support model selection.`);
            if(em.reasoning && !ea.effort_flag && !['config','model_suffix'].includes(ea.effort_mode)) problems.push(`${label}: configured reasoning/effort but adapter does not support it.`);
            if(em.variant && !ea.variant_flag && ea.variant_mode !== 'model_suffix') problems.push(`${label}: configured variant but adapter does not support it.`);
          }
        }
      }
    }
  }
  if(problems.length) die("Invalid role configuration:\n" + problems.map(p=>` - ${p}`).join("\n"));
}

// The git-mutation guard (relay-guards.mjs) is hardcoded and unconditional —
// it cannot be turned off from config. That is intentional. What was wrong
// before this fix is that config.example.json / setup.mjs wrote fields
// like safety.allow_git_commit that LOOKED like they controlled behavior but
// were never read anywhere. A user setting allow_git_commit:true would see
// no change and wrongly conclude the tool respects that setting. Fail loud
// instead of silently ignoring a config value the code can't honor.
function validateSafetyConfig(c){
  const safety=c.safety||{};
  const policy=c.policy||{};
  const problems=[];
  if(safety.allow_git_commit) problems.push("safety.allow_git_commit=true is not supported — Autopilot never commits, regardless of config.");
  if(safety.allow_git_push) problems.push("safety.allow_git_push=true is not supported — Autopilot never pushes, regardless of config.");
  if(safety.allow_destructive_operations) problems.push("safety.allow_destructive_operations=true is not supported.");
  if(policy.require_human_commit===false) problems.push("policy.require_human_commit=false is not supported — there is no code path for Autopilot to commit on your behalf.");
  if(policy.fail_closed_on_relay_violation===false) problems.push("policy.fail_closed_on_relay_violation=false is not supported — a relay policy violation always stops the run.");
  if(problems.length) die("Unsupported safety config:\n" + problems.map(p=>` - ${p}`).join("\n"));
}
// config.example.json documents planning.gsd.phase_root as configurable but
// gsd.mjs previously hardcoded ".planning/phases" and ignored it — same
// silently-ignored-config class of bug fixed elsewhere in this pass.
function gsdPhaseRoot(c){return c.planning?.gsd?.phase_root||".planning/phases";}
function planningAdapter(c){
  if(c.project.planning_framework==="speckit") return speckit;
  if(c.project.planning_framework==="gsd") return gsd;
  if(c.project.planning_framework==="standalone") return standalone;
  const hits=[speckit,gsd].filter(a=>a.detect(repo));
  if(hits.length===1)return hits[0];
  if(!hits.length)return null;
  die("Multiple planning frameworks detected; choose one in config.");
}
// Backlog #4: GSD is hidden from setup/config until it is reviewed, but a
// saved gsd config keeps working. Warn once when a run starts; never block.
function warnIfGsdFramework(c){
  if(c?.project?.planning_framework!=="gsd") return;
  console.log("⚠ GSD is not yet reviewed in this version; Standalone and SpecKit are the supported frameworks.");
}
// Backlog #1: every opencode model a role launch can use (primary plus
// opencode fallbacks) must exist in the sandbox's shared catalog. The cache
// refreshes itself before the relay launches; this is the preflight view.
function openCodeModelsForRole(role){
  const models=[];
  if(!role) return models;
  if(role.adapter==="opencode" && role.model) models.push(role.model);
  for(const fb of Array.isArray(role.fallbacks) ? role.fallbacks : []){
    const adapter=fb?.adapter||role.adapter;
    if(adapter==="opencode" && fb?.model) models.push(fb.model);
  }
  // Pending escalation model: a role launch can switch to it for one round,
  // so it must exist in the live catalog too.
  const em=role.escalation_model;
  if(em && em.adapter==="opencode" && em.model) models.push(em.model);
  return models;
}

// Warn-only preflight (backlog #1(a)): the shared snapshot is only refreshed
// at relay launch, so name EVERY configured OpenCode model (any role,
// primary/fallback/escalation) that the live list no longer carries now — a
// vanished model must warn here, never silently fail at switch time. Never
// seeds, refreshes, writes, or blocks: an unavailable/absent catalog simply
// yields no warning.
function openCodeSandboxModelWarnings(roles, catalogOverride=undefined){
  const byId=new Map();
  for(const roleName of Object.keys(roles||{})){
    for(const model of openCodeModelsForRole(roles?.[roleName])){
      const id=String(model).replace(/^opencode\//,"");
      if(!id) continue;
      const entry=byId.get(id)||{id,model,roles:[]};
      entry.roles.push(roleName);
      byId.set(id,entry);
    }
  }
  if(!byId.size) return [];
  let catalog;
  if(catalogOverride !== undefined){
    catalog=catalogOverride;
  } else {
    try{ catalog=openCodeSandboxCatalog().models; }catch{ catalog=null; }
  }
  if(!catalog) return [];
  return [...byId.values()]
    .filter(entry=>!catalog.has(entry.id))
    .map(entry=>`OpenCode shared-cache catalog is missing ${entry.model} for ${entry.roles.join(", ")} — the sandboxed role may fail with ProviderModelNotFoundError; the cache is refreshed automatically before the relay launch.`);
}

// Quick, non-authoritative check before mission state opens. This is not
// certification and does not gate on any receipt/fingerprint — it only
// turns "CLI missing/misconfigured" into a clear message up front.
//
// Availability is established here and only here: preflightConfig() launches
// each distinct configured adapter executable exactly once (five roles on one
// CLI = one `--version`, not five) while still validating every role's own
// model/reasoning/variant/invocation configuration. Because this runs before
// any state is loaded or mutated, a missing or broken CLI still stops the run
// before any role launch, phase transition, or run directory. A genuine spawn
// failure later on is still reported with its real diagnostics by the relay
// itself.
function preflightConfiguredRoles(c){
  for(const [roleName,role] of Object.entries(c.roles||{})){
    if(!agents[role.adapter]) throw new Error(`Unknown adapter '${role.adapter}' for role '${roleName}'.`);
  }
  for(const w of planModeModelWarnings(c.roles)) console.warn(`Warning: ${w}`);
  for(const w of openCodeSandboxModelWarnings(c.roles)) console.warn(`Warning: ${w}`);
  const {ok,results}=preflightConfig({repo,config:c,agents});
  if(ok) return;
  const failed=results.filter(entry=>!entry.ok);
  throw new Error(failed.map(entry=>`Preflight failed for role '${entry.roleName}' (${entry.adapter}):\n${entry.problems.map(p=>` - ${p}`).join("\n")}`).join("\n"));
}

function buildRelayArgs(role,a,readOnly,resume,state,{trustedEnvelope=false,promptText=null,forceResume=false,stdinSink=null}={}){
  let args=[...(readOnly?a.read_only:a.write)];
  args=applyAgentSelections(args,role,a);
  // forceResume: the TASK-34 wrap-up turn resumes the session that was JUST
  // stopped at the hand-off threshold. `role.resume` is the operator's choice
  // for NEW attempts continuing an old session — it must not veto this
  // (mission 022 live: implementer resume:false skipped every wrap-up).
  if(resume && (role.resume || forceResume)){
    let sid=roleSession(state,roleNameForBuild(state));
    // Backlog #112: ignore (and drop) a stored session of another CLI/model.
    if(sid && !storedSessionMatches(state.sessions?.[roleNameForBuild(state)],a.binary,role.model||null)){ clearRoleSession(state,roleNameForBuild(state)); sid=null; }
    if(sid && a.resume_session?.length) args.push(...a.resume_session,sid);
    // No sid on hand, OR the adapter declares no resume_session at all
    // (currently codex: `codex exec resume` cannot be reached by appending
    // flags onto the `exec`/--sandbox/--ephemeral base args — it is a
    // sibling subcommand with its own option set, and --ephemeral sessions
    // have nothing on disk to resume from at all, confirmed live against
    // the real CLI: "no rollout found for thread id ..."). Either way,
    // proceed as a fresh session rather than falling back to resume_last
    // ("--continue"/"resume --last"). That flag resumes whatever the CLI
    // considers its own most-recent session in this cwd — not necessarily
    // this role's, and not necessarily even the same role if another role
    // sharing the adapter ran in between. Blindly continuing an unknown
    // session is exactly how one planner revision's session (23 tool calls,
    // 1.26M cached tokens) snowballed into every subsequent revision.
  }
  const driver = adapterDriver(role.adapter);
  if(driver?.transportPrompt && promptText) {
    args = driver.transportPrompt(args, promptText);
  } else if(driver?.encodeStdin && promptText && stdinSink) {
    // Stdin-only transport (agy): the prompt rides ONE stream-json user
    // event, so the task-1.1 encoder frames it here and the caller feeds the
    // framed line as the child's stdin — never as argv.
    stdinSink.text = driver.encodeStdin(promptText);
  }
  if(trustedEnvelope){
    const prepare=driver?.trustedEnvelopeArgs;
    if(prepare) args=prepare(args);
  }
  return args;
}

function roleNameForBuild(state){return state.__relayRoleName||"implementer";}
function makeRelayResult({roleName,role,a,p,args,invocationVerification,output,sessionId=null,before,after,guard,started,finished,reviewContract,cwd,readOnly,observations,envelopeApplied=false,usage=null,resolvedBinary,modelResolution=null,snapshotBeforeStartedAt=null,snapshotBeforeAt=null,snapshotAfterStartedAt=null,snapshotAfterAt=null,sessionNumber=null,planRevision=null,carriedForwardTasks=null}){
  let guardEvents;
  let guardLogReadable=true;
  try{ guardEvents=readGuardLog(guard.logFile); }
  catch{ guardEvents=[]; guardLogReadable=false; }
  const touchedFiles=touchedFilesBetween(before,after,cwd);
  const readOnlyViolation=!!(readOnly && before.fingerprint!==after.fingerprint && touchedFiles.length>0);
  // Refs are the primary mutation signal: a commit, tag, branch move, or
  // any ref update always changes the for-each-ref output.  HEAD alone
  // misses tag/branch/reflog-only mutations that never touch HEAD.
  const refsChanged=before.refs!==after.refs;
  // A commit isn't the only way to mutate Git history: `git tag`, `git
  // branch -f`, or `git update-ref` on a ref that isn't currently checked
  // out never moves `head`, so checking head alone misses them entirely.
  // No agent role (read-only or write) is ever expected to mutate refs or
  // repository-administrative Git state — that is exclusively a human
  // action — so any of it changing is the same policy violation a commit is.
  // TASK-28 evidence: the administrative-state comparison iterates the same
  // GIT_STATE_FIELDS constant describeGitStateChange() uses, instead of a
  // hand-written `||` chain, so a field added to the check later is
  // automatically covered by the evidence too. Raw (unredacted) comparison —
  // logically identical to the old chain, with refsChanged staying a
  // separate signal. Evidence only; detection behaviour is unchanged.
  const gitStateChangesForEvidence=describeGitStateChange(before,after);
  const administrativeGitStateChanged=refsChanged
    || gitStateChangesForEvidence.some((entry)=>entry.field!=="head"&&entry.field!=="refs");
  const commitDetected=before.head!==after.head || administrativeGitStateChanged;
  // An empty guard log is never proof that nothing was attempted: the
  // guard may have failed to write (envelope scratch mismatch, permission
  // error, or agent bypass).  Refs capture the ground truth.
  const gitMutationAttempted=guardEvents.length>0 || commitDetected;
  // AUTOPILOT_GIT_GUARD_LOG now maps to the writable scratch mount even for
  // a read-only mission inside the execution envelope (execution-envelope.mjs's
  // mapPathIntoEnvelope/mapEnvironmentIntoEnvelope check scratch containment
  // before repository containment, since the run's scratch dir is always
  // nested inside the repo). A guard write there is therefore reliable: an
  // empty log means no Git command was attempted, which is the expected,
  // valid behavior for a well-behaved read-only role and must not itself be
  // a policy violation. Only a guard log that could not be READ at all
  // (readGuardLog threw) is unreliable evidence.
  const guardLogUnavailable=!guardLogReadable;
  // TASK-39: blocked attempts whose target could NOT be proven protected
  // (every blocked.log entry carries target:"unproven") — fixture repos
  // created without the guard stripped, probe timeouts, missing scope
  // files — and a verifiably unchanged project repo (HEAD, refs AND
  // indexState identical to the pre-run snapshot) are NOT a relay policy
  // violation: the blocked commands never touched the project repo.
  // Anything else stays exactly as fatal as before. The rule lives in
  // relay-guards.mjs so both loops' decision path is identical and
  // unit-testable.
  const blockClassification=classifyGitBlocks(guardEvents,{commitDetected,readOnlyViolation,guardLogUnavailable,before,after,repoChanged:gitStateChangesForEvidence.length>0});
  const policyViolation=blockClassification.policyViolation;
  const fixtureGitBlocksOnlyUnproven=blockClassification.fixtureGitBlocksOnlyUnproven;
  // Backlog #14(b): a blocked command that mutated nothing is a WARNING on
  // the run, recorded in result.json and shown by the orchestrator/WATCH
  // REPORT. Real mutations keep policyViolation above and still halt.
  const blockedNoMutation=blockClassification.blockedNoMutation===true;
  const gitGuardWarning=blockedNoMutation?{kind:"git_guard_blocked_no_mutation",count:guardEvents.length,subcommands:[...new Set(guardEvents.map((e)=>e&&e.subcommand).filter(Boolean))]}:null;
  // driverless: true only for an adapter with NO registered driver (e.g.
  // "cursor") — it has no structured event stream at all. Structured
  // terminal events take precedence for every adapter, with a restricted
  // stderr-only (never stdout) nonzero-exit text fallback behind them; see
  // classifyObservedFailure()'s own docblock for why (Mission 001 runs
  // 27-28's false-positive shapes).
  // TASK-28: name the tripped field(s) in the policy evidence, so the
  // escalation failure state can say e.g. `git_commit_detected (objects,
  // indexState)`. The evidence shape is an array, so one extra typed entry
  // fits without disturbing existing consumers. result.json is the required
  // carrier (gitStateChanges below); this entry is additive context.
  const gitStateChangedFields=commitDetected?gitStateChangesForEvidence.map((entry)=>entry.field):[];
  const policyEvidence=(commitDetected&&gitStateChangedFields.length)?[...observations,{type:"git_state_changed",fields:gitStateChangedFields}]:observations;
  // #107: opencode --print-logs INFO/DEBUG chatter (paths, "loading ...") must not feed the nonzero-exit stderr text fallback.
  const classifyStderr=role.adapter==="opencode"?String(p.stderr||"").split(/\r?\n/).filter(l=>!/^timestamp=\S+ level=(?:INFO|DEBUG)\b/.test(l)).join("\n"):p.stderr;
  const observedFailure=reclassifySilentOpenCodeFailure(classifyObservedFailure({exitCode:p.status,stdout:p.stdout,stderr:classifyStderr,startError:p.error,timedOut:p.timedOut,policyViolation,evidence:policyEvidence,driverless:!adapterDriver(role.adapter)}),{adapter:role.adapter,output,stderr:classifyStderr});
  const contract=reviewContract?.contract||{status:"not_required",error:null};
  const verdict=reviewContract?.verdict||{status:"not_applicable",decision:null,findings:[]};
  const relayFailure=observedFailure||reviewContract?.failure||verdictFailure(roleName,verdict);
  const invocation = buildInvocationRecord({ role, adapterId: role.adapter, adapter: a, args, verification: invocationVerification, resolvedBinary });
  const result={
    ...buildRuntimeResult({
      roleName, role, adapterId: role.adapter, adapter: a, processResult: p, output, invocation,
      startedAt: started, finishedAt: finished, sessionId,
      touchedFiles, policy: { violation: policyViolation, warning: gitGuardWarning, gitMutationAttempted, commitDetected, readOnlyViolation, guardLogUnavailable, fixtureGitBlocksOnlyUnproven: fixtureGitBlocksOnlyUnproven, blockedNoMutation },
      contract,verdict,failure:relayFailure,observations,usage
    }),
    model:role.model||null,
    reasoning:role.reasoning||null,
    variant:role.variant||null,
    // Mission 093 Part 1 task 2.2: configured vs stream-resolved model.
    // configuredModel is the effective model at launch (null when the CLI
    // chose its default); resolvedModel/modelMismatch come from the decoded
    // stream via resolveRunModel (null/null before the first model signal).
    // Additive — the legacy `model` field above is untouched.
    configuredModel:(typeof role?.model==="string"&&role.model!==""?role.model:null),
    resolvedModel:modelResolution?.resolvedModel??null,
    modelMismatch:modelResolution?.modelMismatch??null,
    // Mission 093 Part 1 task 2.3: run-scoped layout fields — snapshot wall
    // clocks plus the continuation-scope session number (all null on runs
    // that own no snapshot/scope, never fabricated). Additive — every reader
    // above is untouched.
    snapshotBeforeStartedAt:snapshotBeforeStartedAt??null,
    snapshotBeforeAt:snapshotBeforeAt??null,
    snapshotAfterStartedAt:snapshotAfterStartedAt??null,
    snapshotAfterAt:snapshotAfterAt??null,
    sessionNumber:sessionNumber??null,
    // Mission 093 Part 1 task 2.4: plan revision number on planning runs
    // (the standalone revision-loop generation, 0-based). Null elsewhere,
    // never fabricated — only a finite integer >= 0 survives. Additive.
    planRevision:(Number.isInteger(planRevision)&&planRevision>=0?planRevision:null),
    // Mission 093 Part 1 task 2.5: task ids carried forward into this attempt
    // by the implementer loop's carryDecision (TASK-21 step 2) before launch —
    // the loop's carry layout at this run's start. Null elsewhere, never
    // fabricated — only a non-empty task-id list survives. Additive.
    carriedForwardTasks:(Array.isArray(carriedForwardTasks)&&carriedForwardTasks.length>0?carriedForwardTasks:null),
    startedAt:started,
    finishedAt:finished,
    review:verdict.status==="available"?{decision:verdict.decision,findings:verdict.findings,...(Array.isArray(verdict.previous)&&verdict.previous.length?{previous:verdict.previous}:{})}:null,
    gitHeadBefore:before.head,
    gitHeadAfter:after.head,
    treeChanged:before.fingerprint!==after.fingerprint,
    readOnlyViolation,
    commitDetected,
    gitMutationAttempted,
    guardLogUnavailable,
    gitGuardEvents:guardEvents,
    gitGuardWarning,
    policyViolation
  };
  // TASK-28: on violation only, record which Git-state field(s) tripped the
  // detection, with a bounded, redacted before/after line diff, plus the
  // full redacted snapshots under git-guard/. Additive: when commitDetected
  // is false the field stays out, so normal results are byte-identical. A
  // failed snapshot write must never change the relay outcome — one warning,
  // then continue.
  if(commitDetected){
    result.gitStateChanges=gitStateChangesForEvidence;
    try{
      const guardDir=guard?.guardDir;
      if(guardDir){
        fs.mkdirSync(guardDir,{recursive:true});
        fs.writeFileSync(path.join(guardDir,"snapshot-before.json"),JSON.stringify(redactedGitSnapshot(before),null,2));
        fs.writeFileSync(path.join(guardDir,"snapshot-after.json"),JSON.stringify(redactedGitSnapshot(after),null,2));
      }
    }catch(error){
      console.warn(`git state evidence snapshots unavailable: ${error?.message||error}`);
    }
  }
  if(contract.status==="invalid")result.status="failed";
  if(p.error)result.status="failed";
  if(roleName) result.role=roleName;
  return result;
}
// Mission-scoped run ledger.
//
// Delegated runs are grouped under per-mission parent folders so that every
// file belonging to one mission lives together, mirroring how SpecKit keeps a
// numbered folder per feature under `specs/`:
//
//   .autopilot/missions/<mission>/runs/<seq>-<role>-<shortid>/   task-phase runs for a mission
//   .autopilot/missions/planning/runs/<seq>-<role>-<shortid>/    planning-phase runs (specify/plan/tasks/review)
//   .autopilot/runs/<seq>-<role>-<shortid>/                      fallback: no mission derivable (flat, backward compatible)
//
// Run folders carry a unique per-mission sequence (oldest->newest), the relay
// role, and the first 8 chars of the run UUID. The FULL UUID is preserved as
// `run_id` in status.json and result.json. Legacy UUID-only folders (no seq)
// remain readable and are never renamed.
//
// Mission naming mirrors SpecKit: the NAME comes from the user's request
// (SpecKit's short-name convention), and the NUMBER is an independent
// autopilot sequence (next available in `.autopilot/missions/`) — never
// borrowed from the spec directory. So `specs/007-dashboard-design-prototype`
// and `missions/001-dashboard-design-prototype` may differ numerically but
// always share the same name.
//
// Resolution chain (first hit wins):
//   1. explicit override (`--mission` CLI > `AUTOPILOT_MISSION` env > `project.mission` config)
//   2. persisted `s.mission` (the unified `<seq>-<name>` for the active mission)
//   3. spec-derived: `currentTask.file` (implementation) or newest `specs/*/` (planning), number stripped
//   4. message-derived: `nameFromRequest()` — the SpecKit `generate_branch_name` port
//   5. none → `null` (flat legacy bucket). Reached only when a run is refused upstream,
//      so in practice every run with a request/override gets a named mission folder.
// Mission naming/path helpers live in ./mission-naming.mjs (leaf module shared
// with adapters/standalone.mjs without an import cycle).
function runsDirFor(s){
  // Mission 091: an adhoc review carries its parent dir on its synthetic
  // in-memory state (never persisted); real mission states never have it.
  if(s&&typeof s.__adhocRunsDir==="string"&&s.__adhocRunsDir) return s.__adhocRunsDir;
  const mission=missionDirFor(repo,s);
  return mission
    ? path.join(repo,".autopilot","missions",mission,"runs")
    : path.join(repo,".autopilot","runs");
}
function runDirFor(s,id,roleName){
  const mission=missionDirFor(repo,s);
  const base=runsDirFor(s);
  const seq=String(nextRunSeq(base)).padStart(2,"0");
  const role=String(roleName||"relay").replace(/[^A-Za-z0-9_]/g,"_");
  return {dir:path.join(base,`${seq}-${role}-${String(id).slice(0,8)}`),mission};
}
function observabilityMeta(s, taskRef=null){
  const text=typeof s?.currentTask?.text==="string"?s.currentTask.text:(typeof s?.currentTask==="string"?s.currentTask:"");
  const tm=text.match(/^T\d+/);
  return {
    phase: s?.phaseIndex!=null ? String(s.phaseIndex+1) : null,
    // Grouping key: the T-label of s.currentTask, which follows the cursor
    // (set per task in both per-task loops), so runs group per task. Tasks
    // whose text has no leading T-label (e.g. standalone "**1.1** …")
    // contribute null and group as before. Never read this as "the task
    // this run worked on" — that is taskRef. renderRunHistory grouping
    // tolerates nulls (flat()/keyOf() in run-history.mjs), so a null here
    // degrades to Unassigned, never a crash.
    taskGroup: tm?tm[0]:null,
    // The run's actual task scope as display refs ("T1.1" for one task,
    // "T001 > T003" for a range, null when the role is phase-level or the
    // scope is unknown). Supplied explicitly per relay call, never derived
    // from global state.
    taskRef: typeof taskRef==="string"&&taskRef ? taskRef : null,
    attempt: s?.attempt!=null ? String(s.attempt) : null
  };
}
function relay(roleName,task,c,s,options={}){
  const {readOnly=false,resume=false,review=false,persistState=true,requirements=[],taskFacts={},timeoutMs=null,taskRef=null,isWrapUp=false,runNote=null,capEnabled=false,contScope=null,planRevision=null,carriedForwardTasks=null,resultExtra=null}=options;
  const callSite = relayGuardEnabled() ? new Error("relay() call site").stack : null;
  return guardRelay(runRelay(roleName,task,c,s,{readOnly,resume,review,persistState,requirements,taskFacts,alwaysSave:false,fatal:die,includeError:false,timeoutMs,taskRef,isWrapUp,runNote,capEnabled,contScope,planRevision,carriedForwardTasks,resultExtra}), callSite);
}
function resolvePermissionFiles(repo,files){
  return (files||[]).map(file=>{
    const expanded=String(file).replace(/^~(?=[\\/])/, process.env.USERPROFILE||process.env.HOME||"");
    return path.isAbsolute(expanded)?expanded:path.resolve(repo,expanded);
  });
}
function resolveRuntimeFiles(binaryPath,siblings){
  return (siblings||[]).map(name=>{
    if(path.basename(name)!==name) throw new Error(`Adapter runtime sibling '${name}' must be a basename.`);
    return path.join(path.dirname(binaryPath),name);
  });
}
// OpenCode runtime-config override (agent definition + snapshot disable) lives
// in scripts/opencode-runtime-config.mjs — see that module for the full
// permission-engine/snapshot history. Called below via guardedEnv extras.
// Backlog #17: drop a stale sticky fallback (config primary changed, or older
// than the retry window) and the role's tried-free list, so the primary is
// tried again. The single entry point for every effective-model resolution.
function syncStickyFallback(s,c,roleName){
  try{
    let configMtimeMs=null;
    try{ configMtimeMs=fs.statSync(cfgPath).mtimeMs; }catch{}
    const stale=staleStickyFallback({role:roleName,roleConfig:c.roles?.[roleName]??null,activeModel:s.activeRoleModels?.[roleName]??null,policy:c.policy,configMtimeMs});
    if(!stale) return false;
    const {[roleName]:_a,...restActive}=s.activeRoleModels||{}; s.activeRoleModels=restActive;
    if(s.triedFreeModels&&roleName in s.triedFreeModels){ const {[roleName]:_t,...restTried}=s.triedFreeModels; s.triedFreeModels=restTried; }
    console.log(stale.message);
    return true;
  }catch{ return false; }
}
function effectiveRoleModelFor(s,c,roleName){
  syncStickyFallback(s,c,roleName);
  return resolveEffectiveRoleModel(c.roles?.[roleName]??null,s.activeRoleModels?.[roleName]??null);
}
async function runRelay(roleName,task,c,s,{cwd=repo,readOnly=false,resume=false,review=false,persistState=true,alwaysSave=false,fatal,includeError=true,requirements=[],taskFacts={},timeoutMs=null,taskRef=null,isWrapUp=false,runNote=null,capEnabled=false,contScope=null,planRevision=null,carriedForwardTasks=null,resultExtra=null,__fallbackDepth=0,__sessionRetry=false}={}){
  const fail=(m)=>{ if(fatal) return fatal(m); throw new Error(m); };
  // Task 042-1.5: refuse new role runs once SIGTERM/SIGINT arrived. Must stay
  // before runDirFor/mkdir or any artifact creation so a signal racing the
  // next role start cannot spawn a new child.
  if(shuttingDown) return fail(`runRelay: refusing to start ${roleName} — orchestrator is shutting down (received SIGTERM/SIGINT)`);
  const rawRole=c.roles?.[roleName]; if(!rawRole) return fail(`Missing role: ${roleName}`);
  // Mission 087 task 2.1: effective adapter/model/reasoning/variant. The
  // sticky s.activeRoleModels[role] (set at the RATE_LIMITED choke point
  // below) overrides the configured primary; without it the primary stands.
  // A fresh object — c.roles is never mutated — so every downstream use of
  // `role` (transport gate, spawn, usage, result.model) runs the fallback.
  // The fallback entry carries only its own reasoning/variant: clear both
  // before merging so a fallback on another adapter never launches with
  // effort/variant flags validated only against the primary adapter.
  let role=rawRole;
  try{
    if(syncStickyFallback(s,c,roleName)&&persistState){ try{ saveState(s); }catch{} }
    let effective=resolveEffectiveRoleModel(rawRole,s.activeRoleModels?.[roleName]??null);
    // Backlog #18: never spend a run on a model another role already found
    // exhausted. If the effective model is exhausted and a configured
    // fallback (or an auto-discovered free model) is still usable, switch
    // right away exactly like the RATE_LIMITED choke point below; otherwise
    // run as today and let the normal failure/escalation path handle it.
    try{
      const nowMs=Date.now();
      if(effective&&isExhausted(s.exhaustedModels,effective,c.policy,nowMs)){
        let decision=skipExhaustedRoleModel({role:roleName,roleConfig:rawRole,activeModel:s.activeRoleModels?.[roleName]??null,exhausted:s.exhaustedModels,policy:c.policy,nowMs});
        if(decision?.action!=="switch"){
          decision=await extendFallbackWithFree({decision:{action:"escalate",reason:`${roleName}: exhausted model; no configured fallback`},role:roleName,roleConfig:rawRole,activeModel:s.activeRoleModels?.[roleName]??null,failureClass:"RATE_LIMITED",tried:s.triedFreeModels?.[roleName]??[],enabled:c.freeModelAutoFallback!==false,adapters:agents,discover:(a)=>agents[a]?discoverModelCatalog(agents[a]):[],exhausted:s.exhaustedModels,policy:c.policy,nowMs});
        }
        if(decision?.action==="switch"&&decision.next){
          s.activeRoleModels={...(s.activeRoleModels||{}),[roleName]:stampStickyFallback(decision.next,rawRole,now())};
          const spent=s.exhaustedModels?.[`${effective.adapter}/${effective.model}`];
          const at=Date.parse(spent?.at);
          const ago=Number.isFinite(at)?Math.max(0,Math.floor((nowMs-at)/60000)):0;
          console.log(`${formatRoleFallbackLog({role:roleName,from:effective,to:decision.next,reason:decision.autoDiscovered?"RATE_LIMITED, auto-discovered free model":"RATE_LIMITED"})} — skipped, exhausted by ${spent?.by??"unknown"} ${ago} min ago`);
          if(persistState){ try{ saveState(s); }catch{} }
          effective=resolveEffectiveRoleModel(rawRole,s.activeRoleModels?.[roleName]??null);
        }
      }
    }catch{}
    if(effective) role={...rawRole,reasoning:undefined,variant:undefined,...effective};
  }catch{}
  // Pending #22: a reviewer/verifier start ends the fix round, so the fixing
  // role's pending escalation is dropped (its next run is back on the normal
  // or fallback model; the stored session of the escalated model is cleared).
  try{ const ended=consumeEscalationFor(s,roleName); if(ended){ clearRoleSession(s,ended); if(persistState) saveState(s); } }catch{}
  // Pending #22: ONE fix round on the stronger model (never on the at-once
  // fallback re-run). The model switch starts a fresh session (#112).
  let escalated=false;
  if(__fallbackDepth===0&&(roleName==="planner"||roleName==="implementer")){
    try{
      const esc=pendingEscalationModel(s,c,roleName);
      if(esc){ role={...rawRole,reasoning:undefined,variant:undefined,...esc}; escalated=true; clearRoleSession(s,roleName); }
    }catch{}
  }
  const a=agents[role.adapter]; if(!a) return fail(`Unknown agent adapter: ${role.adapter}`);
  // Pre-spawn transport gate. This MUST stay before the run directory and
  // any other role-run artifact is created. A second, authoritative
  // resolution with the fully constructed mission request happens below;
  // that result is what actually launches.
  const missionTransportGate=resolveAdapterTransport({driver:adapterDriver(role.adapter),profile:a.provider_egress?.default_profile||null,request:{binary:a.binary}});
  if(!missionTransportGate.available) return fail(`Adapter transport unavailable for ${roleName}: ${missionTransportGate.reason}.`);
  // No `--version` probe here. Every operational command runs
  // preflightConfiguredRoles() before the mission opens, so re-launching the
  // CLI once per role invocation only added latency; a real spawn failure is
  // still surfaced with its own diagnostics by the relay spawn below.

  const id=randomUUID(), {dir,mission}=runDirFor(s,id,roleName);
  fs.mkdirSync(dir,{recursive:true});
  // Backlog 003#36: every pre-launch fail-closed exit below (disposable-
  // workspace creation, the buildRoleRequirements throw, Playwright/bridge
  // refusals) returns before the child ever spawns, so the onStart initRun
  // never fires and the run directory keeps zero metadata (mission 006 run
  // 31: only an empty scratch/, bucketed "Unassigned / UNKNOWN"). Seed the
  // run metadata here, right after the directory exists, so each of those
  // exits leaves a keyed status.json (role/runId/phase/task/attempt) the
  // run-history consecutive-same-key grouping can merge. The onStart call
  // below still rewrites it with the real pid once the child spawns. s is
  // never mutated between here and the old compute site, so hoisting the
  // meta computation is value-identical on paths that reach spawn.
  const meta=observabilityMeta(s,taskRef);
  if(runNote) meta.note=runNote;
  // Mission 093 Part 1 task 2.2: the effective (active/fallback-resolved)
  // model at launch. Null when the CLI chose its default (""/missing is
  // never a fabricated model id); the stream-resolved actual model lands on
  // resolvedModel/modelMismatch via recordRunModel, never here.
  const configuredModel=(typeof role.model==="string"&&role.model!==""?role.model:null);
  // Mission 093 Part 1 task 2.3: the run scope's session number — its
  // continuation-budget used count at launch + 1 (null when this run owns no
  // continuation scope). Snapshot timestamps land via updateRunSnapshots at
  // their sites below; the seed carries nulls, never fabricated times.
  const sessionNumber=resolveSessionNumber(s,contScope);
  // Mission 093 Part 1 task 2.4: plan revision number on planning runs (the
  // standalone revision-loop generation, 0-based). Only a finite integer >= 0
  // survives; anything else (including the null default on non-planning runs)
  // degrades to null, never a fabricated zero.
  const planRevisionValue=(Number.isInteger(planRevision)&&planRevision>=0?planRevision:null);
  // Mission 093 Part 1 task 2.5: the implementer loop's carry layout at this
  // attempt's launch — the task ids carryDecision carried forward before
  // this run. Only a non-empty list survives; anything else (including the
  // null default on non-carry runs) degrades to null, never fabricated.
  const carriedForwardTasksValue=(Array.isArray(carriedForwardTasks)&&carriedForwardTasks.length>0?carriedForwardTasks:null);
  initRun(dir,{role:roleName,runId:id,...meta,configuredModel,resolvedModel:null,modelMismatch:null,sessionNumber,snapshotBeforeStartedAt:null,snapshotBeforeAt:null,snapshotAfterStartedAt:null,snapshotAfterAt:null,planRevision:planRevisionValue,carriedForwardTasks:carriedForwardTasksValue});
  // Backlog 003#31: track the active run for the SIGTERM/SIGINT flush
  // (installed once below). Deliberately never cleared: markInterrupted()
  // only touches `running` status files, so a stale reference to a finished
  // run is a safe no-op.
  activeRunDir=dir;
  activeRelayState=s;
  installInterruptFlush();
  // Native Windows compatibility path (task 15.3, extended by task 15.4A to
  // SpecKit Code Reviewer, task 15.4B1 to SpecKit Verifier, and task 15.2
  // Phase 2 to standalone): plain Windows has no bubblewrap-equivalent
  // filesystem containment (platform-capabilities.mjs), so these read-only
  // roles run against a disposable, throwaway copy of the repository
  // (reviewer-workspace.mjs) instead of failing closed. SpecKit and Standalone
  // frameworks both support disposable copies on native Windows; mission-scoped
  // overlays (when available) are copied into the disposable workspace. The
  // copy always reflects the CURRENT working tree (createReviewerWorkspace
  // copies from disk, not from a commit), so the Verifier sees exactly what the
  // Implementer just produced. This is compatibility isolation against
  // accidental/relative-path writes, NOT an OS-enforced sandbox — it cannot
  // stop a malicious same-user process that independently discovers and
  // writes an absolute official-repository path. GSD is unchanged: its
  // read-only roles still fail closed below exactly as before, and WSL/Linux
  // bubblewrap is untouched. Browser/Playwright provisioning is NOT part of
  // this path — it is handled separately.
  const isNativeWindowsSpeckitOrStandalone = process.platform==="win32" && (c.project?.planning_framework==="speckit" || c.project?.planning_framework==="standalone");
  const useDisposableReviewerWorkspace = readOnly
    && isNativeWindowsSpeckitOrStandalone
    && (roleName==="plan_reviewer" || roleName==="code_reviewer" || roleName==="verifier");
  let disposableWorkspace=null;
  if(useDisposableReviewerWorkspace){
    try{
      const disposableArgs=disposableCopyArgs({framework:c.project?.planning_framework,repository:cwd,mission:c.project?.planning_framework==='standalone'?mission:null});
      const workspaceConfig=disposableArgs||{repository:cwd};
      disposableWorkspace=await createReviewerWorkspace(workspaceConfig);
    }catch(error){
      return fail(`${roleName}: failed to create the Windows disposable reviewer workspace: ${error?.message||error}`);
    }
  }
  // workspaceCleaned is set to true ONLY after cleanup() actually succeeds —
  // never optimistically before the call. A cleanup failure is captured in
  // workspaceCleanupError and is NEVER swallowed: it always makes this
  // relay call fail (see the explicit check after result-processing below,
  // and failClosingWorkspace for the earlier-exit call sites), and it must
  // never be reported as a successful PASS. Idempotent either way — once
  // attempted (successfully or not), it is never re-attempted; a failed
  // cleanup is a terminal, reported condition, not something to retry
  // silently. This wrapper adds no leniency to reviewer-workspace.mjs's own
  // cleanup() — it only observes and propagates whatever that function
  // decides (including its own refusal to remove a workspace root that has
  // been substituted with a symlink/junction).
  let workspaceCleaned=false;
  let workspaceCleanupError=null;
  const cleanupDisposableWorkspace=()=>{
    if(!disposableWorkspace||workspaceCleaned||workspaceCleanupError) return;
    try{ disposableWorkspace.cleanup(); workspaceCleaned=true; }
    catch(error){ workspaceCleanupError=error; }
  };
  // fail() may call process.exit() directly (the synchronous relay() -> die
  // path) rather than throw — process.exit() does not unwind a pending
  // try/finally, so every fail() reachable while the workspace is active
  // must attempt cleanup FIRST, explicitly (never exit with an unattempted
  // cleanup). If cleanup itself also fails, that is folded into the same
  // failure message rather than dropped — both the primary failure and the
  // cleanup failure are preserved when both exist.
  const failClosingWorkspace=(m)=>{
    cleanupDisposableWorkspace();
    if(workspaceCleanupError){
      return fail(`${m} (additionally, the disposable reviewer workspace could not be cleaned up: ${workspaceCleanupError?.message||workspaceCleanupError})`);
    }
    return fail(m);
  };

  try{
  // Everywhere the reviewer child (and its guard/environment) can observe a
  // repository path — its own cwd, the REPOSITORY prompt value, PWD/
  // INIT_CWD, and the Git guard's safe.directory — uses effectiveCwd, so the
  // disposable copy stands in for the official repository. `cwd` itself is
  // never reassigned: the before/after Git snapshots below always inspect
  // the OFFICIAL repository, exactly as before this path existed.
  const effectiveCwd=disposableWorkspace?disposableWorkspace.reviewRepository:cwd;
  const scratchDir=readOnly?path.join(dir,"scratch"):null;
  if(scratchDir && !disposableWorkspace) fs.mkdirSync(scratchDir,{recursive:true});
  // disposableWorkspace's own scratch directory (already created by
  // createReviewerWorkspace) stands in for the default scratchDir above —
  // used everywhere downstream instead of scratchDir so the default
  // `dir/scratch` computation above (never created on disk in this branch)
  // stays purely a no-op placeholder for that case.
  const effectiveScratchDir=disposableWorkspace?disposableWorkspace.scratchDirectory:scratchDir;
  // Filesystem containment (WSL/Linux bubblewrap: repository read-only,
  // scratch writable, normal network) is attempted ONLY for read-only
  // roles (plan_reviewer, code_reviewer, verifier) and is a HARD
  // requirement for them — it never silently falls back to running
  // unsandboxed. Planner/Implementer keep their existing unsandboxed
  // writable behavior and are never blocked by this check. There is no
  // certification, receipt, fingerprint, or admission decision involved.
  // The Windows disposable-copy path above is a separate, non-envelope
  // mechanism: it never attempts the bubblewrap envelope, so it must never
  // apply the envelope's trusted-envelope-only argument transformations
  // either (buildRelayArgs' trustedEnvelope below follows attemptEnvelope).
  const attemptEnvelope=readOnly && !disposableWorkspace;
  const stateForRelay={...s,__relayRoleName:roleName};
  // Backlog #26 Step B (TASK-34): persistent per-task session store,
  // implementer only. The host dir
  // `.autopilot/missions/<mission>/sessions/<task-ref>/` is ensured here so
  // it exists for size accounting even on paths that never enter an
  // envelope. When an envelope IS built, only the adapter's data dir is
  // bound (opencode `~/.local/share/opencode`, claude `~/.claude` — never
  // the whole HOME, so unrelated HOME contents stay out); read-only roles
  // never receive mounts. Native path (Windows/Linux, where the writable
  // implementer runs unenveloped with the real user HOME): sessions already
  // persist — confirmed live (opencode.db under ~/.local/share/opencode,
  // resume via `--session` returns prior context) — so no bind is needed
  // there. Under `.autopilot/` by construction: snapshot/fingerprint
  // exclusion covers it with no new rule.
  let sessionStoreMounts=[];
  let sessionStoreRel=null;
  if(roleName==="implementer" && mission && taskRef){
    sessionStoreRel=sessionStoreRelDir(mission,taskRef);
    ensureSessionStoreDir(mission,taskRef);
    const subpath=sessionStoreSandboxSubpath(role.adapter);
    const hostDir=sessionStoreHostDir(mission,taskRef);
    if(subpath && hostDir) sessionStoreMounts=[{host:hostDir,sandbox:`${SANDBOX_HOME}/${subpath}`}];
  }

  const promptRepository=attemptEnvelope?mapPathIntoEnvelope(effectiveCwd, {available: true, sandbox: {repository: "/workspace/repository"}}, effectiveCwd, effectiveScratchDir) : effectiveCwd;
  const promptScratch=effectiveScratchDir? (attemptEnvelope?"/workspace/scratch":effectiveScratchDir) : effectiveScratchDir;
  // Task 15.4C2 correction: Playwright discovery for the Verifier is computed
  // here, against `cwd` — the OFFICIAL repository passed into this call —
  // never against effectiveCwd/promptRepository (the WSL envelope's
  // sandboxed "/workspace/repository" string, or the Native Windows
  // disposable copy, which intentionally excludes gitignored node_modules).
  // This fixes the false-negative bug: a real Playwright install in the
  // official repository must be discovered even though the Verifier
  // subprocess itself never runs with the official repository as its own
  // cwd.
  //
  // Explicit data flow only: the discovery result lives in a local variable
  // and is passed directly as an explicit verifierTask() argument. The
  // configuration object `c` is never mutated — no hidden runtime property
  // is ever created on it. Recomputed fresh on every verifier call, so a
  // stale value is never observed even though `c` is the same object reused
  // for the whole mission.
  let playwrightRuntimeForVerifier=null;
  if(roleName==="verifier"){
    try{
      playwrightRuntimeForVerifier=discoverPlaywrightRuntime({repository:cwd,skillRoot});
    }catch{
      playwrightRuntimeForVerifier={readyForLaunchProbe:false,module:{status:"not-found",source:null},browser:{status:"not-found",source:null},failureReason:"discovery threw unexpectedly"};
    }
  }
  // Task 15.4C3C: Native Windows compatibility bridge only — decides,
  // read-only, whether the already-discovered playwrightRuntimeForVerifier
  // (never rediscovered here) is eligible to be exposed to the disposable
  // Native Windows Verifier child's environment below. A no-op
  // (`applicable:false`) for every other role/platform/mode, and for a
  // repository-local runtime. An eligible-but-no-longer-valid external
  // runtime fails this relay call closed immediately, before any launch is
  // attempted — never with a partial environment, never by falling back to
  // a repository-local runtime.
  const windowsVerifierPlaywrightBridge=resolveWindowsVerifierPlaywrightBridge({
    platform:process.platform,roleName,disposableWorkspaceActive:!!disposableWorkspace,
    officialRepo:cwd,playwrightRuntime:playwrightRuntimeForVerifier
  });
  // TASK 16.3A: reuse the existing production task-requirement authority
  // (task-requirements.mjs's structural facts + role-requirements.mjs's
  // require_browser/browser-mode policy, both already threaded into this
  // function as the `requirements`/`taskFacts` parameters) to decide whether
  // THIS Verifier call genuinely needs deterministic Playwright browser
  // verification — never a second prompt-text regex. buildRoleRequirements()
  // is the same authority admissionDecision() uses; a requirement of
  // "browser.playwright.deterministic" is the one and only signal that
  // means "the physical Playwright module + Chromium runtime is required",
  // as distinct from "browser.native.supported" (the agent's own browsing
  // tool, unrelated to this runtime and never gated here).
  //
  // When that requirement is present, the runtime must be genuinely
  // deliverable — discovered (playwrightRuntimeForVerifier.readyForLaunchProbe)
  // AND, on the Native Windows disposable-copy path, not blocked by the
  // compatibility bridge above — or this call fails closed BEFORE the
  // Verifier is ever launched. This is intentionally a plain thrown/fatal
  // failure (exactly like every other pre-launch fail-closed check in this
  // function, e.g. the bridge-invalid check just above and the transport/
  // envelope-unavailable checks below): it never reaches
  // enforceAttemptFailure/recordFailureBudget (so no ordinary Verification
  // rejection budget is ever consumed), never advances s.phaseIndex/
  // s.checkpoint, and never marks a task checkbox — so the task/phase stays
  // exactly where it was, and state.json (s.phase/s.step/s.currentPhase/
  // s.currentTask, already saved by the caller before this relay call) is
  // itself the resumable checkpoint: rerunning `ap run` re-enters this same
  // mission/feature/phase/task and, once a real runtime is provisioned,
  // proceeds to launch the Verifier normally and only marks the task
  // complete after a genuine Verification PASS.
  if(roleName==="verifier"){
    let verifierRequirements;
    try{
      verifierRequirements=buildRoleRequirements({config:c,roleName,role,taskText:task,explicit:requirements,taskFacts});
    }catch(err){
      // Fail CLOSED, but with a NAMED cause. These tokens come from the
      // planner's own task annotations, taken verbatim by the framework
      // adapters (adapters/*.mjs), so an unrecognised one is a structural
      // condition to report with the offending text and a state.step — never a
      // bare Error leaving this function as a stack trace (mission 004's F6,
      // where `Unknown capability requirement 'read'` killed the run at the
      // verifier relay with no die() message).
      const classed=requirementFailure(err,{roleName,taskText:task});
      if(!classed) throw err;
      s.phase="escalated";s.step=classed.step;s.lastFailure=classed.failure;
      s.unrecognisedRequirement={token:err.token??null,role:roleName};
      saveState(s);
      die(`${classed.message} STOP — human intervention required.`);
    }
    const browserVerificationRequired=verifierRequirements.some(r=>(typeof r==="string"?r:r?.id)==="browser.playwright.deterministic");
    if(browserVerificationRequired){
      const bridgeBlocksDelivery=windowsVerifierPlaywrightBridge.applicable && !windowsVerifierPlaywrightBridge.valid;
      const runtimeReady=playwrightRuntimeForVerifier?.readyForLaunchProbe===true && !bridgeBlocksDelivery;
      if(!runtimeReady){
        const moduleMissing=playwrightRuntimeForVerifier?.module?.status!=="discovered";
        const browserMissing=playwrightRuntimeForVerifier?.browser?.status!=="discovered";
        const missingLabel=bridgeBlocksDelivery
          ? `a previously discovered runtime could not be safely delivered to the Verifier (${windowsVerifierPlaywrightBridge.invalidReason})`
          : (moduleMissing && browserMissing ? "module and browser" : moduleMissing ? "module" : "browser");
        return failClosingWorkspace(`${roleName}: PLAYWRIGHT_RUNTIME_UNAVAILABLE: this task requires deterministic Playwright browser verification, but the required runtime is not available (${missingLabel} missing). Install/provision Playwright (module + Chromium) and rerun the exact same request; this task remains unchecked and the mission will resume from here once the runtime is available.`);
      }
    }
  }
  if(windowsVerifierPlaywrightBridge.applicable && !windowsVerifierPlaywrightBridge.valid){
    return failClosingWorkspace(`${roleName}: playwright_runtime_invalid: a previously discovered external Playwright runtime is no longer valid immediately before Verifier launch (${windowsVerifierPlaywrightBridge.invalidReason}); refusing to launch with a partial runtime environment.`);
  }
  const relayTask = roleName === "verifier" ? verifierTask(task,promptRepository,promptScratch,c,playwrightRuntimeForVerifier) : task;
  const rawRelayTaskText=[
    `ROLE=${roleName}`,`REPOSITORY=${promptRepository}`,
    mission?`MISSION=${mission}`:null,
    "You are a delegated worker. The orchestrator owns Git history: never run git commit or git push, and never create git worktrees, branches, stashes or tags — the git guard blocks them and the mission stops. To see a committed version use `git show HEAD:<path>` or `git diff`.",
    "Run every command in the foreground and wait for its output in the same turn. Never start background jobs (&, nohup, setsid, run_in_background), never poll with sleep/ps/pgrep loops: your session ends when you end your turn.",
    roleName==="implementer"?"Some tests read source files as text and anchor on exact function signatures/calls; when you change a signature, run the tests that grep for it (grep -rl '<old text>' scripts/test-*.mjs) and keep them passing.":null,
    "If a git diff shows whole-file churn, re-run it EOL-normalized (git diff --ignore-cr-at-eol or git -c core.autocrlf=input diff) and trust the normalized stat.",
    readOnly
      ? `This is a READ-ONLY review. Do not modify any file in the repository. You may write only inside the sanctioned scratch directory: ${promptScratch} (temporary test artifacts, browser checks, reports, browser profiles, and Playwright specs/screenshots/traces go there; ${disposableWorkspace ? "this scratch directory is temporary and is deleted once this review finishes — nothing written here is retained for audit" : "the orchestrator keeps them for audit"}).`
      : "You may modify only files required by the brief.",
    "", "TASK:", relayTask,
    // Each finding must stand on its own. The role that receives it is a
    // FRESH session with no access to this review's reasoning, so a bare
    // summary ("X is hard-coded to a nonexistent path") forces it to go
    // hunting through runs/ logs for the detail — one observed planner
    // burned 22 tool calls and 3.16M cached tokens doing exactly that.
    // Bounded on purpose: location + problem + correction, not an essay.
    review ? '\nThis is a SINGLE-SHOT invocation: the process exits when your turn ends, and there is no later turn — nothing can notify you afterwards. Never end your turn waiting for a background task, a job, or a notification. Collect the result of any check you start in this same turn, or skip it and state that in your findings: a turn that ends while waiting produces no verdict at all, and the mission halts.\nEnd with exactly one line: AUTOPILOT_REVIEW={"decision":"PASS","findings":[]} or FAIL or INCOMPLETE. Use INCOMPLETE when you cannot finish checking everything in this turn — list what remains unchecked in your findings and the orchestrator will continue the review.\nEach finding must be self-contained and actionable WITHOUT reading this review again: give it as {"tasks":["T1"],"location":"<file, or artifact/section>","problem":"<what is wrong>","correction":"<what must change>"}. When your instructions show [Tn] task labels, every finding MUST include "tasks": the [Tn] labels of the tasks this finding concerns (for example ["T1"]), or [] only when the finding genuinely concerns the whole phase (for example, cross-task wiring) — prefer naming a task whenever one is responsible. When your instructions show no [Tn] task labels at all, omit "tasks". Keep each field to one or two sentences. Plain strings are still accepted, but then the string itself must carry all three.' : ""
  ].filter(Boolean).join("\n");
  // Task 15.4C2 correction, generalized: remap EVERY repository-root-
  // qualified path in the COMPLETE final prompt (not only the Verifier's
  // Playwright guidance block) from the official repository root to the
  // representation this role can actually access: WSL/Linux bubblewrap ->
  // "/workspace/repository" (already promptRepository there), Native
  // Windows SpecKit -> the disposable reviewRepository path (already
  // promptRepository there). The relative suffix — including tasks.md line
  // references such as ":3" and the standalone framework's PLAN.md path —
  // is preserved; matching is path-boundary-aware so similar prefixes
  // (C:\repo-other vs C:\repo) are never rewritten; Windows matching is
  // case-insensitive and accepts both slash spellings; the canonical/real
  // root is honored where it differs. Applied to every role, not just the
  // Verifier: Plan Reviewer and Code Reviewer prompts can equally embed an
  // official-root path (e.g. the standalone planner's "Plan file: <path>"
  // line) that a sandboxed reviewer must see under its own visible root or
  // it will reject the read as outside its trusted project. Safe to call
  // unconditionally — remapRepositoryPaths() is a documented no-op whenever
  // the official and visible roots are identical (the planner/implementer
  // case, and any role that never entered an envelope or disposable copy).
  const relayTaskText = remapRepositoryPaths(rawRelayTaskText, cwd, promptRepository);
  // Stdin-encoding drivers (agy's stream-json framing) run their encoder
  // inside buildRelayArgs and land the framed line in this sink; every other
  // adapter sends the raw prompt text on stdin unchanged.
  const relayStdin={text:null};
  const args=buildRelayArgs(role,a,readOnly,resume,stateForRelay,{trustedEnvelope:attemptEnvelope, promptText: relayTaskText, stdinSink:relayStdin, forceResume:isWrapUp});
  const relayStdinText=relayStdin.text==null?relayTaskText:relayStdin.text;
  // AUTHORITATIVE mission transport: the fully constructed mission request
  // (manifest argv + brief stdin) is resolved once here, and exactly
  // missionTransport.invocation / missionTransport.stdin are launched below.
  // No parallel launch payload exists on this path.
  let missionLaunchPlan;
  if(attemptEnvelope){
    // Mission 001 task 14 (opencode-only): seed the shared cache
    // synchronously before building the envelope, resolve its published
    // `current` to a concrete versions path, and pass generic {host,sandbox}
    // mount descriptors (plus the matching env vars) into the envelope.
    // execution-envelope.mjs has no knowledge of OpenCode or its cache
    // layout — all of that lives here, the only place this check needs it
    // to. Non-opencode roles never call the seeder and never receive any of
    // these parameters. Test-only override parameters are never supplied
    // from this production call site.
    const OPENCODE_SHARED_CACHE_SANDBOX_PATH="/autopilot/opencode-cache";
    let sharedCacheMount=null;
    let sharedCacheCompanionMount=null;
    let sharedCacheExtraEnv={};
    if(role.adapter==="opencode"){
      try{
        // Backlog #1: name the model(s) this launch will use so the shared
        // snapshot refreshes when its catalog is stale or lacks one. One
        // check per relay launch; the warning is printed once, here.
        const seeded=ensureOpenCodeCacheSeeded({requiredModels:openCodeModelsForRole(role)});
        if(seeded?.warning?.message) console.warn(`Warning: ${seeded.warning.message}`);
        if(seeded && seeded.ok && seeded.snapshotDir){
          try{
            // The pin block below re-resolves from the envelope's recorded
            // mount entry, so no separate pin-target variable is kept here.
            const snapshotDir=fs.realpathSync(seeded.snapshotDir);
            sharedCacheMount={host:snapshotDir,sandbox:OPENCODE_SHARED_CACHE_SANDBOX_PATH};
            sharedCacheExtraEnv={
              OPENCODE_MODELS_PATH:`${OPENCODE_SHARED_CACHE_SANDBOX_PATH}/xdg-cache/opencode/models.json`,
              OPENCODE_DISABLE_MODELS_FETCH:"1"
            };
            if(effectiveScratchDir){
              const rgSource=path.join(snapshotDir,"xdg-cache","opencode","bin","rg");
              const placeholder=path.join(effectiveScratchDir,".autopilot-home",".cache","opencode","bin","rg");
              if(fs.existsSync(rgSource) && !fs.existsSync(placeholder)){
                fs.mkdirSync(path.dirname(placeholder),{recursive:true});
                fs.writeFileSync(placeholder,"");
              }
              if(fs.existsSync(rgSource) && fs.existsSync(placeholder)){
                sharedCacheCompanionMount={host:rgSource,sandbox:`${SANDBOX_HOME}/.cache/opencode/bin/rg`};
              }
            }
          }catch{
            sharedCacheMount=null;
            sharedCacheCompanionMount=null;
            sharedCacheExtraEnv={};
          }
        }
      }catch{
        sharedCacheMount=null;
        sharedCacheCompanionMount=null;
        sharedCacheExtraEnv={};
      }
    }
    const permissionFiles=resolvePermissionFiles(effectiveCwd,a.permission_files);
    const runtimeFiles=resolveRuntimeFiles(missionTransportGate.invocation.binary,a.runtime_siblings);
    // Task 15.4C3B: forward the already-discovered, unmutated
    // playwrightRuntimeForVerifier local (computed above against the
    // OFFICIAL repository, never rediscovered here) into the real launch
    // plan assembler — but ONLY for the Verifier role on this bubblewrap
    // envelope path. Plan Reviewer and Code Reviewer take this same
    // attemptEnvelope branch and MUST NOT receive it, so the dedicated
    // /playwright/node_modules mount and AUTOPILOT_PLAYWRIGHT_MODULE_ROOT
    // stay Verifier-only (role scoping). Nothing is stored on `c` or in
    // mission state — this is a plain per-call argument.
    missionLaunchPlan=assembleAdapterLaunchPlan({
      driver:adapterDriver(role.adapter),
      adapterProviderProfile:null,
      launchRequest:{binary:a.binary,args,stdin:relayStdinText},
      config:c,repo:effectiveCwd,scratchDir,readOnly:true,
      permissionFiles,runtimeFiles,
      playwrightRuntime: roleName==="verifier" ? playwrightRuntimeForVerifier : null,
      sharedCacheMount,sharedCacheCompanionMount,extraEnv:sharedCacheExtraEnv,
      // Backlog #26 Step B: implementer session-store bind (read-only roles
      // pass none — unchanged). Only the adapter's data dir, never HOME.
      sessionStoreMounts: roleName==="implementer" ? sessionStoreMounts : []
    });
    if(!missionLaunchPlan.available){
      // Task 15.4B1: on Native Windows for a SpecKit project, ALL three
      // read-only roles (plan_reviewer, code_reviewer, verifier) are now
      // diverted to the disposable-copy compatibility path above and never
      // reach this branch — attemptEnvelope is false for every one of them.
      // The former Native-Windows-specific wording ("only Verifier lacks a
      // compatibility path") is therefore gone rather than left behind as a
      // stale, now-untrue special case. What remains is the generic
      // containment message, which is accurate for every context that can
      // still land here: non-SpecKit frameworks (GSD, standalone) on any
      // platform, and WSL/Linux without usable bubblewrap.
      const detail=missionLaunchPlan.stage==="envelope"
        ? `READ_ONLY_CONTAINMENT_UNAVAILABLE: ${missionLaunchPlan.reason}. Read-only roles (plan_reviewer, code_reviewer, verifier) require WSL/Linux bubblewrap filesystem containment (repository read-only bind, writable scratch); it is not available in this environment. Plain Windows without WSL is not currently supported for these roles.`
        : `adapter transport unavailable (${missionLaunchPlan.reason})`;
      return failClosingWorkspace(`${roleName}: ${detail}`);
    }
  } else {
    const transport=resolveAdapterTransport({driver:adapterDriver(role.adapter),profile:null,request:{binary:a.binary,args,stdin:relayStdinText}});
    if(!transport.available) return failClosingWorkspace(`Adapter transport unavailable for ${roleName}: ${transport.reason}.`);
    missionLaunchPlan={available:true,transport,invocation:transport.invocation,stdin:transport.stdin,envelope:{available:false,reason:disposableWorkspace?"windows_disposable_copy":"not_applicable_writable_role"}};
  }
  const missionTransport=missionLaunchPlan.transport;
  const executionEnvelope=missionLaunchPlan.envelope;
  const invocationVerification=verifyAgentInvocation(missionTransport.invocation.args,role,a);
  if(!invocationVerification.ok){ return failClosingWorkspace(`CLI invocation verification failed for ${roleName}: ${invocationVerification.errors.join(" ")}`); }
  const brief=path.join(dir,"brief.txt");
  write(brief, relayTaskText);

  const guard=createGitMutationGuard(effectiveScratchDir||dir,effectiveCwd);
  // TASK 16: give the Layer-1 scope check a sandbox-side protected identity.
  // Inside the bwrap envelope the repository is remounted at
  // `/workspace/repository` while the guard directory lives under the sibling
  // `/workspace/scratch` bind, so the host paths in git-scope.conf don't
  // resolve there and the A2 ambient guard-dir probe finds no enclosing
  // repository — without this, isOutsideProtectedIdentity fails closed for
  // every commit-family subcommand, for every target. Append the envelope's
  // own sandbox.repository as an additional `root=` entry (additive data;
  // the existing containment logic consumes it unchanged). Bwrap-envelope
  // path only (guardedShell's createGitMutationGuard call backs
  // gates.commands under a separate, non-envelope mechanism and is out of
  // scope). Fail closed before the sandboxed process is spawned: any
  // rejection from the helper fails this relay call.
  if(attemptEnvelope&&executionEnvelope?.available&&executionEnvelope?.sandbox?.repository){
    if(!guard.scopeFile){
      return failClosingWorkspace(`${roleName}: git guard scope file missing; refusing to launch a sandboxed role without a provable protected identity.`);
    }
    try{
      appendGuardScopeRoot(guard.scopeFile,executionEnvelope.sandbox.repository);
    }catch(error){
      return failClosingWorkspace(`${roleName}: failed to record the sandbox repository identity in the git guard scope file: ${error?.message||error}`);
    }
  }
  // 024 Phase 4 task 4.2 - per-run before-snapshot for the Layer-1
  // worktree-restore guard (read by the generated wrapper next to
  // git-scope.conf). Fail closed before spawn, like the append block above.
  try{
    writeGuardBeforeSnapshot(guard.scopeFile,effectiveCwd);
  }catch(error){
    return failClosingWorkspace(`${roleName}: failed to record the git guard before-snapshot: ${error?.message||error}`);
  }
  // Mission 084 Phase 2 task 2.1 — snapshot reuse cache: consult the cache
  // first (collectSnapshotGuards + decideSnapshotReuse against the previous
  // after-snapshot); reuse on allow, else a fresh gitSnapshot. Any doubt
  // takes fresh, and the outcome is logged. The direct gitSnapshot(cwd)
  // fallback below keeps a snapshot call inside runRelay after
  // createGitMutationGuard( for the fresh path.
  const snapshotBeforeStartedAt=now();
  const before=(()=>{
    try{
      const currentGuards=collectSnapshotGuards(cwd);
      const cacheKey=getSnapshotCacheKey(cwd);
      const cached=getCachedSnapshot(cacheKey);
      const gapMs=cached&&typeof cached.storedAt==="number"?Date.now()-cached.storedAt:Number.NaN;
      const decision=decideSnapshotReuse(cached,currentGuards,gapMs,[]);
      if(decision.reuse&&cached?.snapshot){
        // Fail closed on the reuse path: the cached guards (HEAD/index/
        // status) are unchanged by a worktree registration, so without this
        // the unsupported-topology check inside gitSnapshot would be skipped
        // and the relay would launch before the after-snapshot throws.
        // Throwing here takes the guard-collection catch below, which falls
        // through to a fresh gitSnapshot(cwd) that re-throws the same
        // topology error before spawn.
        assertSupportedTopology(cwd);
        console.log(`[snapshot-reuse] snapshot reused (${decision.reason})`);
        return cached.snapshot;
      }
      console.log(`[snapshot-reuse] fresh snapshot: ${decision.reason}`);
    }catch(error){
      console.log(`[snapshot-reuse] fresh snapshot: guard collection failed (${error?.message||error})`);
    }
    return gitSnapshot(cwd);
  })();
  // Mission 093 Part 1 task 2.3: wall-clock time of the before-snapshot
  // above. Persisted to status.json now (the onStart re-init below carries
  // it forward, so the full rewrite there cannot wipe it).
  const snapshotBeforeAt=now();
  try{ updateRunSnapshots(dir,{snapshotBeforeStartedAt,snapshotBeforeAt}); }catch{}

  const started=now();
  // Task 15.6K: the relay's effective repository is authoritative for
  // PWD/INIT_CWD on EVERY role invocation — not only for disposable
  // reviewers. OpenCode resolves relative tool paths against the PWD
  // environment variable, not only the child process cwd, so a launcher-
  // inherited PWD/INIT_CWD pointing anywhere else (e.g. the directory `ap
  // run --repo <target>` was launched from) once redirected a real
  // deliverable outside the target. Planner/Implementer therefore observe
  // PWD/INIT_CWD == the official repository (their cwd and REPOSITORY
  // value are already effectiveCwd above); disposable reviewers observe
  // PWD/INIT_CWD == the disposable copy, never the official repository.
  // The WSL/Linux envelope path then maps both into /workspace/repository
  // (execution-envelope.mjs's mapEnvironmentIntoEnvelope forces PWD and
  // INIT_CWD to the sandbox repository), so no host path is ever exposed
  // inside the sandbox. This override changes no guard, allowlist, scope,
  // workspace, Playwright, ordering, or schema behavior.
  // Task 15.4C3C: the ONLY place the bridged runtime's canonical paths are
  // ever written into anything observable — a plain per-call environment
  // value on the Verifier child. Never Planner/Plan Reviewer/Implementer/
  // Code Reviewer/WSL roles (windowsVerifierPlaywrightBridge.valid is only
  // ever true for a Native Windows disposable Verifier launch), never a
  // repository-local runtime (valid is false whenever the bridge was not
  // applicable), and never persisted to config, mission state, or
  // result.json — this object is discarded once launchEnv is built below.
  const windowsPlaywrightBridgeEnv=windowsVerifierPlaywrightBridge.valid
    ? {AUTOPILOT_PLAYWRIGHT_MODULE_ROOT:windowsVerifierPlaywrightBridge.moduleRoot,PLAYWRIGHT_BROWSERS_PATH:windowsVerifierPlaywrightBridge.browserRoot}
    : {};
  const opencodeRuntimeConfigEnv=opencodeRuntimeConfigOverride(role.adapter,readOnly,attemptEnvelope,executionEnvelope,process.env.OPENCODE_CONFIG_CONTENT);
  const guardedLaunchEnv=guardedEnv(guard, {PWD:effectiveCwd,INIT_CWD:effectiveCwd,...windowsPlaywrightBridgeEnv,...opencodeRuntimeConfigEnv});
  // The real mission launch must call the shared assembler, pass spawnEnv
  // unchanged to the outer spawn, and never independently rebuild the
  // agent environment. There is no provider gateway, so gatewayActive is
  // always false.
  const assembledLaunch=assembleAgentEnvironment({
    guardedEnv: guardedLaunchEnv,
    envelope: executionEnvelope,
    repo: effectiveCwd,
    scratchDir: effectiveScratchDir,
    adapterRoleScratchExists: false,
    gatewayActive: false
  });
  // Backlog #79: opencode (bun) extracts native libraries to /tmp on every
  // launch and never deletes them; on a small tmpfs this fills the disk and
  // the gate dies with ENOSPC. Best-effort sweep of the stale leftovers right
  // before the opencode child is spawned — never throws, never blocks the
  // launch. Files a live process still has mapped are kept.
  if(role.adapter==="opencode"){
    try{
      const swept=cleanStaleOpencodeLibs();
      if(swept.deleted>0) console.log(`[tmp-so-cleanup] removed ${swept.deleted} stale opencode native lib(s) from /tmp (${(swept.bytes/1048576).toFixed(1)} MB)`);
    }catch{}
  }
  // Mission 001 task 14 (opencode-only): hold the resolved snapshot's
  // shared pin lock for the full sandboxed-process lifetime. Acquired here,
  // immediately before invoking bwrap, released only after the child exits
  // (success, failure, or crash via finally + kernel release). On ENOENT
  // acquiring the pin, re-resolve `current` and retry the resolve-then-pin
  // sequence with a bounded retry count rather than looping forever or
  // proceeding with a stale path. Non-opencode roles never reach this
  // branch (same role.adapter gating as the seeder above).
  let opencodePinHandle=null;
  if(role.adapter==="opencode" && attemptEnvelope && executionEnvelope?.available && executionEnvelope?.sandbox?.sharedCache?.host){
    const MAX_PIN_ATTEMPTS=3;
    for(let pinAttempt=0; pinAttempt<MAX_PIN_ATTEMPTS; pinAttempt+=1){
      let pinTarget=null;
      try{
        pinTarget = pinAttempt===0
          ? fs.realpathSync(executionEnvelope.sandbox.sharedCache.host)
          : fs.realpathSync(path.join(defaultOpenCodeCacheRoot(),"current"));
      }catch(error){
        if(error?.code==="ENOENT" && pinAttempt+1<MAX_PIN_ATTEMPTS) continue;
        break;
      }
      try{
        opencodePinHandle=acquireOpenCodeCachePin(pinTarget);
        if(pinTarget!==executionEnvelope.sandbox.sharedCache.host){
          const argIndex=executionEnvelope.args.indexOf(executionEnvelope.sandbox.sharedCache.host);
          if(argIndex>=0) executionEnvelope.args[argIndex]=pinTarget;
          executionEnvelope.sandbox.sharedCache.host=pinTarget;
          // The per-file rg companion bind baked into bwrapArgs at
          // envelope-build time also references the vanished snapshot, so it
          // must follow the new pin target: repoint its source arg under the
          // new snapshot, or drop the whole --ro-bind triple when the new
          // snapshot ships no rg (the record is nulled either way a bind is
          // removed so it stays consistent with the args).
          const oldRgHost=executionEnvelope.sandbox.sharedCacheRg?.host;
          if(oldRgHost){
            const rgArgIndex=executionEnvelope.args.indexOf(oldRgHost);
            let rgSource=null;
            try{
              const candidate=path.join(pinTarget,"xdg-cache","opencode","bin","rg");
              if(fs.existsSync(candidate)) rgSource=fs.realpathSync(candidate);
            }catch{
              rgSource=null;
            }
            if(rgSource && rgArgIndex>=0){
              executionEnvelope.args[rgArgIndex]=rgSource;
              executionEnvelope.sandbox.sharedCacheRg.host=rgSource;
            }else if(rgArgIndex>=0 && executionEnvelope.args[rgArgIndex-1]==="--ro-bind"){
              executionEnvelope.args.splice(rgArgIndex-1,3);
              executionEnvelope.sandbox.sharedCacheRg=null;
            }else{
              executionEnvelope.sandbox.sharedCacheRg=null;
            }
          }
        }
        break;
      }catch(error){
        if(error?.code==="ENOENT" && pinAttempt+1<MAX_PIN_ATTEMPTS) continue;
        opencodePinHandle=null;
        break;
      }
    }
  }
  const launchEnv=assembledLaunch.spawnEnv;
  const launchBinary=executionEnvelope?.available?executionEnvelope.binary:missionTransport.invocation.binary;
  const launchArgs=executionEnvelope?.available?executionEnvelope.args:missionTransport.invocation.args;
  const launchCwd=executionEnvelope?.available?executionEnvelope.cwd:effectiveCwd;
  // A relay call previously had no deadline anywhere in this path: a hung
  // or pathologically slow adapter CLI (e.g. one forced to re-scan an
  // un-ignored, ever-growing .autopilot/ scratch tree on every git call)
  // could only ever be recovered by a human finding and killing the process
  // tree by hand. relay_timeout_ms (config policy.*, unvalidated/optional
  // like the rest of policy.*) lets a project raise or lower this; the
  // default is deliberately generous — long enough for genuine high-effort
  // review work, which has been observed taking 35+ minutes legitimately —
  // so this is a backstop against real hangs, not a budget for normal runs.
  const configuredRelayTimeoutMs=Number(c.policy?.relay_timeout_ms)>0?Number(c.policy.relay_timeout_ms):RELAY_TIMEOUT_DEFAULT_MS;
  // TASK-19 Phase 5 task 14: a per-task call site may pass its own bounded
  // deadline (policy.per_task_timeout_ms), which is strictly below the relay
  // backstop by config validation, so the intentional per-task deadline fires
  // before the generic hang backstop.
  const relayTimeoutMs=Number(timeoutMs)>0?Number(timeoutMs):configuredRelayTimeoutMs;
  // Backlog #41 (TASK-35): idle-hang watchdog limit for THIS invocation —
  // resolved against the actual session bound (relayTimeoutMs: the per-task
  // deadline for task calls, the relay backstop otherwise), 0 = off. This
  // is the SINGLE shared site for both loops (standalone SpecKit funnel
  // every role through runRelay), so the twin-loop rule is satisfied by
  // construction — no per-loop wiring exists or is needed.
  const idleHangMs=resolveIdleHangMs(c.policy, relayTimeoutMs);
  const firstOutputMs=resolveFirstOutputMs(c.policy, idleHangMs);
  // Backlog #104: absolute silence cap for read-only roles (a tool child no longer suspends it).
  const maxSilenceMs=readOnly?resolveMaxSilenceMs(c.policy, idleHangMs, relayTimeoutMs):0;
  // Backlog #41 (TASK-35): adapter chain marker for the descendant scan.
  // A descendant whose command line contains this is the adapter's own
  // launcher (a Windows .cmd trampoline, a shim script) rather than a
  // tool/command process — see idle-hang-watchdog.mjs. Computed from the
  // actual launch binary/args (never the adapter id: a node-launched
  // adapter must match its script, not "node", which every tool shares).
  const idleAdapterMarkers=(()=>{
    try{
      // Backlog #104: a sandboxed launch (bwrap/docker) wraps the adapter, so
      // the real adapter process inside is also a launcher, never tool work.
      const markers=[adapterMarkerFor(launchBinary, launchArgs)];
      if(missionTransport?.invocation?.binary) markers.push(adapterMarkerFor(missionTransport.invocation.binary, missionTransport.invocation.args));
      return [...new Set(markers.filter(Boolean))];
    }catch{ return []; }
  })();
  // Backlog #41 (TASK-35): host-visible base dir for the opencode log tail.
  // Implementer sessions bind the adapter data dir to the per-task session
  // store, so <hostDir>/log/opencode.log mirrors the sandboxed
  // $HOME/.local/share/opencode/log/. Other roles have no bind, so fall
  // back best-effort to the operator's real HOME XDG dir (read-only tail;
  // offset- AND timestamp-baselined to this session, so other sessions'
  // history never counts). Null = log tail unavailable for this session
  // (the stderr fast path + the idle watchdog still apply).
  // Backlog #36: privacy travels with the base. The bound store is private
  // to this session (its unattributed lines are ours); the real-HOME
  // fallback is shared with every opencode session on the machine, so the
  // watch only counts lines carrying this session's own id there (captured
  // live from its stdout events in onChunk below).
  const opencodeLogFallbackBase=(()=>{
    if(role.adapter!=="opencode") return null;
    try{
      const home=process.env.HOME||process.env.USERPROFILE||null;
      if(home){ const candidate=path.join(home,".local","share","opencode"); if(fs.existsSync(candidate)) return candidate; }
    }catch{}
    return null;
  })();
  const {base: opencodeLogBase, priv: opencodeLogPrivate} = (()=>{
    if(role.adapter!=="opencode") return {base: null, priv: false};
    if(roleName==="implementer" && mission && taskRef){
      try{ const hostDir=sessionStoreHostDir(mission,taskRef); if(hostDir) return {base: hostDir, priv: true}; }catch{}
    }
    try{
      const home=process.env.HOME||process.env.USERPROFILE||null;
      if(home){
        const candidate=path.join(home,".local","share","opencode");
        if(fs.existsSync(candidate)) return {base: candidate, priv: false};
      }
    }catch{}
    return {base: null, priv: false};
  })();
  // Backlog 003#15 (token ceiling) + 003#16 (turn cap): mid-stream cap
  // monitor. Once per second the accumulated stream is re-decoded with the
  // driver's own decodeEvents and summed with accumulateUsage(); recompute-
  // from-scratch every tick means a truncated tail line can never double-
  // count (it decodes as unparsed_stdout until complete). On breach the
  // child is killed exactly like the deadline path (SIGTERM, SIGKILL after
  // 5s) and capBreach records the reason for the post-spawn continuation
  // path below. Unmeasurable adapters (codex: usage null, never zero) stay on
  // the deadline alone — an absent measurement must never read as "under the
  // cap". All hook bodies are exception-proof: a
  // counting failure must degrade to deadline-only, never break the relay.
  // Scoped to the Implementer only (found live 2026-09-23 via a cap-breach
  // test mission): runRelay() is shared by every role, but result.capped is
  // only ever consumed by the Implementer's two per-task loops
  // (runStandaloneImplementation / runImplementation). A planner,
  // plan_reviewer, code_reviewer, or verifier call that tripped the same
  // monitor had no continuation/rollover handling to catch it — it just
  // died as a generic PROCESS_EXIT_NONZERO adapter failure, consuming
  // adapterRetryBudget instead of the dedicated continuation ledger, with
  // no dead-ends transfer. Disabling capDriver for every other role turns
  // the monitor off at the source rather than leaving a breach for a call
  // site that cannot act on it.
  const roleCaps=resolvePerRoleLimits(roleName,c.policy,{adapter:role.adapter,model:role.model,free_model_pattern:a?.free_model_pattern});
  // Backlog #26 Step B: fixed-token wrap-up threshold (same raw growing
  // term the cap measures — `growingTerm()` — never the price-weighted
  // figure). Review roles in PER_ROLE_WRAPUP_TOKENS_DEFAULT (planner,
  // plan_reviewer, code_reviewer, verifier) wrap up at their per-role
  // roleCaps.wrapUpTokenThreshold (450K, planner 950K — ~one turn of
  // headroom below their own cap); implementer/unknown roles keep the
  // global policy.handoff_wrapup_tokens via resolveHandoffWrapupTokens
  // (default 690K, ~one turn of headroom below the 750K cap).
  const wrapupTokens=Object.hasOwn(PER_ROLE_WRAPUP_TOKENS_DEFAULT,String(roleName ?? "").toLowerCase())
    ? roleCaps.wrapUpTokenThreshold
    : resolveHandoffWrapupTokens(c.policy,roleCaps.perTaskMaxTokens);
  // The wrap-up turn itself is exempt from the per-task cap (it must not
  // trip it) but carries its own ceiling (WRAPUP_MAX_TURNS + WRAPUP_TIMEOUT_MS).
  const capDriver=(!isWrapUp && capEnabled)?adapterDriver(role.adapter):null;
  const wrapupCeilingDriver=(isWrapUp && capEnabled)?adapterDriver(role.adapter):null;
  // TASK-27 follow-up (003#8): live usage totals for every role with a
  // usage-capable driver. usageDriver is deliberately NOT gated on the role
  // name — only the cap check below stays implementer-only (see the comment
  // above: no other role can act on a breach).
  const usageDriver=adapterDriver(role.adapter);
  let capStdout="",capStderr="",capPid=null,capBreach=null,capSettled=false,capTimer=null,capKillTimer=null;
  // Backlog #34d (mission 027 Phase 3 task 3.2): end-of-task grace window
  // state. Null = no window opened this generation (one window per
  // generation); once granted, {turnCeiling, tokenCeiling} bounds the
  // deferred kill while the session finishes within bounds.
  let capGraceWindow=null;
  // Backlog #41 (TASK-35): idle-hang watchdog state. Same lifecycle as the
  // cap monitor (armed in onStart, cleared in finally): idleWatch is the
  // per-session watch (null = watchdog off for this session), idleBreach
  // records the trip for the post-spawn classification below.
  let idleWatch=null,idleBreach=null,idleKillTimer=null;
  const clearCapTimers=()=>{
    if(capTimer){clearInterval(capTimer);capTimer=null;}
    if(capKillTimer){clearTimeout(capKillTimer);capKillTimer=null;}
    if(idleKillTimer){clearTimeout(idleKillTimer);idleKillTimer=null;}
  };
  const evaluateCaps=()=>{
    if(capSettled||capBreach) return;
    if(!usageDriver||typeof usageDriver.decodeEvents!=="function") return;
    let capEvents=null;
    try{ capEvents=usageDriver.decodeEvents(capStdout,capStderr); }catch{ return; }
    // Mission 093 Part 1 task 2.2: persist the stream-reported model as soon
    // as it resolves (a no-op before the first model signal). Runs before
    // the usage early-return below so a model signal without a usage signal
    // still records. Exception-proof like every other hook body here.
    try{ recordRunModel(dir,role.adapter,capEvents,configuredModel); }catch{}
    try{ updateSummaryForRunDir(dir); }catch{}
    let usage=null;
    try{ usage=accumulateUsage(role.adapter,capEvents); }catch{ return; }
    if(!usage) return;
    // TASK-27: live per-invocation totals — the usage decoded above already
    // flows through here every second, so pass it to the cadenced persist
    // (zero new decoding, zero new timers). Null usage never reaches this
    // line (early return above), so driverless adapters stay unmeasured.
    // Best-effort watch refresh on the same tick; a watch write must never
    // break a run.
    if(updateRunUsage(dir,usage)){ try{ refreshWatchReport(s); }catch{} }
    // Cap enforcement stays implementer-only: a breach kill (SIGTERM, then
    // SIGKILL) and result.capped must never touch any other role, which has
    // no continuation handling to catch it. The wrap-up turn (isWrapUp) is
    // exempt from the per-task cap but bounded by its own ceiling
    // (WRAPUP_MAX_TURNS); it never triggers another wrap-up.
    if(isWrapUp){
      if(wrapupCeilingDriver && Number.isInteger(usage.turns) && usage.turns>WRAPUP_MAX_TURNS){
        capBreach={type:"turns",used:usage.turns,limit:WRAPUP_MAX_TURNS,usage,wrapUp:false};
      }
    } else {
      if(!capDriver) return;
      // Backlog #26 Step B: the FIXED TOKEN wrap-up threshold fires FIRST
      // (same raw growing term `checkCapBreach` measures — cacheRead +
      // input, never price-weighted). A light session that hits the turn
      // cap before 690K trips the turn branch instead — the turn-cap breach
      // itself is the wrap-up trigger (the wrap-up turn is cap-exempt, so
      // there is still room to write). Either way the session stops for a
      // wrap-up turn (capped + wrapUp:true + trigger); the hard cap below
      // only fires when the growing term jumps past both between ticks.
      const wrap=checkWrapupTrigger({usage,perTaskMaxTurns:roleCaps.perTaskMaxTurns,perTaskMaxTokens:roleCaps.perTaskMaxTokens,wrapupTokens});
      const breach=checkCapBreach({usage,perTaskMaxTurns:roleCaps.perTaskMaxTurns,perTaskMaxTokens:roleCaps.perTaskMaxTokens});
      const pending=wrap ?? breach;
      if(pending){
        // Backlog #34d (mission 027 Phase 3 task 3.2): end-of-task grace
        // window. A breach (wrap-up trigger OR hard cap) while the session
        // is demonstrably finishing (linked verify passed or final task-result
        // line being written) defers the kill AND the capped marker while
        // usage stays within the granted ceilings; past the ceilings it caps
        // exactly as today. Non-finishing breaches cap immediately. The
        // grace gate applies to BOTH wrap-up and hard-cap paths. Non-
        // implementer roles never reach here (!capDriver return above). Any
        // grace failure degrades to the immediate cap below.
        let graceDeferred=false;
        try{
          // Decode events for grace evidence (separate from usage decode)
          let capEvents=null;
          try{ capEvents=usageDriver.decodeEvents(capStdout,capStderr); }catch{}
          if(capGraceWindow){
            const graceTurns=usage.turns;
            const graceGrowing=growingTerm(usage);
            const withinTurns=Number.isInteger(graceTurns) && Number.isInteger(capGraceWindow.turnCeiling) && graceTurns<=capGraceWindow.turnCeiling;
            const withinTokens=Number.isFinite(graceGrowing) && Number.isFinite(capGraceWindow.tokenCeiling) && graceGrowing<=capGraceWindow.tokenCeiling;
            if(withinTurns && withinTokens){
              try{ observe(dir,{stream:"stdout",bytes:0,minIntervalMs:0,last:`GRACE_WINDOW | TYPE=${pending.type} | USED=${pending.used} | LIMIT=${pending.limit} | TURNS=${graceTurns} | GROWING=${graceGrowing}`}); }catch{}
              graceDeferred=true;
            }
          }else if(capEvents){
            const graceEvidence=capGraceFinishingEvidence(capEvents);
            const graceDecision=evaluateCapGraceWindow({verifyPassed:graceEvidence.verifyPassed,writingFinalResult:graceEvidence.writingFinalResult,graceUsed:false,turnsUsed:usage.turns,perTaskMaxTurns:roleCaps.perTaskMaxTurns,tokensUsed:growingTerm(usage),perTaskMaxTokens:roleCaps.perTaskMaxTokens});
            if(graceDecision.granted){
              capGraceWindow={turnCeiling:graceDecision.turnCeiling,tokenCeiling:graceDecision.tokenCeiling};
              try{ observe(dir,{stream:"stdout",bytes:0,minIntervalMs:0,last:`GRACE_WINDOW | TYPE=${pending.type} | USED=${pending.used} | LIMIT=${pending.limit} | TURN_CEILING=${graceDecision.turnCeiling} | TOKEN_CEILING=${graceDecision.tokenCeiling}`}); }catch{}
              graceDeferred=true;
            }
          }
        }catch{}
        if(graceDeferred) return;
        capBreach={type:pending.type,used:pending.used,limit:pending.limit,usage,wrapUp:true,trigger:pending.type};
        }
        // Mission 047 Phase 1 task 1.2: cumulative raw-token backstop, BEHIND
        // the existing cap checks (wrap-up trigger + hard cap above): a
        // session that stays small every turn (never tripping the per-turn
        // maxSingleTurnContext ceiling) but burns tokens without bound still
        // stops. Same raw cumulative measure the helpers define (input +
        // cacheRead + cacheCreation + output via evaluateBackstopBreach, never
        // the price-weighted figure), same stop mechanism as the cap path
        // (wrapUp:true rides the orchestrator fallback-note path below; the
        // per-task loop rolls over on the separate backstop firing ledger,
        // never the continuation allowance). No grace deferral: a backstop
        // firing is a runaway verdict, not a finishing session.
        // Exception-proof like the grace gate above.
        if(!capBreach){
          try{
            const backstopLimit=resolveBackstopRawTokens(c.policy,roleName);
            const backstopEval=evaluateBackstopBreach({usage,limit:backstopLimit});
            if(backstopEval.breached) capBreach={type:"backstop",used:backstopEval.total,limit:backstopEval.limit,usage,wrapUp:true,trigger:"backstop",backstop:true};
          }catch{}
        }
    }
    if(capBreach&&capPid!=null){
      try{ process.kill(capPid,"SIGTERM"); }catch{}
      capKillTimer=setTimeout(()=>{ if(!capSettled&&capPid!=null){ try{ process.kill(capPid,"SIGKILL"); }catch{} } },5000);
    }
  };
  // Backlog #41 (TASK-35): idle-hang watchdog + opencode rate-limit trip,
  // evaluated on the same 1s tick as the cap monitor (same lifecycle: the
  // interval is armed in onStart and cleared in finally, so a trip can
  // never touch a reused pid — capSettled guards both kills). The watch
  // itself decides when the expensive checks run: repo/process scans happen
  // only after output has already been quiet for the full idleHangMs, so
  // an active session pays ~nothing here. On a trip the child is killed
  // EXACTLY like the cap/deadline path (SIGTERM, SIGKILL after 5s — same
  // grace constant family, no second kill mechanism) and idleBreach carries
  // the verdict to the post-spawn classification below. Yields to an
  // earlier cap breach (the cap path owns that kill); every hook body is
  // exception-proof like evaluateCaps.
  const evaluateIdle=()=>{
    if(capSettled||capBreach||idleBreach) return;
    if(!idleWatch) return;
    let verdict=null;
    try{ verdict=evaluateIdleWatch(idleWatch); }catch{ return; }
    if(!verdict||verdict.status==="ok") return;
    if(verdict.status==="hung") idleBreach={kind:"hung",idleMs:verdict.idleMs,noOutput:verdict.noOutput===true};
    else if(verdict.status==="rate_limited") idleBreach={kind:"rate_limited",provider:verdict.provider||null,model:verdict.model||null};
    else return;
    if(capPid!=null){
      try{ process.kill(capPid,"SIGTERM"); }catch{}
      idleKillTimer=setTimeout(()=>{ if(!capSettled&&capPid!=null){ try{ process.kill(capPid,"SIGKILL"); }catch{} } },IDLE_HANG_KILL_GRACE_MS);
    }
  };
  // Observability must reflect the child actually running, not just having
  // finished: onStart/onChunk fire live off spawnRelayChild's own spawn/data
  // events (it already reads stdout/stderr incrementally, see that file's
  // docblock) instead of waiting for the blocking await below to resolve —
  // otherwise status.json/WATCH-REPORT only ever show a run that has
  // already completed, for however long the child actually takes to run.
  let p;
  try{
    p=await spawnRelayChild({
      binary:launchBinary,
      args:launchArgs,
      cwd:launchCwd,
      env:launchEnv,
      stdinData:missionTransport.stdin,
      // Stdin-only transports must have stdin written: argv-prompt drivers
      // (transportPrompt) skip the write, and agy — which has no
      // transportPrompt and frames its prompt as a stream-json user event
      // via its encoder — must receive that line or the run starts with no
      // task at all.
      writeStdin:!(adapterDriver(role.adapter)?.transportPrompt)||Boolean(adapterDriver(role.adapter)?.encodeStdin),
      timeoutMs:relayTimeoutMs,
      onStart:({pid})=>{
        initRun(dir,{pid,role:roleName,runId:id,...meta,configuredModel,resolvedModel:null,modelMismatch:null,sessionNumber,snapshotBeforeStartedAt,snapshotBeforeAt,snapshotAfterStartedAt:null,snapshotAfterAt:null,planRevision:planRevisionValue,carriedForwardTasks:carriedForwardTasksValue});
        setImmediate(()=>{ try{ throttledWatchRefresh(s); }catch{} });
        capPid=(typeof pid==="number"&&pid>0)?pid:null;
        activeChildPid=(typeof pid==="number"&&pid>0)?pid:null;
        // Backlog #41: arm the idle watchdog — file-mtime + log-offset
        // baselines are taken NOW so only this session's activity counts.
        // Synchronous by necessity (every later tick compares against this
        // baseline); wrapped so an unreadable tree degrades to
        // watchdog-off, never relay-broken. A null pid (spawn failure)
        // also means off — start errors surface through PROCESS_START_FAILED.
        try{
          idleWatch=(idleHangMs>0 && typeof pid==="number" && pid>0)?createIdleWatch({idleHangMs,firstOutputMs,maxSilenceMs,pid,adapter:role.adapter,adapterMarkers:idleAdapterMarkers,repoRoot:effectiveCwd,scratchDir:effectiveScratchDir,opencodeLogBase,opencodeLogFallbackBase,logPrivate:opencodeLogPrivate}):null;
        }catch{ idleWatch=null; }
        clearCapTimers();
        capTimer=setInterval(()=>{ try{ evaluateCaps(); }catch{} try{ evaluateIdle(); }catch{} },1000);
      },
      onChunk:({stream,chunk})=>{
        observe(dir,{stream,bytes:Buffer.byteLength(chunk),last:chunk});
        throttledWatchRefresh(s);
        try{ if(stream==="stdout") capStdout+=chunk; else capStderr+=chunk; }catch{}
        // Backlog #41: every chunk resets the idle clock (and clears a
        // pending unconfirmed rate-limit suspicion — output is progress).
        // opencode stderr additionally feeds the rate-limit fast path.
        // Backlog #36: opencode stdout additionally feeds the session-id
        // capture (first sessionID event wins) that scopes the shared-HOME
        // log tail to this session. Skipped once known: chunks can be
        // large and the id is stable for the session.
        try{
          if(idleWatch){
            if(role.adapter==="opencode"&&stream==="stdout") noteIdleStdoutChunk(idleWatch,String(chunk));
            else noteIdleOutput(idleWatch);
            if(role.adapter==="opencode"&&stream==="stderr") noteIdleStderrText(idleWatch,String(chunk));
            if(role.adapter==="opencode"&&stream==="stdout"&&!idleWatch.sessionId){
              const sid=extractSessionIdFromChunk(String(chunk));
              if(sid) noteIdleSessionId(idleWatch,sid);
            }
          }
        }catch{}
      }
    });
  }finally{
    // Backlog 003#15: settle the cap monitor first — a SIGKILL escalation
    // landing after the child already closed must never touch a reused pid.
    capSettled=true;
    clearCapTimers();
    activeChildPid=null;
    if(opencodePinHandle){
      try{ releaseOpenCodeCachePin(opencodePinHandle); }catch{}
      opencodePinHandle=null;
    }
  }
  const finished=now();
  const out=((p.stdout||"")+"\n"+(p.stderr||"")).trim();
  write(path.join(dir,"stdout.log"),out);
  const driver=adapterDriver(role.adapter);
  const events=driver?driver.decodeEvents(p.stdout,p.stderr):[];
  const normalizedOutput=driver?finalAgentText(events,out):out;
  // Backlog #22: what-did-this-session-actually-do digest from the DECODED
  // events (never raw bytes). A capped session is usually killed mid-tool-
  // calls with no text event, so finalAgentText falls back to raw NDJSON and
  // the old handoff carried a JSON-event tail. The digest rides the relay
  // result as workDigest; finalMessage semantics are unchanged for every
  // other consumer.
  const workDigest=driver?sessionWorkDigest(role.adapter,events,{maxChars:resolveHandoffMaxChars(c.policy),repoRoot:cwd}):"";
  const observations=driver?driver.observe(events,{readPath:"",productionWritePath:"",outsideWritePath:""}):[];
  // Absent (not zero) when the adapter/event stream carries no per-turn
  // usage signal -- see accumulateUsage()'s own docblock.
  const usage=driver?accumulateUsage(role.adapter,events):null;
  // Mission 093 Part 1 task 2.2: final model resolution from the complete
  // decoded stream (the live tick may have missed the terminal signal).
  // runModelPatch is pure; the persist lands on status.json below.
  let modelResolution=null;
  try{ modelResolution=runModelPatch(role.adapter,events,configuredModel); }catch{ modelResolution=null; }
  const snapshotAfterStartedAt=now();
  const after=gitSnapshot(cwd);
  // Mission 093 Part 1 task 2.3: wall-clock time of the after-snapshot
  // above. Persisted to status.json now so finalizeRun's merge below keeps
  // it; the same value rides result.json via makeRelayResult.
  const snapshotAfterAt=now();
  try{ updateRunSnapshots(dir,{snapshotAfterStartedAt,snapshotAfterAt}); }catch{}
  const reviewContract=review?parseReviewContract(normalizedOutput):null;
  // Session id from the raw events first (precise, adapter-native); a
  // driver-less adapter has no structured events to scan, so its only
  // option is the regex fallback over the full raw output.
  const sessionId=sessionIdFromEvents(events)||(driver?null:sessionFromOutput(out));
  const result=makeRelayResult({roleName,role,a,p,args:missionTransport.invocation.args,invocationVerification,output:normalizedOutput,sessionId,before,after,guard,started,finished,reviewContract,cwd,readOnly,observations,envelopeApplied:executionEnvelope?.available===true,usage,resolvedBinary:missionTransport.invocation.binary,modelResolution,snapshotBeforeStartedAt,snapshotBeforeAt,snapshotAfterStartedAt,snapshotAfterAt,sessionNumber,planRevision:planRevisionValue,carriedForwardTasks:carriedForwardTasksValue});
  // Mission 084 Phase 2 task 2.2 — snapshot reuse cache after-site: store
  // the fresh after-snapshot only on clean relays. A policy violation or
  // read-only breach clears the cache with a logged reason and stores
  // nothing (scenario g), so the next relay takes fresh.
  try{
    if(result.policyViolation||result.readOnlyViolation||result.policy?.violation){
      const violationReason=result.policyViolation||result.policy?.violation||"read-only breach";
      clearSnapshotReuseCache(`previous policy violation (${violationReason})`);
      console.log(`[snapshot-reuse] cache cleared: previous policy violation (${violationReason})`);
    }else{
      setCachedSnapshot(getSnapshotCacheKey(cwd),makeCacheEntry(cwd,after));
      console.log(`[snapshot-reuse] cached after-snapshot`);
    }
  }catch(error){
    console.log(`[snapshot-reuse] cache store skipped (${error?.message||error})`);
  }
  // TASK-39: when guard blocks were downgraded to a fixture-repo warning,
  // surface it: state flag drives the WATCH-REPORT line and the next
  // write-role brief line.
  if(result.policy?.fixtureGitBlocksOnlyUnproven){
    s.fixtureGitBlockWarning=true;
    s.fixtureGitBlockWarningPhaseIndex=typeof s.phaseIndex==="number"?s.phaseIndex:null;
  }
  // Backlog #14(b): a blocked git command that mutated nothing is a warning,
  // never an escalation. Record it on the mission state (WATCH-REPORT line)
  // and show it in the log; result.json already carries gitGuardWarning.
  if(result.policy?.blockedNoMutation){
    const warning=result.gitGuardWarning||{kind:"git_guard_blocked_no_mutation",count:result.gitGuardEvents?.length||0,subcommands:[]};
    s.gitGuardWarning={...warning,at:new Date().toISOString()};
    const names=warning.subcommands?.length?` (${warning.subcommands.join(", ")})`:"";
    console.warn(`[git-guard] blocked ${warning.count} git command(s)${names} but the repository is unchanged — recorded as a warning, not a policy violation.`);
  }
  // Backlog #22: decoded-events digest for the rollover handoff (cap sites
  // below). Plain property — result.json carries it, finalMessage untouched.
  result.workDigest=workDigest;
  // Mission 093 Part 1 task 2.2: persist the final stream-resolved model to
  // status.json (no-op before the first model signal; the live tick usually
  // already recorded it). The legacy `model` field is untouched.
  try{ recordRunModel(dir,role.adapter,events,configuredModel); }catch{}
  try{ updateSummaryForRunDir(dir); }catch{}
  if(idleBreach){
    // Backlog #41 (TASK-35): the watchdog killed this child (SIGTERM, then
    // SIGKILL after 5s — the same pattern as the cap/deadline kill, no
    // second kill mechanism). The SIGTERM exit would otherwise misclassify
    // as an adapter PROCESS_EXIT_NONZERO, so the watchdog verdict
    // OVERRIDES the observed failure: IDLE_HANG (new class,
    // infrastructure + retryable, flows into infrastructureRetryBudget
    // through the normal recordAttemptFailure path exactly like TIMEOUT
    // does) or RATE_LIMITED (existing class, infrastructure +
    // non-retryable, escalates immediately without consuming the budget). result.status
    // keeps the true terminal state (failed); the run record carries the
    // marker (IDLE_HANG/RATE_LIMITED observe line) like CAP_BREACH does.
    if(idleBreach.kind==="hung"){
      const idleMessage=formatIdleHangMessage({role:roleName,adapter:role.adapter,model:role.model||null,idleMs:idleBreach.idleMs,maxSilence:idleBreach.maxSilence===true});
      result.idleHang={kind:"hung",idleMs:idleBreach.idleMs,noOutput:idleBreach.noOutput===true,maxSilence:idleBreach.maxSilence===true,message:idleMessage};
      result.failure=failure("IDLE_HANG","infrastructure",true,[{source:"relay",message:idleMessage,role:roleName,adapter:role.adapter,model:role.model||null,idleMs:idleBreach.idleMs}]);
      try{ observe(dir,{stream:"stdout",bytes:0,minIntervalMs:0,last:`IDLE_HANG | ROLE=${roleName} | ADAPTER=${role.adapter} | IDLE_MS=${idleBreach.idleMs}`}); }catch{}
    }else{
      const rateMessage=formatRateLimitedMessage({role:roleName,adapter:role.adapter,model:role.model||null,provider:idleBreach.provider});
      result.idleHang={kind:"rate_limited",provider:idleBreach.provider||null,model:idleBreach.model||null,message:rateMessage};
      result.failure=failure("RATE_LIMITED","infrastructure",false,[{source:"relay",message:rateMessage,role:roleName,adapter:role.adapter,model:idleBreach.model||role.model||null,provider:idleBreach.provider||null}]);
      try{ observe(dir,{stream:"stdout",bytes:0,minIntervalMs:0,last:`RATE_LIMITED | ROLE=${roleName} | ADAPTER=${role.adapter} | PROVIDER=${idleBreach.provider||role.adapter}`}); }catch{}
    }
  }
  // Mission 087 task 2.1: single per-role fallback choke point. runRelay is
  // reached by relay() (:2307-area) and relayAsync (:5831-area), so every
  // caller — including escalateIfRateLimited (planning-review-wiring.mjs)
  // and enforceAttemptFailure — is covered with no per-path hooks. On a
  // RATE_LIMITED result the Phase 1 module is consulted BEFORE any
  // escalation: a "switch" decision pins s.activeRoleModels[role] to the
  // next fallback so the NEXT run of this role launches the fallback
  // effective model (the current result keeps today's shape plus a
  // fallbackSwitch marker; the at-once re-run below returns the retry's
  // result). Exhausted and
  // non-RATE_LIMITED decisions leave state and behavior exactly as before.
  if(result?.failure?.class==="RATE_LIMITED"||result?.failure?.class==="PROVIDER_ERROR"||(result?.failure?.class==="IDLE_HANG"&&result?.idleHang?.noOutput===true)){
    if(escalated){
      // Pending #22: the escalation model itself failed. The normal fallback
      // chain is untouched (the normal model never failed): drop the pending
      // escalation and re-run once on the normal effective model.
      try{
        if(s.escalationPending){ const rest={...s.escalationPending}; delete rest[roleName]; if(Object.keys(rest).length) s.escalationPending=rest; else delete s.escalationPending; }
        const normal=resolveEffectiveRoleModel(rawRole,s.activeRoleModels?.[roleName]??null);
        console.log(`escalation model ${role.model||"?"} failed (${result.failure.class}) — continuing on ${normal?.model||"the normal model"}`);
        result.escalationFailed=true;
        if(persistState){ try{ saveState(s); }catch{} }
      }catch{}
    }else
    try{
      const from={adapter:role.adapter,model:role.model,reasoning:role.reasoning,variant:role.variant};
      // Backlog #18: record the RATE_LIMITED model mission-wide (same place
      // as the per-role tried list) so every other role skips it too.
      if(result.failure.class==="RATE_LIMITED") s.exhaustedModels=markExhausted(s.exhaustedModels,from,roleName,now());
      let decision=decideRoleFallback({role:roleName,roleConfig:c.roles?.[roleName]??null,activeModel:s.activeRoleModels?.[roleName]??null,failureClass:result.failure.class,noOutput:result?.idleHang?.noOutput===true,exhausted:s.exhaustedModels,policy:c.policy,nowMs:Date.now()});
      s.triedFreeModels=markTriedFreeModel(s.triedFreeModels,roleName,from);
      decision=await extendFallbackWithFree({decision,role:roleName,roleConfig:c.roles?.[roleName]??null,activeModel:s.activeRoleModels?.[roleName]??null,failureClass:result.failure.class,noOutput:result?.idleHang?.noOutput===true,tried:s.triedFreeModels?.[roleName]??[],enabled:c.freeModelAutoFallback!==false,adapters:agents,discover:(a)=>agents[a]?discoverModelCatalog(agents[a]):[],exhausted:s.exhaustedModels,policy:c.policy,nowMs:Date.now()});
      if(decision?.action==="switch"&&decision.next){
        s.activeRoleModels={...(s.activeRoleModels||{}),[roleName]:stampStickyFallback(decision.next,c.roles?.[roleName]??null,now())};
        console.log(formatRoleFallbackLog({role:roleName,from,to:decision.next,reason:decision.autoDiscovered?`${result.failure.class}, auto-discovered free model`:result.failure.class}));
        result.fallbackSwitch={from,to:decision.next,reason:decision.reason};
        if(persistState){ try{ saveState(s); }catch{} }
      }else if(decision?.action==="escalate"&&Array.isArray(result.failure.evidence)){
        // Backlog #106: tell the escalation text that fallbacks were tried and are used up.
        result.failure.evidence=[...result.failure.evidence,{source:"role-fallback",fallbacksExhausted:true}];
      }
    }catch{}
  }
  if(capBreach){
    // Backlog 003#15 (ceiling) + 003#17 (continuation): the monitor killed
    // this child for a cap breach. Record it on the result for the
    // per-task continuation path; the per-task loop checks `capped` first
    // and never lets a breach reach the failure budgets. finalizeRun below
    // still records the true terminal status, so the run history stays
    // truthful (failed/killed + capped marker, never a silent PASS).
    // Backlog #26 Step B: `wrapUp:true` + `trigger` mark a breach stopped
    // for the forced hand-off note (fixed 690K token threshold or the turn
    // cap, whichever first). Cap/wrap-up figures are RAW growing-term
    // tokens (cacheRead + input, the cap's own measure) — never the
    // price-weighted figure the watch PRICE column shows (see CONTEXT).
    result.capped={type:capBreach.type,used:capBreach.used,limit:capBreach.limit};
    if(capBreach.wrapUp) result.capped.wrapUp=true;
    if(capBreach.trigger) result.capped.trigger=capBreach.trigger;
    // Mission 047 Phase 1 task 1.2: carry the backstop marker so the
    // per-task loop can route the rollover to the backstop firing ledger
    // instead of the continuation allowance.
    if(capBreach.backstop) result.capped.backstop=true;
    try{ const __rawTokens=growingTerm(capBreach.usage); observe(dir,{stream:"stdout",bytes:0,minIntervalMs:0,last:`CAP_BREACH | TYPE=${capBreach.type} | USED=${capBreach.used} | LIMIT=${capBreach.limit}${capBreach.wrapUp?" | WRAP_UP=true":""} | RAW_TOKENS=${__rawTokens ?? "-"} (raw maxSingleTurnContext)`}); }catch{}
  }
  // Backlog #26 Step B (TASK-34) + mission 045: orchestrator-forced hand-off
  // note. The capped session is stopped above with `capped.wrapUp:true`; the
  // orchestrator now writes the note ITSELF from the worktree diff and the
  // session work digest — no wrap-up resume turn is spawned (a capped session
  // that could not write its own note is exactly the session least likely to
  // obey a second instruction). A fresh note (Backlog #34c) or an unknown
  // note scope is still recorded as a skip and never retried; every other
  // case (missing/stale/empty note) becomes the orchestrator fallback note.
  if(capEnabled && !isWrapUp && capBreach?.wrapUp && result.capped){
    const wrapMission=mission||s.mission||null;
    const noteRel=(wrapMission && taskRef)?handoffNoteRelPath(wrapMission,taskRef):null;
    const runWrapUp=async()=>{
      // Backlog #34c: fresh-note skip. A note overwritten at a milestone
      // after the last project edit already holds the resume context, so no
      // fallback note is written (recorded, never retried) and rollover
      // continues with the digest only. Stale/missing/empty notes fall
      // through to the orchestrator fallback below. Checked BEFORE the
      // fallback write so a fresh note is never overwritten.
      try{
        if(handoffNoteFreshnessForWrapUp(wrapMission,taskRef)?.fresh)
          return {status:"skipped",reason:"note_fresh",trigger:capBreach.trigger||null};
      }catch{}
      // Mission 049 Phase 1 task 1.2: scratch hand-off note (review/planner
      // roles write under /workspace/scratch, i.e. effectiveScratchDir on the
      // host). Read here — before the disposable workspace is cleaned up
      // below — via the shared 1.1 helpers; a missing note degrades to the
      // orchestrator fallback, never a failure.
      try{
        if(effectiveScratchDir && wrapMission && taskRef){
          let scratchText=null, scratchMtimeMs=null;
          try{
            const scratchAbs=scratchHandoffNotePath(effectiveScratchDir,taskRef);
            scratchText=fs.readFileSync(scratchAbs,"utf8");
            scratchMtimeMs=fs.statSync(scratchAbs).mtimeMs;
          }catch{ scratchText=null; scratchMtimeMs=null; }
          let repoText=null, repoMtimeMs=null;
          try{
            const repoAbs=path.join(repo,handoffNoteRelPath(wrapMission,taskRef));
            repoText=fs.readFileSync(repoAbs,"utf8");
            repoMtimeMs=fs.statSync(repoAbs).mtimeMs;
          }catch{ repoText=null; repoMtimeMs=null; }
          const picked=pickFresherHandoffNote({repoText,repoMtimeMs,scratchText,scratchMtimeMs});
          if(picked && picked.text){
            const scratchFresh=isHandoffNoteFresh({noteText:picked.text,noteMtimeMs:picked.mtimeMs,lastProjectEditMtimeMs:lastProjectEditMtimeMs(repo),nowMs:Date.now()});
            if(scratchFresh?.fresh){
              // The scratch dir lives inside the disposable workspace that
              // cleanupDisposableWorkspace() deletes below, and
              // readHandoffNote() reads the repo note only — so a fresher
              // scratch note must be copied to the repo note path before
              // returning note_fresh, or the next session gets neither note.
              // Best-effort: a failed copy still returns note_fresh (the
              // fallback path below would overwrite a stale repo note anyway).
              try{
                if(picked.source==="scratch" && noteRel){
                  fs.mkdirSync(path.dirname(path.join(repo,noteRel)),{recursive:true});
                  fs.writeFileSync(path.join(repo,noteRel),picked.text);
                }
              }catch{}
              return {status:"skipped",reason:"note_fresh",trigger:capBreach.trigger||null};
            }
          }
        }
      }catch{}
      if(!noteRel) return {status:"skipped",reason:"note_scope_unknown",trigger:capBreach.trigger||null};
      // Backlog #15 part 3b: session-only changes. The before/after
      // snapshots bracket this relay, so touchedFilesBetween() names exactly
      // the files this session changed (including bash writes). Limit the
      // diff stat to those paths and list new untracked files as `+N new`; an
      // empty list means this session changed nothing.
      let sessionPaths=[];
      try{ sessionPaths=touchedFilesBetween(before,after,cwd); }catch{ sessionPaths=[]; }
      let diffStat="";
      try{
        diffStat=sessionPaths.length?changedFilesStat(cwd,{paths:sessionPaths}):"";
      }catch{ diffStat=""; }
      let fallbackNote=null;
      try{ fallbackNote=buildOrchestratorFallbackNote(taskRef,events,role.adapter,repo,diffStat,capBreach,sessionPaths); }catch{}
      if(!fallbackNote) return {status:"failed",reason:"fallback_note_build_failed",trigger:capBreach.trigger||null};
      // Backlog #15 part 2: never destroy a real (model-written) note left by
      // an earlier session of this task. The fallback text stays first and
      // intact; a previous model note is carried below it under the fixed
      // heading, and a previous fallback's own carried model note is carried
      // over once (never nested again). Bounded by the resolved note budget.
      // Best-effort: a read/merge failure leaves the bare fallback in place.
      try{
        let previousNoteText=null;
        try{ previousNoteText=fs.readFileSync(path.join(repo,noteRel),"utf8"); }catch{ previousNoteText=null; }
        fallbackNote=mergeFallbackWithPreviousNote(fallbackNote,previousNoteText,resolveHandoffNoteMaxChars(c.policy));
      }catch{}
      try{
        fs.mkdirSync(path.dirname(path.join(repo,noteRel)),{recursive:true});
        fs.writeFileSync(path.join(repo,noteRel),fallbackNote);
      }catch(error){
        return {status:"failed",reason:`fallback_note_write_failed:${String(error?.message||error).slice(0,200)}`,trigger:capBreach.trigger||null};
      }
      return {status:"orchestrator_fallback",reason:"note_missing_or_stale",trigger:capBreach.trigger||null,note:noteRel,fallbackNote:true};
    };
    try{
      result.wrapUp=await runWrapUp();
    }catch(error){
      result.wrapUp={status:"failed",reason:`wrap_up_error:${String(error?.message||error).slice(0,200)}`,trigger:capBreach.trigger||null};
    }
    // PATH field for the wrap-up progress line: which branch produced this
    // result (fresh-note skip, orchestrator fallback write, or anything else
    // — unknown scope, failed build/write, wrap_up_error — reported as "-").
    try{
      const __wrapPath=result.wrapUp.reason==="note_fresh"?"note_fresh":(result.wrapUp.status==="orchestrator_fallback"?"orchestrator_fallback":"-");
      observe(dir,{stream:"stdout",bytes:0,minIntervalMs:0,last:`WRAP_UP | STATUS=${result.wrapUp.status} | REASON=${result.wrapUp.reason||"-"} | PATH=${__wrapPath} | TRIGGER=${result.wrapUp.trigger||"-"} | RAW_TOKENS=${growingTerm(capBreach?.usage) ?? "-"} (raw maxSingleTurnContext)`});
    }catch{}
    try{ if(persistState) saveState(s); }catch{}
    try{ refreshWatchReport(s); }catch{}
  }
  // Backlog #116: a failed implementer run that already did work leaves the
  // orchestrator hand-off note for the relaunch (same generation: no
  // continuation allowance is touched). Never overwrites a fresh note.
  let failureHandoffText="", failureHandoffQuotes="";
  try{
    if(roleName==="implementer" && !isWrapUp && !result.capped && result.status!=="completed" && mission && taskRef
       && failedRunDidWork({adapterId:role.adapter,touchedFiles:result.touchedFiles,events})){
      if(!handoffNoteFreshnessForWrapUp(mission,taskRef)?.fresh){
        // Backlog #15 part 3b: this session's own changes only.
        let sessionPaths=[];
        try{ sessionPaths=touchedFilesBetween(before,after,cwd); }catch{ sessionPaths=[]; }
        let diffStat="";
        try{ diffStat=sessionPaths.length?changedFilesStat(cwd,{paths:sessionPaths}):""; }catch{}
        const note=buildOrchestratorFallbackNote(taskRef,events,role.adapter,repo,diffStat,null,sessionPaths)
          .replace("(orchestrator fallback)\n\nThis session was capped before it wrote a fresh hand-off note, so the","(orchestrator fallback, failed run)\n\nThis session FAILED before it wrote a fresh hand-off note, so the");
        const noteRel=handoffNoteRelPath(mission,taskRef);
        fs.mkdirSync(path.dirname(path.join(repo,noteRel)),{recursive:true});
        fs.writeFileSync(path.join(repo,noteRel),note);
      }
      failureHandoffText=readHandoffNote(mission,taskRef);
      failureHandoffQuotes=handoffNoteExcerptsFor(mission,taskRef);
    }
  }catch{}
  result.executionPlaneSafety={
    envelopeAttempted:attemptEnvelope,
    envelopeApplied:executionEnvelope?.available===true,
    mechanism:disposableWorkspace?"windows-disposable-copy":(executionEnvelope?.context?.mechanism||null)
  };
  if(disposableWorkspace){
    // Truthful, non-bubblewrap-equivalent metadata (task 15.3): this is
    // compatibility isolation, never claim OS-enforced sandbox strength,
    // and the scratch directory is never retained after this role finishes.
    result.executionPlaneSafety.strength="compatibility";
    result.executionPlaneSafety.officialRepositoryUsedAsCwd=false;
    result.executionPlaneSafety.scratchRetained=false;
  }
  // Every read of the workspace this result needs (the guard log read
  // inside makeRelayResult, above) is already done — this is the single,
  // deterministic point where the disposable workspace is cleaned up and
  // checked. A cleanup failure here fails this relay call outright,
  // regardless of what the reviewer itself reported: the ORIGINAL decision
  // is still visible in result.review/result.verdict (preserved, not
  // discarded), but result.status is forced to "failed", no PASS is ever
  // persisted or acted on, and the role session is never cleared as if it
  // had completed successfully.
  cleanupDisposableWorkspace();
  if(workspaceCleanupError){
    result.status="failed";
    result.workspaceCleanupFailed=true;
    result.workspaceCleanupError=String(workspaceCleanupError?.message||workspaceCleanupError);
    result.executionPlaneSafety.workspaceCleaned=false;
  }
  if(includeError) result.error=p.error||(workspaceCleanupError?result.workspaceCleanupError:null)||null;
  if(resultExtra&&typeof resultExtra==="object") Object.assign(result,resultExtra);
  result.mission=mission||null;
  result.scratchDir=effectiveScratchDir||null;
  result.run_id=id;
  // Backlog #110: same scope fields as status.json so result.json is self-describing.
  result.taskRef=meta.taskRef??null;
  if(result.phase==null) result.phase=meta.phase??null;
  if(result.attempt==null) result.attempt=meta.attempt??null;
  // Backlog #26 Step B: per-task session store location (implementer only;
  // null otherwise). The run record names it so the wrap-up resume and the
  // completion size guard agree on the path.
  result.sessionStore=sessionStoreRel||null;
  if(mission && mission!=="planning" && !s.mission) s.mission=mission;
  // Backlog #112: a model switch clears the role's resume session (the new
  // model must start fresh), and a run that died before its first completed
  // step never stored a resumable server session.
  if(result.fallbackSwitch) clearRoleSession(s,roleName);
  else if(result.sessionId && !runFailedBeforeFirstStep(role.adapter,result.status,events)) saveRoleSession(s,roleName,result.sessionId,{cli:a.binary,model:role.model||null});
  else if(!resume && runFailedBeforeFirstStep(role.adapter,result.status,events)) clearRoleSession(s,roleName);
  if(result.status==="completed" && result.verdict?.decision==="PASS") clearRoleSession(s,roleName);
  if(alwaysSave || persistState) saveState(s);
  // Backlog 003#15: a cap breach is a continuation, not a failure — record
  // it as such. The in-memory result keeps the true terminal state
  // (failed/killed) with the result.capped marker above; both status.json and
  // result.json report "capped" so no reader mistakes a continued run for a
  // real failure.
  finalizeRun(dir,{status:capBreach?"capped":result.status,exitCode:p.status,decision:result.verdict?.decision||null,startedAt:started,usage:result.usage,timeoutMs:relayTimeoutMs});
  refreshWatchReportTagged(s,"finalize");
  const {verdict, ...restResult}=result;
  const onDisk=verdict?{...restResult,verdict:(({rawFindings,...rest})=>rest)(verdict)}:result;
  if(capBreach){
    onDisk.status="capped";
    onDisk.capType=capBreach.type;
  }
  write(path.join(dir,"result.json"),JSON.stringify(onDisk,null,2));
  try{ updateSummaryForRunDir(dir); }catch{}
  regenerateReport();
  if(workspaceCleanupError){
    // Cleanup was already attempted above (successfully or not); call fail()
    // directly rather than failClosingWorkspace() here to avoid attempting
    // it a second time and duplicating the error text it would append.
    const decisionSummary=result.verdict?.decision?`the reviewer's own decision was ${result.verdict.decision}`:`the relay status was ${result.status}`;
    return fail(`${roleName}: disposable reviewer workspace cleanup failed after the relay call completed (${decisionSummary}, but refusing to report success because the workspace could not be safely removed): ${result.workspaceCleanupError}`);
  }
  // Mission 087 task 2.2: at-once re-run on a fallback switch. The
  // intermediate RATE_LIMITED result above is already finalized to its own
  // run dir (audit trail), but only the re-run's result is RETURNED — so
  // callers (recordAttemptFailure/enforceAttemptFailure/escalateIfRateLimited)
  // never see the intermediate failure and no failure budget is spent on it.
  // Same session only when the fallback keeps the adapter and that adapter
  // supports exact-session resume AND the just-finished RATE_LIMITED run
  // emitted a sessionId; else a new session (stored sid cleared)
  // with the same brief (task), inputs (requirements/taskFacts) and hand-off
  // note (runNote). Without a sessionId there is no same session to resume:
  // buildRelayArgs would otherwise resume a stale stored sid from an earlier
  // run. Exhausted fallbacks carry no fallbackSwitch marker, so
  // they return today's RATE_LIMITED result unchanged (escalate-and-stop).
  // Backlog #112: opencode "Session not found" on a resume = the stored
  // session is gone; drop it and relaunch fresh once (no failure budget spent).
  if(resume && !__sessionRetry && result.status!=="completed" && runFailedBeforeFirstStep(role.adapter,result.status,events) && isSessionNotFound(role.adapter,p?.stderr)){
    try{
      clearRoleSession(s,roleName);
      if(persistState){ try{ saveState(s); }catch{} }
      console.log(`session: ${roleName} stored session not found; relaunching with a fresh session`);
      return runRelay(roleName,appendFailureHandoff(task,failureHandoffText,failureHandoffQuotes),c,s,{cwd,readOnly,resume:false,review,persistState,alwaysSave,fatal,includeError,requirements,taskFacts,timeoutMs,taskRef,isWrapUp,runNote,capEnabled,contScope,planRevision,carriedForwardTasks,resultExtra,__fallbackDepth,__sessionRetry:true});
    }catch{}
  }
  if(result?.escalationFailed && Number(__fallbackDepth||0)<8){
    try{
      clearRoleSession(s,roleName);
      if(persistState){ try{ saveState(s); }catch{} }
      return runRelay(roleName,appendFailureHandoff(task,failureHandoffText,failureHandoffQuotes),c,s,{cwd,readOnly,resume:false,review,persistState,alwaysSave,fatal,includeError,requirements,taskFacts,timeoutMs,taskRef,isWrapUp,runNote,capEnabled,contScope,planRevision,carriedForwardTasks,resultExtra,__fallbackDepth:Number(__fallbackDepth||0)+1,__sessionRetry});
    }catch{}
  }
  if(result?.fallbackSwitch?.to && Number(__fallbackDepth||0)<8){
    try{
      let retry=decideRoleFallbackRetry({from:result.fallbackSwitch.from,to:result.fallbackSwitch.to,resumeSupported:Boolean(agents[result.fallbackSwitch.to?.adapter]?.resume_session?.length)});
      if(retry?.resume===true && (!result.sessionId || result.fallbackSwitch)){
        retry={...retry,mode:"new-session",resume:false,reason:`${result.fallbackSwitch.to?.adapter||"unknown"}: model switch always starts a fresh session (the stored session belongs to the previous model); re-run uses the same brief/inputs/hand-off note`};
      }
      if(retry?.resume!==true){
        try{ clearRoleSession(s,roleName); }catch{}
        if(persistState){ try{ saveState(s); }catch{} }
      }
      if(retry && typeof retry.resume==="boolean"){
        return runRelay(roleName,appendFailureHandoff(task,failureHandoffText,failureHandoffQuotes),c,s,{cwd,readOnly,resume:retry.resume,review,persistState,alwaysSave,fatal,includeError,requirements,taskFacts,timeoutMs,taskRef,isWrapUp,runNote,capEnabled,contScope,planRevision,carriedForwardTasks,resultExtra,__fallbackDepth:Number(__fallbackDepth||0)+1});
      }
    }catch{}
  }
  return result;
  } catch(error){
    // Backstop for any exception NOT already routed through
    // failClosingWorkspace/the explicit cleanup check above (e.g. a
    // genuinely unexpected throw from gitSnapshot, spawnRelayChild, or
    // makeRelayResult) — those call sites already attempted cleanup
    // themselves before this catch ever runs, so alreadyAttempted is true
    // for them and this block below is a no-op for the cleanup part,
    // avoiding double-reporting the same cleanup failure twice. Only a
    // genuinely unattempted case (this catch is the first code to run after
    // the exception) performs cleanup here and folds a NEW cleanup failure
    // into the propagated error, preserving both the original exception and
    // the cleanup failure rather than silently losing either.
    const alreadyAttempted=workspaceCleaned||!!workspaceCleanupError;
    cleanupDisposableWorkspace();
    if(!alreadyAttempted && workspaceCleanupError){
      const augmented=error instanceof Error?error:new Error(String(error));
      augmented.message+=` (additionally, the disposable reviewer workspace could not be cleaned up: ${workspaceCleanupError?.message||workspaceCleanupError})`;
      augmented.workspaceCleanupError=workspaceCleanupError;
      throw augmented;
    }
    throw error;
  }
}
// gate/<verify>/task.verify commands are shell-executed strings that can
// originate from AI-authored content: gates.commands is human-configured
// (lower risk), but GSD PLAN <verify> tags and task.verify are written by
// the planner role — an LLM — with no human review before execution.
//
// Two layers are applied to every command in this file, no exceptions:
//  1. createGitMutationGuard (relay-guards.mjs): blocks git history/ref
//     mutation (commit, push, rebase, reset, ...). Git-specific, not a
//     general shell policy.
//  2. Shell-Security-Policy (shell-guard.mjs): a pattern denylist for
//     destructive filesystem ops, download-and-run RCE patterns, and
//     privilege/persistence changes, PLUS network isolation that is
//     REQUIRED BY DEFAULT (fail-closed): if isolation can't be applied
//     (non-Linux, or unshare missing/disabled), the command is refused,
//     not silently run unisolated. Set gates.network_isolation=false to
//     explicitly accept running without isolation.
//
// CORRECTNESS NOTE (v9 -> v10): v9's comment here claimed "fail closed" but
// the code fell through to an unconditional spawnSync whenever isolation
// was unavailable — i.e. it was fail-OPEN in exactly the case that
// mattered. Fixed by routing every command through decideExecution()
// (shell-guard.mjs), a pure function that makes the allow/block/isolate
// decision before any process is spawned, so the decision is unit-testable
// independent of platform. See test-shell-guard.mjs's decideExecution
// cases, in particular "isolation required + unavailable -> blocked".
//
// Neither layer is a sandbox. See shell-guard.mjs header for the explicit
// limits. Every command decision (allowed, blocked, isolated-or-not) is
// logged to <run>/shell-guard/blocked.log and to the returned result so
// this is auditable, not just "probably fine."
// networkIsolationEnabled is threaded explicitly (not a module-level flag)
// because parallel waves can run guarded commands from multiple plan units
// concurrently (see runGsdPlanUnit / max_concurrent_agents); a shared
// mutable flag would be a race hazard even though today every caller in
// practice derives it from the same config value.
function guardedShell(cwd,networkIsolationEnabled=true,envAllowlist=[]){
  const dir=path.join(repo,".autopilot","runs",`shell-${randomUUID()}`);
  fs.mkdirSync(dir,{recursive:true});
  const guard=createGitMutationGuard(dir,cwd);
  const shellGuard=createShellGuard(dir);
  shellGuard.networkIsolationEnabled=networkIsolationEnabled;
  return {guard,shellGuard,env:guardedCommandEnv(guard,{},envAllowlist)};
}
// Runs `command` under both guard layers. `label` identifies the source
// (e.g. "gates.commands", "task.verify", "gsd.<verify>") purely for logging
// — it has no effect on policy. Policy (execute/block/isolate) is decided
// by decideExecution() BEFORE anything is spawned — this function does not
// make its own judgment calls, it only carries out the decision.
// Mission 025 phase 4 task 4.1: per-linked-verify durationMs gate history.
// Every gate command's guarded-command measured durationMs is recorded in
// state.json under s.gateDurations ({command: durationMs}, latest wins) so
// the brief builder has a per-test duration source that survives across
// rounds — live gateResult.results stays the primary source, this map is
// the fallback for briefs that run without a fresh gate result (e.g. a
// re-review). Best-effort: never throws, never blocks the gate verdict.
function recordGateDurations(s, results) {
  try {
    if (!s || typeof s !== "object" || !Array.isArray(results)) return;
    const prev = (s.gateDurations && typeof s.gateDurations === "object" && !Array.isArray(s.gateDurations)) ? s.gateDurations : {};
    const next = {...prev};
    for (const r of results) {
      if (!r || typeof r.command !== "string" || !r.command) continue;
      const d = typeof r.durationMs === "string" && r.durationMs.trim() !== "" ? Number(r.durationMs) : r.durationMs;
      if (typeof d === "number" && Number.isFinite(d) && d >= 0) next[r.command] = d;
    }
    s.gateDurations = next;
    saveState(s);
  } catch {}
}
// Mission 062 task 1.3: gate-green evidence for timeout-only INCOMPLETE
// acceptance (see parseGateGreenFiles in scripts/final-review-fix-rounds.mjs).
// Every gates() run replaces s.gateGreenFiles (latest wins) with the sorted
// array of green test-file basenames parsed from this run's gate logs, tied
// to the current mission via s.gateGreenMission (missionDirFor at write
// time). readGateGreenFilesSet rehydrates it to a Set for
// runFinalReviewFixRounds, empty when absent or bound to another mission.
// finalizeMissionComplete deletes both keys. Best-effort: never throws,
// never blocks the gate verdict.
function recordGateGreenFiles(s, results, mission) {
  try {
    if (!s || typeof s !== "object" || !Array.isArray(results)) return;
    let text = "";
    for (const r of results) {
      if (r && typeof r.logFile === "string" && r.logFile) {
        try { text += `\n${fs.readFileSync(r.logFile, "utf8")}`; } catch {}
      }
      if (r && typeof r.tail === "string" && r.tail) text += `\n${r.tail}`;
    }
    s.gateGreenFiles = [...parseGateGreenFiles(text)].sort();
    s.gateGreenMission = mission ?? null;
    saveState(s);
  } catch {}
}
function readGateGreenFilesSet(s, mission) {
  try {
    if (!s || typeof s !== "object" || !Array.isArray(s.gateGreenFiles)) return new Set();
    if (mission != null && s.gateGreenMission != null && s.gateGreenMission !== mission) return new Set();
    return new Set(s.gateGreenFiles.filter((v) => typeof v === "string" && v));
  } catch { return new Set(); }
}
// Mission 093 Part 1 task 3.2 — resolve the per-mission watch-events target
// and emit the gate_start event before any gate command runs. Kept out of
// gates() so the pre-command prologue stays short.
function gateWatchStart(repo,s){
  const missionDir = getMissionWatchDir(s);
  const phase = s?.phaseIndex != null ? s.phaseIndex + 1 : null;
  if (missionDir) {
    try { appendWatchEvent(missionDir, { type: "gate_start", phase, command: null, durationMs: null, ok: null }); } catch {}
  }
  return {missionDir,phase};
}
async function gates(c,s){
  // Mission 084 Phase 2 task 2.4 (fix round 2/2) — the standalone and
  // SpecKit loops run gates(c,s) right before the read-only verifier relay.
  // Gate commands may mutate tracked files (scenario a: ignored or
  // already-dirty writes leave guard hashes unchanged), so clear the
  // snapshot reuse cache up front: no cache store happens while gates run,
  // so entry-clear is equivalent to exit-clear and covers mid-loop failure
  // returns. Same reason string as runGatesInCwd.
  try{
    clearSnapshotReuseCache("gates ran between runs");
    console.log(`[snapshot-reuse] cache cleared: gates ran between runs`);
  }catch(error){
    console.log(`[snapshot-reuse] cache clear skipped (${error?.message||error})`);
  }
  if(!(c.gates?.commands||[]).length) return {ok:true};
  const {env,shellGuard}=guardedShell(repo,c.gates?.network_isolation!==false,c.gates?.env_allowlist||[]);
  const mission=missionDirFor(repo,s);
  const gatesDir=mission
    ? path.join(repo,".autopilot","missions",mission,"gates")
    : path.join(repo,".autopilot","runs",`gates-${randomUUID()}`);
  fs.mkdirSync(gatesDir,{recursive:true});
  const {missionDir,phase}=gateWatchStart(repo,s);
  const results=[];
  for(const command of c.gates.commands){
    const t0=Date.now();
    const logFile=path.join(gatesDir,`phase-${s?.phaseIndex!=null?s.phaseIndex+1:"na"}-${t0}.log`);
    const p=await runGuardedCommand(repo,command,env,shellGuard,{label:"gates.commands",capture:true,logFile});
    // Prefer the guarded-command measured durationMs (spawn-to-close wall
    // time); fall back to the local wall clock when it is missing (e.g. a
    // sync buffered result in tests).
    const wallMs=Date.now()-t0;
    const durationMs=(typeof p?.durationMs === "number" && Number.isFinite(p.durationMs) && p.durationMs>=0)?p.durationMs:wallMs;
    const ok = p.status===0;
    results.push({command,ok,exitCode:p.status,durationMs,logFile,tail:p.tail,shellBlocked:!!p.shellBlocked,reason:p.shellBlockReason||undefined});
    if (missionDir) {
      try { appendWatchEvent(missionDir, { type: "gate_progress", phase, command, durationMs, ok }); } catch {}
    }
    if(p.status!==0){ recordGateDurations(s,results); recordGateGreenFiles(s,results,mission); 
      if (missionDir) {
        try { appendWatchEvent(missionDir, { type: "gate_result", phase, command: null, durationMs: results.reduce((sum, r) => sum + (r.durationMs || 0), 0), ok: false }); } catch {}
        // Mission 093 Part 1 task 3.4: capture git diff --stat at phase gate (failure)
        let diffStat = null;
        try { diffStat = changedFilesStat(repo); } catch { diffStat = null; }
        const checkpoint = s[CHECKPOINT_STATE_KEY];
        const attempt = checkpoint?.attempts?.implementer ?? null;
        try { appendWatchEvent(missionDir, { type: "diff_stat", phase, attempt, taskRef: null, stat: diffStat }); } catch {}
      }
      return {ok:false,command,shellBlocked:!!p.shellBlocked,reason:p.shellBlockReason,exitCode:p.status,durationMs,logFile,tail:p.tail,results}; }
  }
  const last=results[results.length-1];
  recordGateDurations(s,results);
  recordGateGreenFiles(s,results,mission);
  const totalDurationMs = results.reduce((sum, r) => sum + (r.durationMs || 0), 0);
  if (missionDir) {
    try { appendWatchEvent(missionDir, { type: "gate_result", phase, command: null, durationMs: totalDurationMs, ok: true }); } catch {}
    // Mission 093 Part 1 task 3.4: capture git diff --stat at phase gate
    let diffStat = null;
    try { diffStat = changedFilesStat(repo); } catch { diffStat = null; }
    const checkpoint = s[CHECKPOINT_STATE_KEY];
    const attempt = checkpoint?.attempts?.implementer ?? null;
    try { appendWatchEvent(missionDir, { type: "diff_stat", phase, attempt, taskRef: null, stat: diffStat }); } catch {}
  }
  return {ok:true,exitCode:last?last.exitCode:0,durationMs:last?last.durationMs:0,logFile:last?.logFile??null,tail:last?.tail??"",results};
}
// Backlog #105: the recorded-gate key adds every gate execution setting beyond
// the commands (already in the digest key): env allowlist and network isolation.
function lastGateKeyOf(baseKey,c){
  return baseKey+"|"+deltaDigest(JSON.stringify({env:c.gates?.env_allowlist||[],net:c.gates?.network_isolation!==false}));
}
// Keep the WATCH-REPORT gate data complete when a recorded/cached gate result is reused.
function noteGateReused(s,g){
  try{
    const missionDir=getMissionWatchDir(s);
    if(!missionDir) return;
    const phase=s?.phaseIndex!=null?s.phaseIndex+1:null;
    appendWatchEvent(missionDir,{type:"gate_start",phase,command:null,durationMs:null,ok:null,reused:true});
    appendWatchEvent(missionDir,{type:"gate_result",phase,command:null,durationMs:0,ok:g?.ok===true,reused:true});
  }catch{}
}
// Pending #22: after a FAIL round was recorded, schedule the one-round
// escalation when the reviewer reported a previous finding as not_fixed.
function noteEscalationTrigger(s,c,fixer,scopeKey,source,previous){
  try{
    const from=effectiveRoleModelFor(s,c,fixer);
    const histKey=source==="plan_reviewer"?"planReviewHistory":source==="verifier"?"verifierHistory":"codeReviewHistory";
    const history=Array.isArray(s?.[histKey]?.[scopeKey])?s[histKey][scopeKey]:[];
    const round=history.length;
    const minConsecutiveNotFixed=Number.isInteger(c?.policy?.escalate_after_not_fixed)?c.policy.escalate_after_not_fixed:2;
    const r=scheduleEscalation(s,c,{role:fixer,scopeKey,source,previous,history,round,effectiveFrom:from,minConsecutiveNotFixed});
    if(!r) return null;
    console.log(formatEscalationLog(r));
    const missionDir=getMissionWatchDir(s);
    if(missionDir) appendWatchEvent(missionDir,{type:"model_escalation",role:fixer,from:r.from?.model??null,to:r.to.model,adapter:r.to.adapter,source,scope:scopeKey,reason:r.finding,phase:s?.phaseIndex!=null?s.phaseIndex+1:null});
    try{ saveState(s); }catch{}
    return r;
  }catch{ return null; }
}
function review(reviewer,task,c,s,feedback="",requirements=[],taskRef=null,timeoutMs=null,capEnabled=false,roundKey=null,resultExtra=null){
  // Backlog #118: code-review round lines (exhaustive round 1 / verify previous findings).
  if(roundKey) task+=`\n\n${codeReviewerRoundLines(s,roundKey).join("\n")}`;
  return relay(reviewer,task+(feedback?`\n\nFEEDBACK TO ADDRESS:\n${feedback}`:""),c,s,{readOnly:true,review:true,resume:false,requirements,taskRef,timeoutMs,capEnabled,resultExtra});
}
// TASK-26 (003#5 part b) — derive a code_reviewer/verifier kill deadline
// from measured run durations. Returns {timeoutMs, note, derived}: the
// deadline to pass to the relay, one brief Time-budget line appended to the
// role's task text, and the deriveRoleDeadline() result (its `source` drives
// the §4 safety valve). Reads the optional policy override
// (policy.role_timeout_ms?.[role] — never a required config key), the breach
// flag, and the samples (current mission first, repo-wide fallback).
function roleDeadline(c,s,role){
  const relayTimeoutMs=Number(c.policy?.relay_timeout_ms)>0?Number(c.policy.relay_timeout_ms):RELAY_TIMEOUT_DEFAULT_MS;
  const rawOverride=c.policy?.role_timeout_ms?.[role];
  const override=Number.isInteger(rawOverride)&&rawOverride>0?rawOverride:null;
  const breached=s?.roleDeadlineBreached?.[role]===true;
  // Test-only floor override (lets the safety-valve test force a tiny
  // derived deadline); production always uses ROLE_DEADLINE_FLOOR_MS.
  const rawFloor=Number(c?.policy?.role_deadline_floor_ms);
  const floorMs=Number.isFinite(rawFloor)&&rawFloor>0?rawFloor:ROLE_DEADLINE_FLOOR_MS;
  let fallbackDirs=[];
  try{
    const missionsRoot=path.join(repo,".autopilot","missions");
    fallbackDirs=fs.readdirSync(missionsRoot,{withFileTypes:true})
      .filter((entry)=>entry.isDirectory())
      .map((entry)=>path.join(missionsRoot,entry.name,"runs"));
  }catch{}
  const samplesMs=collectRoleSamples(runsDirFor(s),role,fallbackDirs);
  const derived=deriveRoleDeadline({samplesMs,relayTimeoutMs,floorMs,override,breached});
  if(derived.source==="breach-fallback"){
    console.log(`role deadline: ${role} fell back to relay_timeout_ms after a timeout at ${formatDuration(relayTimeoutMs)}`);
  }
  const killAt=formatDuration(derived.timeoutMs);
  const note=derived.lastMs!=null
    ? `Time budget: this run is killed at ${killAt}. Measured: the last completed ${role} run in this project took ${formatDuration(derived.lastMs)} (longest of the last ${derived.sampleCount}: ${formatDuration(derived.longestMs)}). Size any command timeout from these numbers and finish — sentinel included — well inside the budget.`
    : `Time budget: this run is killed at ${killAt}. No measured ${role} run exists yet.`;
  return {timeoutMs:derived.timeoutMs,note,derived};
}
// TASK-26 §4 safety valve: a derived deadline that was too tight. TIMEOUT
// is infrastructure + retryable, so the retry would time out again under the
// same deadline — after one, the next deadline for that role is the ceiling.
// A completed run clears the flag. (Reads failure.class: failure objects
// carry `class`, never `code`.) Budgets and escalation naming are untouched.
function noteRoleDeadlineOutcome(s,role,result,derived){
  if(!s||typeof s!=="object") return;
  if(result?.failure?.class==="TIMEOUT"&&derived?.source==="measured"){
    s.roleDeadlineBreached={...(s.roleDeadlineBreached||{}),[role]:true};
    saveState(s);
  }else if(result?.status==="completed"){
    if(s.roleDeadlineBreached&&Object.hasOwn(s.roleDeadlineBreached,role)){
      delete s.roleDeadlineBreached[role];
      saveState(s);
    }
  }
}
function phaseList(c,s){
  const a=planningAdapter(c);
  if(a===standalone){ const st=s??loadState(); return standalone.tasks(repo,resolveStandaloneMission(repo,st,"")).map((t,i)=>({id:String(i+1),type:"task",command:"",done:t.done,text:t.text,file:t.file,line:t.line})); }
  if(a===speckit){ const info=speckit.inspect(repo); return (info.steps||[]).map(s=>({id:s.id,type:s.type||"command",command:s.command||""})); }
  const info=gsd.inspect(repo,gsdPhaseRoot(c)); return (info.phases||[]).map(p=>({id:p.id,type:"phase",command:""}));
}


function detectPlanningState(c,s,request=""){
  const a=planningAdapter(c);
  if(a===standalone)return standalone.state(repo,resolveStandaloneMission(repo,s,request));
  if(a===speckit){
    const info=speckit.inspect(repo);
    const detected=specKitState(repo,info,c.planning?.speckit?.task_candidates||[]);
    // specKitState() scans specs/ REPO-WIDE ("does *a* feature look
    // planned"), so an unrelated already-complete feature can make it report
    // "complete" even while THIS session's own locked-in feature
    // (s.speckitFeatureDir, set by runPlanningPhase()'s write-boundary
    // resolution once specify creates it) is still mid-planning. Resuming an
    // interrupted new-feature session must check that feature's own
    // completeness, not an unrelated one's — otherwise ensurePlanningReady()
    // would short-circuit straight to tasks_ready via the wrong feature's
    // artifacts, skipping this feature's own outstanding plan/tasks stages.
    if(s.speckitFeatureDir){
      const ownDir=path.join(repo,"specs",s.speckitFeatureDir);
      const ownComplete=["spec.md","plan.md","tasks.md"].every(f=>fs.existsSync(path.join(ownDir,f)));
      if(!ownComplete){
        detected.status="partial";
        detected.entryIndex=0;
        detected.confidence="high";
        detected.reason=`Feature ${s.speckitFeatureDir} planning is still in progress`;
        detected.checkpointed=true;
      }
    }
    if(Number.isInteger(s.planningStepIndex) && s.planningStepIndex>0 && detected.status!=="complete") {
      detected.status="partial";
      detected.entryIndex=Math.max(detected.entryIndex,s.planningStepIndex);
      detected.confidence="high";
      detected.reason="Autopilot checkpoint exists";
      detected.checkpointed=true;
    }
    return detected;
  }
  return gsdState(repo,gsd.inspect(repo,gsdPhaseRoot(c)));
}

async function reviewExistingPlanning(c,s,state,request,opts={}){
  if(state.status==="missing") return {decision:"PASS",findings:[]};
  const framework=state.framework;
  // Backlog #119: standalone only (SpecKit/GSD artifacts differ). Digest of
  // PLAN.md + TASKS.md with checkbox state normalised; skipped only on resume
  // paths (opts.allowSkip), never for an explicit `ap review-plan`.
  let standaloneDigest=null;
  if(framework==="standalone"){
    const m=resolveStandaloneMission(repo,s,request);
    if(m) standaloneDigest=planningArtifactDigest(standalone.planPath(repo,m),standalone.tasksPath(repo,m));
    if(opts.allowSkip && canSkipPlanningStateReview(s.planningStateReview,standaloneDigest)){
      console.log(`[autopilot] planning-state review skipped: plan unchanged since ${s.planningStateReview.at}`);
      return {decision:"PASS",findings:[],skipped:true};
    }
  }
  const subject=framework==="gsd"
    ? `GSD phase ${state.phase||"current"} planning artifacts`
    : framework==="standalone"
      ? "standalone Autopilot planning artifact"
      : "SpecKit planning artifacts";
  const prompt=[
    `Validate the existing ${subject} before execution or continuation.`,
    "Do not regenerate planning artifacts unless the orchestrator explicitly asks for revision.",
    state.status==="complete"
      ? "Read the actual planning artifacts on disk and determine whether they are complete, internally consistent, and ready for execution."
      : "Read only the planning artifacts that already exist. Validate that the completed portion is internally consistent and safe to continue from the detected entry point; do not fail merely because later artifacts are intentionally missing.",
    framework==="gsd"?`Target phase: ${state.phase||"unknown"}. Check PROJECT/REQUIREMENTS/ROADMAP/STATE, RESEARCH/PLAN files, dependencies, verification commands, and phase scope.`:framework==="standalone"?`Check .autopilot/missions/<mission>/PLAN.md and TASKS.md. Validate objective/scope/risks in PLAN.md, phased checklist ordering/accept/verify/capabilities in TASKS.md (each task line is "- [ ] <text> — accept: ... ; verify: ... <!-- autopilot-requires: ... -->"), cross-file consistency, and that no task runs the whole test suite (a task's verify runs only its linked tests; the full suite ${(c?.gates?.commands||[]).length?"is run by the orchestrator as a gate after code review":"belongs to the verifier"}).${verifyDenylistPromptNote(effectiveVerifyDenylist(c))?` ${verifyDenylistPromptNote(effectiveVerifyDenylist(c))}`:""}`:"Check the current SpecKit specification/plan/tasks artifacts, their consistency, task derivation, constraints, and unresolved review gates.",
    `Detected planning state: ${JSON.stringify(state)}`,
    `Project request/context: ${request}`,
    "Return exactly one AUTOPILOT_REVIEW JSON sentinel with decision PASS or FAIL and concise findings."
  ].join("\n\n");
  const rr0=await relayAsync("plan_reviewer",prompt,c,s,{readOnly:true,review:true});
  // TASK-14 Evidence call site 4: the adapter/infrastructure retry path is
  // gated by the positive allowlist `isPlanningReviewRetryFramework()`
  // (standalone or speckit only — never a negative `framework !== "gsd"`
  // check, which would fail open for any malformed/future framework value),
  // and applies identically whether this function was reached via
  // "complete" or "partial" status. Inside the allowlist the same
  // classify-then-record-then-decide contract as call sites 1-3 runs
  // (recordAttemptFailure(), never enforceAttemptFailure(), never
  // recordFailureBudget() directly; retryDelay(c, budget.used + 1); the
  // re-invocation below reuses relayAsync's default resume:false fresh
  // session). GSD takes none of the new branches for any outcome. This call
  // site's functional/output-contract behavior — immediate die(), no
  // revision — stays completely untouched regardless of framework, and never
  // records: those classes pass through the helper unchanged and reach the
  // existing die() below byte-for-byte as today.
  let rr=rr0;
  if(isPlanningReviewRetryFramework(framework)){
    rr=await resolvePlanningReviewAttempt(c,s,"existing-planning-review",rr,
      ()=>relayAsync("plan_reviewer",prompt,c,s,{readOnly:true,review:true}),
      {policyMessage:`Existing planning reviewer violated relay policy.`,escalatePrefix:`Existing ${framework} planning review`});
  } else if(rr.policyViolation) die(`Existing planning reviewer violated relay policy.`);
  // Mission 031 Phase 3 task 3.5: INCOMPLETE-as-FAIL (no continuation): existing-planning-review treats INCOMPLETE as FAIL with explicit reason.
  if(rr.review?.decision==="INCOMPLETE") console.log("Existing planning review INCOMPLETE treated as FAIL (no continuation).");
  if(rr.status!=="completed" || rr.review?.decision!=="PASS") {
    s.phase="escalated";s.step="existing-planning-review-failed";s.planningStateReview=rr.review||null;saveState(s);
    die(`Existing ${framework} planning is not ready for execution.`);
  }
  s.planningStateReview={status:"passed",framework,phase:state.phase||null,at:now(),...(standaloneDigest?{artifactDigest:standaloneDigest}:{})};
  saveState(s);
  return rr.review;
}

async function ensurePlanningReady(c,s,request){
  // Backlog #39 task 1.3: a bare `ap run` after a planning-stage stop resumes
  // with the stored request. A bare run arrives here with the placeholder (not
  // usable); when the open mission is still in a planning-stage state and its
  // stored `s.planningRequest` is usable, substitute it BEFORE detection and
  // classification so `missing` artifacts resume planning instead of dying.
  // Completed/cancelled/idle states never substitute (they keep the die
  // below), and a usable live request (including a genuinely new one) is never
  // replaced. The record guard below still keys on the LIVE request, so the
  // substitution never overwrites `s.planningRequest`.
  const inPlanningStage=String(s.phase||"")==="planning"||String(s.step||"").startsWith("planning");
  const storedPlanningRequest=hasUsableRequest(s.planningRequest)?String(s.planningRequest).trim():"";
  const effectiveRequest=!hasUsableRequest(request)&&storedPlanningRequest&&inPlanningStage?storedPlanningRequest:request;
  if(planningAdapter(c)===standalone){ ensureStandaloneMigrated(repo,s); const r=ensureStandaloneSplit(repo,s); if(r.migrated){ clearReviewFeedbackByPrefix(s,"standalone-task:"); clearFindingTasksByPrefix(s,"standalone-task:"); clearStaleStandaloneBudgets(s); saveState(s); } }
  let state=detectPlanningState(c,s,effectiveRequest);
  const intent=classifyPlanningRequest({
    request:effectiveRequest,
    currentRequest:s.planningRequest,
    stateStatus:state.status
  });
  s.planningIntent=intent;
  // Only a REAL request is recorded. A bare `ap run` (resume) passes the
  // placeholder text; storing it overwrote the mission's original request,
  // which standalone mission naming derives from — the resumed mission lost
  // its name (mission null) and wrote its run to .autopilot/runs and its plan
  // to .autopilot/missions/PLAN.md.
  if(hasUsableRequest(request)) s.planningRequest=String(request).trim();
  s.planningDetection=state;
  saveState(s);
  const startNewPlanning=intent.kind==="new" && hasUsableRequest(request);
  // TASK-14 Phase 5 task 15: standalone resume-position checkpoint consult.
  // Above the ambiguous-status die() and above identity-mismatch validation
  // (which applies only once a genuine new request has already been ruled
  // out — Phase 7). No checkpoint present → every existing behavior below,
  // including the unconditional ambiguous die(), runs completely unchanged.
  // A genuine new request unconditionally clears/supersedes any prior
  // checkpoint (valid or malformed) with no validation at all, then proceeds
  // fresh exactly as today (new-request precedence, same as the existing
  // speckitPlanningCheckpoint mechanism).
  let standaloneReviewResume=null;
  let speckitGateReviewResume=null;
  if(startNewPlanning){
    if(s.standalonePlanningReviewCheckpoint!=null || s.speckitGateReviewCheckpoint!=null){
      delete s.standalonePlanningReviewCheckpoint;
      delete s.speckitGateReviewCheckpoint;
      saveState(s);
    }
  } else if(state.framework==="standalone" && s.standalonePlanningReviewCheckpoint!=null){
    const resumeMission=resolveStandaloneMission(repo,s,effectiveRequest);
    const observed=resumeMission?readStandaloneReviewObserved(resumeMission):{artifacts:[]};
    const evaluated=evaluateStandaloneReview(s.standalonePlanningReviewCheckpoint,
      {framework:"standalone",mission:resumeMission},observed);
    if(evaluated.action!=="resume"){
      die(`Standalone planning review checkpoint is invalid: ${evaluated.code} ${evaluated.evidence?.reason||"validation failed"} evidence=${JSON.stringify(evaluated.evidence||{})}; human intervention required.`);
    }
    // TASK-14 Phase 5 task 16 (decided ambiguous+checkpoint combination): a
    // freshly-detected ambiguous status coinciding with a valid, matching,
    // explicit checkpoint at EITHER position escalates — never falls through
    // to the planner, even from planner-pending. An ambiguous checklist is
    // evidence of a possibly-corrupted file independent of checkpoint history.
    if(state.status==="ambiguous"){
      die(`Standalone planning state is ambiguous with a valid planning review checkpoint present (position=${evaluated.evidence?.position||s.standalonePlanningReviewCheckpoint?.position||"unknown"} mission=${resumeMission||"unknown"}); refusing to guess. Run inspect/setup or repair the planning artifacts. evidence=${JSON.stringify(evaluated.evidence||{})}`);
    }
    standaloneReviewResume=evaluated.evidence?.position||null;
  } else if(state.framework==="speckit" && s.speckitGateReviewCheckpoint!=null){
    // TASK-14 Phase 6 tasks 19-20: the SpecKit analogue of the standalone
    // block above. Same posture: a present checkpoint is always evaluated,
    // never read as absent, and any structural/identity/gate/drift failure
    // escalates fail-closed with evidence instead of falling back to the
    // Planner or to the generic existing-planning review.
    const resumeFeature=s.speckitFeatureDir||null;
    const resumeGate=s.speckitGateReviewCheckpoint?.gate??null;
    const resumeGateIndex=s.speckitGateReviewCheckpoint?.gateIndex??null;
    const evaluatedGate=evaluateSpeckitGateReview(s.speckitGateReviewCheckpoint,
      {framework:"speckit",mission:speckitPlanningIdentity(s),feature:resumeFeature,gate:resumeGate,gateIndex:resumeGateIndex},
      readSpeckitGateObserved(resumeFeature,resumeGate));
    if(evaluatedGate.action!=="resume"){
      die(`SpecKit gate review checkpoint is invalid: ${evaluatedGate.code} ${evaluatedGate.evidence?.reason||"validation failed"} evidence=${JSON.stringify(evaluatedGate.evidence||{})}; human intervention required.`);
    }
    speckitGateReviewResume={
      substage:evaluatedGate.evidence?.substage||null,
      gate:evaluatedGate.evidence?.gate||resumeGate,
      gateIndex:Number.isInteger(evaluatedGate.evidence?.gateIndex)?evaluatedGate.evidence.gateIndex:resumeGateIndex
    };
  }
  if(state.status==="ambiguous") die(`Planning state is ambiguous: ${state.reason||"insufficient evidence"}. Refusing to guess. Run inspect/setup or repair the planning artifacts.`);

  if(state.status==="missing" && !hasUsableRequest(effectiveRequest)){
    die(`No open task to continue and no feature description provided. Run \`ap run <description>\` or use \`--mission <name>\`.`);
  }
  // TASK 15.6B correction, widened by TASK 15.6C correction: a valid
  // same-request RECOVERABLE checkpoint takes precedence over
  // repository-wide detection. Detection is repo-wide, so an unrelated
  // completed feature reports "complete" even when this session's own
  // specify stage just failed with no feature of its own (speckitFeatureDir
  // still null). Accepting that detection would review/adopt the unrelated
  // feature instead of resuming the failed stage. Two DISTINCT failure
  // sources can produce a recoverable, same-stage checkpoint —
  // RECOVERABLE_PLANNING_CHECKPOINT_REASONS covers both:
  //   - "planning-stage-postcondition": the stage's required on-disk
  //     artifacts (speckit-planning-postconditions.mjs) were missing/invalid
  //     despite an exit-zero Planner and a clean write boundary.
  //   - "planning-write-boundary-content-violation": the REAL Native
  //     Windows incident — the Planner's OWN relay call touched an
  //     otherwise-correctly-placed .specify/feature.json whose only defect
  //     is its JSON content/schema (see classifyRecoverableBoundaryViolation
  //     in enforcePlanningWriteBoundary below). Every OTHER write-boundary
  //     violation shape stays hard-escalated with no checkpoint at all, so
  //     this branch is never reached for those cases.
  // The checkpoint (same request only — a different request resets it as
  // new planning below) forces the SpecKit resume path further down.
  // GSD/standalone never set either reason and are untouched.
  const recoverableCheckpointResume=!startNewPlanning
    && RECOVERABLE_PLANNING_CHECKPOINT_REASONS.has(s.speckitPlanningCheckpoint?.reason)
    && SPECKIT_PLANNING_STAGES.has(s.speckitPlanningCheckpoint.step)
    && state.framework==="speckit";
  if(startNewPlanning){
    // Preserve existing framework artifacts; the new planner pass is responsible
    // for creating/continuing the correct artifacts for the newly requested work.
    s.phase="planning";
    s.step="planning_new_request";
    s.planningStepIndex=0;
    s.taskIndex=0;
    s.phaseIndex=0;
    s.attempt=0;
    delete s.speckitPlanningCheckpoint;
    // A new request is a new mission: the previous one's reviewer findings
    // describe artifacts and decisions this planning pass has not made yet.
    // Both records must go together — leaving standalonePlanReview behind
    // would restore its spent `revision` into a mission that has used none
    // (escalating on the FIRST failed review instead of after
    // max_plan_revisions), and leaving reviewFeedback behind would open the
    // next Planner with "the plan reviewer REJECTED the previous attempt"
    // quoting a superseded mission's corrections.
    delete s.standalonePlanReview;
    delete s.reviewFeedback;
    delete s.planReviewHistory;
    delete s.codeReviewHistory;
    delete s.verifierHistory;
    delete s.escalationSwitches;
    delete s.escalationPending;
    // A new mission's name is unknown until the specify step creates its
    // SpecKit feature dir, so SpecKit/GSD must blindly reserve the next
    // sequence here (stable across planning runs) — there is nothing yet to
    // match an existing mission folder against. Standalone is different: its
    // name is already fully derivable from `request` via `nameFromRequest`
    // at this exact point, so blindly reserving `nextMissionSeq` here was
    // wrong — it always outbids `resolveStandaloneMission`'s own later,
    // name-aware `existingMissionSeqForName` lookup (`missionFor`'s seq
    // selection gives absolute priority to a pre-set `s.missionSeq`),
    // permanently orphaning any mission directory that already exists under
    // this exact name (e.g. one a WATCH-REPORT.md refresh already created
    // moments earlier in this same run) behind a needlessly incremented,
    // second sequence number. Reuse that existing sequence when the name
    // already matches one on disk, exactly as a resume would.
    s.mission=null;
    delete s.fixtureGitBlockWarning; delete s.fixtureGitBlockWarningPhaseIndex;
    // TASK-36: only THIS new-request site filters to reusable folders. The
    // reuse exists solely for a provisional folder that a WATCH-REPORT
    // refresh created moments earlier in this SAME run; adopting any folder
    // that has real mission work (TASKS.md/PLAN.md/runs) would let a new
    // request overwrite a finished mission. Resume paths deliberately keep
    // the unfiltered reuse: `missionFor`/`resolveStandaloneMission` (a
    // continuation with plain `ap run` or the same description lands in the
    // same folder) and `persistDetectedMission` (SpecKit, where
    // `st.missionSeq` is already pinned from `nextMissionSeq`). Twin-loop
    // note: SpecKit always takes `nextMissionSeq` below, so this filter is
    // standalone-only and no SpecKit code change is needed — pinned by the
    // SpecKit case in scripts/test-mission-folder-reuse.mjs.
    const planningStartedAtMs=Date.now();
    s.missionSeq=state.framework==="standalone"
      ? (existingMissionSeqForName(repo,nameFromRequest(request),{reusableOnly:true,since:planningStartedAtMs})||String(nextMissionSeq(repo)))
      : String(nextMissionSeq(repo));
    s.planningStartedAt=new Date(planningStartedAtMs).toISOString();
    // Freeze which SpecKit feature directories already exist BEFORE this new
    // request's planner ever runs, and clear any previously resolved feature
    // dir. runPlanningPhase()'s write-boundary check uses this snapshot (never
    // the repo-wide "does SpecKit look planned" detection above) to stop a
    // new, unrelated request from being attached to an existing feature —
    // see planning-boundary.mjs.
    if(state.framework==="speckit"){
      s.planningPreexistingFeatureDirs=listSpecKitFeatureDirNames(repo);
      s.speckitFeatureDir=null;
      // The plan stage is allowed to edit ONLY the controlled SPECKIT
      // marker section of CLAUDE.md (see planning-boundary.mjs). Capture
      // the pre-session content once so every later boundary check can
      // prove everything outside that section stayed byte-for-byte
      // identical, no matter how many plan-stage revisions happen.
      const claudeMdPath=path.join(repo,"CLAUDE.md");
      s.planningClaudeMdBaseline=fs.existsSync(claudeMdPath)?fs.readFileSync(claudeMdPath,"utf8"):null;
    } else {
      delete s.planningPreexistingFeatureDirs;
      delete s.speckitFeatureDir;
      delete s.planningClaudeMdBaseline;
    }
    saveState(s);
  }
  // 023 P2.3: artifacts-complete must not swallow pending rejected-plan
  // findings. A saved reviewFeedback record means the reviewer REJECTED the
  // plan and the revision has not run yet — routing "complete" artifacts to
  // reviewExistingPlanning->tasks_ready would execute an unapproved plan.
  // Guarded by !startNewPlanning (a new request clears reviewFeedback above).
  const hasPendingStandalonePlan=!startNewPlanning
    ? loadReviewFeedback(s,STANDALONE_PLAN_FEEDBACK_KEY).length>0 : false;
  let pendingSpeckitStage=null;
  if(!startNewPlanning && state.framework==="speckit"){
    for(const st of ["specify","plan","tasks"]){
      if(loadReviewFeedback(s,speckitStageFeedbackKey(st)).length>0){ pendingSpeckitStage=st; break; }
    }
  }
  // !startNewPlanning keeps the original `} else if` semantics: a new
  // request never takes the artifacts-complete shortcut.
  if(!startNewPlanning && state.status==="complete" && !recoverableCheckpointResume && !standaloneReviewResume && !speckitGateReviewResume && !hasPendingStandalonePlan && !pendingSpeckitStage) {
    await reviewExistingPlanning(c,s,state,effectiveRequest,{allowSkip:true});
    if(state.framework==="speckit"){ s.phase="tasks_ready";s.step="tasks_ready";saveState(s);return state; }
    s.phase="tasks_ready";s.step="tasks_ready";s.gsdPhase=state.phase;saveState(s);return state;
  }

  if(state.framework==="speckit") {
    if(!startNewPlanning) s.planningStepIndex=state.entryIndex||0;
    // TASK 15.6B, widened by TASK 15.6C: a same-request rerun after a
    // RECOVERABLE checkpoint (postcondition failure OR the narrow
    // write-boundary content-violation carved out above) must resume the
    // FAILED stage itself. Artifact detection alone would skip ahead (e.g.
    // an empty spec.md still counts as "spec present" and resolves to the
    // plan command), so the checkpoint pins the resume position to its
    // stage's command step. Gate-failure checkpoints and non-recoverable
    // write-boundary escalations carry no such reason and keep the
    // existing detection-based behavior untouched.
    const recoverableStageCheckpoint=!startNewPlanning?s.speckitPlanningCheckpoint:null;
    if(recoverableStageCheckpoint && RECOVERABLE_PLANNING_CHECKPOINT_REASONS.has(recoverableStageCheckpoint.reason) && SPECKIT_PLANNING_STAGES.has(recoverableStageCheckpoint.step)){
      const resumeSteps=(speckit.inspect(repo).steps||[]);
      const resumeIdx=resumeSteps.findIndex(st=>st && st.type!=="gate" && st.command && String(st.id||"").includes(recoverableStageCheckpoint.step));
      if(resumeIdx>=0 && resumeIdx<resumeSteps.length) s.planningStepIndex=resumeIdx;
    }
    // When resuming after a gate failure, the checkpoint indicates an
    // in-progress planning session that should continue from the failed
    // step — not be reviewed as "existing planning" (which would fail on
    // the partial artifacts and escalate). A recoverable checkpoint counts
    // the same way even when the session feature is still null: there is
    // nothing of this session's own to review yet.
    // TASK-14 Phase 6 task 20: a resume-position checkpoint is an in-progress
    // session too — it must resume at its own gate, never be handed to
    // reviewExistingPlanning() (which would review "existing planning" and then
    // continue from the generic detection-based entry point instead).
    const hasActiveCheckpoint=(s.speckitPlanningCheckpoint && s.speckitFeatureDir && !startNewPlanning) || recoverableCheckpointResume || !!speckitGateReviewResume;
    if(state.status!=="missing" && !startNewPlanning && !hasActiveCheckpoint && !pendingSpeckitStage) await reviewExistingPlanning(c,s,state,effectiveRequest);
    // The gate the checkpoint names wins over detection's entry index: that is
    // what makes a crash during review-tasks resume at review-tasks instead of
    // at whatever `detectPlanningState()` inferred from the artifacts on disk.
    if(speckitGateReviewResume && Number.isInteger(speckitGateReviewResume.gateIndex)) s.planningStepIndex=speckitGateReviewResume.gateIndex;
    // 023 P2.3: complete artifacts with pending rejected-plan findings resume
    // at the pending stage's command step, never at detection's entryIndex
    // (which points past the last step when everything looks complete).
    // A gate resume already names the exact resume position (its gateIndex
    // set above) and the gate loop consumes the same persisted findings via
    // the revision block — re-pointing at the stage command step here would
    // run the Planner an extra time (a post_revision_review resume would
    // gain a revision, a planner_revision resume would run it twice).
    if(pendingSpeckitStage && !speckitGateReviewResume){
      const pendingSteps=(speckit.inspect(repo).steps||[]);
      const pendingIdx=pendingSteps.findIndex(st=>st && st.type!=="gate" && st.command && String(st.id||"").includes(pendingSpeckitStage));
      if(pendingIdx>=0 && pendingIdx<pendingSteps.length) s.planningStepIndex=pendingIdx;
    }
    saveState(s);
    await runSpecKitPlanning(c,s,effectiveRequest,{gateReviewResume:speckitGateReviewResume});
    return detectPlanningState(c,s);
  }
  if(state.framework==="gsd") {    if(state.status!=="missing" && !startNewPlanning) await reviewExistingPlanning(c,s,state,effectiveRequest);
    s.gsdPhase=state.phase||null;
    saveState(s);
    await runGsdPlanning(c,s,effectiveRequest);
    return detectPlanningState(c,s);
  }
  if(state.framework==="standalone") {
    if(startNewPlanning || state.status!=="complete" || standaloneReviewResume || (!startNewPlanning && hasPendingStandalonePlan)) return runStandalonePlanning(c,s,effectiveRequest,{resumePosition:standaloneReviewResume});
    await reviewExistingPlanning(c,s,state,effectiveRequest,{allowSkip:true});
    s.phase="tasks_ready";s.step="tasks_ready";saveState(s);
    return state;
  }
  die("Unsupported planning adapter.");
}

// Stable state.json keys for persisted reviewer findings. Per-loop, so a
// plan revision and an implementation retry never read each other's
// corrections; per-task/per-phase where the loop itself is per-task.
const STANDALONE_PLAN_FEEDBACK_KEY="standalone-plan";
const standaloneTaskFeedbackKey=(file,line)=>`standalone-task:${path.basename(file)}:${line}`;
const speckitPhaseFeedbackKey=index=>`speckit-phase:${index}`;
const speckitStageFeedbackKey=stage=>`speckit-stage:${stage}`;
const gsdPhaseFeedbackKey=phase=>`gsd-phase:${phase}`;

// TASK-20: a relay result's findings as the REVIEWER returned them. Everything
// that injects feedback into a prompt reads `result.review.findings`, which is
// renderFinding()'s one-line form — task tags (`"tasks":["T1"]`) are flattened
// away there, so the finding→task map must be built from the raw array
// failure-contract.mjs keeps beside it. The rendered list stays the fallback
// for any result produced before that field existed.
const rawReviewFindings=result=>result?.verdict?.rawFindings??result?.review?.findings??[];

// Mission 025 task 2.1: linkedVerifyCommandsForPhase() and
// reviewerLinkedToolResults() live in failure-contract.mjs (imported above)
// so the gate suite can unit-test the extraction directly (task 2.3).

const SPECKIT_PLANNING_STAGES=new Set(["specify","plan","tasks"]);
// TASK 15.6C correction: the two checkpoint reasons that make a same-stage
// retry safe to auto-resume WITHOUT any repair/fabrication by Autopilot
// itself — see the recoverableCheckpointResume/recoverableStageCheckpoint
// wiring in ensurePlanningReady above and classifyRecoverableBoundaryViolation
// in enforcePlanningWriteBoundary below for what each one actually requires
// before it is ever set.
const RECOVERABLE_PLANNING_CHECKPOINT_REASONS=new Set([
  "planning-stage-postcondition",
  "planning-write-boundary-content-violation"
]);
// Phase 9 task 9.1: canonical exact-paths guidance shared by every planner
// prompt (standalone fresh + revision, SpecKit planning phase, GSD planning
// stage, SpecKit tasks artifact contract). Wording deliberately avoids the
// legacy cite forms so a forbidden-pattern scan of the prompt regions never
// trips on its own fix: cite only the absolute sandbox-visible paths named in
// the prompt itself.
const PLANNER_PATHS_LINE="Use only absolute sandbox-visible artifact paths given in this prompt for the plan and task artifacts (PLAN.md and TASKS.md); never cite a remembered number or directory from memory — read the exact paths above.";
// Backlog #57: plan-time verify-length rule, shared verbatim by every planner
// prompt that authors task lines (the standalone planner `tasksLine` — both the
// fresh and the revision branch — and the SpecKit tasks-stage artifact
// contract), the same one-canonical-string pattern as PLANNER_PATHS_LINE above.
// The recorded verify is re-run verbatim downstream (taskLocalCheck.command is
// bounded to ROLE_PROGRESS_COMMAND_MAX_CHARS = 500 in phase-stage-checkpoint.mjs),
// so an inline `node -e` snippet or any longer command can never be executed as
// recorded: every task verify must be ONE short command naming a test file.
// Deliberately contains no semicolon (the standalone tasksLine statement is
// sliced on ";" by the static prompt pins).
const VERIFY_LENGTH_RULE="Every task verify is ONE short command naming a test file (at most 500 characters) and never an inline `node -e` script: the recorded verify is re-run verbatim, so a script a task needs must live in its own test file instead.";
// Planning-prompt rules, same one-canonical-string pattern as PLANNER_PATHS_LINE
// above: each rule is defined once here and referenced by constant from prompts,
// never copied inline. Wording keeps clear of legacy cite forms.
// Reviewer one-pass rule: report everything visible in a single pass instead of
// stopping at the first finding, so review rounds stop costing one round per finding.
const REVIEWER_ALL_FINDINGS_LINE="Report ALL findings you can see in ONE pass — every plan and task inconsistency and every stale test pin a task would break — instead of stopping at the first one or two.";
// Planner read-range rule: keep large sources out of context by reading only the
// cited ranges, starting from the file and line references given in the request.
const PLANNER_READ_RANGE_LINE="Read large source files only by line range or grep starting from the file:line references cited in the request — never read a whole large file into context.";
async function runPlanningPhase(c, step, request, s){
  s.phase="planning"; s.step=step; saveState(s);
  const boundaryActive=Array.isArray(s.planningPreexistingFeatureDirs) && SPECKIT_PLANNING_STAGES.has(step);
  const boundaryNote=boundaryActive
    ? boundaryNoteFor(step,s.speckitFeatureDir)
    : "";
  // TASK 15.6C: the write-boundary note above says WHERE the Planner may
  // write; it never said what the file at that path must actually contain.
  // The real Native Windows incident this fixes: the Planner wrote a valid
  // spec.md but invented its own 7-field .specify/feature.json instead of
  // the real speckit-specify schema (exactly one field, feature_directory).
  // artifactContractNoteFor spells out the exact on-disk shape validated by
  // speckit-planning-postconditions.mjs for every stage, up front, so the
  // Planner does not have to independently reverse-engineer it.
  const contractNote=boundaryActive
    ? artifactContractNoteFor(step,s.speckitFeatureDir,c.policy)
    : "";
  // TASK 15.6C: when this exact stage failed last time in a RECOVERABLE way
  // — either its postcondition (enforcePlanningStagePostcondition) or the
  // narrow write-boundary content violation (enforcePlanningWriteBoundary)
  // — echo the persisted failure back into the RETRY instruction so the
  // Planner corrects the same defect instead of repeating it blind.
  // Fail-closed: a missing, mismatched, unsafe, or malformed checkpoint
  // yields no note at all, never a crash or a fabricated one.
  const correctionNote=boundaryActive
    ? correctionNoteFor(step,s.speckitPlanningCheckpoint)
    : "";
  // Findings from the gate reviewer that sent this stage back for revision.
  // Distinct from correctionNote above, which carries Autopilot's OWN
  // deterministic postcondition/boundary validation — this one carries the
  // review verdict, and without it a revision is asked to fix an unnamed
  // problem.
  const gateFindings=feedbackText(loadReviewFeedback(s,speckitStageFeedbackKey(step)));
  const gateNote=gateFindings
    ? `\n\nThe plan reviewer REJECTED the previous attempt at this stage. Address every finding; do not repeat the same output:\n${gateFindings}${plannerEarlierRoundsText(s,speckitStageFeedbackKey(step)) ? `\n\n${plannerEarlierRoundsText(s,speckitStageFeedbackKey(step))}` : ""}`
    : "";
  // Phase 9 task 9.1: absolute sandbox-visible SpecKit artifact paths cited
  // in the prompt itself, so PLANNER_PATHS_LINE's "read the exact paths
  // above" resolves to real paths (not a remembered number or directory).
  const speckitFeatureName=s.speckitFeatureDir||"<new-feature>";
  const speckitSpecAbs=path.join(repo,"specs",speckitFeatureName,"spec.md");
  const speckitPlanAbs=path.join(repo,"specs",speckitFeatureName,"plan.md");
  const speckitTasksAbs=path.join(repo,"specs",speckitFeatureName,"tasks.md");
  const speckitPathsLine=`SpecKit artifact paths (absolute, sandbox-visible): spec: ${speckitSpecAbs}; plan: ${speckitPlanAbs}; tasks: ${speckitTasksAbs}.`;
  const task=`Planning phase: ${step}.
Use the selected planning framework's installed commands/skills and project artifacts.
${speckitPathsLine}
${PLANNER_PATHS_LINE}
${PLANNER_READ_RANGE_LINE}
Do not implement production code. Do not commit/push.${boundaryNote}${contractNote}${correctionNote}${gateNote}
Keep a hand-off note at ${handoffNoteRelPath(s.mission, 'standalone-planning-planner')}. OVERWRITE it (never append) at each milestone — after every important finding, before writing the stage artifact — with: 1. Done — files changed (names only; details are in the worktree). 2. Found — facts the next session needs: exact file:line, function names, how the code works there. 3. Next — the exact next edit: file, line, what to change. 4. Dead ends — what you tried that did not work, and why. If your session is stopped, the next session starts from this note. No loop currently reads this note (this relay runs with no taskRef/capEnabled); writing it is an allowed exception to the 'Write only' list above.
Project request:
${request}`;
  // Always fresh: s.sessionId is never assigned (this call also drives
  // gate-failure revisions, whose corrective findings are already embedded
  // in `task` above), so resuming here would only ever mean falling back to
  // an unrelated prior session, not this one.
  const r=await relay("planner",task,c,s,{resume:false});
  // Backlog #54: RATE_LIMITED short-circuits here — before the status die below —
  // so the planner is never treated as a generic planner failure.
  escalateIfRateLimited(c,s,"speckit-gate-review",r,{fatal:die,saveState,escalatePrefix:`SpecKit planner ${step}`});
  if(r.status!=="completed" || r.policyViolation) die(`Planner failed or violated relay policy in phase ${step}.`);
  enforcePlanningWriteBoundary(s,step,r.touchedFiles||[]);
  enforcePlanningStagePostcondition(s,step);
  return r;
}

// Human-readable (prompt-only, non-enforcing) description of exactly what
// this stage may touch — kept in sync with planning-boundary.mjs's actual
// per-stage allowlists so the Planner is told the real contract, but the
// die() in enforcePlanningWriteBoundary below is what actually stops it.
function boundaryNoteFor(step,featureDir){
  const feature=featureDir?`specs/${featureDir}/`:"specs/<new-feature>/";
  if(step==="specify") return `\nThis is a NEW feature. Write only: .specify/feature.json and ${feature}spec.md (plus ${feature}checklists/** if needed). Do not touch any other specs/ feature directory, do not write plan.md/tasks.md yet, and do not create any implementation deliverable.`;
  if(step==="plan") return `\nFeature '${featureDir||"<new-feature>"}'. Write only: ${feature}plan.md, research.md, data-model.md, quickstart.md, contracts/**, and — if needed — ONLY the content between the ${CLAUDE_MD_MARKER_BEGIN} / ${CLAUDE_MD_MARKER_END} markers in CLAUDE.md (nothing else in CLAUDE.md may change). Do not write tasks.md yet, and do not create any implementation deliverable.`;
  if(step==="tasks") return `\nFeature '${featureDir||"<new-feature>"}'. Write only: ${feature}tasks.md. Do not create any implementation deliverable.`;
  return "";
}

// TASK 15.6C: explicit, stage-specific artifact CONTENT contract — kept in
// sync with speckit-planning-postconditions.mjs's actual validation (which
// is what really enforces this; this text is prompt-only guidance and
// mutates nothing). boundaryNoteFor above only names allowed PATHS; this
// names the required SHAPE of what lands at those paths, so the Planner is
// told the real speckit-specify/-plan/-tasks contract instead of having to
// independently discover it.
function artifactContractNoteFor(step,featureDir,policy){
  const sizeTarget=resolveTaskSizeTargetTurns(policy);
  const feature=featureDir?`specs/${featureDir}`:"specs/<new-feature>";
  // Phase 9 task 9.1: absolute sandbox-visible twins of the relative feature
  // paths above. The .specify/feature.json schema stays relative
  // ("specs/<feature>") — only the file paths the planner reads/writes are
  // given as absolute paths so PLANNER_PATHS_LINE resolves to real paths.
  const absFeature=featureDir?path.join(repo,"specs",featureDir):path.join(repo,"specs","<new-feature>");
  if(step==="specify") return `

Artifact contract for this stage (validated on disk before it is accepted):
- Create exactly one new feature directory ${feature}/ (absolute: ${absFeature}/; never reuse or write into an existing specs/ feature directory).
- Write ${absFeature}/spec.md as a non-empty file — whitespace-only content is rejected.
- Write .specify/feature.json as EXACTLY this one-field JSON object, no other keys:
    {"feature_directory": "${feature}"}
  feature_directory must be a string equal to "${feature}" exactly (the same feature directory as spec.md). Do not add branch, feature_name, feature_number, created_at, author, status, or any other field — the real schema has exactly one key.`;
  if(step==="plan") return `

Artifact contract for this stage (validated on disk before it is accepted):
- Write ${absFeature}/plan.md as a non-empty file — whitespace-only content is rejected (plan artifact absolute path: ${absFeature}/plan.md; companion tasks artifact: ${absFeature}/tasks.md).`;
  // TASK 15.6E: the phase-heading syntax is load-bearing — production
  // executes `## Phase N` sections (adapters/speckit.mjs phases()), not
  // loose checkboxes. Loose/orphan task lines without a recognized heading
  // are rejected as tasks_no_executable_phases before any reviewer runs.
  if(step==="tasks") return `

 ${PLANNER_PATHS_LINE}
Artifact contract for this stage (validated on disk before it is accepted):
- Write ${absFeature}/tasks.md as a non-empty file (tasks artifact absolute path: ${absFeature}/tasks.md; companion plan artifact: ${absFeature}/plan.md). Every actionable task MUST live under a recognized phase heading with the exact syntax '## Phase N: <name>' where N is 1, 2, 3, ... (e.g. '## Phase 1: Build the widgets', then '- [ ] T001 Do the thing' lines beneath it).
- At least one phase must contain at least one unchecked task line ('- [ ] ...'). A file with only checked tasks, with no parseable tasks, with no recognized phase heading, or with unchecked task lines outside any '## Phase N' heading (orphans that production would never execute), is rejected.
- TASK 15.6F phase observability: structure work so that EVERY phase, when implemented, produces at least one Git-observable file addition, modification, or deletion. Never make empty-directory creation a standalone phase — Git cannot represent empty directories, so such a phase can never be code-reviewed or verified; fold directory preparation into the same phase (and task flow) as the task that creates the first file inside the directory. Likewise, never create a phase consisting only of reads, checks, or planning notes with no persistent file output.
- Split build-then-wire work into two tasks: a task that needs both a new design/helper AND its wiring into a large file must be two tasks (build, then wire) — one task to build the helper/design, then a second task to wire it in — never combine both in a single task.
- ${taskSizingRuleText(sizeTarget)}
- ${VERIFY_LENGTH_RULE}
- If a previous attempt at this stage failed, the retry instruction carries a structured AUTOPILOT_PLANNING_CORRECTION={...} line naming the exact stage, artifact, expected path, and reason code — satisfy that contract exactly rather than rewriting the file a different way.`;
  return "";
}

// TASK 15.6C, widened by the 15.6C correction: fail-closed structural
// validation of a persisted RECOVERABLE checkpoint before it is ever echoed
// back into a prompt. state.json is local/trusted, but it can still be
// stale (a checkpoint from a DIFFERENT stage than the one about to run),
// hand-edited, or corrupted by a partial write — none of that may be
// trusted structurally. Handles both recoverable checkpoint shapes and
// normalizes them to the same {artifact,expected,reason,detail} view:
//   - "planning-stage-postcondition": checkpoint.postcondition, produced
//     verbatim from validatePlanningStagePostcondition()'s verdict.
//   - "planning-write-boundary-content-violation": checkpoint.boundary
//     ({path,reason}), produced verbatim from
//     classifyRecoverableBoundaryViolation()'s single allowed violation —
//     re-checked here against the SAME content-only whitelist so a
//     hand-edited or otherwise-corrupted checkpoint claiming an unsafe
//     reason (e.g. "outside_allowed_paths") can never surface as if it were
//     a benign schema mistake.
// Anything that does not match the exact expected shape for THIS stage
// yields null (no feedback note at all) rather than crashing or leaking a
// malformed object into the Planner instruction.
function sanitizedPostconditionFeedback(step,checkpoint){
  if(!checkpoint || typeof checkpoint!=="object") return null;
  if(checkpoint.step!==step) return null;
  if(checkpoint.reason==="planning-stage-postcondition"){
    const pc=checkpoint.postcondition;
    if(!pc || typeof pc!=="object") return null;
    if(typeof pc.reason!=="string" || !pc.reason) return null;
    if(typeof pc.artifact!=="string" || !pc.artifact) return null;
    if(typeof pc.expected!=="string" || !pc.expected) return null;
    if(pc.detail!=null && typeof pc.detail!=="string") return null;
    return {reason:pc.reason,artifact:pc.artifact,expected:pc.expected,detail:pc.detail||null};
  }
  if(checkpoint.reason==="planning-write-boundary-content-violation"){
    const b=checkpoint.boundary;
    if(!b || typeof b!=="object") return null;
    if(typeof b.path!=="string" || !b.path) return null;
    if(typeof b.reason!=="string" || !b.reason) return null;
    if(!RECOVERABLE_FEATURE_JSON_CONTENT_REASONS.has(b.reason)) return null;
    return {reason:b.reason,artifact:b.path,expected:b.path,detail:null};
  }
  return null;
}

// TASK 15.6C, widened by the 15.6C correction: the actual retry-instruction
// text built from the sanitized checkpoint above. Carries the same stable
// fields in TWO forms:
//   - a single-line "AUTOPILOT_PLANNING_CORRECTION=<json>" sentinel, keyed
//     stage/artifact/expected/reason/detail — every value a stable
//     identifier the validator itself produced (a reason code, a path),
//     never free-form prose. This is the form tests assert on (grep an
//     exact expected line), the same "PREFIX={...json...}" sentinel
//     convention already used for AUTOPILOT_REVIEW.
//   - human-readable prose immediately below it, for a real model reading
//     the same instruction.
function correctionNoteFor(step,checkpoint){
  const fb=sanitizedPostconditionFeedback(step,checkpoint);
  if(!fb) return "";
  const sentinel=JSON.stringify({stage:step,artifact:fb.artifact,expected:fb.expected,reason:fb.reason,detail:fb.detail});
  return `

Previous attempt at this stage failed validation — correct it, do not repeat it.
AUTOPILOT_PLANNING_CORRECTION=${sentinel}
- Failing artifact: ${fb.artifact}
- Expected path: ${fb.expected}
- Failure reason: ${fb.reason}${fb.detail?`\n- Detail: ${fb.detail}`:""}
Re-read the artifact contract above and produce output that satisfies it exactly.`;
}

// TASK 15.6C correction: the exact, narrow whitelist of write-boundary
// violation shapes that are safe to auto-retry without Autopilot repairing
// or fabricating anything. A SOLE violation on the allowed
// ".specify/feature.json" path (see classifyRecoverableBoundaryViolation
// below) whose ONLY defect is its JSON content/schema — one of
// validateFeatureJson()'s content-level reason codes. Deliberately
// EXCLUDED, and therefore left exactly as hard-escalated/non-recoverable as
// before:
//   - "feature_json_unreadable" — readFile() failed (can indicate a
//     symlink/junction, a directory, or a permissions problem masquerading
//     at this path); more than a benign schema mistake.
//   - "wrong_stage_artifact" — feature.json touched outside the specify
//     stage.
//   - every other reason code (outside_allowed_paths,
//     preexisting_feature_directory, feature_directory_unresolved,
//     different_feature_directory, multiple_new_feature_directories,
//     claude_md_*, etc.) — an escape outside the boundary, an unrelated- or
//     ambiguous-feature write, or a CLAUDE.md edit outside its controlled
//     marker section.
const RECOVERABLE_FEATURE_JSON_CONTENT_REASONS=new Set([
  "feature_json_invalid_json",
  "feature_json_not_an_object",
  "feature_json_unexpected_shape",
  "feature_json_field_feature_directory_invalid",
  "feature_json_feature_directory_malformed",
  "feature_json_feature_directory_mismatch"
]);
// Returns the sole {path,reason} violation when it qualifies for the
// recoverable carve-out above, else null. A MIXED failure (the content
// violation ALONGSIDE any other violation, e.g. an unrelated-feature write
// in the same call) never qualifies — mixing a benign content mistake with
// a genuine boundary/security violation must fail closed to the stricter,
// non-recoverable path.
function classifyRecoverableBoundaryViolation(step,evaluation){
  if(step!=="specify") return null;
  const violations=Array.isArray(evaluation?.violations)?evaluation.violations:[];
  if(violations.length!==1) return null;
  const v=violations[0];
  if(!v || v.path!==".specify/feature.json") return null;
  if(!RECOVERABLE_FEATURE_JSON_CONTENT_REASONS.has(v.reason)) return null;
  return v;
}

// Fails the current planning stage loudly if the planner touched anything
// outside the SpecKit write boundary established for this (new) planning
// session — see planning-boundary.mjs. Gated on
// s.planningPreexistingFeatureDirs so sessions that never went through the
// "new request" setup in ensurePlanningReady() (e.g. framework isn't
// SpecKit) are entirely unaffected; this is enforcement over OBSERVED
// touched-file paths and content (relay-guards.mjs's touchedFilesBetween
// plus a direct read of each touched file), never a prompt-only guard.
//
// TASK 15.6C correction: this is the REAL observed Native Windows incident
// — the Planner's OWN relay call touches both a valid spec.md and an
// invented, invalid-schema .specify/feature.json, so THIS check (which
// inspects every touched path's content, independent of the postcondition
// module) is what actually catches it, before the postcondition check ever
// runs. Escalation (phase="escalated", step="planning-write-boundary-
// violation", planningWriteBoundaryViolation) is recorded EXACTLY as before
// for every violation shape — that observable failure signature is not
// weakened or changed. The ONLY addition: when the violation qualifies for
// the narrow recoverable carve-out above, a same-stage checkpoint is ALSO
// persisted (mirroring how a postcondition failure checkpoints), so
// ensurePlanningReady's existing recoverable-checkpoint resume path can
// safely re-run this exact stage on a same-request retry. Every other
// violation shape gets no checkpoint at all and remains exactly as
// non-recoverable as before — no automatic resume, human intervention
// required.
function enforcePlanningWriteBoundary(s,step,touchedFiles){
  if(!Array.isArray(s.planningPreexistingFeatureDirs) || !SPECKIT_PLANNING_STAGES.has(step)) return;
  const evaluation=evaluatePlanningWriteBoundary({
    stage:step,
    touchedFiles,
    preexistingFeatureDirs:s.planningPreexistingFeatureDirs,
    resolvedFeatureDir:s.speckitFeatureDir||null,
    readFile:(rel)=>{ try{ return fs.readFileSync(path.join(repo,rel),"utf8"); }catch{ return null; } },
    claudeMdBaseline:s.planningClaudeMdBaseline??null
  });
  if(!evaluation.ok){
    s.phase="escalated";s.step="planning-write-boundary-violation";
    s.planningWriteBoundaryViolation={step,violations:evaluation.violations,at:now()};
    const recoverable=classifyRecoverableBoundaryViolation(step,evaluation);
    if(recoverable){
      // Preserve the session feature identity so the retry resumes the SAME
      // feature (mirrors enforcePlanningStagePostcondition's identical
      // preserve-on-failure behavior below).
      if(!s.speckitFeatureDir && evaluation.resolvedFeatureDir) s.speckitFeatureDir=evaluation.resolvedFeatureDir;
      const steps=(speckit.inspect(repo).steps||[]);
      const cmdIdx=steps.findIndex(st=>st && st.type!=="gate" && st.command && String(st.id||"").includes(step));
      s.speckitPlanningCheckpoint={
        step,
        index:Number.isInteger(cmdIdx)&&cmdIdx>=0?cmdIdx:(Number.isInteger(s.planningStepIndex)?s.planningStepIndex:0),
        failedAt:now(),
        reason:"planning-write-boundary-content-violation",
        boundary:{path:recoverable.path,reason:recoverable.reason}
      };
    }
    saveState(s);
    die(`Planner violated the SpecKit planning-stage write boundary in phase '${step}': `+
      evaluation.violations.map(v=>`${v.path} (${v.reason})`).join("; "));
  }
  if(!s.speckitFeatureDir && evaluation.resolvedFeatureDir){
    s.speckitFeatureDir=evaluation.resolvedFeatureDir;
    saveState(s);
  }
}

// TASK 15.6B: SpecKit planning-stage postcondition — validate the stage's
// required on-disk artifacts immediately after the planner relay and the
// write-boundary check, before "<stage> ready" is printed, before the
// workflow advances, and before the following Plan Reviewer gate launches.
// Disk state alone decides: an exit-zero planner that produced no required
// output fails here (touchedFiles=[] is never success when output is
// absent), while valid pre-existing artifacts on a legitimate retry pass.
// Gated exactly like the write boundary, so GSD/standalone/custom stages
// are untouched. Read-only: never mutates or fabricates artifacts.
function enforcePlanningStagePostcondition(s,step){
  if(!Array.isArray(s.planningPreexistingFeatureDirs) || !SPECKIT_PLANNING_STAGES.has(step)) return;
  const verdict=validatePlanningStagePostcondition({
    repo,
    stage:step,
    sessionFeatureDir:s.speckitFeatureDir||null,
    preexistingFeatureDirs:s.planningPreexistingFeatureDirs
  });
  // Preserve the session feature identity whenever the stage resolved one,
  // including on failure, so a same-request rerun resumes the same session.
  if(verdict.featureDir && !s.speckitFeatureDir){
    s.speckitFeatureDir=verdict.featureDir;
    saveState(s);
  }
  if(!verdict.ok){
    if(verdict.featureDir) s.speckitFeatureDir=verdict.featureDir;
    const steps=(speckit.inspect(repo).steps||[]);
    const cmdIdx=steps.findIndex(st=>st && st.type!=="gate" && st.command && String(st.id||"").includes(step));
    // TASK 15.6C: persist ONLY the structured, non-secret fields the
    // validator itself produced (a reason code, an artifact path, an
    // expected path, an optional short detail string) — never file
    // content, never anything from the request/prompt — so the next
    // attempt's correctionNoteFor() can quote the exact failure back to
    // the Planner. sanitizedPostconditionFeedback() re-validates this
    // fail-closed before it is ever used.
    s.speckitPlanningCheckpoint={
      step,
      index:Number.isInteger(cmdIdx)&&cmdIdx>=0?cmdIdx:(Number.isInteger(s.planningStepIndex)?s.planningStepIndex:0),
      failedAt:now(),
      reason:"planning-stage-postcondition",
      postcondition:{
        reason:verdict.reason||null,
        artifact:verdict.artifact||null,
        expected:verdict.expected||null,
        detail:verdict.detail||null
      }
    };
    saveState(s);
    die(formatPostconditionError(step,verdict));
  }
  // TASK 15.6C, widened by the 15.6C correction: this stage's postcondition
  // just passed — which only happens after the write-boundary check for
  // this SAME call already passed too (enforcePlanningWriteBoundary runs
  // first in runPlanningPhase and die()s on any violation) — so any
  // checkpoint feedback persisted for THIS SAME stage, from EITHER
  // recoverable source, is now stale (either it was just corrected, or
  // valid pre-existing artifacts satisfied it outright). Clear it
  // immediately rather than waiting for the whole planning run to finish,
  // so a crash-and-resume right after this point never re-injects an
  // already-resolved failure into a later stage's prompt. Deliberately
  // NOT done inside enforcePlanningWriteBoundary's own success path: this
  // is the one point that confirms the WHOLE stage (boundary AND
  // postcondition) is genuinely satisfied — clearing any earlier would risk
  // discarding still-relevant feedback if the postcondition itself then
  // failed for a different reason.
  if(s.speckitPlanningCheckpoint?.step===step && RECOVERABLE_PLANNING_CHECKPOINT_REASONS.has(s.speckitPlanningCheckpoint?.reason)){
    delete s.speckitPlanningCheckpoint;
    saveState(s);
  }
}

// TASK-38: denylist prompt note, shown in planner and plan-reviewer
// prompts. The caller passes the EFFECTIVE denylist
// (effectiveVerifyDenylist(c) — operator planning.verify_denylist plus the
// always-forbidden full-suite runner test-all.mjs plus every
// gates.commands entry), so the note is non-empty whenever any of those
// sources is non-empty — including a default config, where it still lists
// test-all.mjs.
function verifyDenylistPromptNote(denylist){
  const list=(Array.isArray(denylist)?denylist:[]).map(x=>typeof x==="string"?x.trim():"").filter(Boolean);
  if(!list.length)return "";
  return `VERIFY DENYLIST: these entries must NEVER appear in a task's verify — the orchestrator rejects any plan whose task verify names one of them (substring match): ${list.map(x=>`"${x}"`).join(", ")}. Never use them in a verify; the plan reviewer must FAIL a plan that does.`;
}

// verifyDenylistFindings and effectiveVerifyDenylist live in
// scripts/verify-denylist.mjs (imported above; Mission 038 task 1.1) so unit
// tests can import the same gate the loops run. The gate deliberately
// applies to standalone TASKS.md and GSD <task><verify> blocks only —
// SpecKit task lines carry NO per-task verify field
// (adapters/speckit.mjs tasks()/phases() return {text, done, file, line}
// only), so there is nothing per-task to check on the SpecKit loop (the
// task-text scan lands in Mission 038 task 1.3).

// Parse a standalone TASKS.md into {taskLabel, verify} entries: one entry
// per task line that carries an inline " ; verify: " segment; a task
// without verify: is never flagged. Task ID comes from the "**<phase>.<task>**"
// marker, falling back to the line number.
function standaloneTaskVerifyEntries(tasksFile){
  const out=[];
  if(!fs.existsSync(tasksFile))return out;
  const lines=fs.readFileSync(tasksFile,"utf8").split(/\r?\n/);
  let inFence=false;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/^\s*(```|~~~)/.test(line)){inFence=!inFence;continue;}
    if(inFence)continue;
    const m=line.match(/^\s*-\s*\[\s*([xX ]?)\s*\]\s+(.+)$/);
    if(!m)continue;
    const raw=m[2];
    const vm=raw.match(/;\s*verify:\s*(.+?)(?:\s*<!--|$)/);
    if(!vm)continue;
    const idm=raw.match(/\*\*(\d+\.\d+)\*\*/);
    out.push({taskLabel:idm?idm[1]:`line ${i+1}`,verify:vm[1].trim()});
  }
  return out;
}

async function runStandalonePlanning(c,s,request,opts={}){
  ensureStandaloneMigrated(repo,s);
  { const r=ensureStandaloneSplit(repo,s); if(r.migrated){ clearReviewFeedbackByPrefix(s,"standalone-task:"); clearFindingTasksByPrefix(s,"standalone-task:"); clearStaleStandaloneBudgets(s); } }
  const mission=resolveStandaloneMission(repo,s,request);
  const file=standalone.planPath(repo,mission);
  const tasksFile=standalone.tasksPath(repo,mission);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  s.phase="planning";s.step="standalone-plan";s.standalonePlanFile=file;saveState(s);
  // Plan Review gates Implementation: a FAIL returns to Planning (with the
  // reviewer's findings fed back to the Planner) instead of escalating on
  // the first attempt, matching the SpecKit/GSD planning-review loops.
  const maxRevisions=Math.max(1,Number(c.policy?.max_plan_revisions||8));
  // Restored, not restarted: a stopped/crashed mission used to re-enter this
  // loop with feedback="" even though the reviewer's findings were sitting
  // in state.json, so the next Planner had to rediscover the review from
  // runs/ logs. Revision count is restored with it, otherwise a restart
  // silently refunds the revision budget too.
  let revision=Number(s.standalonePlanReview?.revision)||0;
  // Missions planned before reviewFeedback existed recorded their findings
  // on the legacy s.standalonePlanReview.findings array. `revision` above is
  // still read from that same legacy record, so without this migration a
  // resume takes the legacy PENALTY (a spent revision) while dropping the
  // legacy PAYLOAD (the findings) — handing the Planner a byte-identical
  // first-attempt prompt, which is precisely the defect this loop was
  // changed to fix. Migrated through saveReviewFeedback() so the legacy
  // array is bounded and fail-closed on the way in, exactly like a fresh
  // verdict — it is user-editable state and gets no more trust for being old.
  if(!loadReviewFeedback(s,STANDALONE_PLAN_FEEDBACK_KEY).length
     && Array.isArray(s.standalonePlanReview?.findings)
     && s.standalonePlanReview.findings.length){
    saveReviewFeedback(s,STANDALONE_PLAN_FEEDBACK_KEY,s.standalonePlanReview.findings);
    saveState(s);
  }
  const initialFindings=loadReviewFeedback(s,STANDALONE_PLAN_FEEDBACK_KEY);
  let feedback=feedbackText(initialFindings);
  let findingCount=initialFindings.length;
  seedPlanReviewHistory(s,STANDALONE_PLAN_FEEDBACK_KEY,initialFindings);
  let state;
  // TASK-14 Phase 5 task 15: resume at the reviewer when ensurePlanningReady
  // validated an explicit reviewer-pending checkpoint for this same request.
  // The planner already finished writing before the interruption, so the
  // first loop iteration skips the planner call entirely and re-invokes only
  // the reviewer against the existing artifacts. A planner-pending resume
  // needs no flag: the loop below already starts at the planner. Content was
  // validated (reviewer stage) or skipped (writable stage) by the task 12
  // evaluator during the consult above — never here.
  let skipPlannerFirst=opts?.resumePosition===STANDALONE_REVIEWER_POSITION;
  while(true){
    // Mission 086: a queued `ap reset --scope standalone-plan-revision`
    // applies at the top of every revision-loop iteration, restarting the
    // revision budget instead of escalating. Stays queued while nothing is
    // spent or while it belongs to another mission (see
    // scripts/reset-plan-revision.mjs).
    { const restarted=applyPendingPlanRevisionReset(s,pendingResetPath());
      if(restarted!==null&&restarted!==undefined){ revision=restarted; saveState(s);
        console.log(`[autopilot] live reset applied for '${PLAN_REVISION_RESET_KEY}': revision counter restarted — continuing instead of escalating.`); } }
    if(!skipPlannerFirst){
    // Shared TASKS.md authoring contract: every task line carries a stable
    // per-phase ID (**<phase>.<task>**, e.g. **2.3** = 3rd task in Phase 2),
    // assigned in appearance order within each phase. adapters/standalone.mjs's
    // parseTasksFile()/phases() regex tolerates the ID as literal leading text
    // in task.text, so nothing downstream breaks.
    const tasksLineSuffix=(c.gates?.commands||[]).length?"; the orchestrator runs the full suite as a gate after code review, and the verifier analyses its result (backlog #27).":"; the full suite is the verifier's job after the phase (backlog #27).";
    const tasksLine="Content for TASKS.md: use \"## Phase 1: <name>\" headings and \"- [ ] **<phase>.<task>** <text> — accept: ... ; verify: ...\" one line per task (no nested bullets; fences ignored), where **<phase>.<task>** is a stable per-phase ID (e.g. **2.3** = 3rd task in Phase 2). IDs are assigned in appearance order within each phase and MUST stay stable across revisions — never renumber an existing task because another task was added/removed elsewhere in the same phase; a new task in that phase takes the next unused number. Each task must be actionable, bounded, and independently reviewable. Do not add any autopilot-requires annotation — capability needs are detected from the accept/verify text, and an unrecognized annotation fails the mission at verification. Never make running the whole test suite a task (no task whose accept/verify runs the full suite, e.g. an all-tests runner): a task's verify runs only the tests linked to that task" + tasksLineSuffix + " " + VERIFY_LENGTH_RULE + (verifyDenylistPromptNote(effectiveVerifyDenylist(c))?`\n\n${verifyDenylistPromptNote(effectiveVerifyDenylist(c))}`:"");
    // Mission 026 task 2.1: build-then-wire split rule. A task that needs
    // both a new design/helper AND its wiring into a large file is two
    // tasks, never one — the same wording is reused by the SpecKit loop
    // (task 2.2) so the both-loops regression test (task 2.3) pins one
    // canonical string across all four prompts.
    const taskSizeLine="Split build-then-wire work into two tasks: a task that needs both a new design/helper AND its wiring into a large file must be two tasks (build, then wire) — one task to build the helper/design, then a second task to wire it in — never combine both in a single task.";
    // Backlog #34a: one-session sizing rule. Every planned task must fit in
    // one implementer session — same const-use pattern as taskSizeLine above
    // so the regression test pins one canonical string across both branches.
    const oneSessionLine=taskSizingRuleText(resolveTaskSizeTargetTurns(c.policy));
    // Backlog #13: small tasks (like SpecKit). The limit counts work, not
    // tasks, so a phase may hold up to MAX_PHASE_TASKS small one-action
    // tasks; "task size wins over phase count" is the explicit top rule.
    const phaseTaskLimitLine=`Keep each phase to at most ${MAX_PHASE_TASKS} tasks; the limit counts work, not tasks — small tasks are cheap. Task size wins over phase count: when a task would break the size rule, add tasks or an extra phase rather than enlarging the task.`;
    // Merging stays ONLY for truly trivial same-file edits that still fit the
    // concrete size rule; never merge to shrink the task count.
    const mergeTasksLine="Do not create a task that only runs tests or \"regression-checks\" without changing files — verification belongs in each task's verify and in the orchestrator gate. Merge only truly trivial edits to the same file into one task when the merged task still fits the size rule; never merge tasks to reduce the task count or the number of phases.";
    const phaseBoundaryLine="Phases are cut by deliverable: a new phase is for a separate deliverable, not a separate file. Every phase costs a full test-suite gate and reviews, so put a build task and the task that wires it in the SAME phase, and write the reason for each phase boundary in PLAN.md under 'Phase boundaries'. Never trade a smaller task for fewer phases — task size wins over phase count.";
    // A mission whose TASKS.md predates this ID convention (created by an
    // older round-1 authoring pass) enters the revision loop already
    // un-numbered — "edit only what's flagged" then correctly refuses to
    // retrofit IDs onto unflagged tasks forever, and the reviewer is left
    // inferring positional labels instead of citing real ones. Detected
    // once per revision so the backfill instruction below only appears
    // when it's actually needed, never on an already-numbered file.
    const tasksFileHasIds=fs.existsSync(tasksFile) && /^\s*-\s*\[[ xX]\]\s*\*\*\d+\.\d+\*\*/m.test(fs.readFileSync(tasksFile,"utf8"));
    // Revision round (feedback non-empty): edit-in-place, not full-file
    // regeneration. Round-1 (feedback === "") keeps the from-scratch
    // authoring prompt unchanged in the branch below.
    // Mission 039 task 1.3: on continuation resumption the planner must see
    // prior dead ends + the wrap-up handoff note, otherwise it retries blindly.
    const plannerDeadEnds=readRolloverDeadEnds(s, 'task:standalone:planning:planner');
    const plannerHandoffNote=readHandoffNote(mission, 'standalone-planning-planner');
    const plannerDeadEndsText=plannerDeadEnds.length?`Prior dead ends (continuation context — do not retry blindly):\n${plannerDeadEnds.map((d)=>`- Generation ${d.generation} (${d.reason} ${d.used}/${d.limit}): ${d.tail}`).join("\n")}`:"";
    const plannerHandoffNoteText=plannerHandoffNote?`Prior planner handoff note (continuation context — continue from where it stopped):\n${plannerHandoffNote}`:"";
    // Backlog #15 part 4: the planner relay runs capped (capEnabled:true
    // below), so append the two budget-checkpoint turns at 85%/95% of the
    // planner's effective per-task turn cap to its keep-current note text.
    const _plannerEff=effectiveRoleModelFor(s,c,'planner');
    const _plannerPat=_plannerEff? (agents[_plannerEff.adapter]?.free_model_pattern ?? null) : null;
    const plannerBudgetReminder=handoffBudgetReminder(resolvePerRoleLimits('planner',c.policy,_plannerEff?{adapter:_plannerEff.adapter,model:_plannerEff.model,free_model_pattern:_plannerPat}:{}).perTaskMaxTurns);
    const prompt=feedback?[
      "Create or continue an implementation plan for this project without relying on SpecKit or GSD.",
      `Write the narrative plan to exactly: ${file}`,
      `Write the phased checklist to exactly: ${tasksFile}`,
      PLANNER_PATHS_LINE,
      PLANNER_READ_RANGE_LINE,
      `This is a REVISION round, not a fresh authoring round. Before changing anything, read the current PLAN.md and TASKS.md in full — ${file} and ${tasksFile} — this is required, not optional.`,
      findingCount>0
        ? `${findingCount} findings below are the ONLY things to change. Locate each one's exact section (PLAN.md) or numbered task (TASKS.md) and edit only that location. Do not rewrite or restate unrelated content, do not regenerate the whole file.`
        : "Edit the existing PLAN.md and TASKS.md in place: change only what the feedback below requires. Do not rewrite or restate unrelated content, do not regenerate the whole file.",
      tasksLine,
      tasksFileHasIds?"":"TASKS.md currently has no numeric task IDs yet. As part of this edit, add an ID to every existing task (not only the ones the findings below flag), using the format above, in appearance order within each phase. This is a one-time structural backfill — do not change any task's wording while doing it.",
      phaseTaskLimitLine,
      mergeTasksLine,
      phaseBoundaryLine,
      taskSizeLine,
      oneSessionLine,
      "Keep PLAN.md and TASKS.md consistent (every checklist item lives only in TASKS.md, with accept/verify inline on the same line).",
      "Do not implement production code and do not commit/push.",
      plannerDeadEndsText,
      plannerHandoffNoteText,
      `Project request/context: ${request}`,
      `Keep a hand-off note at ${handoffNoteRelPath(mission, 'standalone-planning-planner')}. OVERWRITE it (never append) at each milestone — after every important finding, before writing PLAN.md/TASKS.md — with: 1. Done — files changed (names only; details are in the worktree). 2. Found — facts the next session needs: exact file:line, function names, how the code works there. 3. Next — the exact next edit: file, line, what to change. 4. Dead ends — what you tried that did not work, and why. If your session is stopped, the next session starts from this note.${plannerBudgetReminder ? ` ${plannerBudgetReminder}` : ""}`,
      plannerEarlierRoundsText(s,STANDALONE_PLAN_FEEDBACK_KEY),
      `Plan reviewer feedback that MUST be addressed:\n${feedback}`
    ].filter(Boolean).join("\n\n"):[
      "Create or continue an implementation plan for this project without relying on SpecKit or GSD.",
      `Write the narrative plan to exactly: ${file}`,
      "Content for PLAN.md: objective, scope, constraints, risks, verification strategy. Do NOT put the checklist here.",
      `Write the phased checklist to exactly: ${tasksFile}`,
      PLANNER_PATHS_LINE,
      PLANNER_READ_RANGE_LINE,
      tasksLine,
      phaseTaskLimitLine,
      mergeTasksLine,
      phaseBoundaryLine,
      taskSizeLine,
      oneSessionLine,
      "Keep PLAN.md and TASKS.md consistent (every checklist item lives only in TASKS.md, with accept/verify inline on the same line).",
      "If artifacts already exist, preserve completed tasks and add/fix only what is missing for the request.",
      "Do not implement production code and do not commit/push.",
      plannerDeadEndsText,
      plannerHandoffNoteText,
      `Project request/context: ${request}`,
      `Keep a hand-off note at ${handoffNoteRelPath(mission, 'standalone-planning-planner')}. OVERWRITE it (never append) at each milestone — after every important finding, before writing PLAN.md/TASKS.md — with: 1. Done — files changed (names only; details are in the worktree). 2. Found — facts the next session needs: exact file:line, function names, how the code works there. 3. Next — the exact next edit: file, line, what to change. 4. Dead ends — what you tried that did not work, and why. If your session is stopped, the next session starts from this note.${plannerBudgetReminder ? ` ${plannerBudgetReminder}` : ""}`
    ].join("\n\n");
    // Always fresh, never resume: the prompt above already carries the full
    // plan file path and, on a revision, the reviewer's findings verbatim
    // (`feedback`) — nothing the planner needs is only available in a prior
    // session. Resuming would instead keep growing one session's context
    // (tool calls, old PLAN.md reads, old review findings) across every
    // revision for no benefit, which is exactly what caused one mission's
    // planner session to reach 1.26M cached input tokens.
    const planner=await relayAsync("planner",prompt,c,s,{resume:false,capEnabled:true,taskRef:'standalone-planning-planner',planRevision:revision});
    if(planner.capped){
      // Mission 031 Phase 6 task 6.2: a standalone planner cap breach is
      // a continuation event, never a failure. Consume one continuation
      // generation on the planning planner scope via the shared helper
      // (records the dead end); `continue` retries planning with the
      // same request. Exhausted allowance escalates as not-converging.
      const contScope='task:standalone:planning:planner';
      // Backlog #59 part (a): cumulative raw-token backstop rollover for
      // the planner, BEFORE the cap path below — a continuation event on
      // the SEPARATE backstop firing ledger, never the continuation
      // allowance (a backstop firing must not consume extra_sessions, and
      // must not end as not-converging).
      if(planner.capped.backstop===true||planner.capped.type==="backstop"){
        const backstop=handleRoleBackstopFiring(s,contScope,planner);
        if(backstop.escalate){
          const last=backstop.last;
          s.phase="escalated";s.step="runaway_session_escalation";
          s.phaseCheckpointError={code:"BACKSTOP_CONSECUTIVE_FIRINGS",evidence:{role:"planner",totalRawTokens:last.totalRawTokens??planner.capped.used,turns:last.turns??null,maxSingleTurnContext:last.maxSingleTurnContext??null,firings:[...backstop.firings]}};
          saveState(s);
          die(`Standalone planner fired the cumulative backstop twice in a row (${last.totalRawTokens??planner.capped.used}/${planner.capped.limit} cumulative raw tokens, ${last.turns??"?"} turns, largest single-turn context ${last.maxSingleTurnContext??"?"}). STOP — human intervention required.`);
        }
        saveState(s);
        console.log(`Planner crossed the cumulative backstop (${planner.capped.used}/${planner.capped.limit} cumulative raw tokens); continuing as backstop session ${backstop.firings.length+1}.`);
        continue;
      }
      // This generation ended WITHOUT a backstop firing, so the
      // consecutive-firing count resets (PLAN: two CONSECUTIVE firings
      // escalate — an interleaving ordinary generation breaks the streak).
      clearBackstopFirings(s,contScope);
      // Backlog #27: a queued `ap reset --scope <continuation>` applies at
      // this decision, before the next generation is consumed.
      maybeApplyPendingContinuationReset(s,contScope);
      const cont=handlePlanningContinuation(s,'planner',planner,'task:standalone:planning:planner',c.policy,'capped');
      if(!cont.allowed){
        recordLastContinuation(s,{contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-planner'});
        die(`Standalone planning did not converge after ${cont.used} capped generations (${planner.capped.type} cap ${planner.capped.used}/${planner.capped.limit}). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
      }
      // Mission 031 Phase 6 task 6b.2: no-progress stop for the planner —
      // role-appropriate progress signal is PLAN.md/TASKS.md change (mtime +
      // size + content hash via planningNoProgressTouchedFiles), never
      // touchedFiles. Runs after the continuation check.
      stopOnNoProgress(s,c,{framework:"standalone",contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-planner',touchedFiles:planningNoProgressTouchedFiles(file,tasksFile,contScope,s),checkpoint:s[CHECKPOINT_STATE_KEY],step:"standalone_planning_no_progress"});
      console.log(`Planner hit the ${planner.capped.type} cap (${planner.capped.used}/${planner.capped.limit} ${capUnitLabel(planner.capped.type)}); continuing as session ${cont.used+1} of ${cont.limit+1}.`);
      continue;
    }
    // Backlog #59 part (a): the planner run ended WITHOUT a backstop firing
    // (normal completion, or the voluntary incomplete stop below) — reset
    // the consecutive-firing count.
    clearBackstopFirings(s,'task:standalone:planning:planner');
    if(parsePlanningIncompleteSignal(planner.finalMessage ?? planner)){
      // Mission 031 Phase 6 task 6b.1: a standalone planner voluntary early
      // stop is a continuation event, never a failure. Consume one
      // continuation generation on the planning planner scope via the shared
      // helper (records the dead end); `continue` retries planning with the
      // same request. Exhausted allowance escalates as not-converging.
      const contScope='task:standalone:planning:planner';
      // Backlog #27: a queued `ap reset --scope <continuation>` applies at
      // this decision, before the next generation is consumed.
      maybeApplyPendingContinuationReset(s,contScope);
      const cont=handlePlanningContinuation(s,'planner',planner,'task:standalone:planning:planner',c.policy,'incomplete');
      if(!cont.allowed){
        recordLastContinuation(s,{contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-planner'});
        die(`Standalone planning did not converge after ${cont.used} generations (last generation stopped voluntarily as incomplete). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
      }
      // Mission 031 Phase 6 task 6b.2: no-progress stop for the planner —
      // role-appropriate progress signal is PLAN.md/TASKS.md change (mtime +
      // size + content hash via planningNoProgressTouchedFiles), never
      // touchedFiles. Runs after the continuation check.
      stopOnNoProgress(s,c,{framework:"standalone",contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-planner',touchedFiles:planningNoProgressTouchedFiles(file,tasksFile,contScope,s),checkpoint:s[CHECKPOINT_STATE_KEY],step:"standalone_planning_no_progress"});
      console.log(`Planner stopped voluntarily as incomplete; continuing as session ${cont.used+1} of ${cont.limit+1}.`);
      continue;
    }
    // Backlog #54: RATE_LIMITED short-circuits here — after the capped and
    // INCOMPLETE continuation branches above, before the status die below —
    // so the planner is never re-invoked for a rate limit.
    escalateIfRateLimited(c,s,"standalone-plan-review",planner,{fatal:die,saveState,escalatePrefix:"Standalone planner"});
    if(planner.status!=="completed" || planner.policyViolation)die("Standalone planner failed or violated relay policy.");
    if(!fs.existsSync(file))die(`Planner did not create ${file}.`);
    if(!fs.existsSync(tasksFile)){
      // Legacy fallback: planner wrote old single-file checklist into PLAN.md.
      // Auto-split now so a model trained on the old contract does not fail the mission.
      const tmpS={...s, mission};
      try{
        const r=ensureStandaloneSplit(repo, tmpS);
        if(r.migrated){ clearReviewFeedbackByPrefix(s,"standalone-task:"); clearFindingTasksByPrefix(s,"standalone-task:"); clearStaleStandaloneBudgets(s); saveState(s); }
      }catch(e){
        if(e?.code==="MIGRATION_CONFLICT") die(e.message);
        throw e;
      }
      if(!fs.existsSync(tasksFile))die(`Planner did not create ${tasksFile} (and auto-split did not produce it).`);
    }
    // TASK-14 Phase 5 task 15: explicit reviewer-pending checkpoint, set
    // immediately after the planner completes and before the reviewer call.
    // A restart in this state resumes at the reviewer with content validated
    // (reviewer stage). Left unchanged on a retryable-infra retry below.
    writeStandaloneReviewerPendingCheckpoint(s,mission);
    saveState(s);
    } else {
      // Resumed at the reviewer: the planner already wrote these files before
      // the interruption (validated above via the task 12 evaluator, content
      // digest included). Never re-invoke the planner for this iteration.
      skipPlannerFirst=false;
      if(!fs.existsSync(file))die(`Planner did not create ${file}.`);
      if(!fs.existsSync(tasksFile))die(`Planner did not create ${tasksFile} (and auto-split did not produce it).`);
    }
    // Mission 031 Phase 7 task 7.1: after a plan_reviewer cap breach the
    // wrap-up handoff note is the reviewer's resume context — quote it into
    // the next review prompt so the resumed reviewer continues from where it
    // stopped instead of re-reviewing from scratch. Best-effort: a missing
    // note renders nothing.
    const reviewerHandoffNote=readHandoffNote(mission,'standalone-planning-plan_reviewer');
    // Backlog #15 part 4: the plan_reviewer relay runs capped
    // (capEnabled:true below), so append the two budget-checkpoint turns at
    // 85%/95% of its effective per-task turn cap to its note reminder.
    const _prEff=effectiveRoleModelFor(s,c,'plan_reviewer');
    const _prPat=_prEff? (agents[_prEff.adapter]?.free_model_pattern ?? null) : null;
    const planReviewerBudgetReminder=handoffBudgetReminder(resolvePerRoleLimits('plan_reviewer',c.policy,_prEff?{adapter:_prEff.adapter,model:_prEff.model,free_model_pattern:_prPat}:{}).perTaskMaxTurns);
    const reviewPrompt=[
      "Review the standalone Autopilot plan before implementation.",
      `Plan file: ${file}` ,
      `Tasks file: ${tasksFile}`,
      "Check PLAN.md (objective/scope/risks/strategy) and TASKS.md (phased checklist, each task's accept/verify inline on the same - [ ] line, ordering/dependencies). Validate cross-file consistency.",
      REVIEWER_ALL_FINDINGS_LINE,
      "When a finding concerns a TASKS.md item, `location` MUST cite its numeric ID exactly as written in the file (e.g. 'TASKS.md 2.3'), not a description or recount of position. When a finding concerns PLAN.md, cite its existing numbered list item (e.g. 'PLAN.md Scope 4', 'PLAN.md Risks 2') or, for unnumbered sections (Objective, Constraints), the section heading.",
      "FAIL a single task that combines building a new design/helper AND wiring it into a large file — such build-then-wire work must be two tasks (build, then wire); cite the oversized task by its numeric ID exactly as written in the file (e.g. 'TASKS.md 2.3').",
      taskSizeReviewText(resolveTaskSizeTargetTurns(c.policy))+"; cite the oversized task by its numeric ID exactly as written in the file (e.g. 'TASKS.md 2.3').",
      `FAIL any phase with more than ${MAX_PHASE_TASKS} tasks, citing the phase (e.g. 'TASKS.md Phase 2'); it must be split into additional phases.`,
      "FAIL a task that changes no files (only runs tests / regression-checks), citing the task ID (e.g. 'TASKS.md 2.3'). Do NOT FAIL small tasks for being small or for not being merged — small one-action tasks are deliberate. Do not FAIL a phase merely for having few tasks: phases are cut by deliverable, and task size wins over phase count.",
      ...planReviewerRoundLines(s,STANDALONE_PLAN_FEEDBACK_KEY),
      "Do not modify either file. End with the required AUTOPILOT_REVIEW sentinel.",
      `Keep a hand-off note at ${scratchHandoffNotePath(SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, 'standalone-planning-plan_reviewer')}. OVERWRITE it (never append) at each milestone — after every important finding and before the review verdict — with: 1. Done — files changed (names only; details are in the worktree). 2. Found — facts the next session needs: exact file:line, function names, how the code works there. 3. Next — the exact next edit: file, line, what to change. 4. Dead ends — what you tried that did not work, and why. If your session is stopped, the next session starts from this note.${planReviewerBudgetReminder ? ` ${planReviewerBudgetReminder}` : ""}`,
      feedback?`Prior findings to re-check:\n${feedback}`:"",
      reviewerHandoffNote?`Prior reviewer handoff note (continuation context — continue from where it stopped):\n${reviewerHandoffNote}`:"",
      verifyDenylistPromptNote(effectiveVerifyDenylist(c))
    ].filter(Boolean).join("\n\n");
    // TASK-38: deterministic verify-denylist gate. When any task's verify
    // names an entry of the EFFECTIVE denylist
    // (effectiveVerifyDenylist(c): planning.verify_denylist plus the
    // always-forbidden full-suite runner test-all.mjs plus every
    // gates.commands entry), this counts as a plan-review FAIL WITHOUT
    // launching the reviewer: one finding per offending task, revision
    // counter spent like any FAIL, planner re-invoked with the findings.
    // Never escalates on the first hit, never touches an adapter budget
    // (no adapter ran). SpecKit runs this loop's twin (runPlanningPhase)
    // with no per-task verify field — see the comment on
    // verifyDenylistFindings; GSD is covered in runGsdPlanning.
    const standaloneVerifyEntries=standaloneTaskVerifyEntries(tasksFile);
    const standaloneTasksText=fs.existsSync(tasksFile)?fs.readFileSync(tasksFile,"utf8"):"";
    const denied=[...verifyDenylistFindings(standaloneVerifyEntries,effectiveVerifyDenylist(c)),...verifyLengthFindings(standaloneVerifyEntries),...verifyShardFindings(standaloneVerifyEntries),...phaseTaskCountFindings(standaloneTasksText),...unrecognizedAnnotationFindings(standaloneTasksText)];
    if(denied.length){
      revision++;
      const planFindings=saveReviewFeedback(s,STANDALONE_PLAN_FEEDBACK_KEY,denied);
      recordPlanReviewRound(s,STANDALONE_PLAN_FEEDBACK_KEY,planFindings);
      feedback=feedbackText(planFindings)||"Plan reviewer returned FAIL without findings.";
      findingCount=planFindings.length;
      s.standalonePlanReview={revision,findings:planFindings};
      writeStandalonePlannerPendingCheckpoint(s,mission);
      saveState(s);
      // Mission 086: a request staged during the last revision fires before
      // the cap check below, restarting the revision budget instead of
      // escalating.
      { const restarted=applyPendingPlanRevisionReset(s,pendingResetPath());
        if(restarted!==null&&restarted!==undefined){ revision=restarted; saveState(s);
          console.log(`[autopilot] live reset applied for '${PLAN_REVISION_RESET_KEY}': revision counter restarted — continuing instead of escalating.`);
          continue; } }
      if(revision>=maxRevisions){
        s.phase="escalated";s.step="standalone-plan-review-failed";saveState(s);
        die(`Standalone plan failed review after ${maxRevisions} revision(s).`);
      }
      continue;
    }
    let reviewResult=await relayAsync("plan_reviewer",reviewPrompt,c,s,{readOnly:true,review:true,resume:false,capEnabled:true,taskRef:'standalone-planning-plan_reviewer',planRevision:revision});
    if(reviewResult.policyViolation)die("Standalone plan reviewer violated relay policy.");
    if(reviewResult.capped){
      // Mission 031 Phase 7 task 7.1: a standalone plan_reviewer cap breach
      // is a continuation event, never a failure. Checked BEFORE
      // resolvePlanningReviewAttempt: a capped run exits non-zero, so the
      // retry helper would otherwise record it as an attempt failure and
      // retry/escalate under the failure budget, losing the capped marker.
      // Consume one continuation generation on the planning plan_reviewer
      // scope via the shared helper (records the dead end); `continue`
      // retries planning with the same request. Exhausted allowance
      // escalates as not-converging.
      const contScope='task:standalone:planning:plan_reviewer';
      // Backlog #59 part (a): cumulative raw-token backstop rollover for
      // the plan_reviewer, BEFORE the cap path below — a continuation event
      // on the SEPARATE backstop firing ledger, never the continuation
      // allowance.
      if(reviewResult.capped.backstop===true||reviewResult.capped.type==="backstop"){
        const backstop=handleRoleBackstopFiring(s,contScope,reviewResult);
        if(backstop.escalate){
          const last=backstop.last;
          s.phase="escalated";s.step="runaway_session_escalation";
          s.phaseCheckpointError={code:"BACKSTOP_CONSECUTIVE_FIRINGS",evidence:{role:"plan_reviewer",totalRawTokens:last.totalRawTokens??reviewResult.capped.used,turns:last.turns??null,maxSingleTurnContext:last.maxSingleTurnContext??null,firings:[...backstop.firings]}};
          saveState(s);
          die(`Standalone plan reviewer fired the cumulative backstop twice in a row (${last.totalRawTokens??reviewResult.capped.used}/${reviewResult.capped.limit} cumulative raw tokens, ${last.turns??"?"} turns, largest single-turn context ${last.maxSingleTurnContext??"?"}). STOP — human intervention required.`);
        }
        saveState(s);
        console.log(`Plan reviewer crossed the cumulative backstop (${reviewResult.capped.used}/${reviewResult.capped.limit} cumulative raw tokens); continuing as backstop session ${backstop.firings.length+1}.`);
        continue;
      }
      // This generation ended WITHOUT a backstop firing, so the
      // consecutive-firing count resets (PLAN).
      clearBackstopFirings(s,contScope);
      // Backlog #27: a queued `ap reset --scope <continuation>` applies at
      // this decision, before the next generation is consumed.
      maybeApplyPendingContinuationReset(s,contScope);
      const cont=handlePlanningContinuation(s,'plan_reviewer',reviewResult,'task:standalone:planning:plan_reviewer',c.policy,'capped');
      if(!cont.allowed){
        recordLastContinuation(s,{contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-plan_reviewer'});
        die(`Standalone planning did not converge after ${cont.used} capped generations (${reviewResult.capped.type} cap ${reviewResult.capped.used}/${reviewResult.capped.limit}). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
      }
      console.log(`Plan reviewer hit the ${reviewResult.capped.type} cap (${reviewResult.capped.used}/${reviewResult.capped.limit} ${capUnitLabel(reviewResult.capped.type)}); continuing as session ${cont.used+1} of ${cont.limit+1}.`);
      // Resume at the reviewer: the planner output is unchanged and the
      // reviewer-pending checkpoint (written after the planner) is still
      // current, so skip the planner next iteration and re-invoke only the
      // reviewer with the wrap-up note quoted into its prompt above.
      skipPlannerFirst=true;
      continue;
    }
    // Backlog #59 part (a): the plan_reviewer run ended WITHOUT a backstop
    // firing (normal completion, or the voluntary incomplete stop below) —
    // reset the consecutive-firing count.
    clearBackstopFirings(s,'task:standalone:planning:plan_reviewer');
    // Mission 031 Phase 9 task 7b.1: voluntary early stop — the reviewer
    // returned the INCOMPLETE signal (see parseIncompleteSignal, Phase 3
    // task 3.4). A continuation event, never a failure. Checked BEFORE
    // resolvePlanningReviewAttempt: INCOMPLETE carries no failure marker,
    // so the retry helper would otherwise record INTERNAL_CONTRACT_ERROR
    // and retry/escalate under the failure budget. Consume one
    // continuation generation on the planning plan_reviewer scope via the
    // shared helper (records the dead end with reason "incomplete");
    // `continue` retries planning with the same request. Exhausted
    // allowance escalates as not-converging.
    if(parseIncompleteSignal(reviewResult.review ?? reviewResult)){
      const contScope='task:standalone:planning:plan_reviewer';
      // Backlog #27: a queued `ap reset --scope <continuation>` applies at
      // this decision, before the next generation is consumed.
      maybeApplyPendingContinuationReset(s,contScope);
      const cont=handlePlanningContinuation(s,'plan_reviewer',reviewResult,'task:standalone:planning:plan_reviewer',c.policy,'incomplete');
      if(!cont.allowed){
        recordLastContinuation(s,{contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-plan_reviewer'});
        die(`Standalone planning did not converge after ${cont.used} incomplete generations. STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
      }
      console.log(`Plan reviewer stopped early (incomplete); continuing as session ${cont.used+1} of ${cont.limit+1}.`);
      // Resume at the reviewer: the planner output is unchanged, same as
      // the capped branches above.
      skipPlannerFirst=true;
      continue;
    }
    // Backlog #54: RATE_LIMITED short-circuits here — after the capped and
    // INCOMPLETE continuation branches above, before the wiring call below —
    // so the planner is never re-invoked for a rate limit.
    escalateIfRateLimited(c,s,"standalone-plan-review",reviewResult,{fatal:die,saveState,escalatePrefix:"Standalone plan review"});
    // TASK-14 Evidence call site 1: retryable adapter/infrastructure failures
    // retry the reviewer only (fresh session, revision counter untouched,
    // checkpoint position stays "reviewer-pending"); non-retryable ones
    // escalate naming class/domain; functional/output-contract outcomes flow
    // through to the unchanged revision behavior below with nothing recorded.
    reviewResult=await resolvePlanningReviewAttempt(c,s,"standalone-plan-review",reviewResult,
      ()=>relayAsync("plan_reviewer",reviewPrompt,c,s,{readOnly:true,review:true,resume:false,capEnabled:true,taskRef:'standalone-planning-plan_reviewer',planRevision:revision}),
      {policyMessage:"Standalone plan reviewer violated relay policy.",escalatePrefix:"Standalone plan review"});
    if(reviewResult.capped){
      // Mission 031 Phase 7 task 7.1: a capped reviewer retry (the retry
      // lambda above re-invokes the same cap-guarded call) that passes
      // through the retry helper untouched still carries the capped marker —
      // treat it as a continuation event exactly like the pre-helper branch.
      const contScope='task:standalone:planning:plan_reviewer';
      // Backlog #59 part (a): cumulative raw-token backstop rollover for
      // the plan_reviewer, BEFORE the cap path below — a continuation event
      // on the SEPARATE backstop firing ledger, never the continuation
      // allowance.
      if(reviewResult.capped.backstop===true||reviewResult.capped.type==="backstop"){
        const backstop=handleRoleBackstopFiring(s,contScope,reviewResult);
        if(backstop.escalate){
          const last=backstop.last;
          s.phase="escalated";s.step="runaway_session_escalation";
          s.phaseCheckpointError={code:"BACKSTOP_CONSECUTIVE_FIRINGS",evidence:{role:"plan_reviewer",totalRawTokens:last.totalRawTokens??reviewResult.capped.used,turns:last.turns??null,maxSingleTurnContext:last.maxSingleTurnContext??null,firings:[...backstop.firings]}};
          saveState(s);
          die(`Standalone plan reviewer fired the cumulative backstop twice in a row (${last.totalRawTokens??reviewResult.capped.used}/${reviewResult.capped.limit} cumulative raw tokens, ${last.turns??"?"} turns, largest single-turn context ${last.maxSingleTurnContext??"?"}). STOP — human intervention required.`);
        }
        saveState(s);
        console.log(`Plan reviewer crossed the cumulative backstop (${reviewResult.capped.used}/${reviewResult.capped.limit} cumulative raw tokens); continuing as backstop session ${backstop.firings.length+1}.`);
        continue;
      }
      // This generation ended WITHOUT a backstop firing, so the
      // consecutive-firing count resets (PLAN).
      clearBackstopFirings(s,contScope);
      // Backlog #27: a queued `ap reset --scope <continuation>` applies at
      // this decision, before the next generation is consumed.
      maybeApplyPendingContinuationReset(s,contScope);
      const cont=handlePlanningContinuation(s,'plan_reviewer',reviewResult,'task:standalone:planning:plan_reviewer',c.policy,'capped');
      if(!cont.allowed){
        recordLastContinuation(s,{contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-plan_reviewer'});
        die(`Standalone planning did not converge after ${cont.used} capped generations (${reviewResult.capped.type} cap ${reviewResult.capped.used}/${reviewResult.capped.limit}). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
      }
      console.log(`Plan reviewer hit the ${reviewResult.capped.type} cap (${reviewResult.capped.used}/${reviewResult.capped.limit} ${capUnitLabel(reviewResult.capped.type)}); continuing as session ${cont.used+1} of ${cont.limit+1}.`);
      // Resume at the reviewer (same as the pre-helper branch above).
      skipPlannerFirst=true;
      continue;
    }
    // Backlog #59 part (a): the retried plan_reviewer run ended WITHOUT a
    // backstop firing — reset the consecutive-firing count.
    clearBackstopFirings(s,'task:standalone:planning:plan_reviewer');
    // Mission 031 Phase 7 task 7.1: the reviewer finished without being
    // capped (PASS or FAIL below), so its wrap-up handoff note — if any —
    // is stale resume context. Clear it now, before the PASS break or the
    // FAIL planner-revision continue, so the next review prompt (including
    // reviews of planner-revised PLAN.md/TASKS.md and later planning runs)
    // never quotes a stale "continue from where it stopped" note.
    clearHandoffNote(mission,'standalone-planning-plan_reviewer');
    if(reviewResult.status==="completed" && reviewResult.review?.decision==="PASS"){
      // A PASS must not leave the previous FAIL's findings readable by a
      // later resume, which would re-feed stale corrections into a plan
      // that has since been accepted.
      clearReviewFeedback(s,STANDALONE_PLAN_FEEDBACK_KEY);
      clearPlanReviewHistory(s,STANDALONE_PLAN_FEEDBACK_KEY);
      clearFindingTasks(s,STANDALONE_PLAN_FEEDBACK_KEY);
      delete s.standalonePlanReview;
      // TASK-14 Phase 5 task 15: cleared on PASS in the SAME state-save call
      // that processes it — a kill between this save and the function
      // returning still restarts with the checkpoint already cleared.
      delete s.standalonePlanningReviewCheckpoint;
      saveState(s);
      state=standalone.state(repo,mission);
      break;
    }
    revision++;
    const planFindings=saveReviewFeedback(s,STANDALONE_PLAN_FEEDBACK_KEY,reviewResult.review?.findings||[]);
    recordPlanReviewRound(s,STANDALONE_PLAN_FEEDBACK_KEY,planFindings,reviewResult.review?.previous);noteEscalationTrigger(s,c,"planner",STANDALONE_PLAN_FEEDBACK_KEY,"plan_reviewer",reviewResult.review?.previous);
    feedback=feedbackText(planFindings) || "Plan reviewer returned FAIL without findings.";
    findingCount=planFindings.length;
    s.standalonePlanReview={revision,findings:planFindings};
    // TASK-14 Phase 5 task 15: set to planner-pending ONLY by this transition
    // logic, when a call-site outcome that today already returns to the
    // planner occurs (functional FAIL or uncaught output-contract failure —
    // both reach here via passthrough with nothing recorded). Content is NOT
    // validated on resume from this position (writable stage — only
    // version/identity/paths). A retryable-infra retry never reaches here
    // (handled inside resolvePlanningReviewAttempt with position unchanged).
    // On revision exhaustion the mission escalates instead of returning to
    // the planner in this process — but a same-request resume must still
    // re-invoke the Planner with the persisted findings and re-run plan
    // review, never skip to the reviewer (reviewer-pending) or adopt the
    // rejected plan as complete. So the checkpoint is overwritten to
    // planner-pending here as well: resume validates only
    // version/identity/paths (never content) and runStandalonePlanning
    // starts at the planner whose revision-round prompt quotes the findings
    // saved above, with the restored revision count keeping the budget spent.
    writeStandalonePlannerPendingCheckpoint(s,mission);
    saveState(s);
    // Mission 086: a request staged during the last revision fires before
    // the cap check below, restarting the revision budget instead of
    // escalating.
    { const restarted=applyPendingPlanRevisionReset(s,pendingResetPath());
      if(restarted!==null&&restarted!==undefined){ revision=restarted;
        feedback=feedbackText(loadReviewFeedback(s,STANDALONE_PLAN_FEEDBACK_KEY))||feedback;
        findingCount=loadReviewFeedback(s,STANDALONE_PLAN_FEEDBACK_KEY).length||findingCount;
        saveState(s);
        console.log(`[autopilot] live reset applied for '${PLAN_REVISION_RESET_KEY}': revision counter restarted — continuing instead of escalating.`);
        continue; } }
    if(revision>=maxRevisions){
      s.phase="escalated";s.step="standalone-plan-review-failed";saveState(s);
      die(`Standalone plan failed review after ${maxRevisions} revision(s).`);
    }
  }
  if(state.status==="ambiguous" || state.status==="missing")die(`Standalone plan is not executable: ${state.reason}`);
  { const dg=planningArtifactDigest(file,tasksFile);
    s.planningStateReview={status:"passed",framework:"standalone",at:now(),...(dg?{artifactDigest:dg}:{})}; }
  s.phase="tasks_ready";s.step="tasks_ready";saveState(s);
  return state;
}

const STEP_LABELS={
  specify:"Spec",
  "review-spec":"Spec Review",
  plan:"Plan",
  "review-plan":"Plan Review",
  tasks:"Tasks",
  "review-tasks":"Tasks Review",
  implement:"Implementation"
};
function roleStepLine(c,roleName){
  const role=c.roles?.[roleName];
  if(!role) return "";
  const a=agents[role.adapter];
  const parts=[`  ${roleName==="plan_reviewer"?"Reviewer":"Planner"}: ${a?.binary||role.adapter}`];
  if(role.model) parts.push(`  Model: ${role.model}`);
  return parts.join("\n");
}
async function runSpecKitPlanning(c,s,request,opts={}){
  const gateResume=opts.gateReviewResume||null;
  const info=speckit.inspect(repo);
  const steps=info.steps;
  const start=Math.max(0,Number(s.planningStepIndex||0));
  const total=steps.length;
  const persistDetectedMission=(st)=>{
    // Once the specify step has created the feature dir for the current
    // planning session, adopt its NAME (number stripped) and unify the mission
    // folder to `<seq>-<name>` — the mission's own sequence, independent of
    // the spec's number. If a provisional mission folder exists under a
    // different name, it is renamed early (before implementation accumulates).
    const started=new Date(st.planningStartedAt||0).getTime();
    if(!started) return;
    const specsRoot=path.join(repo,"specs");
    if(!fs.existsSync(specsRoot)) return;
    let best=null, bestTime=0;
    for(const d of fs.readdirSync(specsRoot)){
      const dir=path.join(specsRoot,d);
      if(!fs.statSync(dir).isDirectory()) continue;
      let t=fs.statSync(dir).mtimeMs;
      const specFile=path.join(dir,"spec.md");
      if(fs.existsSync(specFile)) t=Math.max(t,fs.statSync(specFile).mtimeMs);
      if(t>=started-5000 && t>bestTime){ bestTime=t; best=d; }
    }
    if(!best) return;
    const name=stripSpecNumber(best);
    const seq=st.missionSeq||missionSeqOf(st.mission)||existingMissionSeqForName(repo,name)||String(nextMissionSeq(repo));
    const unified=sanitizeMissionName(`${seq}-${name}`);
    if(st.mission===unified){ st.missionSeq=seq; saveState(st); return; }
    if(st.mission){
      const oldDir=path.join(repo,".autopilot","missions",sanitizeMissionName(st.mission));
      const newDir=path.join(repo,".autopilot","missions",unified);
      if(fs.existsSync(oldDir) && !fs.existsSync(newDir)){
        fs.renameSync(oldDir,newDir);
        migrationLog(repo,`renamed mission folder ${st.mission} -> ${unified} (unified to spec name ${best})`);
      }
    }
    st.mission=unified;
    st.missionSeq=seq;
    saveState(st);
  };
  for(let idx=start; idx<steps.length; idx++){
    const step=steps[idx];
    const label=STEP_LABELS[step.id]||step.id;
    s.planningStepIndex=idx; saveState(s);
    const n=idx+1;
    if(step.type==="gate"){
      console.log(`\n[${n}/${total}] ${label}`);
      console.log(roleStepLine(c,"plan_reviewer"));
      s.step=step.id; saveState(s);
      console.log("  Status: reviewing...");
      // TASK 15.6F: the review-tasks gate additionally enforces the phase
      // observability contract (prompt-only guidance; the die() paths below
      // are what actually stop an invalid tasks.md from reaching
      // implementation). Other gates and frameworks are untouched.
      const tasksGateNote = String(step.id||"").includes("tasks")
        ? "\nAdditionally, enforce the phase-observability contract on the tasks artifact: every '## Phase N' section must be implementable into at least one Git-observable file addition, modification, or deletion. FAIL the gate if any phase can produce no Git-observable file change — for example a phase whose only task is creating an empty directory (Git cannot represent empty directories, so such a phase could never be code-reviewed or verified), or a phase of only reads, checks, or planning notes with no persistent file output. Setup phases that modify observable files (package.json, configuration, source files, documentation) satisfy this contract and must not fail it. FAIL a single task that combines building a new design/helper AND wiring it into a large file — such build-then-wire work must be two tasks (build, then wire); cite the oversized task by its ID exactly as written in the file (e.g. 'T001'). "+taskSizeReviewText(resolveTaskSizeTargetTurns(c.policy))+`; cite the oversized task by its ID exactly as written in the file (e.g. 'T001'). FAIL any phase with more than ${MAX_PHASE_TASKS} tasks, citing the phase; it must be split into additional phases.`
        : "";
      // The planning stage this gate governs. Computed for BOTH outcomes,
      // not just the failing one: a FAIL persists its findings against this
      // stage, and a PASS has to be able to clear them again.
      const gateStage=(idx===0 || step.id.includes("spec")) ? "specify"
        : step.id.includes("tasks") ? "tasks"
        : "plan";
      // TASK-14 Phase 6 task 19: the substage this run was restarted in, for
      // THIS gate only. The evaluator already bound the checkpoint to its own
      // gate id/index before this loop was entered, so a substage naming
      // another gate can never apply here.
      const resumeSubstage=(gateResume && gateResume.gateIndex===idx)?gateResume.substage:null;
      const resumingAtPlannerRevision=resumeSubstage===SPECKIT_PLANNER_REVISION;
      const resumingAtReReview=resumeSubstage===SPECKIT_POST_REVISION_REVIEW;
      const initialReviewPrompt=
        `Review the current artifact state at the SpecKit gate "${step.id}".
Message: ${step.message||""}${tasksGateNote}
${REVIEWER_ALL_FINDINGS_LINE}
${planReviewerRoundLines(s,speckitStageFeedbackKey(gateStage)).join("\n")}
Return PASS or FAIL with findings.`;
      let rr;
      if(resumingAtPlannerRevision || resumingAtReReview){
        // Restarted inside the revision block: the initial review already ran
        // and failed before the interruption, and its findings are persisted
        // against this stage. Re-running it would pay again for a review the
        // crash already completed — and planner_revision names the Planner as
        // the position to resume at, so the reviewer must not run first.
        rr={status:"completed",review:{decision:"FAIL",findings:loadReviewFeedback(s,speckitStageFeedbackKey(gateStage))}};
      } else {
        // TASK-14 Phase 6 task 19: initial_review — written before the first
        // review call, so a crash during that review resumes here with the
        // recorded content digest validated.
        writeSpeckitGateCheckpoint(s,{feature:s.speckitFeatureDir,gate:step.id,gateIndex:idx,substage:SPECKIT_INITIAL_REVIEW});
        saveState(s);
        // Mission 038 task 1.4: deterministic SpecKit tasks-text denylist
        // gate. SpecKit tasks carry no per-task `verify` field, so the gate
        // scans each tasks.md task line's full text for a forbidden command
        // span (test-all.mjs or any gates.commands entry). On findings this
        // counts as a plan-review FAIL WITHOUT launching the reviewer: the
        // synthesized rr flows into the existing saveReviewFeedback +
        // planner_revision checkpoint + runPlanningPhase revision path below.
        if(gateStage==="tasks" && s.speckitFeatureDir){
          let tasksMdText="";
          try{ tasksMdText=fs.readFileSync(path.join(repo,"specs",s.speckitFeatureDir,"tasks.md"),"utf8"); }catch{ tasksMdText=""; }
          const denied=[...speckitTaskDenylistFindings(tasksMdText,effectiveVerifyDenylist(c)),...speckitTaskVerifyLengthFindings(tasksMdText),...speckitTaskVerifyShardFindings(tasksMdText)];
          if(denied.length){
            // Render to strings here: reReviewPrompt below joins
            // rr.review.findings, and raw objects would reach the
            // post-revision reviewer as "[object Object]".
            const deniedText=denied.map(f=>`${f.location}: ${f.problem} — ${f.correction}`);
            rr={status:"completed",review:{decision:"FAIL",findings:deniedText},failure:failure("PLANNING_REJECTED","planning",true,deniedText)};
          } else {
            rr=await review("plan_reviewer",initialReviewPrompt,c,s);
          }
        } else {
          rr=await review("plan_reviewer",initialReviewPrompt,c,s);
        }
        if(rr.policyViolation){
          die(`SpecKit gate ${step.id} reviewer violated read-only relay policy.`);
        }
        // TASK-14 Evidence call site 2 (the initial_review position): the same
        // classify-then-record-then-decide contract as call site 1 — retryable
        // adapter/infrastructure failures retry this review call only (fresh
        // session; review() already passes resume:false), non-retryable ones
        // escalate naming class/domain, and functional/output-contract outcomes
        // flow through to the unchanged revision behavior below with nothing
        // recorded.
        // Backlog #54: RATE_LIMITED short-circuits here — before the wiring call
        // below — so no saveReviewFeedback/planner_revision checkpoint write
        // and no runPlanningPhase revision.
        escalateIfRateLimited(c,s,"speckit-gate-review",rr,{fatal:die,saveState,escalatePrefix:`SpecKit gate ${step.id} plan review`});
        rr=await resolvePlanningReviewAttempt(c,s,"speckit-gate-review",rr,
          ()=>review("plan_reviewer",initialReviewPrompt,c,s),
          {policyMessage:`SpecKit gate ${step.id} reviewer violated read-only relay policy.`,escalatePrefix:`SpecKit gate ${step.id} plan review`});
      }
      // Mission 031 Phase 3 task 3.5: INCOMPLETE-as-FAIL (no continuation): speckit-gate-initial-review has no continuation loop — an INCOMPLETE decision is treated as FAIL with explicit reason and never consumes a continuation.
      if(rr.review?.decision==="INCOMPLETE") console.log(`SpecKit gate ${step.id} initial plan review INCOMPLETE treated as FAIL (no continuation).`);
      if(rr.status!=="completed" || rr.review?.decision!=="PASS") {
        // TASK-14 Phase 6 tasks 19-20: resuming at post_revision_review skips
        // the whole revision — the Planner already produced the revised
        // artifacts before the interruption — and this gate still grants no
        // second revision, so a FAIL on the re-review below escalates exactly
        // as it does today.
        if(!resumingAtReReview){
          console.log(`  FAIL — revising ${label}`);
          // Backlog #54: RATE_LIMITED re-check before spending a gate revision —
          // the pre-wiring guard above already escalates, so this never fires in
          // practice; it guarantees no saveReviewFeedback/planner_revision
          // checkpoint write and no runPlanningPhase call for a rate limit.
          escalateIfRateLimited(c,s,"speckit-gate-review",rr,{fatal:die,saveState,escalatePrefix:`SpecKit gate ${step.id} plan review`});
          // The gate reviewer's findings used to be dropped entirely here: the
          // revising Planner was re-run with the SAME prompt as the original
          // attempt and never told what the gate rejected, so it could only
          // guess or go read the review out of runs/. Persist them against the
          // stage about to be revised, so runPlanningPhase() can quote them
          // and a resume mid-revision still has them.
          saveReviewFeedback(s,speckitStageFeedbackKey(gateStage),rr.review?.findings||[]);
          recordPlanReviewRound(s,speckitStageFeedbackKey(gateStage),rr.review?.findings||[],rr.review?.previous);noteEscalationTrigger(s,c,"planner",speckitStageFeedbackKey(gateStage),"plan_reviewer",rr.review?.previous);
          saveState(s);
          // planner_revision: written immediately before the between-reviews
          // Planner call. Content is NOT validated on resume (writable stage —
          // only version/identity/paths), which is what makes a crash here
          // resume at the Planner instead of jumping to the reviewer.
          writeSpeckitGateCheckpoint(s,{feature:s.speckitFeatureDir,gate:step.id,gateIndex:idx,substage:SPECKIT_PLANNER_REVISION});
          saveState(s);
          await runPlanningPhase(c,gateStage,request,s);
          persistDetectedMission(s);
          s.planningStepIndex=idx; saveState(s);
          // post_revision_review: written before the re-review call, after the
          // Planner's revision completed — a reviewer stage, so the content
          // digest is recorded and validated on resume.
          writeSpeckitGateCheckpoint(s,{feature:s.speckitFeatureDir,gate:step.id,gateIndex:idx,substage:SPECKIT_POST_REVISION_REVIEW});
          saveState(s);
        }
        const reReviewPrompt=`Re-review the SpecKit gate "${step.id}" after revision.\n${rr.review?.findings?.join("\n")||""}${tasksGateNote}\n${planReviewerRoundLines(s,speckitStageFeedbackKey(gateStage)).join("\n")}\n${REVIEWER_ALL_FINDINGS_LINE}`;
        // Mission 038 task 1.4: re-run the deterministic tasks-text scan on
        // the REVISED tasks.md before paying for another reviewer call. A
        // revision that still runs a forbidden command fails
        // deterministically (same string rendering as the initial gate); a
        // clean revision falls through to the re-review above.
        let deterministicRetry=null;
        if(gateStage==="tasks" && s.speckitFeatureDir){
          let revisedText="";
          try{ revisedText=fs.readFileSync(path.join(repo,"specs",s.speckitFeatureDir,"tasks.md"),"utf8"); }catch{ revisedText=""; }
          const stillDenied=[...speckitTaskDenylistFindings(revisedText,effectiveVerifyDenylist(c)),...speckitTaskVerifyLengthFindings(revisedText),...speckitTaskVerifyShardFindings(revisedText)];
          if(stillDenied.length){
            const stillDeniedText=stillDenied.map(f=>`${f.location}: ${f.problem} — ${f.correction}`);
            deterministicRetry={status:"completed",review:{decision:"FAIL",findings:stillDeniedText},failure:failure("PLANNING_REJECTED","planning",true,stillDeniedText)};
          }
        }
        let retry=deterministicRetry||await review("plan_reviewer",reReviewPrompt,c,s);
        // Backlog #54: RATE_LIMITED short-circuits here — before the re-review
        // wiring call below — so the planner is never re-invoked for a rate limit.
        escalateIfRateLimited(c,s,"speckit-gate-review",retry,{fatal:die,saveState,escalatePrefix:`SpecKit gate ${step.id} plan re-review`});
        // TASK-14 Evidence call site 3 (the post_revision_review position):
        // the same classify-then-record-then-decide contract as call sites
        // 1-2 — retryable adapter/infrastructure failures retry this
        // re-review call only (fresh session; review() already passes
        // resume:false), granting zero additional revisions; non-retryable
        // ones escalate naming class/domain; functional/output-contract
        // outcomes ("passthrough" — no revision left at this position) flow
        // through to the unchanged immediate die() below with nothing
        // recorded.
        retry=await resolvePlanningReviewAttempt(c,s,"speckit-gate-review",retry,
          ()=>review("plan_reviewer",reReviewPrompt,c,s),
          {policyMessage:`SpecKit gate ${step.id} reviewer violated read-only relay policy.`,escalatePrefix:`SpecKit gate ${step.id} plan re-review`});
        // Mission 031 Phase 3 task 3.5: INCOMPLETE-as-FAIL (no continuation): speckit-gate-re-review has no continuation loop — an INCOMPLETE decision is treated as FAIL with explicit reason and never consumes a continuation.
        if(retry.review?.decision==="INCOMPLETE") console.log(`SpecKit gate ${step.id} plan re-review INCOMPLETE treated as FAIL (no continuation).`);
        if(retry.status!=="completed" || retry.review?.decision!=="PASS") {
          if(!s.speckitPlanningCheckpoint) s.speckitPlanningCheckpoint={};
          s.speckitPlanningCheckpoint={step:step.id,index:idx,failedAt:now()};
          // Keep the RE-review's findings (fresher than the ones that drove
          // the revision) so the resumed run revises against the latest
          // verdict rather than the superseded one.
          saveReviewFeedback(s,speckitStageFeedbackKey(gateStage),retry.review?.findings||[]);
          recordPlanReviewRound(s,speckitStageFeedbackKey(gateStage),retry.review?.findings||[],retry.review?.previous);noteEscalationTrigger(s,c,"planner",speckitStageFeedbackKey(gateStage),"plan_reviewer",retry.review?.previous);
          // 023 Phase 2 task 2.2 (standalone 2.1 twin): on gate exhaustion
          // the mission escalates instead of returning to the planner in
          // this process — but a same-request resume must still re-invoke
          // the Planner with the persisted findings and re-run gate review,
          // never just re-run the re-review (post_revision_review) or adopt
          // the rejected artifacts as complete. So the checkpoint is
          // overwritten to planner_revision here as well: resume validates
          // only version/identity/paths (never content) and the gate loop
          // restarts at the Planner whose revision-round prompt quotes the
          // findings saved above.
          writeSpeckitGateCheckpoint(s,{feature:s.speckitFeatureDir,gate:step.id,gateIndex:idx,substage:SPECKIT_PLANNER_REVISION});
          saveState(s);
          die(`SpecKit gate ${step.id} failed.`);
        }
      }
      // Reached only when this gate passed — on the first attempt or after a
      // revision. Both must leave the stage clean. Clearing only on the
      // post-revision PASS was the gap: a gate that failed, was revised, died
      // on re-review, then passed on the FIRST attempt of the resumed run
      // took this path and left the dead findings in state.json, where the
      // next Planner to run this stage would be told the reviewer had
      // REJECTED an attempt that has since been accepted.
      clearReviewFeedback(s,speckitStageFeedbackKey(gateStage));
      clearPlanReviewHistory(s,speckitStageFeedbackKey(gateStage));
      clearFindingTasks(s,speckitStageFeedbackKey(gateStage));
      // TASK-14 Phase 6 task 19: cleared the moment THIS gate reaches PASS —
      // not only at the end of the whole planning loop — so a crash after a
      // passed gate can never resume into it.
      delete s.speckitGateReviewCheckpoint;
      saveState(s);
      console.log(`  ✓ PASS`);
      continue;
    }
    if(step.command){
      console.log(`\n[${n}/${total}] ${label}`);
      console.log(roleStepLine(c,"planner"));
      console.log("  Status: running...");
      if(step.id.includes("specify")) await runPlanningPhase(c,"specify",request,s);
      else if(step.id.includes("plan")) await runPlanningPhase(c,"plan",request,s);
      else if(step.id.includes("tasks")) await runPlanningPhase(c,"tasks",request,s);
      else if(step.id.includes("implement")) break; // Autopilot owns implementation.
      else await runPlanningPhase(c,step.id,request,s);
      persistDetectedMission(s);
      console.log(`  ✓ ${label} ready`);
    }
  }
  delete s.speckitPlanningCheckpoint;
  s.phase="tasks_ready";s.step="tasks_ready";saveState(s);
}

function gsdPlanningReviewPrompt(stage, phase, request, findings=""){
  return [
    `Review the GSD planning stage "${stage}" for ${phase || "the current project"}.`,
    "You are read-only. Do not edit planning artifacts. Do not implement code. Do not commit/push.",
    "Review the actual current .planning artifacts on disk, not assumptions.",
    "Check internal consistency, requirements coverage, scope, dependencies, sequencing, testability, and readiness for the next GSD planning stage.",
    stage === "research" ? "Research review: verify that research is relevant, evidence-backed, and answers the phase's key unknowns before planning." : "",
    stage === "discuss" ? "Discuss review: verify implementation decisions/constraints are explicit enough to plan without unresolved ambiguity." : "",
    stage === "plan" ? "Plan review: verify every generated PLAN is atomic, executable in a fresh context, has correct dependencies/files/verification, and collectively achieves the phase goal." : "",
    stage === "plan-check" ? "Plan-check review: independently challenge the saved plans and identify any blocking gap before execution." : "",
    findings ? `Prior findings to re-check:\n${findings}` : "",
    "Return exactly one AUTOPILOT_REVIEW JSON sentinel with decision PASS or FAIL and concise findings."
  ].filter(Boolean).join("\n\n");
}

async function gsdPlanningStage(c,s,{stage,phase,request,resume=false}){
  s.phase="planning"; s.step=`gsd-${stage}`; s.gsdPhase=phase||null; saveState(s);
  // Phase 9 task 9.1: absolute sandbox-visible GSD artifact paths cited in
  // the prompt itself, so PLANNER_PATHS_LINE's "read the exact paths above"
  // resolves to real paths.
  const gsdRootAbs=path.join(repo,gsdPhaseRoot(c));
  const gsdPhaseAbs=phase?path.join(repo,gsdPhaseRoot(c),phase):path.join(repo,gsdPhaseRoot(c),"<phase>");
  const gsdPathsLine=`GSD artifact paths (absolute, sandbox-visible): planning dir: ${gsdRootAbs}; target phase dir: ${gsdPhaseAbs}.`;
  const prompt=[
    `Run the GSD planning stage: ${stage}.`,
    phase ? `Target phase: ${phase}` : "Target: current milestone/project planning.",
    "Use the installed GSD Core commands/skills and the project's real .planning artifacts.",
    gsdPathsLine,
    PLANNER_PATHS_LINE,
    stage === "research" ? "Perform the phase research work and produce/update the GSD research artifact. Do not implement production code." : "",
    stage === "discuss" ? "Capture or refine the implementation decisions/context needed by the next planning step. Do not implement production code." : "",
    stage === "plan" ? "Run the GSD plan-phase workflow for the target phase. It must produce the native PLAN.md artifacts and preserve GSD-native structure." : "",
    "Do not commit or push.",
    `Project request/context:\n${request}`
  ].filter(Boolean).join("\n\n");
  const r=await relayAsync("planner",prompt,c,s,{readOnly:false,resume});
  if(r.status!=="completed" || r.policyViolation)die(`GSD planning stage ${stage} failed or violated relay policy.`);
  return r;
}

async function reviewGsdPlanningStage(c,s,stage,phase,request,previousFindings=""){
  const rr=await relayAsync("plan_reviewer",
    gsdPlanningReviewPrompt(stage,phase,request,previousFindings),
    c,s,{readOnly:true,review:true});
  if(rr.status==="completed" && !rr.policyViolation && rr.review?.decision==="PASS") return rr;
  return rr;
}

async function runGsdPlanning(c,s,request){
  const info=gsd.inspect(repo,gsdPhaseRoot(c));
  if(!info.detected)die("GSD artifacts not detected.");

  const maxRevisions=Math.max(1,Number(c.policy?.max_plan_revisions||8));
  const nativePath=path.join(repo,".planning","config.json");
  let native={};
  if(fs.existsSync(nativePath)){
    try{native=JSON.parse(read(nativePath));}catch{native={};}
  }
  const workflow=native.workflow||{};
  const localPlanningReview=c.planning?.gsd?.planning_review || {};
  const planReviewEnabled=workflow.plan_review_convergence!==false && c.workflow?.planReview!==false && c.workflow?.gsdPlanningReview!==false && localPlanningReview.enabled!==false;
  const runResearch=workflow.research!==false;
  const detected=gsdState(repo,gsd.inspect(repo,gsdPhaseRoot(c)));
  const current=detected.phase || gsd.currentPhase(repo,gsdPhaseRoot(c));
  const phase=current || gsd.nextPendingPhase(repo,null,gsdPhaseRoot(c)) || null;

  // GSD's planning pipeline is: Discuss/Context -> Research -> Plan -> Plan-check.
  // Autopilot adds an independent read-only reviewer after each stage and replans on failure.
  const stages=[];
  const configuredStages=Array.isArray(localPlanningReview.stages)&&localPlanningReview.stages.length
    ? localPlanningReview.stages : ["discuss","research","plan","plan-check"];
  const detectedEntry=detected.entryStage||(!current?"discuss":"research");
  const order={discuss:0,research:1,plan:2,"plan-check":3,execute:4};
  const startOrder=order[detectedEntry]??0;
  if(configuredStages.includes("discuss") && startOrder<=0 && phase) stages.push("discuss");
  if(runResearch && phase && configuredStages.includes("research") && startOrder<=1) stages.push("research");
  if(phase && configuredStages.includes("plan") && startOrder<=2) stages.push("plan");

  for(const stage of stages){
    let revision=0;
    let lastFindings="";
    const stageMaxRevisions=Math.max(1,Number(localPlanningReview.max_revisions||maxRevisions));
    const checkpointKey=`gsd-plan-${stage}-${phase||"project"}`;
    if(s.planningCheckpoints?.[checkpointKey]?.status==="passed") continue;

    while(true){
      // Always fresh: `request` already carries the reviewer's findings
      // appended verbatim on every revision (below), so nothing the planner
      // needs is resume-only. Same fix as the standalone plan loop — resuming
      // here would otherwise let one GSD planning session's context grow
      // across every revision for no benefit.
      await gsdPlanningStage(c,s,{stage,phase,request,resume:false});

      if(!planReviewEnabled){
        if(!s.planningCheckpoints)s.planningCheckpoints={};
        s.planningCheckpoints[checkpointKey]={status:"passed",stage,phase,at:now()}; saveState(s);
        break;
      }

      // TASK-38: deterministic verify-denylist gate on GSD plan tasks
      // (<task><verify> blocks). Same contract as the standalone gate:
      // one finding per offending task, counts against stageMaxRevisions,
      // re-runs the native stage with the findings, no adapter budget. The
      // effective denylist always carries the full-suite entries
      // (test-all.mjs + gates.commands), so no empty-list guard: even a
      // default config rejects a task that runs the full suite.
      if(stage==="plan"){
        const gsdEntries=gsd.phasePlans(repo,phase,gsdPhaseRoot(c))
          .flatMap(plan=>plan.tasks.map((task,idx)=>({file:plan.file,taskLabel:task.name||`task-${idx+1}`,verify:task.verify})));
        const gsdDenied=verifyDenylistFindings(gsdEntries,effectiveVerifyDenylist(c));
        if(gsdDenied.length){
          revision++;
          lastFindings=gsdDenied.map(f=>`${f.location}: ${f.problem} — ${f.correction}`).join("\n");
          s.gsdPlanningReview={stage,phase,revision,findings:gsdDenied};
          s.step=`gsd-${stage}-revision-${revision}`; saveState(s);
          if(revision>=stageMaxRevisions){
            s.phase="escalated";s.step=`gsd-${stage}-review-failed`;saveState(s);
            die(`GSD planning stage ${stage} failed review after ${stageMaxRevisions} revision(s).`);
          }
          request=`${request}\n\nGSD ${stage} reviewer findings that MUST be addressed on the next revision:\n${lastFindings}`;
          continue;
        }
      }

      const rr=await reviewGsdPlanningStage(c,s,stage,phase,request,lastFindings);
      if(rr.review?.decision==="PASS"){
        if(!s.planningCheckpoints)s.planningCheckpoints={};
        s.planningCheckpoints[checkpointKey]={status:"passed",stage,phase,at:now()};
        saveState(s);
        break;
      }

      revision++;
      lastFindings=(rr.review?.findings||[]).join("\n") || "Reviewer returned FAIL without findings.";
      s.gsdPlanningReview={stage,phase,revision,findings:rr.review?.findings||[]};
      s.step=`gsd-${stage}-revision-${revision}`; saveState(s);
      if(revision>=stageMaxRevisions){
        s.phase="escalated";s.step=`gsd-${stage}-review-failed`;saveState(s);
        die(`GSD planning stage ${stage} failed review after ${stageMaxRevisions} revision(s).`);
      }
      // The next loop re-runs the same native GSD planning stage with the review feedback in context.
      request=`${request}\n\nGSD ${stage} reviewer findings that MUST be addressed on the next revision:\n${lastFindings}`;
    }
  }

  // Three independent, non-substitutable plan-quality layers run here, in
  // this order:
  //   1. GSD's own native plan-checker — runs *inside* the planner relay
  //      call itself, as part of /gsd-plan-phase, before this function
  //      even sees the saved plans. Not visible in this file by design.
  //   2. gsd-tools deterministic validation (below) — external, scriptable,
  //      non-LLM checks (`verify references`, `state validate`) against the
  //      artifacts GSD wrote to disk. Only runs if the gsd-tools binary is
  //      installed; see the else-branch for what happens when it's not.
  //   3. Autopilot's independent plan_reviewer — a separate, read-only LLM
  //      review over the same saved artifacts (further below).
  // None of these three is a substitute for either of the others: (1) is
  // the planner grading its own homework, (2) is deterministic but only as
  // thorough as the checks gsd-tools implements, (3) is an independent LLM
  // opinion but can share blind spots with (1) since both are LLMs.
  if(phase){
    const tool=findGsdTools();
    const gsdToolsRequested=c.planning?.gsd?.run_plan_verify!==false;
    if(tool && gsdToolsRequested){
      const checks=[
        ["verify","references",path.join(repo,".planning","ROADMAP.md")],
        ["state","validate"]
      ];
      for(const check of checks){
        const r=runGsdTool(tool,check);
        write(path.join(repo,".autopilot","runs",`${Date.now()}-gsd-plan-check.log`),((r.stdout||"")+"\n"+(r.stderr||"")).trim());
        if(r.status!==0){
          s.phase="escalated";s.step="gsd-plan-native-check";saveState(s);
          die(`GSD native planning check failed: ${check.join(" ")}`);
        }
      }
    } else if(gsdToolsRequested){
      // FIX: this used to skip silently, so a phase could reach "tasks
      // ready" having only had layers 1 and 3, with nothing in the state
      // file or logs saying layer 2 never ran. Record it explicitly so a
      // human reviewing an overnight run — or a later `autopilot status` —
      // can see the deterministic layer was skipped, not that it passed.
      s.gsdPlanCheckLayers=s.gsdPlanCheckLayers||{};
      s.gsdPlanCheckLayers[phase]={deterministicGsdTools:"skipped-not-installed"};
      saveState(s);
      console.warn(`WARNING: gsd-tools binary not found — deterministic plan-check layer (verify references / state validate) was SKIPPED for phase ${phase}. Native (in-planner) and Autopilot plan_reviewer checks still ran. Install gsd-tools or set planning.gsd.run_plan_verify=false explicitly to silence this warning.`);
    }

    if(planReviewEnabled){
      const finalReview=await relayAsync("plan_reviewer",
        gsdPlanningReviewPrompt("plan-check",phase,request),
        c,s,{readOnly:true,review:true});
      // Mission 031 Phase 3 task 3.5: INCOMPLETE-as-FAIL (no continuation): gsd-plan-final-review has no continuation loop — an INCOMPLETE decision is treated as FAIL with explicit reason and never consumes a continuation.
      if(finalReview.review?.decision==="INCOMPLETE") console.log(`GSD phase ${phase} plan final review INCOMPLETE treated as FAIL (no continuation).`);
      if(finalReview.review?.decision!=="PASS"){
        s.phase="escalated";s.step="gsd-plan-final-review";s.gsdPlanningReview=finalReview.review;saveState(s);
        die(`GSD phase ${phase} plans failed final planning review.`);
      }
    }
  }

  s.phase="tasks_ready";s.step="tasks_ready";s.gsdPhase=phase||"current";saveState(s);
}
async function runSpec(c,s){
  const request=process.env.AUTOPILOT_SPEC || c.project?.spec || "Use the current project request/context.";
  await ensurePlanningReady(c,s,request);
  console.log("PLANNING STATE RESOLVED — TASKS/PHASE PLAN READY");
}

function activeSpecKitFeatureDir(){
  try{
    const feature=JSON.parse(read(path.join(repo,".specify","feature.json")));
    if(typeof feature.feature_directory==="string" && feature.feature_directory.trim()){
      const dir=path.resolve(repo,feature.feature_directory);
      return dir.startsWith(path.resolve(repo)+path.sep) ? path.relative(repo,dir) : null;
    }
  }catch{}
  return null;
}
function specKitPhases(c){
  const scoped=activeSpecKitFeatureDir();
  const candidates=scoped
    ? [path.join(scoped,"tasks.md"),path.join(scoped,"tasks","*.md")]
    : (c.planning?.speckit?.task_candidates||[".specify/tasks.md","specs/*/tasks.md","specs/*/tasks/*.md"]);
  return speckit.phases(repo,candidates);
}

// Per-task policy-violation exit: reconcile the task checkboxes (and clear the
// pending snapshot) BEFORE dying, per the "reconcile BEFORE any other decision"
// invariant. Fail-closed with task_marking_failed if the reconcile fails.
function reconcileTaskCheckboxesBeforePolicyDie(s,preAttemptTasks,label,snapshotKey){
  const reconciled=applyTaskCheckboxStates(preAttemptTasks);
  // Mission 084 Phase 2 task 2.4 — orchestrator tracked write invalidates
  // the snapshot reuse cache (scenario b). The reconcile above rewrites
  // tracked tasks.md checkboxes.
  try{
    clearSnapshotReuseCache("orchestrator tracked write");
    console.log(`[snapshot-reuse] cache cleared: orchestrator tracked write`);
  }catch(error){
    console.log(`[snapshot-reuse] cache clear skipped (${error?.message||error})`);
  }
  if(!reconciled.ok){
    s.phase="escalated";s.step="task_marking_failed";s.taskMarkingError=reconciled.reason;saveState(s);
    die(`${label} task checkbox validation failed while neutralizing a premature edit: ${reconciled.reason}. STOP — human intervention required.`);
  }
  delete s[snapshotKey];saveState(s);
}

// TASK 14 CORRECTION: a full, fresh-from-disk snapshot of EVERY task
// belonging to the active SpecKit feature — every phase, not just the one
// currently being worked — as flat {file,line,text,done} entries. Taken
// immediately before each Implementer attempt and persisted
// (s.pendingCheckboxSnapshot) so that whatever the Implementer does to ANY
// task's checkbox (including a FUTURE phase's, not just the current one)
// can be forced back to this exact pre-attempt truth afterward — see the
// reconciliation call right after the implementer relay below, and the
// startup reconciliation near the top of runImplementation() that recovers
// this if the process is killed before that point is reached.
function snapshotActiveFeatureTasks(c){
  return specKitPhases(c).flatMap(p=>p.tasks).map(t=>({file:t.file,line:t.line,text:t.text,done:t.done}));
}

function gitRun(cwd,args,capture=true){
  return spawnSync("git",args,{cwd,encoding:"utf8",stdio:capture?"pipe":"inherit",shell:false});
}
// Backlog #37: new untracked files that no task names and that look like
// scratch. Put into the code-review brief as "unexpected new files"; never
// deleted automatically (the reviewer decides).
function unexpectedNewFilesReviewNote(tasksText){
  try{
    const raw=gitRawOutput(repo,["ls-files","--others","--exclude-standard","-z"]);
    const files=raw.split("\0").filter(Boolean);
    return unexpectedNewFilesNote(findUnexpectedScratchFiles(files,tasksText));
  }catch{
    return "";
  }
}

function gitOutput(cwd,args){
  const r=gitRun(cwd,args,true);
  return (r.stdout||"").trim();
}
function gitRawOutput(cwd,args){
  const r=gitRun(cwd,args,true);
  if(r.status!==0) throw new Error((r.stderr||r.stdout||"Git command failed").trim());
  return r.stdout||"";
}
function isMainWorkingTreeClean(state){
  const snapshot=gitSnapshot(repo);
  if(state?.expectedWorkingFingerprint && snapshot.fingerprint===state.expectedWorkingFingerprint) return true;
  const sRaw=gitRun(repo,["status","--porcelain=v1","-z","--untracked-files=all"],true);
  // -z form never quotes (spaces/non-ASCII stay literal) and a rename/copy
  // entry spans TWO NUL-terminated tokens (`XY <to>` + bare `<from>`) —
  // parsed by the shared relay-guards helper so odd paths compare unquoted.
  let meaningful=parsePorcelainV1ZEntries(String(sRaw.stdout||""))
    .filter(e=>!e.paths.some(p=>p.includes(".autopilot/") || p.includes(".planning/")));
  // EOL-tolerant (mission 024): `git status` reports a CRLF-only rewrite
  // as modified even under `-c core.autocrlf=input`; filter tracked paths
  // absent from the `--ignore-cr-at-eol` dirty set so phantom churn does
  // not read as a dirty tree. Untracked (`??`) lines are always kept.
  // Fail open: on probe failure proceed with the unfiltered status.
  try{
    const r=gitRun(repo,["-c","core.autocrlf=input","diff","--ignore-cr-at-eol","--name-only","-z","HEAD"],true);
    if(r.status===0){
      const dirty=new Set(String(r.stdout||"").split("\0").filter(Boolean));
      meaningful=meaningful.filter(e=>keepEntryAfterEolFilter(e,dirty));
    }
  }catch{ /* fail open */ }
  return meaningful.length===0;
}
function workingSnapshotPatch(){
  // Preserve all current non-Autopilot changes as the base for the next wave
  // without touching the user's index. Tracked changes come from git diff;
  // untracked files are converted to applyable new-file patches.
  let patch=gitRawOutput(repo,["diff","--binary","HEAD","--",".",":(exclude).autopilot/**"]);
  const untracked=gitRawOutput(repo,["ls-files","--others","--exclude-standard","-z"])
    .split("\0").filter(Boolean).filter(rel=>!rel.startsWith(".autopilot/"));
  for(const rel of untracked){
    const r=spawnSync("git",["diff","--no-index","--binary","--","/dev/null",rel],{cwd:repo,encoding:"utf8",shell:false});
    if(r.status!==0&&r.status!==1) throw new Error(((r.stdout||"")+"\n"+(r.stderr||"")).trim());
    const untrackedPatch=r.stdout||"";
    if(!untrackedPatch) continue;
    patch += (patch && !patch.endsWith("\n")?"\n":"") + untrackedPatch;
    if(!patch.endsWith("\n")) patch += "\n";
  }
  return patch;
}
function seedWorktree(wt,snapshot){
  if(!snapshot)return;
  const check=spawnSync("git",["apply","--check","--whitespace=nowarn","-"],{
    cwd:wt,encoding:"utf8",input:snapshot,shell:false
  });
  if(check.status!==0)throw new Error(`Failed to seed worktree from current working state: ${((check.stdout||"")+"\\n"+(check.stderr||"")).trim()}`);
  const applied=spawnSync("git",["apply","--whitespace=nowarn","-"],{
    cwd:wt,encoding:"utf8",input:snapshot,shell:false
  });
  if(applied.status!==0)throw new Error(`Failed to seed worktree: ${((applied.stdout||"")+"\\n"+(applied.stderr||"")).trim()}`);
}
function worktreeRoot(){
  return path.join(path.dirname(repo),`.autopilot-worktrees-${path.basename(repo)}`);
}
function createWorktree(id,baseSha){
  const root=worktreeRoot();
  const wt=path.join(root,id);
  fs.mkdirSync(root,{recursive:true});
  gitRun(repo,["worktree","prune"],true);
  const registered=gitOutput(repo,["worktree","list","--porcelain"]).split(/\r?\n{2,}/).find(block=>block.includes(`worktree ${wt}`));
  if(registered) gitRun(repo,["worktree","remove","--force",wt],true);
  fs.rmSync(wt,{recursive:true,force:true});
  const r=gitRun(repo,["worktree","add","--detach",wt,baseSha],true);
  if(r.status!==0) die(`Failed to create worktree ${id}: ${(r.stderr||"").trim()}`);
  return wt;
}
function removeWorktree(wt){
  gitRun(repo,["worktree","remove","--force",wt],true);
}
function changedPaths(wt){
  const tracked=gitRawOutput(wt,["diff","--name-only","-z","HEAD"]).split("\0").filter(Boolean);
  const untracked=gitRawOutput(wt,["ls-files","--others","--exclude-standard","-z"]).split("\0").filter(Boolean);
  return [...new Set([...tracked,...untracked])].filter(p=>p && !p.startsWith(".autopilot/"));
}
function fileDeltaPatch(wt,rel){
  const mainFile=path.join(repo,rel), wtFile=path.join(wt,rel);
  const mainExists=fs.existsSync(mainFile), wtExists=fs.existsSync(wtFile);
  if(mainExists&&wtExists&&fs.statSync(mainFile).isDirectory())return "";
  const left=mainExists?mainFile:"/dev/null";
  const right=wtExists?wtFile:"/dev/null";
  if(left===right)return "";
  const r=spawnSync("git",["diff","--no-index","--binary","--",left,right],{cwd:repo,encoding:"utf8",shell:false});
  if(r.status!==0&&r.status!==1)throw new Error(((r.stdout||"")+"\n"+(r.stderr||"")).trim());
  const lines=(r.stdout||"").split(/\n/);
  if(!lines.length||!lines[0])return "";
  const out=lines.map(line=>{
    if(line.startsWith("diff --git ")) return `diff --git a/${rel} b/${rel}`;
    if(line.startsWith("--- ")&&mainExists) return `--- a/${rel}`;
    if(line.startsWith("+++ ")&&wtExists) return `+++ b/${rel}`;
    return line;
  });
  return out.join("\n");
}
function planPatch(wt){
  return changedPaths(wt).map(rel=>fileDeltaPatch(wt,rel)).filter(Boolean).join("\n");
}
function planDiff(wt){
  return gitRawOutput(wt,["diff","--no-ext-diff","--",".",":(exclude).autopilot/**"]);
}
function applyPatchCheck(patch){
  const r=spawnSync("git",["apply","--check","--whitespace=nowarn","-"],{
    cwd:repo,encoding:"utf8",input:patch,shell:false
  });
  return {ok:r.status===0,output:((r.stdout||"")+"\n"+(r.stderr||"")).trim()};
}
function applyPatch(patch){
  return spawnSync("git",["apply","--whitespace=nowarn","-"],{
    cwd:repo,encoding:"utf8",input:patch,shell:false
  });
}
function gsdParallelConfig(c){
  const g=c.planning?.gsd||{};
  let native={};
  const nativePath=path.join(repo,".planning","config.json");
  if(fs.existsSync(nativePath)){
    try{native=JSON.parse(read(nativePath))}catch{native={};}
  }
  const p=native.parallelization ?? g.parallelization ?? {};
  const workflow=native.workflow ?? {};
  return {
    enabled:g.parallelization_enabled!==false && p.enabled!==false,
    planLevel:p.plan_level!==false,
    taskLevel:p.task_level===true,
    useWorktrees:workflow.use_worktrees!==false,
    maxConcurrent:Math.max(1,Number(p.max_concurrent_agents||3)),
    minPlans:Math.max(2,Number(p.min_plans_for_parallel||2))
  };
}
function gsdTasks(c,phase){
  const tasks=gsd.normalizedTasks(repo,phase,gsdPhaseRoot(c));
  if(!tasks.length)return [];
  const pc=gsdParallelConfig(c);
  if(pc.taskLevel){
    console.warn("GSD task-level parallelization is intentionally disabled by Autopilot; executing tasks sequentially within each PLAN.");
  }
  return tasks;
}
function findGsdTools(){
  const candidates=[
    path.join(repo,"gsd-tools.cjs"),
    path.join(repo,".gsd","gsd-tools.cjs"),
    path.join(skillRoot,"vendor","gsd-tools.cjs")
  ];
  for(const p of candidates) if(fs.existsSync(p)) return {kind:"node-script",command:p};
  const probes=["gsd-tools","gsd-sdk"];
  for(const bin of probes){
    const r=spawnSync(bin,["--help"],{cwd:repo,encoding:"utf8",stdio:"ignore",shell:false});
    if(r.status===0 || r.status===1) return {kind:"binary",command:bin};
  }
  return null;
}
function runGsdTool(tool,args){
  if(tool.kind==="node-script") return spawnSync("node",[tool.command,...args],{cwd:repo,encoding:"utf8",captureOutput:true,shell:false});
  return spawnSync(tool.command,args,{cwd:repo,encoding:"utf8",captureOutput:true,shell:false});
}
async function runLocalVerificationCommands(c,s){ return gates(c,s); }
function syncGsdStateIfAvailable(){
  const tool=findGsdTools();
  if(!tool)return {ok:true,available:false};
  const r=runGsdTool(tool,["state","sync"]);
  write(path.join(repo,".autopilot","runs",`${Date.now()}-gsd-state-sync.log`),((r.stdout||"")+"\n"+(r.stderr||"")).trim());
  return {ok:r.status===0,available:true};
}
function writeGsdVerificationArtifacts(c,phase,phaseReview,verifier,gate){
  // FIX: was hardcoded to ".planning/phases" — ignored c.planning.gsd.phase_root,
  // so a custom phase_root wrote VERIFICATION.md/UAT.md/SUMMARY.md next to a
  // phases directory that didn't match where phases actually live.
  const dir=path.join(repo,gsdPhaseRoot(c),phase);
  fs.mkdirSync(dir,{recursive:true});
  const verification=path.join(dir,"VERIFICATION.md");
  const uat=path.join(dir,"UAT.md");
  const summary=path.join(dir,"SUMMARY.md");
  const pass=gate.ok && verifier?.decision==="PASS" && phaseReview?.decision==="PASS";
  write(verification,[
    "---",`phase: ${phase}`,`status: ${pass?"passed":"failed"}`,"---","",
    `# Phase ${phase} Verification`,"",
    `Automated gates: ${gate.ok?"PASS":"FAIL"}`,"",
    "## Verifier",verifier?.decision||"FAIL",...(verifier?.findings||[]).map(x=>`- ${x}`),"",
    "## Code Review",phaseReview?.decision||"FAIL",...(phaseReview?.findings||[]).map(x=>`- ${x}`),""
  ].join("\n"));
  write(uat,[
    "---",`phase: ${phase}`,`status: ${pass?"ready":"blocked"}`,"---","",
    `# Phase ${phase} UAT`,"",
    pass?"No blocking automated findings. End-of-phase human verification remains required before ship.":"UAT is blocked until verification/review findings are resolved.",""
  ].join("\n"));
  write(summary,[
    "---",`phase: ${phase}`,`status: ${pass?"complete":"needs-fix"}`,"---","",
    `# Phase ${phase} Summary`,"",`Verification: ${pass?"PASS":"FAIL"}`,"",
    "Autopilot does not create Git commits; the human owns commit/push."
  ].join("\n"));
  return pass;
}
function planUnits(tasks){
  const by=new Map();
  for(const t of tasks){
    if(!by.has(t.planId)) by.set(t.planId,{planId:t.planId,planFile:t.planFile,wave:t.wave??1,tasks:[]});
    by.get(t.planId).tasks.push(t);
  }
  return [...by.values()].sort((a,b)=>
    ((a.wave??999)-(b.wave??999)) || a.planId.localeCompare(b.planId)
  );
}
function waveGroups(units){
  const m=new Map();
  for(const u of units){
    if(!m.has(u.wave))m.set(u.wave,[]);
    m.get(u.wave).push(u);
  }
  return [...m.entries()].sort((a,b)=>a[0]-b[0]);
}
function buildPlanPrompt(phase,u){
  return [
    `Implement the complete GSD plan ${u.planId}.`,
    `Phase: ${phase}`,
    `Plan file: ${u.planFile}`,
    `Wave: ${u.wave}`,
    "",
    "This is one GSD plan. Execute its task blocks in the exact order defined by the PLAN.md.",
    "Do not execute other plans. Do not modify .planning/STATE.md or other plans.",
    "Do not commit or push.",
    "",
    ...u.tasks.map((t,i)=>[
      `TASK ${i+1}: ${t.name}`,
      `Files: ${t.files.join(", ")||"(see plan)"}`,
      `Action: ${t.action||"(see plan)"}`,
      `Verify: ${t.verify||"(configured gates)"}`,
      `Done: ${t.done||"(see plan)"}`
    ].join("\n"))
  ].join("\n");
}
async function relayAsync(roleName,task,c,s,options={}){
  const {cwd=repo,readOnly=false,resume=false,review=false,persistState=true,requirements=[],taskFacts={},taskRef=null,timeoutMs=null,capEnabled=false,contScope=null,planRevision=null,carriedForwardTasks=null}=options;
  return runRelay(roleName,task,c,s,{cwd,readOnly,resume,review,persistState,requirements,taskFacts,taskRef,timeoutMs,alwaysSave:true,fatal:orchestratorFatal,includeError:true,capEnabled,contScope,planRevision,carriedForwardTasks});
}
// Mission 091 task 2.1: minimal adhoc review entry. Runs one read-only
// reviewer/verifier relay against an already-built prompt with a synthetic
// in-memory state object (never loaded from or written to
// .autopilot/state.json: persistState:false skips every saveState call and
// saveRoleSession only mutates the in-memory object). Backlog #5: the relay
// cwd is the REAL repository root (repoRoot) — the envelope REPOSITORY bind,
// the role's cwd and the brief's REPOSITORY all point at the repo under
// review, never the adhoc output dir. The parent adhoc dir
// (.autopilot/adhoc/<timestamp>-<role>/) is ONLY the runsDir override, so
// relay artifacts land as a nested NN-<role>-<id8>/ subdir inside it (via
// runDirFor) instead of .autopilot/runs/. repoRoot defaults to the module
// repository when omitted. Fatal errors throw (relayAsync pattern) — never
// exits the process, no exit hooks. Self-contained by design (only
// fs/path/runRelay): the 091 entry test extracts this function and drives it
// with a stubbed runRelay.
export async function runAdhocReview({role,prompt,adhocDir,repoRoot=null,config=null,requirements=[],taskFacts={},taskRef=null,timeoutMs=null}={}){
  const roleName=String(role??"").trim();
  if(!roleName) throw new Error("runAdhocReview: role is required.");
  const brief=String(prompt??"");
  if(!brief.trim()) throw new Error("runAdhocReview: prompt is required.");
  const parent=String(adhocDir??"");
  if(!parent||!path.isAbsolute(parent)) throw new Error(`runAdhocReview: adhocDir must be an absolute path (got ${JSON.stringify(parent)}).`);
  let stat=null;
  try{ stat=fs.statSync(parent); }catch{ stat=null; }
  if(!stat||!stat.isDirectory()) throw new Error(`runAdhocReview: adhocDir not found or not a directory: ${parent}`);
  const c=config??null;
  if(!c||!c.roles?.[roleName]) throw new Error(`runAdhocReview: missing role in config: ${roleName}`);
  const s={__adhocRunsDir:parent};
  return runRelay(roleName,brief,c,s,{cwd:repoRoot||repo,readOnly:true,review:true,persistState:false,requirements,taskFacts,taskRef,timeoutMs,alwaysSave:false,fatal:orchestratorFatal,includeError:true});
}
function writeGsdSummary(repoRoot,u,results,verifyOk){
  const planDir=path.dirname(path.join(repoRoot,path.relative(repo,u.planFile)));
  const stem=path.basename(u.planId).replace(/-PLAN\.md$/i,"");
  const summary=path.join(planDir,`${stem}-SUMMARY.md`);
  write(summary,[
    "---",`plan: ${u.planId}`,`status: ${verifyOk ? "complete":"needs-fix"}`,"---","",
    `# ${u.planId}`,"",
    "## What changed",
    ...results.map(r=>r.finalMessage||"(see .autopilot run log)"),"",
    "## Verification",verifyOk?"PASS":"FAIL","",
    "## Notes","Autopilot-managed execution; no commit was created by the orchestrator."
  ].join("\n"));
}

// Mission 085 Phase 1 task 1.3 — the per-unit failure decision runs on a deep
// copy (`localState` below), so a live `ap reset` it honours (disk request
// consumed, counter restarted, `lastReset` stamped) must be carried back:
// `failureRecords` is the only channel into `executeWave`'s outer re-record.
// Capture the applied reset (cleared budget keys + `lastReset`) here; the outer
// loop re-applies it to `s` before its own `recordFailureBudget`, or the
// re-record increments past the limit and escalates a failure the operator
// already reset.
function recordGsdUnitFailure(c,localState,unitLabel,results,gate,failureRecords){
  const resetBefore=localState.lastReset;
  const budgetsBefore={...(localState.failureBudgets||{})};
  const recorded=recordAttemptFailure(c,localState,unitLabel,results,gate,{persist:false});
  failureRecords.push(deriveGsdUnitResetRecord({budgetsBefore,resetBefore,localState,recorded}));
  return recorded;
}
async function runGsdPlanUnit(c,s,phase,u,waveBaseSha,snapshot){
  const wt=createWorktree(`phase-${phase}-wave-${u.wave}-${path.basename(u.planId,".md")}`,waveBaseSha);
  const localState=JSON.parse(JSON.stringify(s));
  localState.currentTask={phase,plan:u.planId,name:u.planId,wave:u.wave};
  // Parallel GSD PLAN units must not inherit or persist global role sessions.
  // Each unit owns its session for retries inside that PLAN only.
  localState.sessions={};
  try{
    seedWorktree(wt,snapshot);
    let feedback="";
    const failureRecords=[];
    for(let attempt=1;;attempt++){
      await retryDelay(c,attempt);
      localState.phase="implementing";localState.step="implement";
      localState.gsdPhase=phase;localState.feedback=feedback;localState.attempt=attempt;

      const taskRequirements=u.tasks.flatMap(task=>task.requiredCapabilities||[]);
      const taskFacts=mergeTaskFacts(u.tasks);
      const impl=await relayAsync("implementer",
        buildPlanPrompt(phase,u)+(feedback?`\n\nPREVIOUS FAILURE:\n${feedback}`:""),
        c,localState,{cwd:wt,resume:attempt>1 || !!roleSession(localState,"implementer"),persistState:false,requirements:taskRequirements,taskFacts,capEnabled:true});

      // Code Review gates everything else: no gate command, task.verify
      // command, or Verifier may run until Code Review has returned PASS.
      localState.step="review";
      const rv=await relayAsync("code_reviewer",
        [
          `Review ONLY GSD plan ${u.planId} in phase ${phase}.`,
          "The plan was executed in an isolated worktree.",
          "Do not modify files. Do not commit/push.",
          "",
          `Git diff:\n${planDiff(wt)}`
        ].join("\n"),
        c,localState,{cwd:wt,readOnly:true,review:true,persistState:false,requirements:taskRequirements,taskFacts});

      if(impl.policyViolation || rv.policyViolation){
        return {ok:false,plan:u,worktree:wt,error:`Relay policy violation: ${impl.policyViolation||rv.policyViolation}`,policyViolation:impl.policyViolation||rv.policyViolation};
      }

      if(!(impl.status==="completed" && rv.status==="completed" && rv.review?.decision==="PASS")){
        const recorded=recordGsdUnitFailure(c,localState,`gsd:${phase}:${u.planId}`,[impl,rv],{ok:true},failureRecords);
        feedback=[
          ...(impl.status!=="completed"?["Implementer failed."]:[]),
          ...(rv.review?.findings||[])
        ].join("\n") || "Plan implementation/review failed.";
        localState.feedback=feedback;
        if(!recorded.budget.allowed){
          return {ok:false,plan:u,worktree:wt,error:`Plan ${u.planId} stopped on ${recorded.failure.domain}/${recorded.failure.class}.`,failureRecords};
        }
        continue;
      }

      // Only after Code Review PASS: run configured verification (gates +
      // task.verify commands).
      const {env:shellEnv,shellGuard}=guardedShell(wt,c.gates?.network_isolation!==false,c.gates?.env_allowlist||[]);
      const taskVerifications=[];
      for(const t of u.tasks){
        if(!t.verify)continue;
        const v=runCommandInCwd(wt,t.verify,shellEnv,shellGuard,{label:`task.verify:${t.name}`,untrusted:true});
        taskVerifications.push({task:t.name,ok:v.status===0,output:((v.stdout||"")+"\n"+(v.stderr||"")).trim(),command:t.verify,shellBlocked:!!v.shellBlocked,blockReason:v.shellBlockReason||null});
      }
      const gatesResult=runGatesInCwd(c,wt,shellEnv,shellGuard);
      const verifyOk=gatesResult.ok && taskVerifications.every(v=>v.ok);

      if(verifyOk){
        return {ok:true,plan:u,worktree:wt,patch:planPatch(wt),review:rv.review,implementer:impl,failureRecords};
      }
      const verificationGate={ok:false,command:gatesResult.command||taskVerifications.find(v=>!v.ok)?.command||null};
      const recorded=recordGsdUnitFailure(c,localState,`gsd:${phase}:${u.planId}`,[impl,rv],verificationGate,failureRecords);
      feedback=[
        ...(gatesResult.ok?[]:[`Gate failed: ${gatesResult.command}`]),
        ...taskVerifications.filter(v=>!v.ok).map(v=>`Task verify failed (${v.task}): ${v.command}`)
      ].join("\n") || "Plan verification failed.";
      localState.feedback=feedback;
      if(!recorded.budget.allowed){
        return {ok:false,plan:u,worktree:wt,error:`Plan ${u.planId} stopped on ${recorded.failure.domain}/${recorded.failure.class}.`,failureRecords};
      }
    }
  }catch(error){
    return {ok:false,plan:u,worktree:wt,error:error.message};
  }
}
// FIX (was the actual hole): this used to run task.verify via plain
// `sh -lc <command>` with NO shell-guard pattern check and NO network
// isolation — worse than gates.commands, which at least went through
// runGuardedCommand. task.verify is written by the planner LLM with zero
// human review, making it the highest-risk command source in the whole
// pipeline. It now takes the same shellGuard + label + logging path as
// everything else. Callers must pass the shellGuard returned by
// guardedShell(cwd) alongside its env — see runGsdPlanUnit below.
function runCommandInCwd(cwd,command,env,shellGuard,options={label:"task.verify"}){
  return runGuardedCommand(cwd,command,env,shellGuard,options);
}
function runGatesInCwd(c,cwd,env,shellGuard){
  // Mission 084 Phase 2 task 2.4 — gates invalidate the snapshot reuse
  // cache: gate commands may mutate tracked files (scenario a). Cleared
  // up front: no cache store happens while gates run, so entry-clear is
  // equivalent to exit-clear and also covers mid-loop failure returns.
  try{
    clearSnapshotReuseCache("gates ran between runs");
    console.log(`[snapshot-reuse] cache cleared: gates ran between runs`);
  }catch(error){
    console.log(`[snapshot-reuse] cache clear skipped (${error?.message||error})`);
  }
  for(const command of c.gates?.commands||[]){
    const p=runCommandInCwd(cwd,command,env,shellGuard,{label:"gates.commands",untrusted:false});
    if(p.status!==0)return {ok:false,command,shellBlocked:!!p.shellBlocked,reason:p.shellBlockReason};
  }
  return {ok:true};
}
async function validateWavePatches(patches,baseSha,snapshot){
  const wt=createWorktree(`validation-${randomUUID()}`,baseSha);
  try{
    seedWorktree(wt,snapshot);
    for(const patch of patches){
      const check=applyPatchCheckInCwd(wt,patch);
      if(!check.ok)return {ok:false,output:check.output};
      const applied=applyPatchInCwd(wt,patch);
      if(applied.status!==0){
        return {ok:false,output:((applied.stdout||"")+"\n"+(applied.stderr||"")).trim()};
      }
    }
    return {ok:true};
  }finally{
    removeWorktree(wt);
  }
}
function applyPatchCheckInCwd(cwd,patch){
  const r=spawnSync("git",["apply","--check","--whitespace=nowarn","-"],{cwd,encoding:"utf8",input:patch,shell:false});
  return {ok:r.status===0,output:((r.stdout||"")+"\n"+(r.stderr||"")).trim(),status:r.status};
}
function applyPatchInCwd(cwd,patch){
  return spawnSync("git",["apply","--whitespace=nowarn","-"],{cwd,encoding:"utf8",input:patch,shell:false});
}
async function executeWave(c,s,phase,waveUnits,waveNumber){
  // Re-snapshot at the start of every wave so later waves include all prior
  // successful work. The commit SHA usually stays unchanged because Autopilot
  // never commits, but keeping a per-wave baseline avoids stale assumptions.
  const waveBaseSha=gitOutput(repo,["rev-parse","HEAD"]);
  const snapshot=workingSnapshotPatch();
  const pc=gsdParallelConfig(c);
  const canParallel=pc.enabled && pc.planLevel && pc.useWorktrees && waveUnits.length>=pc.minPlans;
  const chunks=[];
  for(let i=0;i<waveUnits.length;i+=pc.maxConcurrent)chunks.push(waveUnits.slice(i,i+pc.maxConcurrent));

  const results=[];
  for(const chunk of chunks){
    const batch=canParallel ? await Promise.all(chunk.map(u=>runGsdPlanUnit(c,s,phase,u,waveBaseSha,snapshot)))
                            : [await runGsdPlanUnit(c,s,phase,chunk[0],waveBaseSha,snapshot)];
    results.push(...batch);

    for(const record of batch.flatMap(result=>result.failureRecords||[])){
      // Mission 085 Phase 1 task 1.3 — propagate a live reset the per-unit
      // decision already applied on its deep copy (runGsdPlanUnit via
      // recordGsdUnitFailure, derived in scripts/gsd-unit-reset.mjs): the
      // copy consumed the disk request and restarted its counter, so the
      // outer re-record must restart too instead of incrementing past the
      // limit and escalating. NO queue IO here on purpose: the unit already
      // consumed those entries, and a same-key or global request queued after
      // the unit applied the first one must stay queued until its own
      // decision arrives. Non-matching entries were never consumed inside the
      // unit and are untouched here, so they stay queued; per-record
      // escalate-and-die order below is unchanged. A carried global reset
      // clears every spent counter on the outer state (not just
      // failureBudgets), mirroring what the unit cleared.
      applyCarriedGsdReset(s,record);
      const budget=recordFailureBudget(s,c.policy,record.failure,record.scope);
      s.lastFailure=record.failure;s.lastFailureBudget=budget;
      if(!budget.allowed){
        for(const result of batch) if(result.ok) removeWorktree(result.worktree);
        const naming=decideEscalationName({failureClass:record.failure.class,retryable:record.failure.retryable,used:budget.used,limit:budget.limit,budget:budget.budget,evidence:record.failure.evidence});
        s.phase="escalated";s.step=naming.step;saveState(s);
        die(`${record.failure.domain}/${record.failure.class} (${record.scope}): ${naming.detail}; human intervention required.`);
      }
    }
    saveState(s);

    if(!batch.every(r=>r.ok)){
      for(const r of batch) if(r.ok) removeWorktree(r.worktree);
      return {ok:false,results};
    }
  }

  // Never partially apply a wave. Validate the complete patch set in a disposable
  // worktree seeded with the exact current working state, then apply to main only
  // after the whole wave is proven mergeable.
  const patches=results.map(r=>r.patch);
  const validation=await validateWavePatches(patches,waveBaseSha,snapshot);
  if(!validation.ok){
    return {ok:false,results,conflict:{output:validation.output}};
  }
  const combinedPatch=patches.join("\n");
  const applied=applyPatch(combinedPatch);
  if(applied.status!==0){
    return {ok:false,results,conflict:{output:((applied.stdout||"")+"\n"+(applied.stderr||"")).trim()}};
  }
  for(const r of results){
    writeGsdSummary(repo,r.plan,[{finalMessage:r.implementer?.finalMessage||"Plan completed in isolated worktree."}],true);
    removeWorktree(r.worktree);
  }

  s.checkpoint={type:"gsd-wave",phase,wave:waveNumber,plans:results.map(r=>r.plan.planId),at:now()};
  saveState(s);
  return {ok:true,results,baseSha:waveBaseSha};
}

async function runGsdPhase(c,s,phase){
  const tasks=gsdTasks(c,phase);
  if(!tasks.length) die(`No GSD tasks found in phase ${phase}.`);
  if(!isMainWorkingTreeClean(s)) die("Main working tree is dirty. Refusing parallel GSD execution; commit/stash unrelated changes first.");

  const units=planUnits(tasks);
  const waves=waveGroups(units);

  for(const [waveNumber,waveUnits] of waves){
    const checkpoint=s.checkpoint;
    const alreadyCompleted=checkpoint?.type==="gsd-wave" &&
      checkpoint.phase===phase && Number(checkpoint.wave)>=Number(waveNumber);
    if(alreadyCompleted)continue;
    s.phase="wave";s.step=`wave-${waveNumber}`;s.gsdPhase=phase;
    s.currentWave={phase,wave:waveNumber,plans:waveUnits.map(u=>u.planId)};
    saveState(s);

    const result=await executeWave(c,s,phase,waveUnits,waveNumber);
    if(!result.ok){
      s.phase="escalated";s.step="human_merge";
      s.conflict=result.conflict||null;saveState(s);
      die(result.conflict
        ? `GSD wave ${waveNumber} has a patch conflict. STOP — human merge required.`
        : `GSD wave ${waveNumber} failed. STOP — human intervention required.`);
    }
    // Only the parent orchestrator writes canonical state after a wave fully
    // succeeds; parallel PLAN workers never write the shared state.json.
    // Mission 084 Phase 2 task 2.3 — phase re-baseline invalidates the
    // snapshot reuse cache: never reuse across a re-baseline (scenario c).
    s.expectedWorkingFingerprint=gitSnapshot(repo).fingerprint;
    try{
      clearSnapshotReuseCache("expectedWorkingFingerprint re-baseline");
      console.log(`[snapshot-reuse] cache cleared: expectedWorkingFingerprint re-baseline`);
    }catch(error){
      console.log(`[snapshot-reuse] cache clear skipped (${error?.message||error})`);
    }
    s.currentWave={phase,wave:waveNumber,plans:waveUnits.map(u=>u.planId),baseSha:result.baseSha};
    saveState(s);
  }

  s.step="phase_verify";s.phase="verifying";saveState(s);
  const phasePlanText=units.map(u=>[
    `PLAN: ${u.planId}`,`WAVE: ${u.wave}`,
    ...u.tasks.map(t=>`TASK: ${t.name}\nDONE: ${t.done||""}`)
  ].join("\n")).join("\n\n");

  const phaseRequirements=units.flatMap(unit=>unit.tasks.flatMap(task=>task.requiredCapabilities||[]));
  const phaseTaskFacts=mergeTaskFacts(units.flatMap(unit=>unit.tasks));

  // Code Review gates everything else at the phase level too: no gate,
  // deterministic gsd-tools check, or Verifier may run until the phase
  // Code Reviewer has returned PASS.
  const phaseReview=await relayAsync("code_reviewer",
    `Final code review for GSD phase ${phase}.\n\nGit diff:\n${diff()}\n\nReview against phase plans, requirements, and scope.`,
    c,s,{readOnly:true,review:true,requirements:phaseRequirements,taskFacts:phaseTaskFacts});

  if(phaseReview.status!=="completed" || phaseReview.policyViolation || phaseReview.review?.decision!=="PASS"){
    enforceAttemptFailure(c,s,`gsd-phase-code-review:${phase}`,[phaseReview],{ok:true});
    s.phase="phase_fix_plan";s.step="phase_fix_plan";saveState(s);
    // Persisted BEFORE the fix-plan relay, not just passed into it: this
    // branch dies immediately afterwards and waits for a resume, so a stop
    // between the review and the fix plan would otherwise lose the findings
    // the fix plan exists to address.
    const findings=saveReviewFeedback(s,gsdPhaseFeedbackKey(phase),phaseReview.review?.findings||[]);
    saveState(s);
    const fixPlan=await relayAsync("planner",
      `Create a focused GSD fix plan for phase ${phase}.\nDo not commit/push.\nCode review found these issues; fix only these findings:\n${feedbackText(findings)}`,
      c,s,{resume:false});
    if(fixPlan.status!=="completed"){s.phase="escalated";saveState(s);die(`GSD phase ${phase} code review failed and fix-plan creation failed.`)}
    s.phase="phase_fix_ready";saveState(s);
    die(`GSD phase ${phase} needs fixes (code review). Run resume to continue.`);
  }

  // Only after Code Review PASS: gates, deterministic gsd-tools checks, and
  // the Verifier role.
  const verifier=await relayAsync("verifier",[
    `Verify completed GSD phase ${phase}.`,
    "Read .planning/ROADMAP.md and all phase PLAN.md files.",
    "Check phase goal, success criteria, requirements coverage, and automated evidence.",
    "Do not modify files. Do not commit/push.","",phasePlanText,
    `\nGit diff:\n${diff()}`
  ].join("\n"),c,s,{readOnly:true,review:true,requirements:phaseRequirements,taskFacts:phaseTaskFacts});

  const gate=await runLocalVerificationCommands(c,s);
  let gsdToolPass=true;
  if(c.planning?.gsd?.use_gsd_tools_when_available!==false){
    const tool=findGsdTools();
    if(tool){
      const checks=[
        ["state","validate"],
        ["verify","phase-completeness",phase],
        ["verify","references",path.join(repo,".planning","ROADMAP.md")]
      ];
      for(const check of checks){
        const r=runGsdTool(tool,check);
        write(path.join(repo,".autopilot","runs",`${Date.now()}-gsd-tools.log`),((r.stdout||"")+"\n"+(r.stderr||"")).trim());
        if(r.status!==0){gsdToolPass=false;break;}
      }
    }
  }
  const verificationPass=gate.ok&&gsdToolPass&&verifier.status==="completed"&&!verifier.policyViolation&&verifier.review?.decision==="PASS";

  if(!verificationPass){
    enforceAttemptFailure(c,s,`gsd-phase-verify:${phase}`,[verifier],{ok:gate.ok&&gsdToolPass,command:gate.command||(gsdToolPass?null:"gsd-tool-verification")});
    s.phase="phase_fix_plan";s.step="phase_fix_plan";saveState(s);
    // Persisted before the relay for the same reason as the code-review
    // branch above: this path dies and waits for a resume.
    const findings=saveReviewFeedback(s,gsdPhaseFeedbackKey(phase),
      [...(verifier.review?.findings||[]),...(gate.ok?[]:[`Verification gate failed: ${gate.command}`])]);
    saveState(s);
    const fixPlan=await relayAsync("planner",
      `Create a focused GSD fix plan for phase ${phase}.\nDo not commit/push.\nFix only these findings:\n${feedbackText(findings)}`,
      c,s,{resume:false});
    if(fixPlan.status!=="completed"){s.phase="escalated";saveState(s);die(`GSD phase ${phase} verification failed and fix-plan creation failed.`)}
    s.phase="phase_fix_ready";saveState(s);
    die(`GSD phase ${phase} needs fixes (verification). Run resume to continue.`);
  }



  const stateSync=syncGsdStateIfAvailable();
  if(!stateSync.ok){s.phase="escalated";s.step="state_sync";saveState(s);die(`GSD STATE.md sync failed for phase ${phase}.`);}
  writeGsdVerificationArtifacts(c,phase,phaseReview.review,verifier.review,gate);
  clearReviewFeedback(s,gsdPhaseFeedbackKey(phase));
  clearFindingTasks(s,gsdPhaseFeedbackKey(phase));
  // Mission 084 Phase 2 task 2.3 — phase re-baseline invalidates the
  // snapshot reuse cache: never reuse across a re-baseline (scenario c).
  s.expectedWorkingFingerprint=gitSnapshot(repo).fingerprint;
  try{
    clearSnapshotReuseCache("expectedWorkingFingerprint re-baseline");
    console.log(`[snapshot-reuse] cache cleared: expectedWorkingFingerprint re-baseline`);
  }catch(error){
    console.log(`[snapshot-reuse] cache clear skipped (${error?.message||error})`);
  }
  s.phase="phase_complete";s.step="human_commit";s.checkpoint={type:"gsd-phase",phase,at:now()};saveState(s);
  console.log(`GSD PHASE ${phase} COMPLETE — HUMAN COMMIT REQUIRED`);
}

async function runGsdImplementation(c,s){
  const stage=activeStage;
  // Mission 090 task 1.5: stage-scoped implement/review/verify are
  // standalone-only (`--stage planning` stops before the framework dispatch
  // in runImplementation, so only the refusals land here).
  if(stage!=null&&stage!=="planning"){
    die(`Usage error: --stage ${stage} is only supported with the standalone framework in this build. Use: ap run [request]`);
  }
  let phase=gsd.currentPhase(repo,gsdPhaseRoot(c));
  while(phase){
    s.gsdPhase=phase;saveState(s);
    await runGsdPhase(c,s,phase);
    phase=gsd.nextPendingPhase(repo,phase,gsdPhaseRoot(c));
    if(phase){s.checkpoint={type:"phase-transition",from:s.gsdPhase,to:phase,at:now()};saveState(s);}
  }
  s.phase="final_review";s.step="final_review";saveState(s);
  const final=await relayAsync("code_reviewer",
    `Final repository review across all completed GSD phases.\n\nGit diff:\n${diff()}`,
    c,s,{readOnly:true,review:true});
  // Mission 031 Phase 3 task 3.5: INCOMPLETE-as-FAIL (no continuation): gsd-loop-final-review has no continuation loop — an INCOMPLETE decision is treated as FAIL with explicit reason and never consumes a continuation.
  if(final.review?.decision==="INCOMPLETE") console.log("GSD loop final repository review INCOMPLETE treated as FAIL (no continuation).");
  if(final.status!=="completed" || final.policyViolation || final.review?.decision!=="PASS"){s.phase="escalated";saveState(s);die("Final repository review failed.")}
  finalizeMissionComplete(s);
  console.log("ALL GSD PHASES COMPLETE — HUMAN COMMIT REQUIRED");
}

// Mission 051 Phase 1 task 1.3: mission-final fix-round driver shared by the
// two standalone final-review FAIL sites (early-final no-pending path and
// post-loop mission-final). A final-review FAIL loops through
// runFinalReviewFixRounds — durable budget counter in mission state, finding
// record, fixPassBriefExcerpts brief, implementer fix pass, gate, then final
// re-review — and the caller escalates only when the returned outcome is not
// "passed". Evidence-refusal and policy-violation results bypass the loop
// inside the helper (immediate escalation, today's behavior, no round
// consumed). `site` is "early-final" or "mission-final" (finding-record key
// plus re-review log label); every other input is the site's own mission
// scope, so no SpecKit/GSD context leaks in. Returns the helper outcome
// verbatim ({outcome:"passed"|"escalate"|"bypass",...}).
// Backlog #86: reviewer-failure recorder shared by the standalone and SpecKit
// final-review drivers. A final review with no verdict (timeout / api_retry /
// failed status) or a FAIL with zero findings is a failure of the REVIEWER:
// it goes through recordAttemptFailure (infrastructure scope `mission`, the
// existing infrastructureRetryBudget pattern) and, while the budget allows,
// the helper re-runs the reviewer only — never an implementer fix pass. A
// result with no classified failure (completed, zero findings) is recorded as
// a retryable STRUCTURED_OUTPUT_MISSING. Exhaustion escalates exactly like
// enforceAttemptFailure (decideEscalationName step + die text).
async function recordFinalReviewerFailure(c,s,site,{review:result}){
  const classified=result?.failure
    ?result
    :{...(result||{}),role:result?.role||"code_reviewer",failure:failure("STRUCTURED_OUTPUT_MISSING","adapter",true,[{source:"final-review",message:`Final review (${site}) produced no verdict or no findings.`}])};
  const recorded=enforceAttemptFailure(c,s,`final-review:${site}`,[classified],{ok:true},{returnEscalation:true});
  if(!recorded.escalate){
    console.log(`Final review (${site}) reviewer failure ${recorded.failure.domain}/${recorded.failure.class}: retrying the reviewer (no implementer fix pass).`);
    await retryDelay(c,recorded.budget.used+1,recorded.failure.class);
    return {allowed:true};
  }
  return {allowed:false,step:recorded.escalate.step,message:recorded.escalate.message};
}
async function runStandaloneFinalReviewFixRounds({c,s,site,initialReview,mission,phaseList,missionRequirements,declaredPaths,missionBaselineKey}){
  const allTasks=phaseList.flatMap(p=>p.tasks);
  const linkedCommands=linkedVerifyCommandsForPhase(allTasks,c?.gates?.commands);
  // Mission-final reviews run no phase gates: the evidence channel is the
  // reviewer's own observed tool calls against the mission-wide linked set
  // (same helper and shape as the inline refusal checks at both sites).
  const checkSiteRefusal=(candidate)=>shouldRefusePassForEvidence({gateResults:[],toolResults:reviewerLinkedToolResults(candidate,linkedCommands)});
  const missionTasks=allTasks.map(t=>({file:t.file,text:t.text}));
  const digestArgs={framework:"standalone",mission,phaseIndex:phaseList.length,phaseNumber:phaseList.length+1,phaseName:`mission-${site}`,tasks:missionTasks,repoRoot:repo};
  let lastFinalReview=initialReview;
  const reviewOnce=async(summary="")=>{
    const handoff=buildStandaloneHandoff({kind:"MISSION_FINAL",
      deltaChunks:scopedDeltaChunks(repo,missionBaselineKey,{mission,declaredPaths}),
      baselineKey:missionBaselineKey,declaredPaths,
      planPath:standalone.planPath(repo,mission),tasksPath:standalone.tasksPath(repo,mission),
      repoRoot:repo,
      implementationSummary:typeof summary==="string"?summary:""});
    if(handoff.meta.truncated) console.warn(truncationWarning(handoff.meta));
    const budget=roleDeadline(c,s,"code_reviewer");
    const result=await review("code_reviewer",`${handoff.text}\n\n${budget.note}`,
      c,s,"",missionRequirements,null,budget.timeoutMs,false,codeReviewScopeKey("final","standalone"));
    noteRoleDeadlineOutcome(s,"code_reviewer",result,budget.derived);
    lastFinalReview=result;
    return result;
  };
  const standaloneFixResult=await runFinalReviewFixRounds({
    state:s,policy:c.policy,
    initialReview,
    initialEvidenceRefusal:checkSiteRefusal(initialReview),
    initialFindings:rawReviewFindings(initialReview),
    // Mission 062 task 1.3: latest gate-green evidence, rehydrated to a Set
    // (mission-final runs no fresh gate — the stored phase-gate greens win).
    gateGreenFiles:readGateGreenFilesSet(s,missionDirFor(repo,s)),
    recordArgs:{key:`standalone-final:${site}`,phaseTaskDigest:phaseTaskDigest(digestArgs),taskIds:stableTaskIds(digestArgs),factsByTask:undefined,revision:1,carryAllowed:false},
    readFile:fixPassBriefReadFile,
    saveState:()=>saveState(s),
    deps:{
      runFixPass:async({brief,findings,round,used,limit})=>{
        recordCodeReviewRound(s,codeReviewScopeKey("final","standalone"),findings,lastFinalReview?.review?.previous);noteEscalationTrigger(s,c,"implementer",codeReviewScopeKey("final","standalone"),"code_reviewer",lastFinalReview?.review?.previous);
        const earlierRounds=implementerEarlierRoundsText(s,codeReviewScopeKey("final","standalone"));
        const prompt=`Mission-final review FAIL (fix round ${round}/${limit}): address every finding below or rebut it with evidence; do not declare the work complete while any finding stands.\n${feedbackText(findings)}${earlierRounds?`\n\n${earlierRounds}`:""}${brief?`\n${brief}`:""}`;
        const fix=await relay("implementer",prompt,c,s,{resume:false,requirements:missionRequirements});
        if(fix?.policyViolation){
          s.phase="escalated";s.step="relay_policy_violation";s.relayPolicyViolation=fix.policyViolation;saveState(s);
          die(formatRelayPolicyViolation(fix.policyViolation,fix.touchedFiles));
        }
        return fix;
      },
      // Mission-final runs no phase gates (see checkSiteRefusal above).
      runGate:async()=>null,
      runFinalReview:async({round,used,limit,gate,brief,summary})=>{
        const rereview=await reviewOnce(typeof summary==="string"?summary:"");
        if(rereview?.review?.decision==="INCOMPLETE") console.log(`Standalone ${site} final re-review round ${round} INCOMPLETE treated as FAIL (no continuation).`);
        return rereview;
      },
      checkEvidenceRefusal:({review:candidate})=>checkSiteRefusal(candidate),
      recordReviewerFailure:(info)=>recordFinalReviewerFailure(c,s,`standalone-${site}`,info),
    },
  });
  if(standaloneFixResult?.outcome!=="escalate") clearCodeReviewHistory(s,codeReviewScopeKey("final","standalone"));
  return standaloneFixResult;
}

async function runStandaloneImplementation(c,s){
  const stopStage=activeStage;
  ensureStandaloneMigrated(repo,s);
  { const r=ensureStandaloneSplit(repo,s); if(r.migrated){ clearReviewFeedbackByPrefix(s,"standalone-task:"); clearFindingTasksByPrefix(s,"standalone-task:"); clearStaleStandaloneBudgets(s); saveState(s); } }
  const mission=resolveStandaloneMission(repo,s,"");
  const missionDir = getMissionWatchDir(s);

  // Startup reconcile: isolated standalone checkbox snapshot from a crashed
  // process (never shared with SpecKit's pendingCheckboxSnapshot key).
  //
  // F9: the same intent-first rule the SpecKit reconcile applies, stated here
  // too so the rule lives with the reconcile that depends on it instead of
  // resting on the caller's ordering. Redundant while this runner is only ever
  // reached through runImplementation() — whose own guard has already run — and
  // deliberately so: with no debris to drop it is a silent no-op, so it cannot
  // double-print the takeover notice or change a resume's outcome.
  dropAbandonedMissionDebris(c,s);
  if(Object.hasOwn(s,"pendingStandaloneCheckboxSnapshot")){
    const snapshot=s.pendingStandaloneCheckboxSnapshot;
    const tasksFilePath=standalone.tasksPath(repo,mission);
    const v=validateStandaloneSnapshot(snapshot,mission,tasksFilePath);
    if(!v.ok){
      s.phase="escalated";s.step="standalone_snapshot_validation_failed";s.taskMarkingError=v.reason;saveState(s);
      die(`Standalone checkbox snapshot validation failed: ${v.reason}. STOP — human intervention required.`);
    }
    const r=applyTaskCheckboxStates(v.tasks);
    if(!r.ok){
      s.phase="escalated";s.step="standalone_checkbox_reconcile_failed";s.taskMarkingError=r.reason;saveState(s);
      die(`Standalone checkbox reconcile failed: ${r.reason}. STOP — human intervention required.`);
    }
    // Detect appended task tampering: fresh tasks must be a subset of the
    // snapshot identity set. An Implementer must not add new checkboxes that
    // bypass the cached phaseList and final review.
    const freshTasks=standalone.tasks(repo,mission);
    const snapshotIds=new Set(v.tasks.map(t=>`${t.file}:${t.line}`));
    const appended=freshTasks.filter(t=>!snapshotIds.has(`${t.file}:${t.line}`));
    if(appended.length>0){
      s.phase="escalated";s.step="standalone_appended_task_tampering";saveState(s);
      die(`Appended task tampering detected: ${appended.length} new checkbox(es) not in snapshot. STOP — human intervention required.`);
    }
    delete s.pendingStandaloneCheckboxSnapshot;saveState(s);
  }

  // Resolve phases, declared paths, and mission baseline before either
  // final-review path can execute (v8 correction #4).
  const phaseList=standalone.phases(repo,mission);
  if(typeof s.phaseIndex!=="number"||s.phaseIndex<0) s.phaseIndex=0;
  // Mission 090 task 1.5: stage-scoped stop — when stopStage is set, only
  // that stage of the CURRENT phase runs (implementer→implement,
  // code_reviewer→review, verifier+mark_tasks→verify). Each stop persists
  // its checkpoint and returns before the mission-final review, so the next
  // stage command resumes from it. Null (a plain run) is untouched.
  const stopPhaseIndex=s.phaseIndex;
  const stopAllowedStages=stopStage==="implement"?["implementer"]:stopStage==="review"?["code_reviewer"]:stopStage==="verify"?["verifier","mark_tasks"]:null;
  const stopAfterStage=(label)=>{
    console.log(`Stage '${stopStage}' complete — stopping after ${label} (resume with the next stage command).`);
  };
  const declaredPaths=standalone.declaredDeliverables(repo,mission);
  const missionIdentity=s.mission||s.missionSeq||"mission";
  const missionBaselineKey=`mission-${sanitizeKeySegment(missionIdentity)}`;

  // Historical baseline: only when demonstrably pre-implementation.
  const baselineExists=fs.existsSync(path.join(repo,".autopilot","baseline",missionBaselineKey,"manifest.json"));
  if(!baselineExists){
    const allUndone=phaseList.every(p=>p.tasks.every(t=>!t.done));
    const noSnapshot=!Object.hasOwn(s,"pendingStandaloneCheckboxSnapshot")&&!Object.hasOwn(s,"pendingCheckboxSnapshot");
    if(!(s.phase==="tasks_ready"&&allUndone&&noSnapshot)){
      die("MIGRATION_BASELINE_MISSING: historical baseline does not exist and cannot be safely created (mission not demonstrably pre-implementation).");
    }
  }
  // Ensure baseline exists and declaredPaths match. If the baseline already
  // existed and declaredPaths changed, this throws DECLARATION_MISMATCH early
  // instead of deferring the error to final review.
  ensureBaseline(repo,missionBaselineKey,{mission,declaredPaths});

  // Compute mission-wide requirements for final review (v8 correction #1).
  const missionRequirements=phaseList.flatMap(p=>p.tasks.flatMap(t=>t.requiredCapabilities||[]));

  // No-pending early path: final review with MISSION-scoped delta.
  const pendingTasks=phaseList.some(p=>p.tasks.some(t=>!t.done));
  if(!pendingTasks){
    if(stopStage){
      // Mission 090 task 1.5: a stage run never enters mission-final review.
      stopAfterStage(stopStage);
      return;
    }
    // A crash after the final setTaskCheckboxes() but before checkpoint
    // deletion lands here with a stale active checkpoint still bound to the
    // last phase — it must not survive its completed mission.
    if(Object.hasOwn(s,CHECKPOINT_STATE_KEY)){ delete s[CHECKPOINT_STATE_KEY];saveState(s); }
    s.phase="final_review";s.step="final_review";saveState(s);
    const finalHandoff=buildStandaloneHandoff({kind:"MISSION_FINAL",
      deltaChunks:scopedDeltaChunks(repo,missionBaselineKey,{mission,declaredPaths}),
      baselineKey:missionBaselineKey,declaredPaths,
      planPath:standalone.planPath(repo,mission),tasksPath:standalone.tasksPath(repo,mission),
      repoRoot:repo,
      implementationSummary:""});
    if(finalHandoff.meta.truncated) console.warn(truncationWarning(finalHandoff.meta));
    // TASK-26: the mission-final review gets a measured deadline too.
    const finalBudget=roleDeadline(c,s,"code_reviewer");
    let final=await review("code_reviewer",`${finalHandoff.text}\n\n${finalBudget.note}`,
      c,s,"",missionRequirements,null,finalBudget.timeoutMs,false,codeReviewScopeKey("final","standalone"));
    noteRoleDeadlineOutcome(s,"code_reviewer",final,finalBudget.derived);
    if(final.status==="completed"&&!final.policyViolation&&final.review?.decision==="PASS"){
      // Mission 025 task 2.4 (no-pending early final path): same mission-wide
      // linked-verify refusal as the post-loop final review below. Only
      // commands matching a linked task verify or gate command count.
      const earlyFinalRefusal=shouldRefusePassForEvidence({gateResults:[],toolResults:reviewerLinkedToolResults(final,linkedVerifyCommandsForPhase(phaseList.flatMap(p=>p.tasks),c?.gates?.commands))});
      if(earlyFinalRefusal?.refuse===true){s.phase="escalated";saveState(s);die("Final review failed.");}
    }
    // Mission 031 Phase 3 task 3.5: INCOMPLETE-as-FAIL (no continuation): standalone-early-final-review has no continuation loop — an INCOMPLETE decision is treated as FAIL with explicit reason and never consumes a continuation.
    if(final.review?.decision==="INCOMPLETE") console.log("Standalone early final review INCOMPLETE treated as FAIL (no continuation).");
    if(final.status!=="completed"||final.policyViolation||final.review?.decision!=="PASS"){
      // Mission 051 task 1.3: route the early-final FAIL through the shared
      // bounded fix-round driver (finding record, fixPassBriefExcerpts
      // brief, implementer fix pass, fresh-handoff re-review, evidence
      // check). The linked-evidence refusal above already escalated
      // (bypass, no round consumed); a policy violation bypasses inside the
      // helper and lands back here. Only budget exhaustion (or a mid-loop
      // refusal/policy path) escalates, keeping today's message and step
      // `final_review`.
      const earlyFinalFix=await runStandaloneFinalReviewFixRounds({c,s,site:"early-final",initialReview:final,mission,phaseList,missionRequirements,declaredPaths,missionBaselineKey});
      if(earlyFinalFix.outcome==="passed"){final=earlyFinalFix.review;}
      else{s.phase="escalated";s.step=earlyFinalFix.step||"final_review";saveState(s);die(earlyFinalFix.message||"Final review failed.");}
    }
    finalizeMissionComplete(s);
    console.log("ALL WORK COMPLETE — HUMAN COMMIT REQUIRED");
    return;
  }

  s.phase="implementing";saveState(s);

  for(;s.phaseIndex<phaseList.length;s.phaseIndex++){
    if(s.operatorPhaseNote&&Number.isInteger(s.operatorPhaseNote.phaseIndex)&&s.operatorPhaseNote.phaseIndex!==s.phaseIndex){ delete s.operatorPhaseNote; saveState(s); }
    const phase=phaseList[s.phaseIndex];
    if(stopStage&&s.phaseIndex!==stopPhaseIndex){
      // Mission 090 task 1.5: a stage covers the current phase only (one
      // phase, not all phases) — never advance into the next phase.
      stopAfterStage(stopStage);
      return;
    }
    // TASK-39 follow-up: the warning from a previous phase is cleared
    // when a new phase starts (the state flag also records which phase
    // raised it, so briefs and the report for the phase that produced
    // the blocks still show it).
    if(s.fixtureGitBlockWarning && s.fixtureGitBlockWarningPhaseIndex!==s.phaseIndex){ delete s.fixtureGitBlockWarning; delete s.fixtureGitBlockWarningPhaseIndex; }
    let phaseTasks=phase.tasks.filter(t=>!t.done);
    if(!phaseTasks.length){
      // Every task already checked: a stale checkpoint must not survive
      // its completed phase — clear it and advance.
      if(Object.hasOwn(s,CHECKPOINT_STATE_KEY)){ delete s[CHECKPOINT_STATE_KEY];saveState(s); }
      continue;
    }
    const phaseKey=`standalone-phase:${s.phaseIndex}`;
    const phaseRequirements=phaseTasks.flatMap(t=>t.requiredCapabilities||[]);
    // TASK-20: reviewer-facing task labels — position i is phaseTaskIds[i],
    // labelled 1-based by taskLabel() (never derived inline; a stable task
    // ID's own T segment is 0-based, see finding-task-locality.mjs).
    const scope=phaseTasks.map((t,i)=>`- [${taskLabel(i)}] ${t.text} (${t.file}:${t.line})`).join("\n");
    const phaseBaselineKey=`${missionBaselineKey}-phase-${s.phaseIndex}`;
    ensureBaseline(repo,phaseBaselineKey,{mission,declaredPaths});
    warnHeadMovedSinceBaseline(s,phaseBaselineKey);

    // Durable phase-stage checkpoint (TASK-7): absent or bound elsewhere →
    // revision 1 at the Implementer; present but malformed → fail closed. A
    // checkpoint bound to another phase here is corruption, never a resume
    // — the completed-phase path above clears stale ones.
    const taskIdentities=()=>phaseTasks.map(t=>({file:t.file,text:t.text}));
    let checkpoint=s[CHECKPOINT_STATE_KEY]??null;
    if(!isCheckpointForPhase(checkpoint,{framework:"standalone",mission,phaseIndex:s.phaseIndex})){
      if(checkpoint!==null&&checkpoint!==undefined){
        s.phase="escalated";s.step="standalone_checkpoint_identity_mismatch";
        s.phaseCheckpointError={code:"PHASE_CHECKPOINT_INVALID",expected:{framework:"standalone",mission,phaseIndex:s.phaseIndex},observed:{framework:checkpoint.framework,mission:checkpoint.mission,phaseIndex:checkpoint.phaseIndex}};
        saveState(s);
        die(`Standalone phase checkpoint is bound to a different phase/mission. STOP — human intervention required.`);
      }
      checkpoint=createCheckpoint({framework:"standalone",mission,phaseIndex:s.phaseIndex,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo,baselineKey:phaseBaselineKey,at:now()});
      s[CHECKPOINT_STATE_KEY]=checkpoint;s.attempt=1;saveState(s);
    }else{
      const structural=validateCheckpoint(checkpoint);
      if(!structural.ok){
        s.phase="escalated";s.step="standalone_checkpoint_invalid";
        s.phaseCheckpointError={code:structural.code,reason:structural.reason,evidence:structural.evidence};
        saveState(s);
        die(`Standalone phase checkpoint failed validation: ${structural.reason}. STOP — human intervention required.`);
      }
      if(typeof s.attempt!=="number"||s.attempt<1) s.attempt=1;
      // Backlog #105: an operator resume (new process) never reuses a recorded gate result; only the in-process verifier infra retry may.
      delete checkpoint.lastGate;
    }

    // TASK-19 Phase 3 task 10: produce the orchestrator-owned phase brief
    // before the first per-task invocation. Deliberately a no-op until the
    // checkpoint carries roleProgress (i.e. per-task dispatch has started), so
    // phase-level runs are byte-for-byte unchanged.
    ensurePhaseBriefForCheckpoint({repo,mission,framework:"standalone",checkpoint,phase:{name:phase.name,phaseTotal:phaseList.length},tasks:phaseTasks.map(t=>({id:t.id,text:t.text})),planContext:scope});

    // Merge a stage-transition decision into the checkpoint: next stage,
    // cleared running stage, revision, display/backoff attempts, and — for
    // Implementer completion — the recorded approval evidence. Retry and
    // escalation authority stays entirely with enforceAttemptFailure()'s
    // return value; this only persists what decideTransition computed. The
    // per-stage attempts counters are never compared against a limit here.
    const applyCheckpointTransition=(transition)=>{
      if(!transition.ok){
        s.phase="escalated";s.step="standalone_transition_invalid";
        s.phaseCheckpointError={code:transition.code||"PHASE_CHECKPOINT_INVALID",reason:transition.reason,evidence:transition.evidence};
        saveState(s);
        die(`Standalone phase transition failed: ${transition.reason}. STOP — human intervention required.`);
      }
      // TASK-29: persist which stage (if any) owns a pending retry pause.
      // `retry` (infrastructure/adapter failure) arms the pause for
      // `nextStage`; every other action clears it.
      checkpoint={...checkpoint,nextStage:transition.nextStage,runningStage:null,revision:transition.revision,attempts:transition.attempts,retryPauseStage:retryPauseStageOf(transition)};
      clearContinuationGateResult(checkpoint);
      // Backlog #105: the recorded gate survives only a verifier infra retry; a functional rejection / restart re-runs gates.
      if(!(transition.action==="retry"&&transition.nextStage==="verifier")) delete checkpoint.lastGate;
      if(transition.clearApprovals){ checkpoint.codeReviewer=null;checkpoint.verifier=null;checkpoint.roleProgress=emptyRoleProgress();checkpoint.roleProgressWorkAhead=[]; }
      return checkpoint;
    };

    // TASK-20 step 1 (record) + TASK-21 step 2 (carry forward): map the RAW
    // verdict findings (never the rendered feedback strings, which
    // renderFinding() has already flattened) onto this phase's unfinished
    // tasks and persist the record under the SAME key the review feedback
    // was just saved to. Each FAIL site calls this AFTER saveReviewFeedback()
    // and BEFORE applyCheckpointTransition(), while
    // roleProgress.implementer.factsByTask still holds the pre-wipe file
    // ownership; the digest binds the record to the task list it was taken
    // from so a later phase cannot inherit it. `revision` is read here, so
    // it is the pre-transition revision N; the retry at N+1 replays from
    // it. `carryAllowed` is true for a code-review FAIL and for a verifier
    // FAIL (TASK-21 step 2, c-gap 2): a red gate command only says the phase
    // is not done, while the findings that arrive with it name the tasks —
    // the fail-closed rule lives in `allMapped`, which an empty or unmapped
    // entry list turns into an empty carry.
    const recordPhaseFindingTasks=(key,findings,carryAllowed)=>{
      recordFindingTasks(s,key,{
        phaseTaskDigest:phaseTaskDigest({framework:"standalone",mission,phaseIndex:s.phaseIndex,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo}),
        findings,
        taskIds:stableTaskIds({framework:"standalone",mission,phaseIndex:s.phaseIndex,phaseNumber:s.phaseIndex+1,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo}),
        factsByTask:checkpoint.roleProgress?.implementer?.factsByTask,
        revision:checkpoint.revision,
        carryAllowed,
      });
    };

    let passed=false;
    let feedback=feedbackText(loadReviewFeedback(s,phaseKey));

    console.log(`\n  Phase ${s.phaseIndex+1}/${phaseList.length}: ${phase.name} — ${phaseTasks.length} task(s)`);

    // Role results from this process, kept so combined failure
    // classification sees the same evidence as before. A resumed process
    // has none: the checkpoint's stored approvals plus digest-matched
    // evidence stand in their place.
    let lastImpl=null,lastReview=null;

    while(!passed){
      phaseTasks=phase.tasks.filter(t=>!t.done);
      if(!phaseTasks.length){
        // All checked mid-loop: same stale-clearance as the entry path.
        if(Object.hasOwn(s,CHECKPOINT_STATE_KEY)){ delete s[CHECKPOINT_STATE_KEY];saveState(s); }
        passed=true;
        continue;
      }
      s.currentPhase={name:phase.name,tasks:phaseTasks};s.currentTask=phaseTasks[0];s.feedback=feedback;saveState(s);
      // Stage-conditional observations for the shared gate evaluator: the
      // task digest always; the full delta digest only for approval-reuse
      // stages. An interrupted Implementer legitimately leaves a partial
      // delta, so it is neither computed nor compared while the
      // Implementer is the resume stage.
      const stage=resumeStage(checkpoint);
      const observed={phaseTaskDigest:phaseTaskDigest({framework:"standalone",mission,phaseIndex:s.phaseIndex,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo})};
      if(isApprovalReuseStage(stage)){
        try{
          observed.deltaDigest=deltaDigest(scopedDelta(repo,phaseBaselineKey,{mission,declaredPaths}));
        }catch(e){
          if(e?.code==="DECLARATION_MISMATCH") observed.deltaError=e;
          else throw e;
        }
      }
      const gate=evaluatePlanningGate(checkpoint,"standalone",{mission,phaseIndex:s.phaseIndex,allChecked:false},observed);
      if(gate.action==="escalate"){
        s.phase="escalated";s.step="standalone_checkpoint_drift";
        s.phaseCheckpointError={code:gate.code,evidence:gate.evidence};
        saveState(s);
        die(`Standalone phase checkpoint ${gate.code==="PHASE_CHECKPOINT_DRIFT"?"drifted":"is invalid"}; refusing to reuse approval. STOP — human intervention required.`);
      }
      if(gate.action!=="resume"){
        s.phase="escalated";s.step="standalone_checkpoint_gate";
        s.phaseCheckpointError={code:"INTERNAL_CONTRACT_ERROR",evidence:gate};
        saveState(s);
        die(`Standalone phase checkpoint gate returned ${gate.action} inside the implementation loop. STOP — human intervention required.`);
      }
      if(stopAllowedStages&&!stopAllowedStages.includes(stage)){
        // Mission 090 task 1.5: this run left its stage's scope (e.g. a
        // review/verify FAIL returned to the Implementer) — stop cleanly on
        // the saved checkpoint; the next stage command resumes from it.
        // Infra retries stay inside their stage and loop on.
        stopAfterStage(stopStage);
        return;
      }

      if(stage==="implementer"){
        if(checkpoint.attempts.implementer>0){ s.attempt+=1;saveState(s);await maybeRetryPause(c,s,checkpoint,"implementer"); }
        s.step="implement";
        // Durable interruption signal: runningStage was persisted BEFORE the
        // previous Implementer launch, so a hard kill (no result processed,
        // attempts.implementer still 0) still reads "implementer" here.
        // attempts alone cannot distinguish a kill from a first attempt.
        const implementerInterrupted=checkpoint.runningStage==="implementer";
        checkpoint.runningStage="implementer";s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);

        // Snapshot tasks for crash recovery BEFORE the Implementer runs.
        const preAttemptTasks=standalone.snapshotTasks(repo,mission);
        s.pendingStandaloneCheckboxSnapshot={feature:null,mission,tasks:preAttemptTasks,capturedAt:now()};saveState(s);

        // Worktree listing before the Implementer (git-invisible guard).
        let attemptFsBefore=null;
        try{ attemptFsBefore=listWorktreeEntries(repo); }catch{ attemptFsBefore=null; }

        // A retry without the rejection it is retrying against can only guess
        // (or re-read the review out of runs/) — the exact gap the standalone
        // plan loop and the GSD plan-unit loop already close by quoting findings
        // verbatim. `feedback` holds the code_reviewer/verifier findings from
        // the previous attempt (or the resumed rejection), empty on attempt 1.
        // TASK-24: no phase-wide retryFindings here — each re-run task's
        // brief is built per task inside the loop below (after the carry
        // decision), so a task gets only its own findings plus the
        // phase-wide/unlinked ones.
        // An interrupted or rejected Implementer left partial work behind:
        // continue it rather than starting over. attempts.implementer covers
        // rejections (a result was processed); implementerInterrupted covers
        // hard kills (runningStage was persisted before the launch that died
        // and no attempt was ever recorded).
        const resumeNote=(checkpoint.attempts.implementer>0||implementerInterrupted)
          ? `\n\nA previous Implementer run for this phase was interrupted or rejected: inspect the existing work in the tree and continue it rather than starting over.`
          : "";
        // TASK-19 Phase 4 (task 12): one fresh invocation per task. The phase
        // remains the revision and approval unit; the per-role cursor in the
        // checkpoint is the only progress authority. `resume:false` is enforced
        // by this call site, never merely suggested by configuration, so no
        // invocation can inherit a prior task's adapter session.
        if(!checkpoint.roleProgress) checkpoint.roleProgress=emptyRoleProgress();
        ensurePhaseBriefForCheckpoint({repo,mission,framework:"standalone",checkpoint,phase:{name:phase.name,phaseTotal:phaseList.length},tasks:phaseTasks.map(t=>({id:t.id,text:t.text})),planContext:scope});
        // TASK-19 Phase 5 task 14: a real per-task deadline (strictly below the
        // relay backstop by config validation), applied per invocation so one
        // task cannot consume another's allowance.
        const perTaskLimits=resolvePerTaskLimits(c.policy, Number(c.policy?.relay_timeout_ms)>0?Number(c.policy.relay_timeout_ms):RELAY_TIMEOUT_DEFAULT_MS);
        const phaseTaskIds=stableTaskIds({framework:"standalone",mission,phaseIndex:s.phaseIndex,phaseNumber:s.phaseIndex+1,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo});
        const phaseTaskDigestValue=phaseTaskDigest({framework:"standalone",mission,phaseIndex:s.phaseIndex,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo});
        const expectedRunId=`${mission}:phase-${s.phaseIndex}`;
        let impl=null;
        // Mission 093 Part 1 task 2.5: this loop's carry layout — the task
        // ids carryDecision carries forward, in plan order. The implementer
        // attempt run that follows each carry snapshots the list as
        // carriedForwardTasks; attempt runs before the first carry record
        // null. Never fabricated — only real carryDecision results enter.
        const carriedTasks=[];
        for(;;){
          const cursorResume=evaluateCrashResume({progress:checkpoint.roleProgress,role:"implementer",taskIds:phaseTaskIds});
          if(cursorResume.action==="complete") break;
          if(cursorResume.action!=="resume"){
            s.phase="escalated";s.step="standalone_role_progress_cursor";
            s.phaseCheckpointError={code:"INTERNAL_CONTRACT_ERROR",evidence:cursorResume};
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            die(`Standalone Implementer cursor is not resumable (${cursorResume.action}). STOP — human intervention required.`);
          }
          const taskId=cursorResume.taskId;
          const taskIndex=phaseTaskIds.indexOf(taskId);
          // 003#32: the watch-report header reads s.currentTask, which was
          // set once to phaseTasks[0] at phase start — advance it to the task
          // the cursor is actually on (launched or carried below), so the
          // dashboard never reports a stale first task. taskIndex IS the
          // position of taskId (indexOf above), parallel to phaseTasks.
          if(taskIndex>=0){ s.currentTask=phaseTasks[taskIndex]; saveState(s); }
          const prep=prepareTaskInvocation({progress:checkpoint.roleProgress,role:"implementer",runId:expectedRunId,revision:checkpoint.revision,phaseTaskDigest:phaseTaskDigestValue,taskId,taskIds:phaseTaskIds});
          if(!prep.ok){
            s.phase="escalated";s.step="standalone_role_progress_invalid";
            s.phaseCheckpointError={code:prep.code,reason:prep.reason,evidence:prep.evidence};
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            die(`Standalone Implementer task cursor failed validation: ${prep.reason}. STOP — human intervention required.`);
          }
          // Persist currentTaskId/cursor BEFORE launch (step 1); a crash after
          // this point resumes exactly this task.
          checkpoint.roleProgress=prep.progress;
          checkpoint.runningStage="implementer";s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);

          // TASK-21 step 2 (carry forward): the retry walks the tasks in
          // plan order through the normal cursor path above. A task the
          // review findings did NOT name is carried, not re-run: its
          // previous facts are re-committed through the same
          // commitTaskResult call the normal path uses, under the new
          // revision — no progress object is ever merged forward, only
          // facts are replayed through the validated path. The wipe and
          // the cursor rules are untouched. A kill between the `prep`
          // persist above and the carry commit below leaves currentTaskId
          // on this task, and the restart re-evaluates carryDecision to
          // the same result — no extra state needed.
          const findingRecord=loadFindingTasks(s,phaseKey,{phaseTaskDigest:phaseTaskDigestValue});
          const carried=carryDecision({record:findingRecord,taskId,progress:checkpoint.roleProgress,revision:checkpoint.revision,phaseTaskDigest:phaseTaskDigestValue});
          if(carried.carry){
            maybeInjectCarryCrash(taskId);
            const normalized={role:"implementer",runId:expectedRunId,revision:checkpoint.revision,phaseTaskDigest:phaseTaskDigestValue,taskId,status:"completed",facts:carried.facts};
            const carryCommitted=commitTaskResult({progress:checkpoint.roleProgress,expected:prep.expected,result:normalized});
            if(!carryCommitted.ok){
              s.phase="escalated";s.step="standalone_task_carry_invalid";
              s.phaseCheckpointError={code:carryCommitted.code,reason:carryCommitted.reason,evidence:carryCommitted.evidence};
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
              die(`Standalone Implementer carry-forward commit failed: ${carryCommitted.reason}. STOP — human intervention required.`);
            }
            checkpoint.roleProgress=carryCommitted.progress;
            clearTaskContinuation(s,`task:standalone:phase-${s.phaseIndex}:${taskId}`);
            clearRolloverDeadEnds(s,`task:standalone:phase-${s.phaseIndex}:${taskId}`);
            clearBackstopFirings(s,`task:standalone:phase-${s.phaseIndex}:${taskId}`);
            // Backlog #26 Step A: a carried task converged without running —
            // its hand-off note dies with it too, like the allowance above.
            // Backlog #26 Step B: its session store dies with it too (size
            // logged first; kept on escalation, like the note).
            logSessionStoreSize(mission,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
            clearSessionStore(mission,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
            clearHandoffNote(mission,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
            clearLastContinuation(s,`task:standalone:phase-${s.phaseIndex}:${taskId}`);
            // No detectWorkAhead for carried tasks: no new files were written.
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            carriedTasks.push(taskId);
            console.log(`  Task ${taskId} carried forward — not named by the review findings`);
            continue;
          }

          let beforeMap, anchoredTestsNote="";
          try{ const beforeChunks=scopedDeltaChunks(repo,phaseBaselineKey,{mission,declaredPaths}); beforeMap=attributionMap(beforeChunks); anchoredTestsNote=anchoredTestsSection(beforeChunks); }
          catch(e){
            s.phase="escalated";s.step="standalone_delta_mismatch";
            s.phaseCheckpointError={code:e?.code||"DELTA_COMPUTATION_FAILED",evidence:{message:e?.message||String(e)}};
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            die(`Standalone task attribution failed before task ${taskIndex+1}: ${e?.message||e}. STOP — human intervention required.`);
          }
          const promptBuilt=buildTaskPrompt({
            framework:"standalone",mission,phaseIndex:s.phaseIndex,phaseNumber:s.phaseIndex+1,phaseName:phase.name,phaseTotal:phaseList.length,
            revision:checkpoint.revision,role:"implementer",phaseTaskDigest:phaseTaskDigestValue,
            taskIds:phaseTaskIds,tasks:phaseTasks,currentTaskId:taskId,roleProgress:checkpoint.roleProgress,
            phaseBriefPath:phaseBriefRelativePath(mission,s.phaseIndex+1),
            deadEnds:readRolloverDeadEnds(s,`task:standalone:phase-${s.phaseIndex}:${taskId}`),
            handoffNote:readHandoffNote(mission,taskDisplayRef(phaseTasks[taskIndex],taskIndex)),
            handoffNoteExcerpts:handoffNoteExcerptsFor(mission,taskDisplayRef(phaseTasks[taskIndex],taskIndex)),
            handoffNoteMaxChars:resolveHandoffNoteMaxChars(c.policy),
            handoffPerTaskMaxTurns:resolvePerRoleLimits('implementer',c.policy,(()=>{const e=effectiveRoleModelFor(s,c,'implementer');const pat=e? (agents[e.adapter]?.free_model_pattern ?? null):null;return e?{adapter:e.adapter,model:e.model,free_model_pattern:pat}:{};})()).perTaskMaxTurns,
            fixtureGitBlockWarning:s.fixtureGitBlockWarning,
            gitGuardWarning:s.gitGuardWarning,
          });
          if(!promptBuilt.ok){
            s.phase="escalated";s.step="standalone_prompt_invalid";
            s.phaseCheckpointError={code:promptBuilt.code,reason:promptBuilt.reason,evidence:promptBuilt.evidence};
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            die(`Standalone per-task prompt assembly failed: ${promptBuilt.reason}. STOP — human intervention required.`);
          }
          // TASK-24 step 4: each re-run task's brief gets only its own
          // findings, plus every phase-wide/unlinked one. A carried task
          // has no prompt, so nothing is built for it (see the continue
          // above). `feedback` keeps today's whole-phase wording for the
          // non-mapped cases; the reviewer still gets the full `feedback`
          // as FEEDBACK TO ADDRESS (see the review() call below).
          let taskRetryFindings="";
          if(feedback){
            const taskFindings=loadReviewFeedback(s,phaseKey);
            if(taskFindings.length===0){
              taskRetryFindings=`\n\nReviewer feedback from the previous attempt that MUST be addressed — fix every finding or rebut it with evidence, do not declare the work complete while any finding stands:\n${feedback}`;
            }else{
              const grouped=findingsForTask({findings:taskFindings,record:findingRecord,taskId,revision:checkpoint.revision});
              if(grouped.fallback){
                taskRetryFindings=`\n\nReviewer feedback from the previous attempt that MUST be addressed — fix every finding or rebut it with evidence, do not declare the work complete while any finding stands:\n${feedback}`;
              }else{
                const sections=[];
                if(grouped.own.length) sections.push(`Findings for this task:\n${feedbackText(grouped.own)}`);
                if(grouped.phaseWide.length) sections.push(`Phase-wide findings (they concern every task in this phase, including this one):\n${feedbackText(grouped.phaseWide)}`);
                if(grouped.unlinked.length) sections.push(`Findings not linked to a specific task (check whether they concern this task):\n${feedbackText(grouped.unlinked)}`);
                // Mission 052 (a): findings another task owns reach this
                // brief as READ-ONLY context, so the excerpt block below
                // stays fed by own+phaseWide+unlinked only.
                const handledBlock=renderHandledFindings(grouped.handled);
                if(sections.length){
                  const fixPassBlock=fixPassBriefExcerpts([...grouped.own,...grouped.phaseWide,...grouped.unlinked],fixPassBriefReadFile);
                  taskRetryFindings=`\n\nReviewer feedback from the previous attempt that MUST be addressed — fix every finding or rebut it with evidence, do not declare the work complete while any finding stands:\n${sections.join("\n")}\n${fixPassHandoffPointer(readHandoffNote(mission,taskDisplayRef(phaseTasks[taskIndex],taskIndex)))}${fixPassBlock}`;
                }else if(carried.reason==="overlap"&&carried.overlap){
                  const labels=(carried.overlap.taskIds??[]).map(id=>{const idx=phaseTaskIds.indexOf(id);return idx>=0?taskLabel(idx):id;}).join(", ");
                  const files=(carried.overlap.files??[]).join(", ");
                  taskRetryFindings=`\n\nThis task is being re-run because the fix for task(s) ${labels} changed file(s) it owns: ${files}. That fix is already done — do not redo it. Re-verify this task against its acceptance criteria and repair only what the change broke.`;
                }else if(carried.reason==="local-check-failed"){
                  taskRetryFindings=`\n\nThis task is being re-run because its own local check failed last time. Re-run that check and fix this task until it passes.`;
                }else{
                  taskRetryFindings=`\n\nThis task is being re-run. Re-verify it against its acceptance criteria.`;
                }
                // Appended outside the branch above, so a task that has no
                // finding of its own still learns which neighbour's work it
                // must not redo.
                if(handledBlock) taskRetryFindings+=`\n\n${handledBlock}`;
                {const earlierCodeRounds=implementerEarlierRoundsText(s,codeReviewScopeKey("standalone-phase",s.phaseIndex));if(earlierCodeRounds) taskRetryFindings+=`\n\n${earlierCodeRounds}`;}
              }
            }
          }
           const autoRejectNote=autoRejectRetryNote([lastImpl,lastReview,impl].filter(Boolean));
           // Mission 093 Part 1 task 2.3: the run scope owning this attempt's
           // session number (continuation-budget used at launch + 1).
const operatorNote=operatorPhaseNoteLine(s);
const taskImpl=await relay("implementer",`${promptBuilt.text}${taskRetryFindings}${resumeNote}${autoRejectNote}${anchoredTestsNote?`\n\n${anchoredTestsNote}`:""}${operatorNote?`\n\n${operatorNote}`:""}`,c,s,{resume:false,requirements:phaseRequirements,timeoutMs:perTaskLimits.perTaskTimeoutMs,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex),capEnabled:true,contScope:`task:standalone:phase-${s.phaseIndex}:${taskId}`,carriedForwardTasks:[...carriedTasks]});
            impl=taskImpl;
            // Mission 093 Part 1 task 3.4: capture git diff --stat after implementer attempt
            if (missionDir) {
              let diffStat = null;
              try { diffStat = changedFilesStat(repo); } catch { diffStat = null; }
              const attempt = (checkpoint?.attempts?.implementer ?? 0) + 1; // 1-based: counter increments after the stage, gate events read it afterwards
              try { appendWatchEvent(missionDir, { type: "diff_stat", phase: s.phaseIndex + 1, attempt, taskRef: taskDisplayRef(phaseTasks[taskIndex], taskIndex), stat: diffStat }); } catch {}
            }
            maybeInjectPostRoleCrash();
           if(taskImpl.policyViolation){
             reconcileTaskCheckboxesBeforePolicyDie(s,preAttemptTasks,"Standalone","pendingStandaloneCheckboxSnapshot");
             s.phase="escalated";s.step="relay_policy_violation";s.relayPolicyViolation=taskImpl.policyViolation;
             s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
             die(formatRelayPolicyViolation(s.relayPolicyViolation, taskImpl.touchedFiles));
           }
            if(taskImpl.capped){
              // Mission 047 Phase 1 task 1.2: cumulative raw-token backstop
              // rollover, BEFORE the cap path below. A continuation event on
              // the SEPARATE backstop firing ledger (state.backstopFirings via
              // recordBackstopFiring), never the continuation allowance:
              // consumeContinuation is NOT called here, so the extra_sessions
              // ledger is untouched and failure budgets are never reached. The
              // session already stopped via the orchestrator fallback-note path
              // (wrapUp orchestrator_fallback above), so the next generation
              // resumes from the fallback note + digest; no dead-end entry is
              // recorded (the fallback note carries the resume context).
              // Mission 047 Phase 1 task 1.3: the second consecutive firing
              // escalates as runaway_session_escalation with evidence (total
              // raw tokens, turns, largest single-turn context, both firings)
              // instead of starting a third session; the first firing always
              // continues below.
              if(taskImpl.capped.backstop===true||taskImpl.capped.type==="backstop"){
                const contScope=`task:standalone:phase-${s.phaseIndex}:${taskId}`;
                const firings=recordBackstopFiring(s,contScope,{generation:readBackstopFirings(s,contScope).length+1,totalRawTokens:taskImpl.capped.used,turns:Number.isInteger(taskImpl.usage?.turns)?taskImpl.usage.turns:null,maxSingleTurnContext:Number.isFinite(Number(taskImpl.usage?.maxSingleTurnContext))?Number(taskImpl.usage.maxSingleTurnContext):null});
                if(evaluateBackstopEscalation(firings).escalate){
                  const last=firings[firings.length-1]||{};
                  s.phase="escalated";s.step="runaway_session_escalation";
                  s.phaseCheckpointError={code:"BACKSTOP_CONSECUTIVE_FIRINGS",evidence:{taskId,totalRawTokens:last.totalRawTokens??taskImpl.capped.used,turns:last.turns??null,maxSingleTurnContext:last.maxSingleTurnContext??null,firings:[...firings]}};
                  s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
                  die(`Standalone task ${taskId} fired the cumulative backstop twice in a row (${last.totalRawTokens??taskImpl.capped.used}/${taskImpl.capped.limit} cumulative raw tokens, ${last.turns??"?"} turns, largest single-turn context ${last.maxSingleTurnContext??"?"}). STOP — human intervention required.`);
                }
                s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
                stopOnNoProgress(s,c,{framework:"standalone",contScope,taskId,missionName:mission,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex),touchedFiles:taskImpl.touchedFiles,checkpoint});
                console.log(`Task ${taskId} crossed the cumulative backstop (${taskImpl.capped.used}/${taskImpl.capped.limit} cumulative raw tokens); wrap-up note: ${taskImpl.wrapUp?.status||"unknown"}${taskImpl.wrapUp?.reason?` (${taskImpl.wrapUp.reason})`:""}; continuing as backstop session ${firings.length+1}.`);
                continue;
              }
              // Backlog 003#15 (ceiling) + 003#17 (continuation): a cap breach
             // is a continuation event, never a failure — failure budgets are
            // untouched on this path. Consume one continuation generation for
            // this task and record the dead end; `continue` re-enters the
            // cursor loop, which still points at this uncommitted task, so
            // the next pass relaunches it fresh (resume:false) with the
            // dead-ends transfer in its prompt. Exhausted allowance
            // escalates as not-converging.
            const contScope=`task:standalone:phase-${s.phaseIndex}:${taskId}`;
            // Mission 047 Phase 1 task 1.2: this generation ended WITHOUT a
            // backstop firing, so the consecutive-firing count resets (PLAN:
            // two CONSECUTIVE firings escalate — an interleaving ordinary
            // generation breaks the streak).
            clearBackstopFirings(s,contScope);
            // Backlog #27: a queued `ap reset --scope <continuation>` applies at
            // this decision, before the next generation is consumed.
            maybeApplyPendingContinuationReset(s,contScope);
            const cont=consumeContinuation(s,c.policy,contScope);
            // Files-first dead-end tail: what this generation completed is
            // the resume point the next one needs; the killed run's output
            // tail is supporting detail only. Guarded — a delta failure on
            // a continuation path degrades to the output tail, never dies.
            let capFiles=[];
            try{
              capFiles=attributedChangedPaths(beforeMap,attributionMap(scopedDeltaChunks(repo,phaseBaselineKey,{mission,declaredPaths})));
            }catch{}
            // Backlog #22: the handoff carries the decoded-events digest
            // (taskImpl.workDigest), never the raw finalMessage/output tail —
            // a capped session dies mid-tool-calls with no text event, so the
            // raw tail is a JSON-event fragment that starts the next session
            // blind. Empty digest degrades to the marker, never to raw bytes.
            recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:taskImpl.capped.type,used:taskImpl.capped.used,limit:taskImpl.capped.limit,tail:deadEndTail({files:capFiles,outputTail:taskImpl.workDigest?taskImpl.workDigest:"(no decoded activity)",maxChars:resolveHandoffMaxChars(c.policy)})});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            if(!cont.allowed){
              // Dead ends are deliberately NOT cleared here: per-task keys
              // cannot leak into another task, and the entries are the
              // post-mortem record of why this task never converged.
              s.phase="escalated";s.step="standalone_task_not_converging";
              s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{taskId,used:cont.used,limit:cont.limit,breach:taskImpl.capped.type}};
              // Backlog #27: record the continuation for bare `ap reset`, and
              // end with the exact resume command. Note + dead ends kept
              // (post-mortem record, like dead-ends).
              recordLastContinuation(s,{contScope,taskId,missionName:mission,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex)});
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
              die(`Standalone task ${taskId} did not converge after ${cont.used} capped generations (${taskImpl.capped.type} cap ${taskImpl.capped.used}/${taskImpl.capped.limit}). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
            }
            stopOnNoProgress(s,c,{framework:"standalone",contScope,taskId,missionName:mission,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex),touchedFiles:taskImpl.touchedFiles,checkpoint});
            console.log(`Task ${taskId} hit the ${taskImpl.capped.type} cap (${taskImpl.capped.used}/${taskImpl.capped.limit} ${capUnitLabel(taskImpl.capped.type)}); wrap-up note: ${taskImpl.wrapUp?.status||"unknown"}${taskImpl.wrapUp?.reason?` (${taskImpl.wrapUp.reason})`:""}; continuing as session ${cont.used+1} of ${cont.limit+1}.`);
            continue;
          }
          if(taskImpl.status!=="completed"){
            // Interrupted attempt: leave the cursor on this task and let the
            // existing budget/enforcement path below decide retry vs escalate.
            // Mission 047 Phase 1 task 1.2: ended WITHOUT a backstop firing —
            // reset the consecutive-firing count (PLAN).
            clearBackstopFirings(s,`task:standalone:phase-${s.phaseIndex}:${taskId}`);
            break;
          }
          const parsed=parseTaskResultContract(taskImpl.finalMessage??"");
          if(parsed.trailingNote) console.log(`Task ${taskId}: trailing text ignored after a valid result`);
          if(!parsed.ok){
            // 003#43: a missing/malformed task-result sentinel is an adapter output
            // failure, not a verdict — retry the SAME task under adapterRetryBudget,
            // exactly like the reviewer/verifier sentinel (failure-contract.mjs:97).
            // Results that parse but fail commit/validation below still escalate
            // immediately (standalone_task_commit_invalid): those are contract
            // violations, not lost output.
            impl={...taskImpl,status:"failed",
              failure:failure(parsed.code,"adapter",true,[{source:"task-result",message:parsed.reason,taskId}])};
            // Mission 047 Phase 1 task 1.2: malformed-sentinel failure ended
            // WITHOUT a backstop firing — reset the consecutive count (PLAN).
            clearBackstopFirings(s,`task:standalone:phase-${s.phaseIndex}:${taskId}`);
            break;
          }
          if(parsed.taskLocalCheck.status==="attempted"){
            // Backlog: voluntary early stop ("stopped for optimal turn
            // budget"). NEITHER a commit (no durable completion exists —
            // committing would falsely advance the cursor past unfinished
            // work) NOR a failure (nothing broke) NOR a review case
            // (nothing to judge yet): a continuation event on the same
            // allowance as cap breaches. "failed" keeps its existing path
            // (commit → review judges wrongness); only voluntary
            // incompleteness continues. The model's own summary is the
            // dead-end tail here — it states the resume point, unlike a
            // killed run's truncated output. Exhausted allowance escalates
            // as not-converging, so an always-stopping task cannot loop
            // forever.
            const contScope=`task:standalone:phase-${s.phaseIndex}:${taskId}`;
            // Mission 047 Phase 1 task 1.2: voluntary stop ended WITHOUT a
            // backstop firing — reset the consecutive-firing count (PLAN).
            clearBackstopFirings(s,contScope);
            // Backlog #27: a queued `ap reset --scope <continuation>` applies at
            // this decision, before the next generation is consumed.
            maybeApplyPendingContinuationReset(s,contScope);
            const cont=consumeContinuation(s,c.policy,contScope);
            let endedFiles=[];
            try{
              endedFiles=attributedChangedPaths(beforeMap,attributionMap(scopedDeltaChunks(repo,phaseBaselineKey,{mission,declaredPaths})));
            }catch{}
            recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:"incomplete",used:null,limit:null,tail:deadEndTail({summary:parsed.summary,files:endedFiles})});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            if(!cont.allowed){
              // Dead ends are deliberately NOT cleared here: per-task keys
              // cannot leak into another task, and the entries are the
              // post-mortem record of why this task never converged.
              s.phase="escalated";s.step="standalone_task_not_converging";
              s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{taskId,used:cont.used,limit:cont.limit,stopped:"attempted"}};
              // Backlog #27: record the continuation for bare `ap reset`, and
              // end with the exact resume command. Note + dead ends kept
              // (post-mortem record, like dead-ends).
              recordLastContinuation(s,{contScope,taskId,missionName:mission,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex)});
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
              die(`Standalone task ${taskId} did not converge after ${cont.used} generations (last generation stopped voluntarily with work remaining). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
            }
            stopOnNoProgress(s,c,{framework:"standalone",contScope,taskId,missionName:mission,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex),touchedFiles:taskImpl.touchedFiles,checkpoint});
            console.log(`Task ${taskId} stopped voluntarily with work remaining; continuing as session ${cont.used+1} of ${cont.limit+1}.`);
            continue;
          }
          let afterMap;
          try{ afterMap=attributionMap(scopedDeltaChunks(repo,phaseBaselineKey,{mission,declaredPaths})); }
          catch(e){
            s.phase="escalated";s.step="standalone_delta_mismatch";
            s.phaseCheckpointError={code:e?.code||"DELTA_COMPUTATION_FAILED",evidence:{message:e?.message||String(e)}};
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            die(`Standalone task attribution failed after task ${taskIndex+1}: ${e?.message||e}. STOP — human intervention required.`);
          }
          // Files are taken from the TREE, never from the model's reply: an
          // omitted file cannot hide a change from per-task review.
          const attributed=attributedChangedPaths(beforeMap,afterMap);
          // Mission 078 task 1.2: a completed reviewer-feedback fix pass
          // that changed zero files commits normally with a no-work stamp
          // recording the current revision and its summary. Gated on the
          // reviewer-feedback brief classifier plus zero touched files on
          // the relay result and an empty tree attribution. First passes
          // (empty brief), re-verify/carry re-runs, the carry-forward path
          // above, and capped/incomplete/interrupted paths (which never
          // reach this commit) are exempt by construction.
          const noWorkStamp=(isReviewerFeedbackFixPass(taskRetryFindings) && isNoWorkPerformed(taskImpl) && attributed.length===0)
            ? {revision:checkpoint.revision,summary:parsed.summary}
            : null;
          const normalized={role:"implementer",runId:expectedRunId,revision:checkpoint.revision,phaseTaskDigest:phaseTaskDigestValue,taskId,status:"completed",facts:{summary:parsed.summary,files:attributed,taskLocalCheck:parsed.taskLocalCheck,...(parsed.trailingNote?{trailingNote:parsed.trailingNote}:{}),...(noWorkStamp?{noWorkPerformed:noWorkStamp}:{})}};
          const committed=commitTaskResult({progress:checkpoint.roleProgress,expected:prep.expected,result:normalized});
          if(!committed.ok){
            s.phase="escalated";s.step="standalone_task_commit_invalid";
            s.phaseCheckpointError={code:committed.code,reason:committed.reason,evidence:committed.evidence};
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            die(`Standalone Implementer task commit failed: ${committed.reason}. STOP — human intervention required.`);
          }
          checkpoint.roleProgress=committed.progress;
          // Backlog 003#17: task converged — its continuation allowance and
          // dead ends die with it, never leaking into the next task.
          clearTaskContinuation(s,`task:standalone:phase-${s.phaseIndex}:${taskId}`);
          clearRolloverDeadEnds(s,`task:standalone:phase-${s.phaseIndex}:${taskId}`);
          clearBackstopFirings(s,`task:standalone:phase-${s.phaseIndex}:${taskId}`);
          // Backlog #26 Step A: the task converged — its hand-off note dies
          // with it, so a later retry of a DIFFERENT attempt never inherits a
          // stale note. Best-effort; kept on escalation (post-mortem).
          // Backlog #26 Step B: its session store dies with it too (size
          // logged first, warn above 50MB; kept on escalation, like the note).
          logSessionStoreSize(mission,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
          clearSessionStore(mission,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
          clearHandoffNote(mission,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
          clearLastContinuation(s,`task:standalone:phase-${s.phaseIndex}:${taskId}`);
          // Heuristic work-ahead signal: evidence only, never a die().
          const workAhead=detectWorkAhead(attributed,phaseTasks,taskIndex);
          if(workAhead.paths.length){
            checkpoint.roleProgressWorkAhead=[...(checkpoint.roleProgressWorkAhead??[]),{taskId,workAhead:workAhead.tasks}];
          }
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        }
        // TASK-21: `impl` is whatever the last REAL launch set — carried
        // tasks never touch it, so checkpoint.implementer.summary (which the
        // next code-review handoff shows) comes only from the last real
        // launch, not from the carried tasks. That is correct: the reviewer
        // should hear about the fix. `impl === null` here would mean EVERY
        // task was carried, which cannot happen: a FAIL with allMapped:true
        // always names at least one task (an empty or unattributable finding
        // list fails allMapped closed), that task has no carry entry, so at
        // least one task always runs and sets `impl`.
        lastImpl=impl;

        // Reconcile BEFORE any other decision — neutralize premature edits.
        const reconciled=applyTaskCheckboxStates(preAttemptTasks);
        if(!reconciled.ok){
          s.phase="escalated";s.step="task_marking_failed";s.taskMarkingError=reconciled.reason;saveState(s);
          die(`Standalone task checkbox validation failed while neutralizing a premature edit: ${reconciled.reason}. STOP — human intervention required.`);
        }
        // Detect appended task tampering: fresh tasks must be a subset of the
        // pre-attempt snapshot identity set. An Implementer must not add new
        // checkboxes that bypass the cached phaseList and final review.
        const freshAfterImpl=standalone.tasks(repo,mission);
        const preIds=new Set(preAttemptTasks.map(t=>`${t.file}:${t.line}`));
        const appended=freshAfterImpl.filter(t=>!preIds.has(`${t.file}:${t.line}`));
        if(appended.length>0){
          s.phase="escalated";s.step="standalone_appended_task_tampering";saveState(s);
          die(`Appended task tampering detected: ${appended.length} new checkbox(es) not in snapshot. STOP — human intervention required.`);
        }
        delete s.pendingStandaloneCheckboxSnapshot;saveState(s);

        if(impl&&impl.policyViolation){
          s.phase="escalated";s.step="relay_policy_violation";s.relayPolicyViolation=impl.policyViolation;saveState(s);
          die(formatRelayPolicyViolation(s.relayPolicyViolation, impl.touchedFiles));
        }

        if(impl&&impl.status!=="completed"){
          // Infrastructure/adapter interruption: keep nextStage implementer
          // and carry the partial delta forward untouched — never treat it
          // as drift, never rerun planning. The cursor was left on the
          // interrupted task by the loop, so the retry resumes there.
          const recorded=enforceAttemptFailure(c,s,`standalone:phase-${s.phaseIndex}`,[impl],{ok:true});
          checkpoint=applyCheckpointTransition(decideTransition(checkpoint,recorded));
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          continue;
        }

        // Git-invisible phase guard: worktree changed but scoped delta is empty.
        {
          let phaseDeltaEmpty=false;
          try{ phaseDeltaEmpty=scopedDelta(repo,phaseBaselineKey,{mission,declaredPaths}).trim()===""; }catch{ phaseDeltaEmpty=false; }
          if(phaseDeltaEmpty){
            let attemptChanged=false;
            try{ attemptChanged=attemptFsBefore!==null&&JSON.stringify(attemptFsBefore)!==JSON.stringify(listWorktreeEntries(repo)); }catch{ attemptChanged=false; }
            if(attemptChanged){
              const ids=phaseTasks.map(t=>{let rel=t.file;try{rel=path.relative(repo,t.file).replaceAll("\\","/");}catch{} return `${rel}:${t.line}`;}).join("; ");
              s.phase="escalated";s.step="git_invisible_phase";
              s.gitInvisiblePhase={phase:phase.name,tasks:phaseTasks.map(t=>({file:t.file,line:t.line,text:t.text})),at:now()};
              saveState(s);
              die(`Standalone phase '${phase.name}' completed with no Git-observable change although the worktree changed (e.g. an empty directory, which Git cannot represent): GIT_INVISIBLE_PHASE. Phase tasks: ${ids}. STOP — human intervention required.`);
            }
          }
        }

        // Completed, policy-clean implementation: record the approval
        // evidence (bounded summary, run ID, full delta digest) and advance
        // to Code Reviewer.
        let fullDelta;
        try{
          fullDelta=scopedDelta(repo,phaseBaselineKey,{mission,declaredPaths});
        }catch(e){
          s.phase="escalated";s.step="standalone_delta_mismatch";
          s.phaseCheckpointError={code:e?.code||"DELTA_COMPUTATION_FAILED",evidence:{message:e?.message||String(e)}};
          saveState(s);
          die(`Standalone phase delta could not be computed after implementation: ${e?.message||e}. STOP — human intervention required.`);
        }
        {
          const transition=decideTransition(checkpoint,{stage:"implementer",status:"completed",runId:impl?.sessionId??null,summary:sanitizeSummary(impl?.finalMessage??checkpoint.implementer?.summary??""),deltaDigest:deltaDigest(fullDelta)});
          checkpoint=applyCheckpointTransition(transition);
          checkpoint.deltaDigest=transition.deltaDigest;
          checkpoint.implementer={runId:transition.runId,summary:transition.summary};
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        }
        if(stopStage==="implement"){
          // Mission 090 task 1.5: implement covers the Implementer only.
          stopAfterStage("implement");
          return;
        }
        continue;
      }

      // Code Review gates Verification: no gate/Verifier until Code Review PASS.
      if(stage==="code_reviewer"){
        if(checkpoint.attempts.code_reviewer>0){ s.attempt+=1;saveState(s);await maybeRetryPause(c,s,checkpoint,"code_reviewer"); }
        s.step="code_review";checkpoint.runningStage="code_reviewer";s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        // TASK-23: snapshot the tree at the start of EVERY code review, so
        // the next review (if this one FAILs) can diff only the fix's
        // changes. Idempotent — an infra retry or crash-resume of the same
        // review never re-snapshots. Same opts as phaseBaselineKey: a
        // mismatch throws DECLARATION_MISMATCH.
        const reviewKey=`${phaseBaselineKey}-review-r${checkpoint.revision}`;
        ensureBaseline(repo,reviewKey,{mission,declaredPaths});
        // A re-review sees only the findings that caused the fix (already in
        // `feedback`) plus the fix diff: everything that changed since the
        // previous revision's review snapshot. Missing snapshot (older
        // mission, hand-deleted) falls back to today's whole-phase review.
        // Never guess.
        const prevReviewKey=`${phaseBaselineKey}-review-r${checkpoint.revision-1}`;
        const isRereview=checkpoint.revision>1&&hasBaseline(repo,prevReviewKey);
        let reviewHandoff;
        if(isRereview){
          const fixChunks=scopedDeltaChunks(repo,prevReviewKey,{mission,declaredPaths});
          const phaseFiles=scopedDeltaChunks(repo,phaseBaselineKey,{mission,declaredPaths}).map(c=>c.path);
          // Mission 078 task 1.3: an all-zero-file reviewer-feedback round
          // returns to the reviewer with the implementer's answer/rebuttal
          // threaded in. The section appears only when the round changed
          // zero files (empty fixChunks) and ran >=1 reviewer-feedback fix
          // pass stamped in the current revision — the stamp records its
          // revision, so carried tasks' stale stamps are ignored here.
          // No approval shortcut and no gates() call on this path: gates
          // still run only after Code Review PASS via the delta-digest
          // cache below.
          let noWorkAnswerSection="";
          try{
            const factsByTask=checkpoint.roleProgress?.implementer?.factsByTask;
            const stamped=(factsByTask&&typeof factsByTask==="object"&&!Array.isArray(factsByTask))
              ? Object.values(factsByTask).filter((f)=>f&&typeof f==="object"&&f.noWorkPerformed&&typeof f.noWorkPerformed==="object"&&f.noWorkPerformed.revision===checkpoint.revision)
              : [];
            if(fixChunks.length===0&&stamped.length>0){
              noWorkAnswerSection=buildNoWorkAnswerSection(stamped.map((f)=>(f.noWorkPerformed&&typeof f.noWorkPerformed.summary==="string")?f.noWorkPerformed.summary:(typeof f.summary==="string"?f.summary:"")));
            }
          }catch{ noWorkAnswerSection=""; }
          reviewHandoff=buildStandaloneHandoff({kind:"PHASE_REREVIEW",
            phaseName:phase.name,phaseIndex:s.phaseIndex,phaseTotal:phaseList.length,
            phaseTasks,attempt:s.attempt,
            deltaChunks:fixChunks,changedFiles:phaseFiles,
            baselineKey:reviewKey,declaredPaths,
            repoRoot:repo,
            gateHistory:s?.gateDurations,
            linkedVerifyCommands:linkedVerifyCommandsForPhase(phaseTasks,c?.gates?.commands),
            implementationSummary:`${checkpoint.implementer?.summary??""}${noWorkAnswerSection}`,
            operatorPhaseEdits:s.operatorPhaseEdits});
        }else{
          reviewHandoff=buildStandaloneHandoff({kind:"PHASE_REVIEW",
            phaseName:phase.name,phaseIndex:s.phaseIndex,phaseTotal:phaseList.length,
            phaseTasks,attempt:s.attempt,
            deltaChunks:scopedDeltaChunks(repo,phaseBaselineKey,{mission,declaredPaths}),
            baselineKey:phaseBaselineKey,declaredPaths,
            repoRoot:repo,
            gateHistory:s?.gateDurations,
            linkedVerifyCommands:linkedVerifyCommandsForPhase(phaseTasks,c?.gates?.commands),
            implementationSummary:checkpoint.implementer?.summary??"",
            operatorPhaseEdits:s.operatorPhaseEdits});
        }
        // Mission 063 task 1.4: recorded operator phase edits (`ap rebase`)
        // ride the reviewer brief once, then clear so a later review does
        // not repeat them. Cleared only when the brief included them.
        if(formatOperatorPhaseEdits(s.operatorPhaseEdits)){ delete s.operatorPhaseEdits; saveState(s); }
        if(reviewHandoff.meta.truncated) console.warn(truncationWarning(reviewHandoff.meta));
        const reviewIds=stableTaskIds({framework:"standalone",mission,phaseIndex:s.phaseIndex,phaseNumber:s.phaseIndex+1,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo});
        // TASK-26: the reviewer gets a measured kill deadline and is told it.
        const reviewBudget=roleDeadline(c,s,"code_reviewer");
        const reviewRef=reviewTaskRef(s,phaseKey,phaseTasks,reviewIds,checkpoint.revision,isRereview);
        const reviewDeadEnds=readRolloverDeadEnds(s, `task:standalone:phase-${s.phaseIndex}:code_reviewer`);
        const reviewHandoffNote=readHandoffNote(mission, reviewRef);
        const reviewDeadEndsText=reviewDeadEnds.length?`Prior dead ends (continuation context — do not retry blindly):\n${reviewDeadEnds.map((d)=>`- Generation ${d.generation} (${d.reason} ${d.used}/${d.limit}): ${d.tail}`).join("\n")}`:"";
        const reviewHandoffNoteText=reviewHandoffNote?`Prior reviewer handoff note (continuation context — continue from where it stopped):\n${reviewHandoffNote}`:"";
        const operatorNote=operatorPhaseNoteLine(s);
        const tasksFilePathForReview=standalone.tasksPath(repo,mission);
        const tasksTextForReview=fs.existsSync(tasksFilePathForReview)?fs.readFileSync(tasksFilePathForReview,"utf8"):"";
        const scratchNote=unexpectedNewFilesReviewNote(tasksTextForReview);
        const rv=await review("code_reviewer",`${reviewHandoff.text}\n\n${scratchNote?`${scratchNote}\n\n`:""}${reviewDeadEndsText}\n\n${reviewHandoffNoteText}\n\n${operatorNote?`${operatorNote}\n\n`:""}${reviewBudget.note}\n${readOnlyHandoffNoteReminder({mission, ref: reviewRef, noteLimit: resolveHandoffNoteMaxChars(c.policy)})}`,
          c,s,feedback,phaseRequirements,reviewRef,reviewBudget.timeoutMs,true,codeReviewScopeKey("standalone-phase",s.phaseIndex),
          reviewTruncationResult(reviewHandoff.meta));
        noteRoleDeadlineOutcome(s,"code_reviewer",rv,reviewBudget.derived);
        lastReview=rv;
        if(rv.policyViolation){
          s.phase="escalated";s.step="relay_policy_violation";s.relayPolicyViolation=rv.policyViolation;saveState(s);
          die(formatRelayPolicyViolation(s.relayPolicyViolation, rv.touchedFiles));
        }
        if(rv.capped){
          // Mission 031 Phase 4 task 4.1: a standalone code_reviewer cap
          // breach is a continuation event, never a failure — failure
          // budgets are untouched on this path. Consume one continuation
          // generation on the per-phase code_reviewer scope and record the
          // dead end; `continue` retries the review stage against the same
          // unchanged phase diff. Exhausted allowance escalates as
          // not-converging. Read-only role: no file attribution — the
          // summary states the resume point, files stay empty.
          const contScope=`task:standalone:phase-${s.phaseIndex}:code_reviewer`;
          // Backlog #59 part (a): cumulative raw-token backstop rollover for
          // the code_reviewer, BEFORE the cap path below — a continuation
          // event on the SEPARATE backstop firing ledger, never the
          // continuation allowance (a backstop firing must not consume
          // extra_sessions, and must not end as not-converging).
          if(rv.capped.backstop===true||rv.capped.type==="backstop"){
            const backstop=handleRoleBackstopFiring(s,contScope,rv);
            if(backstop.escalate){
              const last=backstop.last;
              s.phase="escalated";s.step="runaway_session_escalation";
              s.phaseCheckpointError={code:"BACKSTOP_CONSECUTIVE_FIRINGS",evidence:{role:"code_reviewer",totalRawTokens:last.totalRawTokens??rv.capped.used,turns:last.turns??null,maxSingleTurnContext:last.maxSingleTurnContext??null,firings:[...backstop.firings]}};
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
              die(`Standalone code reviewer fired the cumulative backstop twice in a row (${last.totalRawTokens??rv.capped.used}/${rv.capped.limit} cumulative raw tokens, ${last.turns??"?"} turns, largest single-turn context ${last.maxSingleTurnContext??"?"}). STOP — human intervention required.`);
            }
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            console.log(`Code reviewer crossed the cumulative backstop (${rv.capped.used}/${rv.capped.limit} cumulative raw tokens); continuing as backstop session ${backstop.firings.length+1}.`);
            continue;
          }
          // This generation ended WITHOUT a backstop firing, so the
          // consecutive-firing count resets (PLAN: two CONSECUTIVE firings
          // escalate — an interleaving ordinary generation breaks the streak).
          clearBackstopFirings(s,contScope);
          // Backlog #27: a queued `ap reset --scope <continuation>` applies at
          // this decision, before the next generation is consumed.
          maybeApplyPendingContinuationReset(s,contScope);
          const cont=consumeContinuation(s,c.policy,contScope,resolvePerRoleLimits('code_reviewer',c.policy).continuationAllowance);
          recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:rv.capped.type,used:rv.capped.used,limit:rv.capped.limit,tail:deadEndTail({summary:`Code review capped (${rv.capped.type} ${rv.capped.used}/${rv.capped.limit}); phase diff unchanged — re-review the same phase diff.`,files:[]})});
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          if(!cont.allowed){
            // Dead ends are deliberately NOT cleared here: per-phase keys
            // cannot leak into another phase, and the entries are the
            // post-mortem record of why this phase never converged.
            s.phase="escalated";s.step="standalone_task_not_converging";
            s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{role:"code_reviewer",used:cont.used,limit:cont.limit,breach:rv.capped.type}};
            // Backlog #27: record the continuation for bare `ap reset`, and
            // end with the exact resume command.
            recordLastContinuation(s,{contScope,taskId:null,missionName:mission,taskRef:reviewRef});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            die(`Standalone code review did not converge after ${cont.used} capped generations (${rv.capped.type} cap ${rv.capped.used}/${rv.capped.limit}). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
          }
          console.log(`Code review hit the ${rv.capped.type} cap (${rv.capped.used}/${rv.capped.limit} ${capUnitLabel(rv.capped.type)}); continuing as session ${cont.used+1} of ${cont.limit+1}.`);
          continue;
        }
        // Backlog #59 part (a): the code_reviewer run ended WITHOUT a
        // backstop firing (normal completion, or the voluntary incomplete
        // stop below) — reset the consecutive-firing count.
        clearBackstopFirings(s,`task:standalone:phase-${s.phaseIndex}:code_reviewer`);
        if(parseIncompleteSignal(rv.review ?? rv)){
          // Mission 031 Phase 4 task 4.3: voluntary early stop (INCOMPLETE
          // decision or non-empty Next section) is a continuation event,
          // never a failure — INCOMPLETE skips FAIL/failure-budget handling
          // and routes here. Consume one continuation generation on the
          // per-phase code_reviewer scope and record the dead end with
          // reason "incomplete"; `continue` retries the review stage.
          // Exhausted allowance escalates as not-converging. Read-only
          // role: no file attribution — files stay empty.
          const contScope=`task:standalone:phase-${s.phaseIndex}:code_reviewer`;
          maybeApplyPendingContinuationReset(s,contScope);
          const cont=consumeContinuation(s,c.policy,contScope,resolvePerRoleLimits('code_reviewer',c.policy).continuationAllowance);
          recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:"incomplete",used:null,limit:null,tail:deadEndTail({summary:`Code review incomplete (${rv.review?.decision ?? "INCOMPLETE"}); phase diff unchanged — re-review the same phase diff.`,files:[]})});
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          if(!cont.allowed){
            s.phase="escalated";s.step="standalone_task_not_converging";
            s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{role:"code_reviewer",used:cont.used,limit:cont.limit,stopped:"incomplete"}};
            recordLastContinuation(s,{contScope,taskId:null,missionName:mission,taskRef:reviewRef});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            die(`Standalone code review did not converge after ${cont.used} generations (last generation stopped voluntarily as incomplete). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
          }
          console.log(`Code review stopped voluntarily as incomplete; continuing as session ${cont.used+1} of ${cont.limit+1}.`);
          continue;
        }
        if(rv.status==="completed"&&rv.review?.decision==="PASS"){
          // Mission 025 task 2.1: never accept a standalone reviewer PASS
          // while any linked verify/tool result exited non-zero or 124. The
          // reviewer's own observed tool calls are the evidence channel here
          // (phase gates run later, at the verifier stage): a failed or
          // timed-out tool result routes to feedback/retry, never to PASS.
          // Only commands matching a linked task verify or gate command
          // count — inspection commands (grep/test/git diff) never refuse.
          const toolRefusal=shouldRefusePassForEvidence({gateResults:[],toolResults:reviewerLinkedToolResults(rv,linkedVerifyCommandsForPhase(phaseTasks,c?.gates?.commands))});
          if(toolRefusal?.refuse===true){
            const toolReason=toolRefusal.reason==="timed-out"?"timed out":"failed";
            const toolCommand=toolRefusal.command?` \`${String(toolRefusal.command).slice(0,200)}\``:"";
            const toolExit=toolRefusal.exitCode ?? toolRefusal.status ?? "unknown";
            const refusalFindings=[`Reviewer PASS refused: linked verify/tool result${toolCommand} ${toolReason} (exit ${toolExit}). Re-verify the work after addressing the failure instead of passing.`];
            feedback=feedbackText(saveReviewFeedback(s,phaseKey,refusalFindings))||"Implementation/code review failed.";
            recordPhaseFindingTasks(phaseKey,refusalFindings,true);recordCodeReviewRound(s,codeReviewScopeKey("standalone-phase",s.phaseIndex),refusalFindings,rv.review?.previous);
            {
              const recorded=enforceAttemptFailure(c,s,`standalone:phase-${s.phaseIndex}`,lastImpl?[lastImpl,{...rv,failure:failure("IMPLEMENTATION_REJECTED","implementation",true,refusalFindings)}]:[{...rv,failure:failure("IMPLEMENTATION_REJECTED","implementation",true,refusalFindings)}],{ok:true});
              checkpoint=applyCheckpointTransition(decideTransition(checkpoint,recorded));
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            }
            continue;
          }
          clearCodeReviewHistory(s,codeReviewScopeKey("standalone-phase",s.phaseIndex));const transition=decideTransition(checkpoint,{stage:"code_reviewer",status:"completed",decision:"PASS",runId:rv.sessionId??null,findings:rv.review?.findings??[]});
          checkpoint=applyCheckpointTransition(transition);
          checkpoint.codeReviewer={runId:rv.sessionId??null,decision:"PASS",findings:rv.review?.findings??[]};
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          if(stopStage==="review"){
            // Mission 090 task 1.5: review covers the Code Reviewer only.
            stopAfterStage("review");
            return;
          }
          continue;
        }
        if(rv.status==="completed"){
          // Functional FAIL: the findings feed the Implementer retry, and
          // the stored approval is invalidated via the transition.
          feedback=feedbackText(saveReviewFeedback(s,phaseKey,rv.review?.findings||[]))||"Implementation/code review failed.";
          // TASK-20 step 1: record the finding→task map before the transition
          // below wipes roleProgress. The wipe itself is unchanged; TASK-21
          // step 2 replays the unflagged tasks' facts on the retry instead.
          recordPhaseFindingTasks(phaseKey,rawReviewFindings(rv),true);recordCodeReviewRound(s,codeReviewScopeKey("standalone-phase",s.phaseIndex),rv.review?.findings||[],rv.review?.previous);noteEscalationTrigger(s,c,"implementer",codeReviewScopeKey("standalone-phase",s.phaseIndex),"code_reviewer",rv.review?.previous);
        }
        // Infrastructure interruption or functional rejection: the split is
        // read off enforceAttemptFailure()'s return value — retry only the
        // Reviewer on infra, return to the Implementer on rejection.
        {
          const recorded=enforceAttemptFailure(c,s,`standalone:phase-${s.phaseIndex}`,lastImpl?[lastImpl,rv]:[rv],{ok:true});
          checkpoint=applyCheckpointTransition(decideTransition(checkpoint,recorded));
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        }
        continue;
      }

      // Only after Code Review PASS: run configured gates and the Verifier.
      if(stage==="verifier"){
        if(checkpoint.attempts.verifier>0){ s.attempt+=1;saveState(s);await maybeRetryPause(c,s,checkpoint,"verifier"); }
        s.step="verify";checkpoint.runningStage="verifier";s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        let g;
        let preGateCacheKey=null;
        try{
          preGateCacheKey=deltaDigest(scopedDelta(repo,phaseBaselineKey,{mission,declaredPaths}))+"|"+deltaDigest(JSON.stringify(c.gates.commands||[]));
        }catch(e){
          s.phase="escalated";s.step="standalone_delta_mismatch";
          s.phaseCheckpointError={code:e?.code||"DELTA_COMPUTATION_FAILED",evidence:{message:e?.message||String(e)}};
          saveState(s);
          die(`Standalone phase delta could not be computed before gates: ${e?.message||e}. STOP — human intervention required.`);
        }
        {
          const stashedGate=preGateCacheKey?takeContinuationGateResult(checkpoint,preGateCacheKey):null;
          // Backlog #105: the last recorded gate result (pass OR fail) is reused
          // whenever the digest key is unchanged — verifier infra retry, resume.
          const lastGate=preGateCacheKey?getLastGateResult(checkpoint,lastGateKeyOf(preGateCacheKey,c)):null;
          if(stashedGate){g=stashedGate;}else{
          const cached=preGateCacheKey?getCachedGateResult(checkpoint,preGateCacheKey):null;
          if(lastGate){
            g=lastGate;
            console.log("gate result reused (digest unchanged)");noteGateReused(s,g);
          }else if(cached&&cached.ok===true){
            g=cached;
            console.log("gate result reused (digest unchanged)");noteGateReused(s,g);
          }else{
            g=await gates(c,s);
            if(g.ok===true){
              setCachedGateResult(checkpoint,preGateCacheKey,g);
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            }
          }
          }
        }
        // Gates run before the Verifier and may write files (coverage
        // reports, markers): re-record the full delta AFTER gates pass so
        // the Verifier reviews — and the checkpoint records — the same tree
        // the approval will later be consumed against. Without this refresh
        // the mark_tasks gate would compare a pre-gate record against a
        // post-gate tree and drift-escalate on every file-writing gate. A
        // crash mid-gate still fails closed at the next gate check (partial
        // gate outputs are unapproved changes). This is evidence refresh,
        // not a transition: stage, revision, and attempts are untouched.
        try{
          checkpoint.deltaDigest=deltaDigest(scopedDelta(repo,phaseBaselineKey,{mission,declaredPaths}));
          if(g.ok===true){
            setCachedGateResult(checkpoint,checkpoint.deltaDigest+"|"+deltaDigest(JSON.stringify(c.gates.commands||[])),g);
          }
          recordLastGateResult(checkpoint,lastGateKeyOf(checkpoint.deltaDigest+"|"+deltaDigest(JSON.stringify(c.gates.commands||[])),c),g);
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        }catch(e){
          s.phase="escalated";s.step="standalone_delta_mismatch";
          s.phaseCheckpointError={code:e?.code||"DELTA_COMPUTATION_FAILED",evidence:{message:e?.message||String(e)}};
          saveState(s);
          die(`Standalone phase delta could not be recomputed after gates: ${e?.message||e}. STOP — human intervention required.`);
        }
        const verifyHandoff=buildStandaloneHandoff({kind:"PHASE_VERIFY",
          phaseName:phase.name,phaseIndex:s.phaseIndex,phaseTotal:phaseList.length,
          phaseTasks,attempt:s.attempt,
          deltaChunks:scopedDeltaChunks(repo,phaseBaselineKey,{mission,declaredPaths}),
          baselineKey:phaseBaselineKey,declaredPaths,
          implementationSummary:checkpoint.implementer?.summary??"",
          gateResult:g,gateHistory:s?.gateDurations,
          linkedVerifyCommands:linkedVerifyCommandsForPhase(phaseTasks,c?.gates?.commands)});
        if(verifyHandoff.meta.truncated) console.warn(truncationWarning(verifyHandoff.meta));
        // TASK-26: the verifier gets a measured kill deadline and is told it.
        const verifyBudget=roleDeadline(c,s,"verifier");
        const verifyRef=allPhaseTaskRef(phaseTasks);
        const verifyDeadEnds=readRolloverDeadEnds(s, `task:standalone:phase-${s.phaseIndex}:verifier`);
        const verifyHandoffNote=readHandoffNote(mission, verifyRef);
        const verifyDeadEndsText=verifyDeadEnds.length?`Prior dead ends (continuation context — do not retry blindly):\n${verifyDeadEnds.map((d)=>`- Generation ${d.generation} (${d.reason} ${d.used}/${d.limit}): ${d.tail}`).join("\n")}`:"";
        const verifyHandoffNoteText=verifyHandoffNote?`Prior verifier handoff note (continuation context — continue from where it stopped):\n${verifyHandoffNote}`:"";
        const vv=await relayAsync("verifier",`${verifyHandoff.text}\n\n${verifyDeadEndsText}\n\n${verifyHandoffNoteText}\n\n${verifyBudget.note}\n${verifierRoundLines(s,codeReviewScopeKey("standalone-phase",s.phaseIndex)).join("\n")}\n${readOnlyHandoffNoteReminder({mission, ref: verifyRef, noteLimit: resolveHandoffNoteMaxChars(c.policy)})}`,
          c,s,{readOnly:true,review:true,requirements:phaseRequirements,taskRef:verifyRef,timeoutMs:verifyBudget.timeoutMs,capEnabled:true});
        noteRoleDeadlineOutcome(s,"verifier",vv,verifyBudget.derived);
        {
          // Backlog #91: a red phase gate forces the recorded verdict to FAIL.
          const ov=applyRedGateOverride(vv.review,g,phaseTasks);
          if(ov.review!==vv.review){
            vv.review=ov.review;
            if(ov.overridden){
              persistRedGateOverride(runsDirFor(s),vv.run_id,ov.review);
              vv.verdictOverride="red_gate";
              console.log("Verifier verdict overridden PASS -> FAIL: phase gate is red (verdictOverride=red_gate).");
            }
          }
        }
        if(vv.policyViolation){
          s.phase="escalated";s.step="relay_policy_violation";s.relayPolicyViolation=vv.policyViolation;saveState(s);
          die(formatRelayPolicyViolation(s.relayPolicyViolation, vv.touchedFiles));
        }
        if(vv.capped){
          // Mission 031 Phase 4 task 4.2: a standalone verifier cap
          // breach is a continuation event, never a failure — failure
          // budgets are untouched on this path. Consume one continuation
          // generation on the per-phase verifier scope and record the
          // dead end; `continue` retries the verifier stage against the
          // same unchanged phase diff. Exhausted allowance escalates as
          // not-converging. Read-only role: no file attribution — the
          // summary states the resume point, files stay empty.
          const contScope=`task:standalone:phase-${s.phaseIndex}:verifier`;
          // Backlog #59 part (a): cumulative raw-token backstop rollover for
          // the verifier, BEFORE the cap path below — a continuation event
          // on the SEPARATE backstop firing ledger, never the continuation
          // allowance.
          if(vv.capped.backstop===true||vv.capped.type==="backstop"){
            const backstop=handleRoleBackstopFiring(s,contScope,vv);
            if(backstop.escalate){
              const last=backstop.last;
              s.phase="escalated";s.step="runaway_session_escalation";
              s.phaseCheckpointError={code:"BACKSTOP_CONSECUTIVE_FIRINGS",evidence:{role:"verifier",totalRawTokens:last.totalRawTokens??vv.capped.used,turns:last.turns??null,maxSingleTurnContext:last.maxSingleTurnContext??null,firings:[...backstop.firings]}};
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
              die(`Standalone verifier fired the cumulative backstop twice in a row (${last.totalRawTokens??vv.capped.used}/${vv.capped.limit} cumulative raw tokens, ${last.turns??"?"} turns, largest single-turn context ${last.maxSingleTurnContext??"?"}). STOP — human intervention required.`);
            }
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            recordContinuationGateResult(checkpoint,preGateCacheKey,g);
            console.log(`Verifier crossed the cumulative backstop (${vv.capped.used}/${vv.capped.limit} cumulative raw tokens); continuing as backstop session ${backstop.firings.length+1}.`);
            continue;
          }
          // This generation ended WITHOUT a backstop firing, so the
          // consecutive-firing count resets (PLAN).
          clearBackstopFirings(s,contScope);
          // Backlog #27: a queued `ap reset --scope <continuation>` applies at
          // this decision, before the next generation is consumed.
          maybeApplyPendingContinuationReset(s,contScope);
          const cont=consumeContinuation(s,c.policy,contScope,resolvePerRoleLimits('verifier',c.policy).continuationAllowance);
          recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:vv.capped.type,used:vv.capped.used,limit:vv.capped.limit,tail:deadEndTail({summary:`Verification capped (${vv.capped.type} ${vv.capped.used}/${vv.capped.limit}); phase diff unchanged — re-verify the same phase diff.`,files:[]})});
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          if(!cont.allowed){
            // Dead ends are deliberately NOT cleared here: per-phase keys
            // cannot leak into another phase, and the entries are the
            // post-mortem record of why this phase never converged.
            s.phase="escalated";s.step="standalone_task_not_converging";
            s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{role:"verifier",used:cont.used,limit:cont.limit,breach:vv.capped.type}};
            // Backlog #27: record the continuation for bare `ap reset`, and
            // end with the exact resume command.
            recordLastContinuation(s,{contScope,taskId:null,missionName:mission,taskRef:verifyRef});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            die(`Standalone verification did not converge after ${cont.used} capped generations (${vv.capped.type} cap ${vv.capped.used}/${vv.capped.limit}). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
          }
          recordContinuationGateResult(checkpoint,preGateCacheKey,g);
          console.log(`Verification hit the ${vv.capped.type} cap (${vv.capped.used}/${vv.capped.limit} ${capUnitLabel(vv.capped.type)}); continuing as session ${cont.used+1} of ${cont.limit+1}.`);
          continue;
        }
        // Backlog #59 part (a): the verifier run ended WITHOUT a backstop
        // firing (normal completion, or the voluntary incomplete stop
        // below) — reset the consecutive-firing count.
        clearBackstopFirings(s,`task:standalone:phase-${s.phaseIndex}:verifier`);
        if(parseIncompleteSignal(vv.review ?? vv)){
          // Mission 031 Phase 4 task 4.3: voluntary early stop (INCOMPLETE
          // decision or non-empty Next section) is a continuation event,
          // never a failure — INCOMPLETE skips FAIL/failure-budget handling
          // and routes here. Consume one continuation generation on the
          // per-phase verifier scope and record the dead end with reason
          // "incomplete"; `continue` retries the verifier stage. Exhausted
          // allowance escalates as not-converging. Read-only role: no file
          // attribution — files stay empty.
          const contScope=`task:standalone:phase-${s.phaseIndex}:verifier`;
          maybeApplyPendingContinuationReset(s,contScope);
          const cont=consumeContinuation(s,c.policy,contScope,resolvePerRoleLimits('verifier',c.policy).continuationAllowance);
          recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:"incomplete",used:null,limit:null,tail:deadEndTail({summary:`Verification incomplete (${vv.review?.decision ?? "INCOMPLETE"}); phase diff unchanged — re-verify the same phase diff.`,files:[]})});
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          if(!cont.allowed){
            s.phase="escalated";s.step="standalone_task_not_converging";
            s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{role:"verifier",used:cont.used,limit:cont.limit,stopped:"incomplete"}};
            recordLastContinuation(s,{contScope,taskId:null,missionName:mission,taskRef:verifyRef});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            die(`Standalone verification did not converge after ${cont.used} generations (last generation stopped voluntarily as incomplete). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
          }
          recordContinuationGateResult(checkpoint,preGateCacheKey,g);
          console.log(`Verification stopped voluntarily as incomplete; continuing as session ${cont.used+1} of ${cont.limit+1}.`);
          continue;
        }
        if(g.ok&&vv.status==="completed"&&vv.review?.decision==="PASS"){
          // Mission 025 task 2.2: never accept a standalone verifier PASS
          // while any linked verify/tool result exited non-zero or 124. The
          // joint gate+verdict check covers both evidence channels: the
          // phase-gate results (g.results) and the verifier's own observed
          // tool calls. A failed or timed-out linked result routes to
          // feedback/retry, never to PASS. Only commands matching a linked
          // task verify or gate command count — the verifier's inspection
          // commands (grep/test/git diff) never refuse PASS.
          const verifierRefusal=shouldRefusePassForEvidence({gateResults:Array.isArray(g.results)?g.results:[],toolResults:reviewerLinkedToolResults(vv,linkedVerifyCommandsForPhase(phaseTasks,c?.gates?.commands))});
          if(verifierRefusal?.refuse===true){
            const verifierReason=verifierRefusal.reason==="timed-out"?"timed out":"failed";
            const verifierCommand=verifierRefusal.command?` \`${String(verifierRefusal.command).slice(0,200)}\``:"";
            const verifierExit=verifierRefusal.exitCode ?? verifierRefusal.status ?? "unknown";
            const refusalFindings=[`Verifier PASS refused: linked verify/tool result${verifierCommand} ${verifierReason} (exit ${verifierExit}). Re-verify the work after addressing the failure instead of passing.`];
            feedback=feedbackText(saveReviewFeedback(s,phaseKey,refusalFindings))||"Verification failed.";
            recordPhaseFindingTasks(phaseKey,refusalFindings,true);
            {
              const recorded=enforceAttemptFailure(c,s,`standalone:phase-${s.phaseIndex}`,lastImpl&&lastReview?[lastImpl,lastReview,{...vv,failure:failure("VERIFICATION_REJECTED","verification",true,refusalFindings)}]:(lastReview?[lastReview,{...vv,failure:failure("VERIFICATION_REJECTED","verification",true,refusalFindings)}]:[{...vv,failure:failure("VERIFICATION_REJECTED","verification",true,refusalFindings)}]),g);
              checkpoint=applyCheckpointTransition(decideTransition(checkpoint,recorded));
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            }
            continue;
          }
          const transition=decideTransition(checkpoint,{stage:"verifier",status:"completed",decision:"PASS",runId:vv.sessionId??null,findings:vv.review?.findings??[]});
          checkpoint=applyCheckpointTransition(transition);
          checkpoint.verifier={runId:vv.sessionId??null,decision:"PASS",findings:vv.review?.findings??[]};
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          continue;
        }
        feedback=feedbackText(saveReviewFeedback(s,phaseKey,vv.review?.findings||[]))||(g.ok?"Verification failed.":`Verification gate failed: ${g.command||"unknown"}`);
        // TASK-20 step 1: same record as the review FAIL site. A gate failure
        // with no findings at all lands here as `entries:[]` +
        // `allMapped:false` — "redo everything", today's safe behaviour.
        // TASK-21 step 2 (c-gap 2): `carryAllowed` is true here too. A red
        // gate command only says the phase is not done; the findings that
        // arrive with it are what name the tasks, so the unaffected ones are
        // carried exactly like a code-review FAIL. A gate failure with NO
        // findings still fails `allMapped` (an empty entry list carries no
        // locality) and records an empty carry, so the retry re-runs
        // everything — that fail-closed rule lives in the record, not in
        // this argument.
        // Mission 073 Phase 1 task 1.3: escalate once when a RED gate's
        // failing files are all outside the phase delta instead of
        // dispatching an implementer fix round. Parse the full g.logFile
        // (fallback: concatenated results logFiles plus tails) and union
        // the phase delta paths with the phase tasks' linked test files
        // (phaseTasks only — gate commands never count as inside). Mixed,
        // inside, task-linked, truncated, and empty cases fall through to
        // the normal fix round below. No checkpoint state is touched here.
        if(g&&g.ok===false){
          let gateLogText="";
          try{
            if(g&&typeof g.logFile==="string"&&g.logFile) gateLogText+=`\n${fs.readFileSync(g.logFile,"utf8")}`;
          }catch{}
          if(!gateLogText.trim()){
            try{
              for(const r of (Array.isArray(g.results)?g.results:[])){
                if(r&&typeof r.logFile==="string"&&r.logFile){
                  try{ gateLogText+=`\n${fs.readFileSync(r.logFile,"utf8")}`; }catch{}
                }
                if(r&&typeof r.tail==="string"&&r.tail) gateLogText+=`\n${r.tail}`;
              }
            }catch{}
          }
          if(!gateLogText.trim()&&typeof g.tail==="string"&&g.tail) gateLogText=g.tail;
          const parsed=parseGateFailures(gateLogText);
          let phaseDeltaFiles=[];
          try{
            phaseDeltaFiles=scopedDeltaChunks(repo,phaseBaselineKey,{mission,declaredPaths}).map(c=>c.path);
          }catch{}
          // Import locality compares against files the phase actually changed;
          // task-linked test files are unioned below for the existing name and
          // source-text match only.
          const phaseDeltaChangedFiles=[...phaseDeltaFiles];
          phaseDeltaFiles=[...phaseDeltaFiles,...taskLinkedTestFiles(phaseTasks)];
          // Gate locality (backlog #89): static text scan only. A failing test
          // that reads/greps a delta file as source text, or whose failure
          // output names one, is phase-related (implementer fix round).
          const gateTestSources={};
          for(const f of parsed.failures){
            try{ gateTestSources[f.file]=fs.readFileSync(path.resolve(repo,f.file),"utf8"); }catch{}
          }
          const locality=classifyGateFailures({failingFiles:parsed.failures.map(f=>f.file),phaseDeltaFiles,truncated:parsed.truncated,testSources:gateTestSources,failureText:gateLogText});
          // Import locality (#20): a failing test that imports a phase-changed
          // file — directly or through one local module — is phase-related even
          // when the test file itself is outside the delta. Read only the
          // failing files, bounded to two import levels.
          let importLocality=null;
          if(locality.allOutsideDelta){
            for(const f of parsed.failures){
              const found=importsDeltaFile({
                testPath:f.file,
                deltaPaths:phaseDeltaChangedFiles,
                maxDepth:2,
                readFile:(filePath)=>{
                  try{ return fs.readFileSync(path.resolve(repo,filePath),"utf8"); }catch{ return null; }
                },
              });
              if(found.inside){ importLocality={test:f.file,via:found.via}; break; }
            }
            if(importLocality) console.log(`gate locality: ${importLocality.test} imports ${importLocality.via} → fix round`);
          }
          if(locality.allOutsideDelta&&!importLocality){
            // Backlog #215: the static/import scans are only a fast path. A
            // test can reach phase-changed code by spawning bin/ap.cjs or
            // setup (or importing deeper than maxDepth), so re-run every
            // failing file once on a clean copy of the phase baseline. A pass
            // there proves the failure is this phase's regression -> normal
            // fix round. Escalate ONLY when they fail on the baseline too;
            // any error (missing baseline, git/tar/spawn failure) is
            // fail-open to fixing.
            let baselineCheck=null;
            try{
              baselineCheck=await checkGateBaseline({
                repo,
                baselineKey:phaseBaselineKey,
                failures:parsed.failures,
              });
            }catch(error){
              baselineCheck={outcome:"error",error:String(error?.message??error)};
            }
            if(baselineCheck?.outcome==="pass"){
              console.log(`gate locality: ${baselineCheck.passingFile} passes on the baseline → fix round`);
            }else if(baselineCheck?.outcome==="all-fail"){
              s.phase="escalated";s.step="standalone_gate_unrelated_failures";saveState(s);
              die(formatGateFailureEscalation({failures:parsed.failures,phaseName:phase.name,mission}));
            }else{
              console.log(`gate locality: baseline re-run could not prove the failures are outside the delta (${baselineCheck?.error||"unknown error"}) → fix round`);
            }
          }
        }
        recordPhaseFindingTasks(phaseKey,rawReviewFindings(vv),true);recordVerifierRound(s,codeReviewScopeKey("standalone-phase",s.phaseIndex),vv.review?.findings||[],vv.review?.previous);noteEscalationTrigger(s,c,"implementer",codeReviewScopeKey("standalone-phase",s.phaseIndex),"verifier",vv.review?.previous);
        // Gate failure and functional Verification FAIL share this path:
        // back to Implementer, then Reviewer, then Verifier. An
        // infrastructure failure retries only the Verifier.
        {
          const recorded=enforceAttemptFailure(c,s,`standalone:phase-${s.phaseIndex}`,lastImpl&&lastReview?[lastImpl,lastReview,vv]:(lastReview?[lastReview,vv]:[vv]),g);
          checkpoint=applyCheckpointTransition(decideTransition(checkpoint,recorded));
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        }
        continue;
      }

      if(stage==="mark_tasks"){
        // No-model crash-recovery stage consuming the stored Verifier PASS
        // (the loop-top gate already matched task+delta digests against it):
        // mark via the existing path, set in-memory done, advance the phase
        // index through the loop, then clear the checkpoint and feedback.
        s.step="mark_tasks";saveState(s);
        const marked=setTaskCheckboxes(phaseTasks,true);
        // Mission 084 Phase 2 task 2.4 — orchestrator tracked write
        // invalidates the snapshot reuse cache (scenario b).
        try{
          clearSnapshotReuseCache("mark_tasks tracked write");
          console.log(`[snapshot-reuse] cache cleared: mark_tasks tracked write`);
        }catch(error){
          console.log(`[snapshot-reuse] cache clear skipped (${error?.message||error})`);
        }
        if(!marked.ok){
          s.phase="escalated";s.step="task_marking_failed";s.taskMarkingError=marked.reason;saveState(s);
          die(`Standalone task checkbox marking failed after verification PASS: ${marked.reason}. STOP — human intervention required.`);
        }
        for(const t of phaseTasks) t.done=true;
        passed=true;
        s.lastReview={decision:checkpoint.codeReviewer?.decision??"PASS",findings:checkpoint.codeReviewer?.findings??[]};
        s.feedback="";clearRoleSession(s,"implementer");
        // TASK-20: the finding→task record is cleared with the findings it
        // describes — a PASS must never leave a FAIL's map readable.
        clearReviewFeedback(s,phaseKey);
        clearFindingTasks(s,phaseKey);clearCodeReviewHistory(s,codeReviewScopeKey("standalone-phase",s.phaseIndex));clearVerifierHistory(s,codeReviewScopeKey("standalone-phase",s.phaseIndex));
        // TASK-23: this phase's per-review snapshots are only ever read by
        // its own next code review. A passed phase is never reviewed again,
        // so delete them (they are copies of the phase's dirty files).
        // Before the checkpoint delete, while revision is still readable.
        for(let r=1;r<=checkpoint.revision;r++) removeBaseline(repo,`${phaseBaselineKey}-review-r${r}`);
        delete s[CHECKPOINT_STATE_KEY];
        saveState(s);
        console.log(`  ✓ Phase ${s.phaseIndex+1} completed`);
        if(stopStage){
          // Mission 090 task 1.5: `--stage verify` covers the
          // verifier+mark_tasks step of the current phase — stop after the
          // phase's mark_tasks instead of advancing or entering final review.
          // Persist the same phase-progress marker the full pipeline writes
          // after the inner loop (line ~7743) and advance past the finished
          // phase, so the next stage command resumes at the first phase with
          // pending tasks instead of re-selecting the finished phase.
          s.checkpoint={type:"standalone-phase",phase:phase.name,index:s.phaseIndex,at:now()};
          s.phaseIndex+=1;
          saveState(s);
          stopAfterStage(stopStage);
          return;
        }
        continue;
      }

      // Unreachable: validateCheckpoint bounds nextStage/runningStage to the
      // four pipeline stages. Fail closed rather than loop forever.
      s.phase="escalated";s.step="standalone_unknown_stage";
      s.phaseCheckpointError={code:"INTERNAL_CONTRACT_ERROR",evidence:{stage}};
      saveState(s);
      die(`Standalone phase checkpoint names an unknown stage: ${String(stage)}. STOP — human intervention required.`);
    }
    s.checkpoint={type:"standalone-phase",phase:phase.name,index:s.phaseIndex,at:now()};saveState(s);
  }

  if(stopStage){
    // Mission 090 task 1.5: a stage run never enters mission-final review
    // (including the mission-final fix rounds, full pipeline only).
    stopAfterStage(stopStage);
    return;
  }
  s.phase="final_review";s.step="final_review";saveState(s);
  const finalHandoff=buildStandaloneHandoff({kind:"MISSION_FINAL",
    deltaChunks:scopedDeltaChunks(repo,missionBaselineKey,{mission,declaredPaths}),
    baselineKey:missionBaselineKey,declaredPaths,
    planPath:standalone.planPath(repo,mission),tasksPath:standalone.tasksPath(repo,mission),
    repoRoot:repo,
    implementationSummary:""});
  if(finalHandoff.meta.truncated) console.warn(truncationWarning(finalHandoff.meta));
    // TASK-26: the mission-final review gets a measured deadline too.
    const standaloneFinalBudget=roleDeadline(c,s,"code_reviewer");
    let final=await review("code_reviewer",`${finalHandoff.text}\n\n${standaloneFinalBudget.note}`,
      c,s,"",missionRequirements,null,standaloneFinalBudget.timeoutMs,false,codeReviewScopeKey("final","standalone"));
    noteRoleDeadlineOutcome(s,"code_reviewer",final,standaloneFinalBudget.derived);
    if(final.status==="completed"&&!final.policyViolation&&final.review?.decision==="PASS"){
      // Mission 025 task 2.4: never complete the mission on a final-reviewer
      // PASS while any linked verify/tool result exited non-zero or 124. The
      // mission-final review runs no phase gates, so the reviewer's own
      // observed tool calls are the evidence channel (same helper as task
      // 2.1, mission-wide linked set). A failed or timed-out linked result
      // escalates like a FAIL and never reaches finalizeMissionComplete
      // below. Only commands matching a linked task verify or gate command
      // count — inspection commands (grep/test/git diff) never refuse.
      const finalRefusal=shouldRefusePassForEvidence({gateResults:[],toolResults:reviewerLinkedToolResults(final,linkedVerifyCommandsForPhase(phaseList.flatMap(p=>p.tasks),c?.gates?.commands))});
      if(finalRefusal?.refuse===true){
        s.phase="escalated";s.step="final_review";saveState(s);die("Final review failed.");
      }
    }
    // Mission 031 Phase 3 task 3.5: INCOMPLETE-as-FAIL (no continuation): standalone-final-review has no continuation loop — an INCOMPLETE decision is treated as FAIL with explicit reason and never consumes a continuation.
    if(final.review?.decision==="INCOMPLETE") console.log("Standalone final review INCOMPLETE treated as FAIL (no continuation).");
    if(final.status!=="completed"||final.policyViolation||final.review?.decision!=="PASS"){
      // Mission 051 task 1.3: same shared fix-round driver as the
      // early-final site above. Escalates only on budget exhaustion (or
      // mid-loop refusal/policy), keeping message `Final review failed.`
      // and step `final_review`.
      const standaloneFinalFix=await runStandaloneFinalReviewFixRounds({c,s,site:"mission-final",initialReview:final,mission,phaseList,missionRequirements,declaredPaths,missionBaselineKey});
      if(standaloneFinalFix.outcome==="passed"){final=standaloneFinalFix.review;}
      else{s.phase="escalated";s.step=standaloneFinalFix.step||"final_review";saveState(s);die(standaloneFinalFix.message||"Final review failed.");}
    }
  finalizeMissionComplete(s);
  console.log("ALL WORK COMPLETE — HUMAN COMMIT REQUIRED");
}

// TASK-11 task 12 (resolution 3): resume-bypass observations for the s.phase
// allowlist gate in runImplementation. Gathers the authority-derived inputs
// the shared pure evaluatePlanningGate() needs — current framework, mission
// and phase list from config/state/disk (never from the checkpoint), the
// current task digest always, the current full delta digest only when the
// resume stage is an approval-reuse stage (never for the implementer stage,
// whose partial work legitimately changed the delta) — then returns
// `{decision, framework, phaseIndex}` where `decision` is the evaluator's
// decision object verbatim (never reconstructed locally, never a boolean)
// and framework/phaseIndex are a separate context object for logging and
// step naming. Every branch — resume, plan, escalate, including absent,
// inapplicable, and structurally invalid checkpoints — is decided by the
// shared module. A DECLARATION_MISMATCH while computing the delta becomes
// deltaError (drift, never a crash); any other computation failure throws.
// The persisted baselineKey is comparison data only: the delta is computed
// against the authority-derived expected key, so a corrupted or
// traversal-shaped persisted key never reaches the filesystem.
function evaluateResumeBypass(c,s){
  const checkpoint=s?.[CHECKPOINT_STATE_KEY]??null;
  const a=planningAdapter(c);
  const framework=a===standalone?"standalone":a===gsd?"gsd":"speckit";
  if(framework!=="standalone"&&framework!=="speckit"){
    // GSD untouched: the shared module returns plan for any other framework
    // without consulting the checkpoint.
    return {decision:evaluatePlanningGate(checkpoint,framework,{},{}),framework,phaseIndex:null};
  }
  const claimIndex=Number.isInteger(checkpoint?.phaseIndex)?checkpoint.phaseIndex:-1;
  let mission, missionIdentity, phaseList, deltaOpts;
  if(framework==="standalone"){
    mission=resolveStandaloneMission(repo,s,"");
    missionIdentity=s.mission||s.missionSeq||"mission";
    phaseList=standalone.phases(repo,mission);
    deltaOpts={mission,declaredPaths:standalone.declaredDeliverables(repo,mission)};
  }else{
    mission=s.mission||s.missionSeq||s.speckitFeatureDir||"mission";
    missionIdentity=mission;
    phaseList=specKitPhases(c);
    deltaOpts=undefined;
  }
  const currentIdx=(typeof s.phaseIndex==="number"&&s.phaseIndex>=0)?s.phaseIndex:0;
  const claimPhase=phaseList[claimIndex]??null;
  const phaseTasks=claimPhase?.tasks??[];
  const pending=phaseTasks.filter(t=>!t.done);
  const expectedBaselineKey=`mission-${sanitizeKeySegment(missionIdentity)}-phase-${currentIdx}`;
  const observed={phaseTaskDigest:phaseTaskDigest({framework,mission,phaseIndex:claimIndex,
    phaseName:claimPhase?.name??(typeof checkpoint?.phaseName==="string"?checkpoint.phaseName:""),
    tasks:phaseTasks.map(t=>({file:t.file,text:t.text})),repoRoot:repo})};
  if(isApprovalReuseStage(resumeStage(checkpoint))){
    try{
      observed.deltaDigest=deltaOpts
        ? deltaDigest(scopedDelta(repo,expectedBaselineKey,deltaOpts))
        : deltaDigest(scopedDelta(repo,expectedBaselineKey));
    }catch(e){
      if(e?.code==="DECLARATION_MISMATCH") observed.deltaError=e;
      else throw e;
    }
  }
  const decision=evaluatePlanningGate(checkpoint,framework,{
    mission,
    phaseIndex:currentIdx,
    allChecked:phaseTasks.length>0&&pending.length===0,
    exists:claimPhase!==null,
    phaseCount:phaseList.length,
    expectedBaselineKey,
  },observed);
  return {decision,framework,phaseIndex:currentIdx};
}

// TASK-19 Phase 4 test-only crash injection. A marker file under `.autopilot/`
// (already excluded from every scoped delta) simulates a crash in the exact
// window AFTER a per-task role child has returned but BEFORE the completion
// checkpoint is persisted — the window TASK-8 Test 8 requires a subprocess
// proof of, and the one the adapter-side sleep-marker technique cannot reach.
// It is inert unless a test writes the marker; the marker is removed before
// exiting so a resumed run does not re-crash. No model, adapter, or production
// path ever creates this file.
function maybeInjectPostRoleCrash(){
  const marker=path.join(repo,".autopilot",".autopilot-test-crash-after-role");
  if(!fs.existsSync(marker)) return;
  try{ fs.rmSync(marker,{force:true}); }catch{ /* best-effort */ }
  process.exit(137);
}

// TASK-21 step 2 test-only crash injection, twin of
// maybeInjectPostRoleCrash(). A marker file under `.autopilot/` (already
// excluded from every scoped delta) simulates a crash in the exact window
// AFTER a carried task's `prep` is persisted but BEFORE its carry commit —
// the window the adapter-side sleep-marker technique cannot reach, because
// a carry performs no relay call at all. It is inert unless a test writes
// the marker; an empty marker crashes on the first carried task, otherwise
// the marker names the task ID to crash on. The marker is removed before
// exiting so a resumed run does not re-crash and re-evaluates
// carryDecision to the same result. No model, adapter, or production path
// ever creates this file.
function maybeInjectCarryCrash(taskId){
  const marker=path.join(repo,".autopilot",".autopilot-test-crash-after-carry-prep");
  let armed=null;
  try{ armed=fs.readFileSync(marker,"utf8").trim(); }
  catch{ return; }
  if(armed&&armed!==String(taskId)) return;
  try{ fs.rmSync(marker,{force:true}); }catch{ /* best-effort */ }
  process.exit(137);
}

async function runImplementation(c){
  const stage=activeStage;
  // Mission 090 task 1.5: stage plumbing — the run dispatch passes the
  // parsed `--stage` value (null for a plain run, which is untouched).
  // `planning` stops after ensurePlanningReady below; implement/review/
  // verify cut inside runStandaloneImplementation, while non-standalone
  // frameworks refuse them (planning allowed) at their own dispatch.
  let s=loadState();

  // TASK 14 CORRECTION: reconcile any SpecKit checkbox snapshot left
  // pending by a previous process that crashed between the Implementer
  // writing tasks.md and this same reconciliation running normally (see
  // where s.pendingCheckboxSnapshot is set/cleared inside the phase loop
  // below). This MUST happen before specKitPhases()/phaseList or any other
  // logic that decides which phases/tasks are already complete by reading
  // tasks.md off disk — otherwise a resumed run could trust a checkbox an
  // interrupted Implementer wrote but Autopilot never verified, and skip a
  // phase that was never actually reviewed or verified.
  //
  // TASK 14 CORRECTION 2 (fail-closed fix): a snapshot that EXISTS but is
  // invalid — malformed, empty, missing its feature/mission identity, or
  // bound to a different feature/mission than the one active right now —
  // must never be silently ignored. Ignoring it is exactly the fail-open
  // bug: it leaves whatever the interrupted Implementer wrote on disk
  // (potentially poisoned "[x]" values) untouched and implicitly trusted.
  // ANY presence of s.pendingCheckboxSnapshot therefore forces a strict
  // validation gate here; only a snapshot that passes EVERY check is
  // reconciled, and the snapshot is preserved (never deleted) on failure so
  // this state can never quietly disappear and never be skipped by a
  // second resume attempt either.
  //
  // TASK 14 CORRECTION 3 (fail-closed fix): the gate must trigger on
  // PROPERTY PRESENCE, never on truthiness. `if(s.pendingCheckboxSnapshot)`
  // treats `false`/`null`/`0`/`""` as "nothing pending" and skips
  // validation entirely — exactly the same fail-open shape as CORRECTION
  // 2's `Array.isArray(...) && ...length` gap, just one layer earlier. The
  // only state that legitimately means "no pending recovery" is the
  // property being completely ABSENT from state.json (it is simply never
  // set outside the phase loop's own capture/clear below) — so presence
  // alone, regardless of value, must always route through
  // validatePendingCheckboxSnapshot(), which already rejects every
  // non-object value (including all four falsy corruptions above) via its
  // own leading `!snapshot || typeof snapshot!=="object"` check.
  //
  // F9: this is the FIRST thing a run does and it is reached BEFORE the
  // new-request decision further down this same function — for EVERY framework,
  // since standalone and GSD are only dispatched after it. Settle the intent
  // first (dropAbandonedMissionDebris does the asking), so a supplied new
  // request is never judged by the abandoned mission's snapshot. This call is
  // therefore the load-bearing one; the standalone reconcile's identical call is
  // ordering-redundant today and kept only so the rule lives with each reconcile
  // that depends on it.
  // Mission 055 Phase 1 task 1.2: snapshot BEFORE the early clear — the
  // takeover banner below is built from state, so it must still report
  // entries this drop already cleared in the same run (passed as
  // preClearedPlanningKeys; harmless when this drop is a no-op).
  const preClearedPlanningKeys=spentPlanningContinuationKeys(s);
  dropAbandonedMissionDebris(c,s);
  if(Object.hasOwn(s,"pendingCheckboxSnapshot")){
    const currentFeatureDir=activeSpecKitFeatureDir();
    const currentMissionIdentity=s.mission||s.missionSeq||s.speckitFeatureDir||"mission";
    const validation=validatePendingCheckboxSnapshot(s.pendingCheckboxSnapshot,currentFeatureDir,currentMissionIdentity,repo);
    if(!validation.ok){
      s.phase="escalated";s.step="task_snapshot_recovery_failed";s.taskMarkingError=validation.reason;saveState(s);
      die(`SpecKit pending checkbox snapshot failed validation during crash recovery: ${validation.reason}. Refusing to reconcile or trust on-disk checkboxes. STOP — human intervention required.`);
    }
    const reconciled=applyTaskCheckboxStates(s.pendingCheckboxSnapshot.tasks);
    // Mission 084 Phase 2 task 2.4 — SpecKit checkbox write invalidates
    // the snapshot reuse cache (scenario b).
    try{
      clearSnapshotReuseCache("orchestrator tracked write");
      console.log(`[snapshot-reuse] cache cleared: orchestrator tracked write`);
    }catch(error){
      console.log(`[snapshot-reuse] cache clear skipped (${error?.message||error})`);
    }
    if(!reconciled.ok){
      s.phase="escalated";s.step="task_marking_failed";s.taskMarkingError=reconciled.reason;saveState(s);
      die(`SpecKit task checkbox reconciliation failed while recovering from an interrupted attempt: ${reconciled.reason}. STOP — human intervention required.`);
    }
    delete s.pendingCheckboxSnapshot;
    saveState(s);
    console.log(`Reconciled ${reconciled.changed.length} SpecKit task checkbox edit(s) left pending by an interrupted attempt.`);
  }

  // Recover stale/interrupted runs from an unexpected shutdown BEFORE any new
  // run is created. This marks dead RUNNING runs INTERRUPTED (idempotent),
  // never consumes an attempt, never touches state.json counters, and never
  // rewrites existing result/progress data. A live run with a valid PID stays
  // RUNNING.
  const recovered=recoverStaleRuns(runsDirFor(s));
  if(recovered.interrupted.length){
    console.log(`Recovered ${recovered.interrupted.length} stale run(s) as INTERRUPTED.`);
  }
  refreshWatchReport(s);
  const rawRequest=process.env.AUTOPILOT_SPEC || c.project?.spec || "";
  const request=rawRequest || "Use the current project request/context.";
  console.log("\nProject Autopilot — run");
  // Refusal rule: continuing WITHOUT a message is allowed only when there is
  // open work at some step. If nothing has started, or the previous mission
  // is fully complete, a feature description (or --mission) is required.
  const activePhases=new Set(["planning","tasks_ready","implementing","final_review","phase_complete","verifying","wave","escalated"]);
  let openWork=activePhases.has(s.phase);
  if(!openWork && (s.phase==="idle"||!s.phase)){
    const ps=detectPlanningState(c,s,rawRequest);
    openWork=ps.status==="complete"||ps.status==="partial";
  }
  if(!openWork){
    // After `ap cancel` the old mission is over, so ANY usable request starts
    // a new one — even the identical text (re-running a cancelled request
    // used to die with the misleading "no feature description provided").
    const isNewRequest=hasUsableRequest(rawRequest) && (s.phase==="cancelled" || rawRequest.trim()!==String(s.planningRequest||"").trim());
    if(isNewRequest){
      // A new feature description after completion/fresh state → start a new
      // mission: clear the checkpoint so planning runs with a fresh seq.
      s.phase="idle"; s.step="idle"; s.mission=null; s.missionSeq=null; s.planningStartedAt=null;
      delete s.fixtureGitBlockWarning; delete s.fixtureGitBlockWarningPhaseIndex;
      saveState(s);
      console.log("New request detected — starting a new mission.");
      clearInheritedFailureCounters(s);
    } else {
      die(`No open task to continue and no feature description provided. Run \`ap run <description>\` or use \`--mission <name>\`.`);
    }
  } else if(hasUsableRequest(rawRequest) && rawRequest.trim()!==String(s.planningRequest||"").trim()){
    // TASK-14 Phase 8 follow-up (mission-004 finding F1): a SUPPLIED, DIFFERENT
    // feature description starts a new mission even while the previous one is
    // still open — `escalated` is in `activePhases` above, so without this the
    // new request was silently swallowed and the run was decided by the OLD
    // mission's phase checkpoint instead, dying with
    // "Phase checkpoint drifted; refusing to resume." and making a new mission
    // impossible without hand-editing state.json.
    //
    // The mission's own lifecycle rule is preserved: `ap run` with NO message
    // still continues the open mission (including the supported recovery path
    // of clearing a failure budget and resuming), and only a genuinely
    // different supplied request abandons it.
    // F3: the notice is built from the OPEN mission's state, so it is printed
    // BEFORE the clears below, and lists the spent failure counters as
    // cleared below — the clearInheritedFailureCounters line printed after
    // the banner is the run's only failure-counter clear line (the
    // planning-continuation cleared line stays separate).
    for(const line of newMissionTakeoverLines(s,rawRequest,preClearedPlanningKeys)) console.log(line);
    // F3: clear the dead mission's ENTIRE owned state, not just the two
    // checkpoints. Hand-clearing three keys left `currentPhase`, `currentTask`,
    // `feedback`, `relayPolicyViolation`, `lastReview`, a stale
    // `planningStateReview` and the crash-recovery checkbox snapshot behind,
    // where they surface in state.json and the watch report as if they belonged
    // to the new mission (a foreign phase and task text, and a `lastFailure`
    // that reads like a fresh silent stop). Failure counters are cleared
    // separately by clearInheritedFailureCounters after the banner (which
    // reads the pre-clear state) — `ap reset` remains the supported way to
    // zero them within a mission.
    // Mission 055 Phase 1 task 1.2: spent planner continuations are NOT
    // counters — the new mission starts with a full planner/plan_reviewer
    // allowance, so clear them here (banner above already listed them).
    // Mission 093 task 1.3: prior cancel/reset/escalation records are THIS
    // mission's outcome — drop them unconditionally so the new mission
    // carries no prior cancel line, reset record or escalation record.
    for(const key of MISSION_SCOPED_STATE_KEYS) delete s[key];
    clearPlanningContinuations(s);
    delete s.lastCancelled; delete s.lastReset; delete s.lastContinuation;
    s.phase="idle"; s.step="idle"; s.mission=null; s.missionSeq=null; s.planningStartedAt=null;
    saveState(s);
    clearInheritedFailureCounters(s);
  }
  if(s.phase!=="tasks_ready" && s.phase!=="implementing" && s.phase!=="final_review" && s.phase!=="complete" && s.phase!=="phase_complete") {
    // Resolution 3 (TASK-11 task 12): a valid phase checkpoint bypasses
    // planning — decided by the shared pure evaluator, never reimplemented
    // inline. resume skips ensurePlanningReady(); escalate fails closed
    // with evidence (never routes to planning); plan keeps today's route.
    const bypass=evaluateResumeBypass(c,s);
    if(bypass.decision.action==="resume"){
      console.log(`Phase checkpoint resume: skipping planning (valid ${bypass.framework} checkpoint for phase ${bypass.phaseIndex}).`);
    }else if(bypass.decision.action==="escalate"){
      s.phase="escalated";s.step=`${bypass.framework}_checkpoint_drift`;
      s.phaseCheckpointError={code:bypass.decision.code,evidence:bypass.decision.evidence};
      saveState(s);
      die(`Phase checkpoint ${bypass.decision.code==="PHASE_CHECKPOINT_DRIFT"?"drifted":"is invalid"}; refusing to resume. STOP — human intervention required.`);
    }else{
      await ensurePlanningReady(c,s,request);
      s=loadState();
    }
  }
  if(stage==="planning"){
    // Mission 090 task 1.3: planning-only run — planning already persisted
    // state.phase/step via ensurePlanningReady (tasks_ready), so stop
    // cleanly here before the framework dispatch; the next stage command
    // resumes (a later plain run skips planning via the bypass above).
    console.log("Stage 'planning' complete — stopping after planning (resume with the next stage command).");
    return;
  }
  const a=planningAdapter(c);
  if(a===standalone) return await runStandaloneImplementation(c,s);
  if(a===gsd){
    return await runGsdImplementation(c,s);
  }

  // TASK 15.6E: an already-persisted `tasks_ready` mission can hold a
  // structurally invalid tasks.md (the real incident: 5 unchecked loose
  // checkboxes, zero `## Phase` headings, postcondition green under the old
  // flat-checkbox rule). Entering Implementation with it dies unrecoverably
  // below. Revalidate with the SAME strengthened tasks postcondition the
  // planning stage enforces, and convert the failure into the SAME
  // recoverable Tasks-stage correction flow — a planning-stage-postcondition
  // checkpoint for step "tasks" — so a same-request retry resumes the Tasks
  // stage on the same mission and feature instead of dying here again.
  // Strictly gated to tasks_ready (a mid-implementation resume legitimately
  // has progressively-checked phases and must never be re-routed to
  // planning), SpecKit only (above early-returns own GSD/standalone), and
  // never rewrites tasks.md — the Planner corrects it on retry.
  if(s.phase==="tasks_ready"){
    const reval=validatePlanningStagePostcondition({
      repo,
      stage:"tasks",
      sessionFeatureDir:s.speckitFeatureDir||null,
      preexistingFeatureDirs:Array.isArray(s.planningPreexistingFeatureDirs)?s.planningPreexistingFeatureDirs:[]
    });
    if(!reval.ok){
      if(reval.featureDir && !s.speckitFeatureDir) s.speckitFeatureDir=reval.featureDir;
      const steps=(speckit.inspect(repo).steps||[]);
      const cmdIdx=steps.findIndex(st=>st && st.type!=="gate" && st.command && String(st.id||"").includes("tasks"));
      s.speckitPlanningCheckpoint={
        step:"tasks",
        index:Number.isInteger(cmdIdx)&&cmdIdx>=0?cmdIdx:(Number.isInteger(s.planningStepIndex)?s.planningStepIndex:0),
        failedAt:now(),
        reason:"planning-stage-postcondition",
        postcondition:{
          reason:reval.reason||null,
          artifact:reval.artifact||null,
          expected:reval.expected||null,
          detail:reval.detail||null
        }
      };
      s.phase="planning";s.step="tasks";
      saveState(s);
      die(formatPostconditionError("tasks",reval));
    }
  }

  const phaseList=specKitPhases(c);
  if(!phaseList.length)die("No unchecked SpecKit tasks found.");
  // Mission 090 task 1.5: stage-scoped implement/review/verify are
  // standalone-only (`--stage planning` stops before the framework dispatch
  // above, so only the refusals land here).
  if(stage!=null&&stage!=="planning"){
    die(`Usage error: --stage ${stage} is only supported with the standalone framework in this build. Use: ap run [request]`);
  }
  s.phase="implementing";saveState(s);
  console.log(`\n[Implementation]`);
  console.log(`  Phases: ${phaseList.length}`);
  console.log(`  Implementer: ${c.roles?.implementer?.adapter||""}`);
  if(typeof s.phaseIndex!=="number" || s.phaseIndex<0) s.phaseIndex=0;

  // TASK 13 / Problem B: a repository may already be dirty (modified,
  // deleted, staged, or untracked files) before this mission ever runs.
  // The final review must see only THIS MISSION's cumulative implementation
  // delta, never that pre-existing dirt — so its baseline is captured once,
  // before the very first phase's very first attempt. ensureBaseline() is
  // idempotent: a resumed process calling this again after phase 1 already
  // completed is a safe no-op, never re-capturing (and thereby never
  // absorbing already-made implementation changes into the baseline).
  //
  // The key is namespaced by THIS mission's own stable identity
  // (s.mission, falling back to s.missionSeq/s.speckitFeatureDir — all of
  // which are set once, at the start of planning, and persisted in
  // state.json, so a resume of the SAME mission reuses the SAME key) so a
  // second, later mission in the same repository never reuses the first
  // mission's baseline. sanitizeKeySegment() turns that identity into a
  // path-safe segment — never interpolate it into a path directly, since
  // it can originate from planner-authored (LLM) content.
  const missionIdentity=s.mission||s.missionSeq||s.speckitFeatureDir||"mission";
  const missionDir = getMissionWatchDir(s);
  const missionBaselineKey=`mission-${sanitizeKeySegment(missionIdentity)}`;
  ensureBaseline(repo,missionBaselineKey);

  for(;s.phaseIndex<phaseList.length;s.phaseIndex++){
    if(s.operatorPhaseNote&&Number.isInteger(s.operatorPhaseNote.phaseIndex)&&s.operatorPhaseNote.phaseIndex!==s.phaseIndex){ delete s.operatorPhaseNote; saveState(s); }
    const phase=phaseList[s.phaseIndex];
    let phaseTasks=phase.tasks.filter(t=>!t.done);
    if(!phaseTasks.length){
      // Every task already checked: a stale checkpoint must not survive
      // its completed phase — clear it and advance.
      if(Object.hasOwn(s,CHECKPOINT_STATE_KEY)){ delete s[CHECKPOINT_STATE_KEY];saveState(s); }
      continue;
    }
    // Restored per phase, for the same reason as the standalone loop: a
    // resumed retry must be handed the rejection it is retrying against.
    // TASK-39 follow-up: clear the fixture-block warning when a new
    // phase starts (see the standalone loop above).
    if(s.fixtureGitBlockWarning && s.fixtureGitBlockWarningPhaseIndex!==s.phaseIndex){ delete s.fixtureGitBlockWarning; delete s.fixtureGitBlockWarningPhaseIndex; }
    let passed=false;
    let feedback=feedbackText(loadReviewFeedback(s,speckitPhaseFeedbackKey(s.phaseIndex)));
    // TASK-20: reviewer-facing task labels — position i is phaseTaskIds[i],
    // labelled 1-based by taskLabel() (never derived inline; a stable task
    // ID's own T segment is 0-based, see finding-task-locality.mjs).
    const scope=phaseTasks.map((t,i)=>`- [${taskLabel(i)}] ${t.text} (${t.file}:${t.line})`).join("\n");
    const phaseRequirements=phaseTasks.flatMap(task=>task.requiredCapabilities||[]);
    console.log(`\n  Phase ${s.phaseIndex+1}/${phaseList.length}: ${phase.name} — ${phaseTasks.length} task(s)`);
    // Per-phase baseline: captured once at this phase's first attempt
    // (idempotent — a retry after a FAILED attempt, or a resume mid-phase,
    // never re-captures, so a failed attempt's own partial changes are
    // never folded into "pre-existing" state and hidden from review).
    const phaseBaselineKey=`${missionBaselineKey}-phase-${s.phaseIndex}`;
    ensureBaseline(repo,phaseBaselineKey);
    warnHeadMovedSinceBaseline(s,phaseBaselineKey);

    // Durable phase-stage checkpoint (TASK-7), shared identically with the
    // Standalone loop: absent or bound elsewhere → revision 1 at the
    // Implementer; present but malformed → fail closed. A checkpoint bound
    // to another phase here is corruption, never a resume — the
    // completed-phase path above clears stale ones.
    const taskIdentities=()=>phaseTasks.map(t=>({file:t.file,text:t.text}));
    let checkpoint=s[CHECKPOINT_STATE_KEY]??null;
    if(!isCheckpointForPhase(checkpoint,{framework:"speckit",mission:missionIdentity,phaseIndex:s.phaseIndex})){
      if(checkpoint!==null&&checkpoint!==undefined){
        s.phase="escalated";s.step="speckit_checkpoint_identity_mismatch";
        s.phaseCheckpointError={code:"PHASE_CHECKPOINT_INVALID",expected:{framework:"speckit",mission:missionIdentity,phaseIndex:s.phaseIndex},observed:{framework:checkpoint.framework,mission:checkpoint.mission,phaseIndex:checkpoint.phaseIndex}};
        saveState(s);
        die(`SpecKit phase checkpoint is bound to a different phase/mission. STOP — human intervention required.`);
      }
      checkpoint=createCheckpoint({framework:"speckit",mission:missionIdentity,phaseIndex:s.phaseIndex,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo,baselineKey:phaseBaselineKey,at:now()});
      s[CHECKPOINT_STATE_KEY]=checkpoint;s.attempt=1;saveState(s);
    }else{
      const structural=validateCheckpoint(checkpoint);
      if(!structural.ok){
        s.phase="escalated";s.step="speckit_checkpoint_invalid";
        s.phaseCheckpointError={code:structural.code,reason:structural.reason,evidence:structural.evidence};
        saveState(s);
        die(`SpecKit phase checkpoint failed validation: ${structural.reason}. STOP — human intervention required.`);
      }
      if(typeof s.attempt!=="number"||s.attempt<1) s.attempt=1;
      // Backlog #105: an operator resume (new process) never reuses a recorded gate result; only the in-process verifier infra retry may.
      delete checkpoint.lastGate;
    }

    // TASK-19 Phase 3 task 10: same no-op-until-roleProgress brief producer as
    // the Standalone loop.
    ensurePhaseBriefForCheckpoint({repo,mission:missionIdentity,framework:"speckit",checkpoint,phase:{name:phase.name,phaseTotal:phaseList.length},tasks:phaseTasks.map(t=>({id:t.id,text:t.text})),planContext:scope});

    // Merge a stage-transition decision into the checkpoint — the same
    // shared decideTransition() the Standalone loop calls, never a
    // hand-duplicated copy: next stage, cleared running stage, revision,
    // display/backoff attempts, and — for Implementer completion — the
    // recorded approval evidence. Retry and escalation authority stays
    // entirely with enforceAttemptFailure()'s return value; this only
    // persists what decideTransition computed. The per-stage attempts
    // counters are never compared against a limit here.
    const applyCheckpointTransition=(transition)=>{
      if(!transition.ok){
        s.phase="escalated";s.step="speckit_transition_invalid";
        s.phaseCheckpointError={code:transition.code||"PHASE_CHECKPOINT_INVALID",reason:transition.reason,evidence:transition.evidence};
        saveState(s);
        die(`SpecKit phase transition failed: ${transition.reason}. STOP — human intervention required.`);
      }
      // TASK-29: persist which stage (if any) owns a pending retry pause.
      // `retry` (infrastructure/adapter failure) arms the pause for
      // `nextStage`; every other action clears it.
      checkpoint={...checkpoint,nextStage:transition.nextStage,runningStage:null,revision:transition.revision,attempts:transition.attempts,retryPauseStage:retryPauseStageOf(transition)};
      clearContinuationGateResult(checkpoint);
      // Backlog #105: the recorded gate survives only a verifier infra retry; a functional rejection / restart re-runs gates.
      if(!(transition.action==="retry"&&transition.nextStage==="verifier")) delete checkpoint.lastGate;
      if(transition.clearApprovals){ checkpoint.codeReviewer=null;checkpoint.verifier=null;checkpoint.roleProgress=emptyRoleProgress();checkpoint.roleProgressWorkAhead=[]; }
      return checkpoint;
    };

    // The SpecKit twin of the Standalone loop's recordPhaseFindingTasks(): the
    // SAME call, the same pre-wipe read, the same key as the review feedback —
    // only the mission identity and framework differ (TASK-20's hard rule:
    // both loops, always). `revision` is read here, so it is the
    // pre-transition revision N; `carryAllowed` is true for a code-review
    // FAIL and for a verifier FAIL (TASK-21 step 2, c-gap 2).
    const recordPhaseFindingTasks=(key,findings,carryAllowed)=>{
      recordFindingTasks(s,key,{
        phaseTaskDigest:phaseTaskDigest({framework:"speckit",mission:missionIdentity,phaseIndex:s.phaseIndex,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo}),
        findings,
        taskIds:stableTaskIds({framework:"speckit",mission:missionIdentity,phaseIndex:s.phaseIndex,phaseNumber:s.phaseIndex+1,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo}),
        factsByTask:checkpoint.roleProgress?.implementer?.factsByTask,
        revision:checkpoint.revision,
        carryAllowed,
      });
    };

    // Role results from this process, kept so combined failure
    // classification sees the same evidence as before. A resumed process
    // has none: the checkpoint's stored approvals plus digest-matched
    // evidence stand in their place.
    let lastImpl=null,lastReview=null;

    while(!passed){
      phaseTasks=phase.tasks.filter(t=>!t.done);
      if(!phaseTasks.length){
        // All checked mid-loop: same stale-clearance as the entry path.
        if(Object.hasOwn(s,CHECKPOINT_STATE_KEY)){ delete s[CHECKPOINT_STATE_KEY];saveState(s); }
        passed=true;
        continue;
      }
      s.currentPhase={name:phase.name,tasks:phaseTasks};s.currentTask=phaseTasks[0];s.feedback=feedback;saveState(s);
      // Stage-conditional observations for the shared gate evaluator: the
      // task digest always; the full delta digest only for approval-reuse
      // stages. An interrupted Implementer legitimately leaves a partial
      // delta, so it is neither computed nor compared while the
      // Implementer is the resume stage.
      const stage=resumeStage(checkpoint);
      const observed={phaseTaskDigest:phaseTaskDigest({framework:"speckit",mission:missionIdentity,phaseIndex:s.phaseIndex,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo})};
      if(isApprovalReuseStage(stage)){
        try{
          observed.deltaDigest=deltaDigest(scopedDelta(repo,phaseBaselineKey));
        }catch(e){
          if(e?.code==="DECLARATION_MISMATCH") observed.deltaError=e;
          else throw e;
        }
      }
      const gate=evaluatePlanningGate(checkpoint,"speckit",{mission:missionIdentity,phaseIndex:s.phaseIndex,allChecked:false},observed);
      if(gate.action==="escalate"){
        s.phase="escalated";s.step="speckit_checkpoint_drift";
        s.phaseCheckpointError={code:gate.code,evidence:gate.evidence};
        saveState(s);
        die(`SpecKit phase checkpoint ${gate.code==="PHASE_CHECKPOINT_DRIFT"?"drifted":"is invalid"}; refusing to reuse approval. STOP — human intervention required.`);
      }
      if(gate.action!=="resume"){
        s.phase="escalated";s.step="speckit_checkpoint_gate";
        s.phaseCheckpointError={code:"INTERNAL_CONTRACT_ERROR",evidence:gate};
        saveState(s);
        die(`SpecKit phase checkpoint gate returned ${gate.action} inside the implementation loop. STOP — human intervention required.`);
      }

      if(stage==="implementer"){
        if(checkpoint.attempts.implementer>0){ s.attempt+=1;saveState(s);await maybeRetryPause(c,s,checkpoint,"implementer"); }
        s.step="implement";
        // Durable interruption signal: runningStage was persisted BEFORE the
        // previous Implementer launch, so a hard kill (no result processed,
        // attempts.implementer still 0) still reads "implementer" here.
        // attempts alone cannot distinguish a kill from a first attempt.
        const implementerInterrupted=checkpoint.runningStage==="implementer";
        checkpoint.runningStage="implementer";s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);

      // TASK 14 CORRECTION: snapshot EVERY task in the active feature
      // (every phase, not just this one) immediately before the
      // Implementer runs, and persist it BEFORE the relay call so a crash
      // between the Implementer writing and the reconciliation below can
      // still recover on resume (see the pendingCheckboxSnapshot handling
      // near the top of runImplementation).
      //
      // TASK 14 CORRECTION 2: explicitly bound to the canonical active
      // feature directory and this mission's own stable identity (the SAME
      // identity used for the baseline keys above) — this is exactly what
      // lets startup recovery detect a stale/mismatched snapshot instead of
      // ever trusting one captured for a different feature or mission.
      const preAttemptTasks=snapshotActiveFeatureTasks(c);
      s.pendingCheckboxSnapshot={feature:activeSpecKitFeatureDir(),mission:missionIdentity,tasks:preAttemptTasks,capturedAt:now()};saveState(s);

      // TASK 15.6F: worktree listing before the Implementer runs. Compared
      // after the attempt against the Git-observable phase delta: a
      // worktree that changed while the delta stayed empty is the
      // git-invisible-phase trap (e.g. an empty directory, which Git cannot
      // represent). A listing failure records null and the guard below
      // treats it as "unknown" — proceeding exactly as before.
      let attemptFsBefore=null;
      try{ attemptFsBefore=listWorktreeEntries(repo); }catch{ attemptFsBefore=null; }

      // Same gap as the standalone loop had: a retry without the rejection it
      // is retrying against can only guess. `feedback` holds the
      // code_reviewer/verifier findings from the previous attempt (or the
      // resumed rejection), empty on attempt 1.
      // TASK-24: no phase-wide retryFindings here — each re-run task's
      // brief is built per task inside the loop below (after the carry
      // decision), so a task gets only its own findings plus the
      // phase-wide/unlinked ones.
      // An interrupted or rejected Implementer left partial work behind:
      // continue it rather than starting over. attempts.implementer covers
      // rejections (a result was processed); implementerInterrupted covers
      // hard kills (runningStage was persisted before the launch that died
      // and no attempt was ever recorded).
      const resumeNote=(checkpoint.attempts.implementer>0||implementerInterrupted)
        ? `\n\nA previous Implementer run for this phase was interrupted or rejected: inspect the existing work in the tree and continue it rather than starting over.`
        : "";
      // TASK-19 Phase 4 (task 12): one fresh invocation per task, SpecKit
      // branch — same contract as the Standalone loop, GSD deliberately
      // untouched.
      if(!checkpoint.roleProgress) checkpoint.roleProgress=emptyRoleProgress();
      ensurePhaseBriefForCheckpoint({repo,mission:missionIdentity,framework:"speckit",checkpoint,phase:{name:phase.name,phaseTotal:phaseList.length},tasks:phaseTasks.map(t=>({id:t.id,text:t.text})),planContext:scope});
      const perTaskLimits=resolvePerTaskLimits(c.policy, Number(c.policy?.relay_timeout_ms)>0?Number(c.policy.relay_timeout_ms):RELAY_TIMEOUT_DEFAULT_MS);
      const phaseTaskIds=stableTaskIds({framework:"speckit",mission:missionIdentity,phaseIndex:s.phaseIndex,phaseNumber:s.phaseIndex+1,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo});
      const phaseTaskDigestValue=phaseTaskDigest({framework:"speckit",mission:missionIdentity,phaseIndex:s.phaseIndex,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo});
      const expectedRunId=`${missionIdentity}:phase-${s.phaseIndex}`;
      let impl=null;
      // Mission 093 Part 1 task 2.5: this loop's carry layout — the task
      // ids carryDecision carries forward, in plan order. The implementer
      // attempt run that follows each carry snapshots the list as
      // carriedForwardTasks; attempt runs before the first carry record
      // null. Never fabricated — only real carryDecision results enter.
      const carriedTasks=[];
      for(;;){
        const cursorResume=evaluateCrashResume({progress:checkpoint.roleProgress,role:"implementer",taskIds:phaseTaskIds});
        if(cursorResume.action==="complete") break;
        if(cursorResume.action!=="resume"){
          s.phase="escalated";s.step="speckit_role_progress_cursor";
          s.phaseCheckpointError={code:"INTERNAL_CONTRACT_ERROR",evidence:cursorResume};
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          die(`SpecKit Implementer cursor is not resumable (${cursorResume.action}). STOP — human intervention required.`);
        }
        const taskId=cursorResume.taskId;
        const taskIndex=phaseTaskIds.indexOf(taskId);
        // 003#32: twin of the standalone hook above — advance s.currentTask
        // to the task the cursor is actually on, so the watch-report header
        // never reports the stale phase-start task.
        if(taskIndex>=0){ s.currentTask=phaseTasks[taskIndex]; saveState(s); }
        const prep=prepareTaskInvocation({progress:checkpoint.roleProgress,role:"implementer",runId:expectedRunId,revision:checkpoint.revision,phaseTaskDigest:phaseTaskDigestValue,taskId,taskIds:phaseTaskIds});
        if(!prep.ok){
          s.phase="escalated";s.step="speckit_role_progress_invalid";
          s.phaseCheckpointError={code:prep.code,reason:prep.reason,evidence:prep.evidence};
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          die(`SpecKit Implementer task cursor failed validation: ${prep.reason}. STOP — human intervention required.`);
        }
        checkpoint.roleProgress=prep.progress;
        checkpoint.runningStage="implementer";s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);

        // TASK-21 step 2 (carry forward), SpecKit twin of the Standalone
        // hook above: same decision, same replay through commitTaskResult
        // under the new revision, same untouched wipe and cursor rules. A
        // kill between the `prep` persist above and the carry commit below
        // leaves currentTaskId on this task, and the restart re-evaluates
        // carryDecision to the same result — no extra state needed.
        const findingRecord=loadFindingTasks(s,speckitPhaseFeedbackKey(s.phaseIndex),{phaseTaskDigest:phaseTaskDigestValue});
        const carried=carryDecision({record:findingRecord,taskId,progress:checkpoint.roleProgress,revision:checkpoint.revision,phaseTaskDigest:phaseTaskDigestValue});
        if(carried.carry){
          maybeInjectCarryCrash(taskId);
          const normalized={role:"implementer",runId:expectedRunId,revision:checkpoint.revision,phaseTaskDigest:phaseTaskDigestValue,taskId,status:"completed",facts:carried.facts};
          const carryCommitted=commitTaskResult({progress:checkpoint.roleProgress,expected:prep.expected,result:normalized});
          if(!carryCommitted.ok){
            s.phase="escalated";s.step="speckit_task_carry_invalid";
            s.phaseCheckpointError={code:carryCommitted.code,reason:carryCommitted.reason,evidence:carryCommitted.evidence};
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            die(`SpecKit Implementer carry-forward commit failed: ${carryCommitted.reason}. STOP — human intervention required.`);
          }
          checkpoint.roleProgress=carryCommitted.progress;
          clearTaskContinuation(s,`task:speckit:phase-${s.phaseIndex}:${taskId}`);
          clearRolloverDeadEnds(s,`task:speckit:phase-${s.phaseIndex}:${taskId}`);
          clearBackstopFirings(s,`task:speckit:phase-${s.phaseIndex}:${taskId}`);
          // Backlog #26 Step A: the task converged — its hand-off note dies
          // with it, so a later retry of a DIFFERENT attempt never inherits a
          // stale note. Best-effort; kept on escalation (post-mortem).
          // Backlog #26 Step B: its session store dies with it too (size
          // logged first; kept on escalation, like the note).
          logSessionStoreSize(missionIdentity,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
          clearSessionStore(missionIdentity,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
          clearHandoffNote(missionIdentity,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
          clearLastContinuation(s,`task:speckit:phase-${s.phaseIndex}:${taskId}`);
          // No detectWorkAhead for carried tasks: no new files were written.
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          carriedTasks.push(taskId);
          console.log(`  Task ${taskId} carried forward — not named by the review findings`);
          continue;
        }

        let beforeMap;
        try{ beforeMap=attributionMap(scopedDeltaChunks(repo,phaseBaselineKey)); }
        catch(e){
          s.phase="escalated";s.step="speckit_delta_mismatch";
          s.phaseCheckpointError={code:e?.code||"DELTA_COMPUTATION_FAILED",evidence:{message:e?.message||String(e)}};
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          die(`SpecKit task attribution failed before task ${taskIndex+1}: ${e?.message||e}. STOP — human intervention required.`);
        }
        const promptBuilt=buildTaskPrompt({
          framework:"speckit",mission:missionIdentity,phaseIndex:s.phaseIndex,phaseNumber:s.phaseIndex+1,phaseName:phase.name,phaseTotal:phaseList.length,
          revision:checkpoint.revision,role:"implementer",phaseTaskDigest:phaseTaskDigestValue,
            taskIds:phaseTaskIds,tasks:phaseTasks,currentTaskId:taskId,roleProgress:checkpoint.roleProgress,
            phaseBriefPath:phaseBriefRelativePath(missionIdentity,s.phaseIndex+1),
            deadEnds:readRolloverDeadEnds(s,`task:speckit:phase-${s.phaseIndex}:${taskId}`),
            handoffNote:readHandoffNote(missionIdentity,taskDisplayRef(phaseTasks[taskIndex],taskIndex)),
            handoffNoteExcerpts:handoffNoteExcerptsFor(missionIdentity,taskDisplayRef(phaseTasks[taskIndex],taskIndex)),
            handoffNoteMaxChars:resolveHandoffNoteMaxChars(c.policy),
            handoffPerTaskMaxTurns:resolvePerRoleLimits('implementer',c.policy,(()=>{const e=effectiveRoleModelFor(s,c,'implementer');const pat=e? (agents[e.adapter]?.free_model_pattern ?? null):null;return e?{adapter:e.adapter,model:e.model,free_model_pattern:pat}:{};})()).perTaskMaxTurns,
            fixtureGitBlockWarning:s.fixtureGitBlockWarning,
            gitGuardWarning:s.gitGuardWarning,
          });
        if(!promptBuilt.ok){
          s.phase="escalated";s.step="speckit_prompt_invalid";
          s.phaseCheckpointError={code:promptBuilt.code,reason:promptBuilt.reason,evidence:promptBuilt.evidence};
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          die(`SpecKit per-task prompt assembly failed: ${promptBuilt.reason}. STOP — human intervention required.`);
        }
        // TASK-24 step 4, SpecKit twin: each re-run task's brief gets only
        // its own findings, plus every phase-wide/unlinked one. Same
        // contract as the Standalone hook above; the reviewer still gets
        // the full `feedback` as FEEDBACK TO ADDRESS.
        let taskRetryFindings="";
        if(feedback){
          const taskFindings=loadReviewFeedback(s,speckitPhaseFeedbackKey(s.phaseIndex));
          if(taskFindings.length===0){
            taskRetryFindings=`\n\nReviewer feedback from the previous attempt that MUST be addressed — fix every finding or rebut it with evidence, do not declare the work complete while any finding stands:\n${feedback}`;
          }else{
            const grouped=findingsForTask({findings:taskFindings,record:findingRecord,taskId,revision:checkpoint.revision});
            if(grouped.fallback){
              taskRetryFindings=`\n\nReviewer feedback from the previous attempt that MUST be addressed — fix every finding or rebut it with evidence, do not declare the work complete while any finding stands:\n${feedback}`;
            }else{
              const sections=[];
              if(grouped.own.length) sections.push(`Findings for this task:\n${feedbackText(grouped.own)}`);
              if(grouped.phaseWide.length) sections.push(`Phase-wide findings (they concern every task in this phase, including this one):\n${feedbackText(grouped.phaseWide)}`);
              if(grouped.unlinked.length) sections.push(`Findings not linked to a specific task (check whether they concern this task):\n${feedbackText(grouped.unlinked)}`);
              // Mission 052 (a): findings another task owns reach this
              // brief as READ-ONLY context, so the excerpt block below
              // stays fed by own+phaseWide+unlinked only.
              const handledBlock=renderHandledFindings(grouped.handled);
              if(sections.length){
                const fixPassBlock=fixPassBriefExcerpts([...grouped.own,...grouped.phaseWide,...grouped.unlinked],fixPassBriefReadFile);
                taskRetryFindings=`\n\nReviewer feedback from the previous attempt that MUST be addressed — fix every finding or rebut it with evidence, do not declare the work complete while any finding stands:\n${sections.join("\n")}\n${fixPassHandoffPointer(readHandoffNote(missionIdentity,taskDisplayRef(phaseTasks[taskIndex],taskIndex)))}${fixPassBlock}`;
              }else if(carried.reason==="overlap"&&carried.overlap){
                const labels=(carried.overlap.taskIds??[]).map(id=>{const idx=phaseTaskIds.indexOf(id);return idx>=0?taskLabel(idx):id;}).join(", ");
                const files=(carried.overlap.files??[]).join(", ");
                taskRetryFindings=`\n\nThis task is being re-run because the fix for task(s) ${labels} changed file(s) it owns: ${files}. That fix is already done — do not redo it. Re-verify this task against its acceptance criteria and repair only what the change broke.`;
              }else if(carried.reason==="local-check-failed"){
                taskRetryFindings=`\n\nThis task is being re-run because its own local check failed last time. Re-run that check and fix this task until it passes.`;
              }else{
                taskRetryFindings=`\n\nThis task is being re-run. Re-verify it against its acceptance criteria.`;
              }
              // Appended outside the branch above, so a task that has no
              // finding of its own still learns which neighbour's work it
              // must not redo.
              {const earlierCodeRounds=implementerEarlierRoundsText(s,codeReviewScopeKey("speckit-phase",s.phaseIndex));if(earlierCodeRounds) taskRetryFindings+=`\n\n${earlierCodeRounds}`;}
              if(handledBlock) taskRetryFindings+=`\n\n${handledBlock}`;
            }
          }
        }
        const autoRejectNote=autoRejectRetryNote([lastImpl,lastReview,impl].filter(Boolean));
        // Mission 093 Part 1 task 2.3: the run scope owning this attempt's
        // session number (continuation-budget used at launch + 1).
const operatorNote=operatorPhaseNoteLine(s);
const taskImpl=await relay("implementer",`${promptBuilt.text}${taskRetryFindings}${resumeNote}${autoRejectNote}${operatorNote?`\n\n${operatorNote}`:""}`,c,s,{resume:false,requirements:phaseRequirements,timeoutMs:perTaskLimits.perTaskTimeoutMs,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex),capEnabled:true,contScope:`task:speckit:phase-${s.phaseIndex}:${taskId}`,carriedForwardTasks:[...carriedTasks]});
          impl=taskImpl;
          // Mission 093 Part 1 task 3.4: capture git diff --stat after implementer attempt
          if (missionDir) {
            let diffStat = null;
            try { diffStat = changedFilesStat(repo); } catch { diffStat = null; }
            const attempt = (checkpoint?.attempts?.implementer ?? 0) + 1; // 1-based, matches gate events
            try { appendWatchEvent(missionDir, { type: "diff_stat", phase: s.phaseIndex + 1, attempt, taskRef: taskDisplayRef(phaseTasks[taskIndex], taskIndex), stat: diffStat }); } catch {}
          }
          maybeInjectPostRoleCrash();
           if(taskImpl.policyViolation){
             reconcileTaskCheckboxesBeforePolicyDie(s,preAttemptTasks,"SpecKit","pendingCheckboxSnapshot");
             s.phase="escalated";s.step="relay_policy_violation";s.relayPolicyViolation=taskImpl.policyViolation;
             s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
             die(formatRelayPolicyViolation(s.relayPolicyViolation, taskImpl.touchedFiles));
           }
           if(taskImpl.capped){
             // Mission 047 Phase 1 task 1.2: cumulative raw-token backstop
             // rollover, BEFORE the cap path below. SpecKit twin of the
             // standalone hook above: a continuation event on the SEPARATE
             // backstop firing ledger (state.backstopFirings via
             // recordBackstopFiring), never the continuation allowance:
             // consumeContinuation is NOT called here, so the extra_sessions
             // ledger is untouched and failure budgets are never reached. The
             // session already stopped via the orchestrator fallback-note path
             // (wrapUp orchestrator_fallback above), so the next generation
             // resumes from the fallback note + digest; no dead-end entry is
              // recorded (the fallback note carries the resume context).
              // Mission 047 Phase 1 task 1.3: the second consecutive firing
              // escalates as runaway_session_escalation with evidence (total
              // raw tokens, turns, largest single-turn context, both firings)
              // instead of starting a third session; the first firing always
              // continues below.
              if(taskImpl.capped.backstop===true||taskImpl.capped.type==="backstop"){
                const contScope=`task:speckit:phase-${s.phaseIndex}:${taskId}`;
                const firings=recordBackstopFiring(s,contScope,{generation:readBackstopFirings(s,contScope).length+1,totalRawTokens:taskImpl.capped.used,turns:Number.isInteger(taskImpl.usage?.turns)?taskImpl.usage.turns:null,maxSingleTurnContext:Number.isFinite(Number(taskImpl.usage?.maxSingleTurnContext))?Number(taskImpl.usage.maxSingleTurnContext):null});
                if(evaluateBackstopEscalation(firings).escalate){
                  const last=firings[firings.length-1]||{};
                  s.phase="escalated";s.step="runaway_session_escalation";
                  s.phaseCheckpointError={code:"BACKSTOP_CONSECUTIVE_FIRINGS",evidence:{taskId,totalRawTokens:last.totalRawTokens??taskImpl.capped.used,turns:last.turns??null,maxSingleTurnContext:last.maxSingleTurnContext??null,firings:[...firings]}};
                  s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
                  die(`SpecKit task ${taskId} fired the cumulative backstop twice in a row (${last.totalRawTokens??taskImpl.capped.used}/${taskImpl.capped.limit} cumulative raw tokens, ${last.turns??"?"} turns, largest single-turn context ${last.maxSingleTurnContext??"?"}). STOP — human intervention required.`);
                }
               s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
               stopOnNoProgress(s,c,{framework:"speckit",contScope,taskId,missionName:missionIdentity,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex),touchedFiles:taskImpl.touchedFiles,checkpoint});
               console.log(`Task ${taskId} crossed the cumulative backstop (${taskImpl.capped.used}/${taskImpl.capped.limit} cumulative raw tokens); wrap-up note: ${taskImpl.wrapUp?.status||"unknown"}${taskImpl.wrapUp?.reason?` (${taskImpl.wrapUp.reason})`:""}; continuing as backstop session ${firings.length+1}.`);
               continue;
             }
             // Backlog 003#15 (ceiling) + 003#17 (continuation), SpecKit twin
             // of the standalone hook above: breach continues, never fails.
            const contScope=`task:speckit:phase-${s.phaseIndex}:${taskId}`;
            // Mission 047 Phase 1 task 1.2: this generation ended WITHOUT a
            // backstop firing, so the consecutive-firing count resets (PLAN:
            // two CONSECUTIVE firings escalate — an interleaving ordinary
            // generation breaks the streak).
            clearBackstopFirings(s,contScope);
            // Backlog #27: a queued `ap reset --scope <continuation>` applies at
            // this decision, before the next generation is consumed.
            maybeApplyPendingContinuationReset(s,contScope);
            const cont=consumeContinuation(s,c.policy,contScope);
            let capFiles=[];
            try{
              capFiles=attributedChangedPaths(beforeMap,attributionMap(scopedDeltaChunks(repo,phaseBaselineKey)));
            }catch{}
            // Backlog #22: the handoff carries the decoded-events digest
            // (taskImpl.workDigest), never the raw finalMessage/output tail —
            // a capped session dies mid-tool-calls with no text event, so the
            // raw tail is a JSON-event fragment that starts the next session
            // blind. Empty digest degrades to the marker, never to raw bytes.
            recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:taskImpl.capped.type,used:taskImpl.capped.used,limit:taskImpl.capped.limit,tail:deadEndTail({files:capFiles,outputTail:taskImpl.workDigest?taskImpl.workDigest:"(no decoded activity)",maxChars:resolveHandoffMaxChars(c.policy)})});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            if(!cont.allowed){
              // Dead ends are deliberately NOT cleared here: per-task keys
              // cannot leak into another task, and the entries are the
              // post-mortem record of why this task never converged.
              s.phase="escalated";s.step="speckit_task_not_converging";
              s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{taskId,used:cont.used,limit:cont.limit,breach:taskImpl.capped.type}};
              // Backlog #27: record the continuation for bare `ap reset`, and
              // end with the exact resume command. Note + dead ends kept
              // (post-mortem record, like dead-ends).
              recordLastContinuation(s,{contScope,taskId,missionName:missionIdentity,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex)});
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
              die(`SpecKit task ${taskId} did not converge after ${cont.used} capped generations (${taskImpl.capped.type} cap ${taskImpl.capped.used}/${taskImpl.capped.limit}). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
            }
            stopOnNoProgress(s,c,{framework:"speckit",contScope,taskId,missionName:missionIdentity,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex),touchedFiles:taskImpl.touchedFiles,checkpoint});
            console.log(`Task ${taskId} hit the ${taskImpl.capped.type} cap (${taskImpl.capped.used}/${taskImpl.capped.limit} ${capUnitLabel(taskImpl.capped.type)}); wrap-up note: ${taskImpl.wrapUp?.status||"unknown"}${taskImpl.wrapUp?.reason?` (${taskImpl.wrapUp.reason})`:""}; continuing as session ${cont.used+1} of ${cont.limit+1}.`);
            continue;
          }
          // Mission 047 Phase 1 task 1.2: ended WITHOUT a backstop firing —
          // reset the consecutive-firing count (PLAN).
          if(taskImpl.status!=="completed") clearBackstopFirings(s,`task:speckit:phase-${s.phaseIndex}:${taskId}`);
          if(taskImpl.status!=="completed") break;
        const parsed=parseTaskResultContract(taskImpl.finalMessage??"");
        if(parsed.trailingNote) console.log(`Task ${taskId}: trailing text ignored after a valid result`);
        if(!parsed.ok){
          // 003#43, SpecKit twin of the standalone hook above: a
          // missing/malformed task-result sentinel retries the SAME task
          // under adapterRetryBudget. Parseable-but-invalid commits below
          // (speckit_task_commit_invalid) still escalate immediately.
            impl={...taskImpl,status:"failed",
            failure:failure(parsed.code,"adapter",true,[{source:"task-result",message:parsed.reason,taskId}])};
          // Mission 047 Phase 1 task 1.2: malformed-sentinel failure ended
          // WITHOUT a backstop firing — reset the consecutive count (PLAN).
          clearBackstopFirings(s,`task:speckit:phase-${s.phaseIndex}:${taskId}`);
          break;
        }
          if(parsed.taskLocalCheck.status==="attempted"){
            // Backlog: voluntary early stop, SpecKit twin of the standalone
            // hook above — continue on the continuation allowance, never
            // commit partial work, never review it.
            const contScope=`task:speckit:phase-${s.phaseIndex}:${taskId}`;
            // Mission 047 Phase 1 task 1.2: voluntary stop ended WITHOUT a
            // backstop firing — reset the consecutive-firing count (PLAN).
            clearBackstopFirings(s,contScope);
            // Backlog #27: a queued `ap reset --scope <continuation>` applies at
            // this decision, before the next generation is consumed.
            maybeApplyPendingContinuationReset(s,contScope);
            const cont=consumeContinuation(s,c.policy,contScope);
            let endedFiles=[];
            try{
              endedFiles=attributedChangedPaths(beforeMap,attributionMap(scopedDeltaChunks(repo,phaseBaselineKey)));
            }catch{}
            recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:"incomplete",used:null,limit:null,tail:deadEndTail({summary:parsed.summary,files:endedFiles})});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            if(!cont.allowed){
              // Dead ends are deliberately NOT cleared here: per-task keys
              // cannot leak into another task, and the entries are the
              // post-mortem record of why this task never converged.
              s.phase="escalated";s.step="speckit_task_not_converging";
              s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{taskId,used:cont.used,limit:cont.limit,stopped:"attempted"}};
              // Backlog #27: record the continuation for bare `ap reset`, and
              // end with the exact resume command. Note + dead ends kept
              // (post-mortem record, like dead-ends).
              recordLastContinuation(s,{contScope,taskId,missionName:missionIdentity,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex)});
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
              die(`SpecKit task ${taskId} did not converge after ${cont.used} generations (last generation stopped voluntarily with work remaining). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
            }
            stopOnNoProgress(s,c,{framework:"speckit",contScope,taskId,missionName:missionIdentity,taskRef:taskDisplayRef(phaseTasks[taskIndex],taskIndex),touchedFiles:taskImpl.touchedFiles,checkpoint});
            console.log(`Task ${taskId} stopped voluntarily with work remaining; continuing as session ${cont.used+1} of ${cont.limit+1}.`);
            continue;
          }
          let afterMap;
        try{ afterMap=attributionMap(scopedDeltaChunks(repo,phaseBaselineKey)); }
        catch(e){
          s.phase="escalated";s.step="speckit_delta_mismatch";
          s.phaseCheckpointError={code:e?.code||"DELTA_COMPUTATION_FAILED",evidence:{message:e?.message||String(e)}};
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          die(`SpecKit task attribution failed after task ${taskIndex+1}: ${e?.message||e}. STOP — human intervention required.`);
        }
        const attributed=attributedChangedPaths(beforeMap,afterMap);
        const normalized={role:"implementer",runId:expectedRunId,revision:checkpoint.revision,phaseTaskDigest:phaseTaskDigestValue,taskId,status:"completed",facts:{summary:parsed.summary,files:attributed,taskLocalCheck:parsed.taskLocalCheck,...(parsed.trailingNote?{trailingNote:parsed.trailingNote}:{})}};
        const committed=commitTaskResult({progress:checkpoint.roleProgress,expected:prep.expected,result:normalized});
        if(!committed.ok){
          s.phase="escalated";s.step="speckit_task_commit_invalid";
          s.phaseCheckpointError={code:committed.code,reason:committed.reason,evidence:committed.evidence};
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          die(`SpecKit Implementer task commit failed: ${committed.reason}. STOP — human intervention required.`);
        }
          checkpoint.roleProgress=committed.progress;
          // Backlog 003#17: task converged — its continuation allowance and
          // dead ends die with it, never leaking into the next task.
          clearTaskContinuation(s,`task:speckit:phase-${s.phaseIndex}:${taskId}`);
          clearRolloverDeadEnds(s,`task:speckit:phase-${s.phaseIndex}:${taskId}`);
          clearBackstopFirings(s,`task:speckit:phase-${s.phaseIndex}:${taskId}`);
          // Backlog #26 Step A: the task converged — its hand-off note dies
          // with it, so a later retry of a DIFFERENT attempt never inherits a
          // stale note. Best-effort; kept on escalation (post-mortem).
          // Backlog #26 Step B: its session store dies with it too (size
          // logged first, warn above 50MB; kept on escalation, like the note).
          logSessionStoreSize(missionIdentity,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
          clearSessionStore(missionIdentity,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
          clearHandoffNote(missionIdentity,taskDisplayRef(phaseTasks[taskIndex],taskIndex));
          clearLastContinuation(s,`task:speckit:phase-${s.phaseIndex}:${taskId}`);
          const workAhead=detectWorkAhead(attributed,phaseTasks,taskIndex);
        if(workAhead.paths.length){
          checkpoint.roleProgressWorkAhead=[...(checkpoint.roleProgressWorkAhead??[]),{taskId,workAhead:workAhead.tasks}];
        }
        s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
      }
      // TASK-21: `impl` is whatever the last REAL launch set — carried tasks
      // never touch it, so checkpoint.implementer.summary (which the next
      // code-review handoff shows) comes only from the last real launch, not
      // from the carried tasks. That is correct: the reviewer should hear
      // about the fix. `impl === null` here would mean EVERY task was
      // carried, which cannot happen: a FAIL with allMapped:true always
      // names at least one task (an empty or unattributable finding list
      // fails allMapped closed), that task has no carry entry, so at least
      // one task always runs and sets `impl`.
      lastImpl=impl;

      // Reconcile BEFORE any other decision is made about this attempt —
      // the policy-violation check, Code Review, gate/Verifier handling,
      // retry, and escalation below must never observe or act on whatever
      // the Implementer wrote to ANY task's checkbox, in this phase or a
      // future one. Identity-validated and fail-closed: a mismatch means a
      // task line changed in an unexpected way and must stop the mission
      // rather than silently paper over it.
      const reconciled=applyTaskCheckboxStates(preAttemptTasks);
      // Mission 084 Phase 2 task 2.4 — SpecKit checkbox write invalidates
      // the snapshot reuse cache (scenario b): the reconcile above rewrites
      // tracked tasks.md checkboxes the Implementer may have touched.
      try{
        clearSnapshotReuseCache("orchestrator tracked write");
        console.log(`[snapshot-reuse] cache cleared: orchestrator tracked write`);
      }catch(error){
        console.log(`[snapshot-reuse] cache clear skipped (${error?.message||error})`);
      }
      if(!reconciled.ok){
        s.phase="escalated";s.step="task_marking_failed";s.taskMarkingError=reconciled.reason;saveState(s);
        die(`SpecKit task checkbox validation failed while neutralizing a premature edit: ${reconciled.reason}. STOP — human intervention required.`);
      }
      delete s.pendingCheckboxSnapshot;saveState(s);

      if(impl&&impl.policyViolation){
        s.phase="escalated";s.step="relay_policy_violation";s.relayPolicyViolation=impl.policyViolation;saveState(s);
        die(formatRelayPolicyViolation(s.relayPolicyViolation, impl.touchedFiles));
      }

      if(impl&&impl.status!=="completed"){
        // Infrastructure/adapter interruption: keep nextStage implementer
        // and carry the partial delta forward untouched — never treat it
        // as drift, never rerun planning. The cursor was left on the
        // interrupted task by the loop, so the retry resumes there.
        const recorded=enforceAttemptFailure(c,s,`speckit:${phase.name}`,[impl],{ok:true});
        checkpoint=applyCheckpointTransition(decideTransition(checkpoint,recorded));
        s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        continue;
      }

      // TASK 15.6F: git-invisible phase guard. A successfully completed
      // Implementer attempt whose CUMULATIVE phase delta is git-empty while
      // the worktree itself changed (e.g. an empty directory, which Git
      // cannot represent) can never be code-reviewed on merits, and a
      // disposable-copy Verifier could never observe it either — the real
      // incident burned five attempts and three verification budget units
      // this way. Stop at this FIRST such attempt: no Code Reviewer, no
      // Verifier, no failure budget consumed, no checkbox marked, no
      // silent skip. A fully quiescent attempt (nothing changed at any
      // level) proceeds exactly as before, as does any attempt with a
      // non-empty cumulative delta (including later attempts building on
      // an earlier attempt's visible work). A scopedDelta/list failure
      // degrades to "proceed as before" — the guard fires only on
      // positive evidence, never on an unreadable signal.
      if(impl.status==="completed" && !impl.policyViolation){
        let phaseDeltaEmpty=false;
        try{ phaseDeltaEmpty=scopedDelta(repo,phaseBaselineKey).trim()===""; }
        catch{ phaseDeltaEmpty=false; }
        if(phaseDeltaEmpty){
          let attemptChanged=false;
          try{ attemptChanged=attemptFsBefore!==null && JSON.stringify(attemptFsBefore)!==JSON.stringify(listWorktreeEntries(repo)); }
          catch{ attemptChanged=false; }
          if(attemptChanged){
            const ids=phaseTasks.map(t=>{
              let rel=t.file;
              try{ rel=path.relative(repo,t.file).replaceAll("\\","/"); }catch{ /* absolute fallback below */ }
              return `${rel}:${t.line}`;
            }).join("; ");
            s.phase="escalated";s.step="git_invisible_phase";
            s.gitInvisiblePhase={phase:phase.name,tasks:phaseTasks.map(t=>({file:t.file,line:t.line,text:t.text})),at:now()};
            saveState(s);
            die(`SpecKit phase '${phase.name}' completed with no Git-observable change although the worktree changed (e.g. an empty directory, which Git cannot represent): GIT_INVISIBLE_PHASE. Phase tasks: ${ids}. STOP — human intervention required.`);
          }
        }
      }

      // Completed, policy-clean implementation: record the approval
      // evidence (bounded summary, run ID, full delta digest) and advance
      // to Code Reviewer.
      let fullDelta;
      try{
        fullDelta=scopedDelta(repo,phaseBaselineKey);
      }catch(e){
        s.phase="escalated";s.step="speckit_delta_mismatch";
        s.phaseCheckpointError={code:e?.code||"DELTA_COMPUTATION_FAILED",evidence:{message:e?.message||String(e)}};
        saveState(s);
        die(`SpecKit phase delta could not be computed after implementation: ${e?.message||e}. STOP — human intervention required.`);
      }
      {
        const transition=decideTransition(checkpoint,{stage:"implementer",status:"completed",runId:impl?.sessionId??null,summary:sanitizeSummary(impl?.finalMessage??checkpoint.implementer?.summary??""),deltaDigest:deltaDigest(fullDelta)});
        checkpoint=applyCheckpointTransition(transition);
        checkpoint.deltaDigest=transition.deltaDigest;
        checkpoint.implementer={runId:transition.runId,summary:transition.summary};
        s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
      }
      continue;
      }

      // Code Review gates Verification: no gate command or Verifier may run
      // until Code Review has returned PASS.
      if(stage==="code_reviewer"){
        if(checkpoint.attempts.code_reviewer>0){ s.attempt+=1;saveState(s);await maybeRetryPause(c,s,checkpoint,"code_reviewer"); }
        s.step="code_review";checkpoint.runningStage="code_reviewer";s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        // TASK-23: snapshot the tree at the start of EVERY code review, so
        // the next review (if this one FAILs) can diff only the fix's
        // changes. Idempotent — an infra retry or crash-resume of the same
        // review never re-snapshots. Same opts as phaseBaselineKey (none).
        const reviewKey=`${phaseBaselineKey}-review-r${checkpoint.revision}`;
        ensureBaseline(repo,reviewKey);
        // A re-review sees only the findings that caused the fix (already in
        // `feedback`) plus the fix diff: everything that changed since the
        // previous revision's review snapshot. Missing snapshot (older
        // mission, hand-deleted) falls back to today's whole-phase review.
        // Never guess.
        const prevReviewKey=`${phaseBaselineKey}-review-r${checkpoint.revision-1}`;
        const fixChunks=(checkpoint.revision>1&&hasBaseline(repo,prevReviewKey))
          ? scopedDeltaChunks(repo,prevReviewKey) : null;
        let reviewPrompt;
        if(fixChunks){
          const phaseFiles=scopedDeltaChunks(repo,phaseBaselineKey).map(c=>c.path);
          const sortedPhaseFiles=[...new Set(phaseFiles.filter(Boolean))].sort();
          const fixBody=fixChunks.map(c=>c.text).join("\n")||"The fix changed no files.";
          reviewPrompt=`Re-review after a fix. Your previous findings are listed under FEEDBACK TO ADDRESS. For each one, confirm it is fixed or still stands. Then review ONLY the changes below — they are everything that changed since your last review — for new problems or regressions. Code outside these changes was already reviewed; do not re-review it, but you may read any file for context.\nPhase: ${phase.name}\n\nTasks:\n${scope}\n\nChanged files in this phase so far: ${sortedPhaseFiles.length?sortedPhaseFiles.join(", "):"none"}\n\nChanges since your last review (everything the fix changed — review ONLY this diff for new problems or regressions):\n${scopedDeltaBeginMarker("FIX")}\n${fixBody}\n${SCOPED_DELTA_END_MARKER}`;
        }else{
          reviewPrompt=`Review the whole phase (all tasks together) — not task by task.\nPhase: ${phase.name}\n\nTasks:\n${scope}\n\nScoped implementation delta for THIS PHASE only (pre-existing repository changes made before this mission started, and changes from earlier phases, are excluded — do not evaluate or flag anything outside this delta; an empty delta means this phase made no repository changes):\n${scopedDeltaBeginMarker("PHASE")}\n${speckitBoundedDelta(repo,phaseBaselineKey,"PHASE_REVIEW")}\n${SCOPED_DELTA_END_MARKER}`;
        }
        // Mission 066 task 1.3, SpecKit twin: security checklist rides the
        // phase code-review prompt for both fresh reviews and re-reviews
        // (fixChunks). Unconditional, alongside the durations/no-parallel
        // sections below. Explicit repo root — absent/unreadable yields the
        // generic section, never throws.
        reviewPrompt+=`\n\n${buildSecurityChecklistSection(repo)}`;
        // Mission 025 phase 4 task 4.2, SpecKit twin: the reviewer runs
        // before the phase gate, so per-linked-test durations come from the
        // persisted gate history (prior rounds), with the explicit
        // unmeasured fallback when no sample exists yet.
        {
          const reviewDurations=formatLinkedTestDurations(linkedVerifyCommandsForPhase(phaseTasks,c?.gates?.commands),resolveGateDurations(null,s?.gateDurations));
          if(reviewDurations) reviewPrompt+=`\n\n${reviewDurations}`;
          const heavyNoParallel=formatHeavySuiteNoParallelNote();
          if(heavyNoParallel) reviewPrompt+=`\n\n${heavyNoParallel}`;
        }
        // Mission 063 task 1.4, SpecKit twin: recorded operator phase edits
        // (`ap rebase`) ride the reviewer prompt once, then clear so a later
        // review does not repeat them. Cleared only when included.
        { const operatorEditsSection=formatOperatorPhaseEdits(s.operatorPhaseEdits);
          if(operatorEditsSection) reviewPrompt+=`\n\n${operatorEditsSection}`;
          if(operatorEditsSection){ delete s.operatorPhaseEdits; saveState(s); } }
        const reviewIds=stableTaskIds({framework:"speckit",mission:missionIdentity,phaseIndex:s.phaseIndex,phaseNumber:s.phaseIndex+1,phaseName:phase.name,tasks:taskIdentities(),repoRoot:repo});
        // TASK-26, SpecKit twin: the reviewer gets a measured kill deadline
        // and is told it.
        const reviewBudget=roleDeadline(c,s,"code_reviewer");
        const reviewRef=reviewTaskRef(s,speckitPhaseFeedbackKey(s.phaseIndex),phaseTasks,reviewIds,checkpoint.revision,!!fixChunks);
        const reviewDeadEnds=readRolloverDeadEnds(s, `task:speckit:phase-${s.phaseIndex}:code_reviewer`);
        const reviewHandoffNote=readHandoffNote(missionIdentity, reviewRef);
        const reviewDeadEndsText=reviewDeadEnds.length?`Prior dead ends (continuation context — do not retry blindly):\n${reviewDeadEnds.map((d)=>`- Generation ${d.generation} (${d.reason} ${d.used}/${d.limit}): ${d.tail}`).join("\n")}`:"";
        const reviewHandoffNoteText=reviewHandoffNote?`Prior reviewer handoff note (continuation context — continue from where it stopped):\n${reviewHandoffNote}`:"";
        const scratchNote=unexpectedNewFilesReviewNote(phaseTasks.map((t)=>`${t.text||""} ${t.file||""}`).join("\n"));
        const rv=await review("code_reviewer",
          `${reviewPrompt}\n\n${scratchNote?`${scratchNote}\n\n`:""}${reviewDeadEndsText}\n\n${reviewHandoffNoteText}\n\n${operatorPhaseNoteLine(s)?`${operatorPhaseNoteLine(s)}\n\n`:""}${reviewBudget.note}\n${readOnlyHandoffNoteReminder({mission: missionIdentity, ref: reviewRef, noteLimit: resolveHandoffNoteMaxChars(c.policy)})}`,
          c,s,feedback,phaseRequirements,reviewRef,reviewBudget.timeoutMs,true,codeReviewScopeKey("speckit-phase",s.phaseIndex));
        noteRoleDeadlineOutcome(s,"code_reviewer",rv,reviewBudget.derived);
        lastReview=rv;
        if(rv.policyViolation){
          s.phase="escalated";s.step="relay_policy_violation";s.relayPolicyViolation=rv.policyViolation;saveState(s);
          die(formatRelayPolicyViolation(s.relayPolicyViolation, rv.touchedFiles));
        }
        if(rv.capped){
          // Mission 031 Phase 5 task 5.1: a SpecKit code_reviewer cap
          // breach is a continuation event, never a failure — failure
          // budgets are untouched on this path. Consume one continuation
          // generation on the per-phase code_reviewer scope and record the
          // dead end; `continue` retries the review stage against the same
          // unchanged phase diff. Exhausted allowance escalates as
          // not-converging. Read-only role: no file attribution — the
          // summary states the resume point, files stay empty.
          const contScope=`task:speckit:phase-${s.phaseIndex}:code_reviewer`;
          // Backlog #59 part (a): cumulative raw-token backstop rollover for
          // the code_reviewer, BEFORE the cap path below — a continuation
          // event on the SEPARATE backstop firing ledger, never the
          // continuation allowance.
          if(rv.capped.backstop===true||rv.capped.type==="backstop"){
            const backstop=handleRoleBackstopFiring(s,contScope,rv);
            if(backstop.escalate){
              const last=backstop.last;
              s.phase="escalated";s.step="runaway_session_escalation";
              s.phaseCheckpointError={code:"BACKSTOP_CONSECUTIVE_FIRINGS",evidence:{role:"code_reviewer",totalRawTokens:last.totalRawTokens??rv.capped.used,turns:last.turns??null,maxSingleTurnContext:last.maxSingleTurnContext??null,firings:[...backstop.firings]}};
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
              die(`SpecKit code reviewer fired the cumulative backstop twice in a row (${last.totalRawTokens??rv.capped.used}/${rv.capped.limit} cumulative raw tokens, ${last.turns??"?"} turns, largest single-turn context ${last.maxSingleTurnContext??"?"}). STOP — human intervention required.`);
            }
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            console.log(`Code reviewer crossed the cumulative backstop (${rv.capped.used}/${rv.capped.limit} cumulative raw tokens); continuing as backstop session ${backstop.firings.length+1}.`);
            continue;
          }
          // This generation ended WITHOUT a backstop firing, so the
          // consecutive-firing count resets (PLAN).
          clearBackstopFirings(s,contScope);
          // Backlog #27: a queued `ap reset --scope <continuation>` applies at
          // this decision, before the next generation is consumed.
          maybeApplyPendingContinuationReset(s,contScope);
          const cont=consumeContinuation(s,c.policy,contScope,resolvePerRoleLimits('code_reviewer',c.policy).continuationAllowance);
          recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:rv.capped.type,used:rv.capped.used,limit:rv.capped.limit,tail:deadEndTail({summary:`Code review capped (${rv.capped.type} ${rv.capped.used}/${rv.capped.limit}); phase diff unchanged — re-review the same phase diff.`,files:[]})});
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          if(!cont.allowed){
            // Dead ends are deliberately NOT cleared here: per-phase keys
            // cannot leak into another phase, and the entries are the
            // post-mortem record of why this phase never converged.
            s.phase="escalated";s.step="speckit_task_not_converging";
            s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{role:"code_reviewer",used:cont.used,limit:cont.limit,breach:rv.capped.type}};
            // Backlog #27: record the continuation for bare `ap reset`, and
            // end with the exact resume command.
            recordLastContinuation(s,{contScope,taskId:null,missionName:missionIdentity,taskRef:reviewRef});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
             die(`SpecKit code review did not converge after ${cont.used} capped generations (${rv.capped.type} cap ${rv.capped.used}/${rv.capped.limit}). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
            }
             console.log(`SpecKit code review hit the ${rv.capped.type} cap (${rv.capped.used}/${rv.capped.limit} ${capUnitLabel(rv.capped.type)}); continuing as session ${cont.used+1} of ${cont.limit+1}.`);
          continue;
        }
        // Backlog #59 part (a): the code_reviewer run ended WITHOUT a
        // backstop firing (normal completion, or the voluntary incomplete
        // stop below) — reset the consecutive-firing count.
        clearBackstopFirings(s,`task:speckit:phase-${s.phaseIndex}:code_reviewer`);
        if(parseIncompleteSignal(rv.review ?? rv)){
          // Mission 031 Phase 5 task 5.3: voluntary early stop (INCOMPLETE
          // decision or non-empty Next section) is a continuation event,
          // never a failure — INCOMPLETE skips FAIL/failure-budget handling
          // and routes here. Consume one continuation generation on the
          // per-phase code_reviewer scope and record the dead end with
          // reason "incomplete"; `continue` retries the review stage.
          // Exhausted allowance escalates as not-converging. Read-only
          // role: no file attribution — files stay empty.
          const contScope=`task:speckit:phase-${s.phaseIndex}:code_reviewer`;
          // Backlog #27: a queued `ap reset --scope <continuation>` applies at
          // this decision, before the next generation is consumed.
          maybeApplyPendingContinuationReset(s,contScope);
          const cont=consumeContinuation(s,c.policy,contScope,resolvePerRoleLimits('code_reviewer',c.policy).continuationAllowance);
          recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:"incomplete",used:null,limit:null,tail:deadEndTail({summary:`Code review incomplete (${rv.review?.decision ?? "INCOMPLETE"}); phase diff unchanged — re-review the same phase diff.`,files:[]})});
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          if(!cont.allowed){
            // Dead ends are deliberately NOT cleared here: per-phase keys
            // cannot leak into another phase, and the entries are the
            // post-mortem record of why this phase never converged.
            s.phase="escalated";s.step="speckit_task_not_converging";
            s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{role:"code_reviewer",used:cont.used,limit:cont.limit,stopped:"incomplete"}};
            // Backlog #27: record the continuation for bare `ap reset`, and
            // end with the exact resume command.
            recordLastContinuation(s,{contScope,taskId:null,missionName:missionIdentity,taskRef:reviewRef});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
             die(`SpecKit code review did not converge after ${cont.used} generations (last generation stopped voluntarily as incomplete). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
            }
            console.log(`SpecKit code review stopped voluntarily as incomplete; continuing as session ${cont.used+1} of ${cont.limit+1}.`);
          continue;
        }
        if(rv.status==="completed"&&rv.review?.decision==="PASS"){
          // Mission 025 task 3.1: never accept a SpecKit reviewer PASS
          // while any linked verify/tool result exited non-zero or 124. The
          // reviewer's own observed tool calls are the evidence channel here
          // (phase gates run later, at the verifier stage): a failed or
          // timed-out tool result routes to feedback/retry, never to PASS.
          // Only commands matching a linked task verify or gate command
          // count — inspection commands (grep/test/git diff) never refuse.
          const toolRefusal=shouldRefusePassForEvidence({gateResults:[],toolResults:reviewerLinkedToolResults(rv,linkedVerifyCommandsForPhase(phaseTasks,c?.gates?.commands))});
          if(toolRefusal?.refuse===true){
            const toolReason=toolRefusal.reason==="timed-out"?"timed out":"failed";
            const toolCommand=toolRefusal.command?` \`${String(toolRefusal.command).slice(0,200)}\``:"";
            const toolExit=toolRefusal.exitCode ?? toolRefusal.status ?? "unknown";
            const refusalFindings=[`Reviewer PASS refused: linked verify/tool result${toolCommand} ${toolReason} (exit ${toolExit}). Re-verify the work after addressing the failure instead of passing.`];
            feedback=feedbackText(saveReviewFeedback(s,speckitPhaseFeedbackKey(s.phaseIndex),refusalFindings))||"Implementation/code review failed.";
            recordPhaseFindingTasks(speckitPhaseFeedbackKey(s.phaseIndex),refusalFindings,true);recordCodeReviewRound(s,codeReviewScopeKey("speckit-phase",s.phaseIndex),refusalFindings,rv.review?.previous);
            {
              const recorded=enforceAttemptFailure(c,s,`speckit:${phase.name}`,lastImpl?[lastImpl,{...rv,failure:failure("IMPLEMENTATION_REJECTED","implementation",true,refusalFindings)}]:[{...rv,failure:failure("IMPLEMENTATION_REJECTED","implementation",true,refusalFindings)}],{ok:true});
              checkpoint=applyCheckpointTransition(decideTransition(checkpoint,recorded));
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            }
            continue;
          }
          clearCodeReviewHistory(s,codeReviewScopeKey("speckit-phase",s.phaseIndex));const transition=decideTransition(checkpoint,{stage:"code_reviewer",status:"completed",decision:"PASS",runId:rv.sessionId??null,findings:rv.review?.findings??[]});
          checkpoint=applyCheckpointTransition(transition);
          checkpoint.codeReviewer={runId:rv.sessionId??null,decision:"PASS",findings:rv.review?.findings??[]};
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          continue;
        }
        if(rv.status==="completed"){
          // Functional FAIL: the findings feed the Implementer retry, and
          // the stored approval is invalidated via the transition.
          feedback=feedbackText(saveReviewFeedback(s,speckitPhaseFeedbackKey(s.phaseIndex),rv.review?.findings||[]))||"Implementation/code review failed.";
          // TASK-20 step 1: record the finding→task map before the transition
          // below wipes roleProgress. The wipe itself is unchanged; TASK-21
          // step 2 replays the unflagged tasks' facts on the retry instead.
          recordPhaseFindingTasks(speckitPhaseFeedbackKey(s.phaseIndex),rawReviewFindings(rv),true);recordCodeReviewRound(s,codeReviewScopeKey("speckit-phase",s.phaseIndex),rv.review?.findings||[],rv.review?.previous);noteEscalationTrigger(s,c,"implementer",codeReviewScopeKey("speckit-phase",s.phaseIndex),"code_reviewer",rv.review?.previous);
        }
        // Infrastructure interruption or functional rejection: the split is
        // read off enforceAttemptFailure()'s return value — retry only the
        // Reviewer on infra, return to the Implementer on rejection.
        {
          const recorded=enforceAttemptFailure(c,s,`speckit:${phase.name}`,lastImpl?[lastImpl,rv]:[rv],{ok:true});
          checkpoint=applyCheckpointTransition(decideTransition(checkpoint,recorded));
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        }
        continue;
      }

      // Only after Code Review PASS: run configured gates and the Verifier.
      if(stage==="verifier"){
        if(checkpoint.attempts.verifier>0){ s.attempt+=1;saveState(s);await maybeRetryPause(c,s,checkpoint,"verifier"); }
        s.step="verify";checkpoint.runningStage="verifier";s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        let g;
        let preGateCacheKey=null;
        try{
          preGateCacheKey=deltaDigest(scopedDelta(repo,phaseBaselineKey))+"|"+deltaDigest(JSON.stringify(c.gates.commands||[]));
        }catch(e){
          s.phase="escalated";s.step="speckit_delta_mismatch";
          s.phaseCheckpointError={code:e?.code||"DELTA_COMPUTATION_FAILED",evidence:{message:e?.message||String(e)}};
          saveState(s);
          die(`SpecKit phase delta could not be computed before gates: ${e?.message||e}. STOP — human intervention required.`);
        }
        {
          const stashedGate=preGateCacheKey?takeContinuationGateResult(checkpoint,preGateCacheKey):null;
          // Backlog #105: the last recorded gate result (pass OR fail) is reused
          // whenever the digest key is unchanged — verifier infra retry, resume.
          const lastGate=preGateCacheKey?getLastGateResult(checkpoint,lastGateKeyOf(preGateCacheKey,c)):null;
          if(stashedGate){g=stashedGate;}else{
          const cached=preGateCacheKey?getCachedGateResult(checkpoint,preGateCacheKey):null;
          if(lastGate){
            g=lastGate;
            console.log("gate result reused (digest unchanged)");noteGateReused(s,g);
          }else if(cached&&cached.ok===true){
            g=cached;
            console.log("gate result reused (digest unchanged)");noteGateReused(s,g);
          }else{
            g=await gates(c,s);
            if(g.ok===true){
              setCachedGateResult(checkpoint,preGateCacheKey,g);
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            }
          }
          }
        }
        // Gates run before the Verifier and may write files (coverage
        // reports, markers): re-record the full delta AFTER gates pass so
        // the Verifier reviews — and the checkpoint records — the same tree
        // the approval will later be consumed against. Without this refresh
        // the mark_tasks gate would compare a pre-gate record against a
        // post-gate tree and drift-escalate on every file-writing gate. A
        // crash mid-gate still fails closed at the next gate check (partial
        // gate outputs are unapproved changes). This is evidence refresh,
        // not a transition: stage, revision, and attempts are untouched.
        try{
          checkpoint.deltaDigest=deltaDigest(scopedDelta(repo,phaseBaselineKey));
          if(g.ok===true){
            setCachedGateResult(checkpoint,checkpoint.deltaDigest+"|"+deltaDigest(JSON.stringify(c.gates.commands||[])),g);
          }
          recordLastGateResult(checkpoint,lastGateKeyOf(checkpoint.deltaDigest+"|"+deltaDigest(JSON.stringify(c.gates.commands||[])),c),g);
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        }catch(e){
          s.phase="escalated";s.step="speckit_delta_mismatch";
          s.phaseCheckpointError={code:e?.code||"DELTA_COMPUTATION_FAILED",evidence:{message:e?.message||String(e)}};
          saveState(s);
          die(`SpecKit phase delta could not be recomputed after gates: ${e?.message||e}. STOP — human intervention required.`);
        }
        // TASK-26, SpecKit twin: the verifier gets a measured kill deadline
        // and is told it.
        const verifyBudget=roleDeadline(c,s,"verifier");
        const gateSection=(c.gates?.commands||[]).length?formatGateResult(g):"";
        // Mission 025 phase 4 task 4.2, SpecKit twin: per-linked-test
        // durations from the just-run gate over the persisted history.
        const verifyDurations=formatLinkedTestDurations(linkedVerifyCommandsForPhase(phaseTasks,c?.gates?.commands),resolveGateDurations(g,s?.gateDurations));
        const heavyNoParallelVerify=formatHeavySuiteNoParallelNote();
        const verifyRef=allPhaseTaskRef(phaseTasks);
        const verifyDeadEnds=readRolloverDeadEnds(s, `task:speckit:phase-${s.phaseIndex}:verifier`);
        const verifyHandoffNote=readHandoffNote(missionIdentity, verifyRef);
        const verifyDeadEndsText=verifyDeadEnds.length?`Prior dead ends (continuation context — do not retry blindly):\n${verifyDeadEnds.map((d)=>`- Generation ${d.generation} (${d.reason} ${d.used}/${d.limit}): ${d.tail}`).join("\n")}`:"";
        const verifyHandoffNoteText=verifyHandoffNote?`Prior verifier handoff note (continuation context — continue from where it stopped):\n${verifyHandoffNote}`:"";
        const vv=await relayAsync("verifier",
          `${`Verify this phase after implementation and code review.${gateSection?" The full test suite already ran as the phase gate; review the recorded gate result below — do not re-run it.":""}\nPhase: ${phase.name}\n\nTasks:\n${scope}\n\nScoped implementation delta for THIS PHASE only (pre-existing repository changes made before this mission started, and changes from earlier phases, are excluded — do not evaluate or flag anything outside this delta; an empty delta means this phase made no repository changes):\n${scopedDeltaBeginMarker("PHASE")}\n${speckitBoundedDelta(repo,phaseBaselineKey,"PHASE_REVIEW")}\n${SCOPED_DELTA_END_MARKER}`}${gateSection?`\n\n${gateSection}`:""}${verifyDurations?`\n\n${verifyDurations}`:""}${heavyNoParallelVerify?`
\n\n${heavyNoParallelVerify}`:""}\n\n${verifyDeadEndsText}\n\n${verifyHandoffNoteText}\n\n${verifyBudget.note}\n${verifierRoundLines(s,codeReviewScopeKey("speckit-phase",s.phaseIndex)).join("\n")}\n${readOnlyHandoffNoteReminder({mission: missionIdentity, ref: verifyRef, noteLimit: resolveHandoffNoteMaxChars(c.policy)})}`,
          c,s,{readOnly:true,review:true,requirements:phaseRequirements,taskRef:verifyRef,timeoutMs:verifyBudget.timeoutMs,capEnabled:true});
        noteRoleDeadlineOutcome(s,"verifier",vv,verifyBudget.derived);
        {
          // Backlog #91: a red phase gate forces the recorded verdict to FAIL.
          const ov=applyRedGateOverride(vv.review,g,phaseTasks);
          if(ov.review!==vv.review){
            vv.review=ov.review;
            if(ov.overridden){
              persistRedGateOverride(runsDirFor(s),vv.run_id,ov.review);
              vv.verdictOverride="red_gate";
              console.log("Verifier verdict overridden PASS -> FAIL: phase gate is red (verdictOverride=red_gate).");
            }
          }
        }
        if(vv.policyViolation){
          s.phase="escalated";s.step="relay_policy_violation";s.relayPolicyViolation=vv.policyViolation;saveState(s);
          die(formatRelayPolicyViolation(s.relayPolicyViolation, vv.touchedFiles));
        }
        if(vv.capped){
          // Mission 031 Phase 5 task 5.2: a SpecKit verifier cap
          // breach is a continuation event, never a failure — failure
          // budgets are untouched on this path. Consume one continuation
          // generation on the per-phase verifier scope and record the
          // dead end; `continue` retries the verifier stage against the
          // same unchanged phase diff. Exhausted allowance escalates as
          // not-converging. Read-only role: no file attribution — the
          // summary states the resume point, files stay empty.
          const contScope=`task:speckit:phase-${s.phaseIndex}:verifier`;
          // Backlog #59 part (a): cumulative raw-token backstop rollover for
          // the verifier, BEFORE the cap path below — a continuation event
          // on the SEPARATE backstop firing ledger, never the continuation
          // allowance.
          if(vv.capped.backstop===true||vv.capped.type==="backstop"){
            const backstop=handleRoleBackstopFiring(s,contScope,vv);
            if(backstop.escalate){
              const last=backstop.last;
              s.phase="escalated";s.step="runaway_session_escalation";
              s.phaseCheckpointError={code:"BACKSTOP_CONSECUTIVE_FIRINGS",evidence:{role:"verifier",totalRawTokens:last.totalRawTokens??vv.capped.used,turns:last.turns??null,maxSingleTurnContext:last.maxSingleTurnContext??null,firings:[...backstop.firings]}};
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
              die(`SpecKit verifier fired the cumulative backstop twice in a row (${last.totalRawTokens??vv.capped.used}/${vv.capped.limit} cumulative raw tokens, ${last.turns??"?"} turns, largest single-turn context ${last.maxSingleTurnContext??"?"}). STOP — human intervention required.`);
            }
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            recordContinuationGateResult(checkpoint,preGateCacheKey,g);
            console.log(`Verifier crossed the cumulative backstop (${vv.capped.used}/${vv.capped.limit} cumulative raw tokens); continuing as backstop session ${backstop.firings.length+1}.`);
            continue;
          }
          // This generation ended WITHOUT a backstop firing, so the
          // consecutive-firing count resets (PLAN).
          clearBackstopFirings(s,contScope);
          // Backlog #27: a queued `ap reset --scope <continuation>` applies at
          // this decision, before the next generation is consumed.
          maybeApplyPendingContinuationReset(s,contScope);
          const cont=consumeContinuation(s,c.policy,contScope,resolvePerRoleLimits('verifier',c.policy).continuationAllowance);
          recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:vv.capped.type,used:vv.capped.used,limit:vv.capped.limit,tail:deadEndTail({summary:`Verification capped (${vv.capped.type} ${vv.capped.used}/${vv.capped.limit}); phase diff unchanged — re-verify the same phase diff.`,files:[]})});
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          if(!cont.allowed){
            // Dead ends are deliberately NOT cleared here: per-phase keys
            // cannot leak into another phase, and the entries are the
            // post-mortem record of why this phase never converged.
            s.phase="escalated";s.step="speckit_task_not_converging";
            s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{role:"verifier",used:cont.used,limit:cont.limit,breach:vv.capped.type}};
            // Backlog #27: record the continuation for bare `ap reset`, and
            // end with the exact resume command.
            recordLastContinuation(s,{contScope,taskId:null,missionName:missionIdentity,taskRef:verifyRef});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
             die(`SpecKit verification did not converge after ${cont.used} capped generations (${vv.capped.type} cap ${vv.capped.used}/${vv.capped.limit}). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
            }
             recordContinuationGateResult(checkpoint,preGateCacheKey,g);
             console.log(`SpecKit verification hit the ${vv.capped.type} cap (${vv.capped.used}/${vv.capped.limit} ${capUnitLabel(vv.capped.type)}); continuing as session ${cont.used+1} of ${cont.limit+1}.`);
           continue;
        }
        // Backlog #59 part (a): the verifier run ended WITHOUT a backstop
        // firing (normal completion, or the voluntary incomplete stop
        // below) — reset the consecutive-firing count.
        clearBackstopFirings(s,`task:speckit:phase-${s.phaseIndex}:verifier`);
        if(parseIncompleteSignal(vv.review ?? vv)){
          // Mission 031 Phase 5 task 5.3: voluntary early stop (INCOMPLETE
          // decision or non-empty Next section) is a continuation event,
          // never a failure — INCOMPLETE skips FAIL/failure-budget handling
          // and routes here. Consume one continuation generation on the
          // per-phase verifier scope and record the dead end with reason
          // "incomplete"; `continue` retries the verifier stage. Exhausted
          // allowance escalates as not-converging. Read-only role: no file
          // attribution — files stay empty.
          const contScope=`task:speckit:phase-${s.phaseIndex}:verifier`;
          // Backlog #27: a queued `ap reset --scope <continuation>` applies at
          // this decision, before the next generation is consumed.
          maybeApplyPendingContinuationReset(s,contScope);
          const cont=consumeContinuation(s,c.policy,contScope,resolvePerRoleLimits('verifier',c.policy).continuationAllowance);
          recordRolloverDeadEnd(s,contScope,{generation:cont.used,reason:"incomplete",used:null,limit:null,tail:deadEndTail({summary:`Verification incomplete (${vv.review?.decision ?? "INCOMPLETE"}); phase diff unchanged — re-verify the same phase diff.`,files:[]})});
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          if(!cont.allowed){
            // Dead ends are deliberately NOT cleared here: per-phase keys
            // cannot leak into another phase, and the entries are the
            // post-mortem record of why this phase never converged.
            s.phase="escalated";s.step="speckit_task_not_converging";
            s.phaseCheckpointError={code:"CONTINUATION_EXHAUSTED",evidence:{role:"verifier",used:cont.used,limit:cont.limit,stopped:"incomplete"}};
            // Backlog #27: record the continuation for bare `ap reset`, and
            // end with the exact resume command.
            recordLastContinuation(s,{contScope,taskId:null,missionName:missionIdentity,taskRef:verifyRef});
            s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
             die(`SpecKit verification did not converge after ${cont.used} generations (last generation stopped voluntarily as incomplete). STOP — human intervention required.\nResume: ap reset --scope ${contScope} then ap run`);
            }
            recordContinuationGateResult(checkpoint,preGateCacheKey,g);
            console.log(`SpecKit verification stopped voluntarily as incomplete; continuing as session ${cont.used+1} of ${cont.limit+1}.`);
          continue;
        }
        if(g.ok&&vv.status==="completed"&&vv.review?.decision==="PASS"){
          // Mission 025 task 3.2: never accept a SpecKit verifier PASS
          // while any linked verify/tool result exited non-zero or 124. The
          // joint gate+verdict check covers both evidence channels: the
          // phase-gate results (g.results) and the verifier's own observed
          // tool calls. A failed or timed-out linked result routes to
          // feedback/retry, never to PASS. Only commands matching a linked
          // task verify or gate command count — the verifier's inspection
          // commands (grep/test/git diff) never refuse PASS.
          const verifierRefusal=shouldRefusePassForEvidence({gateResults:Array.isArray(g.results)?g.results:[],toolResults:reviewerLinkedToolResults(vv,linkedVerifyCommandsForPhase(phaseTasks,c?.gates?.commands))});
          if(verifierRefusal?.refuse===true){
            const verifierReason=verifierRefusal.reason==="timed-out"?"timed out":"failed";
            const verifierCommand=verifierRefusal.command?` \`${String(verifierRefusal.command).slice(0,200)}\``:"";
            const verifierExit=verifierRefusal.exitCode ?? verifierRefusal.status ?? "unknown";
            const refusalFindings=[`Verifier PASS refused: linked verify/tool result${verifierCommand} ${verifierReason} (exit ${verifierExit}). Re-verify the work after addressing the failure instead of passing.`];
            feedback=feedbackText(saveReviewFeedback(s,speckitPhaseFeedbackKey(s.phaseIndex),refusalFindings))||"Verification failed.";
            recordPhaseFindingTasks(speckitPhaseFeedbackKey(s.phaseIndex),refusalFindings,true);
            {
              const recorded=enforceAttemptFailure(c,s,`speckit:${phase.name}`,lastImpl&&lastReview?[lastImpl,lastReview,{...vv,failure:failure("VERIFICATION_REJECTED","verification",true,refusalFindings)}]:(lastReview?[lastReview,{...vv,failure:failure("VERIFICATION_REJECTED","verification",true,refusalFindings)}]:[{...vv,failure:failure("VERIFICATION_REJECTED","verification",true,refusalFindings)}]),g);
              checkpoint=applyCheckpointTransition(decideTransition(checkpoint,recorded));
              s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
            }
            continue;
          }
          const transition=decideTransition(checkpoint,{stage:"verifier",status:"completed",decision:"PASS",runId:vv.sessionId??null,findings:vv.review?.findings??[]});
          checkpoint=applyCheckpointTransition(transition);
          checkpoint.verifier={runId:vv.sessionId??null,decision:"PASS",findings:vv.review?.findings??[]};
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
          continue;
        }
        feedback=feedbackText(saveReviewFeedback(s,speckitPhaseFeedbackKey(s.phaseIndex),vv.review?.findings||[]))||(g.ok?"Verification failed.":`Verification gate failed: ${g.command}`);
        // TASK-20 step 1: same record as the review FAIL site. A gate failure
        // with no findings at all lands here as `entries:[]` +
        // `allMapped:false` — "redo everything", today's safe behaviour.
        // TASK-21 step 2 (c-gap 2): the SpecKit twin of the standalone
        // verifier-FAIL site — `carryAllowed` is true here as well, for the
        // same reason: a red gate command only says the phase is not done
        // while the findings that arrive with it name the tasks. A gate
        // failure with NO findings still fails `allMapped` and records an
        // empty carry, so the retry re-runs everything.
        recordPhaseFindingTasks(speckitPhaseFeedbackKey(s.phaseIndex),rawReviewFindings(vv),true);recordVerifierRound(s,codeReviewScopeKey("speckit-phase",s.phaseIndex),vv.review?.findings||[],vv.review?.previous);noteEscalationTrigger(s,c,"implementer",codeReviewScopeKey("speckit-phase",s.phaseIndex),"verifier",vv.review?.previous);
        // Gate failure and functional Verification FAIL share this path:
        // back to Implementer, then Reviewer, then Verifier. An
        // infrastructure failure retries only the Verifier.
        {
          const recorded=enforceAttemptFailure(c,s,`speckit:${phase.name}`,lastImpl&&lastReview?[lastImpl,lastReview,vv]:(lastReview?[lastReview,vv]:[vv]),g);
          checkpoint=applyCheckpointTransition(decideTransition(checkpoint,recorded));
          s[CHECKPOINT_STATE_KEY]=checkpoint;saveState(s);
        }
        continue;
      }

      if(stage==="mark_tasks"){
        // No-model crash-recovery stage consuming the stored Verifier PASS
        // (the loop-top gate already matched task+delta digests against it).
        // Only NOW — Implementer completed, Code Review PASS, configured
        // gates PASS, Verifier PASS — does Autopilot mark these exact task
        // lines "[x]" in tasks.md. Identity-validated and fail-closed: a
        // mismatch (unexpected drift in tasks.md since phaseTasks was
        // computed) stops the mission rather than checking off the wrong
        // line or silently leaving verified work unmarked.
        s.step="mark_tasks";saveState(s);
        const marked=setTaskCheckboxes(phaseTasks,true);
        // Mission 084 Phase 2 task 2.4 — orchestrator tracked write
        // invalidates the snapshot reuse cache (scenario b).
        try{
          clearSnapshotReuseCache("mark_tasks tracked write");
          console.log(`[snapshot-reuse] cache cleared: mark_tasks tracked write`);
        }catch(error){
          console.log(`[snapshot-reuse] cache clear skipped (${error?.message||error})`);
        }
        if(!marked.ok){
          s.phase="escalated";s.step="task_marking_failed";s.taskMarkingError=marked.reason;saveState(s);
          die(`SpecKit task checkbox marking failed after verification PASS: ${marked.reason}. STOP — human intervention required.`);
        }
        // The Implementer/Verifier never mutate these in-memory task
        // objects — they only flip the on-disk checkbox via
        // setTaskCheckboxes above. Without this, s.currentPhase/s.currentTask
        // (which hold these SAME object references) would keep reporting
        // done:false for a phase that has, in fact, just passed Verification
        // and been marked "[x]" on disk — a truthfulness gap in state.json
        // for as long as this phase stays "current" (i.e. until the next
        // phase overwrites it, or the mission completes and clears it).
        for(const t of phaseTasks) t.done=true;
        passed=true;s.lastReview={decision:checkpoint.codeReviewer?.decision??"PASS",findings:checkpoint.codeReviewer?.findings??[]};s.feedback="";clearRoleSession(s,"implementer");
        // TASK-20: the finding→task record is cleared with the findings it
        // describes — a PASS must never leave a FAIL's map readable.
        clearReviewFeedback(s,speckitPhaseFeedbackKey(s.phaseIndex));
        clearFindingTasks(s,speckitPhaseFeedbackKey(s.phaseIndex));clearCodeReviewHistory(s,codeReviewScopeKey("speckit-phase",s.phaseIndex));clearVerifierHistory(s,codeReviewScopeKey("speckit-phase",s.phaseIndex));
        // TASK-23: this phase's per-review snapshots are only ever read by
        // its own next code review. A passed phase is never reviewed again,
        // so delete them (they are copies of the phase's dirty files).
        // Before the checkpoint delete, while revision is still readable.
        for(let r=1;r<=checkpoint.revision;r++) removeBaseline(repo,`${phaseBaselineKey}-review-r${r}`);
        delete s[CHECKPOINT_STATE_KEY];
        saveState(s);
        console.log(`  ✓ Phase ${s.phaseIndex+1} completed`);
        continue;
      }

      // Unreachable: validateCheckpoint bounds nextStage/runningStage to the
      // four pipeline stages. Fail closed rather than loop forever.
      s.phase="escalated";s.step="speckit_unknown_stage";
      s.phaseCheckpointError={code:"INTERNAL_CONTRACT_ERROR",evidence:{stage}};
      saveState(s);
      die(`SpecKit phase checkpoint names an unknown stage: ${String(stage)}. STOP — human intervention required.`);
    }
    s.checkpoint={type:"phase",index:s.phaseIndex,phase:phase.name,tasks:phaseTasks.map(t=>t.text),at:now()};saveState(s);
  }

  s.phase="final_review";s.step="final_review";saveState(s);
  // TASK-26: the mission-final review gets a measured deadline too.
  const speckitFinalBudget=roleDeadline(c,s,"code_reviewer");
  const speckitFinalNoParallel=formatHeavySuiteNoParallelNote();
  // Mission 067 task 1.2: security checklist rides the SpecKit
  // mission-final review prompt verbatim plus the shared
  // whole-mission-diff reviewer line (imported, never duplicated).
  // Explicit repo root — absent/unreadable yields the generic section.
  let final=await review("code_reviewer",
    `${`Perform final repository review against the planning artifacts.\n\nScoped implementation delta for THIS ENTIRE MISSION (pre-existing repository changes made before this mission started are excluded — do not evaluate or flag anything outside this delta; an empty delta means this mission made no repository changes):\n${scopedDeltaBeginMarker("MISSION")}\n${speckitBoundedDelta(repo,missionBaselineKey,"MISSION_FINAL")}\n${SCOPED_DELTA_END_MARKER}`}${speckitFinalNoParallel?`\n\n${speckitFinalNoParallel}`:""}\n\n${buildSecurityChecklistSection(repo)}\n${MISSION_FINAL_SECURITY_LINE}\n\n${speckitFinalBudget.note}`,
    c,s,"",[],null,speckitFinalBudget.timeoutMs,false,codeReviewScopeKey("final","speckit"));
  noteRoleDeadlineOutcome(s,"code_reviewer",final,speckitFinalBudget.derived);
  if(final.status==="completed"&&!final.policyViolation&&final.review?.decision==="PASS"){
    // Mission 025 task 3.4: never complete the mission on a final-reviewer
    // PASS while any linked verify/tool result exited non-zero or 124. The
    // mission-final review runs no phase gates, so the reviewer's own
    // observed tool calls are the evidence channel (same helper as task
    // 3.1, mission-wide linked set). A failed or timed-out linked result
    // escalates like a FAIL and never reaches finalizeMissionComplete
    // below. Only commands matching a linked task verify or gate command
    // count — inspection commands (grep/test/git diff) never refuse.
    const finalRefusal=shouldRefusePassForEvidence({gateResults:[],toolResults:reviewerLinkedToolResults(final,linkedVerifyCommandsForPhase(specKitPhases(c).flatMap(p=>p.tasks),c?.gates?.commands))});
    if(finalRefusal?.refuse===true){
      s.phase="escalated";s.step="final_review";saveState(s);die("Final review failed.");
    }
  }
  // Mission 031 Phase 3 task 3.5: INCOMPLETE-as-FAIL (no continuation): speckit-final-review has no continuation loop — an INCOMPLETE decision is treated as FAIL with explicit reason and never consumes a continuation.
  if(final.review?.decision==="INCOMPLETE") console.log("SpecKit final review INCOMPLETE treated as FAIL (no continuation).");
  if(final.status!=="completed" || final.policyViolation || final.review?.decision!=="PASS"){
    // Mission 051 task 1.4: route the SpecKit mission-final FAIL through the
    // bounded final-review fix-round loop instead of escalating immediately.
    // The linked-evidence refusal above already escalated (bypass, no round
    // consumed); a policy violation bypasses inside the helper and lands
    // back here. Mission-final runs no phase gates, so the gate is null and
    // the evidence channel is the reviewer's own observed tool calls against
    // the mission-wide linked set. Each round records the finding chain,
    // briefs the fix pass from fixPassBriefExcerpts, relays the findings to
    // the implementer, then re-reviews. Only budget exhaustion (or a
    // mid-loop refusal/policy path) escalates, keeping message
    // `Final review failed.` and step `final_review`.
    const speckitLinkedCommands=linkedVerifyCommandsForPhase(specKitPhases(c).flatMap(p=>p.tasks),c?.gates?.commands);
    const speckitCheckRefusal=(candidate)=>shouldRefusePassForEvidence({gateResults:[],toolResults:reviewerLinkedToolResults(candidate,speckitLinkedCommands)});
    const speckitMissionTasks=specKitPhases(c).flatMap(p=>p.tasks).map(t=>({file:t.file,text:t.text}));
    const speckitDigestArgs={framework:"speckit",mission:missionIdentity,phaseIndex:phaseList.length,phaseNumber:phaseList.length+1,phaseName:"mission-final",tasks:speckitMissionTasks,repoRoot:repo};
    let lastFinalReview=final;
    const speckitFinalFix=await runFinalReviewFixRounds({
      state:s,policy:c.policy,
      initialReview:final,initialEvidenceRefusal:speckitCheckRefusal(final),
      initialFindings:rawReviewFindings(final),
      // Mission 062 task 1.3: latest gate-green evidence, rehydrated to a
      // Set (mission-final runs no fresh gate — stored greens win).
      gateGreenFiles:readGateGreenFilesSet(s,missionDirFor(repo,s)),
      recordArgs:{key:"speckit-final:mission-final",phaseTaskDigest:phaseTaskDigest(speckitDigestArgs),taskIds:stableTaskIds(speckitDigestArgs),factsByTask:undefined,revision:1,carryAllowed:false},
      readFile:fixPassBriefReadFile,
      saveState:()=>saveState(s),
      deps:{
        runFixPass:async({brief,findings,round,used,limit})=>{
          recordCodeReviewRound(s,codeReviewScopeKey("final","speckit"),findings,lastFinalReview?.review?.previous);noteEscalationTrigger(s,c,"implementer",codeReviewScopeKey("final","speckit"),"code_reviewer",lastFinalReview?.review?.previous);
          const earlierRounds=implementerEarlierRoundsText(s,codeReviewScopeKey("final","speckit"));
          const prompt=`SpecKit mission-final review FAIL (fix round ${round}/${limit}): address every finding below or rebut it with evidence; do not declare the work complete while any finding stands.\n${feedbackText(findings)}${earlierRounds?`\n\n${earlierRounds}`:""}${brief?`\n${brief}`:""}`;
          const fix=await relay("implementer",prompt,c,s,{resume:false,requirements:[]});
          if(fix?.policyViolation){
            s.phase="escalated";s.step="relay_policy_violation";s.relayPolicyViolation=fix.policyViolation;saveState(s);
            die(formatRelayPolicyViolation(fix.policyViolation,fix.touchedFiles));
          }
          return fix;
        },
        runGate:async()=>null,
        runFinalReview:async({round,used,limit,gate,brief,summary})=>{
          const budget=roleDeadline(c,s,"code_reviewer");
          // 067 security section above; 071 no-work summary as answer/rebuttal.
          const answerSection=(typeof summary==="string"&&summary!=="")?`\n\nImplementer's answer/rebuttal (no files changed):\n${summary}`:"";
          const rereview=await review("code_reviewer",
            `${`Perform final repository review against the planning artifacts.\n\nScoped implementation delta for THIS ENTIRE MISSION (pre-existing repository changes made before this mission started are excluded — do not evaluate or flag anything outside this delta; an empty delta means this mission made no repository changes):\n${scopedDeltaBeginMarker("MISSION")}\n${speckitBoundedDelta(repo,missionBaselineKey,"MISSION_FINAL")}\n${SCOPED_DELTA_END_MARKER}`}${speckitFinalNoParallel?`\n\n${speckitFinalNoParallel}`:""}\n\n${buildSecurityChecklistSection(repo)}\n${MISSION_FINAL_SECURITY_LINE}${answerSection}\n\n${budget.note}`,
            c,s,"",[],null,budget.timeoutMs,false,codeReviewScopeKey("final","speckit"));
          noteRoleDeadlineOutcome(s,"code_reviewer",rereview,budget.derived);
          lastFinalReview=rereview;
          if(rereview?.review?.decision==="INCOMPLETE") console.log(`SpecKit mission-final final re-review round ${round} INCOMPLETE treated as FAIL (no continuation).`);
          return rereview;
        },
        checkEvidenceRefusal:({review:rereview})=>speckitCheckRefusal(rereview),
        recordReviewerFailure:(info)=>recordFinalReviewerFailure(c,s,"speckit-mission-final",info),
      },
    });
    if(speckitFinalFix.outcome!=="escalate") clearCodeReviewHistory(s,codeReviewScopeKey("final","speckit"));
    if(speckitFinalFix.outcome==="passed"){final=speckitFinalFix.review;}
    else{s.phase="escalated";s.step=speckitFinalFix.step||"final_review";saveState(s);die(speckitFinalFix.message||"Final review failed.");}
  }

  // Belt-and-suspenders: re-read tasks.md fresh from disk (never the
  // in-memory phaseList, which could be stale) and refuse to declare the
  // mission complete while any task belonging to this SpecKit feature is
  // still unchecked. Every phase above already marks its own tasks "[x]"
  // immediately after that phase's Verification PASS, so this should never
  // actually find anything — it exists to fail closed instead of silently
  // completing if that invariant is ever violated.
  const stillUnchecked=specKitPhases(c).flatMap(p=>p.tasks).filter(t=>!t.done);
  if(stillUnchecked.length){
    s.phase="escalated";s.step="task_marking_incomplete";saveState(s);
    die(`Refusing to complete: ${stillUnchecked.length} SpecKit task(s) remain unchecked in tasks.md: ${stillUnchecked.map(t=>`${t.text} (${t.file}:${t.line})`).join("; ")}. STOP — human intervention required.`);
  }

  finalizeMissionComplete(s);
  console.log("ALL WORK COMPLETE — HUMAN COMMIT REQUIRED");
}

function setup(){
  const p=path.join(skillRoot,"scripts","setup.mjs");
  return run("node",[p,"--repo",repo]);
}
async function reviewPlanCommand(c,s){
  const state=detectPlanningState(c,s);
  if(state.status==="missing") die("No planning artifacts exist yet. Run ap run to let Autopilot plan and continue automatically.");
  if(state.status==="ambiguous") die(`Planning state is ambiguous: ${state.reason||"insufficient evidence"}. Run ap run again after repairing the planning artifacts.`);
  const result=await reviewExistingPlanning(c,s,state,process.env.AUTOPILOT_SPEC||c.project?.spec||"Review the current planning artifacts.");
  console.log(JSON.stringify(result,null,2));
}

async function doCommand(c,s){
  const request=commandArgs.join(" ").trim()||process.env.AUTOPILOT_SPEC||c.project?.spec||"Use the current project request/context.";
  process.env.AUTOPILOT_SPEC=request;
  await runSpec(c,s);
  return runImplementation(c);
}

async function main(){
  if(command === "--help" || commandArgs.includes("--help") || command==="help"){
    console.log(`Project Autopilot CLI\n\nPublic command:\n  ap run [request] [--repo <path>] [--stage <planning|implement|review|verify>]    Full autonomous A-to-Z workflow, or one stage only with --stage\n\nThe run automatically detects existing SpecKit/GSD/Autopilot state, continues\nfrom the correct stage, plans only when necessary, and never git commits or pushes.\nWith --stage, only that stage runs (planning|implement|review|verify); a stage whose\nprerequisites are unmet is refused with a usage error naming the missing state.`);
    return;
  }
  if(command==="setup")return setup();
  // Backlog #14 task 1.2: `ap uninstall` MUST be dispatched before
  // ensureFirstRun() — an unconfigured repo has no `.autopilot/`, and running
  // the setup wizard there would defeat the whole point of the command (the
  // same setup-trigger bug `ap stop` had). The command itself reports
  // "Autopilot is not set up here" and exits 0 in that case.
  if(command==="uninstall"){
    // Flags are parsed inside the handler (--yes/--dry-run/--keep-missions), so
    // the whole arg list is passed through rather than a pre-joined string.
    // The handler's return code is applied explicitly, like the other
    // mission-control commands below, so its refusals (a live run, a missing
    // TTY) are observable as a non-zero exit.
    const code=uninstallCommand(commandArgs);
    process.exitCode=code;
    return code;
  }
  // First use is automatic: every operational command ensures project config
  // exists before doing any work. The explicit setup command remains a
  // developer/repair fallback.
  ensureFirstRun();
  if(command==="doctor")return run("node",[path.join(skillRoot,"scripts","doctor.mjs"),"--repo",repo]);
  if(command==="inspect"){const c=cfg();const a=planningAdapter(c);const fw=a===standalone?{id:"standalone",detected:true,planFile:standalone.planPath(repo,resolveStandaloneMission(repo,loadState(),"")),tasksFile:standalone.tasksPath(repo,resolveStandaloneMission(repo,loadState(),""))}:a===gsd?a.inspect(repo,gsdPhaseRoot(c)):a.inspect(repo);const state=detectPlanningState(c,loadState());console.log(JSON.stringify({framework:fw,planningState:state,phaseList:phaseList(c)},null,2));return}
  if(command==="status"){const st=loadState();console.log(JSON.stringify(st,null,2));console.log(git(["status","--short"]));try{const n=staleRunningNote(repo,missionFor(repo,st));if(n)console.log(n)}catch{/* display only */}return}
  // Mission-control commands (F2). The reason is every non-flag argument, so
  // `--repo`'s value never leaks into the recorded text. The handler's return
  // code is applied to the process explicitly: these commands' refusals (a live
  // run, an empty scope) must be observable as a non-zero exit by a script or a
  // human's `$?`, and relying on the generic return path left them at 0.
  if(command==="cancel"){
    // Flags are parsed inside the handler (reason + --yes/--dry-run), so the
    // whole arg list is passed through rather than a pre-joined string.
    const code=cancelCommand(commandArgs);
    process.exitCode=code;
    return code;
  }
  if(command==="reset"){
    const i=commandArgs.indexOf("--scope");
    const code=resetCommand(i>=0?commandArgs[i+1]||null:null);
    process.exitCode=code;
    return code;
  }
  if(command==="stop"){
    // Flags are parsed inside the handler (--yes/--dry-run), so the whole
    // arg list is passed through rather than a pre-joined string.
    const code=stopCommand(commandArgs);
    process.exitCode=code;
    return code;
  }
  if(command==="rebase"){
    // Flags are parsed inside the handler (--note/--yes), so the whole
    // arg list is passed through rather than a pre-joined string.
    const code=rebaseCommand(commandArgs);
    process.exitCode=code;
    return code;
  }
  if(command==="finding"){
    const code=findingCommand(commandArgs);
    process.exitCode=code;
    return code;
  }
  const c=cfg();preflightConfiguredRoles(c);const s=loadState();
  if(command==="plan"||command==="spec")return runSpec(c,s);
  if(command==="review")return reviewPlanCommand(c,s);
  if(command==="implement"||command==="run"||command==="resume"||command==="full") {
    warnIfGsdFramework(c);
    // Owner PID guard (mission 041 task 1.2): before ANY state mutation,
    // refuse when a verified-live owner PID file exists, else claim it.
    let cur=null;
    try{ cur=readOwnerPid(repo); }catch{ cur=null; }
    const ownerVerdict=cur?verifyOwnerPid(cur,repo):false;
    if(ownerVerdict===true){
      console.error(`mission is live, pid ${cur.pid}`);
      process.exitCode=1;
      return 1;
    }
    if(ownerVerdict==="unknown"){
      // Windows claim with an unreadable cmdline (CIM unavailable): neither
      // live nor stale — fail closed WITHOUT deleting or overwriting the
      // possibly-live run's PID file (mission 041 task 1.1).
      console.error(`mission may be live, pid ${cur.pid} (owner claim unverifiable on this platform); refusing to start`);
      process.exitCode=1;
      return 1;
    }
    // Same-platform stale file (dead PID or recycled cmdline) is ours to
    // clear; a cross-platform file is never stale — leave it for the
    // /proc+CIM scans (task 1.3) to fall through to.
    if(cur&&cur.platform===process.platform){
      try{ removeOwnerPid(repo); }catch{}
    }
    try{ writeOwnerPid(process.pid,repo); ownsMission=true; }catch{}
    // Normal-exit cleanup is explicit (try/finally on the run paths below).
    // The speckit-resume contract (see test-interrupt-flush.mjs /
    // test-speckit-plan-review-resume.mjs) allows exactly one
    // exit-event hook, which only refreshes the watch report;
    // owner-pid cleanup stays in the explicit try/finally. Signal cleanup
    // stays in flushAndReraise above.
    // Install the watch-refresh interval once for the whole `ap run` lifetime.
    watchRefreshInterval=setInterval(()=>{ try{ watchRefreshTrace("tick"); refreshWatchReport(activeRelayState??loadState()); }catch{} },5000).unref();
    try{
      if(command==="implement"||command==="run"||command==="resume") {
        // Backlog #39 task 1.2: parse run args with the pure helper so
        // `--mission <name>` (and `--repo <path>`) never become request text.
        // The mission override itself still resolves via `missionOverride()`
        // reading `process.argv`; this only decides what becomes AUTOPILOT_SPEC.
        // A flag-like residual request or a valueless `--mission` dies here with
        // a usage error instead of running with a swallowed/mistaken request.
        const parsed=parseRunArgs(commandArgs);
        if(parsed.error) die(parsed.error);
        if(parsed.stage!=null&&command!=="run") die(`Usage error: --stage ${parsed.stage} is only supported with \`ap run\`. Use: ap run --stage ${parsed.stage} [request]`);
        if(parsed.request) process.env.AUTOPILOT_SPEC=parsed.request;
        if(command==="resume"){
          const missionDir = getMissionWatchDir(s);
          try{ if (missionDir) appendWatchEvent(missionDir, { type: "operator", reason: "resume", scope: "mission" }); }catch{}
        }
        // Mission 090 task 1.4: stage-ordering guard — refuse a stage whose
        // prerequisites are unmet before running anything, exiting non-zero
        // with the guard's reason naming the missing state.
        // Backlog open #5: the guard evaluates the mission that will actually
        // run — parseRunArgs' residual `request` is this invocation's request,
        // so a NEW mission's request (or a terminal old mission:
        // complete/cancelled/escalated) refuses implement/review/verify
        // instead of letting runImplementation treat the text as a new
        // request with no plan (mission 095: planner ran on a backlog file).
        if(parsed.stage!=null){
          const verdict=guardStage(parsed.stage,{state:s,checkpoint:s[CHECKPOINT_STATE_KEY]??null,request:parsed.request});
          if(!verdict.allowed) die(verdict.reason.startsWith("Usage error")?verdict.reason:`Usage error: ${verdict.reason}`);
        }
        activeStage=parsed.stage??null;
        return await runImplementation(c);
      }
      if(command==="full"){
        await runSpec(c,s);
        return await runImplementation(c);
      }
    }
    finally{ if(watchRefreshInterval){ const wri=watchRefreshInterval; clearInterval(wri); watchRefreshInterval=null; watchRefreshTrace(`clear destroyed=${wri._destroyed===true}`); } cleanupOwnerPid(); }
  }
  if(command==="do")return doCommand(c,s);
  die("Unknown command. Use: setup, plan, review, run, resume, status, doctor, inspect, do.");
}
// Mission 091 task 2.1: only run the CLI when executed directly — importing
// this module (e.g. adhoc-runner defaultEntry importing runAdhocReview)
// must have no side effects (no config migration, no process exit).
const __isMainEntry=(()=>{try{if(!process.argv[1])return false;return fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url));}catch{return false;}})();
// Backlog #98: an unexpected exception (not an intentional die(), which exits
// itself) records a clean escalation, finalizes the open run as interrupted,
// and prints a resume hint. Every step is best-effort; exit code stays 2.
function handleUnexpectedError(error){
  const message=String(error?.message||error);
  const frame=(String(error?.stack||"").split(/\r?\n/).find(l=>/^\s*at /.test(l))||"").trim()||null;
  try{ if(activeRunDir) markInterrupted(activeRunDir,{reason:`unexpected error: ${message}`}); }catch{}
  try{
    if(ownsMission||activeRunDir){
      const stPath=path.join(repo,".autopilot","state.json");
      if(fs.existsSync(stPath)){
        const s=loadState();
        const fatalTag=error?.autopilotFatal===true;
        const keep=s.phase==="complete"||s.phase==="cancelled"||s.phase==="idle"||(s.phase==="escalated"&&s.step&&s.step!=="unexpected_error");
        if(fatalTag&&!keep){
          // Intentional fail-closed stop: record the failure but keep phase/step so `ap run` resumes.
          s.lastFailure={domain:"orchestrator",class:"ORCHESTRATOR_FATAL",retryable:false,message,location:null,at:now()};
          saveState(s);
        }else if(!keep){
          s.phase="escalated";s.step="unexpected_error";
          s.lastFailure={domain:"orchestrator",class:"UNEXPECTED_ERROR",retryable:false,message,location:frame,at:now()};
          saveState(s);
          try{ refreshWatchReport(s); }catch{}
        }
      }
    }
  }catch{}
  try{ if(ownsMission) removeOwnerPid(repo,{ifPid:process.pid}); }catch{}
  if(error?.autopilotFatal===true)console.error(`ERROR: ${message}`);
  else console.error(`ERROR: unexpected error (escalated as unexpected_error): ${message}${frame?` [${frame}]`:""}`);
  console.error("Fix the cause, then run `ap run` to resume.");
  if(process.env.AUTOPILOT_DEBUG_STACK) console.error(error?.stack||error);
  process.exit(2);
}
if(__isMainEntry)Promise.resolve(main()).catch(handleUnexpectedError);
