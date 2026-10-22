#!/usr/bin/env node
// Backlog #117: a Claude stream cut before the terminal `result` event must not
// record only the partial streamed output_tokens.
import assert from "node:assert/strict";
import {accumulateUsage} from "./adapter-drivers.mjs";

const usage = (o) => ({input_tokens: 8, output_tokens: o, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100});
const text = "x".repeat(400); // ~100 tokens
const msg = (id, block, o) => ({type: "assistant", message: {id, usage: usage(o), content: [block]}});
const stream = [];
for (let i = 0; i < 5; i++) {
  // same id repeated per content block (thinking, text, tool_use), partial usage
  stream.push(msg(`m${i}`, {type: "thinking", thinking: ""}, 1));
  stream.push(msg(`m${i}`, {type: "text", text}, 1));
  stream.push(msg(`m${i}`, {type: "tool_use", input: {a: "y".repeat(100)}}, 1));
}

const killed = accumulateUsage("claude", stream);
assert.equal(killed.turns, 5);
assert.equal(killed.input, 40);
assert.equal(killed.cacheRead, 5000);
assert.ok(killed.output >= 5 * 100, `output ${killed.output} should reflect content, not partial 5`);
assert.ok(killed.priceWeighted > accumulateUsage("claude", stream.map((e) => ({...e, message: {...e.message, content: []}}))).priceWeighted);

// With a terminal result its totals stay authoritative.
const done = accumulateUsage("claude", [...stream, {type: "result", num_turns: 5, usage: {input_tokens: 40, output_tokens: 4897, cache_read_input_tokens: 5000, cache_creation_input_tokens: 500}}]);
assert.equal(done.output, 4897);
assert.equal(done.turns, 5);
console.log("PASS test-117-claude-killed-usage");
