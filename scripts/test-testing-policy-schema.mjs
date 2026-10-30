#!/usr/bin/env node
// tests.e2e / tests.e2e_setup_pending: generator output carries both keys.
import {buildConfigSchema, ENUMS} from "./gen-config-schema.mjs";

let failed = 0;
function check(name, ok) {
  if (!ok) { failed++; console.error(`FAIL ${name}`); } else console.log(`ok ${name}`);
}

const tests = buildConfigSchema().properties.tests.properties;
const e2e = tests.e2e;
const pending = tests.e2e_setup_pending;
const want = ["playwright", "cypress", "none"];
check("e2e present as string or null", JSON.stringify(e2e?.type) === JSON.stringify(["string", "null"]));
check("e2e enum", JSON.stringify(e2e?.enum) === JSON.stringify([...want, null]));
check("ENUMS entry matches", JSON.stringify(ENUMS["tests.e2e"]) === JSON.stringify(want));
check("e2e has description", typeof e2e?.description === "string" && e2e.description.length > 0);
check("e2e default is null", e2e && e2e.default === null);
check("e2e_setup_pending is boolean", pending?.type === "boolean");
check("e2e_setup_pending has description", typeof pending?.description === "string" && pending.description.length > 0);
check("e2e_setup_pending default is false", pending && pending.default === false);

process.exit(failed ? 1 : 0);
