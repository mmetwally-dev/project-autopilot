#!/usr/bin/env node
// Task-TEXT full-suite scan (verify-denylist.mjs): a task that tells the
// implementer to run the whole suite or the gate commands is flagged even when
// its verify is file-scoped.
import {taskTextFullSuiteFindings, speckitTaskTextFullSuiteFindings, fullSuiteTaskEntries} from "./verify-denylist.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const c = {gates: {commands: ["npm run lint", "node scripts/gate.mjs"]}};
const entries = fullSuiteTaskEntries(c);
check("entries: test-all.mjs + gates", entries.join("|") === "test-all.mjs|npm run lint|node scripts/gate.mjs", entries);

const T075 = "- [ ] T075 Final verification (SC-006): create `docs/operations/sync-verification-report.md` recording the results (pass/fail, counts, date) of the complete offline regression gate `npm run test` (covers all suites …), `npm run type-check` and `npm run lint`; test `tests/unit/sync-verification-report.test.ts` asserts the report names all three commands and has a result line for each. verify: `npx vitest run tests/unit/sync-verification-report.test.ts`";
const text = (line) => line.split(/;\s*verify:|\.\s*verify:/)[0];

{
  const f = speckitTaskTextFullSuiteFindings(`## Phase 9\n${T075}\n`, entries);
  check("speckit: T075 flagged for npm run test and gate lint", f.length === 2 && f.some((x) => x.problem.includes('"npm run test"')) && f.some((x) => x.problem.includes('"npm run lint"')), f);
  check("speckit: finding carries heading and correction", f[0].location.includes("Phase 9") && f[0].correction.includes("after code review"), f[0]);
  const standalone = taskTextFullSuiteFindings([{taskLabel: "9.1", text: text(T075.replace("verify:", "; verify:"))}], entries);
  check("standalone: T075-shaped text flagged", standalone.length >= 1 && standalone[0].location === "TASKS.md 9.1", standalone);
}

const flagged = (t, ents = entries) => taskTextFullSuiteFindings([{taskLabel: "x", text: t}], ents).length;
check("file-scoped vitest not flagged", flagged("Add tests; run `npx vitest run tests/unit/x.test.ts` to check") === 0);
check("vitest with path-like arg and trailing prose not flagged", flagged("Run vitest run src/a.test.ts and fix failures") === 0);
check("npm test -- file not flagged", flagged("Run `npm test -- tests/a.spec.ts`") === 0);
check("npm run test:unit variant not flagged", flagged("Run `npm run test:unit`") === 0);
check("gates entry in text flagged", flagged("Make sure `node scripts/gate.mjs` passes") === 1);
check("test-all.mjs in text flagged", flagged("Run node scripts/test-all.mjs at the end") === 1);
check("npm test bare flagged", flagged("Finally run `npm test`.") === 1);
check("pnpm test bare flagged", flagged("then pnpm test") === 1);
check("yarn test bare flagged", flagged("then yarn test") === 1);
check("bare vitest run flagged", flagged("Run `vitest run` and record counts") === 1);
check("npx vitest run bare flagged (one finding)", flagged("Run `npx vitest run`") === 1);
check("bare npx jest flagged", flagged("Run `npx jest` once") === 1);
check("negated mention not flagged", flagged("Do not run `npm run test` here; the gate does") === 0);
check("plain mention of tests not flagged", flagged("Add unit tests for the parser") === 0);
check("no entries: bare runner still flagged", flagged("run `npm test`", []) === 1);
check("speckit: file-scoped line not flagged", speckitTaskTextFullSuiteFindings("- [ ] T1 add x; verify: `npx vitest run tests/a.test.ts`", entries).length === 0);
check("speckit: verify part is not scanned here", speckitTaskTextFullSuiteFindings("- [ ] T1 add x; verify: `npm test`", entries).length === 0);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("test-task-text-full-suite: all passed");
