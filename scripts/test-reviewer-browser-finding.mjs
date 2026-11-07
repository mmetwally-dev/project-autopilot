import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROWSER_CHECK_NOTE_PREFIX,
  CODE_REVIEWER_BROWSER_LINE,
  isBrowserCheckFinding,
  splitBrowserFindings
} from "./task-requirements.mjs";
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
// 1. isBrowserCheckFinding unit tests
// ─────────────────────────────────────────────────────────────
{
  const clinixHubText =
    "Settings services page, ServiceFormDialog, DeactivateServiceDialog, OrdersTab: Still not checked in a real browser: there is no approved browser or Playwright command, and the dev server needs a database and network access.";
  check(
    "isBrowserCheckFinding true for exact real-app text",
    isBrowserCheckFinding(clinixHubText) === true
  );

  const prefixedNote = `${BROWSER_CHECK_NOTE_PREFIX} check manual checkout workflows`;
  check(
    "isBrowserCheckFinding true for prefixed note",
    isBrowserCheckFinding(prefixedNote) === true
  );

  const prefixedNoteLower = "  browser check not possible: check settings page  ";
  check(
    "isBrowserCheckFinding true for lowercase trimmed prefixed note",
    isBrowserCheckFinding(prefixedNoteLower) === true
  );

  check(
    "isBrowserCheckFinding true for 'not verified in a browser'",
    isBrowserCheckFinding("This change has not been verified in a browser") === true
  );

  check(
    "isBrowserCheckFinding true for 'no approved browser or playwright command'",
    isBrowserCheckFinding("there is no approved browser or playwright command") === true
  );

  check(
    "isBrowserCheckFinding true for 'no approved browser command'",
    isBrowserCheckFinding("Error: no approved browser command available") === true
  );

  const nonBrowserFinding =
    "ServiceFormDialog.test.tsx: Both tests pass even without the focus-restore code";
  check(
    "isBrowserCheckFinding false for non-browser finding",
    isBrowserCheckFinding(nonBrowserFinding) === false
  );

  check(
    "isBrowserCheckFinding false for empty string",
    isBrowserCheckFinding("") === false
  );

  check(
    "isBrowserCheckFinding false for non-string",
    isBrowserCheckFinding(null) === false && isBrowserCheckFinding(123) === false
  );
}

// ─────────────────────────────────────────────────────────────
// 2. splitBrowserFindings unit tests
// ─────────────────────────────────────────────────────────────
{
  const clinixHubText =
    "Settings services page, ServiceFormDialog, DeactivateServiceDialog, OrdersTab: Still not checked in a real browser: there is no approved browser or Playwright command, and the dev server needs a database and network access.";
  const regularFinding1 =
    "ServiceFormDialog.test.tsx: Both tests pass even without the focus-restore code";
  const prefixedNote = `${BROWSER_CHECK_NOTE_PREFIX} verify form focus`;
  const regularObjFinding = { file: "dialog.tsx", line: 42, message: "Missing aria-label" };
  const browserObjFinding = { file: "page.tsx", message: "Component has not been tested in a real browser" };

  const mixedReview = {
    decision: "FAIL",
    findings: [
      regularFinding1,
      clinixHubText,
      regularObjFinding,
      prefixedNote,
      browserObjFinding
    ]
  };

  const { browser, rest } = splitBrowserFindings(mixedReview);

  check(
    "splitBrowserFindings splits mixed findings into correct counts",
    browser.length === 3 && rest.length === 2,
    `got browser=${browser.length}, rest=${rest.length}`
  );

  check(
    "splitBrowserFindings isolates browser findings",
    browser[0] === clinixHubText &&
      browser[1] === prefixedNote &&
      browser[2] === browserObjFinding
  );

  check(
    "splitBrowserFindings preserves non-browser findings in rest",
    rest[0] === regularFinding1 && rest[1] === regularObjFinding
  );

  // Direct array input
  const fromArray = splitBrowserFindings([clinixHubText, regularFinding1]);
  check(
    "splitBrowserFindings accepts bare array of findings",
    fromArray.browser.length === 1 && fromArray.rest.length === 1
  );

  // All browser findings
  const allBrowser = splitBrowserFindings({
    findings: [clinixHubText, prefixedNote]
  });
  check(
    "splitBrowserFindings handles all browser findings (rest empty)",
    allBrowser.browser.length === 2 && allBrowser.rest.length === 0
  );

  // No browser findings
  const noBrowser = splitBrowserFindings({
    findings: [regularFinding1]
  });
  check(
    "splitBrowserFindings handles zero browser findings (browser empty)",
    noBrowser.browser.length === 0 && noBrowser.rest.length === 1
  );
}

// ─────────────────────────────────────────────────────────────
// 3. Source checks: autopilot.mjs prompts and review() body
// ─────────────────────────────────────────────────────────────
{
  const autopilotPath = path.join(here, "autopilot.mjs");
  const autopilotSrc = fs.readFileSync(autopilotPath, "utf8");

  // Check CODE_REVIEWER_BROWSER_LINE export
  check(
    "CODE_REVIEWER_BROWSER_LINE exported and contains BROWSER_CHECK_NOTE_PREFIX",
    typeof CODE_REVIEWER_BROWSER_LINE === "string" &&
      CODE_REVIEWER_BROWSER_LINE.includes(BROWSER_CHECK_NOTE_PREFIX) &&
      CODE_REVIEWER_BROWSER_LINE.includes("Browser checks are the verifier's job")
  );

  // Check imports in autopilot.mjs
  check(
    "autopilot.mjs imports CODE_REVIEWER_BROWSER_LINE",
    autopilotSrc.includes("CODE_REVIEWER_BROWSER_LINE")
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

  // Standalone phase review prompt check
  const standalonePrompt = extractReviewPromptTemplate(autopilotSrc, "tasksFilePathForReview");
  check(
    "standalone phase review prompt includes CODE_REVIEWER_BROWSER_LINE",
    Boolean(standalonePrompt && standalonePrompt.includes("CODE_REVIEWER_BROWSER_LINE"))
  );
  check(
    "standalone phase review prompt places CODE_REVIEWER_BROWSER_LINE right after CODE_REVIEWER_TARGETED_TESTS_LINE",
    Boolean(
      standalonePrompt &&
        standalonePrompt.includes("${CODE_REVIEWER_TARGETED_TESTS_LINE}\\n\\n${CODE_REVIEWER_BROWSER_LINE}")
    )
  );

  // SpecKit phase review prompt check
  const speckitPrompt = extractReviewPromptTemplate(autopilotSrc, "reviewTaskRef(s,speckitPhaseFeedbackKey");
  check(
    "speckit phase review prompt includes CODE_REVIEWER_BROWSER_LINE",
    Boolean(speckitPrompt && speckitPrompt.includes("CODE_REVIEWER_BROWSER_LINE"))
  );
  check(
    "speckit phase review prompt places CODE_REVIEWER_BROWSER_LINE right after CODE_REVIEWER_TARGETED_TESTS_LINE",
    Boolean(
      speckitPrompt &&
        speckitPrompt.includes("${CODE_REVIEWER_TARGETED_TESTS_LINE}\\n\\n${CODE_REVIEWER_BROWSER_LINE}")
    )
  );

  // Extract whole review() function body
  const reviewFnStart = autopilotSrc.indexOf("function review(reviewer,task,c,s,");
  check("review() function found in autopilot.mjs", reviewFnStart !== -1);

  const nextFnStart = autopilotSrc.indexOf("function planningScopeParts(", reviewFnStart);
  check("next function boundary after review() found", nextFnStart !== -1);

  const reviewFnBody = autopilotSrc.slice(reviewFnStart, nextFnStart);

  check(
    "review() calls splitBrowserFindings (or isBrowserCheckFinding)",
    reviewFnBody.includes("splitBrowserFindings") || reviewFnBody.includes("isBrowserCheckFinding")
  );

  check(
    "review() calls appendManualChecks",
    reviewFnBody.includes("appendManualChecks(")
  );

  check(
    "review() can flip FAIL to PASS",
    reviewFnBody.includes('result.review.decision = "PASS"') ||
      reviewFnBody.includes("result.review.decision='PASS'") ||
      reviewFnBody.includes('result.review.decision="PASS"')
  );

  check(
    "review() logs manual UI check recorded message",
    reviewFnBody.includes("Manual UI check recorded in MANUAL-CHECKS.md") &&
      reviewFnBody.includes("not counted as a review finding")
  );

  check(
    "review() browser finding handling is wrapped in try/catch",
    /try\s*\{[\s\S]*?appendManualChecks[\s\S]*?\}\s*catch/.test(reviewFnBody)
  );
}

// ─────────────────────────────────────────────────────────────
// 4. End-to-end simulation of review() decision flipping & MANUAL-CHECKS.md
// ─────────────────────────────────────────────────────────────
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-browser-test-"));
  try {
    const clinixHubText =
      "Settings services page, ServiceFormDialog, DeactivateServiceDialog, OrdersTab: Still not checked in a real browser: there is no approved browser or Playwright command, and the dev server needs a database and network access.";
    const regularFinding =
      "ServiceFormDialog.test.tsx: Both tests pass even without the focus-restore code";

    // Scenario A: Review returned FAIL with ONLY browser check finding -> should flip to PASS
    {
      const resultA = {
        status: "completed",
        review: {
          decision: "FAIL",
          findings: [clinixHubText]
        }
      };

      const { browser, rest } = splitBrowserFindings(resultA.review);
      check("scenario A: browser findings detected", browser.length === 1);
      if (browser.length) {
        appendManualChecks(tempDir, {
          phaseName: "phase-9",
          notes: browser,
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
      check("scenario A: MANUAL-CHECKS.md contains clinixHubText", contentA.includes(clinixHubText));
    }

    // Scenario B: Review returned FAIL with mixed findings -> remains FAIL, findings has rest
    {
      const resultB = {
        status: "completed",
        review: {
          decision: "FAIL",
          findings: [regularFinding, clinixHubText]
        }
      };

      const { browser, rest } = splitBrowserFindings(resultB.review);
      if (browser.length) {
        appendManualChecks(tempDir, {
          phaseName: "phase-9",
          notes: browser,
          at: new Date().toISOString()
        });
        resultB.review.findings = rest;
        if (rest.length === 0) {
          resultB.review.decision = "PASS";
        }
      }

      check("scenario B: decision remains FAIL", resultB.review.decision === "FAIL");
      check("scenario B: findings contains only rest", resultB.review.findings.length === 1 && resultB.review.findings[0] === regularFinding);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll reviewer browser finding tests passed!");
  process.exit(0);
}
