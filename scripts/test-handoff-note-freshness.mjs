#!/usr/bin/env node
// Mission 027 Phase 2 task 2.1 — hand-off note freshness unit tests.
//
// Pins the pure isHandoffNoteFresh() helper in per-task-budget.mjs: fresh
// only for a non-empty note newer than the last project edit within the
// bounded staleness window; stale on missing/empty/unreadable/skewed input.
import {
  isHandoffNoteFresh,
  HANDOFF_NOTE_FRESHNESS_WINDOW_MS,
  HANDOFF_NOTE_FRESHNESS_WINDOW_MAX_MS,
} from "./per-task-budget.mjs";

let failures = 0;
function check(name, condition, evidence) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`); }
}

const NOW = 1_700_000_000_000;
const freshArgs = (overrides = {}) => ({
  noteText: "1. Done — a.mjs.\n2. Found — a.mjs:10 foo().\n3. Next — edit a.mjs:12.\n4. Dead ends — none.",
  noteMtimeMs: NOW - 30_000,
  lastProjectEditMtimeMs: NOW - 60_000,
  nowMs: NOW,
  ...overrides,
});
const isFresh = (args) => isHandoffNoteFresh(args)?.fresh === true;

// ── Window bounds ──
check("window: default is a small bounded 5 minutes capped at 15 minutes",
  HANDOFF_NOTE_FRESHNESS_WINDOW_MS === 5 * 60 * 1000
  && HANDOFF_NOTE_FRESHNESS_WINDOW_MAX_MS === 15 * 60 * 1000,
  {HANDOFF_NOTE_FRESHNESS_WINDOW_MS, HANDOFF_NOTE_FRESHNESS_WINDOW_MAX_MS});

// ── Fresh case ──
{
  const r = isHandoffNoteFresh(freshArgs());
  check("fresh: non-empty note newer than the last edit within the window is fresh",
    r?.fresh === true && r?.reason === "fresh", r);
}

// ── Missing / empty notes ──
check("stale: null note is stale", isFresh(freshArgs({noteText: null})) === false);
check("stale: undefined note is stale", isFresh(freshArgs({noteText: undefined})) === false);
check("stale: non-string note is stale", isFresh(freshArgs({noteText: 42})) === false);
check("stale: empty note is stale",
  isHandoffNoteFresh(freshArgs({noteText: ""}))?.reason === "empty_note");
check("stale: whitespace-only note is stale",
  isHandoffNoteFresh(freshArgs({noteText: "   \n\t  "}))?.reason === "empty_note");

// ── Missing / unreadable times ──
check("stale: missing note mtime is stale",
  isHandoffNoteFresh(freshArgs({noteMtimeMs: undefined}))?.fresh === false);
check("stale: missing project-edit mtime is stale",
  isHandoffNoteFresh(freshArgs({lastProjectEditMtimeMs: null}))?.reason === "missing_time");
check("stale: missing now is stale",
  isHandoffNoteFresh(freshArgs({nowMs: undefined}))?.fresh === false);
check("stale: NaN times are stale (unreadable)",
  isHandoffNoteFresh(freshArgs({noteMtimeMs: NaN}))?.reason === "unreadable_time"
  && isHandoffNoteFresh(freshArgs({lastProjectEditMtimeMs: NaN}))?.reason === "unreadable_time"
  && isHandoffNoteFresh(freshArgs({nowMs: NaN}))?.reason === "unreadable_time");
check("stale: non-numeric time strings are stale (unreadable)",
  isHandoffNoteFresh(freshArgs({noteMtimeMs: "yesterday"}))?.reason === "unreadable_time");
check("stale: no args at all is stale, never throws",
  (() => { try { return isHandoffNoteFresh()?.fresh === false && isHandoffNoteFresh(undefined)?.fresh === false; } catch { return false; } })());

// ── Skewed clocks ──
check("stale: note dated after now is clock skew",
  isHandoffNoteFresh(freshArgs({noteMtimeMs: NOW + 60_000}))?.reason === "clock_skew");
check("stale: project edit dated after now is clock skew",
  isHandoffNoteFresh(freshArgs({lastProjectEditMtimeMs: NOW + 60_000}))?.reason === "clock_skew");

// ── Newer-than-edit rule ──
check("stale: note older than the last project edit is stale",
  isHandoffNoteFresh(freshArgs({noteMtimeMs: NOW - 120_000, lastProjectEditMtimeMs: NOW - 60_000}))?.reason
  === "note_not_newer_than_project_edit");
check("stale: note at exactly the edit time is stale (must be newer)",
  isHandoffNoteFresh(freshArgs({noteMtimeMs: NOW - 60_000, lastProjectEditMtimeMs: NOW - 60_000}))?.fresh === false);

// ── Staleness window ──
check("stale: note older than the window is stale",
  isHandoffNoteFresh(freshArgs({noteMtimeMs: NOW - HANDOFF_NOTE_FRESHNESS_WINDOW_MS - 1000, lastProjectEditMtimeMs: NOW - HANDOFF_NOTE_FRESHNESS_WINDOW_MS - 2000}))?.reason === "stale_note");
check("fresh: note exactly at the window edge is still fresh",
  isFresh(freshArgs({noteMtimeMs: NOW - HANDOFF_NOTE_FRESHNESS_WINDOW_MS, lastProjectEditMtimeMs: NOW - HANDOFF_NOTE_FRESHNESS_WINDOW_MS - 1000})) === true);
check("stale: invalid window falls back to the default (old note still stale)",
  isHandoffNoteFresh(freshArgs({noteMtimeMs: NOW - HANDOFF_NOTE_FRESHNESS_WINDOW_MS - 1000, freshnessWindowMs: -5}))?.fresh === false);
check("bounded: oversized window clamps to the max (note within max but past default stays stale under default only)",
  isHandoffNoteFresh(freshArgs({
    noteMtimeMs: NOW - HANDOFF_NOTE_FRESHNESS_WINDOW_MS - 1000,
    lastProjectEditMtimeMs: NOW - HANDOFF_NOTE_FRESHNESS_WINDOW_MS - 2000,
    freshnessWindowMs: Number.MAX_SAFE_INTEGER,
  }))?.fresh === true
  && isHandoffNoteFresh(freshArgs({noteMtimeMs: NOW - HANDOFF_NOTE_FRESHNESS_WINDOW_MAX_MS - 1000, lastProjectEditMtimeMs: NOW - HANDOFF_NOTE_FRESHNESS_WINDOW_MAX_MS - 2000}))?.reason === "stale_note");

if (failures) {
  console.error(`${failures} handoff-note-freshness check(s) failed.`);
  process.exit(1);
}
console.log("handoff-note-freshness tests passed");
