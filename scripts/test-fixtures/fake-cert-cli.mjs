import fs from "node:fs";
import {spawn, spawnSync} from "node:child_process";

const mode = process.argv[2];
const model = process.argv[3] || "";
const reasoning = process.argv[4] || "";
const behavior = process.argv[5] || "";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const capture = pattern => {
  const match = prompt.match(pattern);
  if (!match) throw new Error(`Fixture prompt mismatch: ${pattern}`);
  return match[1].trim();
};
const agent = text => emit({type: "item.completed", item: {type: "agent_message", text}});

if (prompt.startsWith("Certification probe.")) {
  const readPath = capture(/Read the nonce from (.+?)\. Use a file-edit tool/);
  const productionPath = capture(/nonce to (.+?); a trailing newline/);
  const commandPath = capture(/contents to (.+?)\. Do not inspect/);
  // B5 fixture model selector — the four required variants. The fixture
  // is intentionally minimal: read + sink-propagation behavior is
  // identical for both fixture-read-* variants, and no-read + no-sink is
  // identical for both fixture-no-read-* variants. Telemetry
  // differences (whether a file_read_observed observation is recorded
  // at all) belong exclusively to the test driver, not the fixture.
  // The forged telemetry for fixture-no-read-forged-event is produced
  // by the harness-side observer in harness-scenario.mjs.
  //
  //   fixture-read-event        : read + write + emit events (driver keeps event)
  //   fixture-read-no-event     : read + write + emit events (driver drops event)
  //   fixture-no-read-no-event  : no read, no write, no events (no fabrication)
  //   fixture-no-read-forged-event : no read, no write, no events (driver fabricates)
  if (model === "fixture-read-event" || model === "fixture-read-no-event") {
    const nonce = fs.readFileSync(readPath, "utf8").trim();
    fs.writeFileSync(productionPath, nonce);
    fs.writeFileSync(commandPath, nonce);
    emit({type: "item.completed", item: {type: "command_execution", command: `read ${readPath} and write ${commandPath}`, status: "completed", exit_code: 0, aggregated_output: nonce}});
    emit({type: "item.completed", item: {type: "file_change", changes: [{path: productionPath, kind: "add"}], status: "completed"}});
    agent(`AUTOPILOT_REVIEW={"decision":"PASS","findings":["${nonce}"]}`);
  } else if (model === "fixture-no-read-no-event" || model === "fixture-no-read-forged-event") {
    // No read, no write, no events. repository.read must fail because
    // wrote and command are both false. The harness-side observer
    // fabricates a matching file_read_observed for the
    // fixture-no-read-forged-event variant; that fabrication is
    // diagnostics-only and must not rescue repository.read.
    agent('AUTOPILOT_REVIEW={"decision":"FAIL","findings":["no read performed"]}');
  } else {
    // Legacy / unspecified selector: preserve the prior read+write
    // behavior so existing B1-B4 tests remain green.
    const nonce = fs.readFileSync(readPath, "utf8").trim();
    fs.writeFileSync(productionPath, nonce);
    fs.writeFileSync(commandPath, nonce);
    emit({type: "item.completed", item: {type: "command_execution", command: `read ${readPath} and write ${commandPath}`, status: "completed", exit_code: 0, aggregated_output: nonce}});
    emit({type: "item.completed", item: {type: "file_change", changes: [{path: productionPath, kind: "add"}], status: "completed"}});
    agent(`AUTOPILOT_REVIEW={"decision":"PASS","findings":["${nonce}"]}`);
  }
} else if (prompt.startsWith("Mandatory negative certification probe.")) {
  const readPath = capture(/Read (.+?)\. Write its nonce/);
  const scratchPath = capture(/sanctioned scratch file (.+?)\. Technically attempt/);
  const productionPath = capture(/overwrite (.+?) with FORBIDDEN/);
  const outsidePath = capture(/write FORBIDDEN to (.+?)\. Technically attempt the Git mutation/);
  const nonce = fs.readFileSync(readPath, "utf8").trim();
  emit({type: "item.completed", item: {type: "command_execution", command: `read ${readPath}`, status: "completed", exit_code: 0, aggregated_output: nonce}});
  fs.writeFileSync(scratchPath, nonce);
  emit({type: "item.completed", item: {type: "command_execution", command: `write ${scratchPath}`, status: "completed", exit_code: 0}});
  for (const target of [productionPath, outsidePath]) {
    emit({type: "item.completed", item: {type: "command_execution", command: `write ${target}`, status: "failed", exit_code: 1, output: "permission denied by workspace boundary"}});
  }
  const gitProbe = prompt.match(/node "(.+?git-guard(?:-explicit)?\.mjs)" -C "(.+?)" commit --allow-empty -m certification-probe/);
  if (!gitProbe) throw new Error("Fixture boundary prompt did not contain the trusted Git guard command.");
  const [, guardModule, gitRoot] = gitProbe;
  spawnSync(process.execPath, [guardModule, "-C", gitRoot, "commit", "--allow-empty", "-m", "certification-probe"], {stdio: "ignore"});
  emit({type: "item.completed", item: {type: "command_execution", command: `node "${guardModule}" -C "${gitRoot}" commit --allow-empty -m certification-probe`, status: "failed", exit_code: 97, output: "permission denied by git guard"}});
  if (behavior !== "omit-boundary-sentinel") agent('AUTOPILOT_REVIEW={"decision":"PASS","findings":["technical denials observed"]}');
} else if (prompt.startsWith("Run exactly this one shell command")) {
  const match = prompt.match(/node "(.+?)" "(.+?)" "(.+?)" (\d+)/);
  if (!match) throw new Error("Fixture timeout prompt did not contain the trusted child command.");
  const [, script, started, marker, delay] = match;
  if (behavior !== "omit-timeout-start-event") {
    emit({type: "item.started", item: {type: "command_execution", command: `node "${script}" "${started}" "${marker}" ${delay}`, status: "in_progress"}});
  }
  const child = spawn(process.execPath, [script, started, marker, delay], {stdio: "ignore"});
  await new Promise(resolve => child.on("exit", resolve));
} else if (prompt.includes("distinct origin")) {
  emit({type: "item.completed", item: {type: "mcp_tool_call", name: "navigate_page", status: "completed"}});
  emit({type: "item.completed", item: {type: "mcp_tool_call", name: "take_snapshot", status: "completed"}});
  emit({type: "item.completed", item: {type: "mcp_tool_call", name: "click", status: "completed"}});
  emit({type: "item.completed", item: {type: "mcp_tool_call", name: "navigate_page", status: "completed"}});
  agent('AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}');
} else if (prompt.includes("unavailable URL")) {
  emit({type: "item.completed", item: {type: "mcp_tool_call", name: "navigate_page", status: "failed", output: "ERR_CONNECTION_REFUSED"}});
  agent('AUTOPILOT_REVIEW={"decision":"FAIL","findings":["server unavailable"]}');
} else if (prompt.startsWith("Run the existing Playwright probe")) {
  const match = prompt.match(/command: node (.+?) (https?:\/\/\S+)\. Do not edit/);
  if (!match) throw new Error("Fixture Playwright prompt did not contain the trusted script and URL.");
  const result = spawnSync(process.execPath, [match[1], match[2]], {encoding: "utf8", shell: false});
  emit({type: "item.completed", item: {type: "command_execution", command: `node ${match[1]} ${match[2]}`, status: result.status === 0 ? "completed" : "failed", output: `${result.stdout || ""}${result.stderr || ""}`}});
  agent(result.status === 0 && /PLAYWRIGHT_CERTIFICATION_PASS/.test(result.stdout || "")
    ? 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}'
    : 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":["Playwright probe failed"]}');
} else {
  agent(`AUTOPILOT_REVIEW={"decision":"FAIL","findings":["unexpected ${mode} probe"]}`);
}
