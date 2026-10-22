#!/usr/bin/env node
// MANUAL integration probe (NOT part of the deterministic `npm test`
// suite — the filename deliberately does not match test-all.mjs's
// `test-*.mjs` discovery glob, and execution additionally requires
// AP_LIVE_OPENCODE=1).
//
// Spawns a REAL `opencode run` Implementer under the guarded environment,
// then a Reviewer after it, proving the 15.6J property against a live
// model: the startup symbolic-ref query is never shim-blocked, the
// deliverable is produced with exact bytes, and HEAD never moves.
//
// SCOPE NOTE (15.6J CORRECTION): this spawns raw `opencode run` processes
// under the guarded environment. That proves ADAPTER behavior (startup
// probes pass, file produced, guard mechanics hold) but it is NOT a
// production relay: no makeRelayResult() verdict is computed, no
// result.json is written, and no later roles are launched by an
// orchestrator here. A harness-level exit 0 therefore never means "relay
// PASS" — the relay-verdict policy is proven separately through REAL
// missions in test-relay-git-mutation-verdict.mjs. Do not read this
// script's exit-0 checks as verdict coverage.
//
// Terminal states:
//   - PASS (exit 0): adapter acted, all guard/file/HEAD checks held.
//   - SKIP (exit 0 with reason): no binary / spawn failure / auth /
//     provider incapacity — environmental, never a test failure.
//   - FAIL (exit 1): the model ran but exited without producing the file
//     and with no guard signal (a model no-op is NEVER a pass), or any
//     guard/file/HEAD check failed.
// Transcripts are ALWAYS removed in finally unless AP_KEEP_TRANSCRIPTS=1
// explicitly requests retention (PASS, FAIL, and SKIP alike); a cleanup
// failure is recorded and forces exit code 1 even over a SKIP.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createGitMutationGuard, guardedEnv, gitSnapshot, readGuardLog} from "./relay-guards.mjs";

if (process.env.AP_LIVE_OPENCODE !== "1") {
  console.log("SKIP live opencode probe: requires explicit opt-in AP_LIVE_OPENCODE=1 (not part of the deterministic suite)");
  process.exit(0);
}

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ""}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-156j-live-"));
const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-156j-relay-"));
const keepTranscripts = process.env.AP_KEEP_TRANSCRIPTS === "1";

function git(cwd, args, env) {
  return spawnSync("git", args, {cwd, encoding: "utf8", env, shell: false});
}
function combined(res) {
  return `${res.stdout || ""}\n${res.stderr || ""}`;
}
function opencodeBinary() {
  const probe = process.platform === "win32"
    ? spawnSync("where.exe", ["opencode"], {encoding: "utf8", shell: false})
    : spawnSync("sh", ["-lc", "command -v opencode"], {encoding: "utf8", shell: false});
  const lines = (probe.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (process.platform === "win32") {
    // npm lays down an extensionless POSIX shell script next to opencode.cmd;
    // only the .cmd (or .exe) launcher can spawn on native Windows.
    return lines.find((x) => /\.(cmd|exe|bat)$/i.test(x)) || null;
  }
  return lines[0] || null;
}

let outcome = "pass";
function skip(reason) {
  console.log(`SKIP relay: ${reason}`);
  outcome = "skip";
}

try {
  const binary = opencodeBinary();
  if (!binary) {
    skip("no opencode binary on PATH in this environment");
  } else {
    const repo = path.join(root, "relay");
    fs.mkdirSync(repo, {recursive: true});
    assert.equal(git(repo, ["init", "-q"]).status, 0);
    assert.equal(git(repo, ["config", "user.email", "symref-live@example.invalid"]).status, 0);
    assert.equal(git(repo, ["config", "user.name", "Symref Live"]).status, 0);
    fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
    assert.equal(git(repo, ["add", "-A"]).status, 0);
    assert.equal(git(repo, ["commit", "-q", "-m", "init"]).status, 0);

    const guard = createGitMutationGuard(path.join(root, "guard-relay"), repo);
    // PWD/INIT_CWD pinned to the fixture repo: matches the production
    // relay authority (autopilot.mjs seeds both from the effective
    // repository on every role invocation since task 15.6K).
    const env = guardedEnv(guard, {PWD: repo, INIT_CWD: repo});
    const headBefore = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    const runRelay = (args, stdinData, timeoutMs) => {
      // Native Windows cannot spawn npm's extensionless POSIX launcher or
      // .cmd without a shell; route through cmd.exe there (argv still passed
      // as a list, quoted by Node).
      if (process.platform === "win32") {
        return spawnSync("cmd.exe", ["/d", "/s", "/c", binary, ...args], {
          cwd: repo, env, encoding: "utf8", shell: false, input: stdinData, timeout: timeoutMs,
        });
      }
      return spawnSync(binary, args, {
        cwd: repo, env, encoding: "utf8", shell: false, input: stdinData, timeout: timeoutMs,
      });
    };
    const authFailure = (out) => /auth|login|unauthenticated|unauthorized|\b401\b/i.test(out);
    const incapacity = (out) => /rate.?limit|429|overloaded|capacity|quota|credit|insufficient/i.test(out);
    // --- Implementer (write mode, mirrors the opencode driver) ---
    // Live-model hardening: the model occasionally exits 0 without acting
    // (exit 0, no file, no guard interaction at all). Guard regressions are
    // still caught DETERMINISTICALLY: any guard-block marker in ANY attempt
    // fails below regardless of file outcome. File absence with a clean
    // transcript after one bounded retry is environmental model flake —
    // but a model no-op must NEVER count as a pass, so it FAILS here (this
    // script is manual integration evidence, not a deterministic suite
    // test). The prompt demands the write tool and no closing reply, so
    // there is no cheap exit for the model to take instead of acting.
    // Every attempt's transcript is saved for post-mortem (and always
    // cleaned in finally unless AP_KEEP_TRANSCRIPTS=1).
    const implMsg = "Use the write tool to write exactly the text 156j-relay-ok into the relative path ./impl-156j.txt resolved against the current working directory. Use a relative path, never an absolute path, and write nowhere else. Do nothing else.";
    const produced = path.join(repo, "impl-156j.txt");
    // Tripwire for a real incident observed in-suite: the model once wrote
    // the deliverable to an ABSOLUTE path inside the canonical skill tree
    // instead of the fixture repo. A stray file there must fail loudly.
    const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const strayPath = path.join(skillRoot, "impl-156j.txt");
    const strayBefore = fs.existsSync(strayPath);
    let impl = null;
    let implOut = "";
    let implAttempts = 0;
    let sawGuardBlock = false;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      implAttempts = attempt;
      impl = runRelay(["run", "--format", "json", "--auto", implMsg], undefined, 240000);
      implOut = combined(impl);
      fs.writeFileSync(path.join(transcriptDir, `implementer-attempt-${attempt}.log`), implOut);
      if (/GIT_MUTATION_BLOCKED/.test(implOut) || /AUTOPILOT GIT GUARD/.test(implOut)) sawGuardBlock = true;
      if (impl.error || (impl.status !== 0 && (authFailure(implOut) || incapacity(implOut)))) break;
      if (impl.status === 0 && fs.existsSync(produced)) break;
      console.log(`INFO relay: implementer attempt ${attempt} did not produce the file (status=${impl.status}); ${attempt < 2 ? "retrying once" : "no retries left"}; transcript: ${transcriptDir}`);
    }
    console.log(`INFO relay: transcripts saved in ${transcriptDir}${keepTranscripts ? " (retained: AP_KEEP_TRANSCRIPTS=1)" : ""}`);
    const implEnd = Date.now();
    if (impl.error) {
      skip(`opencode failed to spawn in this environment (${impl.error.code || impl.error.message})`);
    } else if (impl.status !== 0 && (authFailure(implOut) || incapacity(implOut))) {
      skip("opencode unavailable (auth/capacity) in this environment");
    } else if (!fs.existsSync(produced) && !sawGuardBlock) {
      check("relay: model produced the file after bounded retry (a model no-op is never a pass)",
        false, `status=${impl.status} after ${implAttempts} attempt(s); transcripts: ${transcriptDir}`);
    } else {
      check("relay: implementer exits 0", impl.status === 0, `status=${impl.status} signal=${impl.signal} error=${impl.error || ""} :: ${implOut.slice(-500)}`);
      check("relay: no symbolic-ref block surfaced", !/GIT_MUTATION_BLOCKED/.test(implOut) && !/AUTOPILOT GIT GUARD/.test(implOut));
      check("relay: implementer produced the file", fs.existsSync(produced), `after ${implAttempts} attempt(s)`);
      check("relay: file content exact", fs.existsSync(produced) && fs.readFileSync(produced, "utf8") === "156j-relay-ok",
        fs.existsSync(produced) ? JSON.stringify(fs.readFileSync(produced, "utf8")) : "missing");
      check("relay: file is Git-visible", git(repo, ["status", "--porcelain=v1", "--", "impl-156j.txt"]).stdout.trim() !== "");
      // The 15.6J property: the startup symbolic-ref probe is never blocked.
      // (Opencode's bootstrap is nondeterministic across platforms/runs and
      // may additionally attempt a genuine ref mutation, which the 15.6I
      // hook must and does deny. Such entries, if any, must all be
      // official-scope hook denials, never shim blocks.)
      const implEvents = readGuardLog(guard.logFile);
      check("relay: symbolic-ref never shim-blocked",
        implEvents.every((e) => !(e.layer === "path-shim" && e.subcommand === "symbolic-ref")),
        JSON.stringify(implEvents));
      check("relay: every block (if any) is a genuine-mutation hook denial",
        implEvents.every((e) => e.layer === "hook"
          && (e.scope === "official" || ["pre-commit", "pre-push", "pre-rebase", "pre-merge-commit"].includes(e.hook))),
        JSON.stringify(implEvents));
      check("relay: HEAD unchanged by implementer", git(repo, ["rev-parse", "HEAD"]).stdout.trim() === headBefore);
      // --- Reviewer launches ONLY after successful implementation ---
      if (!fs.existsSync(produced) || impl.status !== 0) {
        check("relay: reviewer gated on implementer success", false, "implementer never produced the file; reviewer not launched");
      } else {
        check("relay: reviewer gated on implementer success", true);
        const revMsg = "Read the relative path ./impl-156j.txt resolved against the current working directory using the read tool and reply with exactly REVIEW:<its content>. Use a relative path, never an absolute path. Do nothing else.";
        const revStart = Date.now();
        const rev = runRelay(["run", "--format", "json", "--agent", "plan", revMsg], undefined, 240000);
        const revOut = combined(rev);
        check("relay: reviewer starts after implementer finished", revStart >= implEnd);
        check("relay: reviewer exits 0", rev.status === 0, `status=${rev.status} signal=${rev.signal} :: ${revOut.slice(-500)}`);
        check("relay: reviewer observed the implementer file content", /REVIEW:/.test(revOut) && /156j-relay-ok/.test(revOut),
          revOut.slice(-400));
        const allEvents = readGuardLog(guard.logFile);
        check("relay: still no shim block end to end",
          allEvents.every((e) => e.layer === "hook"),
          JSON.stringify(allEvents));
        check("relay: HEAD unchanged end to end", git(repo, ["rev-parse", "HEAD"]).stdout.trim() === headBefore);
      }
      // Tripwire runs on EVERY non-skip path: a model deliverable written
      // outside the fixture must fail loudly, never pass silently.
      check("relay: no stray deliverable in the canonical skill tree",
        !fs.existsSync(strayPath), JSON.stringify({strayPath, preExisting: strayBefore}));
    }
  }
} finally {
  // Fail-closed cleanup: every test-owned path is attempted even if an
  // earlier removal failed; no rmSync error is swallowed (each is recorded
  // as a failure); every owned path is verified absent afterward. A cleanup
  // failure forces exit code 1 even when the probe itself would SKIP.
  // Owned paths are ONLY the two mkdtemp directories created by this script
  // — never anything obtained from child/model output (the tripwire path is
  // read-only by design and is never deleted here).
  if (keepTranscripts) {
    console.log(`INFO relay: retaining explicitly owned fixture paths for manual inspection (AP_KEEP_TRANSCRIPTS=1): ${transcriptDir} ${root}`);
  } else {
    let cleanupFailed = false;
    for (const owned of [transcriptDir, root]) {
      try {
        fs.rmSync(owned, {recursive: true, force: true});
      } catch (error) {
        cleanupFailed = true;
        check("cleanup: removal succeeded", false, `${owned}: ${error?.message || error}`);
      }
    }
    for (const owned of [transcriptDir, root]) {
      if (fs.existsSync(owned)) {
        cleanupFailed = true;
        check("cleanup: owned path absent afterward", false, owned);
      }
    }
    if (cleanupFailed) {
      console.error("FAIL cleanup failures force a failing exit even though the probe outcome was SKIP");
      outcome = "fail";
    }
  }
}

if (outcome === "skip") process.exit(0);
console.log(`\n156J live opencode probe: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
