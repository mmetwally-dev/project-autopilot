// Pure helpers for classifying a failed live `ap run` attempt (backlog #16).
import {isLiveQuotaExhausted} from "./live-test-model.mjs";

export function liveRunDiagnosticText(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  const parts = [];
  if (input.failureClass != null) parts.push(String(input.failureClass));
  for (const key of ["output", "stdout", "stderr", "progress", "progressLog", "progress_log", "status", "statusJson", "status_json", "text", "message", "reason"]) {
    const value = input[key];
    if (value == null) continue;
    parts.push(typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return parts.join("\n");
}

export function classifyLiveRunFailure(input) {
  const text = liveRunDiagnosticText(input);
  if (!text.trim()) return {skip: false, reason: null};

  if (isLiveQuotaExhausted({failureClass: typeof input === "object" ? input?.failureClass : null, output: text})) {
    return {skip: true, reason: "free quota/rate limit exhausted"};
  }
  if (/model unavailable|provider\.no-route|provider\.no_route|no-route/i.test(text)) {
    return {skip: true, reason: "provider.no-route / Model unavailable"};
  }
  if (/unexpected server error/i.test(text)) {
    return {skip: true, reason: "Unexpected server error"};
  }
  if (/ECONNRESET|ETIMEDOUT|fetch failed|network error|network timeout/i.test(text)) {
    return {skip: true, reason: "network error (ECONNRESET/ETIMEDOUT/fetch failed)"};
  }
  if (/\bIDLE_HANG\b/.test(text)) {
    return {skip: true, reason: "IDLE_HANG watchdog kill"};
  }
  return {skip: false, reason: null};
}

export function isLiveRunSkip(input) {
  return classifyLiveRunFailure(input).skip === true;
}
