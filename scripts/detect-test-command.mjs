import { readFileSync, existsSync } from 'fs';
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