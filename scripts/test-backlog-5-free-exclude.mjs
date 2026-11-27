#!/usr/bin/env node
// Backlog #5: roles.free_models.exclude config + glob filtering in
// extendFallbackWithFree + validation + schema/example/docs + identical
// setup/config question + tool-markup debris file name check.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DEFAULTS, toRuntimeConfig, toNewLayoutConfig} from "./config-layout.mjs";
import {validateNewConfig} from "./config-validation.mjs";
import {extendFallbackWithFree, matchesFreeModelExclude} from "./free-fallback-discovery.mjs";
import {FREE_MODELS_EXCLUDE_QUESTION, parseFreeModelsExcludeAnswer} from "./setup.mjs";
import {
  isToolMarkupDebrisPath,
  detectToolMarkupDebrisFiles,
  TOOL_MARKUP_DEBRIS_LABEL,
} from "./relay-guards.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// 1. Exclude glob skips opencode/beam-free and keeps other free models
{
  assert.equal(matchesFreeModelExclude({adapter: "opencode", model: "opencode/beam-free"}, ["opencode/beam-free"]), true);
  assert.equal(matchesFreeModelExclude({adapter: "opencode", model: "beam-free"}, ["opencode/beam-*"]), true);
  assert.equal(matchesFreeModelExclude({adapter: "opencode", model: "opencode/deepseek-v4.1-flash-free"}, ["opencode/beam-*"]), false);

  const primary = {adapter: "opencode", model: "opencode/deepseek-v4.1-flash-free"};
  const discovered = ["opencode/beam-free", "opencode/qwen-3-free"];
  const decision = await extendFallbackWithFree({
    decision: {action: "escalate", reason: "exhausted"},
    role: "implementer",
    roleConfig: primary,
    failureClass: "RATE_LIMITED",
    tried: [],
    discover: async () => discovered,
    enabled: true,
    exclude: ["opencode/beam-*"],
  });
  assert.equal(decision.action, "switch");
  assert.equal(decision.next.model, "opencode/qwen-3-free", "must skip opencode/beam-free and pick next free model");

  // Excluding all discovered models -> escalate
  const allExcluded = await extendFallbackWithFree({
    decision: {action: "escalate", reason: "exhausted"},
    role: "implementer",
    roleConfig: primary,
    failureClass: "RATE_LIMITED",
    tried: [],
    discover: async () => discovered,
    enabled: true,
    exclude: ["opencode/*-free"],
  });
  assert.equal(allExcluded.action, "escalate");
}
console.log("PASS 1: extendFallbackWithFree skips excluded globs and keeps other free models");

// 2. Config layout defaults, round-trip, and validation
{
  assert.deepEqual(DEFAULTS.roles.free_models.exclude, []);
  const layout = JSON.parse(JSON.stringify(DEFAULTS));
  layout.roles.free_models.exclude = ["opencode/beam-free", "opencode/*-tiny-*"];
  const rt = toRuntimeConfig(layout);
  assert.deepEqual(rt.freeModelExclude, ["opencode/beam-free", "opencode/*-tiny-*"]);
  const roundTrip = toNewLayoutConfig(rt);
  assert.deepEqual(roundTrip.roles.free_models.exclude, ["opencode/beam-free", "opencode/*-tiny-*"]);

  // Valid config passes
  const ok = validateNewConfig(layout);
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));

  // Non-array rejected
  const bad1 = JSON.parse(JSON.stringify(DEFAULTS));
  bad1.roles.free_models.exclude = "opencode/beam-free";
  const r1 = validateNewConfig(bad1);
  assert.equal(r1.valid, false);
  assert.ok(r1.errors.some((e) => e.includes("roles.free_models.exclude")), JSON.stringify(r1.errors));

  // Non-string element rejected
  const bad2 = JSON.parse(JSON.stringify(DEFAULTS));
  bad2.roles.free_models.exclude = ["opencode/beam-free", 42];
  const r2 = validateNewConfig(bad2);
  assert.equal(r2.valid, false);
  assert.ok(r2.errors.some((e) => e.includes("roles.free_models.exclude")), JSON.stringify(r2.errors));
}
console.log("PASS 2: config layout round-trip and validation reject non-array/non-string exclude");

// 3. Schema, config.example.json, docs/configuration.md
{
  const schema = JSON.parse(fs.readFileSync(path.join(root, "config.schema.json"), "utf8"));
  const prop = schema?.properties?.roles?.properties?.free_models?.properties?.exclude;
  assert.equal(prop?.type, "array", "config.schema.json roles.free_models.exclude type is array");
  assert.deepEqual(prop?.default, []);
  assert.ok(typeof prop?.description === "string" && prop.description.length > 0);

  const example = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  assert.deepEqual(example?.roles?.free_models?.exclude, []);

  const docs = fs.readFileSync(path.join(root, "docs", "configuration.md"), "utf8");
  assert.ok(docs.includes("`roles.free_models.exclude`"), "docs/configuration.md documents roles.free_models.exclude");
}
console.log("PASS 3: config.schema.json, config.example.json, docs/configuration.md carry roles.free_models.exclude");

// 4. Setup and ap config share identical question wording
{
  const expected = "Free models the automatic fallback must never use (comma-separated adapter/model, * allowed; Enter = none)";
  assert.equal(FREE_MODELS_EXCLUDE_QUESTION, expected);
  assert.deepEqual(parseFreeModelsExcludeAnswer("", []), []);
  assert.deepEqual(parseFreeModelsExcludeAnswer("opencode/beam-free, opencode/*-mini*", []), ["opencode/beam-free", "opencode/*-mini*"]);
  assert.deepEqual(parseFreeModelsExcludeAnswer("-", ["opencode/beam-free"]), []);
  assert.deepEqual(parseFreeModelsExcludeAnswer("", ["opencode/beam-free"]), ["opencode/beam-free"]);

  const setupSrc = fs.readFileSync(path.join(here, "setup.mjs"), "utf8");
  assert.ok(
    setupSrc.includes("wizardMode ||\n      scope === SCOPE.ALL ||\n      scope === SCOPE.ROLE;")
    && setupSrc.includes("await askFreeModelsExclude(current, interactive)"),
    "setup.mjs shares askFreeModelsExclude across setup (wizardMode) and ap config (editMode)"
  );
}
console.log("PASS 4: setup and ap config share identical question wording and answer parser");

// 5. Debris file name check flags tool-markup debris and ignores normal names
{
  assert.equal(TOOL_MARKUP_DEBRIS_LABEL, "tool-markup debris file name");
  assert.equal(isToolMarkupDebrisPath('apps/web/src/lib/admin/provisioning/slug.ts">\n'), true);
  assert.equal(isToolMarkupDebrisPath('apps/web/src/lib/admin/provisioning/sql-prisma.ts">\nplaceholder'), true);
  assert.equal(isToolMarkupDebrisPath('src/foo<parameter name="x">'), true);
  assert.equal(isToolMarkupDebrisPath("src/foo</invoke>"), true);
  assert.equal(isToolMarkupDebrisPath("apps/web/src/lib/admin/provisioning/slug.ts"), false);
  assert.equal(isToolMarkupDebrisPath("scripts/test-backlog-5-free-exclude.mjs"), false);

  const detected = detectToolMarkupDebrisFiles(
    [
      "apps/web/src/lib/admin/provisioning/slug.ts",
      'apps/web/src/lib/admin/provisioning/slug.ts">\n',
      'apps/web/src/lib/admin/provisioning/sql-prisma.ts">\nplaceholder',
      "preexisting\nfile.ts",
    ],
    {"preexisting\nfile.ts": {size: 1}}
  );
  assert.deepEqual(detected, [
    'apps/web/src/lib/admin/provisioning/slug.ts">\n',
    'apps/web/src/lib/admin/provisioning/sql-prisma.ts">\nplaceholder',
  ]);

  // Verify autopilot.mjs wires the check into makeRelayResult and both loops
  const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  assert.ok(autopilotSrc.includes("detectToolMarkupDebrisFiles(touchedFiles,before?.files)"));
  assert.ok(autopilotSrc.includes("tool_markup_debris_file_name"));
}
console.log("PASS 5: tool-markup debris file name check flags stray names and ignores normal/pre-existing files");

console.log("\nALL BACKLOG #5 TESTS PASSED.");
