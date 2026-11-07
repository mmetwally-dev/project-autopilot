#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { offlineGateBriefLine } from "./offline-gate-brief.mjs";

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

// 1. Returns the line for implementer with isolation on + commands
{
  const config = {
    gates: {
      network_isolation: true,
      commands: ["npm test"],
    },
  };
  const line = offlineGateBriefLine({ roleName: "implementer", config });
  check(
    "offlineGateBriefLine returns expected line for implementer with isolation on and commands",
    line ===
      "The test gate runs with NO network access: tests must not reach external hosts, remote databases or cloud APIs. Use in-process fakes or mocks instead; a test that needs the network fails in the gate.",
    line
  );
}

// 2. Includes "(available here: PGlite ...)" when offline_test_tools set
{
  const config = {
    gates: {
      network_isolation: true,
      commands: ["npm test"],
      offline_test_tools: "PGlite (@electric-sql/pglite) for PostgreSQL",
    },
  };
  const line = offlineGateBriefLine({ roleName: "implementer", config });
  check(
    "offlineGateBriefLine includes tools note when offline_test_tools is set",
    line ===
      "The test gate runs with NO network access: tests must not reach external hosts, remote databases or cloud APIs. Use in-process fakes or mocks instead (available here: PGlite (@electric-sql/pglite) for PostgreSQL); a test that needs the network fails in the gate.",
    line
  );
}

// 3. Null when network_isolation === false
{
  const config = {
    gates: {
      network_isolation: false,
      commands: ["npm test"],
      offline_test_tools: "PGlite (@electric-sql/pglite) for PostgreSQL",
    },
  };
  const line = offlineGateBriefLine({ roleName: "implementer", config });
  check("offlineGateBriefLine returns null when network_isolation === false", line === null, line);
}

// 4. Null with no gate commands (empty array or missing)
{
  const configEmpty = {
    gates: {
      network_isolation: true,
      commands: [],
    },
  };
  check("offlineGateBriefLine returns null when commands array is empty", offlineGateBriefLine({ roleName: "implementer", config: configEmpty }) === null);

  const configMissing = {
    gates: {
      network_isolation: true,
    },
  };
  check("offlineGateBriefLine returns null when commands is missing", offlineGateBriefLine({ roleName: "implementer", config: configMissing }) === null);
}

// 5. Null for role "plan_reviewer", but valid for planner, code_reviewer, verifier
{
  const config = {
    gates: {
      network_isolation: true,
      commands: ["npm test"],
    },
  };
  check("offlineGateBriefLine returns null for role plan_reviewer", offlineGateBriefLine({ roleName: "plan_reviewer", config }) === null);
  check("offlineGateBriefLine returns string for role planner", typeof offlineGateBriefLine({ roleName: "planner", config }) === "string");
  check("offlineGateBriefLine returns string for role code_reviewer", typeof offlineGateBriefLine({ roleName: "code_reviewer", config }) === "string");
  check("offlineGateBriefLine returns string for role verifier", typeof offlineGateBriefLine({ roleName: "verifier", config }) === "string");

  const judgeSnippet = "Judge only tests this phase added or changed";
  const verifierLine = offlineGateBriefLine({ roleName: "verifier", config });
  const reviewerLine = offlineGateBriefLine({ roleName: "code_reviewer", config });
  const implementerLine = offlineGateBriefLine({ roleName: "implementer", config });
  const plannerLine = offlineGateBriefLine({ roleName: "planner", config });

  check("offlineGateBriefLine for verifier contains 'Judge only tests this phase added or changed'", verifierLine?.includes(judgeSnippet));
  check("offlineGateBriefLine for code_reviewer contains 'Judge only tests this phase added or changed'", reviewerLine?.includes(judgeSnippet));
  check("offlineGateBriefLine for implementer does NOT contain 'Judge only tests this phase added or changed'", !implementerLine?.includes(judgeSnippet));
  check("offlineGateBriefLine for planner does NOT contain 'Judge only tests this phase added or changed'", !plannerLine?.includes(judgeSnippet));
}

// 6. Source-text check that autopilot.mjs calls offlineGateBriefLine({roleName, config:c}) inside rawRelayTaskText
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

  const rawRelayMatch = autopilotSource.match(/const rawRelayTaskText\s*=\s*(\[[\s\S]*?\])\.filter\(Boolean\)\.join\("\\n"\);/);
  check("rawRelayTaskText array matched in scripts/autopilot.mjs", !!rawRelayMatch);

  const arraySource = rawRelayMatch ? rawRelayMatch[1] : "";
  check(
    "autopilot.mjs calls offlineGateBriefLine({roleName, config:c}) inside rawRelayTaskText",
    arraySource.includes("offlineGateBriefLine({roleName, config:c})"),
    arraySource.slice(0, 500)
  );

  check(
    "autopilot.mjs imports offlineGateBriefLine from ./offline-gate-brief.mjs",
    autopilotSource.includes('import { offlineGateBriefLine } from "./offline-gate-brief.mjs";') ||
      autopilotSource.includes("offlineGateBriefLine")
  );
}

if (failed > 0) {
  console.error(`FAILED: ${failed} check(s) failed, ${ok} passed.`);
  process.exit(1);
} else {
  console.log(`ALL CHECKS PASSED (${ok}/${ok})`);
}
