#!/usr/bin/env node
// Backlog #211/#212: implementation-stage indentation and carried-forward text.
//
// #211 — `Attempt N` headers exist only when a phase has more than one
// attempt. With one attempt the table must stay at four spaces (findings and
// carried forward at six, `next:` aligned with the table); with two attempts
// the header pushes the table to six (details at eight, `next:` at six).
//
// #212 — the "(not named by the findings)" note appears once at the end of
// the unnamed group, never after every task: all unnamed, all named, mixed.
import { buildReportModel, renderImplementationStage } from "./watch-report.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });
const lines = (text) => String(text).split("\n");
const row = (text, needle) => lines(text).find((l) => l.includes(needle)) || "";
const indent = (text) => String(text).match(/^ */)[0].length;

function render({ findings = ["T1.2: missing fixture"], carried = ["T1.1"], attempts = 1 } = {}) {
  const phases = [{ number: 1, name: "Phase 1 — Work", done: false, tasks: [{ text: "T1.1", done: true }, { text: "T1.2", done: false }] }];
  const runs = [
    run({ id: "01-implementer-a", dirName: "01-implementer-a", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", started_at: "2026-10-19T10:00:00+00:00" }),
    run({ id: "02-verifier-a", dirName: "02-verifier-a", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1 > T1.2", decision: "FAIL", findings, carriedForwardTasks: carried, started_at: "2026-10-19T10:05:00+00:00" }),
  ];
  if (attempts > 1) {
    runs.push(run({ id: "03-implementer-b", dirName: "03-implementer-b", role: "implementer", phase: "1", attempt: "2", taskRef: "T1.2", status: "running", started_at: "2026-10-19T10:10:00+00:00" }));
  } else {
    runs.push(run({ id: "03-implementer-b", dirName: "03-implementer-b", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.2", status: "running", started_at: "2026-10-19T10:10:00+00:00" }));
  }
  const state = { phase: "implementing", step: "implement", phaseIndex: 0, attempt: attempts, planningDetection: { framework: "standalone" } };
  const model = buildReportModel({ state, runs, events: [], phases, policy: {}, now: "2026-10-19T10:20:00+00:00" });
  return renderImplementationStage(model);
}

// ── #211: one attempt has no header, so nothing is indented under it ────────
{
  const impl = render({ attempts: 1 });
  const table = row(impl, "ROLE");
  const findingsRow = row(impl, "findings →");
  const carriedRow = row(impl, "carried forward →");
  const nextRow = row(impl, "next:");
  check("1 attempt: no Attempt header", !impl.includes("Attempt 1"), row(impl, "Attempt"));
  check("1 attempt: table starts at four", table.startsWith("    ROLE"), table);
  check("1 attempt: running marker keeps its margin", row(impl, "03-implementer-b").startsWith("  › 03-implementer-b"), row(impl, "03-implementer-b"));
  check("1 attempt: findings start at six", indent(findingsRow) === 6, findingsRow);
  check("1 attempt: carried forward starts at six", indent(carriedRow) === 6, carriedRow);
  check("1 attempt: next aligns with the table", indent(nextRow) === 4 && nextRow.startsWith("    next:"), nextRow);
}

// ── #211: two attempts have headers, so the table and details shift ─────────
{
  const impl = render({ attempts: 2 });
  const table = row(impl, "ROLE");
  const findingsRow = row(impl, "findings →");
  const carriedRow = row(impl, "carried forward →");
  const nextRow = row(impl, "next:");
  check("2 attempts: Attempt header present", impl.includes("\n    Attempt 1  ✗ DENIED"), row(impl, "Attempt 1"));
  check("2 attempts: table starts at six", table.startsWith("      ROLE"), table);
  check("2 attempts: running marker keeps its margin", row(impl, "03-implementer-b").startsWith("    › 03-implementer-b"), row(impl, "03-implementer-b"));
  check("2 attempts: findings start at eight", indent(findingsRow) === 8, findingsRow);
  check("2 attempts: carried forward starts at eight", indent(carriedRow) === 8, carriedRow);
  check("2 attempts: next aligns with the table", indent(nextRow) === 6 && nextRow.startsWith("      next:"), nextRow);
}

// ── #212: one note at the end of the unnamed group ──────────────────────────
{
  const allUnnamed = row(render({ findings: ["T9: unrelated"], carried: ["T1.1", "T1.2", "T1.3", "T1.4"] }), "carried forward →");
  check("carried: all unnamed uses one note at the end",
    allUnnamed === "      carried forward → T1.1, T1.2, T1.3, T1.4 (not named by the findings)", allUnnamed);

  const allNamed = row(render({ findings: ["T1.1: first", "T1.2: second"], carried: ["T1.1", "T1.2"] }), "carried forward →");
  check("carried: all named has no note",
    allNamed === "      carried forward → T1.1, T1.2", allNamed);

  const mixed = row(render({ findings: ["T1.5: first", "T1.6: second"], carried: ["T1.1", "T1.2", "T1.5", "T1.6"] }), "carried forward →");
  check("carried: mixed puts named first, then the unnamed group with one note",
    mixed === "      carried forward → T1.5, T1.6 · T1.1, T1.2 (not named by the findings)", mixed);
  check("carried: the note is never repeated",
    (mixed.match(/\(not named by the findings\)/g) || []).length === 1, mixed);
}

if (failures.length) { console.error(`${failures.length} watch-report-b4 check(s) failed.`); process.exit(1); }
console.log("All watch-report-b4 checks passed.");
