#!/usr/bin/env node
// Mission 061 task 1.1 — sharded-verify plan-time gate pins.
//
// A task verify naming a sharded file (scripts/suite-schedule.mjs `shards`)
// must pin one shard via AP_TEST_SHARD=k/n; a bare run is rejected in both
// loops (standalone entries + SpecKit tasks.md text).
import {verifyShardFindings, speckitTaskVerifyShardFindings, SHARD_ASSIGNMENT_RE} from "./verify-denylist.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const SHARDED = "test-finding-task-locality.mjs";
const FAST = "test-config-validation.mjs";

// The shard-assignment matcher accepts quoted and unquoted k/n forms.
check("regex: unquoted AP_TEST_SHARD=3/20 matches",
  SHARD_ASSIGNMENT_RE.test("AP_TEST_SHARD=3/20 node scripts/test-finding-task-locality.mjs"));
check("regex: double-quoted AP_TEST_SHARD=\"3/20\" matches",
  SHARD_ASSIGNMENT_RE.test('AP_TEST_SHARD="3/20" node scripts/test-finding-task-locality.mjs'));
check("regex: bare mention without k/n does not match",
  !SHARD_ASSIGNMENT_RE.test("node scripts/test-finding-task-locality.mjs # AP_TEST_SHARD"));

// ── Standalone loop ──
{
  const bare = verifyShardFindings([{taskLabel: "1.1", verify: `node scripts/${SHARDED}`}]);
  check("standalone: bare sharded-file verify rejected", bare.length === 1, bare);
  check("standalone: bare finding cites the file and correction",
    bare.length === 1 && bare[0].problem.includes(SHARDED) && bare[0].correction.includes("AP_TEST_SHARD"), bare);

  const unquoted = verifyShardFindings([{taskLabel: "1.2", verify: `AP_TEST_SHARD=3/20 node scripts/${SHARDED}`}]);
  check("standalone: AP_TEST_SHARD=3/20 passes", unquoted.length === 0, unquoted);

  const quoted = verifyShardFindings([{taskLabel: "1.3", verify: `AP_TEST_SHARD="3/20" node scripts/${SHARDED}`}]);
  check("standalone: AP_TEST_SHARD=\"3/20\" passes", quoted.length === 0, quoted);

  const mention = verifyShardFindings([{taskLabel: "1.4", verify: `node scripts/${SHARDED} # AP_TEST_SHARD`}]);
  check("standalone: mention without k/n assignment rejected", mention.length === 1, mention);

  const fast = verifyShardFindings([{taskLabel: "1.5", verify: `node scripts/${FAST}`}]);
  check("standalone: fast file passes", fast.length === 0, fast);

  check("standalone: entry without a verify is never flagged",
    verifyShardFindings([{taskLabel: "1.6"}]).length === 0
    && verifyShardFindings([{taskLabel: "1.7", verify: ""}]).length === 0);
}

// ── SpecKit loop (verify segment only) ──
{
  const bare = speckitTaskVerifyShardFindings(`## Phase 1: Build\n\n- [ ] T001 Do the thing; verify: node scripts/${SHARDED}\n`);
  check("speckit: bare sharded-file line rejected", bare.length === 1, bare);
  check("speckit: bare finding cites the heading and correction",
    bare.length === 1 && bare[0].location.includes("Phase 1: Build") && bare[0].correction.includes("AP_TEST_SHARD"), bare);

  const unquoted = speckitTaskVerifyShardFindings(`## Phase 1: Build\n\n- [ ] T002 Do the thing; verify: AP_TEST_SHARD=3/20 node scripts/${SHARDED}\n`);
  check("speckit: AP_TEST_SHARD=3/20 passes", unquoted.length === 0, unquoted);

  const quoted = speckitTaskVerifyShardFindings(`## Phase 1: Build\n\n- [ ] T003 Do the thing; verify: AP_TEST_SHARD="3/20" node scripts/${SHARDED}\n`);
  check("speckit: AP_TEST_SHARD=\"3/20\" passes", quoted.length === 0, quoted);

  const mention = speckitTaskVerifyShardFindings(`## Phase 1: Build\n\n- [ ] T004 Do the thing; verify: node scripts/${SHARDED} (see AP_TEST_SHARD)\n`);
  check("speckit: mention without k/n assignment rejected", mention.length === 1, mention);

  const fast = speckitTaskVerifyShardFindings(`## Phase 1: Build\n\n- [ ] T005 Do the thing; verify: node scripts/${FAST}\n`);
  check("speckit: fast file passes", fast.length === 0, fast);

  check("speckit: line without a sharded file is never flagged",
    speckitTaskVerifyShardFindings("## Phase 1: Build\n\n- [ ] T006 Do the thing; verify: node scripts/test-config-validation.mjs\n").length === 0);

  check("speckit: line without a verify is never flagged",
    speckitTaskVerifyShardFindings(`## Phase 1: Build\n\n- [ ] T007 Do the thing with node scripts/${SHARDED}\n`).length === 0);

  check("speckit: sharded file named outside a fast verify is not flagged",
    speckitTaskVerifyShardFindings(`## Phase 1: Build\n\n- [ ] T010 Add a case to scripts/${SHARDED}; verify: node scripts/${FAST}\n`).length === 0);
}

if (failures) {
  console.error(`${failures} verify-shard-reject check(s) failed.`);
  process.exit(1);
}
console.log("verify-shard-reject tests passed");
