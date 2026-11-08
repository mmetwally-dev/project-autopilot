import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NETWORK_TEST_NOTE_PREFIX,
  BROWSER_CHECK_NOTE_PREFIX,
  splitBrowserFindings,
  splitNetworkTestFindings,
  moveManualCheckFindings,
  manualCheckNoteText,
  filterUnrecordedManualChecks,
  verifierVerdictAfterManualMove,
  browserCheckNotes,
  networkCheckNotes
} from "./task-requirements.mjs";
import { appendManualChecks } from "./manual-checks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilotPath = path.join(here, "autopilot.mjs");
const autopilotSrc = fs.readFileSync(autopilotPath, "utf8");

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
// 1. moveManualCheckFindings helper unit tests
// ─────────────────────────────────────────────────────────────
{
  const networkStr = `${NETWORK_TEST_NOTE_PREFIX} RUN_INTEGRATION=1 npm test`;
  const networkLower = "network test manual run: dev DB required";
  const browserStr = `${BROWSER_CHECK_NOTE_PREFIX} check login modal`;
  const browserLower = "browser check not possible: check responsive layout";
  const regularStr1 = "Missing null check in UserProfile.tsx:42";
  const regularStr2 = "Button styling does not match design token";

  const objNetworkProblem = {
    problem: `${NETWORK_TEST_NOTE_PREFIX} staging rehearsal required`,
    file: "staging.test.ts"
  };
  const objNetworkFinding = {
    finding: "NETWORK TEST MANUAL RUN: seed DB",
    step: "seed"
  };
  const objNetworkText = {
    text: `${NETWORK_TEST_NOTE_PREFIX} auth server`,
    location: "auth.ts"
  };
  const objNetworkSummary = {
    summary: `${NETWORK_TEST_NOTE_PREFIX} remote redis`,
    notes: []
  };
  const objNetworkMessage = {
    message: `${NETWORK_TEST_NOTE_PREFIX} live API`,
    code: "NET_01"
  };

  const objBrowserProblem = {
    problem: `${BROWSER_CHECK_NOTE_PREFIX} operator must verify canvas render`,
    file: "canvas.tsx"
  };
  const objBrowserFinding = {
    finding: "BROWSER CHECK NOT POSSIBLE: check print layout",
    area: "print"
  };
  const objBrowserText = {
    text: `${BROWSER_CHECK_NOTE_PREFIX} check drag and drop`,
    target: "dnd"
  };
  const objBrowserSummary = {
    summary: `${BROWSER_CHECK_NOTE_PREFIX} check touch gestures`,
    device: "tablet"
  };
  const objBrowserMessage = {
    message: `${BROWSER_CHECK_NOTE_PREFIX} check webgl context`,
    component: "3d-view"
  };

  const regularObj1 = {
    file: "dialog.tsx",
    line: 12,
    message: "Missing aria-label on close button"
  };
  const regularObj2 = {
    problem: "Memory leak in event listener",
    fix: "Add removeEventListener in cleanup"
  };

  // Case 1.1: Mixed string findings
  {
    const review = {
      decision: "FAIL",
      findings: [regularStr1, networkStr, browserStr, regularStr2, networkLower, browserLower]
    };
    const { moved } = moveManualCheckFindings(review);
    check(
      "moveManualCheckFindings moves string findings with network and browser prefixes",
      moved.length === 4 &&
        moved.includes(networkStr) &&
        moved.includes(browserStr) &&
        moved.includes(networkLower) &&
        moved.includes(browserLower)
    );
    check(
      "moveManualCheckFindings leaves only regular findings in review.findings",
      review.findings.length === 2 &&
        review.findings[0] === regularStr1 &&
        review.findings[1] === regularStr2
    );
  }

  // Case 1.2: Object findings with prefixes across various fields
  {
    const review = {
      decision: "FAIL",
      findings: [
        regularObj1,
        objNetworkProblem,
        objBrowserProblem,
        objNetworkFinding,
        objBrowserFinding,
        objNetworkText,
        objBrowserText,
        objNetworkSummary,
        objBrowserSummary,
        objNetworkMessage,
        objBrowserMessage,
        regularObj2
      ]
    };
    const { moved } = moveManualCheckFindings(review);
    check(
      "moveManualCheckFindings moves object findings with prefixes in problem/finding/text/summary/message",
      moved.length === 10 &&
        moved.includes(objNetworkProblem) &&
        moved.includes(objBrowserProblem) &&
        moved.includes(objNetworkFinding) &&
        moved.includes(objBrowserFinding) &&
        moved.includes(objNetworkText) &&
        moved.includes(objBrowserText) &&
        moved.includes(objNetworkSummary) &&
        moved.includes(objBrowserSummary) &&
        moved.includes(objNetworkMessage) &&
        moved.includes(objBrowserMessage)
    );
    check(
      "moveManualCheckFindings preserves regular object findings in review.findings",
      review.findings.length === 2 &&
        review.findings[0] === regularObj1 &&
        review.findings[1] === regularObj2
    );
  }

  // Case 1.3: Nothing moved when only regular findings are present
  {
    const review = {
      decision: "FAIL",
      findings: [regularStr1, regularObj1, regularStr2, regularObj2]
    };
    const { moved } = moveManualCheckFindings(review);
    check(
      "moveManualCheckFindings moves nothing when no prefixed findings exist",
      moved.length === 0 && review.findings.length === 4
    );
  }

  // Case 1.4: Empty and edge inputs
  {
    const rNull = moveManualCheckFindings(null);
    check("moveManualCheckFindings handles null", Array.isArray(rNull.moved) && rNull.moved.length === 0);

    const rUndef = moveManualCheckFindings(undefined);
    check("moveManualCheckFindings handles undefined", Array.isArray(rUndef.moved) && rUndef.moved.length === 0);

    const rEmptyObj = moveManualCheckFindings({});
    check("moveManualCheckFindings handles empty object", Array.isArray(rEmptyObj.moved) && rEmptyObj.moved.length === 0);

    const rEmptyFindings = moveManualCheckFindings({ findings: [] });
    check(
      "moveManualCheckFindings handles empty findings array",
      Array.isArray(rEmptyFindings.moved) && rEmptyFindings.moved.length === 0
    );

    const bareArray = [networkStr, regularStr1];
    const rBare = moveManualCheckFindings(bareArray);
    check(
      "moveManualCheckFindings handles bare array input and mutates it",
      rBare.moved.length === 1 && rBare.moved[0] === networkStr && bareArray.length === 1 && bareArray[0] === regularStr1
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 2. verifierVerdictAfterManualMove pure function tests
// ─────────────────────────────────────────────────────────────
{
  check(
    "verifierVerdictAfterManualMove turns FAIL to PASS when remaining=0, gateOk=true, evidenceOk=true",
    verifierVerdictAfterManualMove({ decision: "FAIL", remaining: [], gateOk: true, evidenceOk: true }) === "PASS"
  );

  check(
    "verifierVerdictAfterManualMove turns FAIL to PASS when remaining is number 0",
    verifierVerdictAfterManualMove({ decision: "FAIL", remaining: 0, gateOk: true, evidenceOk: true }) === "PASS"
  );

  check(
    "verifierVerdictAfterManualMove keeps FAIL when remaining findings > 0",
    verifierVerdictAfterManualMove({ decision: "FAIL", remaining: ["real finding"], gateOk: true, evidenceOk: true }) === "FAIL"
  );

  check(
    "verifierVerdictAfterManualMove keeps FAIL when remaining count > 0",
    verifierVerdictAfterManualMove({ decision: "FAIL", remaining: 2, gateOk: true, evidenceOk: true }) === "FAIL"
  );

  check(
    "verifierVerdictAfterManualMove keeps FAIL when gate failed (gateOk=false)",
    verifierVerdictAfterManualMove({ decision: "FAIL", remaining: [], gateOk: false, evidenceOk: true }) === "FAIL"
  );

  check(
    "verifierVerdictAfterManualMove keeps FAIL when evidence check refused PASS (evidenceOk=false)",
    verifierVerdictAfterManualMove({ decision: "FAIL", remaining: [], gateOk: true, evidenceOk: false }) === "FAIL"
  );

  check(
    "verifierVerdictAfterManualMove keeps FAIL when both gate and evidence failed",
    verifierVerdictAfterManualMove({ decision: "FAIL", remaining: [], gateOk: false, evidenceOk: false }) === "FAIL"
  );

  check(
    "verifierVerdictAfterManualMove preserves PASS verdict",
    verifierVerdictAfterManualMove({ decision: "PASS", remaining: [], gateOk: true, evidenceOk: true }) === "PASS"
  );

  check(
    "verifierVerdictAfterManualMove preserves INCOMPLETE verdict",
    verifierVerdictAfterManualMove({ decision: "INCOMPLETE", remaining: [], gateOk: true, evidenceOk: true }) === "INCOMPLETE"
  );
}

// ─────────────────────────────────────────────────────────────
// 3. Behavioral fixtures: verifier FAIL handling with appendManualChecks & de-duplication
// ─────────────────────────────────────────────────────────────
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-manual-checks-test-"));
  const manualChecksFile = path.join(tempDir, "MANUAL-CHECKS.md");

  try {
    const networkFinding = `${NETWORK_TEST_NOTE_PREFIX} An operator must execute the documented staging rehearsal`;
    const browserFinding = `${BROWSER_CHECK_NOTE_PREFIX} An operator must test checkout in mobile browser`;
    const realFinding = "OrdersTab.test.tsx: failed assertion on line 88";

    // Fixture 1: Verifier FAIL with 1 real finding + 1 network finding -> network moved, stays FAIL
    {
      const s = { phaseIndex: 12, recordedManualCheckNotes: {} };
      const review = {
        decision: "FAIL",
        findings: [realFinding, networkFinding]
      };
      const gateOk = true;
      const evidenceOk = true;

      const { moved } = moveManualCheckFindings(review);
      check("fixture 1: network finding moved", moved.length === 1 && moved[0] === networkFinding);
      check("fixture 1: real finding remaining in findings", review.findings.length === 1 && review.findings[0] === realFinding);

      const fresh = filterUnrecordedManualChecks(s, "Phase 13", moved);
      check("fixture 1: fresh notes detected for phase", fresh.length === 1);
      appendManualChecks(tempDir, { phaseName: "Phase 13", notes: fresh, at: "2026-11-08T12:00:00.000Z" });

      review.decision = verifierVerdictAfterManualMove({
        decision: review.decision,
        remaining: review.findings,
        gateOk,
        evidenceOk
      });

      check("fixture 1: decision remains FAIL because real finding is left", review.decision === "FAIL");
      check("fixture 1: MANUAL-CHECKS.md created", fs.existsSync(manualChecksFile));
      const content1 = fs.readFileSync(manualChecksFile, "utf8");
      check("fixture 1: MANUAL-CHECKS.md contains network finding", content1.includes(networkFinding));
      check("fixture 1: MANUAL-CHECKS.md does NOT contain real finding", !content1.includes(realFinding));
    }

    // Fixture 2: Verifier FAIL holding only a network finding -> moved, flips to PASS when gateOk & evidenceOk
    {
      const s = { phaseIndex: 13, recordedManualCheckNotes: {} };
      const review = {
        decision: "FAIL",
        findings: [`${NETWORK_TEST_NOTE_PREFIX} npm run seed:pilot`]
      };
      const gateOk = true;
      const evidenceOk = true;

      const { moved } = moveManualCheckFindings(review);
      check("fixture 2: network finding moved", moved.length === 1);
      check("fixture 2: findings emptied", review.findings.length === 0);

      const fresh = filterUnrecordedManualChecks(s, "Phase 14", moved);
      appendManualChecks(tempDir, { phaseName: "Phase 14", notes: fresh, at: "2026-11-08T12:01:00.000Z" });

      review.decision = verifierVerdictAfterManualMove({
        decision: review.decision,
        remaining: review.findings,
        gateOk,
        evidenceOk
      });

      check("fixture 2: decision flipped from FAIL to PASS", review.decision === "PASS");
      const content2 = fs.readFileSync(manualChecksFile, "utf8");
      check("fixture 2: MANUAL-CHECKS.md contains seed:pilot note", content2.includes("npm run seed:pilot"));
    }

    // Fixture 3: Verifier FAIL holding only network finding, but gate failed -> stays FAIL
    {
      const s = { phaseIndex: 14, recordedManualCheckNotes: {} };
      const review = {
        decision: "FAIL",
        findings: [networkFinding]
      };
      const gateOk = false; // red gate
      const evidenceOk = true;

      const { moved } = moveManualCheckFindings(review);
      review.decision = verifierVerdictAfterManualMove({
        decision: review.decision,
        remaining: review.findings,
        gateOk,
        evidenceOk
      });

      check("fixture 3: decision stays FAIL when gate failed even with 0 remaining findings", review.decision === "FAIL");
    }

    // Fixture 4: Verifier FAIL holding only network finding, but tool evidence check refused PASS -> stays FAIL
    {
      const s = { phaseIndex: 15, recordedManualCheckNotes: {} };
      const review = {
        decision: "FAIL",
        findings: [networkFinding]
      };
      const gateOk = true;
      const evidenceOk = false; // linked verify/tool result failed

      const { moved } = moveManualCheckFindings(review);
      review.decision = verifierVerdictAfterManualMove({
        decision: review.decision,
        remaining: review.findings,
        gateOk,
        evidenceOk
      });

      check("fixture 4: decision stays FAIL when tool evidence refused PASS", review.decision === "FAIL");
    }

    // Fixture 5: De-duplication against notes already recorded for the same phase in this run
    {
      const s = { phaseIndex: 16, recordedManualCheckNotes: {} };
      const reviewA = {
        decision: "FAIL",
        findings: [networkFinding]
      };
      const { moved: movedA } = moveManualCheckFindings(reviewA);
      const freshA = filterUnrecordedManualChecks(s, "Phase 17", movedA);
      check("fixture 5: first run finds 1 fresh note", freshA.length === 1);
      appendManualChecks(tempDir, { phaseName: "Phase 17", notes: freshA, at: "2026-11-08T12:05:00.000Z" });

      // Second check in the same run/phase (e.g. PASS path browserCheckNotes/networkCheckNotes, or second verifier call)
      const reviewB = {
        decision: "PASS",
        notes: [networkFinding, browserFinding]
      };
      const extractedNotes = networkCheckNotes(reviewB);
      const freshB = filterUnrecordedManualChecks(s, "Phase 17", extractedNotes);
      check("fixture 5: second run de-duplicates already recorded networkFinding", freshB.length === 0);

      // Now pass a new note for the same phase
      const extractedBrowser = browserCheckNotes(reviewB);
      const freshC = filterUnrecordedManualChecks(s, "Phase 17", extractedBrowser);
      check("fixture 5: new browser finding is not de-duplicated", freshC.length === 1 && freshC[0] === browserFinding);
      appendManualChecks(tempDir, { phaseName: "Phase 17", notes: freshC, at: "2026-11-08T12:06:00.000Z" });

      // Count occurrences of networkFinding in Phase 17 section
      const content5 = fs.readFileSync(manualChecksFile, "utf8");
      const phase17Idx = content5.indexOf("## Phase 17 (2026-11-08T12:05:00.000Z)");
      const phase17Content = content5.slice(phase17Idx);
      const matches = phase17Content.match(/documented staging rehearsal/g) || [];
      check("fixture 5: documented staging rehearsal appears exactly once in Phase 17", matches.length === 1);
    }

    // Fixture 6: Object finding extraction preserves clean text without [object Object]
    {
      const s = { phaseIndex: 18, recordedManualCheckNotes: {} };
      const objFinding = {
        problem: `${BROWSER_CHECK_NOTE_PREFIX} check datepicker keyboard navigation`,
        selector: "#datepicker"
      };
      const review = {
        decision: "FAIL",
        findings: [objFinding]
      };
      const { moved } = moveManualCheckFindings(review);
      const fresh = filterUnrecordedManualChecks(s, "Phase 19", moved);
      appendManualChecks(tempDir, { phaseName: "Phase 19", notes: fresh, at: "2026-11-08T12:10:00.000Z" });

      const content6 = fs.readFileSync(manualChecksFile, "utf8");
      check(
        "fixture 6: object finding written with extracted text, not [object Object]",
        content6.includes("- BROWSER CHECK NOT POSSIBLE: check datepicker keyboard navigation") &&
          !content6.includes("[object Object]")
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────
// 4. Source checks in autopilot.mjs
// ─────────────────────────────────────────────────────────────
{
  check(
    "autopilot.mjs imports moveManualCheckFindings, verifierVerdictAfterManualMove, filterUnrecordedManualChecks",
    autopilotSrc.includes("moveManualCheckFindings") &&
      autopilotSrc.includes("verifierVerdictAfterManualMove") &&
      autopilotSrc.includes("filterUnrecordedManualChecks")
  );

  // Standalone verifier section inspection
  const standaloneMatch = autopilotSrc.match(/const vv=await relayAsync\("verifier",[\s\S]*?recordPhaseFindingTasks\(phaseKey/);
  check("standalone verifier block located", Boolean(standaloneMatch));
  if (standaloneMatch) {
    const block = standaloneMatch[0];
    const moveIdx = block.indexOf("moveManualCheckFindings(vv.review)");
    const appendIdx = block.indexOf("appendManualChecks(");
    const verdictHelperIdx = block.indexOf("verifierVerdictAfterManualMove(");
    const passDecisionIdx = block.indexOf('vv.review?.decision==="PASS"');

    check("standalone verifier block calls moveManualCheckFindings(vv.review)", moveIdx !== -1);
    check("standalone verifier block calls appendManualChecks", appendIdx !== -1);
    check("standalone verifier block calls verifierVerdictAfterManualMove", verdictHelperIdx !== -1);
    check(
      "standalone verifier calls moveManualCheckFindings before decision is tested",
      moveIdx !== -1 && passDecisionIdx !== -1 && moveIdx < passDecisionIdx
    );
    check(
      "standalone verifier logs expected message",
      block.includes("Manual check recorded in MANUAL-CHECKS.md") &&
        block.includes("not counted as a verifier finding")
    );
  }

  // SpecKit verifier section inspection
  const speckitMatch = autopilotSrc.match(/const vv=await relayAsync\("verifier",[\s\S]*?speckitPhaseFeedbackKey\(s\.phaseIndex\)/);
  check("speckit verifier block located", Boolean(speckitMatch));
  if (speckitMatch) {
    const block = speckitMatch[0];
    const moveIdx = block.indexOf("moveManualCheckFindings(vv.review)");
    const appendIdx = block.indexOf("appendManualChecks(");
    const verdictHelperIdx = block.indexOf("verifierVerdictAfterManualMove(");
    const passDecisionIdx = block.indexOf('vv.review?.decision==="PASS"');

    check("speckit verifier block calls moveManualCheckFindings(vv.review)", moveIdx !== -1);
    check("speckit verifier block calls appendManualChecks", appendIdx !== -1);
    check("speckit verifier block calls verifierVerdictAfterManualMove", verdictHelperIdx !== -1);
    check(
      "speckit verifier calls moveManualCheckFindings before decision is tested",
      moveIdx !== -1 && passDecisionIdx !== -1 && moveIdx < passDecisionIdx
    );
    check(
      "speckit verifier logs expected message",
      block.includes("Manual check recorded in MANUAL-CHECKS.md") &&
        block.includes("not counted as a verifier finding")
    );
  }

  // Verify that PASS path calls browserCheckNotes(vv.review) and networkCheckNotes(vv.review) twice across autopilot.mjs
  const browserCheckCalls = autopilotSrc.match(/browserCheckNotes\(vv\.review\)/g) || [];
  const networkCheckCalls = autopilotSrc.match(/networkCheckNotes\(vv\.review\)/g) || [];
  check(
    "autopilot.mjs calls browserCheckNotes(vv.review) exactly twice (one per loop)",
    browserCheckCalls.length === 2
  );
  check(
    "autopilot.mjs calls networkCheckNotes(vv.review) exactly twice (one per loop)",
    networkCheckCalls.length === 2
  );

  // Verify that MISSION_SCOPED_STATE_KEYS includes recordedManualCheckNotes
  check(
    "MISSION_SCOPED_STATE_KEYS includes recordedManualCheckNotes",
    /MISSION_SCOPED_STATE_KEYS[\s\S]*?"recordedManualCheckNotes"/.test(autopilotSrc)
  );
}

// ─────────────────────────────────────────────────────────────
// Result summary
// ─────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll verifier manual check findings tests passed!");
}
