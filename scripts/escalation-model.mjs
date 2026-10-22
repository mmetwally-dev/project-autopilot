// Stronger "escalation model" for ONE fix round (backlog Pending #22).
//
// Roles that FIX things (planner, implementer) may carry an optional
// roles.<role>.escalation_model {adapter, model, reasoning?, variant?}. When a
// reviewer reports a previous finding as not_fixed (the structured "previous"
// record of the AUTOPILOT_REVIEW sentinel: plan_reviewer, code_reviewer,
// verifier), i.e. the SAME finding was raised again in consecutive review
// rounds of one scope, the NEXT fix round of that role runs on the escalation
// model and the role then returns to its normal (or active fallback) model.
// How many consecutive not_fixed reports are required is
// retries.escalate_after_not_fixed (default 2: the free model gets a second
// fix attempt; 1 is the original behaviour). At most
// one escalation per scope (planner: planning stage; implementer: phase), recorded
// in s.escalationSwitches[scopeKey] so a restart never repeats it. New
// findings alone never trigger it. Absent escalation_model = feature off.
//
// State: s.escalationSwitches[scopeKey] = {role, source, finding, at};
//        s.escalationPending[role]      = {scopeKey, to, from}  (consumed when the
//        next reviewer/verifier of that role family starts);
//        s.verifierHistory[key]         = [{round, findings, previous}].
import { normalizeFindings } from "./review-feedback.mjs";
import { normalizePreviousStatuses } from "./code-review-rounds.mjs";

export const ESCALATION_ROLES = Object.freeze(["planner", "implementer"]);
// Reviewer role -> the fixing role it judges.
export const ESCALATION_REVIEWER_OF = Object.freeze({ plan_reviewer: "planner", code_reviewer: "implementer", verifier: "implementer" });

const VERIFIER_KEY = "verifierHistory";

export const VERIFIER_VERIFY_LINE =
  'If earlier verifier findings are listed below, check each one against the CURRENT code first and report the outcome in the final sentinel as "previous":[{"finding":"<the previous finding text, shortened>","status":"fixed"|"not_fixed"}] (one entry per previous finding; keep a not_fixed one in "findings" too).';

function isRecord(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }

export function normalizeEscalationModel(raw) {
  if (!isRecord(raw) || typeof raw.adapter !== "string" || !raw.adapter || typeof raw.model !== "string" || !raw.model) return null;
  const out = { adapter: raw.adapter, model: raw.model };
  if (typeof raw.reasoning === "string" && raw.reasoning) out.reasoning = raw.reasoning;
  if (typeof raw.variant === "string" && raw.variant) out.variant = raw.variant;
  return out;
}

// ---- verifier round history (same shape as codeReviewHistory) ----
function vslot(state, key) {
  const list = state?.[VERIFIER_KEY]?.[key];
  return Array.isArray(list) ? list : [];
}
export function recordVerifierRound(state, key, findings, previous = []) {
  if (!state || typeof state !== "object" || !key) return 0;
  const normalized = normalizeFindings(findings);
  if (!normalized.length) return vslot(state, key).length;
  if (!isRecord(state[VERIFIER_KEY])) state[VERIFIER_KEY] = {};
  const list = vslot(state, key).slice();
  list.push({ round: list.length + 1, findings: normalized, previous: normalizePreviousStatuses(previous) });
  state[VERIFIER_KEY][key] = list;
  return list.length;
}
export function clearVerifierHistory(state, key) {
  if (!isRecord(state?.[VERIFIER_KEY])) return;
  if (key) delete state[VERIFIER_KEY][key]; else delete state[VERIFIER_KEY];
  if (state[VERIFIER_KEY] && !Object.keys(state[VERIFIER_KEY]).length) delete state[VERIFIER_KEY];
}
// Verifier brief lines: empty on the first verification of a scope.
export function verifierRoundLines(state, key) {
  const rounds = vslot(state, key);
  if (!rounds.length) return [];
  const body = rounds.map(r => `Round ${r.round}:\n${r.findings.map((f, i) => `${i + 1}. ${f}`).join("\n")}`).join("\n\n").slice(-8000);
  return [VERIFIER_VERIFY_LINE, `Earlier verifier findings (verify each):\n${body}`];
}

// ---- escalation trigger / pending / consume ----
// A round's "previous" record that holds a not_fixed entry = the same finding
// was raised in two consecutive rounds. Returns the stuck finding text or null.
export function stuckFinding(previous) {
  const list = normalizePreviousStatuses(previous);
  const hit = list.find(p => p.status === "not_fixed");
  return hit ? hit.finding : null;
}

function findingKey(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").replace(/[.。]+$/g, "").trim();
}

function sameFinding(a, b) {
  const x = findingKey(a);
  const y = findingKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function previousStatusFor(previous, finding) {
  const list = normalizePreviousStatuses(previous);
  const hit = list.find(p => sameFinding(p.finding, finding));
  return hit ? hit.status : null;
}

// How many consecutive review rounds reported `finding` as not fixed.
// `history` is the scope's round list, oldest first; its last entry is the
// round whose `previous` was just recorded. A missing status in an older
// round breaks the streak (the finding was new or already fixed then).
export function consecutiveNotFixedReports(previous, history, finding) {
  const first = normalizePreviousStatuses(previous).find(p => sameFinding(p.finding, finding));
  if (!first || first.status !== "not_fixed") return 0;
  let count = 1;
  const rounds = Array.isArray(history) ? history : [];
  for (let i = rounds.length - 2; i >= 0; i--) {
    if (previousStatusFor(rounds[i]?.previous, finding) !== "not_fixed") break;
    count++;
  }
  return count;
}

// Call after a FAIL round was recorded. Mutates state (escalationSwitches +
// escalationPending) and returns {role, scopeKey, source, finding, to} or null.
// `effectiveFrom` is only carried into the result for logging.
// `minConsecutiveNotFixed` is `retries.escalate_after_not_fixed`: 1 keeps the
// original behaviour (first not_fixed report escalates); 2 (the default) waits
// for the same finding to be reported not fixed in two consecutive reviews.
export function scheduleEscalation(state, config, { role, scopeKey, source, previous, history = [], round = 2, effectiveFrom = null, minConsecutiveNotFixed = 1 } = {}) {
  // Round 1 has no earlier round to be stuck on.
  if (!(Number(round) >= 2)) return null;
  if (!isRecord(state) || !ESCALATION_ROLES.includes(role) || !scopeKey) return null;
  const to = normalizeEscalationModel(config?.roles?.[role]?.escalation_model);
  if (!to) return null;
  const finding = stuckFinding(previous);
  if (!finding) return null;
  const threshold = Math.max(1, Number.isInteger(minConsecutiveNotFixed) ? minConsecutiveNotFixed : 1);
  if (consecutiveNotFixedReports(previous, history, finding) < threshold) return null;
  if (isRecord(state.escalationSwitches) && state.escalationSwitches[scopeKey]) return null;
  state.escalationSwitches = { ...(isRecord(state.escalationSwitches) ? state.escalationSwitches : {}), [scopeKey]: { role, source: source || null, finding, at: new Date().toISOString() } };
  state.escalationPending = { ...(isRecord(state.escalationPending) ? state.escalationPending : {}), [role]: { scopeKey, to, from: effectiveFrom } };
  return { role, scopeKey, source: source || null, finding, to, from: effectiveFrom };
}

// The escalation model the role's next run must use, or null.
export function pendingEscalationModel(state, config, role) {
  const p = state?.escalationPending?.[role];
  if (!isRecord(p)) return null;
  // Removed from config mid-mission -> no escalation.
  return normalizeEscalationModel(config?.roles?.[role]?.escalation_model);
}

// A reviewer/verifier starting means the fix round is over: drop the pending
// escalation of the role it judges. Returns the fixing role cleared, or null.
export function consumeEscalationFor(state, reviewerRole) {
  const fixer = ESCALATION_REVIEWER_OF[reviewerRole];
  if (!fixer || !isRecord(state?.escalationPending) || !state.escalationPending[fixer]) return null;
  const rest = { ...state.escalationPending };
  delete rest[fixer];
  if (Object.keys(rest).length) state.escalationPending = rest; else delete state.escalationPending;
  return fixer;
}

export function formatEscalationLog({ role, from, to, finding, source } = {}) {
  const d = e => (isRecord(e) && e.model ? (String(e.model).startsWith(`${e.adapter}/`) ? e.model : `${e.adapter}/${e.model}`) : "configured model");
  const f = String(finding || "").replace(/\s+/g, " ").slice(0, 160);
  return `escalation: ${role} ${d(from)} → ${d(to)} for one fix round (${source || "reviewer"} reported the same finding not fixed: ${f})`;
}
