export function formatLocalHHMM(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function parseRateLimitResetMs(evidence, events = []) {
  const all = [...(Array.isArray(evidence) ? evidence : []), ...(Array.isArray(events) ? events : [])];
  for (const item of all) {
    if (!item || typeof item !== "object") continue;
    const retryAt = item.retryAt ?? item.event?.retryAt;
    if (typeof retryAt === "string" && retryAt) {
      const ms = Date.parse(retryAt);
      if (Number.isFinite(ms)) return ms;
    }
    const resetsAt = item.resetsAt ?? item.event?.resetsAt ?? item.rate_limit_info?.resetsAt ?? item.event?.rate_limit_info?.resetsAt;
    if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
      return resetsAt < 1e11 ? resetsAt * 1000 : resetsAt;
    }
    if (typeof resetsAt === "string" && resetsAt) {
      const num = Number(resetsAt);
      if (Number.isFinite(num) && String(num) === resetsAt.trim()) {
        return num < 1e11 ? num * 1000 : num;
      }
      const ms = Date.parse(resetsAt);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

export function defaultInterruptibleSleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const cleanup = () => {
      process.removeListener("SIGINT", onSig);
      process.removeListener("SIGTERM", onSig);
    };
    const onSig = () => {
      if (timer) clearTimeout(timer);
      cleanup();
      resolve();
    };
    process.once("SIGINT", onSig);
    process.once("SIGTERM", onSig);
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

export const __rateLimitWaitHooks = {
  now: () => Date.now(),
  sleep: defaultInterruptibleSleep,
};

export function shouldWaitRateLimitReset(result, events, config, nowMs = __rateLimitWaitHooks.now()) {
  if (result?.failure?.class !== "RATE_LIMITED") return null;
  if (result?.fallbackSwitch?.to) return null;
  const resetMs = parseRateLimitResetMs(result.failure?.evidence, events);
  if (resetMs == null) return null;
  const maxWaitMin = Number(config?.advanced?.rate_limit_wait_max_minutes ?? config?.policy?.rate_limit_wait_max_minutes ?? 60);
  if (maxWaitMin <= 0) return null;
  const diffMs = resetMs - nowMs;
  if (diffMs < -60000 || diffMs > maxWaitMin * 60000) return null;
  const targetMs = resetMs + 60000;
  let waitMs = Math.max(0, targetMs - nowMs);
  const testCapRaw = process.env.AUTOPILOT_TEST_RATE_LIMIT_WAIT_MS;
  if (testCapRaw !== undefined && testCapRaw !== "") {
    const testCap = Number(testCapRaw);
    if (Number.isFinite(testCap) && testCap >= 0) {
      waitMs = Math.min(waitMs, testCap);
    }
  }
  return {
    resetMs,
    targetMs,
    waitMs,
    timeStr: formatLocalHHMM(resetMs),
  };
}
