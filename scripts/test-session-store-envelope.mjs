#!/usr/bin/env node
// Backlog #26 Step B (TASK-34): persistent per-task session store.
//
// The adapter's session store must survive the relay process exit (today
// HOME is a tmpfs/scratch mount destroyed on exit, so resume is impossible).
// Implementer relays bind a host dir
// `.autopilot/missions/<mission>/sessions/<task-ref>/` into the envelope —
// only the adapter's data dir (opencode `~/.local/share/opencode`, claude
// `~/.claude`), never the whole HOME. Read-only roles are unchanged (no
// mounts). Windows-native (no envelope): sessions already persist in the
// real user HOME — confirmed live (opencode.db under
// ~/.local/share/opencode; `opencode run --session <id>` returns the prior
// session's context) — so this file SKIPs the live-mount half on win32 and
// still pins the arg shape + the implementer-only forwarding statically.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {buildExecutionEnvelope, SANDBOX_HOME} from "./execution-envelope.mjs";
import {sessionStoreRelDir, sessionStoreSandboxSubpath} from "./per-task-budget.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
};

// ── Pure vocabulary (every platform) ──
check("store: rel dir mirrors the note vocabulary",
  sessionStoreRelDir("001-cap", "T2.2") === ".autopilot/missions/001-cap/sessions/T2.2");
check("store: only the adapter data dir is bound, never whole HOME",
  sessionStoreSandboxSubpath("opencode") === ".local/share/opencode"
  && sessionStoreSandboxSubpath("claude") === ".claude"
  && sessionStoreSandboxSubpath("codex") === null);
check("store: implementer-only forwarding pinned in the relay (read-only roles pass none)",
  /sessionStoreMounts: roleName==="implementer" \? sessionStoreMounts : \[\]/.test(
    fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8")));

if (process.platform === "win32") {
  console.log("test-session-store-envelope: SKIP live-mount half — requires Linux/WSL2 bubblewrap (Windows-native sessions already persist in the real HOME; see the task report probe).");
  if (failures) process.exit(1);
  console.log("session-store envelope tests passed (static half)");
  process.exit(0);
}

// ── Live envelope (Linux/WSL2 only) ──
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-session-store-repo-"));
fs.writeFileSync(path.join(repo, "probe.txt"), "probe\n");
const storeHost = fs.mkdtempSync(path.join(os.tmpdir(), "ap-session-store-host-"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ap-session-store-scratch-"));
const fakeBin = path.join(repo, "fake-adapter");
fs.writeFileSync(fakeBin, "#!/bin/sh\necho probe\n");
fs.chmodSync(fakeBin, 0o755);

const base = {repo, scratchDir: scratch, readOnly: true, config: {}, binary: fakeBin, args: ["run"]};

// Implementer relay shape: opencode data-dir bind present, writable.
const withStore = buildExecutionEnvelope({
  ...base,
  sessionStoreMounts: [{host: storeHost, sandbox: `${SANDBOX_HOME}/.local/share/opencode`}],
});
check("envelope: available with the session store bound", withStore.available === true, withStore.reason || withStore.detail);
if (withStore.available) {
  const argv = withStore.args.join("\n");
  check("envelope: data-dir bind is a writable --bind (the adapter must persist sessions)",
    withStore.args.includes("--bind") && argv.includes(storeHost)
    && argv.includes(`${SANDBOX_HOME}/.local/share/opencode`),
    withStore.args.slice(-8));
  check("envelope: whole HOME is never bound (only the data subpath)",
    !withStore.args.some((a, i) => withStore.args[i - 1] === "--bind" && a === SANDBOX_HOME),
    withStore.args.filter((a) => String(a).includes(SANDBOX_HOME)));
  check("envelope: sandbox record names the session store",
    Array.isArray(withStore.sandbox?.sessionStores) && withStore.sandbox.sessionStores.length === 1
    && withStore.sandbox.sessionStores[0].sandbox === `${SANDBOX_HOME}/.local/share/opencode`,
    withStore.sandbox?.sessionStores);
}

// Read-only roles: unchanged — no session bind when no mounts are passed.
const withoutStore = buildExecutionEnvelope({...base, sessionStoreMounts: []});
check("envelope: read-only shape carries no session bind",
  withoutStore.available === true
  && !withoutStore.args.some((a) => String(a).includes(".local/share/opencode") || String(a).includes("/.claude")),
  withoutStore.reason || withoutStore.detail);

// Fail closed on malformed/escaping mounts.
const bad = buildExecutionEnvelope({...base, sessionStoreMounts: [{host: "/nonexistent-session-store", sandbox: `${SANDBOX_HOME}/.local/share/opencode`}]});
check("envelope: invalid session store fails closed",
  bad.available === false && bad.reason === "session_store_mount_invalid", bad.reason);

fs.rmSync(repo, {recursive: true, force: true});
fs.rmSync(storeHost, {recursive: true, force: true});
fs.rmSync(scratch, {recursive: true, force: true});

if (failures) {
  console.error(`${failures} session-store envelope check(s) failed.`);
  process.exit(1);
}
console.log("session-store envelope tests passed");
