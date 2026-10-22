#!/usr/bin/env node
// Regression coverage for the documented reasoning/effort fallback
// (adapters/documented-effort/<adapterId>.json + loadDocumentedEffort()).
//
// Distinct from test-documented-models.mjs's loadDocumentedCatalog()
// coverage: that mechanism is a second-tier fallback used only when LIVE
// model discovery fails entirely for an adapter. This one covers the
// opposite situation — live discovery for the adapter SUCCEEDS (a real
// model list comes back from the installed CLI), but the specific model's
// own entry reports no reasoning/effort levels, so setup.mjs would
// otherwise fall all the way through to a bare free-text prompt instead of
// a menu. See scripts/setup.mjs's pickModelAndCapabilities() (the
// `if (item.id && !reasoningOptions.length)` block) for the integration
// point this test proves end-to-end.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {loadDocumentedEffort} from "./model-discovery.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const effortDir = path.join(root, "adapters", "documented-effort");

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

// ==========================================================================
// Part 1 — shipped file shape + loadDocumentedEffort() unit coverage.
// ==========================================================================
{
  const files = fs.existsSync(effortDir) ? fs.readdirSync(effortDir).filter(f => f.endsWith(".json")) : [];
  check("at least one documented-effort catalog ships", files.length > 0, files);

  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(effortDir, f), "utf8")); // throws on malformed JSON
    check(`${f}: "source" is an http(s) URL`, typeof raw.source === "string" && /^https?:\/\//.test(raw.source), raw.source);
    check(`${f}: "last_verified" is a YYYY-MM-DD date`, typeof raw.last_verified === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.last_verified), raw.last_verified);
    check(`${f}: "levels" is a non-empty array of non-empty strings`, Array.isArray(raw.levels) && raw.levels.length > 0 && raw.levels.every(l => typeof l === "string" && l), raw.levels);
  }

  const codex = loadDocumentedEffort("codex");
  check("loadDocumentedEffort('codex') returns a usable snapshot", Boolean(codex));
  check(
    "codex documented effort levels match the fixed subset chosen for this menu",
    Array.isArray(codex?.levels) && codex.levels.join(",") === "low,medium,high,xhigh,max",
    codex?.levels
  );

  check("loadDocumentedEffort('does-not-exist') returns null", loadDocumentedEffort("does-not-exist") === null);
  check(
    "loadDocumentedEffort('claude') returns null — Claude's own per-model reasoning already comes from documented-models/claude.json, no separate effort file ships for it",
    loadDocumentedEffort("claude") === null
  );

  // Malformed-file rejection. The disposable fixtures go to a temp dir passed
  // as loadDocumentedEffort's test-only `dir` — never into the shipped
  // catalog, which is read-only inside an execution envelope (backlog closed #38).
  const scratchIds = [
    ["__test_bad_source__", {source: "not-a-url", last_verified: "2026-01-01", levels: ["low"]}],
    ["__test_bad_date__", {source: "https://example.com", last_verified: "not-a-date", levels: ["low"]}],
    ["__test_empty_levels__", {source: "https://example.com", last_verified: "2026-01-01", levels: []}],
    ["__test_non_string_level__", {source: "https://example.com", last_verified: "2026-01-01", levels: [1, 2]}]
  ];
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-effort-fixtures-"));
  try {
    for (const [id, content] of scratchIds) {
      fs.writeFileSync(path.join(fixtureDir, `${id}.json`), JSON.stringify(content), "utf8");
      check(`loadDocumentedEffort rejects malformed fixture (${id})`, loadDocumentedEffort(id, {dir: fixtureDir}) === null);
    }
  } finally {
    fs.rmSync(fixtureDir, {recursive: true, force: true});
  }
}

// ==========================================================================
// Part 2 — end-to-end proof: setup.mjs's wizard actually uses the fallback
// when a LIVE-discovered codex model reports no reasoning levels.
//
// Fake `codex` binary mirrors the fixture style already used by
// test-model-discovery.mjs (a `model/list` JSON-RPC responder over stdio)
// and test-setup-first-run-e2e.mjs (the observed-output-driven wizard
// pump — spawnSync's input:'...' cannot reliably drive setup.mjs's
// readline wizard, see that file's header comment for why). This fake
// model deliberately omits supportedReasoningEfforts.
// ==========================================================================
{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ap-effort-fallback-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-effort-fallback-repo-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-effort-fallback-bin-"));

  const server = path.join(temporary, "fake-codex.mjs");
  fs.writeFileSync(server, [
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") { process.stdout.write("codex-test 1.0.0\\n"); process.exit(0); }',
    'if (args[0] === "--help") { process.stdout.write("Usage: codex\\n  --model <name>\\n  --config <key=value>\\n"); process.exit(0); }',
    'if (args[0] === "app-server") {',
    '  process.stdin.setEncoding("utf8");',
    '  let buffer = "";',
    '  process.stdin.on("data", chunk => {',
    '    buffer += chunk;',
    '    if (buffer.includes(\'"method":"model/list"\')) {',
    // Deliberately no supportedReasoningEfforts field on this model.
    '      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,result:{data:[{slug:"fake-no-reasoning",displayName:"Fake No-Reasoning Model"}]}}) + "\\n");',
    '    }',
    '  });',
    '} else {',
    '  process.exit(0);',
    '}'
  ].join("\n"));

  let codexBin;
  if (process.platform === "win32") {
    codexBin = path.join(binDir, "codex.cmd");
    fs.writeFileSync(codexBin, `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`);
  } else {
    codexBin = path.join(binDir, "codex");
    fs.writeFileSync(codexBin, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`);
    fs.chmodSync(codexBin, 0o755);
  }

  // Drives setup.mjs's readline wizard by matching accumulated stdout
  // against an ORDERED script of {match, answer} pairs, sending each
  // answer only once its own prompt text has actually appeared — not by
  // firing generically on every stdout chunk. A single logical prompt
  // (label + option lines + "Choose [n]: ") arrives as multiple separate
  // writes, so a "send next answer on any new data" pump can consume many
  // queued answers before the prompt it was meant for even finishes
  // printing, landing later answers on the wrong question entirely. Gating
  // on the actual prompt substring removes that ambiguity. Once `stopAt`
  // matches, the child is killed immediately — this harness is for
  // capturing evidence from one specific prompt, not for completing the
  // wizard end-to-end (mirrors the spirit of test-setup-first-run-e2e.mjs's
  // observed-output-driven pump; see that file's header for why
  // spawnSync({input}) cannot safely drive this wizard at all).
  function runSetupInteractively({execPath, args, cwd, env, script, stopAt, timeoutMs}) {
    return new Promise(resolve => {
      const child = spawn(execPath, args, {cwd, env, stdio: ["pipe", "pipe", "pipe"]});
      let stdout = "";
      let stderr = "";
      let scriptIndex = 0;
      let settled = false;
      const settle = (status, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolve({status, signal, stdout, stderr});
      };
      const pump = () => {
        while (scriptIndex < script.length && script[scriptIndex].match.test(stdout)) {
          const {answer} = script[scriptIndex];
          scriptIndex += 1;
          try { child.stdin.write(`${answer}\n`); } catch { /* stdin already closed */ }
        }
        if (stopAt.test(stdout)) {
          try { child.kill("SIGTERM"); } catch { /* already dead */ }
        }
      };
      child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); pump(); });
      child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
      child.on("error", error => settle(null, null));
      const watchdog = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
      }, timeoutMs);
      child.on("close", (code, signal) => settle(code, signal));
    });
  }

  try {
    const delimiter = process.platform === "win32" ? ";" : ":";
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const systemDirs = process.platform === "win32"
      ? [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`]
      : ["/usr/bin", "/bin"];
    // Hermetic PATH: only the fake codex plus the bare minimum the OS needs
    // to spawn it — keeps this deterministic regardless of what real agent
    // CLIs happen to be installed on the machine running the test.
    const env = {...process.env, PATH: [binDir, ...systemDirs].join(delimiter)};

    const setupScript = path.join(root, "scripts", "setup.mjs");
    const r = await runSetupInteractively({
      execPath: process.execPath,
      args: [setupScript, "--wizard", "--repo", repo],
      cwd: root,
      env,
      // Each answer is sent only once ITS OWN prompt text has actually
      // appeared in accumulated stdout — see runSetupInteractively's own
      // comment for why. "2" on the model prompt picks the one
      // live-discovered model (option 1 is always "Use CLI default").
      script: [
        {match: /Press Enter to continue/, answer: ""},
        {match: /\nPlanner CLI\n/, answer: "2"},
        {match: /Planner model \(live discovery from codex\)/, answer: "2"}
      ],
      // Only the Planner role's reasoning prompt is under test — stop the
      // instant it appears, in either its menu or free-text form, rather
      // than driving the wizard to completion.
      // Stop only once setup is WAITING for the answer (output ends with the
      // ": " input prompt), so the whole menu has been printed — stopping at
      // the label alone raced the menu lines under a loaded parallel suite.
      stopAt: /Planner reasoning\/effort[\s\S]*: $/,
      timeoutMs: 30000
    });

    const combined = `${r.stdout || ""}\n${r.stderr || ""}`;

    check("setup.mjs spawned and produced output", combined.trim().length > 0);
    check("no crash during discovery", !/ReferenceError|TypeError: Cannot read properties of undefined/.test(combined), combined);

    check(
      "the fallback disclaimer names the selected model and is not silently skipped",
      combined.includes("Planner: documented reasoning/effort levels (not live-verified for Fake No-Reasoning Model)"),
      combined
    );
    check(
      "the disclaimer cites the real, dated source",
      combined.includes("Source: https://developers.openai.com/api/docs/guides/reasoning | verified: 2026-09-11"),
      combined
    );
    check(
      "a NUMBERED MENU is rendered for reasoning (not a bare free-text prompt)",
      combined.includes("Planner reasoning/effort (for selected model)"),
      combined
    );
    check(
      "the menu is built from the documented levels, in order",
      /1\) Use CLI default\s*\n2\) low\s*\n3\) medium\s*\n4\) high\s*\n5\) xhigh\s*\n6\) max/.test(combined),
      combined
    );
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(binDir, {recursive: true, force: true});
  }
}

if (failures) {
  console.error(`${failures} documented-effort-fallback check(s) failed.`);
  process.exit(1);
}
console.log("documented-effort-fallback tests passed");
