// TASK 16.3B: Native Windows companion to fake-stdin-error-adapter.sh.
//
// The POSIX fixture is copied to a bare "cursor-agent" file (no extension),
// which Windows cannot spawn directly (no shell interpreter registered for
// an extensionless file, and no shell:true is permitted here). The subject
// under test — stdin EPIPE/error handling in the relay's write path
// (scripts/subprocess-relay.mjs) — is pure Node.js child-process/stdin-pipe
// mechanics with no POSIX-specific behavior, so a faithful Node port is a
// correct, direct replacement, not an approximation.
//
// Behavior (identical to the .sh original): immediately closes/destroys
// stdin without reading it, writes a diagnostic line to stderr, and exits 0
// — simulating an adapter that crashes before consuming input, so the
// orchestrator's write to its stdin hits a broken-pipe error.
import fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("fake-stdin-error-adapter 1.0.0");
  process.exit(0);
}

try { fs.closeSync(0); } catch { /* already closed */ }
process.stderr.write("adapter-stderr: stdin closed before input\n");
process.exit(0);
