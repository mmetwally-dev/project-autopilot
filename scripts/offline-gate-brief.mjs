const ALLOWED_ROLES = new Set(["planner", "implementer", "code_reviewer", "verifier"]);

/**
 * Returns a brief reminder line informing workers that the test gate runs
 * without network access, or null if network isolation is disabled, there
 * are no gate commands, or the role is not one of the implementation/review roles.
 *
 * @param {object} params
 * @param {string} params.roleName
 * @param {object} params.config
 * @returns {string|null}
 */
export function offlineGateBriefLine({ roleName, config } = {}) {
  if (!roleName || !ALLOWED_ROLES.has(roleName)) return null;
  if (config?.gates?.network_isolation === false) return null;
  const commands = config?.gates?.commands;
  if (!Array.isArray(commands) || commands.length === 0) return null;

  const rawTools = config?.gates?.offline_test_tools;
  const tools = typeof rawTools === "string" ? rawTools.trim() : "";

  const base = `The test gate runs with NO network access: tests must not reach external hosts, remote databases or cloud APIs. Use in-process fakes or mocks instead${tools ? ` (available here: ${tools})` : ""}; a test that needs the network fails in the gate.`;
  if (roleName === "code_reviewer" || roleName === "verifier") {
    return `${base} Judge only tests this phase added or changed: network errors logged by other, pre-existing tests — or in a gate that passed — are not findings; mention them in notes at most.`;
  }
  return base;
}

export const CODE_REVIEWER_TARGETED_TESTS_LINE = "Run only the tests for the files in this delta (targeted test files); never run the full repository gate, scripts/test-all.mjs or the whole test suite, and never wait on or poll a long-running suite — the orchestrator runs the gate after the review and the verifier judges it.";

