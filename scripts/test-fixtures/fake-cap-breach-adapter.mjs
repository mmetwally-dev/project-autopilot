// Backlog 003#15 (token ceiling) + 003#16 (turn cap) + 003#17 (continuation):
// cap-breach fixture adapter in the opencode wire shape.
//
// Emits real NDJSON step_finish events (optionally token-heavy, optionally
// slow) so runRelay()'s 1s cap monitor can observe turns/tokens mid-stream.
// Slow spins SELF-EXIT after SPIN_TURNS: the test asserts the monitor killed
// the run first (result.capped), and self-exit keeps a monitor regression a
// loud FAIL instead of a hang. Generation detection is prompt-local — the
// second generation's prompt carries the dead-ends section — so no scenario
// switch (and no shared mutable file) is needed between generations.
//
// Scenario (committed `.autopilot-test-scenario`, read from the repo cwd):
//   cap_turns   — slow tiny-token spin, then behave on generation 2+
//   cap_tokens  — slow token-heavy spin, then behave on generation 2+
//   cap_always  — slow spin on every generation (never completes; for the
//                 allowance-exhaustion escalation case)
//   cap_nosid   — like cap_turns but emits no session id (mission 045: no
//                 session id to resume no longer selects a skip — the
//                 orchestrator fallback fires regardless)
//   cap_wrapup_silent — like cap_turns but never writes any note (the
//                 missing-note orchestrator fallback)
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("fake-cap-breach-adapter 1.0.0\n");
  process.exit(0);
}
// Answer help probes instantly (1.x-style help naming --variant) so generation
// detection never falls through to consuming a scenario on `run --help`.
if (args.includes("--help")) {
  process.stdout.write("Usage: opencode [command]\n  run [message..]\n    -m, --model <model>\n    --variant <level>\n    --agent <agent>\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write("opencode/fake-cap-model\n");
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => { data += c; });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", () => resolve(data));
    } catch { resolve(data); }
  });
}

function scenario() {
  for (const candidate of [".autopilot/.autopilot-test-scenario", ".autopilot-test-scenario"]) {
    try {
      const text = fs.readFileSync(candidate, "utf8").trim();
      if (text) return text;
    } catch { /* absent — default */ }
  }
  return "cap_turns";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Session id for the rollover e2e: emitted as lowercase `session_id` (the
// real opencode CLI stamps capital `sessionID`, so the hermetic-binary
// tripwire in test-cap-breach-rollover.mjs — which asserts no `sessionID`
// substring — still distinguishes fixture output from a leaked real binary).
// The `cap_nosid` scenario emits none: mission 045 removed the resume path,
// so it now pins only that a capped run without a session id still gets the
// orchestrator fallback note.
const FIXTURE_SESSION_ID = "fixture-cap-session";
function emit(object) {
  if (scenario() !== "cap_nosid" && object && typeof object === "object"
    && !("session_id" in object) && !("sessionID" in object)) {
    object.session_id = FIXTURE_SESSION_ID;
  }
  process.stdout.write(`${JSON.stringify(object)}\n`);
}
function stepFinish(tokens) {
  emit({type: "step_finish", part: {type: "step-finish", tokens}});
}

const TASK_RESULT = 'AUTOPILOT_TASK_RESULT={"summary":"cap probe generation complete","taskLocalCheck":{"command":"node cap-probe","status":"passed","exitCode":0,"summary":"fixture task done"}}';
const ATTEMPTED_RESULT = 'AUTOPILOT_TASK_RESULT={"summary":"cap probe stopped early with work remaining, 3 probe files written","taskLocalCheck":{"command":"node cap-probe","status":"attempted","exitCode":null,"summary":"stopped early, all files remaining"}}';

const prompt = (await readStdin()) + " " + args.join(" ");
const sc = scenario();
// Planning roles get the planning-specific continuation heading instead of
// role-progress-prompt's implementer heading; both mean "this is the resumed
// generation".
const gen2 = prompt.includes("Dead ends from capped generations")
  || prompt.includes("Prior dead ends (continuation context")
  || prompt.includes("Prior reviewer handoff note (continuation context");
const SPIN_TURNS = 45;
const SPIN_MS = 80;
const tiny = {input: 10, output: 5, reasoning: 0, cache: {read: 0, write: 0}};
const heavy = {input: 1000000, output: 5, reasoning: 0, cache: {read: 1000000, write: 0}};
const tokensFor = () => (sc === "cap_tokens" ? heavy : tiny);

const REVIEW_PASS = 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}';
const REVIEW_FAIL = 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":["fixture planning gap: add the missing detail"]}';
const PLAN_OK = "# Plan\n\nObjective: cap continuation reset probe.\n";
const TASKS_OK = "## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n";

async function spinToCap(tokens) {
  emit({type: "step_start", part: {type: "step-start"}});
  for (let i = 0; i < SPIN_TURNS; i += 1) {
    stepFinish(tokens);
    await sleep(SPIN_MS);
  }
}
function writeStandalonePlanningArtifacts() {
  const planMatch = /Write the narrative plan to exactly: (\S+)/.exec(prompt);
  const tasksMatch = /Write the phased checklist to exactly: (\S+)/.exec(prompt);
  if (planMatch) {
    const planPath = planMatch[1].replace(/[.,;:]+$/, "");
    try {
      fs.mkdirSync(planPath.split("/").slice(0, -1).join("/") || ".", {recursive: true});
      fs.writeFileSync(planPath, PLAN_OK);
    } catch { /* best-effort like the other fixtures */ }
  }
  if (tasksMatch) {
    const tasksPath = tasksMatch[1].replace(/[.,;:]+$/, "");
    try {
      fs.mkdirSync(tasksPath.split("/").slice(0, -1).join("/") || ".", {recursive: true});
      fs.writeFileSync(tasksPath, TASKS_OK);
    } catch { /* best-effort like the other fixtures */ }
  }
}

if (sc === "live_usage_review") {
  // TASK-27 follow-up (003#8): the reviewer twin of `live_usage` — same
  // two-wave usage stream, but a review PASS verdict as the terminal line
  // (reviewers are judged on AUTOPILOT_REVIEW, never the task-result
  // sentinel). Additive: existing scenarios untouched.
  emit({type: "step_start", part: {type: "step-start"}});
  for (let i = 0; i < 3; i += 1) {
    stepFinish(tiny);
    await sleep(SPIN_MS);
  }
  await sleep(12000);
  for (let i = 0; i < 3; i += 1) {
    stepFinish(tiny);
    await sleep(SPIN_MS);
  }
  emit({type: "text", part: {type: "text", text: REVIEW_PASS}});
  // The second dispatch chain below must not run for this scenario.
  process.exit(0);
}

if (sc === "live_usage") {
  // TASK-27: slow two-wave usage stream for the live-totals integration
  // test — 3 turns, a 12s pause (past the 10s persist floor), 3 more turns,
  // then a well-formed completion. Additive: existing scenarios untouched.
  emit({type: "step_start", part: {type: "step-start"}});
  for (let i = 0; i < 3; i += 1) {
    stepFinish(tiny);
    await sleep(SPIN_MS);
  }
  await sleep(12000);
  for (let i = 0; i < 3; i += 1) {
    stepFinish(tiny);
    await sleep(SPIN_MS);
  }
  emit({type: "text", part: {type: "text", text: TASK_RESULT}});
  // The second dispatch chain below must not run for this scenario.
  process.exit(0);
} else if (sc === "cap_files_spin" && !gen2) {
  // Attribution-tail probe: real tree writes before the spin, so the capped
  // generation's dead end can name completed files (not just output tail).
  for (let i = 1; i <= 3; i += 1) {
    try { fs.writeFileSync(`cap-e2e-probe-0${i}.txt`, `probe file ${i}\n`); } catch {}
  }
}
// LEGACY (Backlog #26 Step B): the orchestrator-forced wrap-up turn. Its
// prompt was the wrap-up message ONLY (no dead-ends section, so gen2 is
// false here) — handled BEFORE the spin branches below so every scenario
// (including cap_always) answers fast instead of spinning into the wrap-up
// ceiling. It used to write the note at the exact path the prompt named.
// Mission 045 removed the wrap-up resume, so autopilot.mjs never builds this
// prompt again and this branch is dead fixture code: the rollover e2e now
// asserts the ORCHESTRATOR fallback note instead. Kept so the old shape
// still compiles; `cap_wrapup_silent` used to write nothing here.
const WRAPUP_MARKER = "Write your hand-off note NOW";
if (prompt.includes(WRAPUP_MARKER)) {
  if (sc !== "cap_wrapup_silent") {
    const wrapMatch = /Write your hand-off note NOW to (\S+)/.exec(prompt);
    if (wrapMatch) {
      try {
        const notePath = wrapMatch[1].replace(/[.,;:]+$/, "");
        fs.mkdirSync(notePath.split("/").slice(0, -1).join("/"), {recursive: true});
        fs.writeFileSync(notePath, [
          "1. Done — nothing yet; first generation.",
          "2. Found — GEN1-HANDOFF-MARKER: TASKS.md holds the fixture task; the cap monitor kills at 5 turns.",
          "3. Next — write cap-probe-output.txt and end with AUTOPILOT_TASK_RESULT passed.",
          "4. Dead ends — none yet.",
          "",
        ].join("\n"));
      } catch {}
    }
  }
  emit({type: "step_start", part: {type: "step-start"}});
  stepFinish(tiny);
  await sleep(SPIN_MS);
  emit({type: "text", part: {type: "text", text: "wrap-up note written, stopping"}});
  process.exit(0);
}
if (sc === "cap_verdict") {
  // Item 7: a read-only review that emits its complete verdict and THEN spins
  // past the cap. The final text event is the verdict, so the orchestrator
  // must accept it instead of spending a continuation to re-run the review.
  emit({type: "text", part: {type: "text", text: REVIEW_PASS}});
  await spinToCap(tiny);
} else if (sc === "plan_review_cap_rounds" && prompt.includes("Create or continue an implementation plan")) {
  // Item 6/planner: every Planner generation caps once, then the resumed
  // generation writes the artifacts. The second (revision) Planner run may
  // only cap again if the planner continuation allowance was reset by the
  // completed first Planner run.
  if (!gen2) await spinToCap(tiny);
  else {
    writeStandalonePlanningArtifacts();
    emit({type: "text", part: {type: "text", text: "planner ok"}});
  }
} else if (sc === "plan_review_cap_rounds" && prompt.includes("Review the standalone Autopilot plan")) {
  // Item 6/reviewer: each review round (initial, post-revision, confirmation)
  // caps once and completes on the resumed generation. A completed round
  // resets the reviewer allowance, so the NEXT round may cap again under the
  // same allowance of 1. The first round FAILs, the later rounds PASS.
  if (!gen2) await spinToCap(tiny);
  else if (prompt.includes("confirmation full review after a scoped re-review PASS")
    || prompt.includes("Prior findings to re-check")) {
    emit({type: "text", part: {type: "text", text: REVIEW_PASS}});
  } else {
    emit({type: "text", part: {type: "text", text: REVIEW_FAIL}});
  }
} else if (sc === "planner_stale_note_then_rate_limit" && prompt.includes("Create or continue an implementation plan")) {
  // Backlog #7: the initial Planner completes and leaves a hand-off note
  // (STALE-PLANNER-HANDOFF-MARKER). The next Planner run is a revision and
  // hits a provider rate limit, so the role fallback relaunches it with the
  // SAME prompt. A stale note surviving the completed initial run would be
  // quoted into both revision briefs as "continuation context".
  if (prompt.includes("This is a REVISION round")) {
    emit({type: "error", error: {name: "APIError", data: {message: "rate limit exceeded", statusCode: 429}}});
    process.stderr.write('level=ERROR role=server cause="AI_APICallError: rate_limit_exceeded"\n');
    process.exit(1);
  }
  const noteMatch = /Keep a hand-off note at (\S+)/.exec(prompt);
  if (noteMatch) {
    const notePath = noteMatch[1].replace(/[.,;:]+$/, "");
    try {
      fs.mkdirSync(notePath.split("/").slice(0, -1).join("/") || ".", {recursive: true});
      fs.writeFileSync(notePath, [
        "1. Done — initial planning revision complete.",
        "2. Found — STALE-PLANNER-HANDOFF-MARKER from an earlier, finished revision.",
        "3. Next — nothing; this revision is done.",
        "4. Dead ends — none.",
        "",
      ].join("\n"));
      // Audit trail: proves the fixture wrote the note even though the
      // production clear removes it when the Planner completes uncapped.
      fs.mkdirSync(".autopilot", {recursive: true});
      fs.writeFileSync(".autopilot/.fixture-stale-planner-note", `${notePath}\n${"STALE-PLANNER-HANDOFF-MARKER"}\n`);
    } catch {}
  }
  writeStandalonePlanningArtifacts();
  emit({type: "text", part: {type: "text", text: "planner initial complete"}});
} else if (sc === "planner_stale_note_then_rate_limit" && prompt.includes("Review the standalone Autopilot plan")) {
  // One review FAIL schedules exactly one Planner revision.
  emit({type: "text", part: {type: "text", text: REVIEW_FAIL}});
} else if (sc === "cap_files_spin" && gen2) {
  // Voluntary early stop with a well-formed "attempted" sentinel (never a
  // breach, never a completion): exercises the continuation-on-attempted
  // path, not the commit path.
  emit({type: "step_start", part: {type: "step-start"}});
  stepFinish(tiny);
  await sleep(SPIN_MS);
  emit({type: "text", part: {type: "text", text: ATTEMPTED_RESULT}});
} else if (sc === "cap_always" || !gen2) {
  emit({type: "step_start", part: {type: "step-start"}});
  // Backlog #26 Step A + mission 045: the capped generation keeps its
  // hand-off note at the exact path its own brief names (parsed from the
  // prompt, like a real agent would), before spinning into the cap — so
  // the rollover e2e can assert the orchestrator fallback REPLACED it.
  // Skipped for `cap_wrapup_silent`, which models the mission-022 agent
  // that never wrote the note — the missing-note orchestrator fallback.
  const noteMatch = /Keep a hand-off note at (\S+)/.exec(prompt);
  if (noteMatch && sc !== "cap_wrapup_silent") {
    try {
      // The brief sentence ends with a period after the path — strip it.
      const notePath = noteMatch[1].replace(/[.,;:]+$/, "");
      fs.mkdirSync(notePath.split("/").slice(0, -1).join("/"), {recursive: true});
      fs.writeFileSync(notePath, [
        "1. Done — nothing yet; first generation.",
        "2. Found — GEN1-HANDOFF-MARKER: TASKS.md holds the fixture task; the cap monitor kills at 5 turns.",
        "3. Next — write cap-probe-output.txt and end with AUTOPILOT_TASK_RESULT passed.",
        "4. Dead ends — none yet.",
        "",
      ].join("\n"));
      // Backdate the gen-1 note so the cap-breach rollover e2e exercises
      // the STALE-note path: mission 045 overwrites stale notes with the
      // orchestrator fallback instead of keeping them.
      try {
        const backdate = new Date(Date.now() - 10 * 60 * 1000);
        fs.utimesSync(notePath, backdate, backdate);
      } catch {}
    } catch {}
  }
  // Backlog #22: the capped generation does decoded, digestible work (a read
  // with ranges and a shell command) before spinning into the cap, so the
  // rollover e2e can assert generation 2's brief carries the work digest
  // instead of a raw JSON-event tail. Pure NDJSON output — no tree, no turns.
  emit({type: "tool_use", part: {type: "tool", tool: "read", state: {status: "completed", input: {filePath: "TASKS.md", offset: 1, limit: 20}}}});
  emit({type: "tool_use", part: {type: "tool", tool: "bash", state: {status: "completed", input: {command: "git status --short"}, metadata: {exit: 0}}}});
  for (let i = 0; i < SPIN_TURNS; i += 1) {
    stepFinish(tokensFor());
    await sleep(SPIN_MS);
  }
} else {
  emit({type: "step_start", part: {type: "step-start"}});
  for (let i = 0; i < 2; i += 1) {
    stepFinish(tiny);
    await sleep(SPIN_MS);
  }
  try { fs.writeFileSync("cap-probe-output.txt", "cap probe generation 2\n"); } catch { /* read-only cwd: evidence optional */ }
  emit({type: "text", part: {type: "text", text: TASK_RESULT}});
}
