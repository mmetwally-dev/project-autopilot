#!/usr/bin/env node
// Mission 093 Part 1 task 2.1: unit test for resolveRunModel (scripts/model-extract.mjs).
// One fake-stream sample per adapter (Claude, opencode, agy), asserting the
// resolved model, the null-before-resolution fallback, and the mismatch flag.
import { resolveRunModel } from "./model-extract.mjs";

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── Claude: message.model per assistant event, terminal result wins ─────────
{
  const events = [
    {type: "system", subtype: "init", session_id: "s1"},
    {type: "assistant", message: {id: "m1", model: "claude-sonnet-4-5", content: [{type: "text", text: "hi"}]}},
    {type: "assistant", message: {id: "m2", model: "claude-sonnet-4-5", content: [{type: "text", text: "more"}]}}
  ];
  const got = resolveRunModel("claude", events, "claude-sonnet-4-5");
  assert(got.resolvedModel === "claude-sonnet-4-5", `claude message.model must resolve, got: ${JSON.stringify(got)}`);
  assert(got.modelMismatch === false, `matching configured model must not mismatch, got: ${JSON.stringify(got)}`);
}
{
  const events = [
    {type: "assistant", message: {id: "m1", model: "claude-sonnet-4-5"}},
    {type: "result", subtype: "success", model: "claude-opus-4-6", result: "done"}
  ];
  const got = resolveRunModel("claude", events, "claude-sonnet-4-5");
  assert(got.resolvedModel === "claude-opus-4-6", `claude terminal result model must win, got: ${JSON.stringify(got)}`);
  assert(got.modelMismatch === true, `differing resolved model must mismatch, got: ${JSON.stringify(got)}`);
}

// ── opencode: modelID event field + step_finish part, stderr logfmt ──────────
{
  const events = [
    {type: "step_start", sessionID: "ses_1", modelID: "muse-spark-1.3-contributor-free"},
    {type: "step_finish", sessionID: "ses_1", modelID: "muse-spark-1.3-contributor-free", part: {type: "step-finish", tokens: {input: 10, output: 5, reasoning: 0, cache: {read: 0, write: 0}}}}
  ];
  const got = resolveRunModel("opencode", events, "muse-spark-1.3-contributor-free");
  assert(got.resolvedModel === "muse-spark-1.3-contributor-free", `opencode modelID must resolve, got: ${JSON.stringify(got)}`);
  assert(got.modelMismatch === false, `matching configured model must not mismatch, got: ${JSON.stringify(got)}`);
}
{
  const events = [
    {type: "step_finish", part: {type: "step-finish", model: "openai/gpt-5.4", tokens: {input: 1, output: 1}}},
    {type: "stderr", text: 'timestamp=2026-10-13T02:36:32Z level=INFO message=stream providerID=opencode modelID=step-5-preview-free session.id=ses_1 small=false agent=build mode=primary'}
  ];
  const got = resolveRunModel("opencode", events, "openai/gpt-5.4");
  assert(got.resolvedModel === "step-5-preview-free", `last opencode model signal must win, got: ${JSON.stringify(got)}`);
  assert(got.modelMismatch === true, `differing resolved model must mismatch, got: ${JSON.stringify(got)}`);
}

// #107: main + title-model stream lines in both orders; error/other lines ignored
{
  const main = {type: "stderr", text: "timestamp=2026-10-16T17:54:11.518Z level=INFO run=7e4f7b46 message=stream providerID=opencode modelID=deepseek-v4.1-flash-free session.id=ses_1 small=false agent=build mode=primary"};
  const title = {type: "stderr", text: "timestamp=2026-10-16T17:54:09.723Z level=INFO run=7e4f7b46 message=stream providerID=opencode modelID=gpt-5.4-nano session.id=ses_1 small=true agent=title mode=primary"};
  const titleErr = {type: "stderr", text: 'timestamp=2026-10-16T17:54:10.939Z level=ERROR message="stream error" providerID=opencode modelID=gpt-5.4-nano session.id=ses_1 small=true agent=title mode=primary error.error="x"'};
  for (const events of [[title, titleErr, main], [main, titleErr, title]]) {
    const got = resolveRunModel("opencode", events, "opencode/deepseek-v4.1-flash-free");
    assert(got.resolvedModel === "deepseek-v4.1-flash-free" && got.modelMismatch === false, `title model must be ignored, got: ${JSON.stringify(got)}`);
  }
  const only = resolveRunModel("opencode", [title, titleErr], "opencode/deepseek-v4.1-flash-free");
  assert(only.resolvedModel === null && only.modelMismatch === null, `title-only must stay null, got: ${JSON.stringify(only)}`);
  const mm = resolveRunModel("opencode", [title, main], "opencode/other-free");
  assert(mm.resolvedModel === "deepseek-v4.1-flash-free" && mm.modelMismatch === true, `mismatch must flag, got: ${JSON.stringify(mm)}`);
}

// ── agy: init payload model, terminal result model ───────────────────────────
{
  const events = [
    {event: "init", conversation_id: "cid", init: {cwd: "/repo", model: "gemini-3-flash", tools: ["run_command"]}},
    {event: "step_update", step_update: {conversation_id: "cid", step_index: 1, state: "DONE", step_type: "agent_response", usage: {input_tokens: 10, output_tokens: 5}}}
  ];
  const got = resolveRunModel("antigravity", events, "gemini-3-flash");
  assert(got.resolvedModel === "gemini-3-flash", `agy init model must resolve, got: ${JSON.stringify(got)}`);
  assert(got.modelMismatch === false, `matching configured model must not mismatch, got: ${JSON.stringify(got)}`);
}
{
  const events = [
    {event: "init", conversation_id: "cid", init: {cwd: "/repo"}},
    {event: "result", result: {conversation_id: "cid", status: "SUCCESS", model: "gemini-3-pro", usage: {input_tokens: 10, output_tokens: 5}}}
  ];
  const got = resolveRunModel("antigravity", events, "gemini-3-flash");
  assert(got.resolvedModel === "gemini-3-pro", `agy result model must resolve, got: ${JSON.stringify(got)}`);
  assert(got.modelMismatch === true, `differing resolved model must mismatch, got: ${JSON.stringify(got)}`);
}

// ── Null before resolution; empty inputs; unconfigured default ───────────────
{
  const got = resolveRunModel("claude", [{type: "system", subtype: "init", session_id: "s1"}], "claude-sonnet-4-5");
  assert(got.resolvedModel === null && got.modelMismatch === null, `no model signal must stay null/null, got: ${JSON.stringify(got)}`);
}
{
  for (const [adapter, events] of [["claude", []], ["opencode", []], ["antigravity", []], ["claude", null], ["opencode", "nope"]]) {
    const got = resolveRunModel(adapter, events, "whatever");
    assert(got.resolvedModel === null && got.modelMismatch === null, `${adapter} empty input must stay null/null, got: ${JSON.stringify(got)}`);
  }
}
{
  const got = resolveRunModel("claude", [{type: "assistant", message: {id: "m1", model: "m"}}], null);
  assert(got.resolvedModel === "m" && got.modelMismatch === false, `unconfigured default must resolve without mismatch, got: ${JSON.stringify(got)}`);
}
{
  const got = resolveRunModel("unknown-adapter", [{type: "other"}], "m");
  assert(got.resolvedModel === null && got.modelMismatch === null, `unknown adapter with no signal must stay null/null, got: ${JSON.stringify(got)}`);
}

// ── Backlog #5: claude aliases resolve to full ids; not a mismatch ──────────
{
  const resolved = (model) => [{type: "result", subtype: "success", model, result: "done"}];
  const cases = [
    ["opus", "claude-opus-5-5", false],
    ["sonnet[1m]", "claude-sonnet-5-5", false],
    ["haiku", "claude-sonnet-5-5", true],
    ["claude-opus-5-5", "claude-opus-5-5", false],
  ];
  for (const [configured, model, mismatch] of cases) {
    const got = resolveRunModel("claude", resolved(model), configured);
    assert(got.modelMismatch === mismatch,
      `claude ${configured} → ${model} mismatch must be ${mismatch}, got: ${JSON.stringify(got)}`);
  }
  // A different claude family stays a mismatch.
  const family = resolveRunModel("claude", resolved("claude-opus-5-5"), "haiku");
  assert(family.modelMismatch === true, `haiku → claude-opus-5-5 must mismatch, got: ${JSON.stringify(family)}`);
  // Opencode provider-prefix behavior is unchanged.
  const oc = resolveRunModel("opencode", [{type: "modelID", modelID: "deepseek-v4.1-flash-free"}], "opencode/deepseek-v4.1-flash-free");
  assert(oc.modelMismatch === false, `opencode provider prefix must stay equal, got: ${JSON.stringify(oc)}`);
}

console.log("test-093-model-extract: ok (claude/opencode/agy samples, null-before-resolution, mismatch flag)");
