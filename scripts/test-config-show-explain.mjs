import {getEffectiveConfigForTest, renderConfigShow} from "./config-show.mjs";
import {descriptionFor} from "./gen-config-schema.mjs";
import {spawnSync} from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {fileURLToPath} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOW_SCRIPT = path.join(HERE, "config-show.mjs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`);
  }
}

function assertContains(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    throw new Error(`Assertion failed: ${message}\n  Expected to contain: ${needle}\n  Actual: ${haystack}`);
  }
}

function assertNotContains(haystack, needle, message) {
  if (haystack.includes(needle)) {
    throw new Error(`Assertion failed: ${message}\n  Expected NOT to contain: ${needle}\n  Actual: ${haystack}`);
  }
}

function valueLines(output) {
  return output.split("\n").filter((line) => line && !line.startsWith("  # "));
}

function explanationLines(output) {
  return output.split("\n").filter((line) => line.startsWith("  # "));
}

// Test 1: Without --explain the output is unchanged and has no explanations
console.log("Test 1: Without --explain output is unchanged");
{
  const effectiveConfig = getEffectiveConfigForTest({});
  const baseline = renderConfigShow(effectiveConfig);
  const output = renderConfigShow(effectiveConfig, {explain: false});

  assertEqual(output, baseline, "explain: false should render exactly like the default");
  assertNotContains(output, "  # ", "No explanation lines without --explain");
  console.log("  PASS");
}

// Test 2: retries.implementation gets its schema description on the next line
console.log("Test 2: retries.implementation explanation follows its value");
{
  const effectiveConfig = getEffectiveConfigForTest({});
  const output = renderConfigShow(effectiveConfig, {explain: true});
  const lines = output.split("\n");
  const valueIndex = lines.findIndex((line) => line.startsWith("retries.implementation: "));

  assert(valueIndex >= 0, "retries.implementation value line should be present");
  assertEqual(
    lines[valueIndex + 1],
    `  # ${descriptionFor("retries.implementation")}`,
    "The line after retries.implementation should be its indented description"
  );
  console.log("  PASS");
}

// Test 3: --explain combines with --path and only shows that subtree
console.log("Test 3: --explain works with --path");
{
  const effectiveConfig = getEffectiveConfigForTest({});
  const output = renderConfigShow(effectiveConfig, {showOnly: "retries", explain: true});
  const values = valueLines(output);
  const explanations = explanationLines(output);

  assert(values.length > 0, "retries subtree should have value lines");
  for (const line of values) {
    assert(line.startsWith("retries."), `Every value line should start with retries.: ${line}`);
  }
  assertEqual(explanations.length, values.length, "Every retries value line should have one explanation");
  assertContains(output, "retries.implementation: ", "retries.implementation should be shown");
  assert(!values.some((line) => line.startsWith("project.")), "Other sections should not be shown");
  assert(!values.some((line) => line.startsWith("caps.")), "Other sections should not be shown");
  console.log("  PASS");
}

// Test 4: CLI accepts --explain and still rejects unknown arguments
console.log("Test 4: CLI --explain succeeds and unknown arguments fail");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-config-show-explain-"));
  process.on("exit", () => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  const autopilotDir = path.join(tmpDir, ".autopilot");
  fs.mkdirSync(autopilotDir, {recursive: true});
  fs.writeFileSync(
    path.join(autopilotDir, "config.json"),
    `${JSON.stringify({schema_version: "4.0", project: {repo: "."}}, null, 2)}\n`
  );

  const withExplain = spawnSync(process.execPath, [SHOW_SCRIPT, "--repo", tmpDir, "--explain"], {
    stdio: "pipe",
    shell: false,
    encoding: "utf8"
  });
  assertEqual(withExplain.status, 0, `--explain should exit 0: ${withExplain.stderr}`);
  assertContains(withExplain.stdout, "retries.implementation: ", "CLI should render the effective config");
  assertContains(
    withExplain.stdout,
    `  # ${descriptionFor("retries.implementation")}`,
    "CLI should render explanations"
  );

  const unknown = spawnSync(process.execPath, [SHOW_SCRIPT, "--repo", tmpDir, "--explain", "extra"], {
    stdio: "pipe",
    shell: false,
    encoding: "utf8"
  });
  assertEqual(unknown.status, 2, "An unknown positional argument should exit 2");
  assertContains(unknown.stderr, "Unknown argument: extra", "The unknown argument should be reported");
  console.log("  PASS");
}

// Test 5: Every value line in the full --explain output has exactly one explanation
console.log("Test 5: Full --explain output pairs every value with one explanation");
{
  const effectiveConfig = getEffectiveConfigForTest({});
  const output = renderConfigShow(effectiveConfig, {explain: true});
  const lines = output.split("\n").filter(Boolean);

  assert(lines.length > 0, "Full --explain output should not be empty");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("  # ")) {
      assert(index > 0 && !lines[index - 1].startsWith("  # "), `Explanation line should follow exactly one value line: ${line}`);
      continue;
    }
    assert(index + 1 < lines.length, `Value line should be followed by an explanation: ${line}`);
    assert(lines[index + 1].startsWith("  # "), `Value line should be followed by an explanation: ${line}`);
  }
  assertEqual(explanationLines(output).length, valueLines(output).length, "Each value line should have exactly one explanation");
  console.log("  PASS");
}

console.log("\n✓ All tests passed!");
process.exit(0);
