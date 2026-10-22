#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createShellGuard } from "./shell-guard.mjs";
import { runGuardedCommand } from "./guarded-command.mjs";
import { sandboxCommandPrefix } from "./shell-guard.mjs";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-sandbox-e2e-"));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-run-"));
fs.writeFileSync(path.join(repo, "inside.txt"), "inside");
try {
  if (process.platform !== "linux") {
    console.log("sandbox regression SKIP: Linux bubblewrap sandbox is required only on Linux");
    process.exit(0);
  }

  const prefix = sandboxCommandPrefix(repo, { required: true });
  if (!prefix) {
    console.log("sandbox regression SKIP: usable bubblewrap sandbox unavailable on this runner");
    process.exit(0);
  }

  const shellGuard = createShellGuard(runDir);
  shellGuard.networkIsolationEnabled = false;
  const env = { PATH: process.env.PATH || "" };

  const result = runGuardedCommand(
    repo,
    'test "$(cat inside.txt)" = inside && test ! -e /home/$(id -un) && printf sandbox-ok',
    env,
    shellGuard,
    { label: "task.verify:implementation", untrusted: true }
  );

  assert.equal(result.status, 0, result.stderr || "untrusted command should execute inside sandbox");

  const hostEscape = path.join(repo, "host-escape.txt");
  const sandboxEscapePath = "/workspace/host-escape.txt";
  const escapeAttempt = runGuardedCommand(
    repo,
    `touch ${sandboxEscapePath} && printf escape`,
    env,
    shellGuard,
    { label: "task.verify:escape", untrusted: true }
  );
  assert.equal(escapeAttempt.status, 0);
  assert.equal(fs.existsSync(hostEscape), true, "worktree writes must remain possible inside the sandbox");

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-fake-bwrap-"));
  const fake = path.join(fakeDir, "bwrap");
  fs.writeFileSync(fake, "#!/bin/sh\necho forced-bwrap-failure >&2\nexit 77\n");
  fs.chmodSync(fake, 0o755);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeDir}${path.delimiter}${oldPath || ""}`;
    assert.equal(sandboxCommandPrefix(repo, { required: true }), null, "installed-but-unusable bwrap must fail closed");
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }

  console.log("sandbox E2E PASS: real bwrap wiring + unusable-bwrap fail-closed");
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(runDir, { recursive: true, force: true });
}
