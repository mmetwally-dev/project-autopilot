#!/usr/bin/env node
// Backlog #12(c): at `ap run` start, warn (never stop) when an OpenCode role
// has no explicit model and the operator's OpenCode auth.json lists any
// provider other than `opencode`. The fake auth.json here is real JSON read by
// the production helper; no network, CLI, or real HOME is touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  OPENCODE_AUTH_RELATIVE_PATH,
  opencodeAuthProviderIds,
  opencodeCliDefaultWarnings,
  opencodeCliDefaultWarningMessage,
} from "./preflight.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  return false;
}

const tempDirs = [];
function fakeHome(providers) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ap-opencode-auth-"));
  tempDirs.push(home);
  const file = path.join(home, OPENCODE_AUTH_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(providers, null, 2));
  return {home, file};
}

const role = (adapter, model = "") => ({adapter, model, reasoning: "", variant: "", resume: false});
const config = roles => ({roles});

try {
  // ── auth.json with deepseek => warning for the empty-model OpenCode role ──
  {
    const {home, file} = fakeHome({opencode: {type: "oauth"}, deepseek: {type: "api", key: "x"}});
    check("auth reader lists both providers", opencodeAuthProviderIds({authFile: file}).sort().join(",") === "deepseek,opencode", opencodeAuthProviderIds({authFile: file}));
    const warnings = opencodeCliDefaultWarnings({
      config: config({plan_reviewer: role("opencode"), implementer: role("opencode", "opencode/free-model-free")}),
      home,
    });
    check("deepseek + empty OpenCode model => one warning", warnings.length === 1, warnings);
    check("warning names the role", warnings[0]?.includes("role 'plan_reviewer'"), warnings[0]);
    check("warning names the paid provider", warnings[0]?.includes("deepseek"), warnings[0]);
    check("warning is advisory, not a stop", warnings[0]?.includes("may use a paid provider"), warnings[0]);
    check("warning tells the operator how to fix it", warnings[0]?.includes("ap config"), warnings[0]);
    const message = opencodeCliDefaultWarningMessage(warnings);
    check("formatted message starts with Warning:", message.startsWith("Warning: "), message);
    check("formatted message is one line per role", message.split("\n").length === 1, message);
    check("the explicit-model role contributes no warning", !message.includes("implementer"), message);
  }

  // ── only opencode in auth.json => no warning ─────────────────────────────
  {
    const {home, file} = fakeHome({opencode: {type: "oauth"}});
    const warnings = opencodeCliDefaultWarnings({config: config({plan_reviewer: role("opencode")}), home});
    check("only opencode provider => no warning", warnings.length === 0, warnings);
    check("auth reader ignores the opencode-only provider", opencodeAuthProviderIds({authFile: file}).join(",") === "opencode", opencodeAuthProviderIds({authFile: file}));
  }

  // ── an explicit OpenCode model => no warning even with deepseek ──────────
  {
    const {home} = fakeHome({opencode: {}, deepseek: {}});
    const warnings = opencodeCliDefaultWarnings({
      config: config({plan_reviewer: role("opencode", "opencode/free-model-free")}),
      home,
    });
    check("explicit OpenCode model => no warning", warnings.length === 0, warnings);
  }

  // ── no auth.json / malformed JSON / no OpenCode role => no warning ───────
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ap-opencode-empty-"));
    tempDirs.push(home);
    check("missing auth.json => no providers and no warning", opencodeAuthProviderIds({home}).length === 0
      && opencodeCliDefaultWarnings({config: config({a: role("opencode")}), home}).length === 0);
    const file = path.join(home, OPENCODE_AUTH_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, "{not json");
    check("malformed auth.json => no warning", opencodeCliDefaultWarnings({config: config({a: role("opencode")}), home}).length === 0);
    const {home: paidHome} = fakeHome({deepseek: {}});
    check("deepseek but no OpenCode role => no warning", opencodeCliDefaultWarnings({config: config({a: role("cursor")}), home: paidHome}).length === 0);
  }
} finally {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

// ── `ap run` really calls the helper at preflight, as a warning ────────────
{
  const autopilotSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "autopilot.mjs"), "utf8");
  check("ap run imports the CLI-default warning helper", autopilotSource.includes("opencodeCliDefaultWarnings"), "helper not imported");
  check("ap run calls it in preflightConfiguredRoles", /function preflightConfiguredRoles[\s\S]{0,1200}opencodeCliDefaultWarnings\(\{config:c\}\)/.test(autopilotSource), "preflight call missing");
  check("the warning is printed with console.warn, not thrown", /if\(cliDefaultWarning\) console\.warn\(cliDefaultWarning\)/.test(autopilotSource), "warning path is not warn-only");
}

if (failures) {
  console.error(`${failures} OpenCode CLI-default preflight check(s) failed.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
