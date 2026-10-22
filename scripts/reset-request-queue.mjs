#!/usr/bin/env node
// Live reset-request queue (backlog #56).
//
// The `ap reset` side channel used to be a SINGLE-request file:
// `pendingResetPath()` held one bare request object, so a second `ap reset`
// for a different budget key while a run was live silently overwrote the
// first one (a lost reset — the operator's earlier request vanished before
// the running mission ever saw it). This module owns the QUEUE that file now
// carries, so many requests for many budget keys can be handed to one live
// run at the same time and each is honoured at its own decision point.
//
// Shape on disk (wire-compatible with the legacy format):
//   legacy:  {key,scope,at,requestedBy,requestedPid}
//   queued:  {"requests":[{key,scope,…},{key,scope,…}]}
// `readResetRequests()` reads BOTH, so a queue file written by an older
// autopilot still resolves — nothing on disk is migrated.
//
// Every write goes through `atomicWriteFileSync` (same precedent, and same
// requirement, as `saveState()`): the queue is read back as a whole document
// by the running mission, so a crash may leave only the previous complete
// queue or the new complete queue — never truncated JSON.
//
// All IO is plain `node:fs` (the caller passes paths, so no `repo`/`cfg()`
// closure is needed here) and the module has no import-time side effects.
import fs from "node:fs";
import {atomicWriteFileSync} from "./atomic-state-write.mjs";

// The persisted document for a queue. Kept exported so callers/tests assert
// the exact on-disk shape instead of re-stringifying it themselves.
export function serializeResetRequests(requests) {
  return JSON.stringify({requests}, null, 2);
}

// Read the whole queue as an array of request objects; never throws:
// - a missing or unparseable/corrupt file reads as [] (no request staged);
// - the legacy bare single request object normalizes to a one-entry array;
// - the queued `{requests:[…]}` document is used as-is;
// - anything else (null, number, string, object without `requests`) reads as
//   [] — an unknown shape is treated as "nothing staged" rather than being
//   guessed at, so it can never fire a bogus reset.
export function readResetRequests(filePath) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return []; // missing or corrupt
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.requests)) return parsed.requests;
    // Legacy single request: any object carrying budget-identity fields.
    if (parsed.key !== undefined || parsed.scope !== undefined) return [parsed];
  }
  return [];
}

// Append `request` to the queue, replacing only an existing entry with the
// SAME `key` (the newest request for one budget key wins — an operator who
// re-arms the same key must not end up with two live resets for it). Entries
// for other keys are left untouched, which is the whole point of the queue.
// Returns the new queue.
export function enqueueResetRequest(filePath, request) {
  const kept = readResetRequests(filePath).filter(entry => entry?.key !== request?.key);
  const queue = [...kept, request];
  atomicWriteFileSync(filePath, serializeResetRequests(queue));
  return queue;
}

// Remove only the entry for `key`; when that was the last entry the file is
// deleted so an empty queue never lingers on disk (and never reads back as a
// stale "armed" reset in some later run). Removing a key that is not queued
// is a no-op that still leaves the file consistent.
export function removeResetRequest(filePath, key) {
  const queue = readResetRequests(filePath).filter(entry => entry?.key !== key);
  if (queue.length === 0) {
    removeAllResetRequests(filePath);
    return [];
  }
  atomicWriteFileSync(filePath, serializeResetRequests(queue));
  return queue;
}

// Drop every queued request (an idle `ap reset` discards the whole side
// channel so a leftover can never fire during some later run). Best-effort,
// like the `rmSync` it replaces: a missing file is not an error.
export function removeAllResetRequests(filePath) {
  try {
    fs.rmSync(filePath);
  } catch {
    /* best-effort: nothing staged */
  }
}
