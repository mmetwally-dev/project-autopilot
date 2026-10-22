import assert from "node:assert/strict";
import { applyAgentSelections, verifyAgentInvocation } from "./agent-invocation.mjs";

const cases = [
  {
    name: "claude model + effort",
    adapter: { binary: "claude", model_flag: "--model", effort_flag: "--effort" },
    role: { model: "opus", reasoning: "high", variant: "" },
    base: ["-p"],
    expected: ["-p", "--model", "opus", "--effort", "high"]
  },
  {
    name: "codex model + reasoning",
    adapter: { binary: "codex", model_flag: "--model", effort_flag: "--reasoning-effort" },
    role: { model: "gpt-5.4", reasoning: "high", variant: "" },
    base: ["exec"],
    expected: ["exec", "--model", "gpt-5.4", "--reasoning-effort", "high"]
  },
  {
    name: "opencode model suffix variant",
    adapter: { binary: "opencode", model_flag: "--model", variant_mode: "model_suffix" },
    role: { model: "openai/gpt-5.4", reasoning: "", variant: "high" },
    base: ["run"],
    expected: ["run", "--model", "openai/gpt-5.4#high"]
  },
  {
    name: "antigravity model + effort",
    adapter: { binary: "agy", model_flag: "--model", effort_flag: "--effort" },
    role: { model: "gemini-3.7-flash", reasoning: "high", variant: "" },
    base: ["--print"],
    expected: ["--print", "--model", "gemini-3.7-flash", "--effort", "high"]
  }
];

for (const c of cases) {
  const actual = applyAgentSelections(c.base, c.role, c.adapter);
  assert.deepEqual(actual, c.expected, c.name);
  assert.deepEqual(verifyAgentInvocation(actual, c.role, c.adapter), { ok: true, errors: [] }, `${c.name}: verification`);
  const tampered = [...actual];
  const modelIndex = tampered.indexOf(c.adapter.model_flag);
  if (modelIndex >= 0) tampered[modelIndex + 1] = "wrong-model";
  else if (c.adapter.effort_flag) tampered[tampered.indexOf(c.adapter.effort_flag) + 1] = "wrong";
  assert.equal(verifyAgentInvocation(tampered, c.role, c.adapter).ok, false, `${c.name}: tamper detection`);
}

console.log("agent invocation verification tests passed");
