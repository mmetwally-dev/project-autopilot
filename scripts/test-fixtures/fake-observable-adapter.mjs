// TASK-19 Phase 5 task 14a — a driver-backed fake adapter.
//
// Registered (test-side, via PATH) under the real `opencode` adapter id so
// `adapter-drivers.mjs`'s opencode decoder runs: unlike the `cursor` fixture
// tasks 0/13 use, this one emits real NDJSON `step_start` / `tool_use` /
// `step_finish` parts, so `driver.observe()` and `driver.decodeEvents()` are
// non-empty instead of structurally empty. The cursor fixture cannot serve
// Phase 5 because every mechanism it adds reads observations.
//
// Behavior is chosen by the same committed `.autopilot-test-scenario` file the
// other fixtures use — never an env var (the relay launch allowlist-filters the
// child environment). It answers `--version` immediately with a fixed string so
// `resolveOpenCodeVersion()`'s 30s probe can never hang, and it writes nothing
// anywhere, so it cannot seed the developer's real OpenCode cache.
import fs from "node:fs";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-opencode-observable 1.0.0\n");
  process.exit(0);
}

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

function scenario() {
  for (const candidate of [".autopilot/.autopilot-test-scenario", ".autopilot-test-scenario"]) {
    try {
      const text = fs.readFileSync(candidate, "utf8").trim();
      if (text) return text;
    } catch { /* absent — default */ }
  }
  return "success";
}

const prompt = readStdin();
const sc = scenario();

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
}
function stepStart() {
  emit({type: "step_start", part: {type: "step-start"}});
}
function stepFinish() {
  emit({type: "step_finish", part: {type: "step-finish", tokens: {input: 10, output: 5, reasoning: 0, cache: {read: 0, write: 0}}}});
}
function bash(command, exitCode = 0) {
  emit({type: "tool_use", part: {tool: "bash", state: {status: exitCode === 0 ? "completed" : "error", input: {command}, metadata: {exit: exitCode}, output: ""}}});
}
function write(filePath) {
  emit({type: "tool_use", part: {tool: "write", state: {status: "completed", input: {filePath}, metadata: {exit: 0}}}});
}

// Turn counts are deliberately independent of the scenario's tool activity so
// a test can distinguish "the turn cap fired" from "the deadline fired".
const SPINNING_TURNS = 45;
stepStart();
switch (sc) {
  case "spinning_turns":
    break;
  case "redundant_command":
    bash("npm test");
    bash("npm test");
    bash("npm test");
    break;
  case "command_after_write":
    for (let i = 0; i < 3; i += 1) { write("out.txt"); bash("npm test"); }
    break;
  case "failing_then_fixed":
    bash("npm test", 1);
    bash("npm test", 0);
    break;
  case "command_attempted_once":
    bash("npm test");
    break;
  default:
    break;
}
const turns = sc === "spinning_turns" ? SPINNING_TURNS : 1;
for (let i = 0; i < turns; i += 1) stepFinish();
emit({type: "text", part: {type: "text", text: prompt ? "fixture ok" : "fixture ok"}});
