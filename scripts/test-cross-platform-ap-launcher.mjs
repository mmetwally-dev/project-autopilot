#!/usr/bin/env node
// Cross-platform `ap` launcher test.
//
// Covers the two thin convenience launchers that sit beside the authoritative
// Node entrypoint:
//
//   bin/ap.cmd   Native Windows (CMD + PowerShell)
//   bin/ap       POSIX / WSL2 / Linux
//
// Scope and isolation rules this file obeys:
//   * Launcher MECHANICS are exercised against a disposable fixture under the
//     OS temp directory: the real launcher is copied into a path containing
//     spaces, next to a harmless fixture `ap.cjs` that only reports argv/cwd
//     and returns a requested exit code. That fixture is a deterministic
//     launcher probe, not a smoke test.
//   * Only ONE real-entrypoint parity check runs against the canonical
//     bin/ap.cjs, and only with read-only commands (`help`, and the unknown
//     command `status`, which the current CLI rejects without touching disk).
//   * No real agent CLI is invoked. No smoke repository is used.
//   * The Windows branch never invokes wsl.exe; the POSIX branch never invokes
//     a Windows executable.
//   * PATH is only ever prepended to for a CHILD process environment. The
//     parent process PATH and the permanent user/system PATH are never
//     modified.
//   * Every fixture directory is removed in a finally block.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..");
const binDir = path.join(skillRoot, "bin");
const isWindows = process.platform === "win32";

let failures = 0;
let checks = 0;
function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`ok: ${name}`);
    return;
  }
  failures += 1;
  let rendered = "";
  if (detail !== undefined) {
    try {
      rendered = ` — ${JSON.stringify(detail).slice(0, 2000)}`;
    } catch {
      rendered = ` — ${String(detail).slice(0, 2000)}`;
    }
  }
  console.error(`FAIL: ${name}${rendered}`);
}

function realpath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

const FIXTURE_MARKER_BEGIN = "AP_FIXTURE_BEGIN";
const FIXTURE_MARKER_END = "AP_FIXTURE_END";

// The harmless fixture entrypoint. It stands in for bin/ap.cjs so launcher
// mechanics (argv forwarding, cwd, exit codes, path resolution) can be
// asserted without running any real Autopilot command.
const FIXTURE_ENTRYPOINT = `#!/usr/bin/env node
'use strict';
const argv = process.argv.slice(2);
let code = 0;
for (const arg of argv) {
  if (typeof arg === 'string' && arg.indexOf('--fixture-exit=') === 0) {
    const parsed = Number(arg.slice('--fixture-exit='.length));
    if (Number.isInteger(parsed)) code = parsed;
  }
}
process.stdout.write(
  ${JSON.stringify(FIXTURE_MARKER_BEGIN)} +
  JSON.stringify({argv: argv, cwd: process.cwd(), entry: __filename}) +
  ${JSON.stringify(FIXTURE_MARKER_END)} + '\\n'
);
process.exit(code);
`;

function parseFixtureReport(stdout) {
  const begin = stdout.indexOf(FIXTURE_MARKER_BEGIN);
  const end = stdout.indexOf(FIXTURE_MARKER_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  try {
    return JSON.parse(stdout.slice(begin + FIXTURE_MARKER_BEGIN.length, end));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ap-launcher-fixture-"));
// Deliberate spaces in the launcher's own containing path (requirement 18).
const fixtureSkill = path.join(fixtureRoot, "Project Autopilot Copy");
const fixtureBin = path.join(fixtureSkill, "bin");
// A caller directory that is NOT the skill directory (requirement 19 / test D).
const callerDir = path.join(fixtureRoot, "caller working dir");

const launcherName = isWindows ? "ap.cmd" : "ap";
const sourceLauncher = path.join(binDir, launcherName);
const fixtureLauncher = path.join(fixtureBin, launcherName);

function buildFixture() {
  fs.mkdirSync(fixtureBin, {recursive: true});
  fs.mkdirSync(callerDir, {recursive: true});
  fs.copyFileSync(sourceLauncher, fixtureLauncher);
  if (!isWindows) fs.chmodSync(fixtureLauncher, 0o755);
  fs.writeFileSync(path.join(fixtureBin, "ap.cjs"), FIXTURE_ENTRYPOINT, "utf8");
}

// Prepend ONLY the fixture bin to a CHILD environment. The parent process
// environment is never mutated.
function childEnvWithFixtureBinFirst(extra = {}) {
  const env = {...process.env, ...extra};
  const key = Object.keys(env).find(name => name.toUpperCase() === "PATH") || "PATH";
  env[key] = `${fixtureBin}${path.delimiter}${env[key] || ""}`;
  return env;
}

// ---------------------------------------------------------------------------
// Shell invocation helpers
// ---------------------------------------------------------------------------

// Runs a command line through cmd.exe.
//
// These helpers deliberately go through a real shell: the assertions below are
// about what a user's shell hands to the launcher (quoting, spaces, empty
// arguments, PATH lookup of the bare name `ap`), which cannot be reproduced by
// spawning the launcher directly. They run only against the disposable fixture
// and a read-only parity command.
//
// cmd.exe is invoked explicitly rather than via Node's `shell: true` wrapper —
// the project bans `shell: true` outside the guarded executor, and being
// explicit also makes the exact command line under test visible here.
// `windowsVerbatimArguments` stops Node re-quoting, and `/s` makes cmd strip
// only the outermost quote pair, so the embedded quoting in `line` (the whole
// point of these checks) reaches the launcher untouched.
function runCmd(line, {cwd, env}) {
  return spawnSync("cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true
  });
}

// Runs a command line through PowerShell. The caller uses single-quoted
// PowerShell strings for arguments containing spaces so no double quotes need
// to survive Node's own command-line escaping.
function runPowerShell(line, {cwd, env}) {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `${line}; exit $LASTEXITCODE`],
    {cwd, env, encoding: "utf8", windowsHide: true}
  );
}

function runSh(line, {cwd, env}) {
  return spawnSync("/bin/sh", ["-c", line], {cwd, env, encoding: "utf8"});
}

// Invokes the fixture launcher through the platform's default shell, relying
// on PATH resolution of the bare name `ap`.
function runViaPath(line, {cwd, env}) {
  return isWindows ? runCmd(line, {cwd, env}) : runSh(line, {cwd, env});
}

// ---------------------------------------------------------------------------
// Filesystem-change detection for the real-entrypoint parity check
// ---------------------------------------------------------------------------

// Directory names excluded from snapshotTree, with the reason for each:
// - "node_modules": third-party dependencies, never written by the launcher.
// - ".git": git metadata, churned by fixture commits rather than ap itself.
// - ".autopilot": live mission state and operator files (state.json, run
//   logs, WATCH-REPORT.md, task-file edits), written by processes outside
//   this test — skipped ONLY at the snapshot root (depth 0), so a nested
//   ".autopilot" directory (e.g. scripts/.autopilot) is still detected.
const SNAPSHOT_EXCLUDED = new Set(["node_modules", ".git", ".autopilot"]);

function snapshotTree(root) {
  const entries = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let names;
    try {
      names = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of names) {
      if (SNAPSHOT_EXCLUDED.has(entry.name) && (entry.name !== ".autopilot" || depth === 0)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push(`D ${path.relative(root, full)}`);
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        entries.push(`F ${path.relative(root, full)} ${stat.size} ${stat.mtimeMs}`);
      }
    }
  };
  walk(root, 0);
  entries.sort();
  return crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testLauncherSourceIsThin() {
  const cmdSource = fs.readFileSync(path.join(binDir, "ap.cmd"), "utf8");
  const shSource = fs.readFileSync(path.join(binDir, "ap"), "utf8");

  check("bin/ap.cmd exists and is non-empty", cmdSource.length > 0);
  check("bin/ap exists and is non-empty", shSource.length > 0);

  // Requirement 3: no duplicated dispatch. Neither launcher may name a
  // command or a scripts/*.mjs target - only the sibling ap.cjs.
  const dispatchTargets = ["scripts/setup.mjs", "scripts\\setup.mjs", "scripts/autopilot.mjs", "runtime-mode-router", "adapter-cli"];
  for (const target of dispatchTargets) {
    check(`bin/ap.cmd does not duplicate dispatch target ${target}`, !cmdSource.includes(target));
    check(`bin/ap does not duplicate dispatch target ${target}`, !shSource.includes(target));
  }
  check("bin/ap.cmd delegates to the sibling ap.cjs", /%~dp0ap\.cjs/.test(cmdSource));
  check("bin/ap delegates to the sibling ap.cjs", /\$ap_dir\/ap\.cjs/.test(shSource));

  // Both launchers document their own isolation rules in comments, so the
  // isolation assertions below must look at executable lines only - otherwise
  // the comment explaining "never invokes wsl.exe" would trip the check.
  const cmdCode = cmdSource
    .split(/\r?\n/)
    .filter(line => !/^\s*(rem\b|::)/i.test(line))
    .join("\n");
  const shCode = shSource
    .split("\n")
    .filter(line => !/^\s*#/.test(line))
    .join("\n");

  // Requirement 17: no delayed expansion in the batch launcher.
  check("bin/ap.cmd never enables delayed expansion", !/enabledelayedexpansion/i.test(cmdSource));
  // Requirement 15 / isolation: the Windows launcher must never reach WSL.
  check(
    "bin/ap.cmd never invokes wsl.exe or a POSIX shell",
    !/wsl(\.exe)?\b/i.test(cmdCode) && !/\bbash\b/i.test(cmdCode),
    cmdCode
  );
  // Requirement 14 / isolation: the POSIX launcher must never reach Windows
  // by shelling out to interop. Naming WSL_DISTRO_NAME / WSLInterop to DETECT
  // WSL is fine; invoking wsl.exe or any .exe is not.
  check("bin/ap never invokes wsl.exe", !/wsl\.exe/i.test(shCode), shCode);
  check(
    "bin/ap never executes a Windows .exe",
    !/exec\s+\S*\.exe|\bcmd\.exe\b|\bpowershell(\.exe)?\b/i.test(shCode),
    shCode
  );
  check("bin/ap has a POSIX shebang", shSource.startsWith("#!/bin/sh"));
  check("bin/ap has no CR bytes", !shSource.includes("\r"));
  check("bin/ap.cmd uses CRLF line endings", cmdSource.includes("\r\n"));

  // Requirement 12: the Node-missing path must not offer to fetch anything.
  const fetchVerbs = /\b(curl|wget|winget|choco|scoop|apt-get|apt install|nvm install|brew install)\b/i;
  check("bin/ap.cmd Node diagnostic triggers no download/install", !fetchVerbs.test(cmdSource));
  check("bin/ap Node diagnostic triggers no download/install", !fetchVerbs.test(shSource));

  if (!isWindows) {
    const mode = fs.statSync(path.join(binDir, "ap")).mode & 0o777;
    // Requirement 16: executable where the filesystem supports it. Windows
    // drive mounts (DrvFs without metadata) report 0777 for every file, which
    // still satisfies "executable".
    check("bin/ap is executable", (mode & 0o111) !== 0, {mode: mode.toString(8)});
  }
}

function testArgumentForwarding() {
  // Requirement C: the exact documented invocations, per platform.
  const repoArg = isWindows ? "C:\\Projects\\My Project" : "/home/user/My Project";
  for (const command of ["setup", "run"]) {
    const line = isWindows
      ? `ap ${command} --repo "${repoArg}"`
      : `ap ${command} --repo "${repoArg}"`;
    const result = runViaPath(line, {cwd: callerDir, env: childEnvWithFixtureBinFirst()});
    const report = parseFixtureReport(result.stdout || "");
    check(`argv forwarded for \`${line}\``, report !== null, {stdout: result.stdout, stderr: result.stderr});
    if (report) {
      check(
        `\`${command} --repo "<path with spaces>"\` arrives as exactly 3 arguments`,
        report.argv.length === 3,
        report.argv
      );
      check(`\`${command}\` arrives first`, report.argv[0] === command, report.argv);
      check(`--repo arrives second`, report.argv[1] === "--repo", report.argv);
      check(`the space-containing repo path arrives as ONE argument`, report.argv[2] === repoArg, report.argv);
    }
  }

  // Multiple flags keep their original order.
  const orderLine = isWindows
    ? `ap run --repo "${repoArg}" --role planner --alpha one --beta two`
    : `ap run --repo "${repoArg}" --role planner --alpha one --beta two`;
  const ordered = runViaPath(orderLine, {cwd: callerDir, env: childEnvWithFixtureBinFirst()});
  const orderReport = parseFixtureReport(ordered.stdout || "");
  check("multi-flag invocation reached the fixture", orderReport !== null, {stdout: ordered.stdout, stderr: ordered.stderr});
  if (orderReport) {
    check(
      "multiple flags remain in the same order",
      JSON.stringify(orderReport.argv) ===
        JSON.stringify(["run", "--repo", repoArg, "--role", "planner", "--alpha", "one", "--beta", "two"]),
      orderReport.argv
    );
  }

  // Empty arguments. Both cmd.exe (`""`) and sh ('') support an empty
  // argument in their quoting contract, so both must preserve it.
  const emptyLine = isWindows ? `ap run "" --role planner` : `ap run '' --role planner`;
  const empty = runViaPath(emptyLine, {cwd: callerDir, env: childEnvWithFixtureBinFirst()});
  const emptyReport = parseFixtureReport(empty.stdout || "");
  check("empty-argument invocation reached the fixture", emptyReport !== null, {stdout: empty.stdout, stderr: empty.stderr});
  if (emptyReport) {
    check(
      "an empty argument is preserved in place",
      JSON.stringify(emptyReport.argv) === JSON.stringify(["run", "", "--role", "planner"]),
      emptyReport.argv
    );
  }
}

function testWorkingDirectoryPreserved() {
  // Requirement D: invoked from a directory that is not the skill directory,
  // the delegated ap.cjs must observe the caller's original cwd.
  const result = runViaPath("ap status", {cwd: callerDir, env: childEnvWithFixtureBinFirst()});
  const report = parseFixtureReport(result.stdout || "");
  check("cwd probe reached the fixture", report !== null, {stdout: result.stdout, stderr: result.stderr});
  if (report) {
    check(
      "delegated ap.cjs observes the caller's original working directory",
      realpath(report.cwd) === realpath(callerDir),
      {observed: report.cwd, expected: callerDir}
    );
    check(
      "delegated ap.cjs is the launcher's SIBLING, not one resolved from cwd",
      realpath(report.entry) === realpath(path.join(fixtureBin, "ap.cjs")),
      {observed: report.entry, expected: path.join(fixtureBin, "ap.cjs")}
    );
  }

  // Requirement 4, sharpened: a decoy ap.cjs in the caller's cwd must be
  // ignored entirely.
  const decoy = path.join(callerDir, "ap.cjs");
  fs.writeFileSync(decoy, "process.stdout.write('DECOY_ENTRYPOINT_RAN');process.exit(99);\n", "utf8");
  try {
    const decoyRun = runViaPath("ap status", {cwd: callerDir, env: childEnvWithFixtureBinFirst()});
    check(
      "an ap.cjs in the caller's cwd is never used",
      !(decoyRun.stdout || "").includes("DECOY_ENTRYPOINT_RAN") && decoyRun.status !== 99,
      {stdout: decoyRun.stdout, status: decoyRun.status}
    );
  } finally {
    fs.rmSync(decoy, {force: true});
  }
}

function testExitCodes() {
  const zero = runViaPath("ap run --fixture-exit=0", {cwd: callerDir, env: childEnvWithFixtureBinFirst()});
  check("fixture exit 0 is reported as 0 by the launcher", zero.status === 0, {status: zero.status, stderr: zero.stderr});

  const thirtySeven = runViaPath("ap run --fixture-exit=37", {cwd: callerDir, env: childEnvWithFixtureBinFirst()});
  check(
    "fixture exit 37 is reported as 37 by the launcher",
    thirtySeven.status === 37,
    {status: thirtySeven.status, stderr: thirtySeven.stderr}
  );

  const two = runViaPath("ap run --fixture-exit=2", {cwd: callerDir, env: childEnvWithFixtureBinFirst()});
  check("a non-zero exit is never converted into success", two.status === 2, {status: two.status});
}

function testPathResolution() {
  // Requirement F. Only the CHILD environment gets the fixture bin prepended.
  const parentPathBefore = process.env.PATH || process.env.Path || "";
  const env = childEnvWithFixtureBinFirst();

  if (isWindows) {
    const fromCmd = runCmd(`ap run --fixture-exit=0`, {cwd: callerDir, env});
    const cmdReport = parseFixtureReport(fromCmd.stdout || "");
    check("Native Windows: bare `ap` resolves through ap.cmd from CMD", cmdReport !== null, {
      stdout: fromCmd.stdout,
      stderr: fromCmd.stderr
    });
    if (cmdReport) {
      check(
        "CMD resolution reached the fixture bin's ap.cjs",
        realpath(cmdReport.entry) === realpath(path.join(fixtureBin, "ap.cjs")),
        cmdReport.entry
      );
    }

    const fromPs = runPowerShell(`ap run --repo 'C:\\Projects\\My Project'`, {cwd: callerDir, env});
    const psReport = parseFixtureReport(fromPs.stdout || "");
    check("Native Windows: bare `ap` resolves through ap.cmd from PowerShell", psReport !== null, {
      stdout: fromPs.stdout,
      stderr: fromPs.stderr
    });
    if (psReport) {
      check(
        "PowerShell forwards a space-containing --repo value as one argument",
        JSON.stringify(psReport.argv) === JSON.stringify(["run", "--repo", "C:\\Projects\\My Project"]),
        psReport.argv
      );
    }

    const psExit = runPowerShell(`ap run --fixture-exit=37`, {cwd: callerDir, env});
    check("PowerShell observes the exact child exit code 37", psExit.status === 37, {status: psExit.status});

    // CMD's standing rule for every .cmd shim (npm's included): one batch file
    // invoking another needs `call`, otherwise control transfers and never
    // returns. Interactive CMD and PowerShell are unaffected. Asserted here so
    // the documented `call ap ...` guidance stays honest.
    const wrapper = path.join(callerDir, "wrapper.cmd");
    fs.writeFileSync(
      wrapper,
      ["@echo off", "call ap run --fixture-exit=37", "echo CONTROL_RETURNED=%errorlevel%", "exit /b %errorlevel%", ""].join("\r\n"),
      "utf8"
    );
    try {
      const nested = runCmd(`"${wrapper}"`, {cwd: callerDir, env});
      check("nested batch: `call ap ...` returns control to the calling script", /CONTROL_RETURNED=37/.test(nested.stdout || ""), {
        stdout: nested.stdout,
        stderr: nested.stderr
      });
      check("nested batch: the exact exit code 37 survives `call`", nested.status === 37, {status: nested.status});
    } finally {
      fs.rmSync(wrapper, {force: true});
    }
  } else {
    const fromSh = runSh(`ap run --repo "/home/user/My Project"`, {cwd: callerDir, env});
    const shReport = parseFixtureReport(fromSh.stdout || "");
    check("POSIX: bare `ap` resolves through bin/ap", shReport !== null, {stdout: fromSh.stdout, stderr: fromSh.stderr});
    if (shReport) {
      check(
        "POSIX resolution reached the fixture bin's ap.cjs",
        realpath(shReport.entry) === realpath(path.join(fixtureBin, "ap.cjs")),
        shReport.entry
      );
      check(
        "POSIX forwards a space-containing --repo value as one argument",
        JSON.stringify(shReport.argv) === JSON.stringify(["run", "--repo", "/home/user/My Project"]),
        shReport.argv
      );
    }
  }

  const parentPathAfter = process.env.PATH || process.env.Path || "";
  check("the parent process PATH was not modified", parentPathBefore === parentPathAfter);
}

function testNodeUnavailable() {
  // Requirement H. A disposable, controlled child environment only: the real
  // system PATH is never removed or modified, only the child's copy.
  let env;
  let line;
  if (isWindows) {
    // Keep System32 so where.exe itself exists - the scenario under test is
    // "Node.js is not installed", not "Windows is broken".
    const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
    env = {...process.env};
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "PATH") delete env[key];
    }
    env.PATH = `${fixtureBin}${path.delimiter}${system32}`;
    line = "ap run --fixture-exit=0";
  } else {
    env = {...process.env, PATH: fixtureBin};
    line = "ap run --fixture-exit=0";
  }

  const result = runViaPath(line, {cwd: callerDir, env});
  const combined = `${result.stdout || ""}${result.stderr || ""}`;
  check("Node-unavailable: launcher exits non-zero", result.status !== 0, {status: result.status, combined});
  check(
    "Node-unavailable: a clear Node.js-required message is printed",
    /Node\.js is required to run Project Autopilot/.test(combined),
    combined
  );
  check(
    "Node-unavailable: the message tells the user to install Node themselves",
    /Install Node\.js 18 or newer/.test(combined),
    combined
  );
  check(
    "Node-unavailable: the launcher states it installs nothing",
    /never downloads, installs or modifies anything/.test(combined),
    combined
  );
  check("Node-unavailable: the delegated entrypoint never ran", !combined.includes(FIXTURE_MARKER_BEGIN), combined);
  check("Node-unavailable: no crash artifacts", !/ReferenceError|SyntaxError|EINVAL|Traceback/.test(combined), combined);
}

function testRealEntrypointParity() {
  // Requirement G. Read-only commands only, against the canonical bin/ap.cjs.
  // `help` is the confirmed read-only command; `status` is confirmed NOT a
  // command of this CLI, so it exercises the unknown-command path, which is
  // equally read-only. Neither writes anything.
  const before = snapshotTree(skillRoot);

  const cases = [
    {label: "help", args: ["help"]},
    {
      label: "status --repo <path with spaces>",
      args: ["status", "--repo", isWindows ? "C:\\Projects\\My Project" : "/home/user/My Project"]
    }
  ];

  for (const testCase of cases) {
    const direct = spawnSync(process.execPath, [path.join(binDir, "ap.cjs"), ...testCase.args], {
      cwd: callerDir,
      encoding: "utf8",
      shell: false,
      windowsHide: true
    });

    // Node refuses to spawn a .cmd file without a shell, so the Windows
    // parity run goes through cmd.exe exactly the way a user's shell would.
    // The POSIX launcher is executed directly via its shebang.
    const viaLauncher = isWindows
      ? runCmd(
          [`"${path.join(binDir, "ap.cmd")}"`, ...testCase.args.map(arg => (/[\s"]/.test(arg) ? `"${arg}"` : arg))].join(" "),
          {cwd: callerDir, env: process.env}
        )
      : spawnSync(path.join(binDir, "ap"), testCase.args, {cwd: callerDir, encoding: "utf8", shell: false});

    check(
      `real-entrypoint parity (${testCase.label}): identical exit code`,
      direct.status === viaLauncher.status,
      {direct: direct.status, launcher: viaLauncher.status, launcherStderr: viaLauncher.stderr}
    );
    check(
      `real-entrypoint parity (${testCase.label}): identical stdout`,
      (direct.stdout || "") === (viaLauncher.stdout || ""),
      {direct: (direct.stdout || "").slice(0, 400), launcher: (viaLauncher.stdout || "").slice(0, 400)}
    );
    check(
      `real-entrypoint parity (${testCase.label}): identical stderr`,
      (direct.stderr || "") === (viaLauncher.stderr || ""),
      {direct: (direct.stderr || "").slice(0, 400), launcher: (viaLauncher.stderr || "").slice(0, 400)}
    );
  }

  const after = snapshotTree(skillRoot);
  check("real-entrypoint parity caused no filesystem change under the skill root", before === after);
}

function testRegression() {
  // Requirement J: the pre-existing `node bin/ap.cjs ...` path and the
  // documented dispatch surface are untouched by this task.
  const direct = spawnSync(process.execPath, [path.join(binDir, "ap.cjs"), "help"], {
    cwd: callerDir,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  check("`node bin/ap.cjs help` still exits 0", direct.status === 0, {status: direct.status, stderr: direct.stderr});
  for (const command of ["ap setup", "ap run", "ap config", "ap adapter", "ap help"]) {
    check(`dispatch surface still advertises \`${command}\``, (direct.stdout || "").includes(command), {
      stdout: (direct.stdout || "").slice(0, 400)
    });
  }

  const dispatchShim = spawnSync(process.execPath, [path.join(binDir, "_dispatch.cjs"), "help"], {
    cwd: callerDir,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  check("`node bin/_dispatch.cjs help` still exits 0", dispatchShim.status === 0, {status: dispatchShim.status});

  // bin/ap.cjs must remain the authoritative Node entrypoint referenced by
  // package.json's bin mapping.
  const pkg = JSON.parse(fs.readFileSync(path.join(skillRoot, "package.json"), "utf8"));
  check("package.json bin mapping still points at bin/ap.cjs", pkg.bin && pkg.bin.ap === "bin/ap.cjs", pkg.bin);
}

// Self-check for snapshotTree's skip rule, on a throwaway temp directory —
// never the real repo.
function testSnapshotTreeSkipsRootAutopilotOnly() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-snapshot-tree-"));
  try {
    fs.mkdirSync(path.join(tmp, ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(tmp, ".autopilot", "state.json"), "{}\n");
    fs.mkdirSync(path.join(tmp, "scripts"), {recursive: true});
    fs.writeFileSync(path.join(tmp, "scripts", "a.mjs"), "// a\n");

    const before = snapshotTree(tmp);

    fs.writeFileSync(path.join(tmp, ".autopilot", "state.json"), "{\"x\":1}\n");
    fs.writeFileSync(path.join(tmp, ".autopilot", "new.log"), "log\n");
    check("snapshotTree ignores root-level .autopilot writes", JSON.stringify(snapshotTree(tmp)) === JSON.stringify(before));

    fs.writeFileSync(path.join(tmp, "scripts", "a.mjs"), "// a2\n");
    check("snapshotTree detects changes outside .autopilot", JSON.stringify(snapshotTree(tmp)) !== JSON.stringify(before));

    const afterEdit = snapshotTree(tmp);
    fs.mkdirSync(path.join(tmp, "scripts", ".autopilot"), {recursive: true});
    fs.writeFileSync(path.join(tmp, "scripts", ".autopilot", "x"), "x\n");
    check("snapshotTree detects nested .autopilot directories", JSON.stringify(snapshotTree(tmp)) !== JSON.stringify(afterEdit));
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------

console.log(`Cross-platform ap launcher test — platform=${process.platform} node=${process.version}`);
console.log(`Launcher under test: bin/${launcherName}`);

try {
  buildFixture();
  testLauncherSourceIsThin();
  testArgumentForwarding();
  testWorkingDirectoryPreserved();
  testExitCodes();
  testPathResolution();
  testNodeUnavailable();
  testRealEntrypointParity();
  testRegression();
  testSnapshotTreeSkipsRootAutopilotOnly();
} finally {
  fs.rmSync(fixtureRoot, {recursive: true, force: true});
  if (fs.existsSync(fixtureRoot)) {
    console.error(`WARNING: fixture directory could not be removed: ${fixtureRoot}`);
  } else {
    console.log(`ok: fixture directory removed (${fixtureRoot})`);
  }
}

if (failures > 0) {
  console.error(`Cross-platform ap launcher test FAILED — ${failures} of ${checks} checks failed.`);
  process.exit(1);
}
console.log(`Cross-platform ap launcher test PASS — ${checks} checks.`);
