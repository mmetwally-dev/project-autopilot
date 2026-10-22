// Backlog #108: Claude Code runs read-only (--permission-mode plan) sessions on
// Sonnet when the session model is Haiku. Pure helpers, warn-only.
export const READ_ONLY_ROLES = ["plan_reviewer", "code_reviewer", "verifier"];

export function isHaikuOnReadOnlyClaudeRole(role, adapter, model) {
  if (!READ_ONLY_ROLES.includes(role)) return false;
  if (adapter !== "claude") return false;
  const m = String(model || "").trim().toLowerCase();
  return m === "haiku" || /^claude-haiku-/.test(m) || /^anthropic\/claude-haiku-/.test(m);
}

export function planModeModelNote(role) {
  return `Note: Claude Code runs read-only (plan-mode) sessions on Sonnet when Haiku is selected — role ${role} will actually run as Sonnet and use Sonnet usage.`;
}

// One line per read-only Claude role (primary and each fallback) using Haiku.
export function planModeModelWarnings(roles) {
  const out = [];
  for (const [name, r] of Object.entries(roles || {})) {
    if (!r) continue;
    if (isHaikuOnReadOnlyClaudeRole(name, r.adapter, r.model)) out.push(planModeModelNote(name));
    for (const fb of Array.isArray(r.fallbacks) ? r.fallbacks : []) {
      if (isHaikuOnReadOnlyClaudeRole(name, fb?.adapter, fb?.model)) out.push(planModeModelNote(name));
    }
  }
  return out;
}
