import assert from "node:assert/strict";
import { accumulateUsage, accumulateCodexUsage, USAGE_PRICE_WEIGHTS } from "./adapter-drivers.mjs";
import { growingTerm, evaluateTokenCeiling, checkCapBreach } from "./per-task-budget.mjs";
import {
  contextCell,
  turnsCell,
  priceCell,
  buildReportModel,
  renderPlanningStage,
} from "./watch-report.mjs";

function check(label, condition, extra = null) {
  if (!condition) {
    if (extra !== null) console.error(`FAIL: ${label}`, extra);
    else console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`PASS: ${label}`);
}

// 1. Two turn.completed events + 4 command items + 2 agent messages + 1 reasoning item
const eventsWithUsage = [
  {
    type: "turn.completed",
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 800,
      cache_write_input_tokens: 50,
      output_tokens: 120,
      reasoning_output_tokens: 30,
    },
  },
  { type: "item.started", item: { type: "command_execution", command: "step-1" } },
  { type: "item.completed", item: { type: "command_execution", command: "step-1", status: "completed", exit_code: 0 } },
  { type: "item.completed", item: { type: "command_execution", command: "step-2", status: "completed", exit_code: 0 } },
  { type: "item.completed", item: { type: "command_execution", command: "step-3", status: "completed", exit_code: 0 } },
  { type: "item.completed", item: { type: "command_execution", command: "step-4", status: "failed", exit_code: 1 } },
  { type: "item.completed", item: { type: "agent_message", text: "alpha" } },
  { type: "item.completed", item: { type: "agent_message", text: "beta" } },
  { type: "item.completed", item: { type: "reasoning", summary: "gamma" } },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 2000,
      cached_input_tokens: 1500,
      cache_write_input_tokens: 100,
      output_tokens: 200,
      reasoning_output_tokens: 50,
    },
  },
];

const usage = accumulateCodexUsage(eventsWithUsage);
check("accumulateCodexUsage returns non-null for valid turn.completed events", usage !== null, usage);
check("breakdown: input is sum of (input_tokens - cached_input_tokens)", usage?.input === 700, usage?.input);
check("breakdown: cacheRead is sum of cached_input_tokens", usage?.cacheRead === 2300, usage?.cacheRead);
check("breakdown: cacheCreation is sum of cache_write_input_tokens", usage?.cacheCreation === 150, usage?.cacheCreation);
check("breakdown: output is sum of output_tokens (already includes reasoning_output_tokens)", usage?.output === 320, usage?.output);
check("turns: counts completed tool items only, not agent_message items (4)", usage?.turns === 4, usage?.turns);
check("maxSingleTurnContext: reports null for codex", usage?.maxSingleTurnContext === null, usage?.maxSingleTurnContext);

const expectedPriced =
  700 * USAGE_PRICE_WEIGHTS.input +
  150 * USAGE_PRICE_WEIGHTS.cacheCreation +
  2300 * USAGE_PRICE_WEIGHTS.cacheRead +
  320 * USAGE_PRICE_WEIGHTS.output;
check("priceWeighted: matches USAGE_PRICE_WEIGHTS formula", usage?.priceWeighted === expectedPriced, { got: usage?.priceWeighted, expected: expectedPriced });

const wiredUsage = accumulateUsage("codex", eventsWithUsage);
check("accumulateUsage wired to codex matches accumulateCodexUsage", JSON.stringify(wiredUsage) === JSON.stringify(usage));

// 2. No turn.completed -> partial usage if completed tool items present, null if neither
const itemsOnlyEvents = [
  { type: "item.completed", item: { type: "command_execution", command: "step-1" } },
  { type: "item.completed", item: { type: "agent_message", text: "no usage here" } },
];
const partial = accumulateCodexUsage(itemsOnlyEvents);
check("accumulateCodexUsage: completed command without turn.completed returns partial usage", partial !== null && partial.turns === 1 && partial.usagePartial === true);
const noToolEvents = [
  { type: "item.completed", item: { type: "agent_message", text: "no usage here" } },
];
check("accumulateUsage: empty events returns null", accumulateUsage("codex", []) === null);
check("accumulateUsage: agent_message only without tool items or turn.completed returns null", accumulateUsage("codex", noToolEvents) === null);
check("accumulateCodexUsage: empty events returns null", accumulateCodexUsage([]) === null);
check("accumulateCodexUsage: agent_message only returns null", accumulateCodexUsage(noToolEvents) === null);

// 3. Cap monitor behavior: skips context cap when maxSingleTurnContext is null, enforces turn cap
check("growingTerm returns null when maxSingleTurnContext is null", growingTerm(usage) === null);
const ceiling = evaluateTokenCeiling({ usage, maxTokens: 100 });
check("evaluateTokenCeiling is unenforceable when growingTerm is null", ceiling.enforceable === false && ceiling.exceeded === false);

const withinTurnCap = checkCapBreach({ usage, perTaskMaxTurns: 10, perTaskMaxTokens: 100 });
check("checkCapBreach skips context cap when maxSingleTurnContext is null (returns null)", withinTurnCap === null);

const overTurnCap = checkCapBreach({ usage, perTaskMaxTurns: 3, perTaskMaxTokens: 100 });
check("checkCapBreach enforces turn cap (4 > 3)", overTurnCap?.type === "turns" && overTurnCap?.used === 4 && overTurnCap?.limit === 3);

// 4. WATCH-REPORT rendering for codex run
const codexRun = {
  id: "r105",
  dirName: "02-plan_reviewer-r105",
  role: "plan_reviewer",
  model: "gpt-6.1-sol",
  status: "completed",
  decision: "PASS",
  usage,
};

check("contextCell renders '-' for codex run with null maxSingleTurnContext", contextCell(codexRun) === "-");
check("turnsCell renders TURNS '4'", turnsCell(codexRun) === "4");
check("priceCell renders TOKENS compact price '2.7K'", priceCell(codexRun) === "2.7K");

const reportModel = buildReportModel({
  state: {
    mission: "generic-mission",
    phase: "planning",
    step: "planning",
    planningDetection: { framework: "standalone" },
  },
  runs: [codexRun],
  events: [],
  phases: [],
  policy: {},
});

const renderedPlanning = renderPlanningStage(reportModel);
const rowLine = renderedPlanning.split("\n").find((line) => line.includes("02-plan_reviewer"));
check("rendered planning stage row exists", Boolean(rowLine), renderedPlanning);

// Check table columns: row shows TURNS (4), TOKENS (2.7K), CONTEXT (-)
check("planning row displays TURNS '4'", /\b4\b/.test(rowLine), rowLine);
check("planning row displays TOKENS '2.7K'", rowLine.includes("2.7K"), rowLine);
check("planning row displays CONTEXT '-'", rowLine.includes("-"), rowLine);

// 5. Real sample case: reasoning_output_tokens is already included in output_tokens
const realSampleEvents = [
  {
    type: "turn.completed",
    usage: {
      input_tokens: 660917,
      cached_input_tokens: 577408,
      cache_write_input_tokens: 0,
      output_tokens: 3397,
      reasoning_output_tokens: 404,
    },
  },
  {
    type: "item.completed",
    item: { type: "command_execution", command: "test-step", status: "completed", exit_code: 0 },
  },
];
const realUsage = accumulateCodexUsage(realSampleEvents);
check("real sample: output is 3397 (reasoning_output_tokens 404 is subset, not added)", realUsage?.output === 3397, realUsage?.output);
check("real sample: input is input_tokens - cached_input_tokens (660917 - 577408 = 83509)", realUsage?.input === 83509, realUsage?.input);
check("real sample: cacheRead is cached_input_tokens (577408)", realUsage?.cacheRead === 577408, realUsage?.cacheRead);
check("real sample: cacheCreation is 0", realUsage?.cacheCreation === 0, realUsage?.cacheCreation);
check("real sample: turns is 1", realUsage?.turns === 1, realUsage?.turns);
const expectedRealPriced =
  83509 * USAGE_PRICE_WEIGHTS.input +
  0 * USAGE_PRICE_WEIGHTS.cacheCreation +
  577408 * USAGE_PRICE_WEIGHTS.cacheRead +
  3397 * USAGE_PRICE_WEIGHTS.output;
check("real sample: priceWeighted matches expected (158234.8)", realUsage?.priceWeighted === expectedRealPriced, { got: realUsage?.priceWeighted, expected: expectedRealPriced });

// 6. Deduplication case: item.updated with status completed AND item.completed -> counted once
const updatedAndCompletedEvents = [
  {
    type: "turn.completed",
    usage: {
      input_tokens: 500,
      cached_input_tokens: 100,
      cache_write_input_tokens: 0,
      output_tokens: 50,
      reasoning_output_tokens: 10,
    },
  },
  {
    type: "item.started",
    item: { type: "command_execution", id: "cmd-1", command: "exec-cmd" },
  },
  {
    type: "item.updated",
    item: { type: "command_execution", id: "cmd-1", command: "exec-cmd", status: "completed", exit_code: 0 },
  },
  {
    type: "item.completed",
    item: { type: "command_execution", id: "cmd-1", command: "exec-cmd", status: "completed", exit_code: 0 },
  },
  {
    type: "item.updated",
    item: { type: "file_change", id: "file-1", status: "completed", file: "foo.txt" },
  },
  {
    type: "item.completed",
    item: { type: "file_change", id: "file-1", status: "completed", file: "foo.txt" },
  },
  {
    type: "item.updated",
    item: { type: "mcp_tool_call", id: "mcp-1", status: "completed" },
  },
  {
    type: "item.completed",
    item: { type: "mcp_tool_call", id: "mcp-1", status: "completed" },
  },
  {
    type: "item.updated",
    item: { type: "agent_message", id: "msg-1", status: "completed", text: "done" },
  },
  {
    type: "item.completed",
    item: { type: "agent_message", id: "msg-1", status: "completed", text: "done" },
  },
];
const dedupeUsage = accumulateCodexUsage(updatedAndCompletedEvents);
check("dedupe: item.updated with status completed and item.completed counted once per item (3 completed tool items = 3 turns)", dedupeUsage?.turns === 3, dedupeUsage?.turns);
check("dedupe: output is 50", dedupeUsage?.output === 50, dedupeUsage?.output);
check("dedupe: input is 400", dedupeUsage?.input === 400, dedupeUsage?.input);
check("dedupe: cacheRead is 100", dedupeUsage?.cacheRead === 100, dedupeUsage?.cacheRead);

console.log("All codex usage tests passed.");
