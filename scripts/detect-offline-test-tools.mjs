import fs from "node:fs";
import path from "node:path";

export const OFFLINE_TEST_TOOL_CATALOG = [
  ["@electric-sql/pglite", "PGlite (@electric-sql/pglite) for PostgreSQL"],
  ["pg-mem", "pg-mem for PostgreSQL"],
  ["better-sqlite3", "better-sqlite3 (SQLite)"],
  ["mongodb-memory-server", "mongodb-memory-server for MongoDB"],
  ["msw", "msw for HTTP mocks"],
  ["nock", "nock for HTTP mocks"],
];

/**
 * Detects in-process test databases / mock libraries in a repository.
 * Reads package.json (dependencies + devDependencies) and also checks
 * node_modules/<pkg>/package.json existence (to catch transitive installs).
 *
 * @param {string} repoDir
 * @returns {string} Semicolon-joined list of tool labels, or "" if none. Never throws.
 */
export function detectOfflineTestTools(repoDir) {
  if (!repoDir || typeof repoDir !== "string") return "";

  const declared = new Set();
  try {
    const pkgJsonPath = path.join(repoDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      const content = fs.readFileSync(pkgJsonPath, "utf8");
      const data = JSON.parse(content);
      if (data && typeof data === "object") {
        if (data.dependencies && typeof data.dependencies === "object") {
          for (const key of Object.keys(data.dependencies)) {
            declared.add(key);
          }
        }
        if (data.devDependencies && typeof data.devDependencies === "object") {
          for (const key of Object.keys(data.devDependencies)) {
            declared.add(key);
          }
        }
      }
    }
  } catch {}

  const foundLabels = [];
  for (const [pkg, label] of OFFLINE_TEST_TOOL_CATALOG) {
    let present = declared.has(pkg);
    if (!present) {
      try {
        const segments = pkg.split("/");
        const nodeModulesPkg = path.join(repoDir, "node_modules", ...segments, "package.json");
        if (fs.existsSync(nodeModulesPkg)) {
          present = true;
        }
      } catch {}
    }
    if (present) {
      foundLabels.push(label);
    }
  }

  return foundLabels.join("; ");
}
