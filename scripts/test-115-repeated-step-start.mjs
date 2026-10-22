// Backlog #115: repeated same-messageID opencode step_start is not progress.
import assert from "node:assert/strict";
import {createIdleWatch, evaluateIdleWatch, noteIdleStdoutChunk} from "./idle-hang-watchdog.mjs";

const MIN = 60_000;
const ss = id => JSON.stringify({type: "step_start", sessionID: "ses_1", part: {type: "step-start", messageID: id}}) + "\n";
const mk = (adapter = "opencode") => createIdleWatch({idleHangMs: 10 * MIN, firstOutputMs: 2 * MIN, adapter, pid: null, now: 0, platform: "linux"});

// repeats do not reset the clock -> hung (some output, not noOutput)
{
  const w = mk();
  assert.equal(noteIdleStdoutChunk(w, ss("msg_A"), 0), true);
  assert.equal(noteIdleStdoutChunk(w, ss("msg_A"), 5 * MIN), false);
  assert.equal(noteIdleStdoutChunk(w, ss("msg_A"), 10 * MIN - 1000), false);
  assert.equal(w.lastActivityAt, 0);
  assert.equal(evaluateIdleWatch(w, {now: 9 * MIN}).status, "ok");
  w.pid = 999999999; // no live descendants
  const r = evaluateIdleWatch(w, {now: 10 * MIN + 1});
  assert.equal(r.status, "hung");
  assert.equal(r.noOutput, false);
}
// new messageID resets
{
  const w = mk();
  noteIdleStdoutChunk(w, ss("msg_A"), 0);
  assert.equal(noteIdleStdoutChunk(w, ss("msg_B"), 5 * MIN), true);
  assert.equal(w.lastActivityAt, 5 * MIN);
}
// tool_use / text / step_finish between resets, and same id afterwards counts as new
{
  const w = mk();
  noteIdleStdoutChunk(w, ss("msg_A"), 0);
  assert.equal(noteIdleStdoutChunk(w, JSON.stringify({type: "tool_use", part: {}}) + "\n", 3 * MIN), true);
  assert.equal(w.lastActivityAt, 3 * MIN);
  assert.equal(noteIdleStdoutChunk(w, ss("msg_A"), 4 * MIN), true);
  assert.equal(noteIdleStdoutChunk(w, "not json partial", 6 * MIN), true);
}
// other adapters unchanged
{
  const w = mk("claude");
  noteIdleStdoutChunk(w, ss("msg_A"), 0);
  assert.equal(noteIdleStdoutChunk(w, ss("msg_A"), 5 * MIN), true);
  assert.equal(w.lastActivityAt, 5 * MIN);
}
console.log("test-115-repeated-step-start: ALL CHECKS PASSED");
