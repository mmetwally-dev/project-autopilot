#!/usr/bin/env node
// Backlog #4 Part A: failing-file parsing and exclusion-command building.
// Plain node, no runner needed: the samples are the exact shapes vitest and
// jest print when an environment (server/.env/network) failure is reported.
import {
  buildExclusionCommand,
  buildManualCommand,
  formatNotRunInMissions,
  groupFailures,
  parseFailingFiles,
  tailLines,
  appendNotRunInMissionsToReport,
} from "./command-probe.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function checkEqual(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const VITEST_FAILURE = [
  " FAIL  tests/integration/server.test.ts > calls the API",
  "Error: fetch failed",
  "  cause: Error: connect ECONNREFUSED 127.0.0.1:3000",
  " ❯ tests/integration/server.test.ts (2 tests | 2 failed) 12ms",
  "   → fetch failed",
  "",
  " FAIL  tests/unit/patient-db.test.ts > loads a patient",
  "Error: Environment variable not found: DATABASE_URL",
  " ❯ tests/unit/patient-db.test.ts (1 test | 1 failed) 5ms",
  "   → Environment variable not found: DATABASE_URL",
  "",
  " FAIL  tests/unit/remote.test.ts > reaches the remote API",
  "Error: getaddrinfo ENOTFOUND db.example.com",
  " ❯ tests/unit/remote.test.ts (1 test | 1 failed) 3ms",
  "   → getaddrinfo ENOTFOUND db.example.com",
  "",
  " Test Files  3 failed (3)",
].join("\n");

console.log("vitest: environment groups");
const vitest = groupFailures(VITEST_FAILURE, { command: "npx vitest run" });
checkEqual("runner is vitest", vitest.runner, "vitest");
checkEqual("all three files found", vitest.files, [
  "tests/integration/server.test.ts",
  "tests/unit/patient-db.test.ts",
  "tests/unit/remote.test.ts",
]);
checkEqual("three groups", vitest.groups.map((group) => group.kind), ["server", "missing_env", "no_network"]);
check("server reason names the port", vitest.groups[0].reason.includes("127.0.0.1:3000"), vitest.groups[0].reason);
checkEqual("server group files", vitest.groups[0].files, ["tests/integration/server.test.ts"]);
check("env reason names DATABASE_URL", vitest.groups[1].reason.includes("DATABASE_URL"), vitest.groups[1].reason);
checkEqual("env group files", vitest.groups[1].files, ["tests/unit/patient-db.test.ts"]);
check("network reason names the host", vitest.groups[2].reason.includes("db.example.com"), vitest.groups[2].reason);
checkEqual("network group files", vitest.groups[2].files, ["tests/unit/remote.test.ts"]);

const VITEST_MIXED = [
  " FAIL  tests/integration/server.test.ts > calls the API",
  "Error: fetch failed",
  "  cause: Error: connect ECONNREFUSED 127.0.0.1:3000",
  " ❯ tests/integration/server.test.ts (2 tests | 2 failed) 12ms",
  "   → fetch failed",
  "",
  " FAIL  tests/unit/math.test.ts > adds numbers",
  "AssertionError: expected 2 to be 3",
  " ❯ tests/unit/math.test.ts (1 test | 1 failed) 4ms",
  "   → expected 2 to be 3 // Object.is equality",
  "",
  " Test Files  2 failed (2)",
].join("\n");

console.log("\nvitest: a real failure is never hidden");
const mixed = groupFailures(VITEST_MIXED, { command: "npx vitest run" });
checkEqual("two groups", mixed.groups.map((group) => group.kind), ["server", "other"]);
checkEqual("other group keeps the real failing file", mixed.groups[1].files, ["tests/unit/math.test.ts"]);
check("other reason says not environment-related", mixed.groups[1].reason.includes("not environment-related"), mixed.groups[1].reason);

const JEST_FAILURE = [
  "FAIL tests/db.test.js",
  "  ● Test suite failed to run",
  "",
  "    Environment variable not found: DATABASE_URL",
  "",
  "FAIL tests/api.test.js",
  "  ● API calls",
  "",
  "    Error: connect ECONNREFUSED 127.0.0.1:4000",
  "",
  "FAIL tests/net.test.js",
  "  ● Network calls",
  "",
  "    Error: getaddrinfo ENOTFOUND api.example.com",
  "",
  "Test Suites: 3 failed, 3 total",
  "Tests:       1 failed, 1 total",
].join("\n");

console.log("\njest: environment groups");
const jest = groupFailures(JEST_FAILURE, { command: "npx jest" });
checkEqual("runner is jest", jest.runner, "jest");
checkEqual("jest files", jest.files, ["tests/db.test.js", "tests/api.test.js", "tests/net.test.js"]);
checkEqual("jest groups", jest.groups.map((group) => group.kind), ["server", "missing_env", "no_network"]);
checkEqual("jest server file", jest.groups.find((group) => group.kind === "server").files, ["tests/api.test.js"]);
checkEqual("jest env file", jest.groups.find((group) => group.kind === "missing_env").files, ["tests/db.test.js"]);
checkEqual("jest network file", jest.groups.find((group) => group.kind === "no_network").files, ["tests/net.test.js"]);

console.log("\nunknown runner: no file list");
const unknown = groupFailures("something went wrong\nno test framework here", { command: "run-my-tests" });
checkEqual("runner unknown", unknown.runner, "unknown");
checkEqual("no files", unknown.files, []);
checkEqual("no groups", unknown.groups, []);

console.log("\nnode:test best-effort");
const nodeTest = [
  "✖ does stuff (1.2ms)",
  "  Error: connect ECONNREFUSED 127.0.0.1:3000",
  "      at file:///tmp/project/tests/foo.test.mjs:5:3",
].join("\n");
const nodeParsed = parseFailingFiles(nodeTest, { command: "node --test", repoRoot: "/tmp/project" });
checkEqual("node:test runner", nodeParsed.runner, "node-test");
checkEqual("node:test relative file", nodeParsed.files, ["tests/foo.test.mjs"]);

console.log("\nexclusion command building");
checkEqual(
  "vitest exclusion uses --exclude per file",
  buildExclusionCommand("npx vitest run", ["tests/integration/server.test.ts", "tests/unit/db.test.ts"], "vitest"),
  'npx vitest run --exclude "tests/integration/server.test.ts" --exclude "tests/unit/db.test.ts"'
);
checkEqual(
  "vitest does not duplicate an existing exclusion",
  buildExclusionCommand('npx vitest run --exclude "tests/a.test.ts"', ["tests/a.test.ts"], "vitest"),
  'npx vitest run --exclude "tests/a.test.ts"'
);
checkEqual(
  "jest exclusion uses --testPathIgnorePatterns",
  buildExclusionCommand("npx jest", ["tests/db.test.js", "tests/api.test.js"], "jest"),
  'npx jest --testPathIgnorePatterns "tests/db\\.test\\.js|tests/api\\.test\\.js"'
);
checkEqual("unknown runner has no exclusion flag", buildExclusionCommand("pytest", ["tests/a.py"], "unknown"), null);
checkEqual("empty file list returns null", buildExclusionCommand("npx vitest run", [], "vitest"), null);

console.log("\nmanual and report helpers");
checkEqual("npm manual command uses --", buildManualCommand("npm test", ["tests/a.test.ts"]), 'npm test -- "tests/a.test.ts"');
checkEqual("direct runner appends files", buildManualCommand("npx vitest run", ["tests/a.test.ts"]), 'npx vitest run "tests/a.test.ts"');
const report = formatNotRunInMissions([{ files: ["tests/a.test.ts"], reason: "server not reachable on :3000", command: 'npx vitest run "tests/a.test.ts"' }]);
check("report lists reason", report.includes("server not reachable on :3000"));
check("report lists file", report.includes("tests/a.test.ts"));
check("report lists command", report.includes('npx vitest run "tests/a.test.ts"'));
checkEqual("empty report", formatNotRunInMissions([]), "");
check("tail keeps the end", tailLines("a\nb\nc", 2) === "b\nc");
const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-report-"));
const reportFile = path.join(reportDir, "REPORT.md");
fs.writeFileSync(reportFile, "# Mission report\n");
check("append writes once", appendNotRunInMissionsToReport(reportFile, [{ files: ["tests/a.test.ts"], reason: "server not reachable on :3000", command: "npx vitest run" }]));
check("append is idempotent", appendNotRunInMissionsToReport(reportFile, [{ files: ["tests/a.test.ts"], reason: "server not reachable on :3000", command: "npx vitest run" }]) === false);
check("appended report has the list", fs.readFileSync(reportFile, "utf8").includes("Tests not run in missions"));
fs.rmSync(reportDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("ALL CHECKS PASSED");
