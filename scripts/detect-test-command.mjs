import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

function readJsonSafe(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8').trim();
    if (!content) return null;
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function readTextSafe(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
}

function hasTestScriptInPackageJson(repo) {
  const pkgPath = join(repo, 'package.json');
  if (!existsSync(pkgPath)) return false;
  const pkg = readJsonSafe(pkgPath);
  return pkg?.scripts?.test !== undefined;
}

function hasPytestConfig(repo) {
  const pytestIni = join(repo, 'pytest.ini');
  const pyprojectToml = join(repo, 'pyproject.toml');
  
  if (existsSync(pytestIni)) return true;
  
  if (existsSync(pyprojectToml)) {
    const content = readTextSafe(pyprojectToml);
    if (content && content.includes('[tool.pytest')) return true;
  }
  return false;
}

function hasGoMod(repo) {
  return existsSync(join(repo, 'go.mod'));
}

function hasCargoToml(repo) {
  return existsSync(join(repo, 'Cargo.toml'));
}

function hasMakefileTestTarget(repo) {
  const makefilePath = join(repo, 'Makefile');
  if (!existsSync(makefilePath)) return false;
  const content = readTextSafe(makefilePath);
  if (!content) return false;
  return /^test\s*:/m.test(content);
}

export function detectTestCommand(repo) {
  if (hasTestScriptInPackageJson(repo)) return 'npm test';
  if (hasPytestConfig(repo)) return 'pytest';
  if (hasGoMod(repo)) return 'go test ./...';
  if (hasCargoToml(repo)) return 'cargo test';
  if (hasMakefileTestTarget(repo)) return 'make test';
  return null;
}

// Backlog s15 #5(a): detect package manager (npm / yarn / pnpm) for formatting
// script commands consistently with the project's tooling.
export function detectPackageManager(repo, rootPkg = null) {
  const pkg = rootPkg ?? readJsonSafe(join(repo, 'package.json'));
  const pmField = typeof pkg?.packageManager === 'string' ? pkg.packageManager.trim().toLowerCase() : '';
  if (pmField.startsWith('pnpm@') || pmField === 'pnpm') return 'pnpm';
  if (pmField.startsWith('yarn@') || pmField === 'yarn') return 'yarn';
  if (pmField.startsWith('npm@') || pmField === 'npm') return 'npm';
  if (existsSync(join(repo, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repo, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function formatRootScriptCommand(pm, scriptName) {
  if (pm === 'pnpm') return `pnpm run ${scriptName}`;
  if (pm === 'yarn') return `yarn run ${scriptName}`;
  return `npm run ${scriptName}`;
}

function formatWorkspaceScriptCommand(pm, wsPkgName, wsRelPath, scriptName) {
  const target = wsPkgName || wsRelPath;
  if (pm === 'pnpm') {
    return wsPkgName ? `pnpm --filter ${wsPkgName} run ${scriptName}` : `pnpm -C ${wsRelPath} run ${scriptName}`;
  }
  if (pm === 'yarn') {
    return wsPkgName ? `yarn workspace ${wsPkgName} run ${scriptName}` : `yarn --cwd ${wsRelPath} run ${scriptName}`;
  }
  return `npm --workspace ${target} run ${scriptName}`;
}

function expandWorkspaceDirs(repo, workspacesField) {
  const patterns = Array.isArray(workspacesField)
    ? workspacesField
    : (Array.isArray(workspacesField?.packages) ? workspacesField.packages : []);
  if (!patterns.length) return [];
  const dirs = [];
  const seen = new Set();
  const addDir = (rel) => {
    const norm = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!norm || seen.has(norm)) return;
    const abs = join(repo, norm);
    try {
      if (statSync(abs).isDirectory() && existsSync(join(abs, 'package.json'))) {
        seen.add(norm);
        dirs.push(norm);
      }
    } catch { /* skip unreadable */ }
  };

  for (const rawPattern of patterns) {
    const pat = String(rawPattern || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!pat || pat.startsWith('!')) continue;
    if (!pat.includes('*')) {
      addDir(pat);
      continue;
    }
    // Support standard single-level workspace globs like "apps/*" or "packages/*"
    const starIdx = pat.indexOf('*');
    const prefix = pat.slice(0, starIdx).replace(/\/+$/, '');
    const suffix = pat.slice(starIdx + 1).replace(/^\/+/, '');
    const baseDir = prefix ? join(repo, prefix) : repo;
    try {
      const entries = readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const rel = [prefix, entry.name, suffix].filter(Boolean).join('/');
        addDir(rel);
      }
    } catch { /* skip missing dir */ }
  }
  return dirs.sort();
}

function hasNonEmptyScript(scripts, name) {
  return typeof scripts?.[name] === 'string' && scripts[name].trim().length > 0;
}

const TYPECHECK_SCRIPT_NAMES = ['type-check', 'typecheck', 'tsc'];
const LINT_SCRIPT_NAMES = ['lint'];

// Backlog s15 #5(a): detect project type-check and lint scripts from root
// package.json (preferred) and, when absent at root, from declared npm/yarn/pnpm
// workspaces. Returns extra proposed gate commands (e.g. ["npm run type-check",
// "npm run lint"]).
export function detectExtraGateCommands(repo) {
  const pkgPath = join(repo, 'package.json');
  if (!existsSync(pkgPath)) return [];
  const rootPkg = readJsonSafe(pkgPath);
  if (!rootPkg || typeof rootPkg !== 'object') return [];

  const pm = detectPackageManager(repo, rootPkg);
  const rootScripts = rootPkg.scripts && typeof rootPkg.scripts === 'object' ? rootPkg.scripts : {};
  const extra = [];
  const seen = new Set();
  const pushUnique = (cmd) => {
    if (cmd && !seen.has(cmd)) {
      seen.add(cmd);
      extra.push(cmd);
    }
  };

  let workspacesCache = null;
  const getWorkspaces = () => {
    if (workspacesCache !== null) return workspacesCache;
    workspacesCache = expandWorkspaceDirs(repo, rootPkg.workspaces).map((relPath) => {
      const wsPkg = readJsonSafe(join(repo, relPath, 'package.json'));
      return {
        relPath,
        name: typeof wsPkg?.name === 'string' ? wsPkg.name.trim() : '',
        scripts: wsPkg?.scripts && typeof wsPkg.scripts === 'object' ? wsPkg.scripts : {},
      };
    });
    return workspacesCache;
  };

  const detectCategory = (scriptNames) => {
    const rootMatch = scriptNames.find((name) => hasNonEmptyScript(rootScripts, name));
    if (rootMatch) {
      pushUnique(formatRootScriptCommand(pm, rootMatch));
      return;
    }
    for (const ws of getWorkspaces()) {
      const wsMatch = scriptNames.find((name) => hasNonEmptyScript(ws.scripts, name));
      if (wsMatch) {
        pushUnique(formatWorkspaceScriptCommand(pm, ws.name, ws.relPath, wsMatch));
      }
    }
  };

  detectCategory(TYPECHECK_SCRIPT_NAMES);
  detectCategory(LINT_SCRIPT_NAMES);
  return extra;
}

export function formatExtraGateCommandsPrompt(commands) {
  const list = Array.isArray(commands) ? commands.filter(Boolean) : [];
  if (!list.length) return '';
  return `\nAlso run before every phase passes: ${list.join(', ')}\nEnter = yes · n = tests only\n> `;
}

export function mergeExtraGateCommands({ baseCommands = [], extraCommands = [], answer = null } = {}) {
  const base = Array.isArray(baseCommands) ? baseCommands.slice() : [];
  const extras = Array.isArray(extraCommands) ? extraCommands.filter(Boolean) : [];
  if (!extras.length || answer === null || answer === undefined) return base;
  const missing = extras.filter((cmd) => !base.includes(cmd));
  if (!missing.length) return base;
  if (answer === false) return base;
  const typed = String(answer).trim().toLowerCase();
  if (typed === 'n' || typed === 'no' || typed === '-') return base;
  return [...base, ...missing];
}

// The decision setup makes for gates.commands (backlog #37), kept pure so it
// can be unit-tested without spawning the wizard.
//
//   existing non-empty  kept verbatim, never re-asked (warn=false, hint=false)
//   not interactive     never asks: keep existing (or []) and return the hint
//                       that tells the operator where to set it by hand
//   interactive         the operator's answer decides:
//                         ""        -> accept `detected` (or [] when nothing
//                                      was detected)
//                         "-"       -> keep []
//                         anything  -> stored verbatim as ONE full shell
//                                      command (never split into words)
//   answer not given    -> [] : gates.commands is human-configured, so an
//                       empty existing value with no confirmation resolves to
//                       no command rather than to the detected one.
//
// warn: gates.commands just became non-empty (printed once by the caller).
// hint: non-interactive run — the caller prints the hand-edit instructions.
export function resolveGatesCommands({ existing, detected, answer, interactive } = {}) {
  const previous = Array.isArray(existing) ? existing : [];

  if (previous.length > 0) {
    // Non-interactive: never asks; keep the saved value and tell the operator
    // where to change it by hand.
    if (interactive !== true) {
      return { commands: previous, warn: false, hint: true };
    }
    // Interactive: in `ap config` the saved value can be kept, replaced, or
    // cleared. answer === null means the question was not actually asked (e.g.
    // first-run wizard with no saved value), so keep the saved value.
    if (answer === null || answer === undefined) {
      return { commands: previous, warn: false, hint: false };
    }
    const typed = String(answer).trim();
    if (typed === '-') {
      return { commands: [], warn: false, hint: false };
    }
    if (!typed) {
      return { commands: previous, warn: false, hint: false };
    }
    return { commands: [typed], warn: false, hint: false };
  }

  if (interactive !== true) {
    return { commands: [], warn: false, hint: true };
  }

  if (answer === null || answer === undefined) {
    return { commands: [], warn: false, hint: false };
  }

  const typed = String(answer).trim();
  const detectedCommand = detected ? String(detected).trim() : '';

  if (typed === '-' || (!typed && !detectedCommand)) {
    return { commands: [], warn: false, hint: false };
  }

  if (!typed) {
    return { commands: [detectedCommand], warn: true, hint: false };
  }

  return { commands: [typed], warn: true, hint: false };
}