// Code-review round discipline (backlog #118), the code_reviewer twin of
// plan-review-rounds.mjs (#100). No round limit: round 1 is exhaustive; later
// rounds verify each previous finding (structured fixed / not_fixed record in
// the AUTOPILOT_REVIEW "previous" field) and raise new findings only if the fix
// introduced them or they break execution; the implementer fix brief carries
// the findings of EVERY earlier round. History is per review scope
// (s.codeReviewHistory[key]: "phase:<n>" or "final:<site>"), cleared on PASS
// and at a new mission. The fixed/not_fixed record is stored, not acted on
// (it feeds Pending #22).
import { normalizeFindings, normalizeFindingKey } from "./review-feedback.mjs";

const STATE_KEY = "codeReviewHistory";
const MAX_CUMULATIVE_CHARS = 16000;

export const CODE_REVIEW_EXHAUSTIVE_LINE =
  "This is review round 1 — make it EXHAUSTIVE: report every problem you can find in this first review, across all categories you check (correctness, regressions, missing or weak tests, wiring, edge cases), not one batch at a time. Later rounds will only verify the fixes and the changes made, so anything you leave out now will not be looked for again.";

export const CODE_REVIEW_VERIFY_LINE =
  'This is a later review round. First verify each previous finding listed below against the CURRENT code, one by one, and report the outcome INSIDE the final AUTOPILOT_REVIEW JSON sentinel (not in a separate JSON block) as "previous":[{"finding":"<the previous finding text, shortened>","status":"fixed"|"not_fixed"|"needs_run"}] (one entry per previous finding; keep a not_fixed one in "findings" too; use "needs_run" ONLY for findings that need the gate/verifier to run, such as a test timeout, flaky test, browser/Playwright check, or full test gate — never to skip reading the code). Raise NEW findings only if the fix introduced them, or if they would actually break execution; do not raise new style, preference or nice-to-have findings about code that was already reviewed.';

// Tolerant parse of the optional "previous" field. Anything unusable is dropped.
export function normalizePreviousStatuses(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const text = String(entry.finding ?? entry.problem ?? entry.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    const st = String(entry.status ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    const status = st === "fixed"
      ? "fixed"
      : (st === "not_fixed" || st === "notfixed" || st === "unfixed")
        ? "not_fixed"
        : (st === "needs_run" || st === "needsrun")
          ? "needs_run"
          : null;
    if (text && status) out.push({ finding: text, status });
    if (out.length >= 40) break;
  }
  return out;
}

// Backlog s15 #4: when the AUTOPILOT_REVIEW sentinel has no "previous" array,
// accept a "previous" array from the last fenced or standalone JSON object in
// the same final message (before the sentinel line).
export function extractPreviousFromFallbackJson(text) {
  const src = String(text ?? "");
  if (!src || !src.includes("previous")) return [];
  const candidates = [];

  // Scan balanced JSON objects in order of appearance (covers both fenced
  // ```json { ... } ``` blocks and standalone { ... } objects).
  let i = 0;
  while (i < src.length) {
    if (src[i] !== "{") { i += 1; continue; }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < src.length; j += 1) {
      const ch = src[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) break;
    const slice = src.slice(i, end + 1);
    if (slice.includes('"previous"')) {
      try {
        const parsed = JSON.parse(slice);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.previous)) {
          const normalized = normalizePreviousStatuses(parsed.previous);
          if (normalized.length > 0) candidates.push(normalized);
        }
      } catch {
        // Not valid JSON; keep scanning inside in case a nested object is valid.
      }
    }
    i = end + 1;
  }

  return candidates.length > 0 ? candidates[candidates.length - 1] : [];
}

export function codeReviewScopeKey(kind, id) { return `${kind}:${id}`; }

function slot(state, key) {
  const list = state?.[STATE_KEY]?.[key];
  return Array.isArray(list) ? list : [];
}

export function codeReviewRoundCount(state, key) { return slot(state, key).length; }

export function codeReviewRounds(state, key) { return slot(state, key).slice(); }

// Append one failed round: its findings plus the reviewer's fixed/not_fixed
// statuses for the PREVIOUS round's findings. Empty findings -> no-op.
export function recordCodeReviewRound(state, key, findings, previous = []) {
  if (!state || typeof state !== "object" || !key) return 0;
  const normalized = normalizeFindings(findings);
  if (!normalized.length) return codeReviewRoundCount(state, key);
  if (!state[STATE_KEY] || typeof state[STATE_KEY] !== "object") state[STATE_KEY] = {};
  const list = slot(state, key).slice();
  list.push({ round: list.length + 1, findings: normalized, previous: normalizePreviousStatuses(previous) });
  state[STATE_KEY][key] = list;
  return list.length;
}

export function clearCodeReviewHistory(state, key) {
  if (!state?.[STATE_KEY] || typeof state[STATE_KEY] !== "object") return;
  if (key) delete state[STATE_KEY][key]; else delete state[STATE_KEY];
  if (state[STATE_KEY] && !Object.keys(state[STATE_KEY]).length) delete state[STATE_KEY];
}

function render(rounds, extraLen = 0) {
  const blocks = rounds.map(r => `Round ${r.round}:\n${(Array.isArray(r.findings) ? r.findings : []).map((f, i) => `${i + 1}. ${f}`).join("\n")}`);
  while (blocks.length > 1 && (blocks.join("\n\n").length + extraLen) > MAX_CUMULATIVE_CHARS) blocks.shift();
  return blocks.join("\n\n");
}

export function scopeReviewRounds(allRounds) {
  if (!Array.isArray(allRounds) || !allRounds.length) {
    return { rounds: [], fixedCount: 0, fixedLine: "" };
  }
  if (allRounds.length === 1) {
    return { rounds: allRounds.slice(), fixedCount: 0, fixedLine: "" };
  }

  // Find V: index of the LAST round (latest round included) whose `previous` array is non-empty.
  let v = -1;
  for (let i = allRounds.length - 1; i >= 0; i--) {
    if (Array.isArray(allRounds[i]?.previous) && allRounds[i].previous.length > 0) {
      v = i;
      break;
    }
  }

  let candidates;
  let fixedCount = 0;
  let fixedLine = "";

  if (v > 0) {
    candidates = allRounds.slice(v);
    const distinctBeforeV = new Set();
    for (let i = 0; i < v; i++) {
      for (const f of (Array.isArray(allRounds[i]?.findings) ? allRounds[i].findings : [])) {
        const k = normalizeFindingKey(f);
        if (k) distinctBeforeV.add(k);
      }
    }
    fixedCount = distinctBeforeV.size;
    const vRoundNum = allRounds[v]?.round ?? (v + 1);
    const prevRoundNum = vRoundNum - 1;
    fixedLine = `${fixedCount} earlier findings (rounds 1-${prevRoundNum}) were already verified in round ${vRoundNum}; do not re-check them unless this revision touched their lines.`;
  } else {
    candidates = allRounds.slice();
  }

  const latestRound = candidates[candidates.length - 1];
  const earlierCandidates = candidates.slice(0, -1);

  // Latest round's findings always in full; identical texts listed once
  const seenKeys = new Set();
  const latestFindings = [];
  for (const f of (Array.isArray(latestRound?.findings) ? latestRound.findings : [])) {
    const k = normalizeFindingKey(f);
    if (k && seenKeys.has(k)) continue;
    if (k) seenKeys.add(k);
    latestFindings.push(f);
  }

  const keptEarlier = [];
  for (let i = earlierCandidates.length - 1; i >= 0; i--) {
    const r = earlierCandidates[i];
    const rawFindings = Array.isArray(r?.findings) ? r.findings : [];
    const keptFindings = [];
    for (const f of rawFindings) {
      const k = normalizeFindingKey(f);
      if (k && seenKeys.has(k)) continue;
      if (k) seenKeys.add(k);
      keptFindings.push(f);
    }
    if (keptFindings.length > 0) {
      keptEarlier.unshift({ ...r, findings: keptFindings });
    }
  }

  const scopedRounds = [...keptEarlier, { ...latestRound, findings: latestFindings }];
  return { rounds: scopedRounds, fixedCount, fixedLine };
}

// Reviewer brief lines for the NEXT review (recorded rounds = previous rounds).
// When `hasFeedback` is true (e.g. a re-review after a verifier FAIL, where
// verifierHistory holds the failure rather than codeReviewHistory), the brief
// still lists earlier findings under FEEDBACK TO ADDRESS and must include
// CODE_REVIEW_VERIFY_LINE so the reviewer reports "previous" per-finding statuses.
export function codeReviewerRoundLines(state, key, { hasFeedback = false } = {}) {
  const rounds = slot(state, key);
  if (!rounds.length) return hasFeedback ? [CODE_REVIEW_VERIFY_LINE] : [CODE_REVIEW_EXHAUSTIVE_LINE];
  if (rounds.length === 1) {
    return [CODE_REVIEW_VERIFY_LINE, `Previous findings from all earlier review rounds (verify each):\n${render(rounds)}`];
  }
  const { rounds: scoped, fixedLine = "" } = scopeReviewRounds(rounds);
  const fixedLen = fixedLine ? fixedLine.length + 2 : 0;
  const rendered = render(scoped, fixedLen);
  const body = [fixedLine, rendered].filter(Boolean).join("\n\n");
  return [CODE_REVIEW_VERIFY_LINE, `Previous findings from all earlier review rounds (verify each):\n${body}`];
}

function normMatchText(text) {
  return String(text || "")
    .replace(/^\s*\d+\.\s+/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/g, "")
    .trim();
}

function matchTokens(text) {
  return normMatchText(text)
    .split(/[^a-z0-9_./:-]+/)
    .filter(t => t.length >= 3 || t.includes("/") || t.includes(".") || t.includes("_"));
}

function sameOrOverlappingFinding(listedText, prevText, allowTokenOverlap = false) {
  const a = normMatchText(listedText);
  const b = normMatchText(prevText);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  if (!allowTokenOverlap) return false;
  const ta = new Set(matchTokens(listedText));
  const tb = matchTokens(prevText);
  if (!ta.size || !tb.length) return false;
  let shared = 0;
  for (const t of tb) if (ta.has(t)) shared++;
  const needed = tb.length === 1 ? 1 : Math.max(2, Math.ceil(tb.length * 0.5));
  return shared >= needed;
}

// Evaluate a code re-review's "previous" array against the earlier findings
// listed in its brief. Each listed finding must be matched by a distinct
// "previous" entry with status "fixed" or "needs_run".
export function evaluateRereviewPreviousStatuses(listedFindings, rawPrevious) {
  const listed = Array.isArray(listedFindings)
    ? listedFindings.map(f => String(f ?? "").trim()).filter(Boolean)
    : [];
  const previous = normalizePreviousStatuses(rawPrevious);
  if (!listed.length) {
    return { ok: true, missing: [], notFixed: [], fixed: [], needsRun: [], previous };
  }
  const matchedPrevIdx = new Set();
  const matchedListed = new Array(listed.length).fill(null);

  // Pass 1: exact or substring match
  for (let i = 0; i < listed.length; i++) {
    for (let j = 0; j < previous.length; j++) {
      if (matchedPrevIdx.has(j)) continue;
      if (sameOrOverlappingFinding(listed[i], previous[j].finding, false)) {
        matchedPrevIdx.add(j);
        matchedListed[i] = previous[j];
        break;
      }
    }
  }
  // Pass 2: token-overlap match for shortened/paraphrased summaries
  for (let i = 0; i < listed.length; i++) {
    if (matchedListed[i]) continue;
    for (let j = 0; j < previous.length; j++) {
      if (matchedPrevIdx.has(j)) continue;
      if (sameOrOverlappingFinding(listed[i], previous[j].finding, true)) {
        matchedPrevIdx.add(j);
        matchedListed[i] = previous[j];
        break;
      }
    }
  }
  // Pass 3: positional/count fallback when shortened text didn't match by text
  // (skip entries that are text-duplicates of an already-matched listed finding)
  const isDuplicateOfMatched = (prevEntry) =>
    listed.some((l, idx) => matchedListed[idx] && sameOrOverlappingFinding(l, prevEntry.finding, false));
  for (let i = 0; i < listed.length; i++) {
    if (matchedListed[i]) continue;
    if (i < previous.length && !matchedPrevIdx.has(i) && !isDuplicateOfMatched(previous[i])) {
      matchedPrevIdx.add(i);
      matchedListed[i] = previous[i];
    }
  }
  for (let i = 0; i < listed.length; i++) {
    if (matchedListed[i]) continue;
    for (let j = 0; j < previous.length; j++) {
      if (matchedPrevIdx.has(j) || isDuplicateOfMatched(previous[j])) continue;
      matchedPrevIdx.add(j);
      matchedListed[i] = previous[j];
      break;
    }
  }

  const fixed = [];
  const needsRun = [];
  const notFixed = [];
  const missing = [];
  for (let i = 0; i < listed.length; i++) {
    const m = matchedListed[i];
    if (!m) missing.push(listed[i]);
    else if (m.status === "not_fixed") notFixed.push(listed[i]);
    else if (m.status === "needs_run") needsRun.push(listed[i]);
    else fixed.push(listed[i]);
  }
  for (let j = 0; j < previous.length; j++) {
    if (!matchedPrevIdx.has(j) && previous[j].status === "not_fixed") {
      notFixed.push(previous[j].finding);
    }
  }
  return {
    ok: missing.length === 0 && notFixed.length === 0,
    missing,
    notFixed,
    fixed,
    needsRun,
    previous,
  };
}

export function buildRereviewPreviousRetryPrompt(missingFindings, allListedFindings = missingFindings) {
  const list = (Array.isArray(missingFindings) && missingFindings.length ? missingFindings : allListedFindings)
    .map((f, i) => `${i + 1}. ${f}`)
    .join("\n");
  return [
    "VERDICT-ONLY RETRY: Your previous PASS omitted the required per-finding \"previous\" status for the earlier finding(s) below.",
    "Do NOT re-review the rest of the diff and do NOT run any tests or commands.",
    "Check ONLY each listed finding against the current code and return your AUTOPILOT_REVIEW verdict with \"previous\":[{\"finding\":\"<shortened finding>\",\"status\":\"fixed\"|\"not_fixed\"|\"needs_run\"}] INSIDE the AUTOPILOT_REVIEW JSON object (not in a separate JSON block; one entry per listed finding; if any is \"not_fixed\", return decision \"FAIL\" and include it in \"findings\"; use \"needs_run\" ONLY for findings that need the gate/verifier to run, never to skip reading the code).",
    "",
    "Unconfirmed earlier findings:",
    list,
  ].join("\n");
}

export const EARLIER_ROUNDS_RECHECK_LINE =
  "Do not re-check these unless your edit touches their lines.";

export { normalizeFindingKey };

export function dedupeEarlierRounds(allRounds) {
  if (!Array.isArray(allRounds) || allRounds.length <= 1) return [];
  const latestRound = allRounds[allRounds.length - 1];
  const earlierRounds = allRounds.slice(0, -1);
  const latestFindings = Array.isArray(latestRound?.findings) ? latestRound.findings : [];
  const seen = new Set();
  for (const f of latestFindings) {
    const key = normalizeFindingKey(f);
    if (key) seen.add(key);
  }
  const kept = [];
  for (let i = earlierRounds.length - 1; i >= 0; i--) {
    const r = earlierRounds[i];
    const rawFindings = Array.isArray(r?.findings) ? r.findings : [];
    const keptFindings = [];
    for (const f of rawFindings) {
      const key = normalizeFindingKey(f);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      keptFindings.push(f);
    }
    if (keptFindings.length > 0) {
      kept.unshift({ ...r, findings: keptFindings });
    }
  }
  return kept;
}

// Implementer fix brief: findings of all rounds BEFORE the latest (the latest
// is already quoted as the feedback to address).
export function implementerEarlierRoundsText(state, key) {
  const allRounds = slot(state, key);
  const rounds = dedupeEarlierRounds(allRounds);
  if (!rounds.length) return "";
  const rendered = render(rounds);
  if (!rendered) return "";
  return `Findings from ALL earlier code-review rounds (already addressed once — keep them fixed; your fixes for the current findings must not reopen any of them):\n${rendered}\n${EARLIER_ROUNDS_RECHECK_LINE}`;
}
