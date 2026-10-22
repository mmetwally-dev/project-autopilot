// Phase-checkpoint drift rebase — pure state transition (mission 063 task 1.1).
//
// Importable helper for `ap rebase`: on a recorded PHASE_CHECKPOINT_DRIFT
// error with `evidence.reason === "delta drift"`, re-points the stored
// checkpoint's `deltaDigest` at the observed digest, clears the error, and
// records the operator edit. Pure: no filesystem, process, or network
// access; the caller persists via its own `saveState()`. Mutates the passed
// state object in place on success only; every refusal leaves it untouched.
//
// Signature: `rebasePhaseCheckpointDrift(state, {files, note, at, currentDeltaDigest})`
// - `state`: the state.json object (mutated on success).
// - `files`: changed-file list recorded on the operator-edit record.
// - `note`: operator `--note` text (may be empty string).
// - `at`: caller-supplied timestamp string (orchestrator owns time).
// - `currentDeltaDigest`: freshly recomputed delta digest; must equal
//   `evidence.observedDeltaDigest`, otherwise refuse with a
//   `run ap run then ap rebase` message (tree moved since the drift).
//
// Success mutates exactly:
// - `state.phaseExecutionCheckpoint.deltaDigest = evidence.observedDeltaDigest`
// - `delete state.phaseCheckpointError`
// - append `{files, note, at, expectedDeltaDigest, observedDeltaDigest}` to
//   `state.operatorPhaseEdits` (array, created when absent).
// Phase/step/task cursor fields are never touched.

export const OPERATOR_PHASE_EDITS_KEY = "operatorPhaseEdits";

export const REBASE_DRIFT_CODE = "PHASE_CHECKPOINT_DRIFT";

export const REBASE_DELTA_DRIFT_REASON = "delta drift";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function isDigest(value) {
  return typeof value === "string" && DIGEST_RE.test(value);
}

function refusal(reason) {
  return {ok: false, reason};
}

export function rebasePhaseCheckpointDrift(state, options = {}) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return refusal("nothing to rebase: state is not an object");
  }
  const err = state.phaseCheckpointError;
  if (!err || typeof err !== "object" || Array.isArray(err)) {
    return refusal("nothing to rebase: no phase checkpoint error is recorded");
  }
  if (err.code !== REBASE_DRIFT_CODE) {
    return refusal(`nothing to rebase: phase checkpoint error is ${JSON.stringify(err.code ?? null)}, not ${REBASE_DRIFT_CODE}`);
  }
  const evidence = err.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return refusal("cannot rebase: drift error carries no evidence");
  }
  const reason = evidence.reason;
  if (reason === "task drift" || reason === "delta computation failed") {
    return refusal(`cannot rebase: drift reason ${JSON.stringify(reason)} is not operator-rebasable; resolve the task or declaration change first`);
  }
  if (reason !== REBASE_DELTA_DRIFT_REASON) {
    return refusal(`cannot rebase: unsupported drift reason ${JSON.stringify(reason ?? null)}`);
  }
  const observed = evidence.observedDeltaDigest;
  if (!isDigest(observed)) {
    return refusal("cannot rebase: observed delta digest is missing or invalid");
  }
  const expected = evidence.expectedDeltaDigest;
  if (!isDigest(expected)) {
    return refusal("cannot rebase: expected delta digest is missing or invalid");
  }
  const checkpoint = state.phaseExecutionCheckpoint;
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return refusal("cannot rebase: no phase execution checkpoint is recorded");
  }
  if (checkpoint.deltaDigest !== expected) {
    return refusal("cannot rebase: expected digest does not match the recorded checkpoint digest");
  }
  const {currentDeltaDigest} = options;
  if (!isDigest(currentDeltaDigest)) {
    return refusal("cannot rebase: current delta digest is missing or invalid; run ap run then ap rebase");
  }
  if (currentDeltaDigest !== observed) {
    return refusal("cannot rebase: the tree changed since the drift was recorded; run ap run then ap rebase");
  }
  const files = Array.isArray(options.files)
    ? options.files.filter((f) => typeof f === "string")
    : [];
  const note = typeof options.note === "string" ? options.note : "";
  const at = typeof options.at === "string" && options.at ? options.at : null;

  checkpoint.deltaDigest = observed;
  delete state.phaseCheckpointError;
  const record = {
    files,
    note,
    at,
    expectedDeltaDigest: expected,
    observedDeltaDigest: observed,
  };
  if (!Array.isArray(state[OPERATOR_PHASE_EDITS_KEY])) {
    state[OPERATOR_PHASE_EDITS_KEY] = [];
  }
  state[OPERATOR_PHASE_EDITS_KEY].push(record);
  return {ok: true, record};
}
