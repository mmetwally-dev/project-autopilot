import assert from "node:assert/strict";
import { formatPlaywrightStatusBlock } from "./playwright-status-block.mjs";

const discoveredModule = { status: "discovered", source: "skill", dir: "/should/never/appear", nodeModulesDir: "/should/never/appear", package: "/should/never/appear", reason: null };
const discoveredBrowser = { status: "discovered", source: "package-local", path: "/should/never/appear", root: "/should/never/appear", reason: null };
const missingModule = { status: "not-found", source: null, dir: null, nodeModulesDir: null, package: null, reason: "module_not_found_should_never_appear" };
const missingBrowser = { status: "not-found", source: null, path: null, root: null, reason: "browser_not_found_should_never_appear" };
const invalidModule = { status: "invalid-explicit-override", source: "explicit-env", dir: null, nodeModulesDir: null, package: null, reason: "invalid_module_reason_should_never_appear" };
const invalidBrowser = { status: "invalid-explicit-override", source: "explicit-env", path: null, root: null, reason: "invalid_browser_reason_should_never_appear" };

const rawFieldValues = [
  "/should/never/appear",
  "module_not_found_should_never_appear",
  "browser_not_found_should_never_appear",
  "invalid_module_reason_should_never_appear",
  "invalid_browser_reason_should_never_appear"
];

function assertNoRawFields(text) {
  for (const value of rawFieldValues) assert.ok(!text.includes(value), `output must never contain raw field value: ${value}`);
}

// Both discovered: no install/re-run lines at all.
{
  const out = formatPlaywrightStatusBlock({ module: discoveredModule, browser: discoveredBrowser });
  assert.equal(out, "✓ Playwright module: available (source: skill)\n✓ Playwright browser: available (source: package-local)");
  assertNoRawFields(out);
}

// Browser-only missing (the realistic common case: module ships with the skill, browser binary never auto-downloaded).
{
  const out = formatPlaywrightStatusBlock({ module: discoveredModule, browser: missingBrowser });
  assert.equal(
    out,
    "✓ Playwright module: available (source: skill)\n· Playwright browser: not installed\nInstall: npx playwright install chromium\nRe-run \"ap setup\" (or \"ap config\") afterward to confirm the install — this does not re-check automatically."
  );
  assertNoRawFields(out);
}

// Module missing: both install lines plus the re-run line.
{
  const out = formatPlaywrightStatusBlock({ module: missingModule, browser: missingBrowser });
  assert.equal(
    out,
    "· Playwright module: not installed\n· Playwright browser: not installed\nInstall: npm install playwright\nInstall: npx playwright install chromium\nRe-run \"ap setup\" (or \"ap config\") afterward to confirm the install — this does not re-check automatically."
  );
  assertNoRawFields(out);
}

// invalid-explicit-override renders distinct wording per dimension, never collapsing into "not installed".
{
  const out = formatPlaywrightStatusBlock({ module: invalidModule, browser: discoveredBrowser });
  assert.equal(
    out,
    "· Playwright module: misconfigured (PLAYWRIGHT_MODULE_DIR is set but invalid)\n✓ Playwright browser: available (source: package-local)\nInstall: npm install playwright\nRe-run \"ap setup\" (or \"ap config\") afterward to confirm the install — this does not re-check automatically."
  );
  assertNoRawFields(out);
}
{
  const out = formatPlaywrightStatusBlock({ module: discoveredModule, browser: invalidBrowser });
  assert.equal(
    out,
    "✓ Playwright module: available (source: skill)\n· Playwright browser: misconfigured (PLAYWRIGHT_BROWSERS_PATH is set but invalid)\nInstall: npx playwright install chromium\nRe-run \"ap setup\" (or \"ap config\") afterward to confirm the install — this does not re-check automatically."
  );
  assertNoRawFields(out);
}

console.log("setup.mjs formatPlaywrightStatusBlock fixture tests passed");
