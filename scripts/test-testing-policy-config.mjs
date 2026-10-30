#!/usr/bin/env node
// tests.e2e / tests.e2e_setup_pending: layout <-> runtime round-trip, unset
// stays unset, migration and setup defaults leave e2e alone but keep a value.
import {readFileSync} from "node:fs";
import {toRuntimeConfig, toNewLayoutConfig, CONFIG_SCHEMA_VERSION} from "./config-layout.mjs";
import {migrateConfig} from "./config-migration.mjs";

let failed = 0;
function check(name, ok) {
  if (!ok) { failed++; console.error(`FAIL ${name}`); } else console.log(`ok ${name}`);
}

const withE2e = toRuntimeConfig({schema_version: CONFIG_SCHEMA_VERSION, tests: {e2e: "playwright", e2e_setup_pending: true}});
check("runtime maps tests.e2e", withE2e.capabilities?.verification?.e2e === "playwright");
check("runtime maps e2e_setup_pending", withE2e.capabilities?.verification?.e2e_setup_pending === true);
const back = toNewLayoutConfig(withE2e);
check("layout round-trip keeps e2e", back.tests?.e2e === "playwright");
check("layout round-trip keeps e2e_setup_pending", back.tests?.e2e_setup_pending === true);

const none = toNewLayoutConfig(toRuntimeConfig({schema_version: CONFIG_SCHEMA_VERSION, tests: {e2e: "none"}}));
check("explicit none stays none", none.tests?.e2e === "none");

const unset = toNewLayoutConfig(toRuntimeConfig({schema_version: CONFIG_SCHEMA_VERSION, tests: {}}));
check("unset e2e stays unset", !("e2e" in (unset.tests || {})));
check("unset e2e_setup_pending stays unset", !("e2e_setup_pending" in (unset.tests || {})));
const unsetRt = toRuntimeConfig({schema_version: CONFIG_SCHEMA_VERSION});
check("runtime unset e2e is undefined", unsetRt.capabilities?.verification?.e2e === undefined);

const mig = migrateConfig({schema_version: "1.0"}).config ?? migrateConfig({schema_version: "1.0"});
const migVer = mig.capabilities?.verification ?? {};
const migLayout = mig.tests ?? {};
check("migrated old config has no e2e", !("e2e" in migVer) && !("e2e" in migLayout));

const kept = migrateConfig({schema_version: "1.0", capabilities: {verification: {e2e: "cypress"}}});
const keptCfg = kept.config ?? kept;
check("migration preserves existing e2e", (keptCfg.capabilities?.verification?.e2e ?? keptCfg.tests?.e2e) === "cypress");

const setupSrc = readFileSync(new URL("./setup.mjs", import.meta.url), "utf8");
const m = setupSrc.match(/verification: \{\s*browser: "native",\s*require_browser: "when-task-requires"\s*\},\s*\.\.\.\(current\?\.capabilities \|\| \{\}\)/);
check("setup capabilities defaults leave e2e unset and spread current", !!m);

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("all passed");
