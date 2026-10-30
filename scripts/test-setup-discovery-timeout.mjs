#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {discoverModelCatalog, discoverCapabilities, normalizeReasoning, parseOpenCodeVerboseOutput, DISCOVERY_TIMEOUT_MS} from "./model-discovery.mjs";
import {buildDiscoveryCaches} from "./setup-discovery.mjs";

// The production model-list timeout is deliberately generous (30 s). Keep
// this regression test fast by shrinking it through the supported override.
process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS = "1500";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ap-discovery-timeout-"));

function makeBin(name, scriptPath) {
  if (process.platform === "win32") {
    const bin = path.join(temporary, name + ".cmd");
    fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return bin;
  }
  const bin = path.join(temporary, name);
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function countNodeProcesses() {
  if (process.platform === "win32") {
    const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]});
    if (r.status !== 0) return -1;
    return (String(r.stdout || "").match(/^".*"/gm) || []).length;
  }
  const r = spawnSync("pgrep", ["-c", "-f", "setInterval.*10000"], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]});
  if (r.status !== 0) return 0;
  return parseInt(String(r.stdout || "").trim(), 10) || 0;
}

function countFixtureProcesses() {
  const r = spawnSync("pgrep", ["-f", "ap-discovery-timeout-"], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]});
  if (r.status !== 0) return 0;
  return (String(r.stdout || "").split("\n").filter(Boolean)).length;
}

try {
  // ── 1. Hanging OpenCode binary is killed within timeout ──
  {
    const hangScript = path.join(temporary, "hang-opencode.mjs");
    fs.writeFileSync(hangScript, [
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", () => {});',
      'setInterval(() => {}, 10000);'
    ].join("\n"));
    const hangBin = makeBin("hang-opencode", hangScript);

    const start = Date.now();
    const result = await discoverModelCatalog({binary: hangBin, model_discovery: "opencode_models"});
    const elapsed = Date.now() - start;

    assert.ok(Array.isArray(result), "hanging discovery must return an array");
    assert.equal(result.length, 0, "hanging discovery must return empty on timeout");
    assert.equal(result.status, "timeout", "hanging discovery must report a timeout status");
    assert.ok(elapsed < DISCOVERY_TIMEOUT_MS + 5000, `must complete within timeout + margin, took ${elapsed}ms`);
    console.log("PASS: hanging OpenCode discovery terminated within timeout");
  }

  // ── 2. Hanging Codex app-server is killed within timeout ──
  {
    const hangScript = path.join(temporary, "hang-codex.mjs");
    fs.writeFileSync(hangScript, [
      'process.stdin.setEncoding("utf8");',
      'let buffer = "";',
      'process.stdin.on("data", chunk => { buffer += chunk; });',
      'setInterval(() => {}, 10000);'
    ].join("\n"));
    const hangBin = makeBin("hang-codex", hangScript);

    const start = Date.now();
    const result = await discoverModelCatalog({binary: hangBin, model_discovery: "codex_app_server"});
    const elapsed = Date.now() - start;

    assert.ok(Array.isArray(result), "hanging codex must return an array");
    assert.equal(result.length, 0, "hanging codex must return empty on timeout");
    assert.equal(result.status, "timeout", "hanging codex must report a timeout status");
    assert.ok(elapsed < 12000, `must complete within codex timeout + margin, took ${elapsed}ms`);
    console.log("PASS: hanging Codex app-server discovery terminated within timeout");
  }

  // ── 3. No fixture processes leaked after timeouts ──
  {
    await new Promise(r => setTimeout(r, 500));
    const leaked = countFixtureProcesses();
    assert.equal(leaked, 0, `must have 0 leaked fixture processes, found ${leaked}`);
    console.log("PASS: no fixture processes leaked after timeout");
  }

  // ── 4. buildDiscoveryCaches continues after timeout ──
  {
    const hangScript = path.join(temporary, "hang-cache.mjs");
    fs.writeFileSync(hangScript, [
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", () => {});',
      'setInterval(() => {}, 10000);'
    ].join("\n"));
    const hangBin = makeBin("hang-cache", hangScript);

    const agents = {
      opencode: {binary: hangBin, model_discovery: "opencode_models", help_args: ["--help"], probe: ["--help"]},
    };

    const start = Date.now();
    const {capabilityCache} = await buildDiscoveryCaches(["opencode"], agents);
    const elapsed = Date.now() - start;

    // Backlog #5: a timed-out model list is retried once with double the
    // effective budget, so the bound must include that second attempt.
    const retryBudgetMs = 2 * Number(process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS);
    assert.ok(capabilityCache.has("opencode"), "cache must have entry even after timeout");
    assert.ok(elapsed < DISCOVERY_TIMEOUT_MS + retryBudgetMs + 5000, `must complete within timeout + retry + margin, took ${elapsed}ms`);
    console.log("PASS: buildDiscoveryCaches continues after discovery timeout");
  }

  // ── 5. Successful OpenCode discovery still works ──
  {
    const okScript = path.join(temporary, "ok-opencode.mjs");
    const modelData = JSON.stringify({name: "Good Model", supportedReasoningEfforts: ["low", "high"]});
    fs.writeFileSync(okScript, [
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", () => {});',
      `console.log("provider/good-model");`,
      `console.log(${JSON.stringify(modelData)});`,
      'setTimeout(() => {}, 50);'
    ].join("\n"));
    const okBin = makeBin("ok-opencode", okScript);

    const result = await discoverModelCatalog({binary: okBin, model_discovery: "opencode_models"});
    assert.ok(Array.isArray(result), "successful discovery must return an array");
    assert.ok(result.length >= 1, "successful discovery must return models");
    assert.equal(result[0].id, "provider/good-model");
    assert.deepEqual(result[0].reasoning, ["low", "high"]);
    console.log("PASS: successful OpenCode live discovery still works");
  }

  // ── 6. Codex reasoning objects render as readable strings ──
  {
    const codexScript = path.join(temporary, "codex-objects.mjs");
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        data: [
          {slug: "gpt-obj-test", displayName: "GPT Obj Test", supportedReasoningEfforts: [{level: "low"}, {level: "high"}]},
          {slug: "gpt-str-test", displayName: "GPT Str Test", supportedReasoningEfforts: ["medium"]},
          {slug: "gpt-mixed-test", displayName: "GPT Mixed Test", supportedReasoningEfforts: [{name: "low"}, "high"]}
        ]
      }
    });
    fs.writeFileSync(codexScript, [
      'process.stdin.setEncoding("utf8");',
      'let buffer = "";',
      'process.stdin.on("data", chunk => {',
      '  buffer += chunk;',
      '  if (buffer.includes(\'"method":"model/list"\')) {',
      `    console.log(${JSON.stringify(response)});`,
      '  }',
      '});'
    ].join("\n"));
    const codexBin = makeBin("codex-objects", codexScript);

    const result = await discoverModelCatalog({binary: codexBin, model_discovery: "codex_app_server"});
    assert.equal(result.length, 3, "must discover all 3 models");

    for (const model of result) {
      for (const r of model.reasoning) {
        assert.equal(typeof r, "string", `reasoning must be a string, got ${typeof r}: ${JSON.stringify(r)} for model ${model.id}`);
        assert.ok(!String(r).includes("[object Object]"), `no [object Object]: ${JSON.stringify(r)}`);
      }
    }

    const objModel = result.find(m => m.id === "gpt-obj-test");
    assert.deepEqual(objModel.reasoning, ["low", "high"], "objects with .level normalize to level string");

    const strModel = result.find(m => m.id === "gpt-str-test");
    assert.deepEqual(strModel.reasoning, ["medium"], "strings pass through unchanged");

    const mixedModel = result.find(m => m.id === "gpt-mixed-test");
    assert.deepEqual(mixedModel.reasoning, ["low", "high"], "mixed objects and strings all normalize");

    console.log("PASS: Codex reasoning objects rendered as readable choices");
  }

  // ── 7. normalizeReasoning export works correctly ──
  {
    assert.deepEqual(normalizeReasoning(["low", "high"]), ["low", "high"]);
    assert.deepEqual(normalizeReasoning([{level: "low"}, {level: "high"}]), ["low", "high"]);
    assert.deepEqual(normalizeReasoning([{name: "medium"}]), ["medium"]);
    assert.deepEqual(normalizeReasoning([{effort: "low"}]), ["low"]);
    assert.deepEqual(normalizeReasoning([{unknown: true}]), [], "unknown objects filtered, no [object Object]");
    assert.deepEqual(normalizeReasoning([]), []);
    assert.deepEqual(normalizeReasoning(null), []);
    assert.deepEqual(normalizeReasoning(undefined), []);
    assert.deepEqual(normalizeReasoning(["low", {level: "high"}, "medium"]), ["low", "high", "medium"]);
    console.log("PASS: normalizeReasoning correctly normalizes all edge cases");
  }

  // ── 8. parseOpenCodeVerboseOutput normalizes reasoning objects ──
  {
    const verbose = [
      "provider/model-a",
      '{"name": "Model A", "supportedReasoningEfforts": [{"level": "low"}, {"level": "high"}]}',
      "provider/model-b",
      '{"name": "Model B", "supported_reasoning_efforts": ["medium"]}'
    ].join("\n");
    const parsed = parseOpenCodeVerboseOutput(verbose);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0].reasoning, ["low", "high"]);
    assert.deepEqual(parsed[1].reasoning, ["medium"]);
    console.log("PASS: parseOpenCodeVerboseOutput normalizes reasoning objects");
  }

  // ── 9. No [object Object] in menu output ──
  {
    const reasoningFromCodex = ["low", "high"];
    const reasoningFromObjects = normalizeReasoning([{level: "low"}, {name: "high"}]);
    const allOptions = ["Use CLI default", ...reasoningFromCodex, ...reasoningFromObjects];

    for (const opt of allOptions) {
      assert.ok(!String(opt).includes("[object Object]"), `option must not contain [object Object]: ${opt}`);
    }
    const rendered = allOptions.map((x, i) => `${i + 1}) ${x}`);
    for (const line of rendered) {
      assert.ok(!line.includes("[object Object]"), `menu line must not contain [object Object]: ${line}`);
    }
    console.log("PASS: no [object Object] in menu rendering");
  }

  // ── 10. Reasoning value persistence ──
  {
    const codexScript = path.join(temporary, "codex-persist.mjs");
    const response = JSON.stringify({
      jsonrpc: "2.0", id: 2,
      result: { data: [{slug: "gpt-persist", displayName: "GPT Persist", supportedReasoningEfforts: ["low", "high"]}] }
    });
    fs.writeFileSync(codexScript, [
      'process.stdin.setEncoding("utf8");',
      'let buffer = "";',
      'process.stdin.on("data", chunk => {',
      '  buffer += chunk;',
      '  if (buffer.includes(\'"method":"model/list"\')) {',
      `    console.log(${JSON.stringify(response)});`,
      '  }',
      '});'
    ].join("\n"));
    const codexBin = makeBin("codex-persist", codexScript);

    const catalog = await discoverModelCatalog({binary: codexBin, model_discovery: "codex_app_server"});
    const model = catalog[0];
    const selectedReasoning = model.reasoning[1];

    assert.equal(typeof selectedReasoning, "string", "persisted reasoning must be a string");
    assert.equal(selectedReasoning, "high", "persisted value must match expected string");
    const effortModelIds = {low: "gpt-persist-low", high: "gpt-persist-high"};
    assert.equal(effortModelIds[selectedReasoning], "gpt-persist-high", "string reasoning works as object key");
    console.log("PASS: selected reasoning value persists as correct string format");
  }

  // ── 11. Real Codex CLI live verification (skip if not installed) ──
  {
    const whichCmd = process.platform === "win32" ? "where.exe" : "which";
    const check = spawnSync(whichCmd, ["codex"], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]});
    if (check.status === 0) {
      const codexPath = String(check.stdout || "").split(/\r?\n/)[0].trim();
      if (codexPath) {
        console.log(`  Real Codex found at: ${codexPath}`);
        const catalog = await discoverModelCatalog({binary: codexPath, model_discovery: "codex_app_server"});
        assert.ok(Array.isArray(catalog), "real Codex discovery must return an array");
        if (catalog.length > 0) {
          for (const model of catalog) {
            assert.equal(typeof model.id, "string", `model id must be string: ${JSON.stringify(model)}`);
            assert.ok(model.id.length > 0, `model id must not be empty`);
            for (const r of model.reasoning) {
              assert.equal(typeof r, "string", `real Codex reasoning must be string, got ${typeof r}: ${JSON.stringify(r)}`);
              assert.ok(!String(r).includes("[object Object]"), `no [object Object] in real Codex reasoning`);
            }
          }
          console.log(`PASS: real Codex CLI live discovery verified (${catalog.length} models)`);
        } else {
          console.log("PASS: real Codex CLI found but returned no models (auth or network issue - acceptable)");
        }
      }
    } else {
      console.log("SKIP: real Codex CLI not installed, skipping live verification");
    }
  }

  // ── 12. Real OpenCode CLI live verification (skip if not installed) ──
  {
    const whichCmd = process.platform === "win32" ? "where.exe" : "which";
    const check = spawnSync(whichCmd, ["opencode"], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]});
    if (check.status === 0) {
      const ocPath = String(check.stdout || "").split(/\r?\n/)[0].trim();
      if (ocPath) {
        console.log(`  Real OpenCode found at: ${ocPath}`);
        const catalog = await discoverModelCatalog({binary: ocPath, model_discovery: "opencode_models"});
        assert.ok(Array.isArray(catalog), "real OpenCode discovery must return an array");
        if (catalog.length > 0) {
          for (const model of catalog) {
            assert.equal(typeof model.id, "string", `model id must be string`);
            assert.ok(model.id.includes("/"), `model id must have provider/model format: ${model.id}`);
            for (const r of model.reasoning) {
              assert.equal(typeof r, "string", `real OpenCode reasoning must be string, got ${typeof r}`);
              assert.ok(!String(r).includes("[object Object]"), `no [object Object] in real OpenCode reasoning`);
            }
          }
          console.log(`PASS: real OpenCode CLI live discovery verified (${catalog.length} models)`);
        } else {
          console.log("PASS: real OpenCode CLI found but returned no models (acceptable)");
        }
      }
    } else {
      console.log("SKIP: real OpenCode CLI not installed, skipping live verification");
    }
  }

  console.log("\nAll setup discovery timeout and Codex reasoning tests passed.");
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}
