#!/usr/bin/env node
import fs from "node:fs";
import { capUnitLabel } from "./per-task-budget.mjs";
import { callsWithOptions, callArgs, callOptions, optionKeys, functionBody } from "./test-fixtures/source-scan.mjs";

// Backlog 003#15 (token ceiling) + 003#16 (turn cap) + 003#17 (continuation).
// autopilot.mjs runs main() on import, so the runRelay monitor, the breach
// outcome, and the per-task continuation hooks are static-covered here (same
// pattern as test-interrupt-flush / test-transport-authority). Decision
// logic itself (checkCapBreach, allowance ledger, dead-ends bounds) is
// unit-covered in test-per-task-budget.mjs; prompt rendering in
// test-role-progress-prompt.mjs.
let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};
const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
// Required options only: extra options (planRevision, carriedForwardTasks, ...) and ordering are tolerated.
const PLANNER_OPTS = ["resume:false", "capEnabled:true", "taskRef:'standalone-planning-planner'"];
const REVIEWER_OPTS = ["readOnly:true", "review:true", "resume:false", "capEnabled:true", "taskRef:'standalone-planning-plan_reviewer'"];
const count = (re) => [...src.matchAll(re)].length;

// ── Monitor (runRelay, around spawnRelayChild) ──
check("monitor: limits resolved per invocation", (() => {
  // resolved inside runRelay (per invocation), options carry at least adapter + model (extra keys tolerated)
  const body = functionBody(src, "function runRelay(");
  const calls = callArgs(body, "resolvePerRoleLimits(roleName,c.policy,");
  const decl = body.indexOf("const roleCaps=resolvePerRoleLimits(roleName,c.policy,") !== -1;
  const keys = calls.length ? optionKeys(callOptions(calls[0])) : [];
  return decl && calls.length === 1 && keys.includes("adapter") && keys.includes("model")
    && callOptions(calls[0]).includes("adapter:role.adapter") && callOptions(calls[0]).includes("model:role.model");
})());
check("monitor: stream accumulated in onChunk", /capStdout\+=chunk/.test(src) && /capStderr\+=chunk/.test(src));
check("monitor: 1s evaluator installed at spawn", /capTimer=setInterval\(\(\)=>\{ try\{ evaluateCaps\(\); \}catch\{\} try\{ evaluateIdle\(\); \}catch\{\} \},1000\)/.test(src));
check("monitor: decision delegates to the unit-tested pure helper", /checkCapBreach\(\{usage,perTaskMaxTurns:roleCaps\.perTaskMaxTurns,perTaskMaxTokens:roleCaps\.perTaskMaxTokens\}\)/.test(src));
check("monitor: wrap-up ceiling and cap breach consume roleCaps from resolvePerRoleLimits", /wrapupCeilingDriver=\(isWrapUp && capEnabled\)\?adapterDriver\(role\.adapter\):null;/.test(src) && /checkCapBreach\(\{usage,perTaskMaxTurns:roleCaps\.perTaskMaxTurns,perTaskMaxTokens:roleCaps\.perTaskMaxTokens\}\)/.test(src) && /checkWrapupTrigger\(\{usage,perTaskMaxTurns:roleCaps\.perTaskMaxTurns,perTaskMaxTokens:roleCaps\.perTaskMaxTokens,wrapupTokens\}\)/.test(src));
check("monitor: SIGTERM then SIGKILL escalation", /process\.kill\(capPid,"SIGTERM"\)/.test(src) && /process\.kill\(capPid,"SIGKILL"\)/.test(src));
check("monitor: settled in finally (no pid-reuse kill)", /capSettled=true;\s*\n\s*clearCapTimers\(\);/.test(src));
check("monitor: evaluator no-ops once settled or breached", /if\(capSettled\|\|capBreach\) return;/.test(src));
check("monitor: live totals decode for every role (usageDriver, not implementer-gated capDriver)",
  /const usageDriver=adapterDriver\(role\.adapter\);/.test(src)
  && /usageDriver\.decodeEvents\(capStdout,capStderr\)/.test(src)
  && /accumulateUsage\(role\.adapter,capEvents\)/.test(src));
check("monitor: cap enforcement stays implementer-only (wrap-up turn exempt with its own ceiling)",
  /const capDriver=\(!isWrapUp && capEnabled\)\?adapterDriver\(role\.adapter\):null;/.test(src)
  && /\} else \{\s*\n\s*if\(!capDriver\) return;/.test(src)
  && /const wrapupCeilingDriver=\(isWrapUp && capEnabled\)\?adapterDriver\(role\.adapter\):null;/.test(src));

// ── Threading verification ──
check("threading: relay() destructures capEnabled and passes to runRelay",
  /const \{.*capEnabled.*\}=options;/.test(src) &&
  /runRelay\(roleName,task,c,s,\{[^}]*capEnabled[^}]*\}/.test(src));

check("threading: relayAsync() destructures capEnabled and passes to runRelay",
  /async function relayAsync\(roleName,task,c,s,options=\{\}\)\{[\s\S]*?const \{.*capEnabled.*\}=options;/.test(src) &&
  /runRelay\(roleName,task,c,s,\{[^}]*capEnabled[^}]*\}/.test(src));

check("threading: review() accepts capEnabled and passes to relay",
  /function review\(reviewer,task,c,s,feedback="",requirements=\[\],taskRef=null,timeoutMs=null,capEnabled=false(?:,roundKey=null)?(?:,resultExtra=null)?\)/.test(src) &&
  /relay\(reviewer[\s\S]*?capEnabled/.test(src));

// ── Implementer call sites pass capEnabled:true ──
// Standalone (runStandaloneImplementation) and SpecKit (runImplementation)
// loops share the same single-line relay("implementer",...) shape, so each
// site is matched on one line and the count pins both (a single stray match
// can no longer satisfy two identical cross-line regexes).
check("implementer: GSD loop relayAsync passes capEnabled:true",
  /relayAsync\("implementer"[\s\S]{0,300}?capEnabled:true/.test(src));

check("implementer: Standalone + SpecKit loops relay passes capEnabled:true (2 sites)",
  count(/relay\("implementer",[^\n]*capEnabled:true/g) === 2);

// ── Wrap-up path: breach triggers the orchestrator fallback, no resume ──
// Mission 045 (Backlog #46) phase 1: the capped session is NEVER resumed
// for a wrap-up turn. The capped branch itself computes this session's own
// changed paths and writes the orchestrator fallback note, then returns.
// The runWrapUp closure IS the whole wrap-up path — nothing inside it may
// spawn a relay turn, so slice it out and pin the absence structurally
// (the rollover scenarios in test-cap-breach-rollover.mjs prove the
// behavioural half: zero wrap-up runs).
const wrapUpStart = src.indexOf("const runWrapUp=async()=>{");
const wrapUpEnd = src.indexOf("result.wrapUp=await runWrapUp();");
const wrapUpClosure = (wrapUpStart !== -1 && wrapUpEnd > wrapUpStart) ? src.slice(wrapUpStart, wrapUpEnd) : "";
check("wrapup: breach writes the orchestrator fallback note (no wrap-up resume call)",
  /buildOrchestratorFallbackNote\(taskRef,events,role\.adapter,repo,diffStat,capBreach,sessionPaths\)/.test(src)
  && /fs\.writeFileSync\(path\.join\(repo,noteRel\),fallbackNote\)/.test(src)
  && !/runNote:"wrap-up"/.test(src)
  && !/isWrapUp:true/.test(src));
check("wrapup: runWrapUp spawns no relay turn (no resume, no wrap-up prompt builder)",
  wrapUpClosure.length > 0
  && !/relay\(/.test(wrapUpClosure)
  && !/resume:true/.test(wrapUpClosure)
  && !/isWrapUp:true/.test(wrapUpClosure)
  && !/buildWrapUpPrompt\(noteRel,noteMaxChars\)/.test(wrapUpClosure)
  && !/buildReviewWrapUpPrompt/.test(wrapUpClosure));
check("wrapup: the wrap-up prompt builders are gone from autopilot.mjs entirely",
  !/buildWrapUpPrompt|buildReviewWrapUpPrompt/.test(src));

// ── Non-implementer roles do NOT pass capEnabled:true ──
// (Mission 031 P6.2: planner passes capEnabled:true at the standalone
// planning call site only, so planner is pinned by the P6.2 block below,
// not by this guard.)
check("non-implementer: no relay/relayAsync/review call passes capEnabled:true for other roles",
  !/relay\("(plan_reviewer|code_reviewer|verifier)"[^}]*capEnabled:true\}/.test(src) &&
  !/relayAsync\("(plan_reviewer|code_reviewer|verifier)"[^}]*capEnabled:true\}/.test(src) &&
  !/review\([^)]*"(plan_reviewer|code_reviewer|verifier)"[^)]*capEnabled:true/.test(src));

// ── Mission 031 phase 3 task 3.3: reviewer prompt offers INCOMPLETE ──
check("reviewer: prompt offers INCOMPLETE alongside PASS/FAIL",
  /AUTOPILOT_REVIEW=\{[^}]*"decision":"PASS"[^}]*\} or FAIL or INCOMPLETE/.test(src)
  && /Use INCOMPLETE when you cannot finish checking/.test(src));

// ── Breach outcome (capped, never a failure) ──
check("outcome: result carries the capped marker", /result\.capped=\{type:capBreach\.type,used:capBreach\.used,limit:capBreach\.limit\}/.test(src));
check("outcome: run reports capped, not failed (backlog 003#15)",
  /finalizeRun\(dir,\{status:capBreach\?"capped":result\.status/.test(src));
check("outcome: breach is observed to progress", /CAP_BREACH \| TYPE=/.test(src));

// ── Continuation hooks (both per-task implement loops) ──
check("loops: capped branch in both loops", count(/if\(taskImpl\.capped\)\{/g) === 2);
check("loops: allowance consumed at all four continuation sites (2 capped + 2 attempted)", count(/consumeContinuation\(s,c\.policy,contScope\)/g) === 4);
check("loops: dead end recorded at all four continuation sites + standalone code_reviewer capped (031 P4.1) + standalone verifier capped (031 P4.2) + 2 voluntary (031 P4.3) + speckit code_reviewer capped (031 P5.1) + speckit verifier capped (031 P5.2) + 2 speckit voluntary (031 P5.3)", count(/recordRolloverDeadEnd\(s,contScope,/g) === 12);
check("loops: exhaustion escalates not-converging (both frameworks)",
  src.includes('s.step="standalone_task_not_converging"') && src.includes('s.step="speckit_task_not_converging"'));
check("loops: cap breach continues the cursor loop (no commit, no failure path)", count(/Task \$\{taskId\} hit the/g) === 2);
check("loops: voluntary early stop continues too (both loops)",
  count(/parsed\.taskLocalCheck\.status==="attempted"/g) === 2);
check("loops: early stop consumes the same allowance (no free relaunches)",
  count(/stopped voluntarily with work remaining; continuing as session/g) === 2);
check("loops: dead-end tails are files-first (attribution, guarded)",
  count(/deadEndTail\(\{files:capFiles,outputTail:taskImpl\.workDigest\?taskImpl\.workDigest:"\(no decoded activity\)",maxChars:resolveHandoffMaxChars\(c\.policy\)\}\)/g) === 2 &&
  count(/deadEndTail\(\{summary:parsed\.summary,files:endedFiles\}\)/g) === 2);
check("loops: cap handoff carries the decoded-events digest, never raw output",
  !/deadEndTail\(\{files:capFiles,outputTail:taskImpl\.finalMessage/.test(src)
  && count(/taskImpl\.workDigest\?taskImpl\.workDigest:"\(no decoded activity\)"/g) === 2);
check("relay: work digest computed from decoded events (never raw bytes)",
  /const workDigest=driver\?sessionWorkDigest\(role\.adapter,events,\{maxChars:resolveHandoffMaxChars\(c\.policy\),repoRoot:cwd\}\):"";/.test(src)
  && /result\.workDigest=workDigest;/.test(src));
check("relay: finalMessage semantics unchanged (digest is additive)",
  /output:normalizedOutput,sessionId,before,after,guard,started,finished,reviewContract/.test(src));

// ── Backlog #26 Step A: hand-off note wiring (both loops) ──
check("note: previous note read at both prompt builds",
  count(/handoffNote:readHandoffNote\((mission|missionIdentity),taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\)\)/g) === 2);
check("note: operator note limit passed at both prompt builds",
  count(/handoffNoteMaxChars:resolveHandoffNoteMaxChars\(c\.policy\)/g) === 2);
check("note: removed on task completion (converge + carry, both loops)",
  count(/clearHandoffNote\((mission|missionIdentity),taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\)\)/g) === 4);
check("note: prompt builder renders the exact path from the shared helper",
  /handoffNoteRelPath\(mission, noteRef\)/.test(fs.readFileSync(new URL("./role-progress-prompt.mjs", import.meta.url), "utf8")));

// ── Backlog #26 Step B: forced hand-off wrap-up (both loops) ──
// Mission 039 task 2.1: review roles wrap up at their per-role threshold,
// implementer/unknown roles keep the global policy.handoff_wrapup_tokens.
check("wrapup: fixed token threshold resolved per invocation (not a turn %)",
  /Object\.hasOwn\(PER_ROLE_WRAPUP_TOKENS_DEFAULT,String\(roleName \?\? ""\)\.toLowerCase\(\)\)/.test(src)
  && /\? roleCaps\.wrapUpTokenThreshold/.test(src)
  && /: resolveHandoffWrapupTokens\(c\.policy,roleCaps\.perTaskMaxTokens\)/.test(src));
check("per-role wrapup: review role uses own threshold",
  /from "\.\/per-task-budget\.mjs"/.test(src) && src.includes("PER_ROLE_WRAPUP_TOKENS_DEFAULT")
  && /Object\.hasOwn\(PER_ROLE_WRAPUP_TOKENS_DEFAULT/.test(src)
  && /\? roleCaps\.wrapUpTokenThreshold/.test(src));
check("per-role wrapup: implementer uses global handoff_wrapup_tokens",
  /: resolveHandoffWrapupTokens\(c\.policy,roleCaps\.perTaskMaxTokens\)/.test(src)
  && /policy\.handoff_wrapup_tokens/.test(fs.readFileSync(new URL("./per-task-budget.mjs", import.meta.url), "utf8")));
check("wrapup: monitor evaluates the wrap-up trigger before the hard cap",
  /checkWrapupTrigger\(\{usage,perTaskMaxTurns:roleCaps\.perTaskMaxTurns,perTaskMaxTokens:roleCaps\.perTaskMaxTokens,wrapupTokens\}\)/.test(src));
check("wrapup: hard-cap path unchanged behind the wrap-up check",
  /const breach=checkCapBreach\(\{usage,perTaskMaxTurns:roleCaps\.perTaskMaxTurns,perTaskMaxTokens:roleCaps\.perTaskMaxTokens\}\);/.test(src));
check("wrapup: breach records wrapUp:true + trigger on the capped marker",
  /if\(capBreach\.wrapUp\) result\.capped\.wrapUp=true;/.test(src)
  && /if\(capBreach\.trigger\) result\.capped\.trigger=capBreach\.trigger;/.test(src));
check("wrapup: cap/wrap-up figures worded via the capUnitLabel helper (turns names turns, tokens keep raw context tokens)",
  /capUnitLabel,/.test(src) && /from "\.\/per-task-budget\.mjs"/.test(src) && count(/capUnitLabel\(\w+\.capped\.type\)/g) === 9 && capUnitLabel("turns") === "turns" && capUnitLabel("tokens") === "raw context tokens" && /CAP_BREACH \| TYPE=/.test(src));
check("wrapup: fallback note is built from this session's changes plus the session work digest",
  /changedFilesStat\(cwd,\{paths:sessionPaths\}\)/.test(src)
  && /buildOrchestratorFallbackNote\(taskRef,events,role\.adapter,repo,diffStat,capBreach,sessionPaths\)/.test(src)
  && /fs\.writeFileSync\(path\.join\(repo,noteRel\),fallbackNote\)/.test(src));
check("wrapup: wrap-up turn is cap-exempt with its own ceiling (turns + timeout)",
  /WRAPUP_MAX_TURNS/.test(src) && /WRAPUP_TIMEOUT_MS/.test(src)
  && /capEnabled && !isWrapUp/.test(src)
  && !/if\(roleName==="implementer" && !isWrapUp && capBreach\?\.wrapUp && result\.capped\)/.test(src));
check("wrapup: fallback outcomes recorded, never retried, never block the mission",
  /result\.wrapUp=await runWrapUp\(\);/.test(src)
  && /result\.wrapUp=\{status:"failed",reason:`wrap_up_error:/.test(src)
  && /status:"skipped",reason:"note_fresh"/.test(src)
  && /status:"skipped",reason:"note_scope_unknown"/.test(src)
  && /status:"orchestrator_fallback",reason:"note_missing_or_stale"/.test(src));
check("wrapup: build/write failures degrade to failed reasons, never to a resumed session",
  /fallback_note_build_failed/.test(src) && /fallback_note_write_failed/.test(src)
  && !/runNote:"wrap-up"/.test(src));
check("wrapup: implementer session store ensured + forwarded (data dir only, never HOME)",
  /ensureSessionStoreDir\(mission,taskRef\)/.test(src)
  && /sessionStoreSandboxSubpath\(role\.adapter\)/.test(src)
  && /sessionStoreMounts: roleName==="implementer" \? sessionStoreMounts : \[\]/.test(src)
  && /result\.sessionStore=sessionStoreRel\|\|null;/.test(src));
check("wrapup: store cleared with the note on completion (all four sites), size logged first",
  count(/clearSessionStore\((mission|missionIdentity),taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\)\)/g) === 4
  && count(/logSessionStoreSize\((mission|missionIdentity),taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\)\)/g) === 4);
check("wrapup: rollover log words the wrap-up outcome via the capUnitLabel helper",
  /wrap-up note:/.test(src) && /capUnitLabel\(taskImpl\.capped\.type\)/.test(src));
// ── Mission 049 Phase 1 task 1.2: richer cut hand-off ──
// Fallback note renders the 1.1 cut-context helpers (checked on the builder
// module, which autopilot.mjs cannot unit-drive); the runRelay call site
// passes capBreach figures; wrap-up reads the 1.1 scratch-note helper at
// effectiveScratchDir before the disposable workspace is cleaned up and a
// missing note degrades to orchestrator_fallback.
check("049-1.2: fallback note calls the cut-context helper",
  /renderCutContextSection\(\{adapterId, events, capBreach, repoRoot/.test(fs.readFileSync(new URL("./per-task-budget.mjs", import.meta.url), "utf8")));
check("049-1.2: wrap-up reads the scratch note at effectiveScratchDir and degrades missing to fallback",
  /scratchHandoffNotePath\(effectiveScratchDir,taskRef\)/.test(src)
  && /pickFresherHandoffNote\(\{repoText,repoMtimeMs,scratchText,scratchMtimeMs\}\)/.test(src)
  && /status:"orchestrator_fallback",reason:"note_missing_or_stale"/.test(src));
check("049-1.2: fresher scratch note is copied to the repo note before the note_fresh skip",
  /picked\.source==="scratch" && noteRel/.test(src)
  && /fs\.writeFileSync\(path\.join\(repo,noteRel\),picked\.text\)/.test(src)
  && /return \{status:"skipped",reason:"note_fresh",trigger:capBreach\.trigger\|\|null\};/.test(src));
{
  // Reviewer finding 2: the read-only milestone reminder must name the same
  // scratch file the wrap-up reads. buildTaskPrompt accepts handoffNoteRef
  // (the range reviewTaskRef/allPhaseTaskRef the relay runs under); the
  // rendered /workspace/scratch path must equal scratchHandoffNotePath() of
  // that same ref (basename comparison: the prompt renders the in-envelope
  // form, the wrap-up the host effectiveScratchDir form).
  const { buildTaskPrompt } = await import("./role-progress-prompt.mjs");
  const { scratchHandoffNotePath, SCRATCH_HANDOFF_NOTE_DEFAULT_DIR } = await import("./per-task-budget.mjs");
  const { emptyRoleProgress } = await import("./phase-stage-checkpoint.mjs");
  const rangeRef = "T1.1 > T1.3";
  const mkOpts = (role) => {
    const roleProgress = emptyRoleProgress();
    roleProgress[role].status = "running";
    return {
      framework: "standalone", mission: "049-x", phaseIndex: 0, phaseNumber: 1,
      phaseName: "P1", phaseTotal: 1, revision: 1, role, phaseTaskDigest: "d",
      deltaDigest: "dd", taskIds: ["a", "b"],
      tasks: [{ text: "**1.1** Do a" }, { text: "**1.2** Do b" }],
      currentTaskId: "a", handoffNoteRef: rangeRef, roleProgress,
    };
  };
  let promptPathsOk = false;
  try {
    const expectedBase = scratchHandoffNotePath(SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, rangeRef).split("/").pop();
    promptPathsOk = ["codeReviewer", "verifier"].every((role) => {
      const built = buildTaskPrompt(mkOpts(role));
      if (!built?.ok) return false;
      const m = /OVERWRITE your hand-off note at (\S+)/.exec(built.text);
      return !!m && String(m[1]).split("/").pop() === expectedBase;
    });
  } catch { promptPathsOk = false; }
  check("049-1.2: read-only prompt scratch path equals the wrap-up scratch path for the same range ref", promptPathsOk);
}

// ── Mission 045: the wrap-up resume is gone; the orchestrator writes ──
// Mission 022 live made every wrap-up skip as `resume_unsupported` when
// the operator chose resume:false. Mission 045 removes the resume entirely:
// no session id, no adapter resume capability, and no second relay turn.
check("wrap-up: no wrap-up resume remains (no adapter resume-capability gate)",
  !/reason:"no_session_id"/.test(src) && !/reason:"resume_unsupported"/.test(src)
  && !/Adapter capability only/.test(src));
check("wrap-up: relay args keep the forceResume plumbing for other resume callers",
  /if\(resume && \(role\.resume \|\| forceResume\)\)\{/.test(src)
  && /buildRelayArgs\(role,a,readOnly,resume,stateForRelay,\{[^}]*forceResume:isWrapUp\}\)/.test(src));

// ── Backlog #27: reset-for-continuations wiring ──
check("reset: continuation scope resolution accepts all three forms",
  /function resetContinuationScope\(s,scopeArg\)/.test(src)
  && /continuationBudgetKey\(scope\)/.test(src)
  && /lastContinuation\?\.scope/.test(src));
check("reset: queued continuation reset applies at all four continuation decisions + standalone code_reviewer capped (031 P4.1) + standalone verifier capped (031 P4.2) + 2 voluntary P4.3 + speckit code_reviewer capped (031 P5.1) + speckit verifier capped (031 P5.2) + 2 speckit voluntary P5.3 + standalone planner capped (031 P6.2) + standalone planner voluntary (031 P6b.1) + 2 standalone plan_reviewer capped (031 P7.1) + standalone plan_reviewer voluntary (031 P7b.1)",
  count(/maybeApplyPendingContinuationReset\(s,contScope\);/g) === 17);
check("reset: escalation records the continuation for bare `ap reset` (all four sites)",
  count(/recordLastContinuation\(s,\{contScope,taskId,missionName:(mission|missionIdentity),taskRef:taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\)\}\)/g) === 4);
check("reset: every not-converging message ends with the exact resume command",
  count(/Resume: ap reset --scope /g) === 19); // 4 not-converging sites + standalone code_reviewer capped (031 P4.1) + standalone verifier capped (031 P4.2) + 2 voluntary P4.3 + speckit code_reviewer capped (031 P5.1) + speckit verifier capped (031 P5.2) + 2 speckit voluntary P5.3 + standalone planner capped (031 P6.2) + standalone planner voluntary (031 P6b.1) + 2 standalone plan_reviewer capped (031 P7.1) + standalone plan_reviewer voluntary (031 P7b.1) + the shared no-progress stop (#32) + planner no-progress stop (031 P6b.2)

// ── Backlog #32: no-progress stop + note-cited code in the brief ──
check("no-progress: checked at all four continuation decisions, after the allowance check (both loops)",
  count(/stopOnNoProgress\(s,c,\{framework:"standalone",contScope,taskId,missionName:mission,taskRef:taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\),touchedFiles:taskImpl\.touchedFiles,checkpoint\}\);\r?\n\s*console\.log\(`Task \$\{taskId\} (?:hit the|stopped voluntarily)/g) === 2
  && count(/stopOnNoProgress\(s,c,\{framework:"speckit",contScope,taskId,missionName:missionIdentity,taskRef:taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\),touchedFiles:taskImpl\.touchedFiles,checkpoint\}\);\r?\n\s*console\.log\(`Task \$\{taskId\} (?:hit the|stopped voluntarily)/g) === 2);
check("no-progress: escalates with its own step and records the continuation",
  /s\.step=step \?\? `\$\{framework\}_task_no_progress`/.test(src)
  && /code:"NO_PROGRESS"/.test(src)
  && /function stopOnNoProgress[\s\S]*?recordLastContinuation\(s,\{contScope,taskId,missionName,taskRef\}\)/.test(src));
check("no-progress: stop message uses the pure noProgressDisplayLabel helper (068 1.2, never task null)",
  /noProgressDisplayLabel,/.test(src)
  && /function stopOnNoProgress[\s\S]{0,2000}?noProgressDisplayLabel\(\{taskId,taskRef,framework\}\)/.test(src)
  && !/function stopOnNoProgress[\s\S]{0,2000}?task \$\{taskId\} changed no file/.test(src));
check("no-progress: `ap reset` of a continuation also clears the counter (idle + queued)",
  /clearNoProgress\(s,contScope\);/.test(src)
  && /if\(s\.noProgressGenerations\) delete s\.noProgressGenerations\[fullKey\];/.test(src));
check("note excerpts: both loops quote the note's cited code into the brief",
  /handoffNoteExcerpts:handoffNoteExcerptsFor\(mission,taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\)\)/.test(src)
  && /handoffNoteExcerpts:handoffNoteExcerptsFor\(missionIdentity,taskDisplayRef\(phaseTasks\[taskIndex\],taskIndex\)\)/.test(src));
check("note excerpts: reads are confined to the repo",
  /function handoffNoteExcerptsFor[\s\S]*?abs!==root && !abs\.startsWith\(root\+path\.sep\)/.test(src));
check("reset: continuation clear drops allowance + dead-ends and keeps the note",
  /delete s\.continuationBudgets\[fullKey\]/.test(src)
  && /delete s\.rolloverDeadEnds\[fullKey\]/.test(src)
  && /notes are never cleared by reset/.test(src));
check("reset: completion clears the recorded continuation (no stale auto-target)",
  count(/clearLastContinuation\(s,`task:(standalone|speckit):phase-/g) === 4);
{
  // Was a bare count of 2; TASK-21's carry-forward replay added one more
  // legitimate clear per loop (a carried task converges without running, so
  // its allowance/dead ends must die with it too). Pinned by call context
  // instead, so a stray or missing clear fails loudly:
  // - converge: after `checkpoint.roleProgress=committed.progress` (real run);
  // - carry: after `checkpoint.roleProgress=carryCommitted.progress` (replay).
  const converge = [...src.matchAll(/checkpoint\.roleProgress=committed\.progress;[\s\S]{0,300}?clearTaskContinuation\(s,`task:(standalone|speckit):phase-/g)];
  const carry = [...src.matchAll(/checkpoint\.roleProgress=carryCommitted\.progress;[\s\S]{0,200}?clearTaskContinuation\(s,`task:(standalone|speckit):phase-/g)];
  const pairs = [...src.matchAll(/clearTaskContinuation\(s,`task:([^`]+)`\);\s+clearRolloverDeadEnds\(s,`task:\1`\)/g)];
  const frameworks = (list) => JSON.stringify([...new Set(list.map((m) => m[1]))].sort());
  check("loops: allowance cleared on task success (converge × both loops)",
    converge.length === 2 && frameworks(converge) === `["speckit","standalone"]`,
    converge.map((m) => m[1]));
  check("loops: allowance cleared on task success (carry-forward × both loops)",
    carry.length === 2 && frameworks(carry) === `["speckit","standalone"]`,
    carry.map((m) => m[1]));
  check("loops: dead ends cleared wherever the allowance is (same scope, 4 sites)",
    pairs.length === 4, pairs.length);
}
check("loops: dead-ends transfer read at prompt build", count(/deadEnds:readRolloverDeadEnds\(s,`task:(standalone|speckit):phase-/g) === 2);

// ── Independence guard: continuation keys never touch failureBudgets ──
check("budgets: continuation consumed via the independent ledger module",
  /from "\.\/per-task-budget\.mjs"/.test(src) && src.includes("consumeContinuation"));
{
  const blocks = src.split("if(taskImpl.capped){").slice(1).map(b => b.slice(0, 2000));
  check("budgets: no failure-budget call inside either capped block",
    blocks.length === 2 && blocks.every(b => !/failureBudget|recordFailureBudget|enforceAttemptFailure/.test(b)), blocks.length);
}

// ── Mission 031 phase 3 task 3.5: INCOMPLETE-as-FAIL (no continuation) ──
check("incomplete: GSD/final-review paths name INCOMPLETE-as-FAIL explicitly",
  src.includes("INCOMPLETE-as-FAIL (no continuation): gsd-plan-final-review")
  && src.includes("INCOMPLETE-as-FAIL (no continuation): gsd-loop-final-review")
  && src.includes("INCOMPLETE-as-FAIL (no continuation): standalone-early-final-review")
  && src.includes("INCOMPLETE-as-FAIL (no continuation): standalone-final-review")
  && src.includes("INCOMPLETE-as-FAIL (no continuation): speckit-final-review"));
check("incomplete: speckit plan_reviewer initial + re-review name INCOMPLETE-as-FAIL explicitly",
  src.includes("INCOMPLETE-as-FAIL (no continuation): speckit-gate-initial-review")
  && src.includes("INCOMPLETE-as-FAIL (no continuation): speckit-gate-re-review"));
check("incomplete: existing-planning plan_reviewer names INCOMPLETE-as-FAIL explicitly",
  src.includes("INCOMPLETE-as-FAIL (no continuation): existing-planning-review"));
{
  const parts = src.split("INCOMPLETE-as-FAIL (no continuation)").slice(1);
  check("incomplete: no continuation consumed at INCOMPLETE-as-FAIL sites (8 sites)",
    parts.length === 8 && parts.every((p) => !p.slice(0, 600).includes("consumeContinuation")),
    parts.length);
  check("incomplete: failure budget unchanged at INCOMPLETE-as-FAIL sites",
    parts.length === 8 && parts.every((p) => !p.slice(0, 600).includes("recordFailureBudget(")),
    parts.length);
}

// ── Mission 031 phase 4 task 4.1: standalone code_reviewer continuation ──
// (031 P5.1 adds the SpecKit twin, so the positional-capEnabled and capped-
// branch totals below cover both loops; per-loop partitioning is pinned in
// the P5.1 block further down.)
check("031 P4.1: standalone code_reviewer review() passes capEnabled (positional true, 1 site)",
  count(/reviewBudget\.timeoutMs,true[,)]/g) === 2);
check("031 P4.1: code_reviewer capped branch consumes explicit continuationAllowance (4 sites: standalone capped + voluntary P4.3 + speckit capped P5.1 + speckit voluntary P5.3)",
  count(/consumeContinuation\(s,c\.policy,contScope,resolvePerRoleLimits\('code_reviewer',c\.policy\)\.continuationAllowance\)/g) === 4);
check("031 P4.1: code_reviewer continuation scope is per-phase (standalone:phase code_reviewer)",
  src.includes("task:standalone:phase-${s.phaseIndex}:code_reviewer"));
check("031 P4.1: standalone code_reviewer capped branch exists (1 site standalone, 2 total with P5.1)",
  count(/if\(rv\.capped\)\{/g) === 2);
{
  const parts = src.split("if(rv.capped){").slice(1);
  check("031 P4.1: no failure-budget call inside the code_reviewer capped blocks",
    parts.length === 2 && parts.every((p) => !/failureBudget|recordFailureBudget|enforceAttemptFailure/.test(p.slice(0, 2500))), parts.length);
  check("031 P4.1: exhaustion records the continuation for bare `ap reset` at the review site",
    parts.length === 2 && parts.every((p) => /recordLastContinuation\(s,\{contScope,taskId:null,missionName:(mission|missionIdentity),taskRef:reviewRef\}\)/.test(p.slice(0, 4000))));
}

// ── Mission 031 phase 5 task 5.1: SpecKit code_reviewer continuation ──
{
  // runStandaloneImplementation is defined before runImplementation (which
  // holds the SpecKit twin), so the standalone region is everything before
  // the SpecKit loop's function boundary.
  const standalonePart = src.split("async function runImplementation(c){")[0];
  const speckitPart = src.split("async function runImplementation(c){")[1] ?? "";
  check("031 P5.1: speckit code_reviewer review() passes capEnabled (positional true, 1 site, speckit only)",
    (speckitPart.match(/reviewBudget\.timeoutMs,true[,)]/g) ?? []).length === 1
    && (standalonePart.match(/reviewBudget\.timeoutMs,true[,)]/g) ?? []).length === 1);
  check("031 P5.1: code_reviewer continuation scope is per-phase (speckit:phase code_reviewer)",
    src.includes("task:speckit:phase-${s.phaseIndex}:code_reviewer"));
  check("031 P5.1: speckit code_reviewer capped branch consumes explicit continuationAllowance",
    /const contScope=`task:speckit:phase-\$\{s\.phaseIndex\}:code_reviewer`[\s\S]{0,500}?consumeContinuation\(s,c\.policy,contScope,resolvePerRoleLimits\('code_reviewer',c\.policy\)\.continuationAllowance\)/.test(speckitPart));
  check("031 P5.1: speckit code_reviewer capped branch escalates as not-converging",
    /SpecKit code review did not converge after/.test(speckitPart)
    && speckitPart.includes('s.step="speckit_task_not_converging"'));
}

// ── Mission 031 phase 5 task 5.2: SpecKit verifier continuation ──
{
  const standalonePart = src.split("async function runImplementation(c){")[0];
  const speckitPart = src.split("async function runImplementation(c){")[1] ?? "";
  check("031 P5.2: speckit verifier relayAsync passes capEnabled:true (1 site, speckit only)",
    (speckitPart.match(/relayAsync\("verifier",[\s\S]{0,4000}?capEnabled:true/g) ?? []).length === 1
    && (standalonePart.match(/relayAsync\("verifier",[\s\S]{0,4000}?capEnabled:true/g) ?? []).length === 1);
  check("031 P5.2: verifier continuation scope is per-phase (speckit:phase verifier)",
    src.includes("task:speckit:phase-${s.phaseIndex}:verifier"));
  check("031 P5.2: speckit verifier capped branch consumes explicit continuationAllowance",
    /const contScope=`task:speckit:phase-\$\{s\.phaseIndex\}:verifier`[\s\S]{0,500}?consumeContinuation\(s,c\.policy,contScope,resolvePerRoleLimits\('verifier',c\.policy\)\.continuationAllowance\)/.test(speckitPart));
  check("031 P5.2: speckit verifier capped branch escalates as not-converging",
    /SpecKit verification did not converge after/.test(speckitPart)
    && speckitPart.includes('s.step="speckit_task_not_converging"'));
}

// ── Mission 031 phase 5 task 5.3: voluntary early stop (INCOMPLETE) SpecKit review roles ──
{
  const standalonePart = src.split("async function runImplementation(c){")[0];
  const speckitPart = src.split("async function runImplementation(c){")[1] ?? "";
  check("031 P5.3: voluntary incomplete stop consumes continuation at both review roles (rv + vv sites, speckit only)",
    (speckitPart.match(/parseIncompleteSignal\(rv\.review \?\? rv\)/g) ?? []).length === 1
    && (speckitPart.match(/parseIncompleteSignal\(vv\.review \?\? vv\)/g) ?? []).length === 1
    && (standalonePart.match(/parseIncompleteSignal\(rv\.review \?\? rv\)/g) ?? []).length === 1
    && (standalonePart.match(/parseIncompleteSignal\(vv\.review \?\? vv\)/g) ?? []).length === 1);
  check("031 P5.3: speckit voluntary stops record a dead end with reason incomplete (reviewer + verifier sites)",
    (speckitPart.match(/reason:"incomplete",used:null,limit:null,tail:deadEndTail\(\{summary:`(Code review|Verification) incomplete/g) ?? []).length === 2);
  check("031 P5.3: speckit review roles consume explicit continuationAllowance at capped + voluntary sites (2 each)",
    (speckitPart.match(/consumeContinuation\(s,c\.policy,contScope,resolvePerRoleLimits\('code_reviewer',c\.policy\)\.continuationAllowance\)/g) ?? []).length === 2
    && (speckitPart.match(/consumeContinuation\(s,c\.policy,contScope,resolvePerRoleLimits\('verifier',c\.policy\)\.continuationAllowance\)/g) ?? []).length === 2);
  {
    const parts = speckitPart.split(/parseIncompleteSignal\((rv\.review \?\? rv|vv\.review \?\? vv)\)/).slice(1);
    check("031 P5.3: no failure-budget call inside either speckit voluntary stop block",
      parts.length >= 2 && parts.every((p) => !p.slice(0, 2500).includes("failureBudget") && !p.slice(0, 2500).includes("recordFailureBudget(") && !p.slice(0, 2500).includes("enforceAttemptFailure")), parts.length);
    const rvVol = speckitPart.indexOf("parseIncompleteSignal(rv.review ?? rv)");
    const rvPass = speckitPart.indexOf('rv.status==="completed"&&rv.review?.decision==="PASS"', rvVol);
    const vvVol = speckitPart.indexOf("parseIncompleteSignal(vv.review ?? vv)");
    const vvPass = speckitPart.indexOf("g.ok&&vv.status", vvVol);
    check("031 P5.3: speckit voluntary stops precede PASS/FAIL handling (INCOMPLETE skips FAIL routing)",
      rvVol !== -1 && vvVol !== -1 && rvVol < rvPass && vvVol < vvPass);
  }
  check("031 P5.3: speckit voluntary stops escalate as not-converging with the resume command",
    (speckitPart.match(/SpecKit code review did not converge after \$\{cont\.used\} generations \(last generation stopped voluntarily as incomplete\)\. STOP — human intervention required\.\\nResume: ap reset --scope/g) ?? []).length === 1
    && (speckitPart.match(/SpecKit verification did not converge after \$\{cont\.used\} generations \(last generation stopped voluntarily as incomplete\)\. STOP — human intervention required\.\\nResume: ap reset --scope/g) ?? []).length === 1
    && speckitPart.includes('s.step="speckit_task_not_converging"'));
}

// ── Mission 031 phase 5 task 5.4, exempted by mission 068 phase 1 task 1.2 ──
// Read-only SpecKit review roles never escalate standalone_task_no_progress
// (or the SpecKit twin): the capped/voluntary branches continue as the next
// generation. The helper and its import stay (plan_reviewer sites still use
// them until 068 task 1.3); the resume-hint text is unchanged.
{
  const speckitPart = src.split("async function runImplementation(c){")[1] ?? "";
  check("031 P5.4: stopOnNoProgress NOT called for code_reviewer (read-only exempt, 068 1.2)",
    (speckitPart.match(/stopOnNoProgress\(s,c,\{framework:"speckit",contScope,taskId:null,missionName:missionIdentity,taskRef:reviewRef,touchedFiles:reviewNoProgressTouchedFiles\(missionIdentity,reviewRef,contScope,s\),checkpoint\}\)/g) ?? []).length === 0);
  check("031 P5.4: stopOnNoProgress NOT called for verifier (read-only exempt, 068 1.2)",
    (speckitPart.match(/stopOnNoProgress\(s,c,\{framework:"speckit",contScope,taskId:null,missionName:missionIdentity,taskRef:verifyRef,touchedFiles:reviewNoProgressTouchedFiles\(missionIdentity,verifyRef,contScope,s\),checkpoint\}\)/g) ?? []).length === 0);
  check("031 P5.4: exempt branches keep the resume hint and continue as next generation",
    (speckitPart.match(/continuing as session \$\{cont\.used\+1\} of \$\{cont\.limit\+1\}/g) ?? []).length >= 4
    && (speckitPart.match(/Resume: ap reset --scope \$\{contScope\} then ap run/g) ?? []).length >= 4);
}
{
  const { parseFoundEntries } = await import("./standalone-handoff.mjs");
  check("031 P5.4: read-only generation with new Found entries does not count as no-progress (growth)",
    parseFoundEntries("## Found\n- a — ok\n- b — ok\n") > parseFoundEntries("## Found\n- a — ok\n"));
  check("031 P5.4: no note exists = no progress (empty note counts zero)",
    parseFoundEntries("") === 0 && parseFoundEntries("(none)") === 0
    && parseFoundEntries("## Found\n(none)\n") === 0);
}

// ── Mission 031 phase 5 task 5.5: wrap-up fallback for SpecKit review roles ──
{
  const speckitPart = src.split("async function runImplementation(c){")[1] ?? "";
  check("031 P5.5: speckit code_reviewer passes capEnabled so capBreach.wrapUp reaches the orchestrator fallback",
    (speckitPart.match(/reviewBudget\.timeoutMs,true[,)]/g) ?? []).length === 1);
  check("031 P5.5: speckit verifier passes capEnabled:true so capBreach.wrapUp reaches the orchestrator fallback",
    (speckitPart.match(/relayAsync\("verifier",[\s\S]{0,4000}?capEnabled:true/g) ?? []).length === 1);
  check("031 P5.5: wrap-up gate uses capEnabled (reachable for speckit review roles), not roleName===implementer",
    /if\(capEnabled && !isWrapUp && capBreach\?\.wrapUp && result\.capped\)\{/.test(src)
    && !/if\(roleName==="implementer" && !isWrapUp && capBreach\?\.wrapUp && result\.capped\)/.test(src));
  check("031 P5.5: wrapupCeilingDriver still guards the wrap-up ceiling path (isWrapUp && capEnabled)",
    /const wrapupCeilingDriver=\(isWrapUp && capEnabled\)\?adapterDriver\(role\.adapter\):null;/.test(src));
  check("031 P5.5: non-implementer breach takes the orchestrator fallback (review roles included)",
    /buildOrchestratorFallbackNote\(taskRef,events,role\.adapter,repo,diffStat,capBreach,sessionPaths\)/.test(src)
    && /status:"orchestrator_fallback",reason:"note_missing_or_stale",trigger:capBreach\.trigger\|\|null,note:noteRel,fallbackNote:true/.test(src)
    && !/buildWrapUpPrompt\(noteRel,noteMaxChars\)/.test(src)
    && !/runNote:"wrap-up"/.test(src));
}
{
  const { buildReviewWrapUpPrompt } = await import("./standalone-handoff.mjs");
  const cr = buildReviewWrapUpPrompt("code_reviewer", { taskRef: "task:speckit:phase-0:code_reviewer" });
  const vf = buildReviewWrapUpPrompt("verifier", { taskRef: "task:speckit:phase-0:verifier" });
  check("031 P5.5: review wrap-up template renders for code_reviewer and verifier (Found + Next sections)",
    /Found/.test(cr) && /Next/.test(cr) && /Found/.test(vf) && /Next/.test(vf));
}

// ── Mission 031 phase 4 task 4.2: standalone verifier continuation ──
{
  // runStandaloneImplementation is defined before runImplementation (which
  // holds the SpecKit twin), so the standalone region is everything before
  // the SpecKit loop's function boundary.
  const standalonePart = src.split("async function runImplementation(c){")[0];
  const speckitPart = src.split("async function runImplementation(c){")[1] ?? "";
  check("031 P4.2: verifier relayAsync passes capEnabled:true (2 sites: standalone + speckit P5.2)",
    count(/relayAsync\("verifier",[\s\S]{0,4000}?capEnabled:true/g) === 2
    && /relayAsync\("verifier",[\s\S]{0,4000}?capEnabled:true/.test(standalonePart)
    && /relayAsync\("verifier",[\s\S]{0,4000}?capEnabled:true/.test(speckitPart));
}
check("031 P4.2: verifier capped branch consumes explicit continuationAllowance (4 sites: capped + voluntary P4.3 + speckit P5.2 + speckit voluntary P5.3)",
  count(/consumeContinuation\(s,c\.policy,contScope,resolvePerRoleLimits\('verifier',c\.policy\)\.continuationAllowance\)/g) === 4);
check("031 P4.2: verifier continuation scope is per-phase (standalone:phase verifier)",
  src.includes("task:standalone:phase-${s.phaseIndex}:verifier"));
check("031 P4.2: verifier capped branch exists (2 sites: standalone + speckit P5.2)",
  count(/if\(vv\.capped\)\{/g) === 2);
{
  const parts = src.split("if(vv.capped){").slice(1);
  check("031 P4.2: no failure-budget call inside the verifier capped blocks",
    parts.length === 2 && parts.every((p) => !/failureBudget|recordFailureBudget|enforceAttemptFailure/.test(p.slice(0, 2500))), parts.length);
  check("031 P4.2: exhaustion records the continuation for bare `ap reset` at the verify sites",
    parts.length === 2 && parts.every((p) => /recordLastContinuation\(s,\{contScope,taskId:null,missionName:(mission|missionIdentity),taskRef:verifyRef\}\)/.test(p.slice(0, 4000))));
}

// ── Mission 031 phase 4 task 4.3: voluntary early stop (INCOMPLETE) standalone review roles ──
check("031 P4.3: voluntary incomplete stop consumes continuation at both review roles (rv + vv sites)",
  count(/parseIncompleteSignal\(rv\.review \?\? rv\)/g) >= 1
  && count(/parseIncompleteSignal\(vv\.review \?\? vv\)/g) >= 1);
  check("031 P4.3: voluntary stops record a dead end with reason incomplete (reviewer + verifier sites)",
    (src.match(/reason:"incomplete",used:null,limit:null,tail:deadEndTail\(\{summary:`(Code review|Verification) incomplete/g) ?? []).length === 4);
{
  const parts = src.split(/parseIncompleteSignal\((rv\.review \?\? rv|vv\.review \?\? vv)\)/).slice(1);
  check("031 P4.3: no failure-budget call inside either voluntary stop block",
    parts.length >= 2 && parts.every((p) => !p.slice(0, 2500).includes("failureBudget") && !p.slice(0, 2500).includes("recordFailureBudget(") && !p.slice(0, 2500).includes("enforceAttemptFailure")), parts.length);
  const rvVol = src.indexOf("parseIncompleteSignal(rv.review ?? rv)");
  const rvPass = src.indexOf('rv.status==="completed"&&rv.review?.decision==="PASS"', rvVol);
  const vvVol = src.indexOf("parseIncompleteSignal(vv.review ?? vv)");
  const vvPass = src.indexOf("g.ok&&vv.status", vvVol);
  check("031 P4.3: voluntary stops precede PASS/FAIL handling (INCOMPLETE skips FAIL routing)",
    rvVol !== -1 && vvVol !== -1 && rvVol < rvPass && vvVol < vvPass);
}

// ── Mission 031 phase 4 task 4.4: no-progress stop for standalone review roles ──
{
  const standalonePart = src.split("async function runImplementation(c){")[0];
  check("031 P4.4: parseFoundEntries imported for review no-progress signal",
    /parseFoundEntries/.test(src) && src.includes('from "./standalone-handoff.mjs"'));
  check("031 P4.4: reviewNoProgressTouchedFiles helper defined (Found-count signal, no note = no progress)",
    /function reviewNoProgressTouchedFiles\(missionName, taskRef, contScope, s\)/.test(src)
    && /if\(!note\) return \[\];/.test(src)
    && /parseFoundEntries\(note\)/.test(src));
  check("031 P4.4: no-progress escalates with step ${framework}_task_no_progress",
    src.includes("s.step=step ?? `${framework}_task_no_progress`"));
  check("031 P4.4: stopOnNoProgress NOT called for code_reviewer (read-only exempt, 068 1.2)",
    (standalonePart.match(/stopOnNoProgress\(s,c,\{framework:"standalone",contScope,taskId:null,missionName:mission,taskRef:reviewRef,touchedFiles:reviewNoProgressTouchedFiles\(mission,reviewRef,contScope,s\),checkpoint\}\)/g) ?? []).length === 0);
  check("031 P4.4: stopOnNoProgress NOT called for verifier (read-only exempt, 068 1.2)",
    (standalonePart.match(/stopOnNoProgress\(s,c,\{framework:"standalone",contScope,taskId:null,missionName:mission,taskRef:verifyRef,touchedFiles:reviewNoProgressTouchedFiles\(mission,verifyRef,contScope,s\),checkpoint\}\)/g) ?? []).length === 0);
  check("031 P4.4: exempt branches keep the resume hint and continue as next generation",
    (standalonePart.match(/continuing as session \$\{cont\.used\+1\} of \$\{cont\.limit\+1\}/g) ?? []).length >= 4
    && (standalonePart.match(/Resume: ap reset --scope \$\{contScope\} then ap run/g) ?? []).length >= 4);
}
{
  const { parseFoundEntries } = await import("./standalone-handoff.mjs");
  check("031 P4.4: new Found entries count as progress (1 -> 2 grows)",
    parseFoundEntries("## Found\n- a — ok\n") === 1
    && parseFoundEntries("## Found\n- a — ok\n- b — ok\n") === 2);
  check("031 P4.4: read-only generation with new Found entries does not count as no-progress (growth)",
    parseFoundEntries("## Found\n- a — ok\n- b — ok\n") > parseFoundEntries("## Found\n- a — ok\n"));
  check("031 P4.4: no note exists = no progress (empty note counts zero)",
    parseFoundEntries("") === 0 && parseFoundEntries("(none)") === 0
    && parseFoundEntries("## Found\n(none)\n") === 0);
}

// ── Mission 031 phase 4 task 4.5: wrap-up fallback for review roles ──
check("031 P4.5: wrap-up gate uses capEnabled, not roleName===implementer",
  /if\(capEnabled && !isWrapUp && capBreach\?\.wrapUp && result\.capped\)\{/.test(src)
  && !/if\(roleName==="implementer" && !isWrapUp && capBreach\?\.wrapUp && result\.capped\)/.test(src));
check("031 P4.5: non-implementer breach takes the orchestrator fallback for every role",
  /buildOrchestratorFallbackNote\(taskRef,events,role\.adapter,repo,diffStat,capBreach,sessionPaths\)/.test(src)
  && /status:"orchestrator_fallback",reason:"note_missing_or_stale",trigger:capBreach\.trigger\|\|null,note:noteRel,fallbackNote:true/.test(src)
  && !/buildWrapUpPrompt\(noteRel,noteMaxChars\)/.test(src)
  && !/roleName==="implementer"\?buildWrapUpPrompt/.test(src));
check("031 P4.5: wrap-up note path stays the shared mission handoff path",
  /const noteRel=\(wrapMission && taskRef\)\?handoffNoteRelPath\(wrapMission,taskRef\):null;/.test(src)
  && /fs\.writeFileSync\(path\.join\(repo,noteRel\),fallbackNote\)/.test(src));

// ── Mission 031 phase 6 task 6.2: standalone planner capped continuation ──
{
  const standalonePlanningPart = (src.split("async function runStandalonePlanning")[1] ?? "").split("async function runSpecKitPlanning")[0] ?? "";
  const afterStandalonePlanning = src.split("async function runSpecKitPlanning")[1] ?? "";
  check("031 P6.2: standalone planning planner relayAsync passes capEnabled:true (1 site, standalone planning only)",
    callsWithOptions(standalonePlanningPart, 'relayAsync("planner",', ["capEnabled:true"]).length === 1
    && callsWithOptions(afterStandalonePlanning, 'relayAsync("planner",', ["capEnabled:true"]).length === 0
    && !/relay\("planner",[^\n]*capEnabled:true/.test(src));
  check("031 P6.2: standalone planning planner passes taskRef 'standalone-planning-planner'",
    callsWithOptions(standalonePlanningPart, 'relayAsync("planner",', PLANNER_OPTS).length >= 1);
  check("031 P6.2: planner capped branch calls the planning-continuation helper (capped trigger)",
    /if\(planner\.capped\)\{/.test(standalonePlanningPart)
    && standalonePlanningPart.includes("handlePlanningContinuation(s,'planner',planner,'task:standalone:planning:planner',c.policy,'capped')"));
  check("031 P6.2: planning-continuation helper imported (dead end recorded via the helper)",
    /from "\.\/planning-continuation\.mjs"/.test(src) && src.includes("handlePlanningContinuation"));
  check("031 P6.2: planner continuation scope uses the fixed planning taskRef (note path non-null via taskRef)",
    standalonePlanningPart.includes("task:standalone:planning:planner")
    && /recordLastContinuation\(s,\{contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-planner'\}\)/.test(standalonePlanningPart));
}

// ── Mission 031 phase 6 task 6b.1: standalone planner voluntary early-stop continuation ──
{
  const standalonePlanningPart = (src.split("async function runStandalonePlanning")[1] ?? "").split("async function runSpecKitPlanning")[0] ?? "";
  check("031 P6b.1: planner voluntary stop checks parsePlanningIncompleteSignal on finalMessage",
    /parsePlanningIncompleteSignal\(planner\.finalMessage \?\? planner\)/.test(standalonePlanningPart));
  check("031 P6b.1: planner voluntary stop continuation uses the planning-continuation helper (incomplete trigger)",
    standalonePlanningPart.includes("handlePlanningContinuation(s,'planner',planner,'task:standalone:planning:planner',c.policy,'incomplete')"));
  check("031 P6b.1: planner voluntary stop escalation records the continuation with the fixed planning taskRef",
    /stopped voluntarily as incomplete/.test(standalonePlanningPart)
    && /recordLastContinuation\(s,\{contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-planner'\}\)/.test(standalonePlanningPart));
}

// ── Mission 031 phase 6 task 6b.2: planner no-progress stop in planning loop ──
{
  const standalonePlanningPart = (src.split("async function runStandalonePlanning")[1] ?? "").split("async function runSpecKitPlanning")[0] ?? "";
  check("031 P6b.2: stopOnNoProgress called for planner after continuation check (capped + incomplete, 2 sites)",
    (standalonePlanningPart.match(/stopOnNoProgress\(s,c,\{framework:"standalone",contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-planner',touchedFiles:planningNoProgressTouchedFiles\(file,tasksFile,contScope,s\),checkpoint:s\[CHECKPOINT_STATE_KEY\],step:"standalone_planning_no_progress"\}\)/g) ?? []).length >= 2);
  check("031 P6b.2: planner no-progress uses role-appropriate signal (PLAN/TASKS digest, not touchedFiles)",
    standalonePlanningPart.includes("planningNoProgressTouchedFiles(file,tasksFile,contScope,s)")
    && !/stopOnNoProgress\(s,c,\{framework:"standalone",contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-planner',touchedFiles(?!:planningNoProgressTouchedFiles)/.test(standalonePlanningPart));
  check("031 P6b.2: planner no-progress escalates with step standalone_planning_no_progress",
    (standalonePlanningPart.match(/step:"standalone_planning_no_progress"/g) ?? []).length >= 2);
  const capIdx = standalonePlanningPart.indexOf("handlePlanningContinuation(s,'planner',planner,'task:standalone:planning:planner',c.policy,'capped')");
  const capNoProg = standalonePlanningPart.indexOf("planningNoProgressTouchedFiles(file,tasksFile,contScope,s)");
  const incIdx = standalonePlanningPart.indexOf("handlePlanningContinuation(s,'planner',planner,'task:standalone:planning:planner',c.policy,'incomplete')");
  const incNoProg = standalonePlanningPart.lastIndexOf("planningNoProgressTouchedFiles(file,tasksFile,contScope,s)");
  check("031 P6b.2: planner no-progress checks run after the continuation check",
    capIdx !== -1 && incIdx !== -1 && capNoProg > capIdx && incNoProg > incIdx);
  check("031 P6b.2: planner no-progress escalation text is planner-appropriate (PLAN.md/TASKS.md, not task null)",
    /step==="standalone_planning_no_progress"/.test(src)
    && /Standalone planner made no PLAN\.md\/TASKS\.md change in/.test(src)
    && /Resume: ap reset --scope/.test(src));
}
{
  const { planningNoProgressTouchedFiles, planningArtifactDigest } = await import("./planning-continuation.mjs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-noprog-"));
  const planFile = path.join(dir, "PLAN.md");
  const tasksFile = path.join(dir, "TASKS.md");
  const scope = "task:standalone:planning:planner";
  const s = {};
  fs.writeFileSync(planFile, "plan v1");
  fs.writeFileSync(tasksFile, "tasks v1");
  const first = planningNoProgressTouchedFiles(planFile, tasksFile, scope, s);
  check("031 P6b.2: first sighting with artifacts counts as progress (establishes baseline)",
    Array.isArray(first) && first.length > 0 && planningArtifactDigest(planFile, tasksFile) !== null);
  check("031 P6b.2: unchanged PLAN/TASKS counts as no progress (empty signal)",
    planningNoProgressTouchedFiles(planFile, tasksFile, scope, s).length === 0);
  fs.writeFileSync(tasksFile, "tasks v2 — revised");
  check("031 P6b.2: PLAN/TASKS mtime/hash change counts as progress",
    planningNoProgressTouchedFiles(planFile, tasksFile, scope, s).length > 0);
  fs.rmSync(planFile, { force: true });
  fs.rmSync(tasksFile, { force: true });
  check("031 P6b.2: missing PLAN/TASKS counts as no progress (empty signal)",
    planningNoProgressTouchedFiles(planFile, tasksFile, {}, s).length === 0
    && planningArtifactDigest(planFile, tasksFile) === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Mission 031 phase 6 task 6.4: planner wrap-up fallback in planning loop ──
{
  const standalonePlanningPart = (src.split("async function runStandalonePlanning")[1] ?? "").split("async function runSpecKitPlanning")[0] ?? "";
  check("031 P6.4: wrap-up gate uses capEnabled (reachable for planner), not roleName===implementer",
    /if\(capEnabled && !isWrapUp && capBreach\?\.wrapUp && result\.capped\)\{/.test(src)
    && !/if\(roleName==="implementer" && !isWrapUp && capBreach\?\.wrapUp && result\.capped\)/.test(src));
  check("031 P6.4: standalone planning planner passes capEnabled so capBreach.wrapUp reaches the orchestrator fallback (wrap-up reachable)",
    callsWithOptions(standalonePlanningPart, 'relayAsync("planner",', PLANNER_OPTS).length >= 1);
  check("031 P6.4: planner wrap-up note path non-null via fixed taskRef (shared mission handoff path)",
    standalonePlanningPart.includes("'standalone-planning-planner'")
    && /const noteRel=\(wrapMission && taskRef\)\?handoffNoteRelPath\(wrapMission,taskRef\):null;/.test(src));
  check("031 P6.4: planner wrap-up is the orchestrator fallback (all roles, no resume)",
    /buildOrchestratorFallbackNote\(taskRef,events,role\.adapter,repo,diffStat,capBreach,sessionPaths\)/.test(src)
    && /status:"orchestrator_fallback",reason:"note_missing_or_stale",trigger:capBreach\.trigger\|\|null,note:noteRel,fallbackNote:true/.test(src)
    && !/buildWrapUpPrompt\(noteRel,noteMaxChars\)/.test(src));
}
{
  const { buildReviewWrapUpPrompt } = await import("./standalone-handoff.mjs");
  const pl = buildReviewWrapUpPrompt("planner", { taskRef: "task:standalone:planning:planner" });
  check("031 P6.4: planner wrap-up template renders planning Found + Next sections",
    /Found/.test(pl) && /Next/.test(pl) && /PLAN\.md\/TASKS\.md/.test(pl));
}

// ── Mission 031 phase 7 task 7.1: standalone plan_reviewer capped continuation ──
{
  const standalonePlanningPart = (src.split("async function runStandalonePlanning")[1] ?? "").split("async function runSpecKitPlanning")[0] ?? "";
  check("031 P7.1: standalone planning plan_reviewer relayAsync passes capEnabled:true (2 sites: initial + retry, standalone planning only)",
    callsWithOptions(standalonePlanningPart, 'relayAsync("plan_reviewer",', REVIEWER_OPTS).length === 2
    && callsWithOptions(src, 'relayAsync("plan_reviewer",', ["capEnabled:true"]).length === 2);
  check("031 P7.1: plan_reviewer capped branch calls the planning-continuation helper (capped trigger, pre- and post-retry)",
    (standalonePlanningPart.match(/handlePlanningContinuation\(s,'plan_reviewer',reviewResult,'task:standalone:planning:plan_reviewer',c\.policy,'capped'\)/g) ?? []).length === 2);
  check("031 P7.1: pre-helper capped check runs before the retry helper (capped marker never reaches the failure budget)",
    standalonePlanningPart.indexOf("if(reviewResult.capped){") !== -1
    && standalonePlanningPart.indexOf("if(reviewResult.capped){") < standalonePlanningPart.indexOf("resolvePlanningReviewAttempt(c,s,\"standalone-plan-review\""));
  check("031 P7.1: plan_reviewer continuation scope uses the fixed planning taskRef (note path non-null via taskRef)",
    standalonePlanningPart.includes("task:standalone:planning:plan_reviewer")
    && (standalonePlanningPart.match(/recordLastContinuation\(s,\{contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-plan_reviewer'\}\)/g) ?? []).length === 3);
  check("031 P7.1: capped plan_reviewer resumes at the reviewer (skipPlannerFirst=true before continue, all branches incl. P7b.1 voluntary)",
    (standalonePlanningPart.match(/skipPlannerFirst=true;\s*\n\s*continue;/g) ?? []).length === 3);
  check("031 P7.1: review prompt quotes the plan_reviewer wrap-up handoff note (reviewer resumes where it stopped)",
    /readHandoffNote\(mission,'standalone-planning-plan_reviewer'\)/.test(standalonePlanningPart)
    && /Prior reviewer handoff note/.test(standalonePlanningPart));
  check("031 P7.1: non-capped reviewer outcome clears the plan_reviewer handoff note (no stale continue-from-where-it-stopped)",
    /clearHandoffNote\(mission,'standalone-planning-plan_reviewer'\)/.test(standalonePlanningPart));
}

// ── Mission 031 phase 7 task 7b.1: plan_reviewer voluntary early-stop continuation ──
{
  const standalonePlanningPart = (src.split("async function runStandalonePlanning")[1] ?? "").split("async function runSpecKitPlanning")[0] ?? "";
  check("031 P7b.1: plan_reviewer voluntary stop checks parseIncompleteSignal on the review result",
    /parseIncompleteSignal\(reviewResult\.review \?\? reviewResult\)/.test(standalonePlanningPart));
  check("031 P7b.1: plan_reviewer voluntary stop continuation uses the planning-continuation helper (incomplete trigger)",
    standalonePlanningPart.includes("handlePlanningContinuation(s,'plan_reviewer',reviewResult,'task:standalone:planning:plan_reviewer',c.policy,'incomplete')"));
  check("031 P7b.1: plan_reviewer voluntary stop escalation records the continuation with the fixed planning taskRef",
    /stopped early \(incomplete\)/.test(standalonePlanningPart)
    && /recordLastContinuation\(s,\{contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-plan_reviewer'\}\)/.test(standalonePlanningPart));
  {
    const parts = standalonePlanningPart.split("parseIncompleteSignal(reviewResult.review ?? reviewResult)").slice(1);
    check("031 P7b.1: no failure-budget call inside the plan_reviewer voluntary stop block",
      parts.length >= 1 && parts.every((p) => !p.slice(0, 2500).includes("failureBudget") && !p.slice(0, 2500).includes("recordFailureBudget(") && !p.slice(0, 2500).includes("enforceAttemptFailure")), parts.length);
    const volIdx = standalonePlanningPart.indexOf("parseIncompleteSignal(reviewResult.review ?? reviewResult)");
    const retryIdx = standalonePlanningPart.indexOf('resolvePlanningReviewAttempt(c,s,"standalone-plan-review"');
    const passIdx = standalonePlanningPart.indexOf('reviewResult.review?.decision==="PASS"', volIdx);
    check("031 P7b.1: plan_reviewer voluntary stop precedes retry helper and PASS/FAIL handling (INCOMPLETE skips FAIL routing)",
      volIdx !== -1 && retryIdx !== -1 && passIdx !== -1 && volIdx < retryIdx && volIdx < passIdx);
  }
}
{
  const { handlePlanningContinuation, readRolloverDeadEnds } = await import("./planning-continuation.mjs");
  const s = {};
  const cont = handlePlanningContinuation(s, "plan_reviewer", { review: { decision: "INCOMPLETE" } }, "task:standalone:planning:plan_reviewer", {}, "incomplete");
  check("031 P7b.1: review result carrying the incomplete signal consumes a continuation and bypasses failure budget",
    !!cont && cont.allowed === true && readRolloverDeadEnds(s, "task:standalone:planning:plan_reviewer").some((d) => d.reason === "incomplete")
    && !("failureBudgets" in s));
}

// ── Mission 031 phase 7 task 7.3: plan_reviewer wrap-up fallback in planning loop ──
{
  const standalonePlanningPart = (src.split("async function runStandalonePlanning")[1] ?? "").split("async function runSpecKitPlanning")[0] ?? "";
  check("031 P7.3: wrap-up gate uses capEnabled (reachable for plan_reviewer), not roleName===implementer",
    /if\(capEnabled && !isWrapUp && capBreach\?\.wrapUp && result\.capped\)\{/.test(src)
    && !/if\(roleName==="implementer" && !isWrapUp && capBreach\?\.wrapUp && result\.capped\)/.test(src));
  check("031 P7.3: standalone planning plan_reviewer passes capEnabled so capBreach.wrapUp reaches the orchestrator fallback (wrap-up reachable)",
    callsWithOptions(standalonePlanningPart, 'relayAsync("plan_reviewer",', REVIEWER_OPTS).length >= 1);
  check("031 P7.3: plan_reviewer wrap-up note path non-null via fixed taskRef (shared mission handoff path)",
    standalonePlanningPart.includes("'standalone-planning-plan_reviewer'")
    && /const noteRel=\(wrapMission && taskRef\)\?handoffNoteRelPath\(wrapMission,taskRef\):null;/.test(src));
  check("031 P7.3: plan_reviewer wrap-up is the orchestrator fallback (all roles, no resume)",
    /buildOrchestratorFallbackNote\(taskRef,events,role\.adapter,repo,diffStat,capBreach,sessionPaths\)/.test(src)
    && /status:"orchestrator_fallback",reason:"note_missing_or_stale",trigger:capBreach\.trigger\|\|null,note:noteRel,fallbackNote:true/.test(src)
    && !/buildWrapUpPrompt\(noteRel,noteMaxChars\)/.test(src));
}
{
  const { buildReviewWrapUpPrompt } = await import("./standalone-handoff.mjs");
  const pr = buildReviewWrapUpPrompt("plan_reviewer", { taskRef: "task:standalone:planning:plan_reviewer" });
  check("031 P7.3: plan_reviewer wrap-up template renders planning Found + Next sections",
    /Found/.test(pr) && /Next/.test(pr) && /PLAN\.md/.test(pr) && /TASKS\.md/.test(pr));
}

// ── Mission 031 phase 7 task 7b.2, exempted by mission 068 phase 1 task 1.3 ──
// Read-only plan_reviewer sessions never escalate
// standalone_planning_no_progress: the capped/voluntary branches continue as
// the next generation. Planner sites (031 P6b.2) are unchanged. The helper
// and its import stay.
{
  const standalonePlanningPart = (src.split("async function runStandalonePlanning")[1] ?? "").split("async function runSpecKitPlanning")[0] ?? "";
  check("031 P7b.2: stopOnNoProgress NOT called for plan_reviewer (read-only exempt, 068 1.3)",
    (standalonePlanningPart.match(/stopOnNoProgress\(s,c,\{framework:"standalone",contScope,taskId:null,missionName:mission,taskRef:'standalone-planning-plan_reviewer',touchedFiles:reviewNoProgressTouchedFiles\(mission,'standalone-planning-plan_reviewer',contScope,s\),checkpoint:s\[CHECKPOINT_STATE_KEY\],step:"standalone_planning_no_progress"\}\)/g) ?? []).length === 0);
  check("031 P7b.2: no plan_reviewer no-progress escalation step remains",
    (standalonePlanningPart.match(/taskRef:'standalone-planning-plan_reviewer',touchedFiles:reviewNoProgressTouchedFiles/g) ?? []).length === 0);
  check("031 P7b.2: exempt plan_reviewer branches keep the resume hint and continue as next generation",
    (standalonePlanningPart.match(/continuing as session \$\{cont\.used\+1\} of \$\{cont\.limit\+1\}/g) ?? []).length >= 3
    && (standalonePlanningPart.match(/Resume: ap reset --scope \$\{contScope\} then ap run/g) ?? []).length >= 3);
}
{
  const { parseFoundEntries } = await import("./standalone-handoff.mjs");
  check("031 P7b.2: read-only generation with new Found entries does not count as no-progress (growth)",
    parseFoundEntries("## Found\n- a — ok\n- b — ok\n") > parseFoundEntries("## Found\n- a — ok\n"));
  check("031 P7b.2: no note exists = no progress (empty note counts zero)",
    parseFoundEntries("") === 0 && parseFoundEntries("(none)") === 0
    && parseFoundEntries("## Found\n(none)\n") === 0);
}

// ── Mission 031 phase 10 task 10.3: final consistency check ──
// 12 consumeContinuation call sites in autopilot.mjs (4 implementer +
// 4 code_reviewer + 4 verifier across standalone + speckit loops) plus
// 5 handlePlanningContinuation call sites (planner capped + incomplete,
// plan_reviewer capped x2 pre/post-retry + incomplete). The task text
// says "4 planning sites (capped + incomplete per role)"; the 5th is the
// plan_reviewer pre-retry capped site already pinned in P7.1.
check("031 P10.3: 12 consumeContinuation call sites total (4 implementer + 4 code_reviewer + 4 verifier)",
  count(/consumeContinuation\(s,c\.policy,contScope/g) === 12);
check("031 P10.3: 4 implementer sites use the bare allowance form",
  count(/consumeContinuation\(s,c\.policy,contScope\)/g) === 4);
check("031 P10.3: 4 code_reviewer sites pass explicit continuationAllowance",
  count(/consumeContinuation\(s,c\.policy,contScope,resolvePerRoleLimits\('code_reviewer',c\.policy\)\.continuationAllowance\)/g) === 4);
check("031 P10.3: 4 verifier sites pass explicit continuationAllowance",
  count(/consumeContinuation\(s,c\.policy,contScope,resolvePerRoleLimits\('verifier',c\.policy\)\.continuationAllowance\)/g) === 4);
check("031 P10.3: 5 handlePlanningContinuation call sites total (planner 2 + plan_reviewer 3)",
  count(/handlePlanningContinuation\(s,/g) === 5);
check("031 P10.3: planner capped + incomplete planning sites (1 each)",
  count(/handlePlanningContinuation\(s,'planner',planner,'task:standalone:planning:planner',c\.policy,'capped'\)/g) === 1
  && count(/handlePlanningContinuation\(s,'planner',planner,'task:standalone:planning:planner',c\.policy,'incomplete'\)/g) === 1);
check("031 P10.3: plan_reviewer capped x2 (pre/post-retry) + incomplete x1 planning sites",
  count(/handlePlanningContinuation\(s,'plan_reviewer',reviewResult,'task:standalone:planning:plan_reviewer',c\.policy,'capped'\)/g) === 2
  && count(/handlePlanningContinuation\(s,'plan_reviewer',reviewResult,'task:standalone:planning:plan_reviewer',c\.policy,'incomplete'\)/g) === 1);

// ── Mission 039 task 1.1: standalone review roles inject dead-ends + handoff note ──
{
  const standalonePart = src.split("async function runImplementation(c){")[0];
  check("standalone review roles: dead-ends + handoff note injected",
    /const reviewDeadEnds=readRolloverDeadEnds\(s, `task:standalone:phase-\$\{s\.phaseIndex\}:code_reviewer`\)/.test(standalonePart)
    && /const reviewHandoffNote=readHandoffNote\(mission, reviewRef\)/.test(standalonePart)
    && !/readHandoffNote\(mission, 'standalone-.*code_reviewer'\)/.test(standalonePart)
    && /reviewDeadEndsText/.test(standalonePart)
    && /reviewHandoffNoteText/.test(standalonePart)
     && /review\("code_reviewer",`[^`]*\$\{reviewHandoff\.text\}\\n\\n\$\{scratchNote\?`\$\{scratchNote\}\\n\\n`:\"\"\}\$\{reviewDeadEndsText\}[^`]*\$\{reviewHandoffNoteText\}[\s\S]{0,300}?\$\{reviewBudget\.note\}/.test(standalonePart)
    && /const verifyDeadEnds=readRolloverDeadEnds\(s, `task:standalone:phase-\$\{s\.phaseIndex\}:verifier`\)/.test(standalonePart)
    && /const verifyHandoffNote=readHandoffNote\(mission, verifyRef\)/.test(standalonePart)
    && !/readHandoffNote\(mission, 'standalone-.*verifier'\)/.test(standalonePart)
    && /verifyDeadEndsText/.test(standalonePart)
    && /verifyHandoffNoteText/.test(standalonePart)
     && /relayAsync\("verifier",`[^`]*\$\{verifyHandoff\.text\}[^`]*\$\{verifyDeadEndsText\}[^`]*\$\{verifyHandoffNoteText\}[^`]*\$\{verifyBudget\.note\}/.test(standalonePart));
}

// ── Mission 039 task 1.2: speckit review roles inject dead-ends + handoff note ──
{
  const speckitPart = (src.split("async function runImplementation(c){")[1] ?? "");
  check("speckit review roles: dead-ends + handoff note injected",
    /const reviewDeadEnds=readRolloverDeadEnds\(s, `task:speckit:phase-\$\{s\.phaseIndex\}:code_reviewer`\)/.test(speckitPart)
    && /const reviewHandoffNote=readHandoffNote\(missionIdentity, reviewRef\)/.test(speckitPart)
    && !/readHandoffNote\(missionIdentity, '[^']*'\)/.test(speckitPart)
    && !/readHandoffNote\(missionIdentity, "[^"]*"\)/.test(speckitPart)
    && /reviewDeadEndsText/.test(speckitPart)
    && /reviewHandoffNoteText/.test(speckitPart)
    && /review\("code_reviewer",\s*`[^`]*\$\{reviewPrompt\}[\s\S]*\$\{reviewDeadEndsText\}[\s\S]*\$\{reviewHandoffNoteText\}[\s\S]*\$\{reviewBudget\.note\}/.test(speckitPart)
    && /const verifyDeadEnds=readRolloverDeadEnds\(s, `task:speckit:phase-\$\{s\.phaseIndex\}:verifier`\)/.test(speckitPart)
    && /const verifyHandoffNote=readHandoffNote\(missionIdentity, verifyRef\)/.test(speckitPart)
    && !/readHandoffNote\(missionIdentity, '[^']*'\)/.test(speckitPart)
    && /verifyDeadEndsText/.test(speckitPart)
    && /verifyHandoffNoteText/.test(speckitPart)
    && /relayAsync\("verifier",[\s\S]*\$\{verifyDeadEndsText\}[\s\S]*\$\{verifyHandoffNoteText\}[\s\S]*\$\{verifyBudget\.note\}/.test(speckitPart));
}

// ── Mission 039 task 1.3: standalone planner injects dead-ends + handoff note ──
{
  const standalonePlanningPart = (src.split("async function runStandalonePlanning")[1] ?? "").split("async function runSpecKitPlanning")[0] ?? "";
  check("standalone planner: dead-ends + handoff note injected",
    /readRolloverDeadEnds\(s, 'task:standalone:planning:planner'\)/.test(standalonePlanningPart)
    && /readHandoffNote\(mission, 'standalone-planning-planner'\)/.test(standalonePlanningPart)
    && /plannerDeadEndsText/.test(standalonePlanningPart)
    && /plannerHandoffNoteText/.test(standalonePlanningPart)
    && /plannerDeadEndsText,[\s\S]*?plannerHandoffNoteText,[\s\S]*?Project request\/context/.test(standalonePlanningPart));
}

// ── Backlog #62: review-role relay prompts carry the read-only note reminder ──
// The code reviewer / verifier prompts are assembled outside buildTaskPrompt
// (buildStandaloneHandoff + extra text), so each relay call appends the shared
// readOnlyHandoffNoteReminder under the SAME ref the relay runs under — the
// wrap-up reads scratchHandoffNotePath(effectiveScratchDir, taskRef), so the
// note the role is told to write is the note the wrap-up finds.
{
  const reminderCall = (anchorRe, occurrence, callRe, missionKey, refVar, maxDistance = 900) => {
    const anchors = [...src.matchAll(anchorRe)].map((m) => m.index);
    const anchor = anchors[occurrence] ?? -1;
    if (anchor === -1) return false;
    const after = src.slice(anchor);
    const call = after.search(callRe);
    if (call === -1 || call > maxDistance) return false;
    const text = after.slice(call, call + 1400);
    return text.includes("readOnlyHandoffNoteReminder({")
      && text.includes(`${missionKey}, ref: ${refVar}`)
      && text.includes("noteLimit: resolveHandoffNoteMaxChars(c.policy)");
  };
  check("backlog #62: standalone code_reviewer review() appends the reminder under reviewRef",
    // #37 inserts the unexpected-new-files note ahead of the dead-ends text,
    // which moves this call past the default anchor window; keep the bound tight.
    reminderCall(/const reviewRef=reviewTaskRef\(s,phaseKey,/g, 0, /review\("code_reviewer"/, "mission", "reviewRef", 1200));
  check("backlog #62: standalone verifier relayAsync() appends the reminder under verifyRef",
    reminderCall(/const verifyRef=allPhaseTaskRef\(phaseTasks\);/g, 0, /relayAsync\("verifier"/, "mission", "verifyRef"));
  check("backlog #62: speckit code_reviewer review() appends the reminder under reviewRef",
    reminderCall(/const reviewRef=reviewTaskRef\(s,speckitPhaseFeedbackKey/g, 0, /review\("code_reviewer"/, "missionIdentity", "reviewRef"));
  check("backlog #62: speckit verifier relayAsync() appends the reminder under verifyRef",
    reminderCall(/const verifyRef=allPhaseTaskRef\(phaseTasks\);/g, 1, /relayAsync\("verifier"/, "missionIdentity", "verifyRef"));
  const finalCalls = [...src.matchAll(/let final=await review\("code_reviewer"/g)];
  check("backlog #62: mission-final review calls carry no per-task reminder",
    finalCalls.length >= 2
    && finalCalls.every((m) => !src.slice(m.index, m.index + 900).includes("readOnlyHandoffNoteReminder")),
    finalCalls.length);
}

if (failures) {
  console.error(`${failures} cap-breach wiring check(s) failed.`);
  process.exit(1);
}
console.log("cap-breach wiring tests passed");
