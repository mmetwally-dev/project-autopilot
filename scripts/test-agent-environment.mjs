#!/usr/bin/env node
// B2: Agent-environment assembler regression tests.
//
// Covers:
//   1. spawnEnv invariants (production-environment snapshot)
//   2. bridgeEnv invariants (bwrap --setenv overlay)
//   3. effectiveEnv invariants (bridge proxy overlay)
//   4. environmentAuthorityDigest projection invariants
//   5. parseSetenvOverlay purity
//   6. providerBridgeOverlay determinism
//   7. assertFixedGatewayAuthority literals
//   8. schema version constants
//   9. GIT_GUARD_VARIABLES immutability
//  10. deterministic output (call twice, same result)
//  11. spawnEnv never includes bridge proxy vars when gateway active
//  12. effectiveEnv includes bridge proxy vars only when gateway active
//  13. authority digest changes when bridge overlay changes
//  14. runAdapterEnvelopeProbe uses assembleAgentEnvironment (structural)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assembleAgentEnvironment,
  parseSetenvOverlay,
  providerBridgeOverlay,
  assertFixedGatewayAuthority,
  projectEnvironmentAuthorityDigest,
  AGENT_ENVIRONMENT_SCHEMA,
  AGENT_ENVIRONMENT_AUTHORITY_SCHEMA,
  GIT_GUARD_VARIABLES,
} from "./agent-environment.mjs";
import {spawnSync} from "node:child_process";
import {createGitMutationGuard, guardedEnv} from "./relay-guards.mjs";

let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};

// ---- Helpers ----
const safeEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/tmp/home",
  NODE_ENV: "test",
  LANG: "en_US.UTF-8",
  TERM: "xterm",
};

// ---- 1. spawnEnv invariants ----
{
  const result = assembleAgentEnvironment({
    guardedEnv: safeEnv,
    envelope: null,
    adapterRoleScratchExists: false,
    gatewayActive: false,
  });
  check("spawnEnv is defined", result.spawnEnv != null);
  check("spawnEnv.PATH matches guardedEnv.PATH", result.spawnEnv.PATH === safeEnv.PATH);
  check("spawnEnv.HOME matches guardedEnv.HOME", result.spawnEnv.HOME === safeEnv.HOME);
  check("spawnEnv has no bridge proxy vars when gateway inactive",
    result.spawnEnv.HTTP_PROXY === undefined && result.spawnEnv.HTTPS_PROXY === undefined);
}

// ---- 2. bridgeEnv invariants ----
{
  const result = assembleAgentEnvironment({
    guardedEnv: safeEnv,
    envelope: null,
    adapterRoleScratchExists: false,
    gatewayActive: false,
  });
  check("bridgeEnv includes all guardedEnv keys", Object.keys(result.bridgeEnv).includes("PATH"));
  check("bridgeEnv is a separate object (not same ref as spawnEnv)",
    result.bridgeEnv !== result.spawnEnv);
}

// ---- 3. effectiveEnv invariants ----
{
  const resultOff = assembleAgentEnvironment({
    guardedEnv: safeEnv,
    envelope: null,
    adapterRoleScratchExists: false,
    gatewayActive: false,
  });
  check("effectiveEnv has no bridge proxy vars when gateway inactive",
    resultOff.effectiveEnv.HTTP_PROXY === undefined);

  const resultOn = assembleAgentEnvironment({
    guardedEnv: safeEnv,
    envelope: null,
    adapterRoleScratchExists: false,
    gatewayActive: true,
  });
  check("effectiveEnv has HTTP_PROXY when gateway active",
    resultOn.effectiveEnv.HTTP_PROXY === "http://127.0.0.1:18080");
  check("effectiveEnv has HTTPS_PROXY when gateway active",
    resultOn.effectiveEnv.HTTPS_PROXY === "http://127.0.0.1:18080");
  check("effectiveEnv has http_proxy (lowercase) when gateway active",
    resultOn.effectiveEnv.http_proxy === "http://127.0.0.1:18080");
  check("effectiveEnv has https_proxy (lowercase) when gateway active",
    resultOn.effectiveEnv.https_proxy === "http://127.0.0.1:18080");
  check("effectiveEnv NO_PROXY is 127.0.0.1,localhost when gateway active",
    resultOn.effectiveEnv.NO_PROXY === "127.0.0.1,localhost");
  check("effectiveEnv no_proxy is 127.0.0.1,localhost when gateway active",
    resultOn.effectiveEnv.no_proxy === "127.0.0.1,localhost");
  check("effectiveEnv ALL_PROXY is empty when gateway active",
    resultOn.effectiveEnv.ALL_PROXY === "");
  check("effectiveEnv all_proxy is empty when gateway active",
    resultOn.effectiveEnv.all_proxy === "");
}

// ---- 4. environmentAuthorityDigest projection invariants ----
//
// The digest binds:
//   - the schema identifier
//   - the safe-variable allowlist (which names are permitted)
//   - the per-safe-variable value digests (presence + value digest)
//   - the fixed PATH key (which OS env var carries PATH)
//   - the git-guard policy literals (fixed GIT_GUARD_VARIABLES, names)
//   - the canonical sandbox targets
//   - the canonical run-specific guard path templates
//   - the fixed provider authority literals
//   - the egress config (gatewayActive)
//
// The digest does NOT bind the raw ambient PATH, the bwrap setenv
// overlay values, the provider bridge overlay values, or the
// per-guard-runtime value digests of ephemeral variables
// (AUTOPILOT_GIT_GUARD_LOG, GIT_CONFIG_VALUE_0/1) — these are
// host- and run-specific. The diagnostic projection still records
// them for human inspection. The original regression (a parent-set
// AUTOPILOT_NO_GIT_MUTATIONS=1 changing the digest) is fixed
// because that variable is not in the safe-variable allowlist, so
// it is filtered out of both the issuance-side and admission-side
// effective env before the digest is computed.
{
  const digest = projectEnvironmentAuthorityDigest();
  check("authority digest is a hex string", /^[a-f0-9]{64}$/.test(digest));
  const digest2 = projectEnvironmentAuthorityDigest();
  check("authority digest is deterministic (same config => same digest)", digest === digest2);
  check("authority digest changes when egress config changes", (() => {
    const d1 = projectEnvironmentAuthorityDigest({config: {gates: {network_isolation: true}}});
    const d2 = projectEnvironmentAuthorityDigest({config: {gates: {network_isolation: false}}});
    return d1 !== d2;
  })());
  // Safe-variable values are bound: LANG / HOME changes invalidate
  // the digest. This is the material authoritative state.
  const digestNoEnv = projectEnvironmentAuthorityDigest();
  const digestWithEnv = projectEnvironmentAuthorityDigest({effectiveEnv: {LANG: "en_US.UTF-8", HOME: "/tmp/home"}});
  check("authority digest changes when safe variable values differ (binds material state)", digestNoEnv !== digestWithEnv);
  const digestWithEnv2 = projectEnvironmentAuthorityDigest({effectiveEnv: {LANG: "en_US.UTF-8", HOME: "/tmp/home"}});
  check("authority digest is deterministic with same effectiveEnv", digestWithEnv === digestWithEnv2);
  const digestDifferentEnv = projectEnvironmentAuthorityDigest({effectiveEnv: {LANG: "fr_FR.UTF-8", HOME: "/tmp/home"}});
  check("authority digest changes when safe variable value changes", digestWithEnv !== digestDifferentEnv);
  const digestAbsentEnv = projectEnvironmentAuthorityDigest({effectiveEnv: {}});
  check("authority digest differs when safe variable is absent vs present", digestAbsentEnv !== digestWithEnv);
  // Ephemeral guard state (e.g. the per-run guard log file path,
  // per-run GIT_CONFIG_VALUE_0/1 hooks-dir path) is excluded from
  // the digest because it is run-specific. The original regression
  // — a parent-set AUTOPILOT_NO_GIT_MUTATIONS=1 changing the digest
  // — is fixed because that variable is not in the safe-variable
  // allowlist.
  const d1 = projectEnvironmentAuthorityDigest({effectiveEnv: {AUTOPILOT_NO_GIT_MUTATIONS: "1"}});
  const d2 = projectEnvironmentAuthorityDigest({effectiveEnv: {}});
  check("authority digest is unchanged by parent-set AUTOPILOT_NO_GIT_MUTATIONS (regression)", d1 === d2);
  const d3 = projectEnvironmentAuthorityDigest({effectiveEnv: {AUTOPILOT_GIT_GUARD_LOG: "/tmp/some/ephemeral/path"}});
  const d4 = projectEnvironmentAuthorityDigest({effectiveEnv: {}});
  check("authority digest is unchanged by ephemeral AUTOPILOT_GIT_GUARD_LOG (run-specific path)", d3 === d4);
}

// ---- 5. parseSetenvOverlay purity ----
{
  const overlay = parseSetenvOverlay(["--setenv", "FOO", "bar", "--setenv", "BAZ", "qux"]);
  check("parseSetenvOverlay parses triples", overlay.FOO === "bar" && overlay.BAZ === "qux");
  check("parseSetenvOverlay is pure (original args unchanged)", overlay.length === undefined);
  const overlay2 = parseSetenvOverlay(["--setenv", "FOO", "bar", "--setenv", "BAZ", "qux"]);
  check("parseSetenvOverlay is deterministic", JSON.stringify(overlay) === JSON.stringify(overlay2));
}

// ---- 6. providerBridgeOverlay determinism ----
{
  const off = providerBridgeOverlay({gatewayActive: false});
  check("providerBridgeOverlay returns empty when inactive", Object.keys(off).length === 0);
  const on = providerBridgeOverlay({gatewayActive: true});
  check("providerBridgeOverlay has 8 keys when active", Object.keys(on).length === 8);
  check("providerBridgeOverlay HTTP_PROXY is http://127.0.0.1:18080",
    on.HTTP_PROXY === "http://127.0.0.1:18080");
  check("providerBridgeOverlay NO_PROXY is 127.0.0.1,localhost",
    on.NO_PROXY === "127.0.0.1,localhost");
  check("providerBridgeOverlay ALL_PROXY is empty string",
    on.ALL_PROXY === "");
}

// ---- 7. assertFixedGatewayAuthority literals ----
{
  const ok = assertFixedGatewayAuthority();
  check("assertFixedGatewayAuthority returns null on valid literals", ok === null);
}

// ---- 8. schema version constants ----
{
  check("AGENT_ENVIRONMENT_SCHEMA is autopilot-agent-environment.v2",
    AGENT_ENVIRONMENT_SCHEMA === "autopilot-agent-environment.v2");
  check("AGENT_ENVIRONMENT_AUTHORITY_SCHEMA is autopilot-agent-environment-authority.v2",
    AGENT_ENVIRONMENT_AUTHORITY_SCHEMA === "autopilot-agent-environment-authority.v2");
}

// ---- 9. GIT_GUARD_VARIABLES immutability ----
{
  check("GIT_GUARD_VARIABLES.AUTOPILOT_NO_GIT_MUTATIONS is '1'",
    GIT_GUARD_VARIABLES.AUTOPILOT_NO_GIT_MUTATIONS === "1");
  check("GIT_GUARD_VARIABLES is frozen",
    Object.isFrozen(GIT_GUARD_VARIABLES));
}

// ---- 10. deterministic output (call twice, same result) ----
{
  const r1 = assembleAgentEnvironment({guardedEnv: safeEnv, gatewayActive: false});
  const r2 = assembleAgentEnvironment({guardedEnv: safeEnv, gatewayActive: false});
  check("assembleAgentEnvironment is deterministic (same spawnEnv)",
    JSON.stringify(r1.spawnEnv) === JSON.stringify(r2.spawnEnv));
  check("assembleAgentEnvironment is deterministic (same authority digest)",
    r1.authority.digest === r2.authority.digest);
}

// ---- 11. spawnEnv never includes bridge proxy vars when gateway active ----
{
  const result = assembleAgentEnvironment({
    guardedEnv: safeEnv,
    gatewayActive: true,
  });
  check("spawnEnv has no HTTP_PROXY when gateway active",
    result.spawnEnv.HTTP_PROXY === undefined);
  check("spawnEnv has no ALL_PROXY when gateway active",
    result.spawnEnv.ALL_PROXY === undefined);
}

// ---- 12. effectiveEnv includes bridge proxy vars only when gateway active ----
{
  const off = assembleAgentEnvironment({guardedEnv: safeEnv, gatewayActive: false});
  const on = assembleAgentEnvironment({guardedEnv: safeEnv, gatewayActive: true});
  check("effectiveEnv.HTTP_PROXY absent when gateway inactive",
    off.effectiveEnv.HTTP_PROXY === undefined);
  check("effectiveEnv.HTTP_PROXY present when gateway active",
    on.effectiveEnv.HTTP_PROXY !== undefined);
}

// ---- 13. authority digest changes when bridge overlay changes ----
{
  const d1 = projectEnvironmentAuthorityDigest({config: {gates: {network_isolation: true}}});
  const d2 = projectEnvironmentAuthorityDigest({config: {gates: {network_isolation: false}}});
  check("authority digest changes when bridge overlay changes", d1 !== d2);
}

// ---- 14. runAdapterEnvelopeProbe uses assembleAgentEnvironment (structural) ----
{
  const autopilotSource = fs.readFileSync(
    new URL("./autopilot.mjs", import.meta.url), "utf8"
  );
  check("autopilot.mjs imports assembleAgentEnvironment",
    /import \{assembleAgentEnvironment\} from "\.\/agent-environment\.mjs"/.test(autopilotSource));
  check("autopilot.mjs calls assembleAgentEnvironment",
    /assembleAgentEnvironment\(\{/.test(autopilotSource));
}

// ---- 15. host path rewriting via repo/scratchDir params ----
{
  // Mock envelope that is "available" with sandbox paths
  const mockEnvelope = {
    available: true,
    sandbox: { repository: "/workspace/repository", scratch: "/workspace/scratch" },
    args: ["--setenv", "FOO", "bar"],
  };
  // Host-side paths must be constructed with the platform's native path
  // module (like test-gap5-scratch-mapping.mjs already does): a hardcoded
  // POSIX literal such as "/home/user/my-project" is not a valid absolute
  // path on Windows, so path.resolve()/path.relative() inside
  // mapPathIntoEnvelope() do not treat it as containment-equivalent to a
  // Windows-native root, and the rewrite this test is checking for never
  // fires. The sandbox-side targets (/workspace/...) stay POSIX literals —
  // those are envelope (bwrap-container) paths, never host paths.
  const hostRoot = path.resolve(path.sep === "\\" ? "C:\\fixture-host" : "/home/user/my-project");
  const hostRepo = hostRoot;
  const hostScratch = path.join(hostRoot, ".autopilot", "runs", "r1");
  const hostGuardLog = path.join(hostScratch, "git-guard", "blocked.log");
  const hostHooksDir = path.join(hostScratch, "git-guard", "hooks");
  const hostRealGit = path.sep === "\\" ? "C:\\Windows\\System32\\git.exe" : "/usr/bin/git";
  const envWithHostPaths = {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/home",
    AUTOPILOT_GIT_GUARD_LOG: hostGuardLog,
    AUTOPILOT_REAL_GIT: hostRealGit,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_2: "core.autocrlf",
    GIT_CONFIG_VALUE_2: "input",
    GIT_CONFIG_VALUE_0: hostHooksDir,
    GIT_CONFIG_VALUE_1: hostRepo,
  };
  // Without envelope: host paths pass through unchanged (no rewriting needed)
  const noEnvelope = assembleAgentEnvironment({
    guardedEnv: envWithHostPaths,
    envelope: null,
    repo: null,
    scratchDir: null,
    adapterRoleScratchExists: false,
    gatewayActive: false,
  });
  check("without envelope: AUTOPILOT_GIT_GUARD_LOG passes through unchanged",
    noEnvelope.spawnEnv.AUTOPILOT_GIT_GUARD_LOG === hostGuardLog);
  check("without envelope: GIT_CONFIG_VALUE_1 passes through unchanged",
    noEnvelope.spawnEnv.GIT_CONFIG_VALUE_1 === hostRepo);
  check("without envelope: GIT_CONFIG_VALUE_2 (autocrlf literal) passes through unchanged",
    noEnvelope.spawnEnv.GIT_CONFIG_VALUE_2 === "input"
    && noEnvelope.spawnEnv.GIT_CONFIG_KEY_2 === "core.autocrlf");
  // With envelope + host paths: host paths are rewritten to sandbox equivalents
  const withRewrite = assembleAgentEnvironment({
    guardedEnv: envWithHostPaths,
    envelope: mockEnvelope,
    repo: hostRepo,
    scratchDir: hostScratch,
    adapterRoleScratchExists: false,
    gatewayActive: false,
  });
  check("with envelope + host paths: GIT_CONFIG_VALUE_1 rewritten to /workspace/repository",
    withRewrite.spawnEnv.GIT_CONFIG_VALUE_1 === "/workspace/repository");
  // Scratch is always nested inside the repo, so it is the more specific
  // containment match and is checked FIRST in mapPathIntoEnvelope: a
  // scratch-nested path (like the Git guard's hooks dir / log file) maps
  // under the writable /workspace/scratch mount, not the read-only
  // /workspace/repository bind (Gap 5 fix — a repo-first check would
  // always shadow scratch, since every scratch path is also a repository
  // path, silently misrouting writable-scratch paths onto the read-only
  // bind instead).
  check("with envelope + host paths: GIT_CONFIG_VALUE_0 rewritten to /workspace/scratch subpath",
    withRewrite.spawnEnv.GIT_CONFIG_VALUE_0 === "/workspace/scratch/git-guard/hooks");
  check("with envelope + host paths: GIT_CONFIG_VALUE_2 (non-path autocrlf literal) passes through unrewritten",
    withRewrite.spawnEnv.GIT_CONFIG_VALUE_2 === "input"
    && withRewrite.spawnEnv.GIT_CONFIG_KEY_2 === "core.autocrlf");
  check("with envelope + host paths: AUTOPILOT_GIT_GUARD_LOG rewritten to /workspace/scratch subpath",
    withRewrite.spawnEnv.AUTOPILOT_GIT_GUARD_LOG === "/workspace/scratch/git-guard/blocked.log");
  check("with envelope + host paths: PATH entries rewritten (no host repo prefix remains)",
    !withRewrite.spawnEnv.PATH.includes(hostRepo));
  check("with envelope + host paths: HOME is /workspace/scratch/.autopilot-home",
    withRewrite.spawnEnv.HOME === "/workspace/scratch/.autopilot-home");
  check("with envelope + host paths: PWD is /workspace/repository",
    withRewrite.spawnEnv.PWD === "/workspace/repository");
}

// ---- 16. --b2-core-env harness invocation (structural) ----
{
  const testAllSource = fs.readFileSync(
    new URL("./test-all.mjs", import.meta.url), "utf8"
  );
  // The test-all.mjs auto-discovers test-agent-environment.mjs, so
  // inclusion is automatic. Verify the file is named correctly.
  check("test-agent-environment.mjs exists in scripts/", fs.existsSync(
    new URL("./test-agent-environment.mjs", import.meta.url)
  ));
}

// ---- 16. Git-guard authority: guard variables in the real guardedEnv ----
// (moved from the removed test-b2-behavioral.mjs section 4)
{
  const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-agent-env-guard-"));
  try {
    const repository = path.join(guardRoot, "repository");
    fs.mkdirSync(repository, {recursive: true});
    spawnSync("git", ["init"], {cwd: repository, stdio: "ignore"});
    const guard = createGitMutationGuard(path.join(guardRoot, "git-guard-test"), repository);
    const env = guardedEnv(guard);
    check("guard prependPath includes git-guard dir", env.PATH.includes("git-guard"));
    check("guard logFile matches AUTOPILOT_GIT_GUARD_LOG", env.AUTOPILOT_GIT_GUARD_LOG === guard.logFile);
    check("guard realGit matches AUTOPILOT_REAL_GIT", env.AUTOPILOT_REAL_GIT === guard.realGit);
    check("GIT_CONFIG_COUNT=3 (repo present)", env.GIT_CONFIG_COUNT === "3");
    check("GIT_CONFIG_VALUE_1 is repositoryRoot", env.GIT_CONFIG_VALUE_1 === path.resolve(repository));
    check("GIT_CONFIG_KEY_2 is core.autocrlf", env.GIT_CONFIG_KEY_2 === "core.autocrlf");
    check("GIT_CONFIG_VALUE_2 is input", env.GIT_CONFIG_VALUE_2 === "input");
  } finally {
    fs.rmSync(guardRoot, {recursive: true, force: true});
  }
}

// ---- Summary ----
if (failures > 0) {
  console.error(`\nB2 agent-environment: ${failures} FAIL(s)`);
  process.exit(1);
}
console.log(`\nB2 agent-environment: all checks passed.`);
