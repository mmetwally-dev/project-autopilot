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

export function isBrowserCheckFinding(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith(BROWSER_CHECK_NOTE_PREFIX.toLowerCase())) {
    return true;
  }
  return /not (?:been )?(?:checked|verified|tested) in a (?:real )?browser|no approved browser(?: or playwright)? command/i.test(trimmed);
}

export function splitBrowserFindings(review) {
  const findings = Array.isArray(review)
    ? review
    : Array.isArray(review?.findings)
    ? review.findings
    : [];
  const browser = [];
  const rest = [];
  for (const item of findings) {
    const text = typeof item === "string" ? item : (item == null ? "" : JSON.stringify(item));
    if (isBrowserCheckFinding(text)) {
      browser.push(item);
    } else {
      rest.push(item);
    }
  }
  return { browser, rest };
}

// Brief text for the verifier when the phase needs a browser.
export function browserVerifierNote(facts = {}) {
  if (facts.browser !== true && facts.playwright !== true) return "";
  return `Browser check: this phase changes UI files or verifies with Playwright. Do the check in a browser only if an application server is already running and an approved browser/Playwright command exists — never start a server yourself. If that is not available, do NOT return INCOMPLETE for it: decide PASS or FAIL on the rest of the evidence (gate, code, tests) and add one note that starts with "${BROWSER_CHECK_NOTE_PREFIX}" and names the changed pages/components and the acceptance criteria the operator must check by hand.`;
}

export function browserCheckNotes(review) {
  try {
    const prefix = BROWSER_CHECK_NOTE_PREFIX.toLowerCase();
    const result = [];
    const candidates = [];
    if (Array.isArray(review?.notes)) candidates.push(...review.notes);
    if (Array.isArray(review?.findings)) candidates.push(...review.findings);
    for (const item of candidates) {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed.toLowerCase().startsWith(prefix)) {
          result.push(item);
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}
