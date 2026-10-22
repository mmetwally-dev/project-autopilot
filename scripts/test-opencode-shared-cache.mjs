#!/usr/bin/env node
// Mission 001 tasks 17-19: shared-cache proof against the real envelope.
//
// Run A  (cold):  shared-cache parameter omitted ENTIRELY (the property is
//   absent from the buildExecutionEnvelope() call, not merely null), no
//   mount, no cache env vars — the per-run status quo ante.
// Run B1 (warm):  cache seeded via the real ensureOpenCodeCacheSeeded()
//   (task 11, production defaults, no overrides), resolved `current`
//   mounted --ro-bind at /autopilot/opencode-cache plus the per-file rg
//   bind, OPENCODE_MODELS_PATH + OPENCODE_DISABLE_MODELS_FETCH live.
// Run B2 (warm):  repeat against the same already-seeded cache (seeder
//   re-invoked: fast-path no-op must return the identical snapshot).
//
// All three runs use the IDENTICAL grep-workload prompt through the
// identical envelope shape (buildExecutionEnvelope +
// mapEnvironmentIntoEnvelope + spawnSync(bwrap)), each with a fresh
// host-side scratch dir; counts are recursive regular-file counts under
// that run's own host-side <scratchDir>/.autopilot-home (never the
// sandbox-internal path), exactly like the task-1 baseline.
//
// Task 18: during B1 and B2, a zero-residue node probe runs inside the
// same envelope (same scratchDir, same mounted snapshot; it reads the
// mount, attempts mount writes that must fail, and prints PROBE_RESULT to
// stdout — it writes nothing under scratch, so B1/B2 counts stay pristine)
// asserting the task 2-3 artifacts are present/readable sandbox-side while
// the same artifacts are absent (not duplicated) host-side.
// Task 19: recursive content checksum of exactly the task 2-3 artifact
// tree within the resolved `current` snapshot before B1 and after B2
// (bookkeeping files excluded), asserted byte-identical; plus the
// in-sandbox write-failure assertion (EROFS or equivalent).
//
// Measurement note (empirical, 2026-09-17, opencode 1.18.29, DeepSeek):
// per-run HOME counts are dominated by model-latency luck, not by the
// cache. The background dependency install completes proportionally to
// run wall time (~12-13 s cliff: fast runs keep a single _cacache/tmp
// leftover, slow runs accumulate 12-30 content/index files), in BOTH cold
// and warm runs, because the final design keeps the npm cache per-run
// (reviewer finding on npm_config_cache). Observed tool-free homes are
// 9 files cold vs 9 warm; grep-workload homes were 22/22 cold vs 9/37
// warm in prototype runs, and 16 cold vs 9/9 warm in the first full run
// of THIS file (growth missed by one file there: 9 <= 0.5*16 = 8 false).
// The deterministic cache effect is ~1-2 files (models.json no
// longer fetched per run; rg served from the mount). The single-grep
// workload below is the workload that actually exercises both shared
// artifacts (catalog read + helper execution), giving the comparison its
// best honest signal; the thresholds themselves are asserted EXACTLY as
// specified (B1 <= 0.5*A, |B2-B1| <= max(5, 0.1*B1)).
// Fails closed (never skips) on Linux/WSL2 when prerequisites are missing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {buildExecutionEnvelope, mapEnvironmentIntoEnvelope, SANDBOX_HOME} from "./execution-envelope.mjs";
import {ensureOpenCodeCacheSeeded, defaultOpenCodeCacheRoot} from "./opencode-cache.mjs";
import {adapterDriver} from "./adapter-drivers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return true; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  return false;
};

if (process.platform === "win32") {
  console.log("test-opencode-shared-cache: SKIP — requires Linux/WSL2 bubblewrap + the real opencode CLI.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Prerequisites (fail closed on Linux/WSL2 — never skip).
// ---------------------------------------------------------------------------
let resolvedBinary = null;
try {
  const viaProductionResolution = adapterDriver("opencode").resolveBinary("opencode");
  if (viaProductionResolution && fs.existsSync(viaProductionResolution)) {
    resolvedBinary = fs.realpathSync(viaProductionResolution);
  }
} catch {}
check("prereq: opencode CLI resolves via the production adapter driver", !!resolvedBinary, resolvedBinary);
if (!resolvedBinary) { console.error("FAIL closed: real opencode CLI missing on Linux/WSL2."); process.exit(1); }
const authConfigured = fs.existsSync(path.join(os.homedir(), ".local", "share", "opencode", "auth.json"));
check("prereq: opencode auth credentials present (real model calls required)", authConfigured);
if (!authConfigured) { console.error("FAIL closed: no opencode auth on Linux/WSL2."); process.exit(1); }
{
  // Envelope availability probe: bwrap missing/unusable must fail closed.
  const probeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-shared-cache-probe-"));
  const probeScratch = fs.mkdtempSync(path.join(os.tmpdir(), "ap-shared-cache-probe-scratch-"));
  try {
    const probe = buildExecutionEnvelope({repo: probeRepo, scratchDir: probeScratch, readOnly: true, config: {}, binary: resolvedBinary, args: ["--version"]});
    check("prereq: real bwrap execution envelope is available", probe.available === true, probe.reason || probe.detail);
    if (!probe.available) { console.error("FAIL closed: envelope unavailable on Linux/WSL2."); process.exit(1); }
  } finally {
    fs.rmSync(probeRepo, {recursive: true, force: true});
    fs.rmSync(probeScratch, {recursive: true, force: true});
  }
}

// Production-shaped read-only agent payload (the exact
// opencodeRuntimeConfigOverride() shape: custom autopilot_readonly
// agent, scratch-allow only, snapshot:false).
const READONLY_AGENT_DEF = {
  mode: "primary",
  description: "Autopilot read-only relay role.",
  tools: {invalid: true, question: true, bash: true, read: true, glob: true, grep: true, edit: true, write: true, task: true, webfetch: true, todowrite: true, websearch: true, skill: true},
  permission: {edit: {"/workspace/scratch/**": "allow"}, external_directory: {"/workspace/scratch/**": "allow"}}
};
const OPENCODE_CONFIG_CONTENT = JSON.stringify({snapshot: false, agent: {autopilot_readonly: READONLY_AGENT_DEF}});
// Identical workload for A/B1/B2: exactly one grep-tool call (exercises the
// shared rg helper) plus the catalog read (exercises OPENCODE_MODELS_PATH).
const PROMPT = "You must use the grep tool (not read, not glob) to search for the word PINEAPPLE in the current directory. Then reply with exactly the single line CACHEGREP-OK and call no other tools.";
const WANT = "CACHEGREP-OK";

// Task 2-3 artifact tree as shipped inside a snapshot (npm-free by design:
// the embedded npm keeps the writable per-run $HOME/.npm default).
const ARTIFACT_REL = [
  "xdg-cache/opencode/models.json",
  "xdg-cache/opencode/bin/rg",
  "xdg-cache/opencode/packages"
];
const BOOKKEEPING_NAMES = new Set(["manifest.json", ".ready", ".retired-at", ".pin-lock"]);

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-shared-cache-repo-"));
  fs.writeFileSync(path.join(repo, "notes.txt"), "the tracked marker word is PINEAPPLE-42\n");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "one");
  return repo;
}
function countHomeFiles(scratchDir) {
  const home = path.join(scratchDir, ".autopilot-home");
  let n = 0;
  const files = [];
  (function rec(d) {
    let entries;
    try { entries = fs.readdirSync(d, {withFileTypes: true}); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) { n += 1; files.push(p.slice(home.length + 1)); }
    }
  })(home);
  return {n, files: files.sort(), home};
}
// Recursive content checksum scoped to EXACTLY the task 2-3 artifact paths
// within a snapshot (bookkeeping files never hashed even if encountered).
function snapshotChecksum(snapshotDir) {
  const hash = crypto.createHash("sha256");
  const hashed = [];
  const walk = (abs, rel) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (BOOKKEEPING_NAMES.has(name) || name.startsWith(".pin-handshake-") || name.startsWith(".current.tmp-")) continue;
        walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (!st.isFile()) return;
    hash.update(`file:${rel}:${st.size}:${(st.mode & 0o777).toString(8)}\n`);
    hash.update(fs.readFileSync(abs));
    hashed.push(rel);
  };
  for (const rel of ARTIFACT_REL) {
    const abs = path.join(snapshotDir, rel);
    if (!fs.existsSync(abs)) continue;
    walk(abs, rel);
  }
  return {digest: hash.digest("hex"), hashed: hashed.sort()};
}

// One real opencode run through the real envelope. For Run A the
// opencodeCacheDir property is OMITTED ENTIRELY from the envelope call
// (never passed, not even null). Returns the host-side home count.
function runOpencodeOnce({repo, label, opencodeCacheDirArg, omitCacheParam}) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), `ap-shared-cache-${label}-scratch-`));
  let opencodeCacheDir = null;
  const envelopeArgs = {repo, scratchDir, readOnly: true, config: {}, binary: resolvedBinary,
    args: ["run", "--format", "json", "--agent", "autopilot_readonly"]};
  if (!omitCacheParam) {
    // Production shape (autopilot.mjs task 14): resolve current to the
    // concrete versions path, pre-create the rg placeholder so the
    // per-file helper bind engages, and hand the generic {host,sandbox}
    // mount descriptors + matching env vars to the envelope builder —
    // execution-envelope.mjs itself has no opencode-specific knowledge.
    opencodeCacheDir = fs.realpathSync(opencodeCacheDirArg);
    const rgSource = path.join(opencodeCacheDir, "xdg-cache", "opencode", "bin", "rg");
    const placeholder = path.join(scratchDir, ".autopilot-home", ".cache", "opencode", "bin", "rg");
    if (fs.existsSync(rgSource) && !fs.existsSync(placeholder)) {
      fs.mkdirSync(path.dirname(placeholder), {recursive: true});
      fs.writeFileSync(placeholder, "");
    }
    envelopeArgs.sharedCacheMount = {host: opencodeCacheDir, sandbox: "/autopilot/opencode-cache"};
    envelopeArgs.extraEnv = {
      OPENCODE_MODELS_PATH: "/autopilot/opencode-cache/xdg-cache/opencode/models.json",
      OPENCODE_DISABLE_MODELS_FETCH: "1"
    };
    if (fs.existsSync(rgSource) && fs.existsSync(placeholder)) {
      envelopeArgs.sharedCacheCompanionMount = {host: rgSource, sandbox: `${SANDBOX_HOME}/.cache/opencode/bin/rg`};
    }
  }
  const envelope = buildExecutionEnvelope(envelopeArgs);
  check(`${label}: envelope available`, envelope.available === true, envelope.reason || envelope.detail);
  if (!envelope.available) return {scratchDir, envelope, count: -1, ok: false};
  const childEnv = mapEnvironmentIntoEnvelope({...process.env, OPENCODE_CONFIG_CONTENT}, envelope, repo, scratchDir);
  if (omitCacheParam) {
    check(`${label}: cold run maps no shared-cache env vars (task 13 gating)`,
      !("OPENCODE_MODELS_PATH" in childEnv) && !("OPENCODE_DISABLE_MODELS_FETCH" in childEnv),
      `MODELS_PATH=${childEnv.OPENCODE_MODELS_PATH} DISABLE=${childEnv.OPENCODE_DISABLE_MODELS_FETCH}`);
  } else {
    check(`${label}: warm run maps OPENCODE_MODELS_PATH at the sandbox mount`,
      childEnv.OPENCODE_MODELS_PATH === "/autopilot/opencode-cache/xdg-cache/opencode/models.json", childEnv.OPENCODE_MODELS_PATH);
    check(`${label}: warm run disables the models refetch`, childEnv.OPENCODE_DISABLE_MODELS_FETCH === "1", childEnv.OPENCODE_DISABLE_MODELS_FETCH);
  }
  const t0 = Date.now();
  const r = spawnSync(envelope.binary, envelope.args, {encoding: "utf8", shell: false, timeout: 240000, env: childEnv, input: PROMPT, cwd: os.tmpdir(), maxBuffer: 64 * 1024 * 1024});
  const out = String(r.stdout || "");
  const ok = r.status === 0 && out.includes(WANT);
  check(`${label}: real opencode run exits 0 with the exact reply`, ok, `status=${r.status} ms=${Date.now() - t0} tail=${out.slice(-300)} err=${String(r.stderr || "").slice(-300)}`);
  const {n, files} = countHomeFiles(scratchDir);
  console.log(`${label}: host .autopilot-home file count = ${n}`);
  return {scratchDir, envelope, childEnv, count: n, files, ok, opencodeCacheDir};
}

// Zero-residue in-sandbox probe: reads the mount, attempts mount writes
// (must fail EROFS-or-equivalent), echoes sandbox env. Writes NOTHING
// under scratch, so the host counts above stay pristine.
const PROBE_SOURCE = `
import fs from "node:fs";
const results = {};
function tryRead(p) { try { const b = fs.readFileSync(p); return {ok: true, bytes: b.length, mode: (fs.statSync(p).mode & 0o777).toString(8)}; } catch (e) { return {ok: false, code: e.code || String(e.message)}; } }
function tryWrite(p, data) { try { fs.writeFileSync(p, data); return "SUCCEEDED"; } catch (e) { return "DENIED:" + (e.code || e.message); } }
function tryMkdir(p) { try { fs.mkdirSync(p, {recursive: true}); return "SUCCEEDED"; } catch (e) { return "DENIED:" + (e.code || e.message); } }
results.modelsRead = tryRead("/autopilot/opencode-cache/xdg-cache/opencode/models.json");
results.rgRead = tryRead("/autopilot/opencode-cache/xdg-cache/opencode/bin/rg");
try { results.packagesIsDir = fs.statSync("/autopilot/opencode-cache/xdg-cache/opencode/packages").isDirectory(); } catch (e) { results.packagesIsDir = "ERR:" + (e.code || e.message); }
results.modelsOverwrite = tryWrite("/autopilot/opencode-cache/xdg-cache/opencode/models.json", "tampered");
results.cacheNewFile = tryWrite("/autopilot/opencode-cache/PROBE-NEW-FILE.txt", "tampered");
results.env = {OPENCODE_MODELS_PATH: process.env.OPENCODE_MODELS_PATH ?? null, OPENCODE_DISABLE_MODELS_FETCH: process.env.OPENCODE_DISABLE_MODELS_FETCH ?? null};
console.log("PROBE_RESULT=" + JSON.stringify(results));
`;
function runProbe({repo, scratchDir, opencodeCacheDir, label}) {
  const envelope = buildExecutionEnvelope({repo, scratchDir, readOnly: true, config: {},
    binary: process.execPath, args: ["--input-type=module", "-e", PROBE_SOURCE],
    sharedCacheMount: opencodeCacheDir ? {host: opencodeCacheDir, sandbox: "/autopilot/opencode-cache"} : null,
    extraEnv: opencodeCacheDir ? {
      OPENCODE_MODELS_PATH: "/autopilot/opencode-cache/xdg-cache/opencode/models.json",
      OPENCODE_DISABLE_MODELS_FETCH: "1"
    } : {}});
  check(`${label}: probe envelope available`, envelope.available === true, envelope.reason);
  if (!envelope.available) return null;
  const childEnv = mapEnvironmentIntoEnvelope(process.env, envelope, repo, scratchDir);
  const r = spawnSync(envelope.binary, envelope.args, {encoding: "utf8", shell: false, timeout: 60000, env: childEnv, cwd: os.tmpdir()});
  check(`${label}: probe subprocess exits 0`, r.status === 0, r.stderr);
  const line = String(r.stdout || "").split("\n").filter(l => l.startsWith("PROBE_RESULT=")).at(-1);
  let results = null;
  try { results = JSON.parse(line.slice("PROBE_RESULT=".length)); } catch {}
  check(`${label}: probe produced a result`, !!results, String(r.stdout || "").slice(-300));
  return results;
}

const repo = makeRepo();
const scratchDirs = [repo];
try {
  // ---- Run A (cold): parameter omitted entirely, no mount --------------
  const runA = runOpencodeOnce({repo, label: "A-cold", omitCacheParam: true});
  scratchDirs.push(runA.scratchDir);
  check("A: cold run completed (fail closed, not skipped)", runA.ok === true);
  check("A: cold home is non-empty (run did real work)", runA.count > 0, `count=${runA.count}`);
  if (!runA.ok || runA.count <= 0) { console.error("FAIL closed: cold baseline unusable."); process.exit(1); }

  // ---- Seed via the real task-11 lifecycle (production defaults) -------
  let seeded = ensureOpenCodeCacheSeeded();
  if (!seeded || !seeded.ok || !seeded.snapshotDir) {
    // One hygiene retry: a transient model-side flake stamps the cooldown
    // marker; clearing it (test-only, disposable bookkeeping) lets the
    // retry seed for real instead of short-circuiting.
    try { fs.rmSync(path.join(defaultOpenCodeCacheRoot(), ".last-seed-failure.json"), {force: true}); } catch {}
    seeded = ensureOpenCodeCacheSeeded();
  }
  check("seed: real ensureOpenCodeCacheSeeded() published/ready", !!seeded && seeded.ok === true && !!seeded.snapshotDir, JSON.stringify(seeded && {reason: seeded.reason}));
  if (!seeded || !seeded.ok || !seeded.snapshotDir) { console.error("FAIL closed: seeding failed on Linux/WSL2."); process.exit(1); }
  const snapshotB = fs.realpathSync(seeded.snapshotDir);
  check("seed: resolved snapshot is a concrete versions path", snapshotB.includes(`${path.sep}versions${path.sep}`), snapshotB);

  // Task 19 checksum: before B1.
  const checksumBefore = snapshotChecksum(snapshotB);
  check("checksum-before: covers the task 2-3 artifact paths",
    checksumBefore.hashed.includes("xdg-cache/opencode/models.json")
    && checksumBefore.hashed.includes("xdg-cache/opencode/bin/rg"), JSON.stringify(checksumBefore.hashed));
  check("checksum-before: no bookkeeping file hashed",
    !checksumBefore.hashed.some(h => [...BOOKKEEPING_NAMES].some(b => h === b || h.endsWith(`/${b}`))), JSON.stringify(checksumBefore.hashed));

  // ---- Run B1 (warm, mount active) --------------------------------------
  const runB1 = runOpencodeOnce({repo, label: "B1-warm", opencodeCacheDirArg: snapshotB, omitCacheParam: false});
  scratchDirs.push(runB1.scratchDir);
  check("B1: warm run completed (fail closed, not skipped)", runB1.ok === true);
  if (!runB1.ok) { console.error("FAIL closed: B1 unusable."); process.exit(1); }

  // ---- Run B2 (same already-seeded cache) --------------------------------
  const reseeded = ensureOpenCodeCacheSeeded();
  check("B2: seeder fast-path no-op returns the identical snapshot",
    !!reseeded && reseeded.ok === true && fs.realpathSync(reseeded.snapshotDir) === snapshotB,
    JSON.stringify(reseeded && {reason: reseeded.reason, snapshotDir: reseeded.snapshotDir}));
  const runB2 = runOpencodeOnce({repo, label: "B2-warm", opencodeCacheDirArg: snapshotB, omitCacheParam: false});
  scratchDirs.push(runB2.scratchDir);
  check("B2: warm run completed (fail closed, not skipped)", runB2.ok === true);
  if (!runB2.ok) { console.error("FAIL closed: B2 unusable."); process.exit(1); }

  // ---- Task 17: numeric thresholds (exact specified formulas) ------------
  const countA = runA.count, countB1 = runB1.count, countB2 = runB2.count;
  console.log(`counts: A=${countA} B1=${countB1} B2=${countB2}`);
  check("17: count(B1) <= 0.5 * count(A)", countB1 <= 0.5 * countA, `B1=${countB1} A=${countA}`);
  check("17: abs(count(B2)-count(B1)) <= max(5, 0.1*count(B1))",
    Math.abs(countB2 - countB1) <= Math.max(5, 0.1 * countB1), `B1=${countB1} B2=${countB2}`);

  // ---- Tasks 18+19: per-run probes + host-side assertions ----------------
  for (const [run, label] of [[runB1, "B1"], [runB2, "B2"]]) {
    const home = path.join(run.scratchDir, ".autopilot-home");
    const results = runProbe({repo, scratchDir: run.scratchDir, opencodeCacheDir: snapshotB, label: `${label}-probe`});
    if (!results) continue;
    // Sandbox-side presence (task 18): readable at the mount path.
    check(`${label}: sandbox mount serves non-empty models.json`,
      results.modelsRead?.ok === true && results.modelsRead.bytes > 1000000, JSON.stringify(results.modelsRead));
    check(`${label}: sandbox mount serves executable non-empty bin/rg`,
      results.rgRead?.ok === true && results.rgRead.bytes > 1000000 && ((parseInt(results.rgRead.mode, 8) & 0o111) !== 0), JSON.stringify(results.rgRead));
    check(`${label}: sandbox mount serves packages/ directory`, results.packagesIsDir === true, JSON.stringify(results.packagesIsDir));
    // Task 19: in-sandbox write attempts fail (EROFS or equivalent).
    for (const [key, value] of [["modelsOverwrite", results.modelsOverwrite], ["cacheNewFile", results.cacheNewFile]]) {
      const m = /^(DENIED):([A-Z]+)/.exec(value || "");
      check(`${label}: sandbox write ${key} fails read-only (EROFS or equivalent)`,
        m?.[1] === "DENIED" && ["EROFS", "EACCES", "EPERM"].includes(m?.[2]), value);
    }
    // Sandbox env wiring (task 13 live proof).
    check(`${label}: sandbox OPENCODE_MODELS_PATH points at the mount file`,
      results.env?.OPENCODE_MODELS_PATH === "/autopilot/opencode-cache/xdg-cache/opencode/models.json", JSON.stringify(results.env));
    check(`${label}: sandbox OPENCODE_DISABLE_MODELS_FETCH=1`, results.env?.OPENCODE_DISABLE_MODELS_FETCH === "1", JSON.stringify(results.env));
    // Host-side absence (task 18): reuse from the mount, not duplication.
    check(`${label}: host HOME has no duplicated models.json (catalog served from mount)`,
      !fs.existsSync(path.join(home, ".cache", "opencode", "models.json")));
    const hostRg = path.join(home, ".cache", "opencode", "bin", "rg");
    const hostRgStat = (() => { try { return fs.statSync(hostRg); } catch { return null; } })();
    // Production pre-creates an EMPTY placeholder for the per-file bind;
    // either absent or 0 bytes proves the 5MB artifact was never duplicated.
    check(`${label}: host HOME has no duplicated rg binary (absent or empty placeholder, not the 5MB artifact)`,
      hostRgStat === null || hostRgStat.size === 0,
      hostRgStat ? `size=${hostRgStat.size}` : "absent");
    if (hostRgStat) {
      const snapRgBytes = fs.statSync(path.join(snapshotB, "xdg-cache", "opencode", "bin", "rg")).size;
      check(`${label}: snapshot rg is the real multi-MB helper (reuse source)`, snapRgBytes > 1000000, `size=${snapRgBytes}`);
    }
    const hostPkgs = path.join(home, ".cache", "opencode", "packages");
    const hostPkgFiles = (() => {
      try {
        const found = [];
        (function rec(d) {
          for (const e of fs.readdirSync(d, {withFileTypes: true})) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) rec(p);
            else if (e.isFile()) found.push(p);
          }
        })(hostPkgs);
        return found;
      } catch { return []; }
    })();
    check(`${label}: host HOME packages/ holds no duplicated files`, hostPkgFiles.length === 0, JSON.stringify(hostPkgFiles.slice(0, 5)));
  }

  // Task 19 checksum: after B2, must be byte-identical to before B1.
  const checksumAfter = snapshotChecksum(snapshotB);
  check("19: snapshot artifact checksum byte-identical before-B1 vs after-B2",
    checksumAfter.digest === checksumBefore.digest,
    `before=${checksumBefore.digest} after=${checksumAfter.digest}`);
} finally {
  for (const dir of scratchDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch {}
  }
}

if (failures) {
  console.error(`${failures} opencode shared-cache check(s) failed.`);
  process.exit(1);
}
console.log("test-opencode-shared-cache: ALL CHECKS PASSED");
