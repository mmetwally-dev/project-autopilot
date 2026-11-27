// Backlog #3: the `tests.app_server` question shared by `ap setup` and
// `ap config` (both run the same wizard in setup.mjs). Pure helpers only: the
// detection reads package.json, the resolvers turn typed answers into the
// config block. Nothing here starts a process.
import fs from "node:fs";
import path from "node:path";

export const APP_SERVER_HEADER =
  "\nApp server (optional): Autopilot starts your app before the tests and stops it afterwards, for tests that need a running server.";

// Suggest a start command from package.json scripts (dev, dev:web, start).
// Returns {start_command, cwd} or null.
export function detectAppServerCommand(repo) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")); }
  catch { return null; }
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
  const name = ["dev", "dev:web", "start"].find((n) => typeof scripts[n] === "string" && scripts[n].trim());
  if (!name) return null;
  const has = (f) => fs.existsSync(path.join(repo, f));
  const runner = has("pnpm-lock.yaml") ? "pnpm run" : has("yarn.lock") ? "yarn" : "npm run";
  const start_command = name === "start" && runner === "npm run" ? "npm start" : `${runner} ${name}`;
  return {start_command, cwd: ""};
}

export function appServerPrompt({existing, detected}) {
  if (existing) {
    return `${APP_SERVER_HEADER}\nCurrent: ${existing}\nEnter = keep it · type another command · "-" = no app server\n> `;
  }
  if (detected) {
    return `${APP_SERVER_HEADER}\nFound: ${detected.start_command}\nEnter = no app server · "y" = use it · type another command ({port} = the port)\n> `;
  }
  return null;
}

// -> {action:"keep"} | {action:"clear"} | {action:"set", start_command}
export function resolveAppServerAnswer({answer, existing, detected}) {
  const a = String(answer ?? "").trim();
  if (a === "-") return {action: "clear"};
  if (a === "") return existing ? {action: "keep"} : {action: "none"};
  if ((a.toLowerCase() === "y" || a.toLowerCase() === "yes") && detected && !existing) {
    return {action: "set", start_command: detected.start_command};
  }
  if (a.toLowerCase() === "y" && existing) return {action: "keep"};
  return {action: "set", start_command: a};
}

export function parsePathList(text) {
  return String(text ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith("/") ? p : `/${p}`));
}

export function normalizeReadyUrl(text) {
  const t = String(text ?? "").trim();
  if (!t) return "/";
  return t.startsWith("/") ? t : `/${t}`;
}

export function buildAppServerBlock({start_command, cwd = "", ready_url, warmup_urls, env_file, base = {}}) {
  return {
    start_command,
    cwd: base.cwd ?? cwd,
    port: base.port ?? "auto",
    ready_url,
    warmup_urls,
    ready_timeout_ms: base.ready_timeout_ms ?? 180000,
    env_file: env_file || "",
    env: base.env && typeof base.env === "object" ? base.env : {},
    allow_hosts: Array.isArray(base.allow_hosts) ? base.allow_hosts : [],
    credential_vars: Array.isArray(base.credential_vars) ? base.credential_vars : [],
  };
}
