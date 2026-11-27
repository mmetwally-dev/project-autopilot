import assert from "node:assert/strict";
import { highUsageText, renderFinalReviewStage } from "./watch-report.mjs";

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, detail);
  }
}

const model = {
  status: "IN_PROGRESS",
  missionStartedAt: "2026-11-22T07:00:00Z",
  policy: {
    final_review_fix_rounds: 2,
    caps: {
      code_reviewer: { max_tokens: 250000, max_turns: 20 },
      implementer: { max_tokens: 300000, max_turns: 30 },
    },
  },
  tasks: [{ id: "T001" }, { id: "T182" }],
  finalReview: {
    status: "in_progress",
    runs: [
      {
        id: "410",
        role: "code_reviewer",
        phase: "final_review",
        taskRef: "final-review-speckit",
        model: "claude-opus-4-6",
        status: "capped",
        startedAt: "2026-11-22T08:00:00Z",
        endedAt: "2026-11-22T08:02:00Z",
        usage: { priceWeighted: 846200, turns: 41, maxSingleTurnContext: 184000 },
      },
    ],
    rounds: [
      {
        number: 1,
        runs: [
          {
            id: "410",
            role: "code_reviewer",
            phase: "final_review",
            taskRef: "final-review-speckit",
            model: "claude-opus-4-6",
            status: "capped",
            startedAt: "2026-11-22T08:00:00Z",
            endedAt: "2026-11-22T08:02:00Z",
            usage: { priceWeighted: 846200, turns: 41, maxSingleTurnContext: 184000 },
          },
        ],
      },
    ],
  },
};

// 1. Final review run via noteHint="final review" -> turn-capped label, NOT "of 250K cap"
const frLabel = highUsageText(model.finalReview.runs[0], model, { noteHint: "final review" });
check("final review highUsageText uses turn-capped label",
  frLabel === "⚠ high usage (846.2K; final review is turn-capped)", frLabel);

// 2. Final review run detected by taskRef="final-review-speckit" even without noteHint
const frByRef = highUsageText(
  { role: "code_reviewer", taskRef: "final-review-speckit", usage: { priceWeighted: 846200 } },
  model,
);
check("final review highUsageText detected by taskRef uses turn-capped label",
  frByRef === "⚠ high usage (846.2K; final review is turn-capped)", frByRef);

// 3. Regular phase code_reviewer run STILL shows "of 250K cap"
const phaseRevLabel = highUsageText(
  { role: "code_reviewer", taskRef: "T042", phase: "implementation", usage: { priceWeighted: 200000 } },
  model,
);
check("regular phase code_reviewer keeps token cap label",
  phaseRevLabel === "⚠ high usage (200K of 250K cap)", phaseRevLabel);

// 4. Final review fix-round implementer STILL shows implementer token cap label
const fixImplLabel = highUsageText(
  { role: "implementer", taskRef: "final-fix-speckit-round-1", phase: "final_review", usage: { priceWeighted: 240000 } },
  model,
  { noteHint: "final review" },
);
check("final-review fix-round implementer keeps token cap label",
  fixImplLabel === "⚠ high usage (240K of 300K cap)", fixImplLabel);

// 5. Low-usage final review run (< 70% of reference threshold) emits no warning
const lowFrLabel = highUsageText(
  { role: "code_reviewer", taskRef: "final-review-speckit", usage: { priceWeighted: 100000 } },
  model,
  { noteHint: "final review" },
);
check("low-usage final review run emits no high-usage warning", lowFrLabel === null, lowFrLabel);

// 6. Rendered FINAL REVIEW STAGE table contains the real turn-capped label and not "of 250K cap"
const rendered = renderFinalReviewStage(model);
check("rendered FINAL REVIEW STAGE shows turn-capped label",
  rendered.includes("⚠ high usage (846.2K; final review is turn-capped)") && !rendered.includes("of 250K cap"),
  rendered);

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} check(s) failed`);
