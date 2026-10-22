import fs from "node:fs";
import path from "node:path";

import { updateSummary } from "./watch-summary.mjs";

export function localIso(d = new Date()) {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function appendWatchEvent(missionDir, event) {
  const eventsDir = path.join(missionDir, "watch-events.jsonl");
  fs.mkdirSync(path.dirname(eventsDir), { recursive: true });
  const enriched = {
    ...event,
    at: event.at ?? localIso(),
  };
  const line = JSON.stringify(enriched) + "\n";
  fs.appendFileSync(eventsDir, line);
  // Mission 094 Phase 3 task 3.2: events feed changed, refresh the summary
  // cache so a later render stays cached. Best-effort; never breaks callers.
  try {
    const missionDirNorm = path.resolve(missionDir);
    const missionsDir = path.dirname(missionDirNorm);
    const autopilotDir = path.dirname(missionsDir);
    if (path.basename(missionsDir) === "missions" && path.basename(autopilotDir) === ".autopilot") {
      const repo = path.dirname(autopilotDir);
      const mission = path.basename(missionDirNorm);
      updateSummary(repo, mission, { appendEvents: [enriched] });
    }
  } catch { /* ignore */ }
}