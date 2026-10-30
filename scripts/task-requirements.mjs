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

// Brief text for the verifier when the phase needs a browser. The orchestrator
// does not launch a dev server; the verifier starts it or reports the gap.
export function browserVerifierNote(facts = {}) {
  if (facts.browser !== true && facts.playwright !== true) return "";
  return "Browser verification required: this phase changes UI files or verifies with Playwright. Start the project's dev server yourself (use the matching script in package.json, inside your allowed commands and scratch directory), open the changed page in the browser, and check the acceptance criteria there. If the dev server or browser cannot be started, report that check as NOT POSSIBLE with the reason — never skip it silently.";
}
