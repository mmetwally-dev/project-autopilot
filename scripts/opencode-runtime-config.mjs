// OpenCode runtime-config override — pure module, no filesystem/process/network
// access, no side effects at import. Extracted from the autopilot.mjs function
// formerly called opencodeScratchPermissionOverride() so there is exactly one
// source of truth; autopilot.mjs imports opencodeRuntimeConfigOverride() from
// here, and passes the ambient OPENCODE_CONFIG_CONTENT in as an argument (this
// module never reads the environment itself).
//
// Two clearly separate concerns live in this one function:
//
// Part 1 — snapshot:false for every writable OpenCode role (new,
// envelope-independent). OpenCode's default snapshot feature (git-based
// file-tracking/undo, documented at opencode.ai/docs/config) runs
// `git add --all --sparse` after every tool call. Inside the shared
// repository that writes loose objects, which trips the git-mutation guard's
// git_commit_detected false positive for writable roles (implementer,
// planner, any future write-mode role). Disabling the feature entirely
// removes the false positive at the source. This branch is deliberately NOT
// gated on attemptEnvelope/executionEnvelope: for any non-read-only role,
// attemptEnvelope (readOnly && !disposableWorkspace) is always false, so
// gating on it would make this branch permanently dead. It carries no agent
// object and no scratch-permission validation — both are irrelevant to a
// writable role. This deliberately covers every writable OpenCode role, not
// just the implementer.
//
// Part 2 — autopilot_readonly agent + scratch-permission block, ONLY for the
// read-only-envelope path (unchanged reasoning, now scoped explicitly to that
// path alone):
//
// OpenCode-only, envelope-only scratch-write fix: OpenCode has its own
// app-level permission system (opencode.json's `permission.external_directory`
// / `permission.edit`), completely separate from bwrap. A read-only role
// (plan_reviewer/code_reviewer/verifier) that tries to write its review
// output to the sandbox's own writable /workspace/scratch was silently
// blocked by OpenCode itself, even though bwrap would allow the write. This
// showed up as STRUCTURED_OUTPUT_MISSING: the model tried to save its
// AUTOPILOT_REVIEW decision to a scratch file instead of printing it, the
// write was auto-rejected, and no sentinel ever reached stdout.
//
// CORRECTION (supersedes an earlier "*":"deny" + scratch:"allow" design):
// that design can never work. Confirmed empirically against the real
// installed OpenCode 1.18.29, including live `opencode run` tool calls (not
// just `opencode debug agent plan` config-resolution dumps): OpenCode's
// permission engine for `edit`/`external_directory` is DENY-WINS — if ANY
// rule matching the candidate path resolves to "deny", the call is denied,
// full stop, regardless of a more specific "allow" rule existing anywhere
// else in the resolved list (order, specificity, and which config source is
// "last" are all irrelevant once a deny matches). The native "plan" agent
// (adapter-drivers.mjs's opencodeInvocation() previously passed
// `--agent plan` for every read-only role) carries an UNCONDITIONAL, built-in
// `edit "*": deny` that is part of its own native definition — not something
// any override (top-level `permission`, or the `agent.plan.permission` block
// this fix used to add) can remove, since the built-in rule is still merged
// into the resolved list either way and still deny-wins. Ten isolated
// `opencode debug agent plan --tool write` probes and two real-bwrap runs (one
// via the debug harness, one a real `opencode run` live model call) all
// denied the scratch write identically regardless of override shape,
// ordering, or agent nativity — the only variable that ever changed the
// outcome was moving off `--agent plan` entirely.
//
// The fix is therefore `--agent autopilot_readonly` (adapter-drivers.mjs,
// agents.json's opencode.read_only): a custom, non-native agent this
// override defines from scratch via OPENCODE_CONFIG_CONTENT, with the same
// tool set the native "plan" agent exposes but a permission block containing
// ONLY a positive scratch-allow rule — deliberately NO "*":"deny" anywhere,
// since deny-wins means adding one would immediately re-break the exact
// write this fix exists to allow. This is safe specifically because
// repository containment was never this permission block's job: bubblewrap's
// read-only bind mount (`--ro-bind repository /workspace/repository`,
// execution-envelope.mjs, untouched by this fix) is the actual, OS-enforced
// boundary, exactly as adapter-drivers.mjs's opencodeInvocation() already
// documented before this fix existed ("Containment inside the trusted
// envelope comes from bubblewrap, not from any OpenCode flag"). Verified
// live: even with a hostile project opencode.json that widens
// `agent.autopilot_readonly.permission.edit` to `"*":"allow"` (so OpenCode's
// own engine would allow a repository write), the actual write to
// /workspace/repository still fails with EROFS at the OS level and the file
// never lands — and the same hostile config's attempt to deny our own
// scratch pattern under the same agent name does not survive: our
// OPENCODE_CONFIG_CONTENT (last config SOURCE per OpenCode's own documented
// precedence) still wins for the identical (agent, permission-type, pattern)
// key.
//
// Uses OPENCODE_CONFIG_CONTENT (inline JSON), never OPENCODE_CONFIG (a file
// path) or a generated file, for the same file-vs-inline precedence reason as
// before. Scoped as narrowly as the bwrap envelope itself already is for this
// path: adapter must be opencode, the role must be read-only, and this must
// be the real WSL/bwrap envelope path (attemptEnvelope &&
// executionEnvelope.available) — never the Windows disposable-copy
// compatibility path. Fails closed: if the constructed agent definition does
// not have write/edit tools enabled, or its edit/external_directory
// permission is not EXACTLY {"/workspace/scratch/**":"allow"} (no other keys
// — in particular, never a "*" key of any action), this throws rather than
// handing back anything malformed or a rule shape that could silently regress
// into the deny-wins trap above.
const OPENCODE_SCRATCH_GLOB="/workspace/scratch/**";
const OPENCODE_READONLY_AGENT="autopilot_readonly";
// Phase 2 T1 (006-task-13-non): /proc widening NOT done — gate fails. The
// brief.txt:84 denial line exists, but the denied tool/path cannot be confirmed
// from available logs (run-75 stdout absent), so the denial source cannot be
// confirmed as the read-only agent's required verification probe. Per the phase
// gate, the external_directory widening to /proc/** is dropped; this function
// intentionally stays scratch-only.
function opencodeReadOnlyAgentDefinition(){
  return {
    mode:"primary",
    description:"Autopilot read-only relay role. Writes are expected only inside the sanctioned scratch directory; repository containment is enforced by the bubblewrap read-only bind mount, not by this agent's own permission block.",
    tools:{invalid:true,question:true,bash:true,read:true,glob:true,grep:true,edit:true,write:true,task:true,webfetch:true,todowrite:true,websearch:true,skill:true},
    permission:{
      edit:{[OPENCODE_SCRATCH_GLOB]:"allow"},
      external_directory:{[OPENCODE_SCRATCH_GLOB]:"allow"}
    }
  };
}
// Phase 2 T2 (006-task-13-non): two-key external_directory widening NOT done —
// gate fails (see opencodeReadOnlyAgentDefinition note above). Widening was
// dropped, so assertScratchOnlyAllow() intentionally still enforces the exact
// single-key scratch-only shape for both edit and external_directory; this
// task is skipped by design.
function assertScratchOnlyAllow(rule,label){
  const dirs=Object.keys(rule||{});
  if(dirs.length!==1||rule[OPENCODE_SCRATCH_GLOB]!=="allow"){
    throw new Error(`OpenCode scratch-permission override failed validation: '${label}' is not exactly {"${OPENCODE_SCRATCH_GLOB}":"allow"}.`);
  }
}
// Preserve a caller-supplied OPENCODE_CONFIG_CONTENT rather than replacing it
// wholesale: an existing value may carry the user's own providers/models, and
// dropping it would silently change how every writable relay runs. Ours is
// spread last so the keys we own still win. A value that is absent, unparseable,
// or not a plain object is ignored and ours is used alone.
//
// Only the writable path merges. The read-only path below deliberately replaces
// the whole document instead: a preserved top-level `permission` block there
// could re-trigger OpenCode's app-level deny-wins and re-break the
// sanctioned-scratch write that path's custom agent exists to allow.
function mergeConfigContent(existingConfigContent,ours){
  if(typeof existingConfigContent!=="string"||!existingConfigContent.trim()) return JSON.stringify(ours);
  let parsed;
  try{ parsed=JSON.parse(existingConfigContent); }catch{ return JSON.stringify(ours); }
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)) return JSON.stringify(ours);
  return JSON.stringify({...parsed,...ours});
}
export function opencodeRuntimeConfigOverride(roleAdapter,readOnly,attemptEnvelope,executionEnvelope,existingConfigContent){
  if(roleAdapter!=="opencode") return {};
  // Writable OpenCode roles (implementer, planner, any future write-mode
  // role): disable OpenCode's git snapshot feature so its per-tool-call
  // `git add` cannot write loose objects into the shared repository and trip
  // the git-mutation guard. Envelope-independent by necessity (see header).
  if(!readOnly) return {OPENCODE_CONFIG_CONTENT:mergeConfigContent(existingConfigContent,{snapshot:false})};
  if(!attemptEnvelope||!executionEnvelope?.available) return {};
  const agentDefinition=opencodeReadOnlyAgentDefinition();
  // snapshot:false — found empirically while proving this fix end-to-end with
  // a real model call: OpenCode's internal git-based file-tracking/undo
  // system (enabled by default, documented at opencode.ai/docs/config) runs
  // a `git add --all --sparse --pathspec-from-file=-` snapshot after every
  // tool call. That subcommand isn't on relay-guards.mjs's BLOCKED_SUBCOMMANDS
  // list (only history/ref-mutating ones are), so it passes through the
  // git-guard shim to the real git binary — but the real invocation then
  // hangs at high CPU inside this sandbox on the SECOND such snapshot,
  // stalling every relay past its first tool call regardless of which
  // OpenCode agent is used (reproduced identically against the native "plan"
  // agent path before this correction, so it is unrelated to the
  // deny-wins/custom-agent fix above). This role has no use for OpenCode's
  // own undo/rollback UI — repository history is owned by the orchestrator,
  // never by the relay — so disabling the feature entirely removes the stall
  // rather than working around it.
  const content=JSON.stringify({snapshot:false,agent:{[OPENCODE_READONLY_AGENT]:agentDefinition}});
  let parsed;
  try{ parsed=JSON.parse(content); }catch{ throw new Error("OpenCode scratch-permission override failed to build: content did not round-trip through JSON."); }
  const parsedAgent=parsed?.agent?.[OPENCODE_READONLY_AGENT];
  if(parsedAgent?.tools?.write!==true||parsedAgent?.tools?.edit!==true){
    throw new Error("OpenCode scratch-permission override failed validation: the read-only agent must have write and edit tools enabled.");
  }
  assertScratchOnlyAllow(parsedAgent?.permission?.edit,`agent.${OPENCODE_READONLY_AGENT}.permission.edit`);
  assertScratchOnlyAllow(parsedAgent?.permission?.external_directory,`agent.${OPENCODE_READONLY_AGENT}.permission.external_directory`);
  return {OPENCODE_CONFIG_CONTENT:content};
}
