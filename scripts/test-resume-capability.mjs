import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {discoverCapabilities} from "./model-discovery.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume probe "));
const script = path.join(directory, "fake-cli.mjs");
function writeHelp(help) {
  fs.writeFileSync(script, `console.log(process.argv.includes("--help") ? ${JSON.stringify(help)} : "ok");\n`);
}
try {
  // "resume" reflects EXACT-session resume (resume_session), the only
  // mechanism the relay path ever issues — not resume_last ("--continue"),
  // which the relay never invokes even when the CLI advertises it.
  const metadata = {binary: process.execPath, help_args: [script, "--help"], probe: ["--help"], resume_last: ["--continue"], resume_session: ["--resume-session"], model_discovery: "manual"};
  writeHelp("--model");
  assert.equal((await discoverCapabilities(metadata)).resume, false);
  writeHelp("--model --continue");
  assert.equal((await discoverCapabilities(metadata)).resume, false, "resume_last alone must not be reported as exact-resume support");
  writeHelp("--model --resume-session");
  assert.equal((await discoverCapabilities(metadata)).resume, true);

  // codex-shaped metadata: no resume_session declared at all (the real
  // adapters.json codex entry, after removing it because --ephemeral makes
  // exact resume unreachable) must report resume:false without even needing
  // help text to say so.
  const codexShaped = {binary: process.execPath, help_args: [script, "--help"], probe: ["--help"], resume_last: ["exec", "resume", "--last"], model_discovery: "manual"};
  writeHelp("--model --resume --last exec resume");
  assert.equal((await discoverCapabilities(codexShaped)).resume, false, "an adapter with no resume_session must never report resume support");
} finally {
  fs.rmSync(directory, {recursive: true, force: true});
}

// Real adapters.json codex entry must declare no resume_session at all.
// Confirmed live against codex-cli 0.150.1: `codex exec resume` cannot
// accept the base write/read_only args (rejects --sandbox outright) and,
// separately, a session started with the mandatory --ephemeral flag has
// nothing on disk to resume from ("no rollout found for thread id ...").
// If this ever fires, someone re-added resume_session without re-proving
// exact resume actually works under --ephemeral — see
// test-exact-resume-adapters.mjs for the full behavioral proof.
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realAgents = JSON.parse(fs.readFileSync(path.join(skillRoot, "adapters", "agents.json"), "utf8")).adapters;
assert.equal(realAgents.codex.resume_session, undefined, "codex must not declare resume_session (exact resume is unreachable under mandatory --ephemeral)");
assert.equal((await discoverCapabilities(realAgents.codex)).resume, false, "codex capability discovery must report resume:false");

console.log("Resume capability regression PASS");
