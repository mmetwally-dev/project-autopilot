#!/usr/bin/env node
// Security checklist helper (mission 066 task 1.1).
//
// Pure builder: takes an explicit repoRoot and returns the generic security
// checklist plus optional per-project items read from
// `.autopilot/security-checklist.md` under that root. Absent or unreadable
// project file yields the generic section only. Never throws; a missing or
// non-string repoRoot returns the generic section with no file read and no
// cwd fallback.
import fs from "node:fs";
import path from "node:path";

export const SECURITY_PROJECT_RELATIVE = ".autopilot/security-checklist.md";
export const SECURITY_PROJECT_MAX_CHARS = 2000;
export const SECURITY_TRUNCATION_NOTE = "[project checklist truncated to 2000 chars]";

const GENERIC_ITEMS = [
  "hardcoded secrets/tokens/credentials in code, config, or fixtures",
  "injection flaws: unescaped input reaching SQL, shell, or template sinks",
  "path traversal/SSRF via untrusted paths, URLs, or redirects",
  "broken auth/IDOR: missing ownership or permission checks on object access",
  "sensitive-data exposure through logs, errors, or API responses",
  "unsafe dependencies: new/updated packages or execution of remote code",
];

function genericSection() {
  const lines = [
    "### Security checklist",
    ...GENERIC_ITEMS.map((item) => `- ${item}`),
    "Report each finding with file:line and a short fix.",
  ];
  return lines.join("\n");
}

export function buildSecurityChecklistSection(repoRoot) {
  try {
    const generic = genericSection();
    if (typeof repoRoot !== "string" || repoRoot.length === 0) return generic;
    let projectRaw;
    try {
      projectRaw = fs.readFileSync(
        path.join(repoRoot, SECURITY_PROJECT_RELATIVE),
        "utf8",
      );
    } catch {
      return generic;
    }
    if (typeof projectRaw !== "string" || projectRaw.length === 0) return generic;
    let project = projectRaw;
    let note = "";
    if (project.length > SECURITY_PROJECT_MAX_CHARS) {
      project = project.slice(0, SECURITY_PROJECT_MAX_CHARS);
      note = `\n${SECURITY_TRUNCATION_NOTE}`;
    }
    return `${generic}\n\nProject-specific checks:\n${project}${note}`;
  } catch {
    return genericSection();
  }
}
