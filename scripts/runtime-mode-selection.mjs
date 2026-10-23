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
    const distroSuffix =
      capabilities?.currentPlatform === "native-windows" && typeof distro === "string" && distro
        ? ` via distro '${distro}'`
        : "";
    return `WSL2 Strong (Recommended) — OS-enforced bubblewrap containment${distroSuffix}`;
  }
  if (mode.id === RUNTIME_MODE_IDS.linuxStrong) {
    return "Linux Strong — OS-enforced bubblewrap containment";
  }
  return "Windows Compatibility — SpecKit-and-standalone disposable-copy isolation (not OS-enforced containment)";
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
    const messages = [];
    if (userChoiceId === RUNTIME_MODE_IDS.wsl2Strong) {
      if (capabilities?.currentPlatform === "native-windows") {
        messages.push(`Selected WSL2 Strong (Recommended) — OS-enforced bubblewrap containment via distro '${execution.wsl_distro}'.`);
      } else {
        messages.push("Selected wsl2-strong — read-only roles use OS-enforced bubblewrap containment.");
      }
    } else if (userChoiceId === RUNTIME_MODE_IDS.linuxStrong) {
      messages.push("Selected linux-strong — read-only roles use OS-enforced bubblewrap containment.");
    } else {
      messages.push("Selected Windows Compatibility — SpecKit-and-standalone disposable-copy isolation. This is not OS-enforced containment.");
      messages.push("Warning: Windows Compatibility is weaker and not OS-enforced containment.");
    }
    return {status: "selected", execution, selectable, messages};
  }

  const classification = classifySavedRuntimeExecution({savedExecution, capabilities, framework});
  if (classification.status === "preserved") {
    const execution = buildExecutionConfig(savedExecution.runtime_mode, capabilities);
    return {
      status: "preserved",
      execution,
      selectable,
      messages: [
        `Preserving saved runtime mode '${savedExecution.runtime_mode}' (still available for framework '${String(framework)}').`
      ]
    };
  }

  // Fresh (never-saved) single STRONG mode: automatic selection is permitted.
  // Fresh single Compatibility, and every invalid/unavailable saved selection,
  // require an explicit choice — never auto-replace, never auto-save compat.
  if (classification.status === "missing") {
    if (selectable.length === 1 && isStrongModeId(selectable[0].id)) {
      const only = selectable[0];
      const execution = buildExecutionConfig(only.id, capabilities);
      const messages = [];
      if (only.id === RUNTIME_MODE_IDS.wsl2Strong) {
        if (capabilities?.currentPlatform === "native-windows") {
          messages.push(`Selected WSL2 Strong (Recommended) — OS-enforced bubblewrap containment via distro '${execution.wsl_distro}'.`);
        } else {
          messages.push("Selected wsl2-strong — read-only roles use OS-enforced bubblewrap containment.");
        }
      } else {
        messages.push("Selected linux-strong — read-only roles use OS-enforced bubblewrap containment.");
      }
      return {status: "auto", execution, selectable, messages};
    }
    const messages = [];
    if (capabilities?.currentPlatform === "native-windows") {
      if (wslStrong && wslStrong.available !== true) {
        messages.push(`WSL2 Strong is unavailable: ${wslStrong.reason || "unavailable"}.`);
      }
      messages.push("Runtime execution mode — choose one:");
      for (const mode of selectable) {
        messages.push(`- ${formatRuntimeModeLabel(mode, capabilities)}`);
      }
      messages.push("WSL2 Strong (Recommended) uses OS-enforced bubblewrap containment.");
      messages.push("Windows Compatibility is SpecKit-and-standalone disposable-copy isolation. This is not OS-enforced containment.");
    }
    return {status: "need-choice", selectable, messages};
  }

  // Invalid or unavailable saved selection: explicit choice required, no execution.
  const messages = [];
  messages.push(`Saved runtime mode is ${classification.status}: ${classification.reason} Please choose a valid mode.`);
  if (capabilities?.currentPlatform === "native-windows") {
    if (wslStrong && wslStrong.available !== true) {
      messages.push(`WSL2 Strong is unavailable: ${wslStrong.reason || "unavailable"}.`);
    }
    messages.push("Runtime execution mode — choose one:");
    for (const mode of getSelectableRuntimeModes(capabilities, framework)) {
      messages.push(`- ${formatRuntimeModeLabel(mode, capabilities)}`);
    }
    messages.push("WSL2 Strong (Recommended) uses OS-enforced bubblewrap containment.");
    messages.push("Windows Compatibility is SpecKit-and-standalone disposable-copy isolation. This is not OS-enforced containment.");
    messages.push("Warning: never silently switches between Strong and Compatibility modes.");
  }
  return {status: "need-choice", selectable, messages};
}
