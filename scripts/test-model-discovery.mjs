#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {discoverModelCatalog, parseOpenCodeVerboseOutput, parseAntigravityModels} from "./model-discovery.mjs";

const tempDirs = new Set();
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ap-models-"));
tempDirs.add(temporary);
const server = path.join(temporary, "fake-codex.mjs");
fs.writeFileSync(server, `process.stdin.setEncoding("utf8");let buffer="";process.stdin.on("data",chunk=>{buffer+=chunk;if(buffer.includes('"method":"model/list"')){console.log(JSON.stringify({jsonrpc:"2.0",id:2,result:{data:[{slug:"gpt-test-a",displayName:"GPT Test A",supportedReasoningEfforts:["low","high"]},{slug:"gpt-test-b",displayName:"GPT Test B",supportedReasoningEfforts:["medium"]}]}}));}});`);
let binary;
if (process.platform === "win32") {
  binary = path.join(temporary, "codex.cmd");
  fs.writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`);
} else {
  binary = path.join(temporary, "codex");
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`);
  fs.chmodSync(binary, 0o755);
}
const result = await discoverModelCatalog({binary, model_discovery: "codex_app_server"});
if (result.length !== 2 || result[0].id !== "gpt-test-a" || result[0].reasoning.join(",") !== "low,high") throw new Error(`Codex discovery failed: ${JSON.stringify(result)}`);

const verbose = `openai/gpt-5.2
{
  "name": "GPT 5.2",
  "variants": {"low": {}, "medium": {}, "high": {}}
}
anthropic/claude-opus-4-6
{
  "name": "Claude Opus 4.6",
  "variants": {"high": {}, "max": {}}
}`;
const parsed = parseOpenCodeVerboseOutput(verbose);
assert.equal(parsed.length, 2);
assert.deepEqual(parsed[0].variants, ["low", "medium", "high"]);
assert.deepEqual(parsed[1].variants, ["high", "max"]);
console.log("model discovery tests passed");

const antigravitySample = `gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low      Gemini 3.7 Flash (Low)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
gemini-3.1-pro-low        Gemini 3.1 Pro (Low)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium      GPT-OSS 120B (Medium)`;
const antigravity = parseAntigravityModels(antigravitySample);
assert.equal(antigravity.find(item => item.id === "gemini-3.7-flash")?.effortModelIds.high, "gemini-3.7-flash-high");
assert.deepEqual(antigravity.find(item => item.id === "gemini-3.7-flash")?.reasoning, ["low", "medium", "high"]);
assert.equal(antigravity.find(item => item.id === "claude-sonnet-4-6")?.reasoning.length, 0);
console.log("PASS: Antigravity live model grouping + effort suffix discovery");
