import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NETWORK_TEST_NOTE_PREFIX,
  NETWORK_GATED_TEST_LINE,
  CODE_REVIEWER_BROWSER_LINE,
  isNetworkGatedTestFinding,
  splitNetworkTestFindings,
  networkCheckNotes
} from "./task-requirements.mjs";
import { offlineGateBriefLine } from "./offline-gate-brief.mjs";
import { verifierTask } from "./verifier-brief.mjs";
import { appendManualChecks } from "./manual-checks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? " -- " + detail : ""}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 1. Prefix detection unit tests (isNetworkGatedTestFinding)
// ─────────────────────────────────────────────────────────────
{
  check(
    "isNetworkGatedTestFinding true for standard uppercase prefix",
    isNetworkGatedTestFinding(`${NETWORK_TEST_NOTE_PREFIX} RUN_INTEGRATION=1 npm test`) === true
  );

  check(
    "isNetworkGatedTestFinding true for lowercase prefix (case-insensitive)",
    isNetworkGatedTestFinding("network test manual run: RUN_INTEGRATION=1 npm run test:integration") === true
  );

  check(
    "isNetworkGatedTestFinding true for mixed case and whitespace-padded string",
    isNetworkGatedTestFinding("   Network Test Manual Run: npx vitest run test/int.spec.ts   ") === true
  );

  check(
    "isNetworkGatedTestFinding false for normal network finding: 'test calls fetch to a remote host'",
    isNetworkGatedTestFinding("test calls fetch to a remote host") === false
  );

  check(
    "isNetworkGatedTestFinding false for normal network finding: Supabase Auth / offline gate complaint",
    isNetworkGatedTestFinding("the suite still depends on Supabase Auth over the network, a running HTTP server and the remote Prisma DB, and is skipped unless RUN_INTEGRATION=1, so none of the scenarios run in the offline gate") === false
  );

  check(
    "isNetworkGatedTestFinding false for regular code finding",
    isNetworkGatedTestFinding("ServiceFormDialog.test.tsx: Both tests pass even without the focus-restore code") === false
  );

  check(
    "isNetworkGatedTestFinding false for empty string",
    isNetworkGatedTestFinding("") === false
  );

  check(
    "isNetworkGatedTestFinding false for null/undefined/non-string",
    isNetworkGatedTestFinding(null) === false &&
      isNetworkGatedTestFinding(undefined) === false &&
      isNetworkGatedTestFinding(123) === false &&
      isNetworkGatedTestFinding({}) === false
  );
}

// ─────────────────────────────────────────────────────────────
// 2. splitNetworkTestFindings unit tests
// ─────────────────────────────────────────────────────────────
{
  const networkFinding1 = `${NETWORK_TEST_NOTE_PREFIX} RUN_INTEGRATION=1 npm run test:int`;
  const networkFinding2 = "network test manual run: dev DB required for test-auth.mjs";
  const regularFinding1 = "test calls fetch to a remote host";
  const regularFinding2 = "ServiceFormDialog.test.tsx: Both tests pass even without the focus-restore code";

  // Mixed findings in review object
  const mixedReview = {
    decision: "FAIL",
    findings: [regularFinding1, networkFinding1, regularFinding2, networkFinding2]
  };
  const { network, rest } = splitNetworkTestFindings(mixedReview);
  check(
    "splitNetworkTestFindings splits mixed findings into correct counts",
    network.length === 2 && rest.length === 2,
    `got network=${network.length}, rest=${rest.length}`
  );
  check(
    "splitNetworkTestFindings isolates network findings",
    network[0] === networkFinding1 && network[1] === networkFinding2
  );
  check(
    "splitNetworkTestFindings preserves regular findings in rest",
    rest[0] === regularFinding1 && rest[1] === regularFinding2
  );

  // Bare array input
  const fromArray = splitNetworkTestFindings([networkFinding1, regularFinding1]);
  check(
    "splitNetworkTestFindings accepts bare array of findings",
    fromArray.network.length === 1 && fromArray.rest.length === 1
  );

  // All network findings
  const allNetwork = splitNetworkTestFindings({ findings: [networkFinding1, networkFinding2] });
  check(
    "splitNetworkTestFindings handles all network findings (rest empty)",
    allNetwork.network.length === 2 && allNetwork.rest.length === 0
  );

  // Zero network findings
  const noNetwork = splitNetworkTestFindings({ findings: [regularFinding1, regularFinding2] });
  check(
    "splitNetworkTestFindings handles zero network findings (network empty)",
    noNetwork.network.length === 0 && noNetwork.rest.length === 2
  );

  // Null/empty review
  const emptyReview = splitNetworkTestFindings(null);
  check(
    "splitNetworkTestFindings handles null review safely",
    emptyReview.network.length === 0 && emptyReview.rest.length === 0
  );

  // Object findings tests
  const objProblemFinding = {
    tasks: ["T9"],
    location: "tests/x.test.ts:1-9",
    problem: `${NETWORK_TEST_NOTE_PREFIX} RUN_INTEGRATION=1 npm test`,
    correction: "run manually"
  };
  const splitObjProblem = splitNetworkTestFindings([objProblemFinding]);
  check(
    "an object finding with the prefix in 'problem' is split out",
    splitObjProblem.network.length === 1 &&
      splitObjProblem.network[0] === objProblemFinding &&
      splitObjProblem.rest.length === 0
  );

  const objFindingFinding = { finding: "network test manual run: dev DB" };
  const objTextFinding = { text: `${NETWORK_TEST_NOTE_PREFIX} test server` };
  const objSummaryFinding = { summary: `  ${NETWORK_TEST_NOTE_PREFIX} run scenario  ` };
  const splitOtherFields = splitNetworkTestFindings([objFindingFinding, objTextFinding, objSummaryFinding]);
  check(
    "object findings with prefix in finding / text / summary are split out",
    splitOtherFields.network.length === 3 && splitOtherFields.rest.length === 0
  );

  const objCorrectionFinding = {
    tasks: ["T9"],
    location: "tests/x.test.ts:1-9",
    problem: "offline gate failed",
    correction: `${NETWORK_TEST_NOTE_PREFIX} RUN_INTEGRATION=1 npm test`
  };
  const objLocationFinding = {
    tasks: ["T9"],
    location: `${NETWORK_TEST_NOTE_PREFIX} tests/x.test.ts:1-9`,
    problem: "offline gate failed",
    correction: "fix tests"
  };
  const splitNonTarget = splitNetworkTestFindings([objCorrectionFinding, objLocationFinding]);
  check(
    "an object finding with the prefix only inside 'correction' or 'location' is NOT split out",
    splitNonTarget.network.length === 0 &&
      splitNonTarget.rest.length === 2 &&
      splitNonTarget.rest[0] === objCorrectionFinding &&
      splitNonTarget.rest[1] === objLocationFinding
  );
}

// ─────────────────────────────────────────────────────────────
// 3. networkCheckNotes unit tests
// ─────────────────────────────────────────────────────────────
{
  const note1 = `${NETWORK_TEST_NOTE_PREFIX} RUN_INTEGRATION=1 npm test`;
  const note2 = "  network test manual run: dev DB seed required  ";
  const regularNote = "all mocks working";
  const regularFinding = "regular finding text";

  const extracted = networkCheckNotes({
    notes: [note1, regularNote],
    findings: [note2, regularFinding]
  });
  check(
    "networkCheckNotes extracts prefixed notes from both notes and findings",
    extracted.length === 2 && extracted[0] === note1 && extracted[1] === note2
  );

  check(
    "networkCheckNotes returns empty array for null/empty review",
    networkCheckNotes(null).length === 0 && networkCheckNotes({}).length === 0
  );
}

// ─────────────────────────────────────────────────────────────
// 4. Source checks: constant in prompt sites and verifier brief
// ─────────────────────────────────────────────────────────────
{
  const autopilotPath = path.join(here, "autopilot.mjs");
  const autopilotSrc = fs.readFileSync(autopilotPath, "utf8");

  // Constant verification
  check(
    "NETWORK_GATED_TEST_LINE exported and contains prefix and expected guidance",
    typeof NETWORK_GATED_TEST_LINE === "string" &&
      NETWORK_GATED_TEST_LINE.includes(NETWORK_TEST_NOTE_PREFIX) &&
      NETWORK_GATED_TEST_LINE.includes("RUN_INTEGRATION") &&
      NETWORK_GATED_TEST_LINE.includes("judge that test's code statically")
  );

  // autopilot.mjs imports NETWORK_GATED_TEST_LINE
  check(
    "autopilot.mjs imports NETWORK_GATED_TEST_LINE",
    autopilotSrc.includes("NETWORK_GATED_TEST_LINE")
  );

  // Helper to extract review prompt templates from autopilot source
  function extractReviewPromptTemplate(source, blockMarker) {
    const blockIdx = source.indexOf(blockMarker);
    if (blockIdx === -1) return null;
    const reviewCallIdx = source.indexOf('review("code_reviewer",', blockIdx);
    if (reviewCallIdx === -1) return null;
    const start = source.indexOf("`", reviewCallIdx);
    if (start === -1) return null;
    let i = start + 1;
    let depth = 0;
    while (i < source.length) {
      if (source[i] === "`" && depth === 0) {
        return source.slice(start, i + 1);
      }
      if (source[i] === "$" && source[i + 1] === "{") {
        depth++;
        i += 2;
        continue;
      }
      if (source[i] === "}" && depth > 0) {
        depth--;
      }
      i++;
    }
    return null;
  }

  // Standalone code_reviewer prompt site check
  const standalonePrompt = extractReviewPromptTemplate(autopilotSrc, "tasksFilePathForReview");
  check(
    "standalone phase review prompt includes NETWORK_GATED_TEST_LINE next to CODE_REVIEWER_BROWSER_LINE",
    Boolean(
      standalonePrompt &&
        standalonePrompt.includes("${CODE_REVIEWER_BROWSER_LINE}\\n\\n${NETWORK_GATED_TEST_LINE}")
    )
  );

  // SpecKit code_reviewer prompt site check
  const speckitPrompt = extractReviewPromptTemplate(autopilotSrc, "reviewTaskRef(s,speckitPhaseFeedbackKey");
  check(
    "speckit phase review prompt includes NETWORK_GATED_TEST_LINE next to CODE_REVIEWER_BROWSER_LINE",
    Boolean(
      speckitPrompt &&
        speckitPrompt.includes("${CODE_REVIEWER_BROWSER_LINE}\\n\\n${NETWORK_GATED_TEST_LINE}")
    )
  );

  // Verifier brief check in verifier-brief.mjs
  const verifierBriefPath = path.join(here, "verifier-brief.mjs");
  const verifierBriefSrc = fs.readFileSync(verifierBriefPath, "utf8");
  check(
    "verifier-brief.mjs imports NETWORK_GATED_TEST_LINE",
    verifierBriefSrc.includes("NETWORK_GATED_TEST_LINE")
  );

  const briefRendered = verifierTask("Verify task", null, null, {}, null);
  check(
    "rendered verifier brief (verifierTask) includes NETWORK_GATED_TEST_LINE",
    briefRendered.includes(NETWORK_GATED_TEST_LINE)
  );

  // Autopilot.mjs verifier sites call networkCheckNotes
  const networkCheckMatches = autopilotSrc.match(/networkCheckNotes\(vv\.review\)/g) || [];
  check(
    "autopilot.mjs calls networkCheckNotes(vv.review) at both verifier sites",
    networkCheckMatches.length === 2
  );
}

// ─────────────────────────────────────────────────────────────
// 5. offlineGateBriefLine reviewer exception vs implementer check
// ─────────────────────────────────────────────────────────────
{
  const config = { gates: { commands: ["npm test"], offline_test_tools: "PGlite" } };
  const reviewerLine = offlineGateBriefLine({ roleName: "code_reviewer", config });
  const verifierLine = offlineGateBriefLine({ roleName: "verifier", config });
  const implementerLine = offlineGateBriefLine({ roleName: "implementer", config });
  const plannerLine = offlineGateBriefLine({ roleName: "planner", config });

  check(
    "offlineGateBriefLine for code_reviewer mentions env-gated exception",
    typeof reviewerLine === "string" &&
      reviewerLine.includes("The offline rule does not apply to tests the task explicitly env-gates on the network")
  );

  check(
    "offlineGateBriefLine for verifier mentions env-gated exception",
    typeof verifierLine === "string" &&
      verifierLine.includes("The offline rule does not apply to tests the task explicitly env-gates on the network")
  );

  check(
    "offlineGateBriefLine for implementer does NOT mention env-gated exception",
    typeof implementerLine === "string" &&
      !implementerLine.includes("env-gates on the network")
  );

  check(
    "offlineGateBriefLine for planner does NOT mention env-gated exception",
    typeof plannerLine === "string" &&
      !plannerLine.includes("env-gates on the network")
  );
}

// ─────────────────────────────────────────────────────────────
// 6. review() function body source checks and behavior simulation
// ─────────────────────────────────────────────────────────────
{
  const autopilotPath = path.join(here, "autopilot.mjs");
  const autopilotSrc = fs.readFileSync(autopilotPath, "utf8");

  const reviewFnStart = autopilotSrc.indexOf("function review(reviewer,task,c,s,");
  const nextFnStart = autopilotSrc.indexOf("function planningScopeParts(", reviewFnStart);
  const reviewFnBody = autopilotSrc.slice(reviewFnStart, nextFnStart);

  check(
    "review() calls splitNetworkTestFindings",
    reviewFnBody.includes("splitNetworkTestFindings")
  );

  check(
    "review() logs manual network-test run recorded message",
    reviewFnBody.includes("Manual network-test run recorded in MANUAL-CHECKS.md")
  );

  // Behavioral test with appendManualChecks
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-network-test-"));
  try {
    const networkFinding = `${NETWORK_TEST_NOTE_PREFIX} RUN_INTEGRATION=1 npm test -- integration`;
    const regularFinding = "ServiceFormDialog.test.tsx: Both tests pass even without the focus-restore code";

    // Scenario A: Review FAIL with ONLY network-gated test finding -> flips to PASS
    {
      const resultA = {
        status: "completed",
        review: {
          decision: "FAIL",
          findings: [networkFinding]
        }
      };

      const { network, rest } = splitNetworkTestFindings(resultA.review);
      check("scenario A: network findings detected", network.length === 1);
      if (network.length) {
        appendManualChecks(tempDir, {
          phaseName: "phase-9",
          notes: network,
          at: new Date().toISOString()
        });
        resultA.review.findings = rest;
        if (rest.length === 0) {
          resultA.review.decision = "PASS";
        }
      }

      check("scenario A: decision flipped from FAIL to PASS", resultA.review.decision === "PASS");
      check("scenario A: findings emptied", resultA.review.findings.length === 0);

      const manualChecksFile = path.join(tempDir, "MANUAL-CHECKS.md");
      check("scenario A: MANUAL-CHECKS.md created", fs.existsSync(manualChecksFile));
      const contentA = fs.readFileSync(manualChecksFile, "utf8");
      check("scenario A: MANUAL-CHECKS.md contains network finding note", contentA.includes(networkFinding));
    }

    // Scenario B: Review FAIL with mixed regular + network findings -> remains FAIL
    {
      const resultB = {
        status: "completed",
        review: {
          decision: "FAIL",
          findings: [regularFinding, networkFinding]
        }
      };

      const { network, rest } = splitNetworkTestFindings(resultB.review);
      if (network.length) {
        appendManualChecks(tempDir, {
          phaseName: "phase-9",
          notes: network,
          at: new Date().toISOString()
        });
        resultB.review.findings = rest;
        if (rest.length === 0) {
          resultB.review.decision = "PASS";
        }
      }

      check("scenario B: decision remains FAIL", resultB.review.decision === "FAIL");
      check(
        "scenario B: findings contains only rest",
        resultB.review.findings.length === 1 && resultB.review.findings[0] === regularFinding
      );
    }

    // Scenario C: Review FAIL whose only finding is an object finding with prefix in problem -> flips to PASS
    {
      const objFinding = {
        tasks: ["T9"],
        location: "tests/x.test.ts:1-9",
        problem: `${NETWORK_TEST_NOTE_PREFIX} RUN_INTEGRATION=1 dev DB required`,
        correction: "run with dev DB"
      };
      const resultC = {
        status: "completed",
        review: {
          decision: "FAIL",
          findings: [objFinding]
        }
      };

      const { network, rest } = splitNetworkTestFindings(resultC.review);
      check("scenario C: object network finding detected", network.length === 1 && network[0] === objFinding);
      if (network.length) {
        appendManualChecks(tempDir, {
          phaseName: "phase-9",
          notes: network,
          at: new Date().toISOString()
        });
        resultC.review.findings = rest;
        if (rest.length === 0) {
          resultC.review.decision = "PASS";
        }
      }

      check("scenario C: review() turns a FAIL whose only finding is such an object into PASS", resultC.review.decision === "PASS");
      check("scenario C: findings emptied", resultC.review.findings.length === 0);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll network-gated test finding tests passed!");
}
