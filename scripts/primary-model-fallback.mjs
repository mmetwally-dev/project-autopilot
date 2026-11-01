// Backlog #6(b): a primary model that disappears between mission start and a
// role launch is still handled by the existing fallback switch, but the
// operator must SEE it. These helpers are pure: they detect the CLI's own
// model-not-found diagnostic, format the single loud report line, and
// normalize the mission's recorded fallback entries for the WATCH-REPORT.
//
// The text pattern is deliberately narrow: only the CLI's own diagnostic
// channel (stderr / structured error observations) is inspected. Assistant
// prose and tool output never reach this predicate, matching the same rule
// failure-contract.mjs applies to every other failure classification.

const MODEL_NOT_FOUND_PATTERN = /ProviderModelNotFoundError|ModelUnavailableError|Model not found|Model unavailable|provider\.no-route/i;

function observationText(observation) {
  if (!observation || typeof observation !== "object") return "";
  const type = String(observation.type || "");
  // Structured provider/model errors only. Informational observations (tool
  // calls, file reads) and their output can quote arbitrary model prose.
  if (!/provider_error|rate_limited|error/i.test(type)) return "";
  return [observation.message, observation.errorName, observation.errorType, observation.reason]
    .filter((value) => typeof value === "string" && value)
    .join("\n");
}

// True when the run's stderr or a structured provider error names a missing
// model. `stderr` is the CLI's diagnostic channel, never stdout.
export function detectModelNotFoundFailure({ stderr = "", observations = [] } = {}) {
  const texts = [String(stderr || "")];
  for (const observation of Array.isArray(observations) ? observations : []) {
    texts.push(observationText(observation));
  }
  return MODEL_NOT_FOUND_PATTERN.test(texts.join("\n"));
}

function qualifiedModel(entry) {
  if (!entry || typeof entry !== "object") return null;
  const adapter = typeof entry.adapter === "string" ? entry.adapter : "";
  const model = typeof entry.model === "string" ? entry.model : "";
  if (!model) return adapter || null;
  return adapter && !model.startsWith(`${adapter}/`) ? `${adapter}/${model}` : model;
}

// The one loud line WATCH-REPORT (and the final report) prints for a stale
// primary. Never fabricated: an entry without a role/fallback is ignored by
// primaryModelFallbackEntries() below.
export function formatPrimaryModelFallbackLine(entry) {
  const role = entry?.role || "a role";
  const fallback = qualifiedModel(entry?.fallback) || "a fallback";
  const primary = qualifiedModel(entry?.primary);
  const configured = primary ? ` (configured ${primary})` : "";
  return `⚠ primary model not found → using ${fallback} for ${role}${configured} — fix the model with \`ap config\``;
}

// Normalize state.primaryModelFallbacks (a map keyed by role) for the pure
// report model. Insertion order is kept so the report is stable.
export function primaryModelFallbackEntries(state) {
  const raw = state?.primaryModelFallbacks;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out = [];
  for (const [role, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const fallback = value.fallback && typeof value.fallback === "object" ? value.fallback : null;
    if (!fallback || !fallback.model) continue;
    out.push({
      role: typeof value.role === "string" && value.role ? value.role : role,
      primary: value.primary && typeof value.primary === "object" ? value.primary : null,
      fallback,
      at: typeof value.at === "string" ? value.at : null,
    });
  }
  return out;
}
