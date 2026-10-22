#!/usr/bin/env node
// Mission 088 task 1.1: pure fallback-edit helper unit tests.
// Covers list ops (add/remove/move with index validation), reviewer-
// independence warnings for both pairs on primary or fallback equality,
// quota/paid labels with the example ids, and module purity (no I/O).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  addFallback,
  removeFallbackAt,
  moveFallback,
  applyFallbacks,
  reviewerIndependenceWarning,
  costLabelFor,
  formatFallbackEntry,
} from "./role-fallback-edit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleSrc = fs.readFileSync(path.join(here, "role-fallback-edit.mjs"), "utf8");

// 0. Purity: no imports, no I/O handles (console/process/fs/network).
{
  assert.ok(!/^\s*import\s/m.test(moduleSrc), "module must have no imports");
  assert.ok(!moduleSrc.includes("require("), "module must not use require");
  for (const token of ["console.", "process.", "fs.", "net.", "fetch(", "readFile", "writeFile"]) {
    assert.ok(!moduleSrc.includes(token), `module must not reference ${token}`);
  }
  console.log("PASS no-io-purity");
}

const A = {adapter: "opencode", model: "muse-spark"};
const B = {adapter: "claude", model: "opus-4-1"};
const C = {adapter: "openai", model: "gpt-5"};

// 1. List ops: add appends, inputs never mutated, copies are fresh.
{
  const base = [A];
  const added = addFallback(base, B);
  assert.deepEqual(added, [A, B], "add appends after existing entries");
  assert.deepEqual(base, [A], "add must not mutate the input list");
  added[0].model = "mutated";
  assert.equal(base[0].model, "muse-spark", "returned entries must be copies");
  console.log("PASS add-append-no-mutate");
}

// 1b. Remove by index; invalid indices throw RangeError.
{
  const removed = removeFallbackAt([A, B, C], 1);
  assert.deepEqual(removed, [A, C], "remove drops the indexed entry");
  for (const bad of [-1, 3, 99, 1.5, NaN, "0"]) {
    assert.throws(() => removeFallbackAt([A, B], bad), RangeError, `remove index ${String(bad)} must throw`);
  }
  console.log("PASS remove-index-validation");
}

// 1c. Move reorders; both indices validated against the original list.
{
  assert.deepEqual(moveFallback([A, B, C], 0, 2), [B, C, A], "move first to last");
  assert.deepEqual(moveFallback([A, B, C], 2, 0), [C, A, B], "move last to first");
  assert.deepEqual(moveFallback([A, B], 1, 1), [A, B], "move to same index is a no-op");
  for (const [from, to] of [[-1, 0], [0, 5], [2, 0]]) {
    assert.throws(() => moveFallback([A, B], from, to), RangeError, `move ${from}→${to} must throw`);
  }
  console.log("PASS move-index-validation");
}

// 1d. Empty list maps to key removal; non-empty sets fresh copies.
{
  const role = {adapter: "claude", model: "opus-4-1", fallbacks: [A]};
  const emptied = applyFallbacks(role, []);
  assert.ok(!("fallbacks" in emptied), "empty list must remove the fallbacks key");
  assert.deepEqual(role.fallbacks, [A], "apply must not mutate the input config");
  const applied = applyFallbacks({adapter: "claude", model: "x"}, [A, B]);
  assert.deepEqual(applied.fallbacks, [A, B], "non-empty list is stored in order");
  applied.fallbacks[0].model = "mutated";
  assert.equal(A.model, "muse-spark", "stored entries must be copies");
  console.log("PASS empty-list-removes-key");
}

// 2. Reviewer independence: both pairs warn on primary or fallback equality.
{
  const roles = {
    implementer: {adapter: "codex", model: "gpt-5", fallbacks: [{adapter: "opencode", model: "longcat"}]},
    code_reviewer: {adapter: "claude", model: "opus-4-1", fallbacks: []},
    planner: {adapter: "claude", model: "opus-4-1", fallbacks: []},
    plan_reviewer: {adapter: "opencode", model: "muse-spark", fallbacks: []},
  };
  // code_reviewer vs implementer primary and fallback.
  assert.ok(
    reviewerIndependenceWarning({role: "code_reviewer", candidate: {adapter: "codex", model: "gpt-5"}, roles}),
    "code_reviewer matching implementer primary must warn",
  );
  assert.ok(
    reviewerIndependenceWarning({role: "code_reviewer", candidate: {adapter: "opencode", model: "longcat"}, roles}),
    "code_reviewer matching implementer fallback must warn",
  );
  // plan_reviewer vs planner primary.
  assert.ok(
    reviewerIndependenceWarning({role: "plan_reviewer", candidate: {adapter: "claude", model: "opus-4-1"}, roles}),
    "plan_reviewer matching planner primary must warn",
  );
  // Reverse direction: implementer matching code_reviewer primary.
  assert.ok(
    reviewerIndependenceWarning({role: "implementer", candidate: {adapter: "claude", model: "opus-4-1"}, roles}),
    "implementer matching code_reviewer primary must warn",
  );
  // Planner fallback equality warns for plan_reviewer.
  const withPlannerFallback = {
    ...roles,
    planner: {adapter: "claude", model: "opus-4-1", fallbacks: [{adapter: "openai", model: "gpt-5-mini"}]},
  };
  assert.ok(
    reviewerIndependenceWarning({role: "plan_reviewer", candidate: {adapter: "openai", model: "gpt-5-mini"}, roles: withPlannerFallback}),
    "plan_reviewer matching planner fallback must warn",
  );
  // No match, unpaired role, or missing counterpart: no warning.
  assert.equal(
    reviewerIndependenceWarning({role: "code_reviewer", candidate: {adapter: "openai", model: "gpt-5"}, roles}),
    null, "unrelated model must not warn",
  );
  assert.equal(
    reviewerIndependenceWarning({role: "verifier", candidate: {adapter: "codex", model: "gpt-5"}, roles}),
    null, "unpaired role must not warn",
  );
  assert.equal(
    reviewerIndependenceWarning({role: "code_reviewer", candidate: {adapter: "codex", model: "gpt-5"}, roles: {}}),
    null, "missing counterpart config must not warn",
  );
  console.log("PASS reviewer-pairs-primary-and-fallback");
}

// 3. Quota/paid labels with the exact rule and example ids.
{
  assert.equal(costLabelFor({adapter: "claude", model: "opus-4-1"}), "uses Claude plan quota", "claude adapter is quota");
  assert.equal(costLabelFor({adapter: "openai", model: "gpt-5"}), "may be paid", "non-claude id without free marker may be paid");
  assert.equal(costLabelFor({adapter: "openrouter", model: "x:free"}), "", "':free' marker is unmarked");
  assert.equal(costLabelFor({adapter: "openrouter", model: "x-free"}), "", "'-free' marker is unmarked");
  assert.equal(
    formatFallbackEntry({adapter: "claude", model: "opus-4-1"}),
    "claude/opus-4-1 (uses Claude plan quota)",
    "quota label formats into the entry",
  );
  assert.equal(
    formatFallbackEntry({adapter: "openai", model: "gpt-5"}),
    "openai/gpt-5 (may be paid)",
    "paid label formats into the entry",
  );
  assert.equal(
    formatFallbackEntry({adapter: "openrouter", model: "x:free"}),
    "openrouter/x:free",
    "free model formats without a mark",
  );
  console.log("PASS quota-paid-label-rule");
}

console.log("role-fallback-edit: all tests passed");
