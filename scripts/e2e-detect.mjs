// Detects whether a repo is a UI project and which e2e tool it already uses.
// Reads BOTH dependencies and devDependencies of package.json.
import fs from "node:fs";
import path from "node:path";

const UI_PACKAGES = ["react", "next", "vue", "svelte", "angular", "@angular/core"];
const E2E_TOOLS = [
  ["@playwright/test", "playwright"],
  ["cypress", "cypress"],
];

function readDeps(repo) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  } catch {
    return {};
  }
}

export function detectUiProject(repo) {
  const deps = readDeps(repo);
  return UI_PACKAGES.some((name) => Object.hasOwn(deps, name));
}

export function detectE2eTool(repo) {
  const deps = readDeps(repo);
  for (const [name, tool] of E2E_TOOLS) if (Object.hasOwn(deps, name)) return tool;
  return null;
}
