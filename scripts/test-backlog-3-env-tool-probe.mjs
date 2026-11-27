#!/usr/bin/env node
// Backlog #3: env-tool-probe, planner/plan-review env-tools notes, and [manual] task skipping.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KNOWN_ENV_TOOLS,
  extractRequiredTools,
  probeTools,
  envToolsPromptNote,
  planReviewEnvToolsRule,
  plannerEnvToolsRule,
  isManualTask,
  splitManualTasks,
  MANUAL_TASK_NOTE
} from "./env-tool-probe.mjs";
import {
  PLAN_REVIEW_TESTING_RULE,
  envToolsNoteForPlanning,
  skipManualTasksInPhase,
  reportManualTasks
} from "./autopilot.mjs";
import { renderManualTasks, renderReport, buildReportModel } from "./watch-report.mjs";

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

const tempDirs = new Set();
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ── 1. extractRequiredTools positives ──
check("extractRequiredTools: backtick supabase db reset",
  JSON.stringify(extractRequiredTools("Reset DB with `supabase db reset` before seeding.")) === JSON.stringify(["supabase"]),
  extractRequiredTools("Reset DB with `supabase db reset` before seeding."));

check("extractRequiredTools: psql -v ON_ERROR_STOP=1",
  JSON.stringify(extractRequiredTools("Verify: psql -v ON_ERROR_STOP=1 -f schema.sql")) === JSON.stringify(["psql"]),
  extractRequiredTools("Verify: psql -v ON_ERROR_STOP=1 -f schema.sql"));

check("extractRequiredTools: run psql -c",
  JSON.stringify(extractRequiredTools("run psql -c 'SELECT 1'")) === JSON.stringify(["psql"]),
  extractRequiredTools("run psql -c 'SELECT 1'"));

check("extractRequiredTools: docker compose up",
  JSON.stringify(extractRequiredTools("Start stack via docker compose up -d")) === JSON.stringify(["docker"]),
  extractRequiredTools("Start stack via docker compose up -d"));

check("extractRequiredTools: pg_dump --schema-only",
  JSON.stringify(extractRequiredTools("Export schema: pg_dump --schema-only > out.sql")) === JSON.stringify(["pg_dump"]),
  extractRequiredTools("Export schema: pg_dump --schema-only > out.sql"));

const multiText = "Run `supabase db reset`, then pg_dump --schema-only, then docker compose up, and psql -v ON_ERROR_STOP=1 (again `supabase db reset`).";
check("extractRequiredTools: sorted unique list",
  JSON.stringify(extractRequiredTools(multiText)) === JSON.stringify(["docker", "pg_dump", "psql", "supabase"]),
  extractRequiredTools(multiText));

check("KNOWN_ENV_TOOLS includes all 14 required tools",
  KNOWN_ENV_TOOLS.length === 14 && ["docker", "docker-compose", "supabase", "psql", "pg_dump", "pg_restore", "redis-cli", "mysql", "mongosh", "kubectl", "terraform", "aws", "gcloud", "az"].every((t) => KNOWN_ENV_TOOLS.includes(t)),
  KNOWN_ENV_TOOLS);

// ── 2. extractRequiredTools negatives ──
check("extractRequiredTools negative: Supabase Auth",
  extractRequiredTools("Integrate Supabase Auth for user login.").length === 0,
  extractRequiredTools("Integrate Supabase Auth for user login."));

check("extractRequiredTools negative: postgres database",
  extractRequiredTools("Connect to the postgres database using drizzle.").length === 0,
  extractRequiredTools("Connect to the postgres database using drizzle."));

check("extractRequiredTools negative: dockerfile docs",
  extractRequiredTools("Update the dockerfile docs and README.").length === 0,
  extractRequiredTools("Update the dockerfile docs and README."));

// ── 3. probeTools with fake PATH dir containing stub psql ──
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-env-probe-bin-"));
tempDirs.add(fakeBinDir);
const fakePsql = path.join(fakeBinDir, "psql");
fs.writeFileSync(fakePsql, "#!/bin/sh\nexit 0\n");
fs.chmodSync(fakePsql, 0o755);

const probe1 = probeTools(["psql", "docker"], { env: { PATH: fakeBinDir } });
check("probeTools: stub psql available, docker missing",
  JSON.stringify(probe1.available) === JSON.stringify(["psql"]) &&
  JSON.stringify(probe1.missing) === JSON.stringify(["docker"]),
  probe1);

// Stub docker + supabase: missing when allow_docker is false, available when allow_docker is true + bound
const fakeDocker = path.join(fakeBinDir, "docker");
const fakeSupabase = path.join(fakeBinDir, "supabase");
fs.writeFileSync(fakeDocker, "#!/bin/sh\nexit 0\n");
fs.writeFileSync(fakeSupabase, "#!/bin/sh\nexit 0\n");
fs.chmodSync(fakeDocker, 0o755);
fs.chmodSync(fakeSupabase, 0o755);

const probeDenied = probeTools(["docker", "supabase"], {
  envelope: { safety: { allow_docker: false } },
  env: { PATH: fakeBinDir }
});
check("probeTools: docker/supabase missing when allow_docker is false",
  probeDenied.available.length === 0 &&
  JSON.stringify(probeDenied.missing) === JSON.stringify(["docker", "supabase"]),
  probeDenied);

const probeAllowed = probeTools(["docker", "supabase"], {
  envelope: {
    config: { safety: { allow_docker: true } },
    args: ["--ro-bind", fakeBinDir, fakeBinDir, "--bind", "/tmp/fake.sock", "/var/run/docker.sock"]
  },
  env: { PATH: fakeBinDir }
});
check("probeTools: docker/supabase available when allow_docker is true and dir is bound",
  JSON.stringify(probeAllowed.available) === JSON.stringify(["docker", "supabase"]) &&
  probeAllowed.missing.length === 0,
  probeAllowed);

// ── 4. envToolsPromptNote ──
check("envToolsPromptNote: empty when nothing is missing",
  envToolsPromptNote({ available: ["psql"], missing: [] }) === "",
  envToolsPromptNote({ available: ["psql"], missing: [] }));

const noteMissing = envToolsPromptNote({ available: ["psql"], missing: ["docker", "supabase"] });
check("envToolsPromptNote: non-empty single sentence when tools are missing",
  noteMissing.includes("docker, supabase") && noteMissing.includes("not available") && !noteMissing.includes("\n"),
  noteMissing);

// ── 5. Plan-review & planner prompts (standalone + SpecKit + GSD) ──
check("PLAN_REVIEW_TESTING_RULE untouched (does not contain env tools rule)",
  !PLAN_REVIEW_TESTING_RULE.includes("Environment tools"),
  PLAN_REVIEW_TESTING_RULE);

const reviewNoteMissing = envToolsNoteForPlanning({
  text: "Task T006: run `supabase db reset` and `docker compose up`",
  config: { safety: { allow_docker: false } },
  role: "plan_reviewer",
  probeOpts: { env: { PATH: fakeBinDir } }
});
check("plan-review env note contains BLOCKING sentence when tool is missing",
  reviewNoteMissing.includes("BLOCKING") &&
  reviewNoteMissing.includes("docker, supabase") &&
  reviewNoteMissing.includes("are not available to the implementer") &&
  reviewNoteMissing.includes("FAIL any task whose implementation or verify needs one of them") &&
  reviewNoteMissing.includes("[manual]"),
  reviewNoteMissing);

const reviewNoteNoneMissing = envToolsNoteForPlanning({
  text: "Task T001: run psql -v ON_ERROR_STOP=1",
  config: null,
  role: "plan_reviewer",
  probeOpts: { env: { PATH: fakeBinDir } }
});
check("plan-review env note is empty when no required tool is missing",
  reviewNoteNoneMissing === "",
  reviewNoteNoneMissing);

const plannerNoteMissing = envToolsNoteForPlanning({
  text: "Task T006: run `supabase db reset`",
  config: { safety: { allow_docker: false } },
  role: "planner",
  probeOpts: { env: { PATH: fakeBinDir } }
});
check("planner env note tells planner not to create such tasks except as [manual]",
  plannerNoteMissing.includes("supabase") &&
  plannerNoteMissing.includes("Do not create tasks") &&
  plannerNoteMissing.includes("[manual]"),
  plannerNoteMissing);

const autopilotSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const sliceAt = (needle, len = 3000) => {
  const idx = autopilotSrc.indexOf(needle);
  return idx < 0 ? "" : autopilotSrc.slice(idx, idx + len);
};
check("standalone plan-review wires envToolsNoteForPlanning",
  sliceAt("const reviewPrompt=[").includes("envToolsNoteForPlanning("));
check("SpecKit plan-review wires envToolsNoteForPlanning",
  sliceAt("const speckitGateEnvNote=envToolsNoteForPlanning(").includes("role:\"plan_reviewer\"") &&
  sliceAt("const initialReviewPrompt=").includes("${speckitGateEnvNote?"));
check("existing-plan validation wires envToolsNoteForPlanning",
  sliceAt("Validate the existing ${subject}").includes("envToolsNoteForPlanning("));
check("GSD plan-review wires envToolsNoteForPlanning",
  sliceAt("function gsdPlanningReviewPrompt").includes("envToolsNoteForPlanning("));
check("standalone planner wires envToolsNoteForPlanning",
  sliceAt("const standalonePlannerEnvNote=envToolsNoteForPlanning(").includes("role:\"planner\""));
check("SpecKit planner wires envToolsNoteForPlanning",
  sliceAt("const speckitEnvNote=envToolsNoteForPlanning(").includes("role:\"planner\""));
check("GSD planner wires envToolsNoteForPlanning",
  sliceAt("async function gsdPlanningStage").includes("envToolsNoteForPlanning("));

// ── 6. [manual] task skipping and reporting in both loops ──
check("isManualTask matches prefix and inline [manual]",
  isManualTask("[manual] Run supabase db reset") &&
  isManualTask({ text: "T006 [manual] Run `supabase db reset` against local stack" }) &&
  !isManualTask({ text: "T007 Add unit tests for parser" }));

const tasksTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-manual-tasks-"));
tempDirs.add(tasksTmp);
const tasksFile = path.join(tasksTmp, "TASKS.md");
fs.writeFileSync(tasksFile, [
  "## Phase 1: Setup",
  "- [ ] **1.1** [manual] Run `supabase db reset` locally — accept: DB reset",
  "- [ ] **1.2** Add helper module — accept: unit test passes"
].join("\n") + "\n");

const parsedTasks = [
  { id: "1.1", text: "**1.1** [manual] Run `supabase db reset` locally — accept: DB reset", file: tasksFile, line: 2, done: false },
  { id: "1.2", text: "**1.2** Add helper module — accept: unit test passes", file: tasksFile, line: 3, done: false }
];
const state = {};
const logged = [];
let savedCount = 0;
let refreshedCount = 0;
const skipped = skipManualTasksInPhase(parsedTasks, state, {
  phaseName: "Phase 1: Setup",
  phaseIndex: 0,
  save: () => { savedCount += 1; },
  refresh: () => { refreshedCount += 1; },
  log: (msg) => logged.push(msg)
});

check("skipManualTasksInPhase splits manual vs automated tasks",
  skipped.manual.length === 1 && skipped.automated.length === 1 && skipped.automated[0].id === "1.2",
  skipped);
check("manual task marked done and checkbox checked in TASKS.md",
  parsedTasks[0].done === true &&
  parsedTasks[1].done === false &&
  fs.readFileSync(tasksFile, "utf8").includes("- [x] **1.1** [manual]"),
  fs.readFileSync(tasksFile, "utf8"));
check("manual task recorded on state with operator note",
  Array.isArray(state.manualTasks) &&
  state.manualTasks.length === 1 &&
  state.manualTasks[0].note === MANUAL_TASK_NOTE &&
  state.manualTasks[0].text.includes("supabase db reset"),
  state.manualTasks);
check("skipManualTasksInPhase logs, saves, and refreshes watch report",
  logged.some((l) => l.includes(MANUAL_TASK_NOTE)) && savedCount === 1 && refreshedCount === 1,
  { logged, savedCount, refreshedCount });

// Final report (REPORT.md)
const reportFile = path.join(tasksTmp, "REPORT.md");
fs.writeFileSync(reportFile, "# Mission Report\n\nAll phases complete.\n");
reportManualTasks(state, { reportFile, repoRoot: tasksTmp });
const reportContent = fs.readFileSync(reportFile, "utf8");
check("final REPORT.md lists skipped manual tasks",
  reportContent.includes("Manual tasks (for the operator):") &&
  reportContent.includes("supabase db reset") &&
  reportContent.includes(MANUAL_TASK_NOTE),
  reportContent);

// WATCH-REPORT
const watchSection = renderManualTasks({ manualTasks: state.manualTasks });
check("WATCH-REPORT renderManualTasks includes skipped manual tasks",
  watchSection.includes("=== Manual tasks (for the operator) ===") &&
  watchSection.includes("supabase db reset") &&
  watchSection.includes(MANUAL_TASK_NOTE),
  watchSection);

const watchModel = buildReportModel({
  mission: "test-mission",
  state: { ...state, phase: "complete", step: "human_commit" },
  runs: [],
  events: []
});
const fullWatch = renderReport(watchModel);
check("WATCH-REPORT renderReport includes Manual tasks section",
  fullWatch.includes("=== Manual tasks (for the operator) ===") &&
  fullWatch.includes("supabase db reset"),
  fullWatch.slice(-500));

// Both loops wire skipManualTasksInPhase
const skipCalls = [...autopilotSrc.matchAll(/phaseTasks=skipManualTasksInPhase\(/g)];
check("both implementation loops (standalone + SpecKit) wire skipManualTasksInPhase",
  skipCalls.length === 2,
  { count: skipCalls.length });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
