import dns from "node:dns/promises";
import { defaultInterruptibleSleep } from "./rate-limit-wait.mjs";

export const NETWORK_WAIT_BACKOFF_SECONDS = Object.freeze([30, 60, 120, 300]);
export const DEFAULT_NETWORK_WAIT_MINUTES = 60;
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;

export const PROVIDER_HOST_BY_ADAPTER = Object.freeze({
  claude: "api.anthropic.com",
  codex: "api.openai.com",
  opencode: "opencode.ai",
  antigravity: "generativelanguage.googleapis.com",
});

export function providerHostForAdapter(adapter) {
  const key = typeof adapter === "string" ? adapter.trim().toLowerCase() : "";
  return PROVIDER_HOST_BY_ADAPTER[key] || "api.anthropic.com";
}

export async function defaultDnsProbe(host) {
  const target = typeof host === "string" && host.trim() ? host.trim() : "api.anthropic.com";
  let timer = null;
  try {
    await Promise.race([
      dns.lookup(target),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("dns probe timeout")), PROBE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const __networkWaitHooks = {
  now: () => Date.now(),
  sleep: defaultInterruptibleSleep,
  probe: defaultDnsProbe,
};

export function extractNetworkEvidence(result) {
  const ev = Array.isArray(result?.failure?.evidence) ? result.failure.evidence : [];
  for (const item of ev) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
    if (typeof item.message === "string" && item.message.trim()) return item.message.trim();
    if (typeof item.match === "string" && item.match.trim()) return item.match.trim();
  }
  return "network error";
}

export function applyNetworkWaitExhaustedEvidence(result, maxWaitMin, evidenceText) {
  if (!result || typeof result !== "object") return result;
  const existing = Array.isArray(result.failure?.evidence) ? result.failure.evidence : [];
  const nextEvidence = [
    ...existing,
    { type: "network_unavailable", maxWaitMin, text: evidenceText },
  ];
  return {
    ...result,
    networkWaitExhausted: { maxWaitMin, evidence: evidenceText },
    failure: result.failure
      ? { ...result.failure, evidence: nextEvidence }
      : result.failure,
  };
}

export async function waitForNetworkRecovery({
  result,
  config,
  state,
  roleName,
  adapter,
  model = null,
  waitState = null,
  persistState = true,
  saveState = () => {},
  refreshWatchReport = () => {},
  appendWatchEvent = () => {},
  missionDir = null,
} = {}) {
  const rawMax = config?.advanced?.network_wait_minutes ?? config?.policy?.network_wait_minutes ?? DEFAULT_NETWORK_WAIT_MINUTES;
  const maxWaitMin = Number.isFinite(Number(rawMax)) ? Math.max(0, Number(rawMax)) : DEFAULT_NETWORK_WAIT_MINUTES;
  const nowMs = __networkWaitHooks.now();
  const startedAtMs = waitState?.startedAtMs ?? nowMs;
  const attempt = waitState?.attempt ?? 0;
  const evidence = extractNetworkEvidence(result);
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  const maxWaitMs = maxWaitMin * 60_000;

  if (maxWaitMin <= 0 || elapsedMs >= maxWaitMs) {
    return {
      action: "escalate",
      maxWaitMin,
      elapsedMs,
      evidence,
      waitState: { startedAtMs, attempt },
    };
  }

  const stepSec = NETWORK_WAIT_BACKOFF_SECONDS[Math.min(attempt, NETWORK_WAIT_BACKOFF_SECONDS.length - 1)];
  const remainingMs = maxWaitMs - elapsedMs;
  let waitMs = Math.min(stepSec * 1000, remainingMs);

  const testCapRaw = process.env.AUTOPILOT_TEST_NETWORK_WAIT_MS;
  if (testCapRaw !== undefined && testCapRaw !== "") {
    const testCap = Number(testCapRaw);
    if (Number.isFinite(testCap) && testCap >= 0) {
      waitMs = Math.min(waitMs, testCap);
    }
  }

  const waitSec = Math.round(waitMs / 1000);
  const elapsedMin = Math.floor(elapsedMs / 60_000);
  console.log(`network unavailable (${evidence}) — waiting ${waitSec}s before retrying ${roleName} (${elapsedMin}/${maxWaitMin} min)`);

  if (state && typeof state === "object") {
    state.networkWait = {
      role: roleName,
      adapter: adapter || null,
      evidence,
      waitSec,
      elapsedMin,
      maxWaitMin,
      startedAt: new Date(startedAtMs).toISOString(),
    };
    if (persistState) { try { saveState(state); } catch {} }
    try { refreshWatchReport(state); } catch {}
  }

  if (missionDir) {
    try {
      appendWatchEvent(missionDir, {
        type: "operator",
        reason: "network_wait",
        role: roleName,
        adapter: adapter || null,
        model: model || null,
        waitSec,
        elapsedMin,
        maxWaitMin,
        evidence,
      });
    } catch {}
  }

  let interrupted = false;
  let early = false;
  let sleptMs = 0;
  let sawProbeFailure = false;
  const host = providerHostForAdapter(adapter);
  try {
    let left = waitMs;
    while (left > 0) {
      if (state?.phase === "stopped" || state?.phase === "cancelled") {
        interrupted = true;
        break;
      }
      const chunk = Math.min(left, PROBE_INTERVAL_MS);
      if (typeof __networkWaitHooks.sleep === "function") {
        await __networkWaitHooks.sleep(chunk, { state, roleName, adapter, waitMs, chunk });
      }
      sleptMs += chunk;
      left -= chunk;
      if (state?.phase === "stopped" || state?.phase === "cancelled") {
        interrupted = true;
        break;
      }
      if (left > 0 && typeof __networkWaitHooks.probe === "function") {
        const ok = await __networkWaitHooks.probe(host);
        if (!ok) {
          sawProbeFailure = true;
        } else if (sawProbeFailure) {
          early = true;
          break;
        }
      }
    }
  } catch {
    interrupted = true;
  } finally {
    if (state && typeof state === "object") {
      delete state.networkWait;
      if (persistState) { try { saveState(state); } catch {} }
      try { refreshWatchReport(state); } catch {}
    }
  }

  if (interrupted || state?.phase === "stopped" || state?.phase === "cancelled") {
    return {
      action: "interrupted",
      sleptMs,
      early: false,
      waitState: { startedAtMs, attempt: attempt + 1 },
    };
  }

  return {
    action: "retry",
    sleptMs,
    early,
    waitState: { startedAtMs, attempt: attempt + 1 },
  };
}
