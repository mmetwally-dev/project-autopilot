// Regression: capability discovery must never launch a bare interactive CLI
// (a TUI that queries/reconfigures the user's TTY, leaving it in raw mode).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {discoverCapabilities} from "./model-discovery.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nobare-"));
const log = path.join(dir, "calls.log");
const bin = path.join(dir, "fakecli");
fs.writeFileSync(bin, `#!/bin/sh\necho "$#" >> "${log}"\necho "usage --model"\n`, {mode: 0o755});

await discoverCapabilities({binary: bin});
await discoverCapabilities({binary: bin, help_args: []});
const calls = fs.readFileSync(log, "utf8").trim().split("\n");
assert.ok(calls.every(n => Number(n) > 0), "bare (zero-arg) launch must not happen: " + calls.join(","));
fs.rmSync(dir, {recursive: true, force: true});
console.log("test-discovery-no-bare-launch passed");
