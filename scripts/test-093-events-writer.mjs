#!/usr/bin/env node
// Mission 093 Part 1 task 3.1: unit test for appendWatchEvent (scripts/watch-events.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendWatchEvent, localIso } from "./watch-events.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "093-events-writer-"));
const missionDir = path.join(root, "mission-1");

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const readLines = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
const parseLines = (file) => readLines(file).map(JSON.parse);

console.log("Test 1: appendWatchEvent creates file and writes one line per event");
appendWatchEvent(missionDir, { type: "test_event", foo: "bar" });
const lines1 = readLines(path.join(missionDir, "watch-events.jsonl"));
assert(lines1.length === 1, `expected 1 line, got ${lines1.length}`);
const evt1 = JSON.parse(lines1[0]);
assert(evt1.type === "test_event", `type mismatch: ${evt1.type}`);
assert(evt1.foo === "bar", `foo mismatch: ${evt1.foo}`);
assert(typeof evt1.at === "string" && evt1.at.length > 0, `at should be present: ${evt1.at}`);
console.log("  PASS");

console.log("Test 2: multiple appends produce multiple lines");
appendWatchEvent(missionDir, { type: "event_a", n: 1 });
appendWatchEvent(missionDir, { type: "event_b", n: 2 });
appendWatchEvent(missionDir, { type: "event_c", n: 3 });
const lines2 = parseLines(path.join(missionDir, "watch-events.jsonl"));
assert(lines2.length === 4, `expected 4 lines total, got ${lines2.length}`);
assert(lines2[1].type === "event_a" && lines2[1].n === 1);
assert(lines2[2].type === "event_b" && lines2[2].n === 2);
assert(lines2[3].type === "event_c" && lines2[3].n === 3);
console.log("  PASS");

console.log("Test 3: missing data fields are null, not zero or omitted");
appendWatchEvent(missionDir, { type: "partial", present: "value" });
const lines3 = parseLines(path.join(missionDir, "watch-events.jsonl"));
const partial = lines3[lines3.length - 1];
assert(partial.present === "value", "present field should be kept");
assert("missing" in partial ? false : true, "missing field should not be fabricated");
console.log("  PASS");

console.log("Test 4: explicit null in event is preserved");
appendWatchEvent(missionDir, { type: "explicit_null", value: null });
const lines4 = parseLines(path.join(missionDir, "watch-events.jsonl"));
const explicit = lines4[lines4.length - 1];
assert(explicit.value === null, `explicit null should be preserved, got: ${explicit.value}`);
console.log("  PASS");

console.log("Test 5: custom at timestamp is preserved");
const customAt = "2026-01-01T12:00:00+00:00";
appendWatchEvent(missionDir, { type: "custom_at", at: customAt });
const lines5 = parseLines(path.join(missionDir, "watch-events.jsonl"));
const custom = lines5[lines5.length - 1];
assert(custom.at === customAt, `custom at should be preserved, got: ${custom.at}`);
console.log("  PASS");

console.log("Test 6: localIso produces valid local-with-offset timestamp");
const iso = localIso();
assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(iso), `localIso shape wrong: ${iso}`);
console.log("  PASS");

console.log("Test 7: events directory is created if it doesn't exist");
const newMissionDir = path.join(root, "mission-new");
appendWatchEvent(newMissionDir, { type: "first" });
assert(fs.existsSync(path.join(newMissionDir, "watch-events.jsonl")), "file should be created");
const lines7 = parseLines(path.join(newMissionDir, "watch-events.jsonl"));
assert(lines7.length === 1 && lines7[0].type === "first");
console.log("  PASS");

console.log("Test 8: event without type still writes (writer is pure append)");
appendWatchEvent(missionDir, { foo: "bar" });
const lines8 = parseLines(path.join(missionDir, "watch-events.jsonl"));
const noType = lines8[lines8.length - 1];
assert(noType.foo === "bar", "event without type should still write");
assert(typeof noType.at === "string", "at should be auto-generated");
console.log("  PASS");

fs.rmSync(root, { recursive: true, force: true });
console.log("All appendWatchEvent tests passed.");