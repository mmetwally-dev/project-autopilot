import assert from "node:assert/strict";
import fs from "node:fs";
import {runFailedBeforeFirstStep, isSessionNotFound} from "./session-reset.mjs";
import {formatRoleFallbackLog} from "./role-fallback.mjs";
import {saveRoleSession, clearRoleSession, roleSession} from "./relay-guards.mjs";

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const i = src.indexOf("Backlog #112: a model switch clears");
assert.ok(i > 0);
const block = src.slice(i, i + 500);
assert.ok(block.includes("if(result.fallbackSwitch) clearRoleSession(s,roleName)"), "switch clears session");
assert.ok(block.includes("runFailedBeforeFirstStep"), "early failure not stored");
assert.ok(src.includes("(!result.sessionId || result.fallbackSwitch)"), "retry after switch is fresh");
assert.ok(src.includes("isSessionNotFound(role.adapter,p?.stderr)") && src.includes("__sessionRetry:true"), "session-not-found relaunch once");

// Mirror of the save/clear rule.
const s = {};
saveRoleSession(s, "verifier", "ses_old");
const apply = (r, ev) => { if (r.fallbackSwitch) clearRoleSession(s, "verifier"); else if (r.sessionId && !runFailedBeforeFirstStep("opencode", r.status, ev)) saveRoleSession(s, "verifier", r.sessionId); };
apply({fallbackSwitch: {}, sessionId: "ses_old", status: "failed"}, []);
assert.equal(roleSession(s, "verifier"), null, "switch -> next launch has no session");
apply({sessionId: "ses_new", status: "failed"}, [{type: "step_start"}]);
assert.equal(roleSession(s, "verifier"), null, "failed-early run stores nothing");
apply({sessionId: "ses_ok", status: "failed"}, [{type: "step_finish"}]);
assert.equal(roleSession(s, "verifier"), "ses_ok", "run with a completed step stores");
assert.equal(runFailedBeforeFirstStep("opencode", "completed", []), false);

assert.ok(isSessionNotFound("opencode", "Error: Session not found"));
assert.ok(!isSessionNotFound("claude", "Session not found"));
assert.ok(!isSessionNotFound("opencode", "other"));

const log = formatRoleFallbackLog({role: "verifier", from: {adapter: "opencode", model: "opencode/a-free"}, to: {adapter: "opencode", model: "opencode/b-free"}});
assert.ok(!log.includes("opencode/opencode/"), log);
console.log("PASS 112");

// Stored session must match adapter CLI + model to be resumable.
{
  const { storedSessionMatches } = await import("./session-reset.mjs");
  const assert = (await import("node:assert/strict")).default;
  assert.equal(storedSessionMatches({ sessionId: "a", cli: "opencode", model: "m1" }, "opencode", "m1"), true);
  assert.equal(storedSessionMatches({ sessionId: "a", cli: "opencode", model: "m1" }, "opencode", "m2"), false);
  assert.equal(storedSessionMatches({ sessionId: "a", cli: "opencode", model: "m1" }, "claude", "m1"), false);
  assert.equal(storedSessionMatches({ sessionId: "a", cli: "opencode", model: null }, "opencode", null), true);
  assert.equal(storedSessionMatches({ sessionId: "a", cli: "opencode" }, "opencode", "m9"), true, "legacy session without model matches on cli");
  assert.equal(storedSessionMatches(null, "opencode", "m1"), false);
  console.log("test-112 stored-session match OK");
}
