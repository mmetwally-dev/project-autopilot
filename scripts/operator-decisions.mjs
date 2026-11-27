#!/usr/bin/env node
// Backlog #11: mission-level operator decisions (`ap note "<decision>"`).
//
// A decision the operator made (for example "use the simpler protocol") must
// reach the PLANNING stage too: planner, plan/spec/tasks reviewers,
// implementer, code reviewers and verifier all read the same binding block.
// `operatorPhaseNote` (ap rebase --note) is phase-scoped and implementer/
// reviewer only, so it cannot carry this.
//
// Storage: state.operatorDecisions = [{text, at}], mission-scoped (listed in
// MISSION_SCOPED_STATE_KEYS, so a new mission or `ap cancel` drops it).
//
// Live runs: the live run holds state in memory and its next saveState would
// overwrite anything the CLI wrote to state.json. So while a run is live the
// CLI only appends to a small queue file (atomic writes, same idea as the
// reset-request queue); the run drains it into state when it builds a brief.
import fs from "node:fs";
import path from "node:path";
import {atomicWriteFileSync} from "./atomic-state-write.mjs";

export const OPERATOR_DECISIONS_STATE_KEY = "operatorDecisions";
export const OPERATOR_DECISIONS_HEADER = "Operator decisions (binding — reviewers judge the work against them, never against alternatives they rule out):";

export function operatorDecisionQueuePath(repo) {
  return path.join(repo, ".autopilot", "operator-decisions-queue.json");
}

export function operatorDecisionList(s) {
  const list = Array.isArray(s?.[OPERATOR_DECISIONS_STATE_KEY]) ? s[OPERATOR_DECISIONS_STATE_KEY] : [];
  return list.filter((d) => d && typeof d.text === "string" && d.text.trim());
}

function dateOf(at) {
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(at || ""));
  return m ? m[0] : "";
}

// The shared block. Empty string when there are no decisions.
export function operatorDecisionsBlock(s) {
  const list = operatorDecisionList(s);
  if (!list.length) return "";
  const lines = list.map((d) => {
    const day = dateOf(d.at);
    return `- ${d.text.trim().replace(/\s*\n\s*/g, " ")}${day ? ` (${day})` : ""}`;
  });
  return `${OPERATOR_DECISIONS_HEADER}\n${lines.join("\n")}`;
}

// Append the block to a brief; unchanged when there is nothing to add or the
// brief already carries it (a retry/continuation of the same brief).
export function withOperatorDecisions(task, s) {
  const block = operatorDecisionsBlock(s);
  if (!block || typeof task !== "string" || task.includes(OPERATOR_DECISIONS_HEADER)) return task;
  return `${task}\n\n${block}`;
}

// Mutations on state (pure apart from the object passed in).
export function addOperatorDecision(s, text, at) {
  const list = operatorDecisionList(s).slice();
  list.push({ text: String(text).trim(), at });
  s[OPERATOR_DECISIONS_STATE_KEY] = list;
  return list;
}
export function clearOperatorDecisions(s) {
  const had = operatorDecisionList(s).length > 0 || OPERATOR_DECISIONS_STATE_KEY in (s || {});
  if (s) delete s[OPERATOR_DECISIONS_STATE_KEY];
  return had;
}

// Queue file: {"ops":[{op:"add",text,at}|{op:"clear",at}]}
export function readOperatorDecisionOps(repo) {
  try {
    const parsed = JSON.parse(fs.readFileSync(operatorDecisionQueuePath(repo), "utf8"));
    return Array.isArray(parsed?.ops) ? parsed.ops.filter((o) => o && (o.op === "add" || o.op === "clear")) : [];
  } catch {
    return [];
  }
}
export function enqueueOperatorDecisionOp(repo, op) {
  const file = operatorDecisionQueuePath(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ops = [...readOperatorDecisionOps(repo), op];
  atomicWriteFileSync(file, JSON.stringify({ ops }, null, 2));
  return ops;
}
export function removeOperatorDecisionQueue(repo) {
  try { fs.rmSync(operatorDecisionQueuePath(repo), { force: true }); } catch { /* best-effort */ }
}

// Drain the queue into `s`. Returns true when `s` changed (caller saves).
// The file is removed only after the ops were applied in memory; the caller
// persists straight away.
export function applyOperatorDecisionQueue(s, repo) {
  const ops = readOperatorDecisionOps(repo);
  if (!ops.length) { return false; }
  for (const o of ops) {
    if (o.op === "clear") clearOperatorDecisions(s);
    else if (typeof o.text === "string" && o.text.trim()) addOperatorDecision(s, o.text, o.at);
  }
  removeOperatorDecisionQueue(repo);
  return true;
}
