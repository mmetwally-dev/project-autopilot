#!/usr/bin/env node
import {validateNewConfig} from "./config-validation.mjs";

let failed = 0;
function check(name, ok) {
  if (!ok) { failed++; console.error(`FAIL: ${name}`); } else console.log(`ok: ${name}`);
}

const {warnings} = validateNewConfig({capabilities: {verification: {}}});
const msg = warnings.find((w) => w.startsWith("capabilities.verification:")) || "";
check("legacy verification alias warning emitted", msg !== "");
check("alias text names tests.e2e", msg.includes("tests.browser, tests.require_browser, tests.e2e"));
check("alias pin: project_defaults still mapped",
  validateNewConfig({capabilities: {project_defaults: {}}}).warnings.some((w) => w.includes("advanced.capabilities.project_defaults")));

if (failed) process.exit(1);
