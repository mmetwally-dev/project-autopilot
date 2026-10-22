#!/usr/bin/env node
// Focused unit test for scripts/reset-request-queue.mjs (backlog #56).
//
// Imports the helper directly (never a test hook inside `autopilot.mjs`,
// which runs `main()` at import and cannot be imported). Proves the six
// behaviours the wiring in task 1.2 depends on:
// 1. two requests for DIFFERENT budget keys are both kept after two enqueues
//    (the lost-update the queue exists to fix);
// 2. a repeat request for the SAME key leaves exactly one entry, newest wins;
// 3. a legacy bare single-request object file reads as one normalized entry;
// 4. a missing / corrupt file reads as [];
// 5. removing one key leaves the other queued;
// 6. an emptied queue leaves no file on disk.
// Plus the on-disk shape: `{requests:[…]}` written atomically through
// `atomicWriteFileSync` (never a partial direct write).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  readResetRequests,
  enqueueResetRequest,
  removeResetRequest,
  removeAllResetRequests
} from "./reset-request-queue.mjs";

function makeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function cleanup(dir) {
  try { fs.rmSync(dir, {recursive: true, force: true}); } finally { /* best-effort */ }
}
const request = (key, scope) => ({
  key,
  scope,
  at: "2026-01-01T00:00:00.000Z",
  requestedBy: "ap reset",
  requestedPid: process.pid
});

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

// ── 1. Two different keys both survive two enqueues ────────────────────────
{
  const dir = makeDir("ap-reset-queue-two-keys-");
  try {
    const file = path.join(dir, ".autopilot", "reset-request.json");
    enqueueResetRequest(file, request("infrastructureRetryBudget:mission", "mission"));
    enqueueResetRequest(file, request("adapterRetryBudget:adapter:cursor:plan_reviewer", "adapter:cursor:plan_reviewer"));
    const queue = readResetRequests(file);
    check("two keys: two entries queued", queue.length === 2, queue);
    check("two keys: first key intact", queue[0]?.key === "infrastructureRetryBudget:mission");
    check("two keys: second key intact", queue[1]?.key === "adapterRetryBudget:adapter:cursor:plan_reviewer");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    check("two keys: document shape is {requests:[…]}", Array.isArray(doc.requests) && doc.requests.length === 2, doc);
    check("two keys: pretty two-space serialization",
      fs.readFileSync(file, "utf8") === JSON.stringify({requests: doc.requests}, null, 2));
    check("two keys: enqueue returns the new queue", (() => {
      const again = enqueueResetRequest(file, request("implementationFailureBudget:task:x", "task:x"));
      return again.length === 3 && readResetRequests(file).length === 3;
    })());
  } finally { cleanup(dir); }
}

// ── 2. Same key re-enqueued: exactly one entry, newest wins ────────────────
{
  const dir = makeDir("ap-reset-queue-dedupe-");
  try {
    const file = path.join(dir, "reset-request.json");
    const first = request("infrastructureRetryBudget:mission", "mission");
    first.at = "2026-01-01T00:00:00.000Z";
    const second = request("infrastructureRetryBudget:mission", "mission");
    second.at = "2026-01-02T00:00:00.000Z";
    enqueueResetRequest(file, first);
    enqueueResetRequest(file, second);
    const queue = readResetRequests(file);
    check("dedupe: exactly one entry", queue.length === 1, queue);
    check("dedupe: newest request wins", queue[0]?.at === "2026-01-02T00:00:00.000Z", queue[0]);
    check("dedupe: key untouched by dedupe", queue[0]?.key === "infrastructureRetryBudget:mission");
    check("dedupe: other keys are not dropped", (() => {
      enqueueResetRequest(file, request("adapterRetryBudget:adapter:cursor:plan_reviewer", "adapter:cursor:plan_reviewer"));
      enqueueResetRequest(file, second);
      const q = readResetRequests(file);
      return q.length === 2 && q.map((r) => r.key).includes("adapterRetryBudget:adapter:cursor:plan_reviewer");
    })());
  } finally { cleanup(dir); }
}

// ── 3. Legacy bare single request object normalizes to one entry ───────────
{
  const dir = makeDir("ap-reset-queue-legacy-");
  try {
    const file = path.join(dir, "reset-request.json");
    const legacy = {key: "continuationAllowance:task:standalone:phase-1:abc123", scope: "task:standalone:phase-1:abc123", at: "2026-01-01T00:00:00.000Z", requestedBy: "ap reset", requestedPid: 4242};
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
    const queue = readResetRequests(file);
    check("legacy: single object reads as one entry", queue.length === 1, queue);
    check("legacy: entry deep-equals the stored request", JSON.stringify(queue[0]) === JSON.stringify(legacy));
    check("legacy: enqueue normalizes the file to the queued shape", (() => {
      enqueueResetRequest(file, request("infrastructureRetryBudget:mission", "mission"));
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(doc.requests) && doc.requests.length === 2
        && doc.requests[0].key === legacy.key && doc.requests[1].key === "infrastructureRetryBudget:mission";
    })());
  } finally { cleanup(dir); }
}

// ── 4. Missing / corrupt / unknown shapes read as [] ───────────────────────
{
  const dir = makeDir("ap-reset-queue-empty-");
  try {
    const missing = path.join(dir, "reset-request.json");
    check("empty: missing file reads as []", readResetRequests(missing).length === 0);
    const corrupt = path.join(dir, "corrupt.json");
    fs.writeFileSync(corrupt, "{not json at all");
    check("empty: corrupt file reads as []", readResetRequests(corrupt).length === 0);
    check("empty: corrupt file is left untouched", fs.readFileSync(corrupt, "utf8") === "{not json at all");
    for (const [label, content] of [["null", "null"], ["number", "42"], ["string", '"reset"'], ["empty object", "{}"]]) {
      const p = path.join(dir, `shape-${label.replace(/\s+/g, "-")}.json`);
      fs.writeFileSync(p, content);
      check(`empty: ${label} reads as []`, readResetRequests(p).length === 0);
    }
    check("empty: directory path reads as []", readResetRequests(dir).length === 0);
    // Enqueueing over a missing file creates it (mkdirSync recursive inside).
    const nested = path.join(dir, "deep", "nested", "reset-request.json");
    enqueueResetRequest(nested, request("infrastructureRetryBudget:mission", "mission"));
    check("empty: enqueue creates the file", fs.existsSync(nested) && readResetRequests(nested).length === 1);
  } finally { cleanup(dir); }
}

// ── 5. Removing one key leaves the other queued ────────────────────────────
{
  const dir = makeDir("ap-reset-queue-remove-one-");
  try {
    const file = path.join(dir, "reset-request.json");
    enqueueResetRequest(file, request("infrastructureRetryBudget:mission", "mission"));
    enqueueResetRequest(file, request("adapterRetryBudget:adapter:cursor:plan_reviewer", "adapter:cursor:plan_reviewer"));
    const remaining = removeResetRequest(file, "infrastructureRetryBudget:mission");
    check("remove one: returns the remaining queue", remaining.length === 1 && remaining[0]?.key === "adapterRetryBudget:adapter:cursor:plan_reviewer", remaining);
    const queue = readResetRequests(file);
    check("remove one: other key still queued", queue.length === 1 && queue[0]?.key === "adapterRetryBudget:adapter:cursor:plan_reviewer");
    check("remove one: file still exists", fs.existsSync(file));
    // Removing an unknown key is a no-op.
    removeResetRequest(file, "nothing:queued");
    check("remove one: unknown key is a no-op", readResetRequests(file).length === 1);
    // Removing from a missing file is a no-op that reports an empty queue.
    check("remove one: missing file reports []", removeResetRequest(path.join(dir, "gone.json"), "x").length === 0);
  } finally { cleanup(dir); }
}

// ── 6. An emptied queue leaves no file on disk ─────────────────────────────
{
  const dir = makeDir("ap-reset-queue-remove-all-");
  try {
    const file = path.join(dir, "reset-request.json");
    enqueueResetRequest(file, request("infrastructureRetryBudget:mission", "mission"));
    removeResetRequest(file, "infrastructureRetryBudget:mission");
    check("emptied: last removal deletes the file", !fs.existsSync(file));
    check("emptied: deleted file reads as []", readResetRequests(file).length === 0);
    enqueueResetRequest(file, request("infrastructureRetryBudget:mission", "mission"));
    enqueueResetRequest(file, request("adapterRetryBudget:adapter:cursor:plan_reviewer", "adapter:cursor:plan_reviewer"));
    removeAllResetRequests(file);
    check("remove-all: deletes the file", !fs.existsSync(file));
    check("remove-all: reads back as []", readResetRequests(file).length === 0);
    const again = enqueueResetRequest(file, request("verificationFailureBudget:task:y", "task:y"));
    check("remove-all: queue is reusable afterwards", again.length === 1 && readResetRequests(file).length === 1);
    // Idempotent / best-effort: removing twice, and on a never-existing path.
    removeAllResetRequests(file);
    removeAllResetRequests(file);
    removeAllResetRequests(path.join(dir, "never-existed.json"));
    check("remove-all: best-effort on missing files", !fs.existsSync(file));
  } finally { cleanup(dir); }
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
