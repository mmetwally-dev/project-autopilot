#!/usr/bin/env node
// Mission 022 (runs 45/46, code_reviewer): spawnRelayChild ran the caller's
// synchronous onStart hook (initRun + a full WATCH-REPORT render, 5.3 s on a
// 46-run mission) BEFORE writing the prompt to stdin. Claude Code 2.1.x gives
// up after 3 s of silent stdin ("no stdin data received in 3s … Input must be
// provided"), so every reviewer launch failed once the report got slow.
// Contract: the prompt reaches the child's stdin before onStart runs, so a
// slow onStart can never starve an agent that times out on empty stdin.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnRelayChild} from "./subprocess-relay.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
};

// Scratch lives inside the repo (gitignored .autopilot/test-scratch) so this
// mission's tests never write outside the repo. Inside a read-only execution
// envelope the repo is not writable (EROFS); fall back to os.tmpdir(), which
// the envelope points at its sanctioned scratch (TMPDIR=/workspace/scratch).
const makeScratch = (prefix) => {
  const repoScratch = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), ".autopilot", "test-scratch");
  try {
    fs.mkdirSync(repoScratch, {recursive: true});
    return fs.mkdtempSync(path.join(repoScratch, prefix));
  } catch (err) {
    if (!["EROFS", "EACCES", "EPERM"].includes(err?.code)) throw err;
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }
};
const tmp = makeScratch("ap-stdin-order-");
try {
  // Fake agent: like Claude's --print, waits at most 1 s for stdin data, then
  // gives up with a non-zero exit; otherwise echoes what it got.
  const agent = path.join(tmp, "impatient-agent.mjs");
  fs.writeFileSync(agent, [
    "let got = '';",
    "const giveUp = setTimeout(() => { process.stderr.write('no stdin data received in 1s\\n'); process.exit(3); }, 1000);",
    "process.stdin.on('data', (d) => { got += d; clearTimeout(giveUp); });",
    "process.stdin.on('end', () => { clearTimeout(giveUp); process.stdout.write('GOT:' + got.length); process.exit(got.length ? 0 : 4); });",
  ].join("\n"));

  const prompt = "ROLE=code_reviewer\n" + "x".repeat(36000);
  let onStartRanAfterWrite = null;
  const result = await spawnRelayChild({
    binary: process.execPath, args: [agent], cwd: tmp, env: process.env,
    stdinData: prompt, timeoutMs: 20000,
    onStart: () => {
      // Block the event loop for 2 s — twice the agent's patience.
      const end = Date.now() + 2000;
      while (Date.now() < end) { /* busy wait, like a slow sync report render */ }
      onStartRanAfterWrite = true;
    },
  });
  check("a slow synchronous onStart does not starve the agent's stdin",
    result.status === 0 && result.stdout.includes(`GOT:${prompt.length}`), {status: result.status, stdout: result.stdout, stderr: result.stderr});
  check("onStart still runs", onStartRanAfterWrite === true);
  check("no stdin write error", result.error === null, result.error);

  // Source order pin: the write/end block precedes the onStart call.
  const src = fs.readFileSync(new URL("./subprocess-relay.mjs", import.meta.url), "utf8");
  const writeAt = src.indexOf("child.stdin.write(stdinData)");
  const onStartAt = src.indexOf("onStart({pid})");
  check("source: stdin is written before onStart is called", writeAt > 0 && onStartAt > writeAt, {writeAt, onStartAt});
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}

if (failures) { console.error(`${failures} relay stdin-order check(s) failed.`); process.exit(1); }
console.log("relay stdin-before-onStart tests passed");
