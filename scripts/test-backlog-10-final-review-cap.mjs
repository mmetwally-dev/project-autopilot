#!/usr/bin/env node
// Backlog #10:
// - Final review turns cap: 2x per-phase code_reviewer cap by default,
//   configurable via caps.final_review_max_turns (null = 2x default).
// - Config layout, validation, and JSON schema for caps.final_review_max_turns.
// - Wrap-up session store subpaths & copyWrapUpSessionStore for claude,
//   opencode, antigravity (and null for codex), verified with a fake claude
//   CLI that persists sessions under $HOME/.claude/.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  resolveFinalReviewMaxTurns,
  resolvePerRoleLimits,
  wrapUpSessionStoreSubpath,
  copyWrapUpSessionStore,
} from "./per-task-budget.mjs";
import {DEFAULTS, toRuntimeConfig, toNewLayoutConfig} from "./config-layout.mjs";
import {validateNewConfig} from "./config-validation.mjs";
import {buildConfigSchema} from "./gen-config-schema.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

// ── 1. resolveFinalReviewMaxTurns ─────────────────────────────────────────
check("cap: default is 2x code_reviewer default (44)",
  resolveFinalReviewMaxTurns({}) === 44,
  resolveFinalReviewMaxTurns({}));

check("cap: null final_review_max_turns uses 2x code_reviewer cap",
  resolveFinalReviewMaxTurns({final_review_max_turns: null, caps: {code_reviewer: {max_turns: 30}}}) === 60);

check("cap: explicit final_review_max_turns overrides 2x default",
  resolveFinalReviewMaxTurns({final_review_max_turns: 55, caps: {code_reviewer: {max_turns: 30}}}) === 55);

check("cap: per-phase code_reviewer cap stays unchanged when final_review_max_turns is set",
  resolvePerRoleLimits("code_reviewer", {final_review_max_turns: 55, caps: {code_reviewer: {max_turns: 30}}}).perTaskMaxTurns === 30);

check("cap: invalid final_review_max_turns falls back to 2x",
  resolveFinalReviewMaxTurns({final_review_max_turns: 0, caps: {code_reviewer: {max_turns: 25}}}) === 50
  && resolveFinalReviewMaxTurns({final_review_max_turns: -5}) === 44
  && resolveFinalReviewMaxTurns({final_review_max_turns: 1.5}) === 44);

check("cap: free model turns cap still applies as floor",
  resolveFinalReviewMaxTurns(
    {final_review_max_turns: 30, free_model_turns_cap: 50},
    {adapter: "opencode", model: "opencode/mimo-v2-flash-free", free_model_pattern: "-free$"}
  ) === 50);

// ── 2. Config layout, validation, and schema ──────────────────────────────
check("layout: DEFAULTS.caps.final_review_max_turns is null",
  DEFAULTS.caps.final_review_max_turns === null);

{
  const layout = structuredClone(DEFAULTS);
  layout.caps.final_review_max_turns = 50;
  const rt = toRuntimeConfig(layout);
  check("layout: toRuntimeConfig maps caps.final_review_max_turns -> policy.final_review_max_turns",
    rt.policy.final_review_max_turns === 50, rt.policy.final_review_max_turns);
  const back = toNewLayoutConfig(rt);
  check("layout: toNewLayoutConfig maps policy.final_review_max_turns -> caps.final_review_max_turns",
    back.caps.final_review_max_turns === 50, back.caps.final_review_max_turns);
}

{
  const base = structuredClone(DEFAULTS);
  base.roles.planner.cli = "claude";
  base.roles.implementer.cli = "claude";
  const okNull = validateNewConfig({...base, caps: {...base.caps, final_review_max_turns: null}});
  check("validation: caps.final_review_max_turns=null is valid",
    okNull.valid && okNull.errors.length === 0, okNull.errors);

  const okInt = validateNewConfig({...base, caps: {...base.caps, final_review_max_turns: 60}});
  check("validation: caps.final_review_max_turns=60 is valid",
    okInt.valid && okInt.errors.length === 0, okInt.errors);

  const badZero = validateNewConfig({...base, caps: {...base.caps, final_review_max_turns: 0}});
  check("validation: caps.final_review_max_turns=0 is rejected",
    !badZero.valid && badZero.errors.some(e => e.includes("caps.final_review_max_turns")), badZero.errors);

  const badStr = validateNewConfig({...base, caps: {...base.caps, final_review_max_turns: "60"}});
  check("validation: caps.final_review_max_turns='60' is rejected",
    !badStr.valid && badStr.errors.some(e => e.includes("caps.final_review_max_turns")), badStr.errors);
}

{
  const schema = buildConfigSchema();
  const node = schema.properties?.caps?.properties?.final_review_max_turns;
  check("schema: caps.final_review_max_turns has nullable integer with minimum 1",
    node && Array.isArray(node.type) && node.type.includes("integer") && node.type.includes("null") && node.minimum === 1 && node.default === null,
    node);
}

// ── 3. Wrap-up session store subpaths & copy with fake claude CLI ─────────
check("subpath: claude/opencode/antigravity/codex",
  wrapUpSessionStoreSubpath("claude") === ".claude"
  && wrapUpSessionStoreSubpath("opencode") === ".local/share/opencode"
  && wrapUpSessionStoreSubpath("antigravity") === ".gemini/antigravity-cli"
  && wrapUpSessionStoreSubpath("codex") === null);

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-b10-session-"));
  try {
    const fakeClaude = path.join(tmp, "fake-claude.mjs");
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const home = process.env.HOME;
const store = path.join(home, ".claude", "projects", "repo");
const resumeIdx = args.indexOf("--resume");
if (resumeIdx !== -1) {
  const sid = args[resumeIdx + 1];
  const file = path.join(store, sid + ".jsonl");
  if (!fs.existsSync(file)) {
    console.log(JSON.stringify({type: "result", is_error: true, errors: ["No conversation found with session ID: " + sid]}));
    process.exit(1);
  }
  console.log(JSON.stringify({type: "result", session_id: sid, result: "resumed ok"}));
  process.exit(0);
}
const sid = "sess-claude-123";
fs.mkdirSync(store, {recursive: true});
fs.writeFileSync(path.join(store, sid + ".jsonl"), '{"type":"assistant"}\\n');
console.log(JSON.stringify({type: "system", subtype: "init", session_id: sid}));
`, "utf8");
    fs.chmodSync(fakeClaude, 0o755);

    const cappedHome = path.join(tmp, "capped-home");
    const wrapUpHome = path.join(tmp, "wrapup-home");
    fs.mkdirSync(cappedHome, {recursive: true});
    fs.mkdirSync(wrapUpHome, {recursive: true});

    const r1 = spawnSync(process.execPath, [fakeClaude], {env: {...process.env, HOME: cappedHome}, encoding: "utf8"});
    check("fake-claude: capped run creates session in cappedHome/.claude",
      r1.status === 0 && fs.existsSync(path.join(cappedHome, ".claude", "projects", "repo", "sess-claude-123.jsonl")));

    // Simulate 0-byte bwrap .credentials.json mountpoint in cappedHome/.claude
    fs.writeFileSync(path.join(cappedHome, ".claude", ".credentials.json"), "");

    // Without copying, wrapUpHome fails with "No conversation found"
    const rFail = spawnSync(process.execPath, [fakeClaude, "--resume", "sess-claude-123"], {env: {...process.env, HOME: wrapUpHome}, encoding: "utf8"});
    check("fake-claude: without copy, resume fails with No conversation found",
      rFail.status === 1 && rFail.stdout.includes("No conversation found with session ID: sess-claude-123"), rFail.stdout);

    // Copy session store via copyWrapUpSessionStore
    const copied = copyWrapUpSessionStore({
      fromDir: path.join(cappedHome, ".claude"),
      toDir: path.join(wrapUpHome, ".claude"),
      adapterId: "claude",
    });
    check("copyWrapUpSessionStore: returns true and skips .credentials.json",
      copied === true
      && fs.existsSync(path.join(wrapUpHome, ".claude", "projects", "repo", "sess-claude-123.jsonl"))
      && !fs.existsSync(path.join(wrapUpHome, ".claude", ".credentials.json")));

    const rOk = spawnSync(process.execPath, [fakeClaude, "--resume", "sess-claude-123"], {env: {...process.env, HOME: wrapUpHome}, encoding: "utf8"});
    check("fake-claude: after copy, resume finds the capped session and succeeds",
      rOk.status === 0 && rOk.stdout.includes("resumed ok"), rOk.stdout);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}

// ── 4. Wiring checks in autopilot.mjs ─────────────────────────────────────
{
  const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  check("wire: runRelay accepts wrapUpSessionStoreDir and copies before launch",
    src.includes("wrapUpSessionStoreDir=null") && src.includes("copyWrapUpSessionStore("));
  check("wire: runFinalReviewSessions uses resolveFinalReviewMaxTurns",
    src.includes("resolveFinalReviewMaxTurns(c.policy"));
  check("wire: CODE_REVIEW_CAPPED_TWICE wired in handleCodeReviewerUnchangedNote",
    src.includes('code:"CODE_REVIEW_CAPPED_TWICE"')
    && src.includes("handleCodeReviewerUnchangedNote({s,rv,prevNote:prevRawNote")
    && src.includes("handleCodeReviewerUnchangedNote({s,rv,prevNote:reviewHandoffNote||\"\""));
}

if (failures) {
  console.error(`${failures} backlog-10 check(s) failed.`);
  process.exit(1);
}
console.log("backlog-10 final-review-cap & wrap-up session tests passed");
