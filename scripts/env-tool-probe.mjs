import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

export const KNOWN_ENV_TOOLS = Object.freeze([
  "docker",
  "docker-compose",
  "supabase",
  "psql",
  "pg_dump",
  "pg_restore",
  "redis-cli",
  "mysql",
  "mongosh",
  "kubectl",
  "terraform",
  "aws",
  "gcloud",
  "az"
]);

// Tools that require the Docker daemon/socket inside the sandbox (backlog #5):
// even if the binary exists in /usr/bin on the host, it cannot function inside
// the bwrap sandbox unless safety.allow_docker is enabled.
const DOCKER_DEPENDENT_TOOLS = new Set(["docker", "docker-compose", "supabase"]);

// Known subcommands for multi-word CLIs so plain prose (e.g. "supabase auth",
// "docker container") does not trigger false positives while command invocations
// (e.g. "docker compose up", "supabase db reset", "kubectl apply") do.
const TOOL_SUBCOMMANDS = Object.freeze({
  docker: "compose|build|run|ps|exec|up|down|pull|push|stop|start|rm|logs|network|volume|images|info|version|login|tag|inspect",
  "docker-compose": "up|down|build|ps|exec|logs|run|stop|start|restart|rm|config|pull|push|version",
  supabase: "db|start|stop|status|migration|functions|gen|link|login|init|projects|secrets|test|inspect|branches|storage|sso|domains|vanity-subdomains|network-bans|network-restrictions|postgres-config|ssl-enforcement|orgs|seed|snippets",
  kubectl: "get|apply|delete|describe|logs|exec|port-forward|config|create|patch|rollout|scale|ctx|ns|version|cluster-info",
  terraform: "init|plan|apply|destroy|validate|fmt|output|state|import|refresh|show|workspace|providers|version",
  aws: "s3|s3api|ec2|iam|lambda|sts|eks|rds|ecr|ecs|logs|sqs|sns|dynamodb|cloudformation|ssm|secretsmanager|configure|sso",
  gcloud: "auth|config|compute|run|projects|sql|storage|iam|container|builds|functions|pubsub|secrets|logging|info|version",
  az: "login|account|aks|acr|group|storage|webapp|keyvault|sql|postgres|monitor|network|vm|ad|role|deployment|version",
  "redis-cli": "ping|get|set|del|keys|info|flushdb|flushall|monitor|subscribe|publish|scan|hget|hset",
  psql: "",
  pg_dump: "",
  pg_restore: "",
  mysql: "",
  mongosh: ""
});

// Standard system directories mounted read-only into the bwrap sandbox.
const SANDBOX_SYSTEM_MOUNTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
// Directories replaced with empty --tmpfs inside the bwrap sandbox unless explicitly bound.
const SANDBOX_TMPFS_DIRS = ["/home", "/root", "/run"];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract external CLI tools named in task, verify, or plan text.
 *
 * Matching rules (case-sensitive lowercase, whole-token only):
 *  - Token boundaries reject substrings and dot/hyphen-joined identifiers
 *    (e.g. "dockerfile", "supabase.from", "foo-psql").
 *  - Product prose with capitals (e.g. "Supabase Auth", "Docker", "MySQL")
 *    never matches because CLI tool names are matched in exact lowercase.
 *  - A lowercase tool token matches only in command position:
 *    1) inside backticks (e.g. "`supabase db reset`", "`psql`")
 *    2) followed by a CLI flag (e.g. "psql -v ON_ERROR_STOP=1", "pg_dump --schema-only")
 *    3) followed by a known CLI subcommand (e.g. "docker compose up", "supabase db reset")
 *    4) immediately preceded by a command introducer (run/execute/verify:/$/&&/||/;/|)
 *       and followed by a flag or argument token.
 *
 * @param {string} text
 * @returns {string[]} Sorted unique tool names from KNOWN_ENV_TOOLS.
 */
export function extractRequiredTools(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const found = new Set();

  for (const tool of KNOWN_ENV_TOOLS) {
    const escaped = escapeRegex(tool);
    const subcommands = TOOL_SUBCOMMANDS[tool] || "";

    // Whole-token boundaries: not preceded or followed by word, dot, or hyphen.
    const leftBound = "(?<![\\w.-])";
    const rightBound = "(?![\\w.-])";

    // 1) Backtick-quoted command: `tool` or `tool <args>` or `... && tool ...`
    const backtickRe = new RegExp("`[^`\\n]*" + leftBound + escaped + rightBound + "(?:\\s+[^`\\n]*)?`");
    if (backtickRe.test(text)) {
      found.add(tool);
      continue;
    }

    // 2) Followed by a CLI flag: `tool -x` or `tool --flag`
    const flagRe = new RegExp(leftBound + escaped + rightBound + "\\s+-[a-zA-Z0-9-]");
    if (flagRe.test(text)) {
      found.add(tool);
      continue;
    }

    // 3) Followed by a known subcommand: e.g. `docker compose`, `supabase db`
    if (subcommands) {
      const subRe = new RegExp(leftBound + escaped + rightBound + "\\s+(?:" + subcommands + ")(?![\\w-])");
      if (subRe.test(text)) {
        found.add(tool);
        continue;
      }
    }

    // 4) Preceded by a command introducer (run, execute, verify:, $, &&, ||, ;, |)
    //    and followed by whitespace + an argument/flag token (or end of line).
    const introducerRe = new RegExp(
      "(?:^|[\\r\\n]|(?:\\brun|\\bexecute|\\bverify:|\\bcommand:|\\$|&&|\\|\\||;|\\|)\\s+)" +
      leftBound + escaped + rightBound +
      "(?=\\s+(?:-[a-zA-Z0-9-]|[a-z0-9_./\"'$]))"
    );
    if (introducerRe.test(text)) {
      found.add(tool);
    }
  }

  return [...found].sort();
}

function isWithin(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realPathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function extractBoundPathsFromEnvelope(envelope) {
  const bound = [];
  if (Array.isArray(envelope?.args)) {
    const args = envelope.args;
    for (let i = 0; i < args.length - 2; i++) {
      if (args[i] === "--ro-bind" || args[i] === "--bind") {
        bound.push(realPathSafe(args[i + 1]));
        i += 2;
      }
    }
  }
  if (Array.isArray(envelope?.sandbox?.dockerBinDirs)) {
    for (const d of envelope.sandbox.dockerBinDirs) bound.push(realPathSafe(d));
  }
  return bound;
}

function isDockerAllowedInEnvelope(envelope, allowDockerOpt) {
  if (typeof allowDockerOpt === "boolean") return allowDockerOpt;
  if (envelope?.config?.safety?.allow_docker === true) return true;
  if (envelope?.config?.policy?.allow_docker === true) return true;
  if (envelope?.safety?.allow_docker === true) return true;
  if (envelope?.policy?.allow_docker === true) return true;
  if (envelope?.sandbox?.allowDocker === true) return true;
  if (Array.isArray(envelope?.args) && envelope.args.includes("/var/run/docker.sock")) return true;
  return false;
}

function resolveToolOnPath(tool, env, timeoutMs = 2000) {
  try {
    const shBin = process.platform !== "win32" && fs.existsSync("/bin/sh") ? "/bin/sh" : "sh";
    const res = spawnSync(shBin, ["-c", 'command -v "$1"', "--", tool], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      env,
      shell: false
    });
    if (res.error || res.status !== 0) return null;
    const out = String(res.stdout || "").trim().split(/\r?\n/)[0]?.trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Probe which tools from `tools` resolve inside the configured agent sandbox.
 * Never throws.
 *
 * @param {string[]} tools
 * @param {{envelope?: object|null, env?: object, pathEnv?: string, allowDocker?: boolean, timeoutMs?: number}} [opts]
 * @returns {{available: string[], missing: string[]}}
 */
export function probeTools(tools, {envelope = null, env = null, pathEnv = null, allowDocker = undefined, timeoutMs = 2000} = {}) {
  const available = [];
  const missing = [];
  if (!Array.isArray(tools) || tools.length === 0) return {available, missing};

  const uniqueTools = [...new Set(tools.filter((t) => typeof t === "string" && t.trim()))].sort();
  const dockerAllowed = isDockerAllowedInEnvelope(envelope, allowDocker);
  const hasBwrapArgs = Array.isArray(envelope?.args) && envelope.args.length > 0;
  const boundPaths = hasBwrapArgs ? extractBoundPathsFromEnvelope(envelope) : [];

  const effectiveEnv = env
    ? {...env}
    : (pathEnv != null ? {...process.env, PATH: pathEnv} : {...process.env});

  for (const tool of uniqueTools) {
    // Respect backlog #5: docker/docker-compose/supabase cannot work inside the
    // sandbox unless safety.allow_docker is enabled.
    if (DOCKER_DEPENDENT_TOOLS.has(tool) && !dockerAllowed) {
      missing.push(tool);
      continue;
    }

    const foundPath = resolveToolOnPath(tool, effectiveEnv, timeoutMs);
    if (!foundPath) {
      missing.push(tool);
      continue;
    }

    const resolved = realPathSafe(foundPath);

    if (hasBwrapArgs) {
      // Full envelope supplied: binary must be inside a path bound into bwrap.
      const visible = boundPaths.some((root) => isWithin(root, resolved));
      if (!visible) {
        missing.push(tool);
        continue;
      }
    } else if (envelope != null) {
      // Config/policy object supplied without bwrap args: binaries under
      // tmpfs-masked directories (/home, /root, /run) are invisible unless
      // they are docker/supabase with allow_docker enabled (which ro-binds
      // their directory).
      const hiddenByTmpfs = SANDBOX_TMPFS_DIRS.some((dir) => isWithin(dir, resolved));
      const boundByAllowDocker = dockerAllowed && (tool === "docker" || tool === "supabase");
      if (hiddenByTmpfs && !boundByAllowDocker) {
        missing.push(tool);
        continue;
      }
    }

    available.push(tool);
  }

  return {available, missing};
}

/**
 * One-sentence environment-tools status note; empty string when nothing is missing.
 *
 * @param {{available?: string[], missing?: string[]}} result
 * @returns {string}
 */
export function envToolsPromptNote({available = [], missing = []} = {}) {
  const miss = Array.isArray(missing) ? missing.filter(Boolean) : [];
  if (miss.length === 0) return "";
  const avail = Array.isArray(available) ? available.filter(Boolean) : [];
  const availSuffix = avail.length ? ` (available: ${avail.join(", ")})` : "";
  return `Environment tools: ${miss.join(", ")} are not available inside the agent sandbox${availSuffix}.`;
}

/**
 * Plan-review BLOCKING rule when required environment tools are missing.
 *
 * @param {string[]} missing
 * @returns {string}
 */
export function planReviewEnvToolsRule(missing) {
  const miss = Array.isArray(missing) ? missing.filter(Boolean) : [];
  if (miss.length === 0) return "";
  return `Environment tools (BLOCKING): ${miss.join(", ")} are not available to the implementer. FAIL any task whose implementation or verify needs one of them, citing the task ID; the fix is to make it an operator/manual task (marked \`[manual]\` with the exact command for the operator) or drop it.`;
}

/**
 * Planner brief note when required environment tools are missing.
 *
 * @param {string[]} missing
 * @returns {string}
 */
export function plannerEnvToolsRule(missing) {
  const miss = Array.isArray(missing) ? missing.filter(Boolean) : [];
  if (miss.length === 0) return "";
  return `Environment tools: ${miss.join(", ")} are not available to the implementer inside the sandbox. Do not create tasks whose implementation or verify needs one of them, except as operator/manual tasks marked \`[manual]\` with the exact command for the operator.`;
}

// ---------------------------------------------------------------------------
// Manual task helpers (backlog #3): tasks marked `[manual]` are never sent to
// the implementer; they are skipped as "manual — for the operator".
// ---------------------------------------------------------------------------

export const MANUAL_TASK_NOTE = "manual — for the operator";

export function isManualTask(task) {
  const text = typeof task === "string" ? task : String(task?.text || "");
  return /\[manual\]/i.test(text);
}

export function splitManualTasks(tasks) {
  const manual = [];
  const automated = [];
  for (const task of (Array.isArray(tasks) ? tasks : [])) {
    if (isManualTask(task)) manual.push(task);
    else automated.push(task);
  }
  return {manual, automated};
}

export function recordManualTasks(state, tasks, {phaseName = "", phaseIndex = null, at = null} = {}) {
  if (!state || typeof state !== "object" || !Array.isArray(tasks) || !tasks.length) return [];
  if (!Array.isArray(state.manualTasks)) state.manualTasks = [];
  const recorded = [];
  for (const t of tasks) {
    const text = String(t?.text || "").trim();
    if (!text) continue;
    const key = t?.file && t?.line ? `${t.file}:${t.line}` : text;
    const exists = state.manualTasks.some((entry) => {
      const entryKey = entry?.file && entry?.line ? `${entry.file}:${entry.line}` : String(entry?.text || "").trim();
      return entryKey === key;
    });
    if (exists) continue;
    const entry = {
      id: t?.id || null,
      phase: phaseName || null,
      phaseIndex: Number.isInteger(phaseIndex) ? phaseIndex : null,
      text,
      file: t?.file || null,
      line: Number.isInteger(t?.line) ? t.line : null,
      note: MANUAL_TASK_NOTE,
      at: at || new Date().toISOString()
    };
    state.manualTasks.push(entry);
    recorded.push(entry);
  }
  return recorded;
}

export function formatManualTasksLines(manualTasks) {
  const list = Array.isArray(manualTasks) ? manualTasks.filter((t) => t && typeof t.text === "string" && t.text.trim()) : [];
  if (!list.length) return [];
  return list.map((t) => {
    const phasePrefix = t.phase ? `[${t.phase}] ` : (Number.isInteger(t.phaseIndex) ? `[Phase ${t.phaseIndex + 1}] ` : "");
    return `- ${phasePrefix}${t.text.trim()} (${t.note || MANUAL_TASK_NOTE})`;
  });
}

export {SANDBOX_SYSTEM_MOUNTS};
