import {normalizeRequirement, requirementKey, CapabilityRequirementError} from "./capability-contract.mjs";
import {failure} from "./failure-contract.mjs";

const ROLE_BASELINES = Object.freeze({
  planner: ["cli.discovery", "repository.read", "repository.write", "headless.nonInteractive"],
  plan_reviewer: ["cli.discovery", "repository.read", "isolation.repositoryReadOnly", "output.structuredReview", "headless.nonInteractive"],
  implementer: ["cli.discovery", "repository.read", "repository.write", "headless.nonInteractive"],
  code_reviewer: ["cli.discovery", "repository.read", "isolation.repositoryReadOnly", "output.structuredReview", "headless.nonInteractive"],
  verifier: ["cli.discovery", "repository.read", "isolation.repositoryReadOnly", "output.structuredReview", "headless.nonInteractive"]
});

const ROLE_NAMES = new Set(Object.keys(ROLE_BASELINES));
const legacyBrowserPattern = /\b(ui|ux|browser|frontend|web|page|component|screen|form|dashboard|modal|dialog|navigation|responsive|playwright|e2e)\b/i;

export function parseInlineRequirements(text) {
  const matches = [...String(text || "").matchAll(/<!--\s*autopilot-requires:\s*([^>]+?)\s*-->/ig)];
  return matches.flatMap(match => splitRequirements(match[1]));
}

export function stripInlineRequirements(text) {
  return String(text || "").replace(/\s*<!--\s*autopilot-requires:\s*[^>]+?\s*-->/ig, "").trim();
}

export function parseGsdRequirements(block) {
  const matches = [...String(block || "").matchAll(/<requires>([\s\S]*?)<\/requires>/ig)];
  return matches.flatMap(match => splitRequirements(match[1]));
}

function splitRequirements(raw) {
  return [...new Set(String(raw).split(/[\s,]+/).map(value => value.trim()).filter(Boolean))];
}

export function buildRoleRequirements({config, roleName, role = null, taskText = "", explicit = [], taskFacts = {}}) {
  const capabilityConfig = config?.capabilities || {};
  const projectDefaults = capabilityConfig.project_defaults || [];
  const configuredRole = capabilityConfig.role_requirements?.[roleName] || [];
  const baseline = ROLE_BASELINES[roleName] || [];
  const selection = [role?.model ? "selection.model" : null, role?.reasoning ? "selection.effort" : null].filter(Boolean);
  const explicitForRole = scopedRequirements(explicit, roleName);
  const structurallyDerived = deriveStructuredRequirements(capabilityConfig, roleName, taskFacts);
  const inferred = explicitForRole.length || structurallyDerived.length
    ? []
    : legacyRequirements(capabilityConfig, roleName, taskText);
  return uniqueRequirements([...projectDefaults, ...baseline, ...selection, ...configuredRole, ...structurallyDerived, ...inferred, ...explicitForRole]);
}

function scopedRequirements(requirements, roleName) {
  const selected = [];
  for (const raw of requirements || []) {
    if (typeof raw !== "string") {
      if (roleName === "verifier") selected.push(raw);
      continue;
    }
    const separator = raw.indexOf(":");
    if (separator > 0 && ROLE_NAMES.has(raw.slice(0, separator))) {
      if (raw.slice(0, separator) === roleName) selected.push(raw.slice(separator + 1));
    } else if (roleName === "verifier") {
      selected.push(raw);
    }
  }
  return selected;
}

function deriveStructuredRequirements(capabilityConfig, roleName, facts) {
  if (roleName !== "verifier") return [];
  const requirements = [...(facts.requiredCapabilities || [])];
  if (facts.commands === true) requirements.push("commands.execute");
  if (facts.browser === true) requirements.push(...browserRequirements(browserMode(capabilityConfig)));
  if (facts.playwright === true) requirements.push("browser.playwright.deterministic");
  if (capabilityConfig.verification?.require_browser === "always") {
    requirements.push(...browserRequirements(browserMode(capabilityConfig)));
  }
  return requirements;
}

function legacyRequirements(capabilityConfig, roleName, taskText) {
  if (capabilityConfig.legacy_text_inference !== true || roleName !== "verifier") return [];
  if (!legacyBrowserPattern.test(taskText)) return [];
  return browserRequirements(browserMode(capabilityConfig));
}

function browserMode(capabilityConfig) {
  const configured = capabilityConfig.verification?.browser;
  return typeof configured === "string" ? configured : configured?.mode || "native";
}

function browserRequirements(mode) {
  if (mode === "both") return ["browser.native.supported", "browser.playwright.deterministic"];
  if (mode === "playwright") return ["browser.playwright.deterministic"];
  if (mode === "native") return ["browser.native.supported"];
  return [];
}

function uniqueRequirements(requirements) {
  const values = new Map();
  for (const candidate of requirements) {
    const normalized = normalizeRequirement(candidate);
    if (typeof normalized === "object" && normalized.equals === false && normalized.id !== "browser.native.originScopedPermission") {
      throw new CapabilityRequirementError(`A task requirement cannot weaken '${normalized.id}' by requiring false.`, {token: normalized.id});
    }
    values.set(requirementKey(normalized), normalized);
  }
  return [...values.values()];
}

export function roleBaselines() {
  return structuredClone(ROLE_BASELINES);
}

// A planner-authored requirement token the contract does not recognise must
// fail closed with a NAMED cause and the offending text — never as a bare
// Error escaping a relay (mission 004's F6: `ap run` died with an unhandled
// `Unknown capability requirement 'read'` stack trace, no `die()` message and
// no `state.step`). Returns null for anything that is not a contract
// violation, so callers rethrow genuinely unexpected errors instead of
// masking them.
export function requirementFailure(err, {roleName = "", taskText = ""} = {}) {
  if (!(err instanceof CapabilityRequirementError)) return null;
  const excerpt = String(taskText || "").replace(/\s+/g, " ").trim().slice(0, 240);
  return {
    step: "capability_requirement_invalid",
    message: `Task requirement '${err.token ?? "?"}' is not a capability Project Autopilot recognises (relay role: ${roleName || "unknown"}).`
      + (excerpt ? ` Offending task text: "${excerpt}"` : "")
      + " The requirement tokens are taken verbatim from the planner's task annotations.",
    failure: failure("INTERNAL_CONTRACT_ERROR", "orchestrator", false,
      [{source: "annotation", message: `${err.message}${excerpt ? ` Task: ${excerpt}` : ""}`}])
  };
}
