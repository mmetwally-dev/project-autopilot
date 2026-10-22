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
