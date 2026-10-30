#!/usr/bin/env node
import {validateNewConfig} from "./config-validation.mjs";

let failed = 0;
function check(name, ok) {
  if (!ok) { failed++; console.error(`FAIL: ${name}`); } else console.log(`ok: ${name}`);
}
const run = (tests) => validateNewConfig({tests}).errors;
const has = (errs, key) => errs.some((e) => e.includes(key));

check("valid e2e values accepted", ["playwright", "cypress", "none"].every((v) => !has(run({e2e: v}), "e2e")));
check("unset e2e accepted", !has(run({}), "e2e"));
check("invalid e2e rejected", has(run({e2e: "selenium"}), "tests.e2e"));
check("non-string e2e rejected", has(run({e2e: 5}), "tests.e2e"));
check("boolean marker accepted", !has(run({e2e_setup_pending: true}), "e2e_setup_pending") && !has(run({e2e_setup_pending: false}), "e2e_setup_pending"));
check("non-boolean marker rejected", has(run({e2e_setup_pending: "yes"}), "e2e_setup_pending"));
check("unknown tests key still rejected", has(run({bogus_key: 1}), "bogus_key"));

if (failed) process.exit(1);
