// Backlog #91: a verifier PASS on a red phase gate is recorded as FAIL.
// Pure helpers (no process/exit hooks). The model's findings are untouched; the
// gate's failing files / checks go in review.gateFindings (task-mapped).
import fs from "node:fs";
import path from "node:path";
import {parseGateFailures, taskLinkedTestFiles} from "./gate-failure-locality.mjs";

export const RED_GATE_OVERRIDE = "red_gate";

export function isRedGate(gate) {
  if (!gate || typeof gate !== "object") return false;
  if (Array.isArray(gate.results) && gate.results.length) return gate.results.some((r) => r && r.ok === false);
  return gate.ok === false && typeof gate.command === "string";
}

function gateLogText(gate) {
  let text = "";
  const read = (f) => { try { if (typeof f === "string" && f) text += `\n${fs.readFileSync(f, "utf8")}`; } catch {} };
  read(gate.logFile);
  if (!text.trim()) {
    for (const r of Array.isArray(gate.results) ? gate.results : []) {
      if (!r) continue;
      read(r.logFile);
      if (typeof r.tail === "string" && r.tail) text += `\n${r.tail}`;
    }
  }
  if (!text.trim() && typeof gate.tail === "string") text = gate.tail;
  return text;
}

export function redGateFindings(gate, phaseTasks = []) {
  const out = [];
  let failures = [];
  try { failures = parseGateFailures(gateLogText(gate)).failures; } catch {}
  for (const f of failures) {
    let ref = "";
    try {
      const task = (Array.isArray(phaseTasks) ? phaseTasks : []).find((t) => taskLinkedTestFiles([t]).includes(f.file));
      const m = task && /^(T[\d.]+)/.exec(String(task.id || task.text || ""));
      if (m) ref = `${m[1]}: `;
    } catch {}
    out.push(`${ref}Phase gate FAIL: ${f.file}${f.firstCheck ? ` - ${f.firstCheck}` : ""}`);
  }
  if (!out.length) {
    const failed = (Array.isArray(gate.results) ? gate.results : []).find((r) => r && r.ok === false);
    const cmd = failed?.command || gate.command || "unknown";
    out.push(`Phase gate FAIL: ${String(cmd).slice(0, 200)}`);
  }
  return out;
}

// Returns {review, overridden}. Gate green/absent or no decision -> unchanged.
// PASS on a red gate -> FAIL + marker + merged gate findings. An already-FAIL
// review keeps its decision but gets the gate findings merged (overridden
// stays false: the verdict was not changed).
export function applyRedGateOverride(review, gate, phaseTasks = []) {
  if (!review || !isRedGate(gate) || !review.decision) return {review, overridden: false};
  // Gate findings go in a separate field: review.findings drives task
  // targeting / carry-forward and the retry brief, which must stay unchanged.
  if (review.decision !== "PASS") return {review, overridden: false};
  return {review: {...review, decision: "FAIL", gateFindings: redGateFindings(gate, phaseTasks), verdictOverride: RED_GATE_OVERRIDE}, overridden: true};
}

// Rewrites the verifier run's result.json/status.json so the record matches
// the overridden verdict. Best effort: never throws.
export function persistRedGateOverride(runsDir, runId, review) {
  try {
    const short = String(runId || "").slice(0, 8);
    if (!short || !fs.existsSync(runsDir)) return false;
    const name = fs.readdirSync(runsDir).find((n) => n.endsWith(`-verifier-${short}`));
    if (!name) return false;
    const dir = path.join(runsDir, name);
    const patch = (file, fn) => {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) return;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      fn(j);
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    };
    patch("result.json", (j) => {
      j.review = {decision: review.decision, findings: review.findings, gateFindings: review.gateFindings};
      if (j.verdict && typeof j.verdict === "object") { j.verdict.decision = review.decision; j.verdict.gateFindings = review.gateFindings; }
      j.verdictOverride = RED_GATE_OVERRIDE;
    });
    patch("status.json", (j) => { j.decision = review.decision; j.verdictOverride = RED_GATE_OVERRIDE; });
    return true;
  } catch { return false; }
}
