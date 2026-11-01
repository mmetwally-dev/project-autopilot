#!/usr/bin/env node
// Backlog #12(a): live tests must never let OpenCode choose its CLI default
// model (which can be a paid provider inside the sandbox's fresh HOME). This
// proves the picker only ever auto-selects `opencode/*-free`, honours the
// explicit env override, and turns "no free model" into a clear LIVE SKIPPED
// line. Also proves test-all's summary collector keeps those lines.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  LIVE_MODEL_ENV,
  LIVE_SKIP_PREFIX,
  isFreeOpenCodeModel,
  pickFreeOpenCodeModel,
  parseOpenCodeModelList,
  readOpenCodeModelIds,
  resolveLiveFreeOpenCodeModel,
  isLiveQuotaExhausted,
  collectLiveSkipLines,
  formatLiveSkipSummary,
} from "./live-test-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

// ── Only provider opencode + `-free` suffix is auto-selectable ─────────────
check("free matcher accepts opencode/<id>-free", isFreeOpenCodeModel("opencode/glm-5-free") === true);
check("free matcher rejects a paid opencode model", isFreeOpenCodeModel("opencode/deepseek-v4-pro") === false);
check("free matcher rejects another provider's -free id", isFreeOpenCodeModel("deepseek/deepseek-v4.1-flash-free") === false);
check("free matcher rejects free text in the middle", isFreeOpenCodeModel("opencode/free-model") === false);

// ── First opencode/*-free in live list order wins ──────────────────────────
{
  const list = [
    "deepseek/deepseek-v4.1-flash-free",
    "opencode/deepseek-v4-pro",
    "opencode/alpha-free",
    "opencode/beta-free",
  ];
  const picked = pickFreeOpenCodeModel(list, {env: {}});
  check("picker chooses the first opencode/*-free id", picked.model === "opencode/alpha-free", picked);
  check("picker records the live source", picked.source === "live" && picked.skip === null, picked);
}

// ── Explicit env override wins (operator's deliberate choice) ──────────────
{
  const picked = pickFreeOpenCodeModel(["opencode/alpha-free"], {env: {[LIVE_MODEL_ENV]: "opencode/chosen-free"}});
  check("env override wins over the live list", picked.model === "opencode/chosen-free" && picked.source === "env", picked);
  check("env override is trimmed", pickFreeOpenCodeModel([], {env: {[LIVE_MODEL_ENV]: "  opencode/x-free  "}}).model === "opencode/x-free");
}

// ── No free model => one clear LIVE SKIPPED line, never a paid fallback ────
{
  const none = pickFreeOpenCodeModel(["opencode/paid-model", "deepseek/paid-free"], {env: {}});
  check("no free model => no model", none.model === null, none);
  check("no free model => LIVE SKIPPED line", typeof none.skip === "string" && none.skip.startsWith(LIVE_SKIP_PREFIX), none);
  check("skip line names the reason", /no free OpenCode model/.test(none.skip) && /CLI default/.test(none.skip), none.skip);
  check("skip line never names a paid model as the choice", !/using opencode\/paid-model/.test(none.skip), none.skip);
}

// ── Live `opencode models` output parsing ──────────────────────────────────
{
  const ids = parseOpenCodeModelList([
    "opencode/alpha-free",
    'opencode/beta-free {"name":"Beta"}',
    "not-a-model",
    "",
    "opencode/alpha-free",
  ].join("\n"));
  check("model-list parser keeps provider/model ids only", ids.join(",") === "opencode/alpha-free,opencode/beta-free", ids);

  const fakeSpawn = () => ({status: 0, stdout: "opencode/paid-model\nopencode/first-free\nopencode/second-free\n", stderr: ""});
  const read = readOpenCodeModelIds({binary: "opencode", spawn: fakeSpawn, env: {}});
  check("reader returns the live ids", read.ids.join(",") === "opencode/paid-model,opencode/first-free,opencode/second-free", read);
  const resolved = resolveLiveFreeOpenCodeModel({binary: "opencode", spawn: fakeSpawn, env: {}});
  check("resolver picks the explicit free model", resolved.model === "opencode/first-free" && resolved.skip === null, resolved);
}

// ── A CLI failure/no list also skips instead of using the default ──────────
{
  const failed = resolveLiveFreeOpenCodeModel({binary: "opencode", spawn: () => ({status: 2, stdout: "", stderr: "boom"}), env: {}});
  check("unreadable list => skip line", failed.model === null && failed.skip.startsWith(LIVE_SKIP_PREFIX), failed);
  check("unreadable list skip names the command", /opencode models/.test(failed.skip), failed.skip);
}

// ── Free-quota exhaustion is a skip, not a failure ─────────────────────────
check("RATE_LIMITED result => quota-exhausted skip", isLiveQuotaExhausted({failureClass: "RATE_LIMITED"}) === true);
check("free-quota text => quota-exhausted skip", isLiveQuotaExhausted({output: "AI_APICallError: Free usage limit reached"}) === true);
check("ordinary output is not a quota skip", isLiveQuotaExhausted({output: "AUTOPILOT_REVIEW={\"decision\":\"PASS\"}"}) === false);

// ── test-all summary keeps passing children's LIVE SKIPPED lines ───────────
{
  const output = [
    "PASS something",
    `${LIVE_SKIP_PREFIX} OpenCode free model 'opencode/x-free' could not run: free quota/rate limit exhausted`,
    "noise",
    `${LIVE_SKIP_PREFIX} no free OpenCode model (opencode/*-free) is listed`,
  ].join("\n");
  const lines = collectLiveSkipLines(output);
  check("collector keeps exactly the LIVE SKIPPED lines", lines.length === 2 && lines.every(line => line.startsWith(LIVE_SKIP_PREFIX)), lines);
  const summary = formatLiveSkipSummary([...lines, ...lines]);
  check("summary prints each skip once", summary.split("\n").filter(line => line.startsWith("- ")).length === 2, summary);
  check("empty summary is empty", formatLiveSkipSummary([]) === "");
}

// ── Static wiring: the live call site is pinned, not the CLI default ───────
{
  const liveSource = fs.readFileSync(path.join(here, "test-opencode-scratch-permission.mjs"), "utf8");
  check("scratch-permission part E resolves a free model", liveSource.includes("resolveLiveFreeOpenCodeModel()"), "missing resolver call");
  check("scratch-permission passes the resolved model to plan_reviewer",
    liveSource.includes("planReviewerModel: liveModel.model"), "part E still builds plan_reviewer with \"\"");
  const allSource = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
  check("test-all collects LIVE SKIPPED output", allSource.includes("collectLiveSkipLines(result.output)"), "summary collector missing");
  check("test-all prints the summary", allSource.includes("printLiveSkipped()"), "summary printer not called");
}

if (failures) {
  console.error(`${failures} live free-model picker check(s) failed.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
