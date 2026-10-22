// TASK-8 "Stable task IDs" — deterministic per-task runtime identity.
//
// Format: <framework>:P<phase-number>:T<ordinal>:<short-hash-of-normalized-task-text>
//
// Pure module: no filesystem, process, or network access, and no state writes.
// It takes exactly the inputs TASK-7's `phaseTaskDigest()` already takes, and
// reuses that module's `normalizeTaskText()` / `normalizeRepoPath()` rather
// than re-implementing them — if the two normalizations ever drifted, a task
// could keep a stable ID while the authoritative phase-task digest changed (or
// the reverse), and the cursor would point at a task the digest no longer
// describes. Importing is the only way to make that drift impossible.
//
// `file:line` is never an input. Lines move whenever anything above a task is
// edited, which would invalidate a cursor on a task nobody touched.
import {createHash} from "node:crypto";
import {normalizeTaskText, normalizeRepoPath} from "./phase-stage-checkpoint.mjs";

// Length of the hex hash suffix. 12 hex chars = 48 bits: far past any
// plausible per-phase task count, and short enough to stay readable in a
// state file a human has to skim during an escalation.
export const TASK_ID_HASH_LENGTH = 12;

// The ordinal is part of the ID *and* of the hashed identity. Prefix alone is
// not enough: a reorder that swapped two tasks' positions would otherwise
// produce two IDs whose hashes still matched their old positions, so a cursor
// could silently follow moved work.
const ID_PATTERN = /^[^:]+:P[0-9]+:T[0-9]+:[0-9a-f]+$/;

function sha256Hex(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function intOrString(value) {
  return Number.isInteger(value) ? value : String(value ?? "");
}

// A framework containing ":" would make the ID ambiguous to read back apart —
// `standalone:x:P1:T0:abc` cannot be split into its four fields. Fail closed
// rather than emit an ID that parses wrong later.
function assertSegment(value, field) {
  const text = String(value ?? "");
  if (!text) throw new TypeError(`stable task id requires a non-empty ${field}`);
  if (text.includes(":")) throw new TypeError(`stable task id ${field} must not contain ":" (received ${JSON.stringify(text)})`);
  return text;
}

// The hashed identity, as a freshly constructed object with fixed property
// order, hashed over its canonical JSON encoding — never an ad-hoc delimited
// join. This is the `artifactDigest()` / `phaseTaskDigest()` precedent and it
// exists for a concrete reason: a `|`-joined `file:...|text:...` encoding
// collides for distinct identities (`{file:"a|text:b",text:"c"}` versus
// `{file:"a",text:"b|text:c"}` serialize identically), and no hash can repair
// an identity contract that already collided before hashing.
export function taskIdentity({framework, mission, phaseIndex, phaseNumber, phaseName, repoRoot} = {}, task = {}, ordinal = 0) {
  return {
    framework: String(framework ?? ""),
    mission: String(mission ?? ""),
    phaseIndex: intOrString(phaseIndex),
    phaseNumber: intOrString(phaseNumber),
    phaseName: normalizeTaskText(phaseName),
    ordinal: Number.isInteger(ordinal) ? ordinal : String(ordinal ?? ""),
    file: normalizeRepoPath(task?.file, repoRoot),
    text: normalizeTaskText(task?.text),
  };
}

// Phase number for the `P<n>` segment. TASK-8's format names the phase
// *number*; `phaseIndex` is the 0-based array position TASK-7 carries. Prefer
// the explicit number and fall back to index+1 so callers that only have the
// index still produce a well-formed ID.
function phaseSegment({phaseNumber, phaseIndex}) {
  if (Number.isInteger(phaseNumber) && phaseNumber >= 0) return phaseNumber;
  if (Number.isInteger(phaseIndex) && phaseIndex >= 0) return phaseIndex + 1;
  throw new TypeError("stable task id requires an integer phaseNumber or phaseIndex");
}

// One task's stable ID. `ordinal` is the task's position within the phase.
export function stableTaskId(phase = {}, task = {}, ordinal = 0) {
  const framework = assertSegment(phase?.framework, "framework");
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new TypeError(`stable task id requires a non-negative integer ordinal (received ${JSON.stringify(ordinal)})`);
  }
  const identity = taskIdentity(phase, task, ordinal);
  const hash = sha256Hex(JSON.stringify(identity)).slice(0, TASK_ID_HASH_LENGTH);
  return `${framework}:P${phaseSegment(phase)}:T${ordinal}:${hash}`;
}

// Every task ID for a phase, in list order. This is the normal entry point:
// ordinals come from array position, exactly as `phaseTaskDigest()` assigns
// them, so an insert or a removal shifts every later task's ordinal and
// therefore every later task's ID — which is what makes a cursor recorded
// against the old list fail to match the new one instead of silently
// resolving to whatever now sits at that position.
export function stableTaskIds(phase = {}) {
  const tasks = Array.isArray(phase?.tasks) ? phase.tasks : [];
  return tasks.map((task, ordinal) => stableTaskId(phase, task, ordinal));
}

// Shape check for an ID read back out of state. Deliberately structural only:
// proving an ID belongs to the current phase means recomputing it from the
// current task list (`stableTaskIds()` and compare), which is the caller's
// job — this only rejects values that were never a task ID at all.
export function isStableTaskId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}
