#!/usr/bin/env node
// Zero-aware watch report: a configured 0 is shown as the limit, not replaced
// by the default, and the continuation allowance counts a 0 (one session).
import {
  buildBudgetEntries,
  buildReportModel,
  renderImplementationStage,
} from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });
const limits = (policy, state = {}, layout = null) =>
  buildBudgetEntries(state, policy, layout).map((e) => e.limit);

// ── legacy failure_budgets: an explicit 0 is a configured limit ─────────────
{
  const zero = {
    implementationFailureBudget: 0,
    verificationFailureBudget: 0,
    adapterRetryBudget: 0,
    infrastructureRetryBudget: 0,
  };
  check("legacy 0: all four budgets report 0", JSON.stringify(limits({ failure_budgets: zero })) === JSON.stringify([0, 0, 0, 0]), limits({ failure_budgets: zero }));
  check("absent: defaults stay 4/4/3/3", JSON.stringify(limits({})) === JSON.stringify([4, 4, 3, 3]), limits({}));
  check("absent policy: defaults stay 4/4/3/3", JSON.stringify(limits(null)) === JSON.stringify([4, 4, 3, 3]), limits(null));
  const nulls = {
    implementationFailureBudget: null,
    verificationFailureBudget: null,
    adapterRetryBudget: null,
    infrastructureRetryBudget: null,
  };
  check("legacy null: defaults stay 4/4/3/3 (null is absent, not 0)",
    JSON.stringify(limits({ failure_budgets: nulls })) === JSON.stringify([4, 4, 3, 3]), limits({ failure_budgets: nulls }));
  const blanks = {
    implementationFailureBudget: "",
    verificationFailureBudget: "  ",
    adapterRetryBudget: "",
    infrastructureRetryBudget: " ",
  };
  check("legacy blank: defaults stay 4/4/3/3 (blank is absent, not 0)",
    JSON.stringify(limits({ failure_budgets: blanks })) === JSON.stringify([4, 4, 3, 3]), limits({ failure_budgets: blanks }));
}

// ── continuation_allowance: 0 still labels the session range ────────────────
{
  const phases = [{ number: 1, name: "Phase 1 — Work", done: false, tasks: [{ text: "T1.1", done: true }] }];
  const model = (policy) => buildReportModel({
    state: { phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1, planningDetection: { framework: "standalone" } },
    runs: [run({ id: "01-implementer-a", dirName: "01-implementer-a", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", sessionNumber: 1, started_at: "2026-10-19T10:00:00+00:00" })],
    events: [],
    phases,
    policy,
    now: "2026-10-19T10:20:00+00:00",
  });

  const zero = model({ continuation_allowance: 0 });
  check("allowance 0: session label is 'session 1 of 1'", zero.runs[0].sessionLabel === "session 1 of 1", zero.runs[0].sessionLabel);
  check("allowance 0: rendered row uses 'session 1 of 1'", renderImplementationStage(zero).includes("session 1 of 1"), renderImplementationStage(zero));

  const absent = model({});
  check("allowance absent: session label is 'session 1'", absent.runs[0].sessionLabel === "session 1", absent.runs[0].sessionLabel);

  const nulled = model({ continuation_allowance: null });
  check("allowance null: session label is 'session 1' (null is absent, not 0)",
    nulled.runs[0].sessionLabel === "session 1", nulled.runs[0].sessionLabel);
  const blank = model({ continuation_allowance: "  " });
  check("allowance blank: session label is 'session 1' (blank is absent, not 0)",
    blank.runs[0].sessionLabel === "session 1", blank.runs[0].sessionLabel);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll budget-zero watch-report checks passed.");
