const browserFile = /(?:^|[\\/])(?:app|pages|components|screens|ui)(?:[\\/]).*\.(?:tsx|jsx|vue|svelte|html)$/i;
const playwrightCommand = /(?:^|[\s"'])playwright(?:\s|$)|@playwright\/test|\btest:e2e\b/i;

export function deriveTaskFacts(task = {}) {
  const files = Array.isArray(task.files) ? task.files.map(String) : [];
  const verify = String(task.verify || "");
  return {
    browser: files.some(file => browserFile.test(file)),
    playwright: playwrightCommand.test(verify),
    commands: task.verifierRunsCommands === true,
    requiredCapabilities: Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities : []
  };
}

export function mergeTaskFacts(tasks = []) {
  const facts = tasks.map(task => task.taskFacts || deriveTaskFacts(task));
  return {
    browser: facts.some(fact => fact.browser === true),
    playwright: facts.some(fact => fact.playwright === true),
    commands: facts.some(fact => fact.commands === true),
    requiredCapabilities: [...new Set(facts.flatMap(fact => fact.requiredCapabilities || []))]
  };
}

// Standalone and SpecKit task lines carry no structured `files`/`verify`
// fields, only one text line ("... — accept: ...; verify: ..."). Read the
// file paths named in the line and its `verify:` segment, then derive the
// same facts the GSD path derives from its plan XML.
export function deriveTaskFactsFromLine(task = {}) {
  const text = String(task.text || "");
  const verifyMatch = text.match(/;\s*verify:\s*(.+)$/i);
  const files = text.split(/\s+/)
    .map(token => token.replace(/^[`'"(\[]+|[`'"),;.:\]]+$/g, ""))
    .filter(token => /[\\/]/.test(token) && /\.\w+$/.test(token));
  return deriveTaskFacts({files, verify: verifyMatch ? verifyMatch[1] : "", requiredCapabilities: task.requiredCapabilities});
}

export function mergeTaskLineFacts(tasks = []) {
  return mergeTaskFacts(tasks.map(task => ({taskFacts: deriveTaskFactsFromLine(task)})));
}

export const BROWSER_CHECK_NOTE_PREFIX = "BROWSER CHECK NOT POSSIBLE:";

export const CODE_REVIEWER_BROWSER_LINE = `Browser checks are the verifier's job. Never report a missing or impossible browser/manual UI check as a finding. If UI flows need a manual check, add one note that starts with "${BROWSER_CHECK_NOTE_PREFIX}" naming the pages and what to check.`;

export const NETWORK_TEST_NOTE_PREFIX = "NETWORK TEST MANUAL RUN:";

export const NETWORK_GATED_TEST_LINE = `When the task text itself asks for a network or env-gated test (an env flag such as RUN_INTEGRATION, a dev/remote database, a real JWT or auth provider, a running server), judge that test's code statically. Do not fail it for needing the network or for being skipped in the offline gate, and do not ask for an in-process/offline rewrite; add one note that starts with "${NETWORK_TEST_NOTE_PREFIX}" giving the command and the env it needs. A test whose task did not ask for the network is still a finding.`;

export function isBrowserCheckFinding(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith(BROWSER_CHECK_NOTE_PREFIX.toLowerCase())) {
    return true;
  }
  return /not (?:been )?(?:checked|verified|tested) in a (?:real )?browser|no approved browser(?: or playwright)? command/i.test(trimmed);
}

export function isNetworkGatedTestFinding(text) {
  if (typeof text !== "string") return false;
  return text.trim().toLowerCase().startsWith(NETWORK_TEST_NOTE_PREFIX.toLowerCase());
}

const MANUAL_FINDING_FIELDS = ["problem", "finding", "text", "summary", "message"];

function isBrowserFindingItem(item, text) {
  if (typeof item === "string") return isBrowserCheckFinding(item);
  if (item && typeof item === "object") {
    for (const field of MANUAL_FINDING_FIELDS) {
      const val = item[field];
      if (typeof val === "string" && isBrowserCheckFinding(val)) {
        return true;
      }
    }
  }
  return isBrowserCheckFinding(text);
}

function isNetworkGatedFindingItem(item) {
  if (typeof item === "string") return isNetworkGatedTestFinding(item);
  if (item && typeof item === "object") {
    for (const field of MANUAL_FINDING_FIELDS) {
      const val = item[field];
      if (typeof val === "string" && isNetworkGatedTestFinding(val)) {
        return true;
      }
    }
  }
  return false;
}

function splitFindings(review, predicate, key) {
  const findings = Array.isArray(review)
    ? review
    : Array.isArray(review?.findings)
    ? review.findings
    : [];
  const matched = [];
  const rest = [];
  for (const item of findings) {
    const text = typeof item === "string" ? item : (item == null ? "" : JSON.stringify(item));
    if (predicate(item, text)) {
      matched.push(item);
    } else {
      rest.push(item);
    }
  }
  return { [key]: matched, rest };
}

export function splitBrowserFindings(review) {
  return splitFindings(review, (item, text) => isBrowserFindingItem(item, text), "browser");
}

export function splitNetworkTestFindings(review) {
  return splitFindings(review, (item) => isNetworkGatedFindingItem(item), "network");
}

export function moveManualCheckFindings(review) {
  if (!review) return { moved: [] };
  const findings = Array.isArray(review) ? review : review.findings;
  if (!Array.isArray(findings)) return { moved: [] };
  const { browser, rest: afterBrowser } = splitBrowserFindings(findings);
  const { network, rest } = splitNetworkTestFindings(afterBrowser);
  const moved = [...browser, ...network];
  if (Array.isArray(review)) {
    review.length = 0;
    review.push(...rest);
  } else {
    review.findings = rest;
  }
  return { moved };
}

export function manualCheckNoteText(item) {
  if (typeof item === "string") return item.trim();
  if (item && typeof item === "object") {
    for (const field of MANUAL_FINDING_FIELDS) {
      const val = item[field];
      if (typeof val === "string" && val.trim()) {
        return val.trim();
      }
    }
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  }
  return String(item || "").trim();
}

export function filterUnrecordedManualChecks(s, phaseKey, notes) {
  if (!Array.isArray(notes) || notes.length === 0) return [];
  if (s) s.recordedManualCheckNotes = s.recordedManualCheckNotes || {};
  const recorded = s ? (s.recordedManualCheckNotes[phaseKey] = s.recordedManualCheckNotes[phaseKey] || []) : [];
  const recSet = new Set(recorded.map(x => (typeof x === "string" ? x.trim() : manualCheckNoteText(x))));
  const fresh = [];
  for (const item of notes) {
    const txt = typeof item === "string" ? item.trim() : manualCheckNoteText(item);
    if (txt && !recSet.has(txt)) {
      recSet.add(txt);
      recorded.push(txt);
      fresh.push(typeof item === "string" ? item : txt);
    }
  }
  return fresh;
}

export function verifierVerdictAfterManualMove({ decision, remaining, gateOk, evidenceOk }) {
  const remCount = Array.isArray(remaining) ? remaining.length : Number(remaining || 0);
  if (decision === "FAIL" && remCount === 0 && gateOk === true && evidenceOk === true) {
    return "PASS";
  }
  return decision;
}

// Brief text for the verifier when the phase needs a browser.
export function browserVerifierNote(facts = {}) {
  if (facts.browser !== true && facts.playwright !== true) return "";
  return `Browser check: this phase changes UI files or verifies with Playwright. Do the check in a browser only if an application server is already running and an approved browser/Playwright command exists — never start a server yourself. If that is not available, do NOT return INCOMPLETE for it: decide PASS or FAIL on the rest of the evidence (gate, code, tests) and add one note that starts with "${BROWSER_CHECK_NOTE_PREFIX}" and names the changed pages/components and the acceptance criteria the operator must check by hand.`;
}

function extractPrefixedNotes(review, prefix) {
  try {
    const p = prefix.toLowerCase();
    const result = [];
    const candidates = [];
    if (Array.isArray(review?.notes)) candidates.push(...review.notes);
    if (Array.isArray(review?.findings)) candidates.push(...review.findings);
    for (const item of candidates) {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed.toLowerCase().startsWith(p)) {
          result.push(item);
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

export function browserCheckNotes(review) {
  return extractPrefixedNotes(review, BROWSER_CHECK_NOTE_PREFIX);
}

export function networkCheckNotes(review) {
  return extractPrefixedNotes(review, NETWORK_TEST_NOTE_PREFIX);
}
