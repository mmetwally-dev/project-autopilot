#!/usr/bin/env node
// Adapter certification was removed from the supported runtime. `ap adapter
// certify`/`status` remain as recognized commands (backward compatibility
// for scripts/muscle memory) but perform no certification: they print a
// clear message and exit 0. `ap run` performs a lightweight, non-authoritative
// preflight on every run instead (see scripts/preflight.mjs).
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadAgents() {
  return JSON.parse(fs.readFileSync(path.join(skillRoot, "adapters", "agents.json"), "utf8")).adapters;
}

function parseArgs(argv) {
  const action = argv[0];
  const adapter = argv[1];
  if (!["certify", "status"].includes(action) || !adapter) {
    throw new Error("Usage: ap adapter <certify|status> <adapter> [--repo PATH]");
  }
  return {action, adapter};
}

export function runAdapterCommand(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const agents = loadAgents();
  const adapter = agents[parsed.adapter];
  if (!adapter) throw new Error(`Unknown adapter '${parsed.adapter}'.`);
  console.log(`Adapter certification is no longer required by Project Autopilot.`);
  console.log(`'ap run' checks each configured CLI automatically on every run:`);
  console.log(`  - the executable ('${adapter.binary}') is present`);
  console.log(`  - '--version'/'--help' actually runs`);
  console.log(`  - configured model/reasoning/variant flags are structurally supported`);
  console.log(`  - the repository and scratch paths are usable`);
  console.log(`No receipt is written and nothing here is a security gate.`);
  return {ok: true, adapter: parsed.adapter, action: parsed.action};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runAdapterCommand();
  } catch (error) {
    console.error(`${error.message}`);
    process.exit(2);
  }
}
