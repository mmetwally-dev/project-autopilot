#!/usr/bin/env node
// Verifier brief contract tests.
//
// The verifier brief is a prompt-only construct: it must direct the verifier
// to (1) never modify the repository and never commit/push, (2) run only
// approved gate commands, (3) write ALL temporary output (Playwright specs,
// screenshots, traces, reports, browser profiles, test artifacts) inside the
// sanctioned scratch directory, and (4) emit exactly one AUTOPILOT_REVIEW
// sentinel. No certification/trusted-release assumptions remain.
//
// Task 15.4C2 correction: verifierTask() no longer inspects the filesystem
// for Playwright itself (that dependency on scripts/browser-testing.mjs's
// detectPlaywright() is gone). It only ever renders the ALREADY-COMPUTED
// discovery result passed directly as the explicit fifth argument — never
// from transient properties on the configuration object. This file proves
// that render contract directly (unit-level, no subprocess), including that
// raw absolute paths and discovery `.reason` strings never reach the
// rendered prompt. The end-to-end proof that scripts/autopilot.mjs computes
// that result against the OFFICIAL repository (not the disposable/sandboxed
// path the Verifier subprocess itself runs inside) lives in
// test-verifier-playwright-discovery.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import {verifierTask, remapRepositoryPaths, formatLinkedTestDurations, formatHeavySuiteNoParallelNote, HEAVY_E2E_SUITES, LINKED_TEST_UNMEASURED_FALLBACK, formatRedGateVerdictRule} from "./verifier-brief.mjs";
import {buildStandaloneHandoff} from "./standalone-handoff.mjs";

const gates = ["npm run lint", "npm run type-check"];
const config = {gates: {commands: gates}};
const task = "Verify T010 after implementation.";
const brief = verifierTask(task, null, "C:/scratch", config, null);

for (const command of gates) assert.ok(brief.includes(`  - ${command}`), `missing approved gate ${command}`);
assert.match(brief, /approved only these exact verification commands/i);
assert.match(brief, /trusted relay writes the central result\.json/i);
assert.match(brief, /application server must already be running/i);
assert.match(brief, /server startup belongs to trusted orchestration/i);
assert.match(brief, /read-only/i);
assert.match(brief, /sanctioned scratch directory: C:\/scratch/i);
assert.match(brief, /AUTOPILOT_REVIEW JSON sentinel/i);
assert.ok(brief.includes(task));
// Mission 024 phase 2 task 2.3: cheap EOL-normalized diff fallback, wording
// identical to the other brief builders.
assert.ok(brief.includes("git diff --ignore-cr-at-eol"), "missing EOL-normalized diff fallback");
assert.ok(brief.includes("git -c core.autocrlf=input diff"), "missing pinned -c EOL fallback equivalent");

// The scratch directive must explicitly permit the legitimate temporary
// output classes (Playwright artifacts, reports, browser profiles) while
// remaining silent about the repository (which the envelope makes read-only).
assert.match(brief, /Playwright specs, screenshots, traces, reports, browser profiles, and test artifacts/i);

// No verifier command approved / no scratch available => report-only.
const bare = verifierTask(task, null, null, {}, null);
assert.match(bare, /No verifier command is approved/);
assert.match(bare, /Scratch writing is not available/);
console.log("PASS gate/scratch contract preserved");

// ---------------------------------------------------------------------
// No config at all / no discovery passed => treated exactly like
// "neither dimension discovered" (fails safe, never silently assumes
// availability). Also proves Playwright's absence never blocks the rest
// of the contract (gates/scratch/sentinel instructions all still present).
// ---------------------------------------------------------------------
{
  const noConfigBrief = verifierTask(task, null, null, null, null);
  assert.match(noConfigBrief, /Playwright is not available for this project installation \(module and browser not discovered\)/i);
  assert.doesNotMatch(noConfigBrief, /host Playwright runtime was discovered/i);
  assert.match(noConfigBrief, /No verifier command is approved/);
  assert.match(noConfigBrief, /AUTOPILOT_REVIEW JSON sentinel/i);
  console.log("PASS missing config/discovery is treated as unavailable, never as available, and never blocks the rest of the contract");
}

// ---------------------------------------------------------------------
// Item: module missing, browser missing => reports BOTH as unavailable,
// never claims discovery.
// ---------------------------------------------------------------------
{
  const runtime = {
    readyForLaunchProbe: false,
    module: {status: "not-found", source: null},
    browser: {status: "not-found", source: null},
    failureReason: "module: no candidate; browser: no candidate"
  };
  const b = verifierTask(task, null, null, {gates: {commands: []}}, runtime);
  assert.match(b, /Playwright is not available for this project installation \(module and browser not discovered\)/i);
  assert.doesNotMatch(b, /host Playwright runtime was discovered/i);
  console.log("PASS module+browser missing reports both dimensions, never claims discovery");
}

// ---------------------------------------------------------------------
// Item: module discovered, browser missing => reports ONLY "browser", not
// "module and browser" — proving the module's real discovery is reflected
// truthfully rather than collapsed into a generic "unavailable".
// ---------------------------------------------------------------------
{
  const runtime = {
    readyForLaunchProbe: false,
    module: {status: "discovered", source: "repository", dir: "/should/never/appear/module", package: "playwright"},
    browser: {status: "not-found", source: null},
    failureReason: "browser: no candidate"
  };
  const b = verifierTask(task, null, null, {gates: {commands: []}}, runtime);
  assert.match(b, /Playwright is not available for this project installation \(browser not discovered\)/i);
  assert.doesNotMatch(b, /module and browser/i);
  assert.doesNotMatch(b, /host Playwright runtime was discovered/i);
  console.log("PASS module discovered + browser missing reports only \"browser\" as unavailable");
}

// ---------------------------------------------------------------------
// Item: browser discovered, module missing (invalid explicit override) =>
// reports ONLY "module", proving a fail-closed explicit override is
// rendered as truthfully unavailable, never as discovered.
// ---------------------------------------------------------------------
{
  const runtime = {
    readyForLaunchProbe: false,
    module: {status: "invalid-explicit-override", source: "explicit-env"},
    browser: {status: "discovered", source: "platform-cache", path: "/should/never/appear/browser"},
    failureReason: "module: PLAYWRIGHT_MODULE_DIR is set but invalid: ..."
  };
  const b = verifierTask(task, null, null, {gates: {commands: []}}, runtime);
  assert.match(b, /Playwright is not available for this project installation \(module not discovered\)/i);
  assert.doesNotMatch(b, /module and browser/i);
  assert.doesNotMatch(b, /host Playwright runtime was discovered/i);
  console.log("PASS an invalid explicit module override (browser otherwise discovered) still reports \"module\" unavailable, fails closed rather than claiming discovery");
}

// ---------------------------------------------------------------------
// Item: both discovered => truthful "host discovered" guidance, WITH
// safe source labels, and explicitly NOT a launch-success claim.
// ---------------------------------------------------------------------
{
  const runtime = {
    readyForLaunchProbe: true,
    module: {status: "discovered", source: "repository", dir: "/should/never/appear/module", package: "playwright"},
    browser: {status: "discovered", source: "package-local", path: "/should/never/appear/browser"},
    failureReason: null
  };
  const b = verifierTask(task, null, "/scratch", {gates: {commands: []}}, runtime);
  assert.match(b, /A host Playwright runtime was discovered for this project \(module source: repository; browser source: package-local\)\./i);
  assert.match(b, /does not mean a browser launch is already wired up or proven/i);
  assert.match(b, /browser-based verification may only be claimed once that command actually succeeds/i);
  console.log("PASS module+browser discovered reports truthful \"host discovered\" guidance with safe source labels, never claims launch success");
}

// ---------------------------------------------------------------------
// Item: raw absolute paths (module dir, browser path) and the discovery
// `.reason` strings (which themselves embed absolute host paths for local
// debugging) never reach the rendered prompt, in EITHER the discovered or
// unavailable branch.
// ---------------------------------------------------------------------
{
  const secretModulePath = "C:\\Users\\SECRET\\node_modules\\playwright";
  const secretBrowserPath = "/home/SECRET/.cache/ms-playwright/chromium-1091/chrome-linux/chrome";
  const secretReason = `node_modules directory does not exist: ${secretModulePath}`;
  const discoveredRuntime = {
    readyForLaunchProbe: true,
    module: {status: "discovered", source: "autopilot-runtime", dir: secretModulePath, nodeModulesDir: secretModulePath, package: "playwright"},
    browser: {status: "discovered", source: "explicit-env", path: secretBrowserPath, root: secretBrowserPath},
    failureReason: null
  };
  const bDiscovered = verifierTask(task, null, null, {gates: {commands: []}}, discoveredRuntime);
  assert.ok(!bDiscovered.includes(secretModulePath), "discovered-branch prompt leaked the module absolute path");
  assert.ok(!bDiscovered.includes(secretBrowserPath), "discovered-branch prompt leaked the browser absolute path");

  const unavailableRuntime = {
    readyForLaunchProbe: false,
    module: {status: "invalid-explicit-override", source: "explicit-env", reason: secretReason},
    browser: {status: "not-found", source: null, reason: `no Chromium executable found beneath ${secretBrowserPath}`},
    failureReason: `module: ${secretReason}`
  };
  const bUnavailable = verifierTask(task, null, null, {gates: {commands: []}}, unavailableRuntime);
  assert.ok(!bUnavailable.includes(secretModulePath), "unavailable-branch prompt leaked the module absolute path via reason");
  assert.ok(!bUnavailable.includes(secretBrowserPath), "unavailable-branch prompt leaked the browser absolute path via reason");
  assert.ok(!bUnavailable.includes(secretReason), "unavailable-branch prompt leaked a raw discovery reason string");
  console.log("PASS raw absolute paths and discovery reason strings never reach the rendered prompt, in either branch");
}

// ---------------------------------------------------------------------
// Item: verifierTask's 2nd positional parameter ("cwd") is never consulted
// for Playwright — passing an arbitrary, non-filesystem, non-null value
// must produce IDENTICAL Playwright guidance to passing null, proving the
// old cwd-based filesystem inspection is genuinely gone (not merely
// unreachable in these specific tests).
// ---------------------------------------------------------------------
{
  const runtime = {
    readyForLaunchProbe: true,
    module: {status: "discovered", source: "skill", dir: "/x", package: "@playwright/test"},
    browser: {status: "discovered", source: "platform-cache", path: "/y"},
    failureReason: null
  };
  const withNullCwd = verifierTask(task, null, "/scratch", {gates: {commands: []}}, runtime);
  const withJunkCwd = verifierTask(task, "/this/path/does/not/exist/and/is/never/inspected", "/scratch", {gates: {commands: []}}, runtime);
  assert.equal(withNullCwd, withJunkCwd, "verifierTask's cwd parameter influenced the rendered prompt — it must be fully inert for Playwright purposes");
  console.log("PASS the cwd parameter is inert — Playwright guidance comes only from the explicit runtime argument");
}

// ---------------------------------------------------------------------
// Correction: discovery flows through the explicit fifth argument, never
// through the configuration object. Different runtimes produce different
// guidance with an identical config, and the config object is deeply
// unchanged before and after the call.
// ---------------------------------------------------------------------
{
  const sharedConfig = {gates: {commands: []}};
  const before = JSON.stringify(sharedConfig);
  const missing = {
    readyForLaunchProbe: false,
    module: {status: "not-found", source: null},
    browser: {status: "not-found", source: null},
    failureReason: "none"
  };
  const present = {
    readyForLaunchProbe: true,
    module: {status: "discovered", source: "repository", dir: "/x", package: "playwright"},
    browser: {status: "discovered", source: "package-local", path: "/y"},
    failureReason: null
  };
  const bMissing = verifierTask(task, null, null, sharedConfig, missing);
  const bPresent = verifierTask(task, null, null, sharedConfig, present);
  assert.match(bMissing, /Playwright is not available/i);
  assert.match(bPresent, /host Playwright runtime was discovered/i);
  assert.notEqual(bMissing, bPresent, "explicit runtime argument had no effect on rendered guidance");
  assert.equal(JSON.stringify(sharedConfig), before, "configuration object was mutated by verifierTask");
  assert.ok(!("hiddenRuntime" in sharedConfig), "unexpected transient property on configuration object");
  assert.ok(!Object.keys(sharedConfig).some((k) => k.startsWith("__playwright")), "transient runtime property leaked onto configuration object");
  console.log("PASS discovery flows through the explicit argument and the configuration object stays deeply unchanged");
}

// ---------------------------------------------------------------------
// Correction: production source never creates a hidden runtime property on
// the configuration object.
// ---------------------------------------------------------------------
{
  const autoSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  const briefSrc = fs.readFileSync(new URL("./verifier-brief.mjs", import.meta.url), "utf8");
  const hiddenName = `__${"playwright"}Runtime`;
  assert.ok(!autoSrc.includes(hiddenName), "production autopilot source still references a hidden runtime property");
  assert.ok(!briefSrc.includes(hiddenName), "production brief source still references a hidden runtime property");
  assert.match(autoSrc, /verifierTask\(task,promptRepository,promptScratch,c,playwrightRuntimeForVerifier\)/);
  console.log("PASS no hidden runtime property remains in production sources and the explicit call shape is present");
}

// ---------------------------------------------------------------------
// Correction: complete-prompt repository path remapping (unit-level).
// ---------------------------------------------------------------------
{
  // WSL-style: official host path -> /workspace/repository, suffix kept.
  const official = "/tmp/official-repo-abc123";
  const visible = "/workspace/repository";
  const prompt = `Verify phase.\nTasks:\n- Do work (${official}/specs/903-x/tasks.md:3)\nRepo: ${official}\nDone.`;
  const remapped = remapRepositoryPaths(prompt, official, visible);
  assert.ok(!remapped.includes(official), "remapped prompt still contains the official root");
  assert.ok(remapped.includes(`${visible}/specs/903-x/tasks.md:3`), "relative suffix with line reference was not preserved");
  assert.ok(remapped.includes(`Repo: ${visible}`), "bare root was not remapped");
  console.log("PASS WSL-style complete-prompt remapping preserves suffixes including line references");
}

{
  // Windows-style with backslashes: exact-case remap works on any platform.
  const official = "C:\\repo";
  const visible = "D:\\disposable\\repository";
  const prompt = `Tasks:\n- Do work (${official}\\specs\\902-x\\tasks.md:12)\nRepo: ${official}\nDone.`;
  const remapped = remapRepositoryPaths(prompt, official, visible);
  assert.ok(!remapped.includes(official), "windows backslash root still present after remap");
  assert.ok(remapped.includes(`${visible}\\specs\\902-x\\tasks.md:12`), "windows suffix was not preserved");
  console.log("PASS Windows backslash complete-prompt remapping preserves suffixes");
}

{
  // Slash/backslash variants: forward-slash spelling of a backslash root.
  const official = "C:\\repo";
  const visible = "D:\\disposable\\repository";
  const prompt = `See C:/repo/specs/902-x/tasks.md:7 for details.`;
  const remapped = remapRepositoryPaths(prompt, official, visible);
  assert.ok(!remapped.toLowerCase().includes("c:/repo"), "forward-slash spelling was not remapped");
  assert.ok(remapped.includes("tasks.md:7"), "line reference was not preserved through slash-variant remap");
  assert.ok(remapped.includes(visible), "visible repository was not inserted for slash-variant");
  console.log("PASS slash/backslash variants are handled");
}

{
  // Similar-prefix paths are never rewritten.
  const official = "C:\\repo";
  const visible = "D:\\disposable\\repository";
  const outside = "C:\\repo-other\\specs\\tasks.md:3";
  const prompt = `Outside: ${outside}\nInside: ${official}\\tasks.md:1`;
  const remapped = remapRepositoryPaths(prompt, official, visible);
  assert.ok(remapped.includes(outside), "similar-prefix outside path was incorrectly rewritten");
  assert.ok(!remapped.includes(`${official}\\tasks.md`), "inside path was not remapped");
  assert.ok(remapped.includes(`${visible}\\tasks.md:1`), "inside path did not map to the visible repository");
  console.log("PASS similar-prefix paths are preserved while true children are remapped");
}

{
  // Unrelated prose, URLs, and non-repository paths are untouched.
  const official = "/tmp/official-repo-xyz";
  const visible = "/workspace/repository";
  const prompt = `See https://example.com/docs for help.\nHome: /home/user/.cache/ms-playwright/chrome\nTask: ${official}/a.md:1`;
  const remapped = remapRepositoryPaths(prompt, official, visible);
  assert.ok(remapped.includes("https://example.com/docs"), "URL was rewritten");
  assert.ok(remapped.includes("/home/user/.cache/ms-playwright/chrome"), "unrelated absolute path was rewritten");
  assert.ok(remapped.includes(`${visible}/a.md:1`), "repository path was not remapped");
  console.log("PASS unrelated prose, URLs, and outside paths are untouched");
}

// ---------------------------------------------------------------------
// Correction 2: explicit left/right boundary rules. Exact-equality
// assertions (not substring searches) so sibling paths that contain the
// official string as a substring cannot false-pass.
// ---------------------------------------------------------------------
{
  const official = "/tmp/repo";
  const visible = "/workspace/repository";
  assert.equal(remapRepositoryPaths(`${official}/file`, official, visible), `${visible}/file`);
  assert.equal(remapRepositoryPaths(official, official, visible), visible);
  assert.equal(remapRepositoryPaths(`${official}/tasks.md:12`, official, visible), `${visible}/tasks.md:12`);
  console.log("PASS POSIX valid child, bare root, and line references remapped");
}
{
  const official = "/tmp/repo";
  const visible = "/workspace/repository";
  assert.equal(remapRepositoryPaths("/var/tmp/repo/file", official, visible), "/var/tmp/repo/file");
  assert.equal(remapRepositoryPaths("/tmp/repo.backup/file", official, visible), "/tmp/repo.backup/file");
  assert.equal(remapRepositoryPaths("/tmp/repo-other/file", official, visible), "/tmp/repo-other/file");
  assert.equal(remapRepositoryPaths("/tmp/repo_other/file", official, visible), "/tmp/repo_other/file");
  assert.equal(remapRepositoryPaths("/tmp/repo2/file", official, visible), "/tmp/repo2/file");
  console.log("PASS POSIX embedded parent and dot/hyphen/underscore/alphanumeric siblings preserved");
}
{
  const official = "C:\\repo";
  const visible = "D:\\disposable\\repository";
  assert.equal(remapRepositoryPaths("C:\\repo\\file", official, visible), "D:\\disposable\\repository\\file");
  assert.equal(remapRepositoryPaths("C:/repo/file", official, visible), "D:\\disposable\\repository/file");
  assert.equal(remapRepositoryPaths("C:\\repo", official, visible), "D:\\disposable\\repository");
  assert.equal(remapRepositoryPaths("C:\\repo\\tasks.md:12", official, visible), "D:\\disposable\\repository\\tasks.md:12");
  assert.equal(remapRepositoryPaths("C:\\repo.backup\\file", official, visible), "C:\\repo.backup\\file");
  assert.equal(remapRepositoryPaths("C:\\repo-other\\file", official, visible), "C:\\repo-other\\file");
  assert.equal(remapRepositoryPaths("C:\\repo_other\\file", official, visible), "C:\\repo_other\\file");
  assert.equal(remapRepositoryPaths("C:\\repo2\\file", official, visible), "C:\\repo2\\file");
  assert.equal(remapRepositoryPaths("XC:\\repo\\file", official, visible), "XC:\\repo\\file");
  assert.equal(remapRepositoryPaths("prefix-C:\\repo\\file", official, visible), "prefix-C:\\repo\\file");
  console.log("PASS Windows child/slash/bare/line-ref remapped; dot/hyphen/underscore/alphanumeric and embedded tokens preserved");
}
{
  // Windows case-insensitivity holds on Windows; on POSIX the matcher is
  // (correctly) case-sensitive, and the Windows run of this same file
  // proves the insensitive behavior there.
  const official = "C:\\repo";
  const visible = "D:\\disposable\\repository";
  if (process.platform === "win32") {
    assert.equal(remapRepositoryPaths("c:\\repo\\file", official, visible), "D:\\disposable\\repository\\file");
    assert.equal(remapRepositoryPaths("C:\\REPO\\file", official, visible), "D:\\disposable\\repository\\file");
    console.log("PASS Windows case variants remapped (case-insensitive)");
  } else {
    assert.equal(remapRepositoryPaths("C:\\repo\\file", official, visible), "D:\\disposable\\repository\\file");
    console.log("PASS Windows exact-case remap verified on POSIX (case variants covered by the Windows run)");
  }
}

// ---------------------------------------------------------------------
// Correction 3: internal ".." that stays inside the official repository is
// preserved and still remapped normally (item A) — the pre-existing
// Correction 2 tests above never exercised an actual ".." segment.
// ---------------------------------------------------------------------
{
  const official = "/tmp/repo";
  const visible = "/workspace/repository";
  assert.equal(remapRepositoryPaths(`${official}/sub/../file`, official, visible), `${visible}/sub/../file`);
  assert.equal(remapRepositoryPaths(`${official}/./file`, official, visible), `${visible}/./file`);
  console.log("PASS POSIX internal \"..\"/\".\" that stays inside the root is preserved and still remapped");
}
{
  const official = "C:\\repo";
  const visible = "D:\\disposable\\repository";
  assert.equal(remapRepositoryPaths(`${official}\\sub\\..\\file`, official, visible), `${visible}\\sub\\..\\file`);
  console.log("PASS Windows internal \"..\" that stays inside the root is preserved and still remapped");
}

// ---------------------------------------------------------------------
// Correction 3: a traversal path whose normalized target escapes the
// official repository must never be rewritten as a visible-repository
// descendant, and must never expose the official host path either — the
// complete escaping token is replaced with the stable placeholder.
// ---------------------------------------------------------------------
{
  const official = "/tmp/repo";
  const visible = "/workspace/repository";
  const placeholder = "<outside-repository-path>";
  assert.equal(remapRepositoryPaths(`${official}/../secret`, official, visible), placeholder);
  assert.equal(remapRepositoryPaths(`${official}/sub/../../secret`, official, visible), placeholder);
  const embedded = `Task: ${official}/../secret is out of bounds.`;
  const remappedEmbedded = remapRepositoryPaths(embedded, official, visible);
  assert.equal(remappedEmbedded, `Task: ${placeholder} is out of bounds.`);
  assert.ok(!remappedEmbedded.includes(official), "escaping traversal prompt still exposed the official root");
  console.log("PASS POSIX escaping traversal is replaced with the safe placeholder, never a visible descendant, never the official root");
}
{
  const official = "C:\\repo";
  const visible = "D:\\disposable\\repository";
  const placeholder = "<outside-repository-path>";
  assert.equal(remapRepositoryPaths(`${official}\\..\\secret`, official, visible), placeholder);
  assert.equal(remapRepositoryPaths(`${official}\\sub\\..\\..\\secret`, official, visible), placeholder);
  console.log("PASS Windows escaping traversal is replaced with the safe placeholder, never a visible descendant, never the official root");
}
{
  // Escaping and genuine references side by side in the same prompt: only
  // the escaping one is replaced; the genuine one still remaps normally;
  // the official root is gone from the complete prompt either way.
  const official = "/tmp/repo";
  const visible = "/workspace/repository";
  const placeholder = "<outside-repository-path>";
  const prompt = `Escaping: ${official}/../secret\nGenuine: ${official}/file`;
  const remapped = remapRepositoryPaths(prompt, official, visible);
  assert.equal(remapped, `Escaping: ${placeholder}\nGenuine: ${visible}/file`);
  assert.ok(!remapped.includes(official), "official root leaked when an escaping and a genuine reference share one prompt");
  console.log("PASS escaping and genuine references in the same prompt are handled independently, official root never leaks");
}

// ---------------------------------------------------------------------
// Correction 3: file:// URL references to the official repository. These
// are not caught by the plain-path pass (the "/" of "file://" blocks the
// left-boundary check by design) and need their own handling.
// ---------------------------------------------------------------------
{
  const official = "/tmp/repo";
  const visible = "/workspace/repository";
  assert.equal(remapRepositoryPaths("file:///tmp/repo/file", official, visible), "file:///workspace/repository/file");
  assert.equal(remapRepositoryPaths("file:///tmp/repo/tasks.md:12", official, visible), "file:///workspace/repository/tasks.md:12");
  const remapped = remapRepositoryPaths("See file:///tmp/repo/file for details.", official, visible);
  assert.ok(!remapped.includes(official), "POSIX file URL still exposed the official root");
  assert.ok(remapped.includes("file:///workspace/repository/file"), "POSIX file URL was not remapped to the visible repository");
  console.log("PASS POSIX file:// URLs are remapped to the visible repository, preserving line references");
}
{
  const official = "C:\\repo";
  const visible = "D:\\disposable\\repository";
  const remapped = remapRepositoryPaths("file:///C:/repo/file", official, visible);
  assert.equal(remapped, "file:///D:/disposable/repository/file");
  assert.ok(!remapped.includes("\\"), "Windows file:// URL remap introduced a malformed mixed-slash URL");
  console.log("PASS Windows drive-letter file:// URLs are remapped to a well-formed visible file:// URL, never mixed-slash");
}
{
  if (process.platform === "win32") {
    const official = "C:\\repo";
    const visible = "D:\\disposable\\repository";
    assert.equal(remapRepositoryPaths("file:///c:/repo/file", official, visible), "file:///D:/disposable/repository/file");
    assert.equal(remapRepositoryPaths("file:///C:/REPO/file", official, visible), "file:///D:/disposable/repository/file");
    console.log("PASS Windows file:// URL case variants remapped (case-insensitive) on Native Windows");
  } else {
    console.log("PASS Windows file:// URL case-insensitivity covered by the Native Windows run of this same file");
  }
}
{
  // file:// URL sibling/embedded preservation: a URL referencing a
  // similar-prefix sibling path must never be rewritten.
  const official = "/tmp/repo";
  const visible = "/workspace/repository";
  const outsideUrl = "file:///tmp/repo-other/file";
  assert.equal(remapRepositoryPaths(outsideUrl, official, visible), outsideUrl);
  console.log("PASS file:// URL referencing a similar-prefix sibling path is preserved verbatim");
}
{
  // file:// URL escaping traversal: never exposes the official root, never
  // rewritten as a visible descendant.
  const official = "/tmp/repo";
  const visible = "/workspace/repository";
  const placeholder = "<outside-repository-path>";
  const remapped = remapRepositoryPaths("file:///tmp/repo/../secret", official, visible);
  assert.equal(remapped, placeholder);
  assert.ok(!remapped.includes(official), "escaping file:// URL still exposed the official root");
  console.log("PASS file:// URL escaping traversal is replaced with the safe placeholder, never exposes the official root");
}

// ---------------------------------------------------------------------
// Mission 025 phase 4 task 4.4: duration lines plus the heavy-suite
// no-parallel rule in both loops' verifier briefs. Unit-level render
// checks plus standalone brief-text checks (live gate result over
// persisted history) plus SpecKit wiring checks over autopilot.mjs.
// ---------------------------------------------------------------------
{
  const measured = formatLinkedTestDurations(
    ["node scripts/test-a.mjs"], {"node scripts/test-a.mjs": 123});
  assert.ok(measured.includes("node scripts/test-a.mjs"), "measured duration line missing the command");
  assert.ok(measured.includes("123 ms"), "measured duration line missing the ms sample");
  assert.ok(measured.includes("(measured)"), "measured duration line missing the (measured) marker");
  assert.match(measured, /never impose a shorter timeout/i, "measured header must forbid a shorter timeout");
  console.log("PASS verifier duration renderer states each linked test's measured duration");
}
{
  const unmeasured = formatLinkedTestDurations(["node scripts/test-b.mjs"], {});
  assert.ok(unmeasured.includes("node scripts/test-b.mjs"), "unmeasured linked test silently omitted");
  assert.ok(unmeasured.includes(LINKED_TEST_UNMEASURED_FALLBACK), "unmeasured fallback text missing");
  assert.match(unmeasured, /do not impose a shorter timeout than the role deadline/i);
  assert.equal(formatLinkedTestDurations([], {}), "", "empty linked set must render empty");
  assert.equal(formatLinkedTestDurations(null, null), "", "null linked input must render empty");
  console.log("PASS verifier duration renderer falls back explicitly when unmeasured, empty when no linked commands");
}
{
  const note = formatHeavySuiteNoParallelNote();
  assert.ok(note.trim().length > 0, "heavy-suite no-parallel note is empty");
  for (const suite of HEAVY_E2E_SUITES) assert.ok(note.includes(suite), `heavy-suite note missing '${suite}'`);
  assert.match(note, /do not run in parallel/i, "heavy-suite note must forbid parallel runs");
  assert.match(note, /serially/i, "heavy-suite note must instruct serial runs");
  console.log("PASS verifier no-parallel note names the heavy suites and instructs serial runs");
}
{
  const phaseTasks = [{file: "/repo/TASKS.md", line: 3, text: "Do the thing"}];
  const gateResult = {command: "node scripts/test-a.mjs", ok: true, exitCode: 0, durationMs: 789, logFile: null, tail: "ok",
    results: [{command: "node scripts/test-a.mjs", ok: true, exitCode: 0, durationMs: 789, logFile: null, tail: "ok"}]};
  const handoff = buildStandaloneHandoff({kind: "PHASE_VERIFY",
    phaseName: "Phase 1 — Build", phaseIndex: 0, phaseTotal: 1, phaseTasks, attempt: 1,
    deltaChunks: [{path: "a.js", text: "diff"}], baselineKey: "mission-025-p4",
    declaredPaths: [], implementationSummary: "",
    gateResult, gateHistory: {}, linkedVerifyCommands: ["node scripts/test-a.mjs"]});
  assert.ok(handoff.text.includes("node scripts/test-a.mjs"), "standalone verifier brief missing the linked command");
  assert.ok(handoff.text.includes("789 ms"), "standalone verifier brief missing the measured duration");
  for (const suite of HEAVY_E2E_SUITES) assert.ok(handoff.text.includes(suite), `standalone verifier brief missing heavy suite '${suite}'`);
  assert.match(handoff.text, /do not run in parallel/i, "standalone verifier brief missing the no-parallel instruction");
  // History-only source: no live durationMs, sample comes from persisted
  // gate history; unmeasured command still gets the explicit fallback.
  const historyHandoff = buildStandaloneHandoff({kind: "PHASE_VERIFY",
    phaseName: "Phase 1 — Build", phaseIndex: 0, phaseTotal: 1, phaseTasks, attempt: 1,
    deltaChunks: [{path: "a.js", text: "diff"}], baselineKey: "mission-025-p4",
    declaredPaths: [], implementationSummary: "",
    gateResult: null, gateHistory: {"node scripts/test-h.mjs": 654}, linkedVerifyCommands: ["node scripts/test-h.mjs", "node scripts/test-u.mjs"]});
  assert.ok(historyHandoff.text.includes("654 ms"), "standalone verifier brief missing the history-sourced duration");
  assert.ok(historyHandoff.text.includes("node scripts/test-u.mjs"), "standalone verifier brief omitted the unmeasured linked test");
  assert.ok(historyHandoff.text.includes(LINKED_TEST_UNMEASURED_FALLBACK), "standalone verifier brief missing the unmeasured fallback");
  console.log("PASS standalone verifier brief states durations (live + history) and the no-parallel rule");
}
{
  // SpecKit loop: the verifier prompt is composed inline in autopilot.mjs,
  // so assert the composition wires both sections (durations from the
  // just-run gate over history, plus the unconditional no-parallel note).
  const autoSrc = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  assert.ok(autoSrc.includes("const verifyDurations=formatLinkedTestDurations(linkedVerifyCommandsForPhase(phaseTasks"), "SpecKit verifier durations wiring missing");
  assert.ok(autoSrc.includes("const heavyNoParallelVerify=formatHeavySuiteNoParallelNote()"), "SpecKit verifier no-parallel wiring missing");
  assert.ok(autoSrc.includes("const reviewDurations=formatLinkedTestDurations(linkedVerifyCommandsForPhase(phaseTasks"), "SpecKit reviewer durations wiring missing");
  assert.ok(autoSrc.includes("const speckitFinalNoParallel=formatHeavySuiteNoParallelNote()"), "SpecKit final-review no-parallel wiring missing");
  console.log("PASS SpecKit reviewer/verifier/final prompts wire durations and the no-parallel rule");
}

// ---------------------------------------------------------------------
// Mission 065 phase 1 task 1.1: formatRedGateVerdictRule direct unit
// assertions — non-empty rule only for red gates, "" for green/empty,
// in both gate shapes (results array and single ok/command).
// ---------------------------------------------------------------------
{
  const redResults = formatRedGateVerdictRule({results: [
    {command: "node scripts/test-a.mjs", ok: true},
    {command: "node scripts/test-b.mjs", ok: false},
  ]});
  assert.ok(typeof redResults === "string" && redResults.length > 0, "red results-array gate must return a non-empty rule");
  assert.match(redResults, /return FAIL at once/i);
  assert.match(redResults, /failing files/i);
  assert.match(redResults, /first failing check/i);
  assert.match(redResults, /mapped to tasks where possible/i);
  assert.match(redResults, /do not investigate the cause/i);
  assert.match(redResults, /at most one confirmatory/i);
  console.log("PASS red-gate rule fires for a red results-array gate");
}
{
  const redSingle = formatRedGateVerdictRule({command: "node scripts/test-a.mjs", ok: false});
  assert.ok(typeof redSingle === "string" && redSingle.length > 0, "red single-shape gate must return a non-empty rule");
  assert.match(redSingle, /return FAIL at once/i);
  console.log("PASS red-gate rule fires for a red single-shape gate");
}
{
  assert.equal(formatRedGateVerdictRule({results: [{command: "node scripts/test-a.mjs", ok: true}]}), "", "green results-array gate must return empty");
  assert.equal(formatRedGateVerdictRule({command: "node scripts/test-a.mjs", ok: true}), "", "green single-shape gate must return empty");
  assert.equal(formatRedGateVerdictRule(null), "", "null gate must return empty");
  assert.equal(formatRedGateVerdictRule(undefined), "", "undefined gate must return empty");
  assert.equal(formatRedGateVerdictRule({}), "", "empty object gate must return empty");
  assert.equal(formatRedGateVerdictRule({ok: true}), "", "command-less ok gate must return empty");
  console.log("PASS red-gate rule is empty for green and empty gates in both shapes");
}

console.log("verifier brief contract tests passed");
