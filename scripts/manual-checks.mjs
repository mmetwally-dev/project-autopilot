import fs from "node:fs";
import path from "node:path";

export function appendManualChecks(missionDir, { phaseName, notes, at } = {}) {
  try {
    if (!Array.isArray(notes) || notes.length === 0) return false;
    if (typeof missionDir !== "string" || !missionDir.trim()) return false;

    const filePath = path.join(missionDir, "MANUAL-CHECKS.md");
    fs.mkdirSync(missionDir, { recursive: true });

    let content = "";
    if (!fs.existsSync(filePath)) {
      content += "# Manual checks the operator must do by hand\n\n";
    }

    const isoAt = at || new Date().toISOString();
    const sectionName = phaseName || "unknown";
    content += `## ${sectionName} (${isoAt})\n`;
    for (const note of notes) {
      content += `- ${note}\n`;
    }
    content += "\n";

    fs.appendFileSync(filePath, content, "utf8");
    return true;
  } catch {
    return false;
  }
}
