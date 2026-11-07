import path from "node:path";

function parseShellTokens(cmd) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === ";" || ch === "|") {
        return { hasChain: true, tokens: [] };
      }
      if (ch === "&" && cmd[i + 1] === "&") {
        return { hasChain: true, tokens: [] };
      }
      if (/\s/.test(ch)) {
        if (current.length > 0) {
          tokens.push(current);
          current = "";
        }
        continue;
      }
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return { hasChain: false, tokens };
}

function hasAutopilotExclude(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/(?:exclude|ignore)/i.test(t) && t.includes(".autopilot")) {
      return true;
    }
    if (/^--?(?:exclude|ignore)(?:-[a-z0-9_-]+)?$/i.test(t) && i + 1 < tokens.length && tokens[i + 1].includes(".autopilot")) {
      return true;
    }
  }
  return false;
}

function unquote(word) {
  return (word || "").replace(/^['"]|['"]$/g, "");
}

function cmdName(word) {
  if (!word) return "";
  const raw = unquote(word);
  const base = path.posix.basename(raw.replace(/\\/g, "/"));
  return base.replace(/\.(?:cmd|exe)$/i, "");
}

export function withAutopilotExclude(command) {
  if (typeof command !== "string" || !command.trim()) return command;

  const { hasChain, tokens } = parseShellTokens(command);
  if (hasChain || !tokens.length) return command;
  if (hasAutopilotExclude(tokens)) return command;

  let idx = 0;
  while (idx < tokens.length && /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(tokens[idx])) {
    idx++;
  }
  if (idx >= tokens.length) return command;

  const w0 = cmdName(tokens[idx]);
  const w1 = cmdName(tokens[idx + 1]);
  const w2 = cmdName(tokens[idx + 2]);

  // Vitest directly:
  // vitest, or npx vitest, pnpm vitest, pnpm exec vitest, yarn vitest, bunx vitest
  const isVitest =
    w0 === "vitest" ||
    (w0 === "npx" && w1 === "vitest") ||
    (w0 === "pnpm" && w1 === "vitest") ||
    (w0 === "pnpm" && unquote(tokens[idx + 1]) === "exec" && w2 === "vitest") ||
    (w0 === "yarn" && w1 === "vitest") ||
    (w0 === "bunx" && w1 === "vitest");

  if (isVitest) {
    return `${command.trimEnd()} --exclude "**/.autopilot/**"`;
  }

  // Pytest directly:
  // pytest, python -m pytest, python3 -m pytest, uv run pytest, poetry run pytest
  const isPython = /^python3?(?:\.\d+)?$/i.test(w0);
  const isPytest =
    w0 === "pytest" ||
    (isPython && unquote(tokens[idx + 1]) === "-m" && w2 === "pytest") ||
    (w0 === "uv" && unquote(tokens[idx + 1]) === "run" && w2 === "pytest") ||
    (w0 === "poetry" && unquote(tokens[idx + 1]) === "run" && w2 === "pytest");

  if (isPytest) {
    return `${command.trimEnd()} --ignore=.autopilot`;
  }

  return command;
}
