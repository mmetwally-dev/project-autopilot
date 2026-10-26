import assert from "node:assert/strict";
import {PLAN_REVISION_DEFAULT, resolvePlanRevisionBudget} from "./plan-revision-budget.mjs";

assert.equal(PLAN_REVISION_DEFAULT, 8);
assert.equal(resolvePlanRevisionBudget({max_plan_revisions: 0}), 0);
assert.equal(resolvePlanRevisionBudget({max_plan_revisions: "0"}), 0);
assert.equal(resolvePlanRevisionBudget({max_plan_revisions: 3}), 3);
assert.equal(resolvePlanRevisionBudget({}), PLAN_REVISION_DEFAULT);
assert.equal(resolvePlanRevisionBudget({max_plan_revisions: NaN}), PLAN_REVISION_DEFAULT);
assert.equal(resolvePlanRevisionBudget({max_plan_revisions: -1}), PLAN_REVISION_DEFAULT);
assert.equal(resolvePlanRevisionBudget({max_plan_revisions: null}), PLAN_REVISION_DEFAULT);
assert.equal(resolvePlanRevisionBudget({max_plan_revisions: ""}), PLAN_REVISION_DEFAULT);
assert.equal(resolvePlanRevisionBudget({max_plan_revisions: " "}), PLAN_REVISION_DEFAULT);
assert.equal(resolvePlanRevisionBudget({max_plan_revisions: true}), PLAN_REVISION_DEFAULT);
assert.equal(resolvePlanRevisionBudget({max_plan_revisions: false}), PLAN_REVISION_DEFAULT);

console.log("plan revision budget zero-aware resolution PASS");
