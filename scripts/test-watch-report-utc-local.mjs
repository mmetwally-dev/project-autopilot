#!/usr/bin/env node
// Backlog #4: watch report status time shown in local time (not UTC)
// The Status: CANCELLED/COMPLETED/STOPPED/ESCALATED at ... line should use local time

import { buildReportModel, formatStamp, renderPipelineState } from "./watch-report.mjs";

const localStamp = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

// ── Test: Z-suffixed timestamp (UTC) should display in local time ────────────────
{
  // A UTC timestamp like "2026-10-17T12:51:29Z" should show as local time
  // Not as "12:51:29" (which is what UTC would show)

  // We can't easily test the exact local time without knowing the test environment's timezone
  // But we can verify that Z timestamps are NOT output as-is with Z removed
  // They should be converted using getHours() not getUTCHours()

  // Test offset-bearing timestamp (should keep its own clock) - this already works
  const offsetResult = formatStamp("2026-10-17T12:51:29+03:00");
  check("offset timestamp keeps source clock", offsetResult === "2026-10-17 12:51:29", offsetResult);

  // Test Z-suffixed timestamp - should convert to local
  // We can't assert exact local time, but we can verify it's NOT the UTC time
  const zResult = formatStamp("2026-10-17T12:51:29Z");
  check("Z timestamp converts to local", zResult === localStamp("2026-10-17T12:51:29Z"), zResult);
  check("Z timestamp has format YYYY-MM-DD HH:MM:SS", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(zResult), zResult);
}

// ── Test: Naive timestamp (no timezone) - currently treated as UTC ───────────────
{
  // Naive timestamps like "2026-10-17T12:51:29" are treated as UTC
  // The comment says "naive ISO string is treated as UTC"
  // This might be intentional for backwards compatibility
  const naiveResult = formatStamp("2026-10-17T12:51:29");
  check("naive timestamp treated as UTC", naiveResult === localStamp("2026-10-17T12:51:29Z"), naiveResult);
}

// ── Test: COMPLETED/STOPPED/ESCALATED status lines use formatStamp ──────────────
{
  const model = buildReportModel({
    state: { mission: "utc-fixture", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1 },
    runs: [],
    events: [{ type: "operator", reason: "stop", scope: "mission", at: "2026-10-17T12:51:29Z" }],
    phases: [{ number: 1, name: "Phase 1", tasks: [] }],
    now: "2026-10-17T13:00:00Z",
  });
  const pipeline = renderPipelineState(model);
  check("statusStopLine uses local formatStamp", pipeline.includes(`Status:  STOPPED at ${localStamp("2026-10-17T12:51:29Z")}`), pipeline.split("\n").find((l) => l.startsWith("Status:")));
}

if (failures.length) { console.error(`${failures.length} check(s) failed.`); process.exit(1); }
console.log("All watch-report-utc-local checks passed.");