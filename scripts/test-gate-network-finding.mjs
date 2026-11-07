#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatGateResult } from "./standalone-handoff.mjs";
import { networkGateFailureSignals } from "./gate-failure-locality.mjs";
import { detectOfflineTestTools } from "./detect-offline-test-tools.mjs";
import { toRuntimeConfig, toNewLayoutConfig } from "./config-layout.mjs";
import { validateNewConfig } from "./config-validation.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    ok += 1;
    return;
  }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  failed += 1;
}

// ── 1. formatGateResult network finding ──
{
  const gateWithNetworkErr = {
    ok: false,
    command: "npm test",
    exitCode: 1,
    tail: "Error: getaddrinfo EAI_AGAIN aws-0-eu-west-1.pooler.supabase.com\n    at Client.connect",
  };
  const res = formatGateResult(gateWithNetworkErr);
  check("failing gate with getaddrinfo EAI_AGAIN output contains 'Network:'", res.includes("Network:"), res);
  check("failing gate with getaddrinfo EAI_AGAIN output contains 'EAI_AGAIN'", res.includes("EAI_AGAIN"), res);
  check("failing gate with getaddrinfo EAI_AGAIN output contains 'getaddrinfo'", res.includes("getaddrinfo"), res);
  check(
    "failing gate carries instructions for in-process fake or mock",
    res.includes("needs network/a remote service, but the gate is offline — make it use an in-process fake or mock"),
    res
  );

  const gateNoNetworkErr = {
    ok: false,
    command: "npm test",
    exitCode: 1,
    tail: "AssertionError: expected true to be false\n    at Object.<anonymous>",
  };
  const resNoNet = formatGateResult(gateNoNetworkErr);
  check("failing gate without network codes has NO 'Network:' line", !resNoNet.includes("Network:"), resNoNet);

  const passingGate = {
    ok: true,
    command: "npm test",
    exitCode: 0,
    tail: "All 5 tests passed",
  };
  const resPass = formatGateResult(passingGate);
  check("passing gate has NO 'Network:' line", !resPass.includes("Network:"), resPass);

  // Results array shape
  const arrayGateWithNetworkErr = {
    results: [
      {
        command: "npm test",
        ok: false,
        exitCode: 1,
        tail: "connect ECONNREFUSED 127.0.0.1:5432",
      },
    ],
  };
  const resArr = formatGateResult(arrayGateWithNetworkErr);
  check("array-shaped failing gate with network code contains 'Network:' and code", resArr.includes("Network:") && resArr.includes("ECONNREFUSED"), resArr);
}

// ── 2. networkGateFailureSignals unit cases ──
{
  check("networkGateFailureSignals returns empty array for empty string", networkGateFailureSignals("").length === 0);
  check("networkGateFailureSignals returns empty array for null", networkGateFailureSignals(null).length === 0);
  check("networkGateFailureSignals returns empty array for undefined", networkGateFailureSignals(undefined).length === 0);
  check("networkGateFailureSignals returns empty array for number", networkGateFailureSignals(123).length === 0);
  check("networkGateFailureSignals returns empty array when no patterns match", networkGateFailureSignals("plain error message").length === 0);

  const repeated = "getaddrinfo EAI_AGAIN and later getaddrinfo EAI_AGAIN again";
  const signals = networkGateFailureSignals(repeated);
  check("networkGateFailureSignals de-duplicates codes", signals.length === 2 && signals[0] === "getaddrinfo" && signals[1] === "EAI_AGAIN", JSON.stringify(signals));

  const allPatterns = "ENOTFOUND ECONNREFUSED ENETUNREACH EHOSTUNREACH ETIMEDOUT";
  const matchedAll = networkGateFailureSignals(allPatterns);
  check("networkGateFailureSignals matches all network codes", matchedAll.length === 5, JSON.stringify(matchedAll));
}

// ── 3. detectOfflineTestTools tests ──
{
  // Temp dir with package.json devDependency pglite -> label
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), "ap-detect-1-"));
  try {
    fs.writeFileSync(
      path.join(tmp1, "package.json"),
      JSON.stringify({
        name: "test-pkg",
        devDependencies: {
          "@electric-sql/pglite": "^0.2.0",
        },
      })
    );
    const label = detectOfflineTestTools(tmp1);
    check(
      "detectOfflineTestTools detects @electric-sql/pglite in devDependencies",
      label === "PGlite (@electric-sql/pglite) for PostgreSQL",
      label
    );
  } finally {
    fs.rmSync(tmp1, { recursive: true, force: true });
  }

  // Temp dir with only node_modules/@electric-sql/pglite/package.json -> label
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "ap-detect-2-"));
  try {
    const nested = path.join(tmp2, "node_modules", "@electric-sql", "pglite");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "package.json"), JSON.stringify({ name: "@electric-sql/pglite" }));
    const label = detectOfflineTestTools(tmp2);
    check(
      "detectOfflineTestTools detects node_modules/@electric-sql/pglite/package.json",
      label === "PGlite (@electric-sql/pglite) for PostgreSQL",
      label
    );
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }

  // Temp dir empty -> ""
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "ap-detect-3-"));
  try {
    const label = detectOfflineTestTools(tmp3);
    check("detectOfflineTestTools on empty dir returns empty string", label === "", label);
  } finally {
    fs.rmSync(tmp3, { recursive: true, force: true });
  }

  // Multiple tools joined with "; "
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), "ap-detect-4-"));
  try {
    fs.writeFileSync(
      path.join(tmp4, "package.json"),
      JSON.stringify({
        name: "test-multi",
        dependencies: {
          "msw": "^2.0.0",
          "better-sqlite3": "^9.0.0",
        },
      })
    );
    const label = detectOfflineTestTools(tmp4);
    check(
      "detectOfflineTestTools joins multiple tools with '; ' in catalog order",
      label === "better-sqlite3 (SQLite); msw for HTTP mocks",
      label
    );
  } finally {
    fs.rmSync(tmp4, { recursive: true, force: true });
  }
}

// ── 4. Config round-trip and validation ──
{
  const layout = {
    schema_version: "4.0",
    project: { repo: ".", planning_framework: "standalone" },
    tests: {
      gate_commands: ["npm test"],
      gate_network: false,
      offline_test_tools: "PGlite (@electric-sql/pglite) for PostgreSQL",
    },
  };

  const runtime = toRuntimeConfig(layout);
  check(
    "toRuntimeConfig maps tests.offline_test_tools to gates.offline_test_tools",
    runtime.gates?.offline_test_tools === "PGlite (@electric-sql/pglite) for PostgreSQL",
    JSON.stringify(runtime.gates)
  );

  const roundTripped = toNewLayoutConfig(runtime);
  check(
    "toNewLayoutConfig maps gates.offline_test_tools back to tests.offline_test_tools",
    roundTripped.tests?.offline_test_tools === "PGlite (@electric-sql/pglite) for PostgreSQL",
    JSON.stringify(roundTripped.tests)
  );

  // Validation: non-string value is a validation error
  const invalidLayout = {
    schema_version: "4.0",
    project: { repo: ".", planning_framework: "standalone" },
    tests: {
      offline_test_tools: 12345, // invalid type
    },
  };
  const val = validateNewConfig(invalidLayout);
  check("non-string tests.offline_test_tools fails validation", !val.valid);
  check(
    "validation error message mentions tests.offline_test_tools and type",
    val.errors.some((e) => e.includes("tests.offline_test_tools") && e.includes("string")),
    JSON.stringify(val.errors)
  );

  // Valid string passes validation
  const validLayout = {
    schema_version: "4.0",
    project: { repo: ".", planning_framework: "standalone" },
    tests: {
      offline_test_tools: "PGlite (@electric-sql/pglite) for PostgreSQL",
    },
  };
  const validRes = validateNewConfig(validLayout);
  check("valid string tests.offline_test_tools passes validation", validRes.valid, JSON.stringify(validRes.errors));
}

if (failed > 0) {
  console.error(`\nFAILED: ${failed} check(s) failed, ${ok} passed.`);
  process.exit(1);
} else {
  console.log(`\nALL CHECKS PASSED (${ok}/${ok})`);
}
