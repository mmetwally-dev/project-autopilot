#!/usr/bin/env node
// Pure runtime-mode selection helpers (TASK 15.5B correction).
//
// No probing, no config I/O, no readline, no process side effects.
// Discovery comes from scripts/runtime-mode-capabilities.mjs; validation
// from scripts/config-validation.mjs. `scripts/setup.mjs` imports and uses
// these helpers for its interactive UX. Tests import this module directly
// and never import `scripts/setup.mjs`.
//
// Correction guarantees:
// - Automatic selection only for fresh (never-saved) single STRONG modes.
// - Never automatically replaces an existing invalid/unavailable saved mode,
//   even when only one replacement exists (returns need-choice, no execution).
// - Never silently switches Strong <-> Compatibility.
// - Windows Compatibility always requires explicit confirmation in setup
//   (enforced by the caller; this module never auto-saves compat).
import {RUNTIME_MODE_IDS} from "./runtime-mode-capabilities.mjs";
import {validateExecutionConfig} from "./config-validation.mjs";

export function isRoleOnlyScope(scope) {
  return scope === "role" || (typeof scope === "string" && scope.startsWith("role:"));
}

export function preserveExecutionForRoleScope(currentExecution) {
  return currentExecution;
}

export function getSelectableRuntimeModes(capabilities, framework) {
  if (!capabilities || !Array.isArray(capabilities.modes)) return [];
  const knownFrameworks = new Set(["speckit", "gsd", "standalone"]);
  const fw = typeof framework === "string" ? framework : "";
  return capabilities.modes.filter(mode => {
    if (!mode || mode.available !== true) return false;
    if (!Array.isArray(mode.supportedFrameworks)) return false;
    if (knownFrameworks.has(fw)) return mode.supportedFrameworks.includes(fw);
    return true;
  });
}

export function buildExecutionConfig(modeId, capabilities) {
  const validIds = new Set(Object.values(RUNTIME_MODE_IDS));
  if (!validIds.has(modeId)) {
    throw new Error(`Unknown runtime mode '${String(modeId)}' cannot be selected.`);
  }
  const mode = capabilities?.modes?.find(entry => entry?.id === modeId);
  if (!mode || mode.available !== true) {
    throw new Error(`Runtime mode '${modeId}' is unavailable and cannot be selected.`);
  }
  let wslDistro = null;
  if (modeId === RUNTIME_MODE_IDS.wsl2Strong) {
    if (capabilities?.currentPlatform === "native-windows") {
      const discovered = mode.distro ?? capabilities?.usableWslDistro ?? null;
      if (typeof discovered !== "string" || discovered.trim().length === 0) {
        throw new Error("WSL2 Strong requires the discovered usable WSL distro, but none was discovered.");
      }
      wslDistro = discovered;
    } else {
      wslDistro = null;
    }
  } else {
    wslDistro = null;
  }
  return {runtime_mode: modeId, wsl_distro: wslDistro};
}

export function classifySavedRuntimeExecution({savedExecution, capabilities, framework}) {
  if (savedExecution === undefined) return {status: "missing", reason: null};
  const validation = validateExecutionConfig(savedExecution, framework);
  if (!validation.valid) {
    return {status: "invalid", reason: validation.errors.join("; "), errors: validation.errors};
  }
  const selectable = getSelectableRuntimeModes(capabilities, framework);
  const stillSelectable = selectable.some(mode => mode.id === savedExecution.runtime_mode);
  if (stillSelectable) {
    if (
      savedExecution.runtime_mode === RUNTIME_MODE_IDS.wsl2Strong &&
      capabilities?.currentPlatform === "native-windows"
    ) {
      const currentDistro =
        capabilities?.modes?.find(entry => entry?.id === RUNTIME_MODE_IDS.wsl2Strong)?.distro ??
        capabilities?.usableWslDistro ??
        null;
      // null = not pinned (Setup ran inside WSL, which records no distro):
      // any discovered usable distro is acceptable. Only a PINNED distro that
      // no longer matches is unavailable (seen live: a WSL-side Setup saved
      // null, so every Windows-side `ap stop` failed routing and fell back
      // to a Windows-only liveness check that cannot see the WSL run).
      if (savedExecution.wsl_distro === null && typeof currentDistro === "string" && currentDistro) {
        return {status: "preserved", reason: null, selectable};
      }
      if (savedExecution.wsl_distro !== currentDistro) {
        return {
          status: "unavailable",
          reason: `Saved WSL distro '${String(savedExecution.wsl_distro)}' no longer matches the discovered usable distro '${String(currentDistro)}'.`,
          selectable
        };
      }
    }
    return {status: "preserved", reason: null, selectable};
  }
  const savedMode = capabilities?.modes?.find(entry => entry?.id === savedExecution.runtime_mode);
  let reason;
  if (!savedMode) {
    reason = `Saved runtime mode '${String(savedExecution.runtime_mode)}' is unknown.`;
  } else if (savedMode.available !== true) {
    reason = `Saved runtime mode '${String(savedExecution.runtime_mode)}' is no longer available: ${savedMode.reason || "unavailable"}.`;
  } else if (Array.isArray(savedMode.supportedFrameworks) && !savedMode.supportedFrameworks.includes(framework)) {
    reason = `Saved runtime mode '${String(savedExecution.runtime_mode)}' does not support framework '${String(framework)}'.`;
  } else {
    reason = `Saved runtime mode '${String(savedExecution.runtime_mode)}' is no longer selectable.`;
  }
  return {status: "unavailable", reason, selectable};
}

export function formatRuntimeModeLabel(mode, capabilities) {
  if (mode.id === RUNTIME_MODE_IDS.wsl2Strong) {
    const distro = mode.distro ?? capabilities?.usableWslDistro ?? null;
    if (capabilities?.currentPlatform === "native-windows") {
      const label = typeof distro === "string" && distro ? distro : "<distro>";
      return `Inside WSL (${label}) — Recommended. Full protection: the system itself\n   blocks reviewers from changing your files. Your agent CLIs (claude,\n   opencode…) must be installed and signed in inside WSL.`;
    }
    return "WSL2 — full protection (bubblewrap) inside WSL";
  }
  if (mode.id === RUNTIME_MODE_IDS.linuxStrong) {
    return "Linux — full protection (bubblewrap)";
  }
  return "On Windows directly — Simpler. Each reviewer works on a temporary copy\n   of your project, so your files stay safe, but the system doesn't enforce it.\n   Not for GSD projects.";
}

export function formatRuntimeResult(execution, capabilities) {
  if (!execution) return [];
  if (execution.runtime_mode === RUNTIME_MODE_IDS.wsl2Strong) {
    if (capabilities?.currentPlatform === "native-windows") {
      const distro = execution.wsl_distro ?? capabilities?.usableWslDistro ?? null;
      return [`✓ Reviewers run inside WSL (${typeof distro === "string" && distro ? distro : "<distro>"}).`];
    }
    return ["✓ Reviewers run with full protection (bubblewrap)."];
  }
  if (execution.runtime_mode === RUNTIME_MODE_IDS.linuxStrong) {
    return ["✓ Reviewers run with full protection (bubblewrap)."];
  }
  if (execution.runtime_mode === RUNTIME_MODE_IDS.windowsCompatibility) {
    return [
      "✓ Reviewers run on Windows: each one works on a temporary copy of your\n" +
      "  project, so your files stay safe."
    ];
  }
  return [];
}

function distroFromReason(reason) {
  const text = String(reason || "");
  const patterns = [
    /bubblewrap_not_installed_in_distro:([^;:)]+)/,
    /bubblewrap_(?:sandbox_)?unusable_in_distro:([^;:)]+)/,
    /node_missing_in_distro:([^;:)]+)/,
    /node_unusable_in_distro:([^;:)]+)/,
    /wsl1_only_no_usable_wsl2_distro:\s*([^;(]+)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1] && match[1].trim()) return match[1].trim();
  }
  return null;
}

function wslUnavailableReason(capabilities) {
  return capabilities?.modes?.find(entry => entry?.id === RUNTIME_MODE_IDS.wsl2Strong)?.reason || "";
}

export function isWslNotInstalled(capabilities) {
  return wslUnavailableReason(capabilities) === "wsl_not_installed";
}

export function formatWslUnavailable(capabilities) {
  const reason = wslUnavailableReason(capabilities);
  if (!reason || reason === "wsl_not_installed") return null;
  const distro = distroFromReason(reason) || "<distro>";
  if (/bubblewrap_not_installed_in_distro/.test(reason)) {
    return `ℹ WSL2 found but not usable: bubblewrap is not installed inside ${distro}\n  (fix: run "sudo apt install bubblewrap" in ${distro}, then ap setup again).`;
  }
  if (/bubblewrap_(?:sandbox_)?unusable_in_distro/.test(reason)) {
    return `ℹ WSL2 found but not usable: bubblewrap is not working inside ${distro}\n  (fix: run "sudo apt install --reinstall bubblewrap" in ${distro}, then ap setup again).`;
  }
  if (/node_missing_in_distro/.test(reason)) {
    return `ℹ WSL2 found but not usable: Node.js is not installed inside ${distro}\n  (fix: install Node.js inside ${distro}, then ap setup again).`;
  }
  if (/node_unusable_in_distro|malformed_node_output/.test(reason)) {
    return `ℹ WSL2 found but not usable: Node.js is not working inside ${distro}\n  (fix: reinstall Node.js inside ${distro}, then ap setup again).`;
  }
  if (/wsl1/i.test(reason)) {
    return `ℹ WSL found but it is WSL1; reviewers need WSL2 (fix: wsl --set-version ${distro} 2).`;
  }
  if (/no_distro_installed/.test(reason)) {
    return "ℹ WSL2 found but not usable: no Linux distribution is installed in WSL\n  (fix: install one with \"wsl --install -d Ubuntu\", then ap setup again).";
  }
  if (/timed_out/.test(reason)) {
    return "ℹ WSL2 found but not usable: the check timed out (fix: run ap setup again).";
  }
  return `ℹ WSL2 found but not usable (${reason}).`;
}

function plainSavedUnavailableReason({savedExecution, capabilities, framework, classification}) {
  if (classification?.status === "invalid") {
    return `the saved value is invalid (${classification.reason})`;
  }
  if (/Saved WSL distro/.test(classification?.reason || "")) {
    const currentDistro =
      capabilities?.modes?.find(entry => entry?.id === RUNTIME_MODE_IDS.wsl2Strong)?.distro ??
      capabilities?.usableWslDistro ??
      null;
    return `the WSL distribution '${String(savedExecution?.wsl_distro)}' is no longer available${
      typeof currentDistro === "string" && currentDistro ? ` (found '${currentDistro}')` : ""
    }`;
  }
  const savedMode = capabilities?.modes?.find(entry => entry?.id === savedExecution?.runtime_mode);
  if (!savedMode) return "it is not recognised on this machine";
  if (
    savedMode.available === true &&
    Array.isArray(savedMode.supportedFrameworks) &&
    !savedMode.supportedFrameworks.includes(framework)
  ) {
    return `it no longer supports framework '${String(framework)}'`;
  }
  const reason = savedMode.reason || "";
  if (reason === "wsl_not_installed") return "WSL is not installed";
  if (/no_distro_installed/.test(reason)) return "no Linux distribution is installed in WSL";
  if (/wsl1/i.test(reason)) return "WSL1 is not supported; reviewers need WSL2";
  if (/bubblewrap_not_installed/.test(reason)) return "bubblewrap is not installed inside WSL";
  if (/bubblewrap/.test(reason)) return "bubblewrap is not working inside WSL";
  if (/node_missing/.test(reason)) return "Node.js is not installed inside WSL";
  if (/node_unusable|malformed_node/.test(reason)) return "Node.js is not working inside WSL";
  if (/not_applicable_current_platform_is_native_linux/.test(reason)) return "Windows runtime modes do not apply on Linux";
  if (/not_applicable_current_platform_is_native_windows/.test(reason)) return "it is not available on Windows";
  if (/not_applicable_current_platform_is_wsl2/.test(reason)) return "it is not available inside WSL2";
  return `it is no longer available (${reason || "unknown reason"})`;
}

function isStrongModeId(modeId) {
  return modeId === RUNTIME_MODE_IDS.wsl2Strong || modeId === RUNTIME_MODE_IDS.linuxStrong;
}

export function resolveRuntimeExecution({capabilities, framework, savedExecution, userChoiceId}) {
  const selectable = getSelectableRuntimeModes(capabilities, framework);
  const wslStrong = capabilities?.modes?.find(entry => entry?.id === RUNTIME_MODE_IDS.wsl2Strong);

  if (selectable.length === 0) {
    const wslReason =
      wslStrong && wslStrong.available !== true
        ? ` WSL2 Strong is unavailable: ${wslStrong.reason || "unavailable"}.`
        : "";
    const compatNote =
      framework === "gsd"
        ? ` Windows Compatibility supports SpecKit and standalone only, and cannot be used with framework '${framework}'.`
        : "";
    return {
      status: "error",
      error: `No runtime mode supports framework '${String(framework)}'.${wslReason}${compatNote} Configuration not saved.`,
      selectable,
      messages: [
        `No runtime mode supports framework '${String(framework)}'.`,
        ...(wslReason ? [`WSL2 Strong is unavailable: ${wslStrong.reason || "unavailable"}.`] : []),
        ...(compatNote ? [`Windows Compatibility supports SpecKit and standalone only, and cannot be used with framework '${framework}'.`] : [])
      ]
    };
  }

  if (userChoiceId !== undefined && userChoiceId !== null) {
    if (!selectable.some(mode => mode.id === userChoiceId)) {
      return {
        status: "error",
        error: `Runtime mode '${String(userChoiceId)}' is unavailable and cannot be selected. Configuration not saved.`,
        selectable,
        messages: [`Runtime mode '${String(userChoiceId)}' is unavailable and cannot be selected.`]
      };
    }
    const execution = buildExecutionConfig(userChoiceId, capabilities);
    return {status: "selected", execution, selectable, messages: formatRuntimeResult(execution, capabilities)};
  }

  const classification = classifySavedRuntimeExecution({savedExecution, capabilities, framework});
  if (classification.status === "preserved") {
    const execution = buildExecutionConfig(savedExecution.runtime_mode, capabilities);
    return {
      status: "preserved",
      execution,
      selectable,
      messages: formatRuntimeResult(execution, capabilities)
    };
  }

  // Fresh (never-saved) single STRONG mode: automatic selection is permitted.
  // Fresh single Compatibility, and every invalid/unavailable saved selection,
  // require an explicit choice — never auto-replace, never auto-save compat.
  if (classification.status === "missing") {
    if (selectable.length === 1 && isStrongModeId(selectable[0].id)) {
      const only = selectable[0];
      const execution = buildExecutionConfig(only.id, capabilities);
      return {status: "auto", execution, selectable, messages: formatRuntimeResult(execution, capabilities)};
    }
    const messages = [];
    if (capabilities?.currentPlatform === "native-windows" && selectable.length === 1) {
      const reason = formatWslUnavailable(capabilities);
      if (reason) messages.push(reason);
    }
    return {status: "need-choice", selectable, messages};
  }

  // Invalid or unavailable saved selection: explicit choice required, no execution.
  const messages = [];
  messages.push(
    `ℹ The saved setting (${savedExecution?.runtime_mode}) no longer works here: ` +
    `${plainSavedUnavailableReason({savedExecution, capabilities, framework, classification})}.`
  );
  if (capabilities?.currentPlatform === "native-windows" && selectable.length === 1) {
    const reason = formatWslUnavailable(capabilities);
    if (reason) messages.push(reason);
  }
  return {status: "need-choice", selectable, messages};
}
