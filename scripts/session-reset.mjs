// Backlog #112: pure helpers for role resume-session hygiene.

// True when a non-completed run produced no completed step (opencode
// step_finish) -- its server session was never persisted, so storing the id
// would make the next launch fail with "Session not found".
export function runFailedBeforeFirstStep(adapter, status, events) {
  if (adapter !== "opencode" || status === "completed") return false;
  const list = Array.isArray(events) ? events : [];
  return !list.some((e) => e && (e.type === "step_finish" || e.type === "step-finish"));
}

// opencode prints "Error: Session not found" on stderr when resuming a
// session id the server does not know.
export function isSessionNotFound(adapter, stderr) {
  return adapter === "opencode" && /session not found/i.test(String(stderr ?? ""));
}

// Backlog #112: a stored role session is resumable only by the same adapter
// CLI and the same effective model. Sessions stored before the model was
// recorded (no "model" key) match on the CLI alone (backward compatible).
export function storedSessionMatches(stored, cli, model) {
  if (!stored || !stored.sessionId) return false;
  if (stored.cli != null && cli != null && stored.cli !== cli) return false;
  if (Object.prototype.hasOwnProperty.call(stored, "model") && (stored.model ?? null) !== (model ?? null)) return false;
  return true;
}
