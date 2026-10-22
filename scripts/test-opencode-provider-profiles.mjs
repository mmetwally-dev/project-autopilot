#!/usr/bin/env node
// Focused deterministic tests for the OpenCode manifest: the selection.effort
// declaration and the model-scoped provider-egress profile data shape.
// (The resolver that consumed this data lived in the removed
// controlled-egress platform; only the manifest guards remain.)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {canonicalJson, CAPABILITY_IDS} from "./capability-contract.mjs";

let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(skillRoot, "adapters", "agents.json"), "utf8")).adapters;
const opencode = manifest.opencode;

// ---- 1. selection.effort declaration ----
check("OpenCode declares selection.effort as an adapter capability",
  opencode.declared_capabilities["selection.effort"] === true);
check("declared selection.effort is a registered functional capability id",
  CAPABILITY_IDS.includes("selection.effort"));

// ---- 7. Manifest shape guards ----
const profiles = opencode.provider_egress.profiles;
check("deepseek profile exists and zen profile is untouched",
  profiles.deepseek && profiles["opencode-zen"]
  && canonicalJson(profiles["opencode-zen"].destinations) === canonicalJson([
    {host: "opencode.ai", port: 443},
    {host: "models.opencode.ai", port: 443}
  ]));
check("prefix map contains only the two approved prefixes",
  canonicalJson(opencode.provider_egress.profiles_by_model_prefix) === canonicalJson({
    "deepseek/": "deepseek",
    "opencode/": "opencode-zen"
  }));

if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All OpenCode provider-profile checks passed.");
