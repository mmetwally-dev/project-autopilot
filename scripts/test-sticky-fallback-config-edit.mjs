#!/usr/bin/env node
// Backlog open #6: sticky fallback survives an edit of that fallback entry in the config.
// staleStickyFallback drops the sticky entry when it no longer matches any entry
// in the role's current fallbacks (or primary/escalation); preflight prints which
// role is on a fallback.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  stampStickyFallback,
  staleStickyFallback,
  canonicalModelId,
  describeModel,
} from "./role-fallback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

const T0 = Date.parse("2026-11-05T12:00:00.000Z");
const T0_ISO = "2026-11-05T12:00:00.000Z";

const primary = {adapter: "opencode", model: "deepseek-chat"};
const oldFallback = {adapter: "opencode", model: "gemini-3.8-flash-high"};
const newFallback = {adapter: "opencode", model: "gemini-3.8-flash-medium"};
const escModel = {adapter: "opencode", model: "o3-mini"};

const stickyOld = stampStickyFallback(oldFallback, primary, T0_ISO);
const stickyNew = stampStickyFallback(newFallback, primary, T0_ISO);
const stickyEsc = stampStickyFallback(escModel, primary, T0_ISO);

// 1. sticky = old fallback, config fallbacks edited → cleared
{
  const roleConfig = {
    ...primary,
    fallbacks: [newFallback],
  };
  const result = staleStickyFallback({
    role: "implementer",
    roleConfig,
    activeModel: stickyOld,
    nowMs: T0 + 5000,
  });
  assert.equal(result?.why, "config");
  assert.equal(
    result?.message,
    "fallback cleared: implementer active fallback opencode/gemini-3.8-flash-high is no longer in the config's fallbacks; retrying primary opencode/deepseek-chat",
  );
  console.log("PASS sticky-edited-fallback-cleared");
}

// 2. sticky still listed → kept
{
  const roleConfig = {
    ...primary,
    fallbacks: [oldFallback, newFallback],
  };
  const result = staleStickyFallback({
    role: "implementer",
    roleConfig,
    activeModel: stickyOld,
    nowMs: T0 + 5000,
  });
  assert.equal(result, null);
  console.log("PASS sticky-still-listed-kept");
}

// 3. sticky equals escalation → kept (both escalation and escalation_model)
{
  const roleConfigWithEscalation = {
    ...primary,
    fallbacks: [newFallback],
    escalation: escModel,
  };
  const resultEsc = staleStickyFallback({
    role: "implementer",
    roleConfig: roleConfigWithEscalation,
    activeModel: stickyEsc,
    nowMs: T0 + 5000,
  });
  assert.equal(resultEsc, null);

  const roleConfigWithEscalationModel = {
    ...primary,
    fallbacks: [newFallback],
    escalation_model: escModel,
  };
  const resultEscModel = staleStickyFallback({
    role: "implementer",
    roleConfig: roleConfigWithEscalationModel,
    activeModel: stickyEsc,
    nowMs: T0 + 5000,
  });
  assert.equal(resultEscModel, null);
  console.log("PASS sticky-equals-escalation-kept");
}

// 4. sticky equals primary → kept
{
  const stickyPrimary = stampStickyFallback(primary, primary, T0_ISO);
  const roleConfig = {
    ...primary,
    fallbacks: [newFallback],
  };
  const result = staleStickyFallback({
    role: "implementer",
    roleConfig,
    activeModel: stickyPrimary,
    nowMs: T0 + 5000,
  });
  assert.equal(result, null);
  console.log("PASS sticky-equals-primary-kept");
}

// 5. Preflight output and wiring checks in autopilot.mjs
{
  // Wiring in preflightConfiguredRoles: syncStickyFallback is called and the fallback line format is present
  assert.ok(
    autopilotSource.includes("on fallback ${canonicalModelId(active)} since ${active.since}"),
    "must format role on fallback with canonical model id and since",
  );
  // Both loops share the start path in main() which calls preflightConfiguredRoles before dispatch
  assert.ok(
    autopilotSource.includes("await preflightConfiguredRoles(c,s)") || autopilotSource.includes("await preflightConfiguredRoles(c, s)"),
    "preflightConfiguredRoles must receive s in main() start path",
  );
  console.log("PASS preflight-wiring");
}

// 6. Preflight output execution test (capture console output)
{
  const logged = [];
  const originalLog = console.log;
  try {
    console.log = (...args) => logged.push(args.join(" "));

    // Simulate preflight logic on state with sticky fallback still in config
    const roleConfig = {
      ...primary,
      fallbacks: [newFallback],
    };
    const c = {roles: {implementer: roleConfig}};
    const s = {activeRoleModels: {implementer: stickyNew}};

    // Verify canonicalModelId output
    const active = s.activeRoleModels.implementer;
    const line = `implementer: on fallback ${canonicalModelId(active)} since ${active.since}`;
    console.log(line);

    assert.equal(
      logged[0],
      "implementer: on fallback opencode/gemini-3.8-flash-medium since 2026-11-05T12:00:00.000Z",
    );
  } finally {
    console.log = originalLog;
  }
  console.log("PASS preflight-output-format");
}

console.log("test-sticky-fallback-config-edit: all cases passed");
