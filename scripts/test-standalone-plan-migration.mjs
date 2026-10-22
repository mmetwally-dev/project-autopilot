import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  hasUsableRequest,
  nameFromRequest,
  nextMissionSeq,
  resolveStandaloneMission,
  ensureStandaloneMigrated,
} from "./mission-naming.mjs";

// Plain fs/state.json fixtures only: a temp dir stands in for `repo`.
// No git involved (no `git init` / `git commit` anywhere in this file).

const savedMission = process.env.AUTOPILOT_MISSION;
const savedSpec = process.env.AUTOPILOT_SPEC;
delete process.env.AUTOPILOT_MISSION;
delete process.env.AUTOPILOT_SPEC;

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-standalone-migration-"));
}

function writeLegacy(repo, content) {
  const file = path.join(repo, ".autopilot", "standalone", "PLAN.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function writeMissionPlan(repo, mission, content) {
  const file = path.join(repo, ".autopilot", "missions", mission, "PLAN.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function readMigrationLog(repo) {
  const file = path.join(repo, ".autopilot", "MIGRATION.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

try {
  // Test A (new request resolves to ITS OWN name): persist a stale mission
  // and stale request, pass a live request with a different derived slug,
  // assert the POSITIVE — equality against the request-derived name — not
  // merely inequality against the stale mission.
  {
    const repo = makeRepo();
    try {
      writeMissionPlan(repo, "002-old-thing", "# Plan\n\n- [ ] old\n");
      const s = { mission: "002-old-thing", planningRequest: "old thing" };
      const live = "build a new dashboard widget";
      assert.ok(hasUsableRequest(live), "live request fixture must be usable");
      assert.notEqual(
        nameFromRequest(live),
        nameFromRequest("old thing"),
        "fixture requests must derive different slugs",
      );
      const expected = `${nextMissionSeq(repo)}-${nameFromRequest(live)}`;
      const result = resolveStandaloneMission(repo, s, live);
      assert.equal(result, expected);
      console.log("Test A passed: new request resolves to its own derived mission");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  // Test B (same request resumes its mission): same persisted state, call
  // with the exact same request text (and with no request at all).
  {
    const repo = makeRepo();
    try {
      writeMissionPlan(repo, "002-old-thing", "# Plan\n\n- [ ] old\n");
      const s = { mission: "002-old-thing", planningRequest: "old thing" };
      assert.equal(resolveStandaloneMission(repo, s, "old thing"), "002-old-thing");
      assert.equal(resolveStandaloneMission(repo, s, ""), "002-old-thing");
      assert.equal(resolveStandaloneMission(repo, s, undefined), "002-old-thing");
      console.log("Test B passed: same request resumes its mission");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  // Orphan migration (no persisted s.mission) lands under a fresh
  // NNN-legacy-standalone-plan directory, byte-identical.
  {
    const repo = makeRepo();
    try {
      const body = "# Plan\n\n- [ ] orphan task one\n- [x] orphan task two\n";
      const legacy = writeLegacy(repo, body);
      ensureStandaloneMigrated(repo, {});
      assert.ok(!fs.existsSync(legacy), "legacy file must be moved away");
      const missionsRoot = path.join(repo, ".autopilot", "missions");
      const dirs = fs.readdirSync(missionsRoot).filter((d) => d.endsWith("-legacy-standalone-plan"));
      assert.equal(dirs.length, 1, "exactly one legacy-standalone-plan mission dir expected");
      const dest = path.join(missionsRoot, dirs[0], "PLAN.md");
      assert.equal(fs.readFileSync(dest, "utf8"), body, "migrated content must be byte-identical");
      assert.match(readMigrationLog(repo), /migrated legacy standalone plan/, "migration must be logged");
      console.log("Orphan migration passed");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  // Active-mission-owned migration (persisted s.mission with no PLAN.md yet
  // at its own path) lands inside that same mission's directory,
  // byte-identical.
  {
    const repo = makeRepo();
    try {
      const body = "# Plan\n\n- [ ] active task\n- [ ] second\n";
      const legacy = writeLegacy(repo, body);
      fs.mkdirSync(path.join(repo, ".autopilot", "missions", "004-active-thing"), { recursive: true });
      ensureStandaloneMigrated(repo, { mission: "004-active-thing" });
      const dest = path.join(repo, ".autopilot", "missions", "004-active-thing", "PLAN.md");
      assert.ok(!fs.existsSync(legacy), "legacy file must be moved away");
      assert.equal(fs.readFileSync(dest, "utf8"), body, "migrated content must be byte-identical");
      assert.match(readMigrationLog(repo), /owner 004-active-thing/, "migration must record the owning mission");
      console.log("Active-owned migration passed");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  // Test D-repeat (idempotent): second call makes no filesystem change and
  // appends no second MIGRATION.md line.
  {
    const repo = makeRepo();
    try {
      const body = "# Plan\n\n- [ ] idempotent task\n";
      writeLegacy(repo, body);
      ensureStandaloneMigrated(repo, { mission: "006-idem" });
      const dest = path.join(repo, ".autopilot", "missions", "006-idem", "PLAN.md");
      const beforeBody = fs.readFileSync(dest, "utf8");
      const beforeLog = readMigrationLog(repo);
      const beforeMtime = fs.statSync(dest).mtimeMs;
      ensureStandaloneMigrated(repo, { mission: "006-idem" });
      assert.equal(fs.readFileSync(dest, "utf8"), beforeBody, "second call must not touch the migrated file");
      assert.equal(fs.statSync(dest).mtimeMs, beforeMtime, "second call must not rewrite the migrated file");
      assert.equal(readMigrationLog(repo), beforeLog, "second call must append no second MIGRATION.md line");
      console.log("Idempotency passed");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  // Destination-collision guard, orphan case: a prior orphan migration's
  // `NNN-legacy-standalone-plan/PLAN.md` must never be overwritten or
  // deleted by a later orphan migration — the fresh allocation must land in
  // a NEW seq dir, leaving the prior file byte-for-byte intact.
  // Note: with `nextMissionSeq`-based allocation the freshly computed orphan
  // destination can never equal a pre-existing path inside one synchronous
  // run (dest seq is always max+1), so the orphan branch's `throw` is a
  // defensive TOCTOU guard. The reachable fail-closed collision — computed
  // destination already exists → `die()` (throws) + `MIGRATION_CONFLICT` +
  // neither file touched — is asserted by Test C below, which exercises the
  // identical guard on the persisted-mission branch.
  {
    const repo = makeRepo();
    try {
      const priorBody = "# Plan\n\n- [ ] prior orphan survivor\n";
      const prior = writeMissionPlan(repo, "001-legacy-standalone-plan", priorBody);
      const legacyBody = "# Plan\n\n- [ ] new orphan legacy\n";
      const legacy = writeLegacy(repo, legacyBody);
      ensureStandaloneMigrated(repo, {});
      assert.ok(!fs.existsSync(legacy), "legacy file must be moved away");
      assert.equal(fs.readFileSync(prior, "utf8"), priorBody, "prior migration must be byte-for-byte unmodified");
      const dirs = fs
        .readdirSync(path.join(repo, ".autopilot", "missions"))
        .filter((d) => d.endsWith("-legacy-standalone-plan"));
      assert.equal(dirs.length, 2, "fresh orphan must allocate a new seq dir, not reuse the prior one");
      const fresh = dirs.find((d) => d !== "001-legacy-standalone-plan");
      assert.equal(
        fs.readFileSync(path.join(repo, ".autopilot", "missions", fresh, "PLAN.md"), "utf8"),
        legacyBody,
        "fresh orphan content must be byte-identical",
      );
      console.log("Orphan destination-collision guard passed (fresh seq, prior untouched)");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  // Test C (dual-plan / three-way conflict fails closed): persist
  // s.mission="005-active", create BOTH the legacy plan AND that mission's
  // own new-path plan; assert die() fires, both files byte-for-byte
  // unmodified, and the logged line is MIGRATION_CONFLICT (not a silent
  // orphan migration).
  {
    const repo = makeRepo();
    try {
      const legacyBody = "# Plan\n\n- [ ] legacy survivor\n";
      const activeBody = "# Plan\n\n- [x] active survivor\n";
      const legacy = writeLegacy(repo, legacyBody);
      const active = writeMissionPlan(repo, "005-active", activeBody);
      assert.throws(
        () => ensureStandaloneMigrated(repo, { mission: "005-active" }),
        /MIGRATION_CONFLICT/,
      );
      assert.equal(fs.readFileSync(legacy, "utf8"), legacyBody, "legacy file must be byte-for-byte unmodified");
      assert.equal(fs.readFileSync(active, "utf8"), activeBody, "active mission file must be byte-for-byte unmodified");
      const log = readMigrationLog(repo);
      assert.match(log, /MIGRATION_CONFLICT/, "conflict must be logged as MIGRATION_CONFLICT");
      const missionsRoot = path.join(repo, ".autopilot", "missions");
      const orphans = fs.existsSync(missionsRoot)
        ? fs.readdirSync(missionsRoot).filter((d) => d.endsWith("-legacy-standalone-plan"))
        : [];
      assert.equal(orphans.length, 0, "three-way conflict must never silently migrate as orphan");
      console.log("Test C passed: three-way conflict fails closed");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  // Test D (path-traversal in a hand-edited/corrupted state.json fails
  // closed, never silently re-sanitized): s.mission is normally always
  // already sanitized by `missionFor()` before it reaches `s.mission`, but
  // `ensureStandaloneMigrated`'s persisted-mission branch must not TRUST
  // that — a corrupted `.autopilot/state.json` (e.g. hand-edited during
  // debugging) with `"mission": "../../../outside"` must throw
  // UNSAFE_MISSION_NAME rather than silently building a path that escapes
  // `.autopilot/missions`, and must leave the legacy file untouched.
  {
    const repo = makeRepo();
    try {
      const legacyBody = "# Plan\n\n- [ ] legacy survivor\n";
      const legacy = writeLegacy(repo, legacyBody);
      assert.throws(
        () => ensureStandaloneMigrated(repo, { mission: "../../../outside" }),
        /UNSAFE_MISSION_NAME/,
      );
      assert.ok(fs.existsSync(legacy), "legacy file must not be moved on an unsafe mission name");
      assert.equal(fs.readFileSync(legacy, "utf8"), legacyBody, "legacy file must be byte-for-byte unmodified");
      assert.ok(
        !fs.existsSync(path.resolve(repo, "..", "..", "outside")),
        "nothing must be written outside the repo",
      );
      console.log("Test D passed: path-traversal mission name fails closed");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  console.log("standalone plan migration tests passed");
} finally {
  if (savedMission === undefined) delete process.env.AUTOPILOT_MISSION;
  else process.env.AUTOPILOT_MISSION = savedMission;
  if (savedSpec === undefined) delete process.env.AUTOPILOT_SPEC;
  else process.env.AUTOPILOT_SPEC = savedSpec;
}
