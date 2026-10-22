// Task 15.4C2 correction: this module no longer inspects the filesystem for
// Playwright itself, and it never reads transient runtime state from the
// configuration object. Discovery is performed once, upstream, in
// scripts/autopilot.mjs's runRelay() — against the OFFICIAL repository
// (never the WSL sandbox string "/workspace/repository", and never the
// Native Windows disposable reviewer-workspace copy, which intentionally
// excludes gitignored node_modules and would otherwise produce a false
// negative) — via scripts/playwright-runtime.mjs's
// discoverPlaywrightRuntime(). The result is passed directly as the explicit
// fifth argument to verifierTask(); verifierTask() performs no filesystem
// inspection of its own and never consults hidden transient properties on
// the configuration object (no such property exists anywhere in production
// or tests).
//
// Only SOURCE LABELS (e.g. "repository", "skill", "platform-cache",
// "explicit-env", "autopilot-runtime") are ever rendered into the prompt
// text below — never a raw absolute path (module.dir/nodeModulesDir,
// browser.path/root) and never a discovery `.reason` string (which embeds
// absolute host paths for local debugging, but must never reach a
// subprocess prompt). This keeps the official repository's — and every
// discovered module/browser's — absolute path out of the Verifier's prompt
// on every platform, not just Native Windows.
import fs from "node:fs";
import path from "node:path";

function playwrightGuidanceLines(playwrightRuntime) {
  const mod = playwrightRuntime?.module;
  const browser = playwrightRuntime?.browser;
  const moduleOk = mod?.status === "discovered";
  const browserOk = browser?.status === "discovered";

  if (moduleOk && browserOk) {
    return [
      `A host Playwright runtime was discovered for this project (module source: ${mod.source}; browser source: ${browser.source}).`,
      "This discovery alone does not mean a browser launch is already wired up or proven — Playwright may still be exercised only through an exact approved gate command, and browser-based verification may only be claimed once that command actually succeeds."
    ];
  }

  const missing = [];
  if (!moduleOk) missing.push("module");
  if (!browserOk) missing.push("browser");
  const missingLabel = missing.length === 2 ? "module and browser" : missing[0];
  return [
    `Playwright is not available for this project installation (${missingLabel} not discovered).`,
    "Browser-based verification is not available for this run; proceed with non-browser verification through the approved commands above."
  ];
}

export function verifierTask(task, cwd = null, scratchDir = null, config = null, playwrightRuntime = null) {
  const gateCommands = Array.isArray(config?.gates?.commands) ? config.gates.commands.filter(Boolean) : [];
  const lines = [
    "You are the verification/QA role.",
    "Verify independently. Do not modify repository files and never commit or push.",
    "Report through stdout only; the trusted relay writes the central result.json.",
    gateCommands.length
      ? ["Trusted orchestration has approved only these exact verification commands:", ...gateCommands.map(command => `  - ${command}`)].join("\n")
      : "No verifier command is approved. Do not invent or run commands.",
    "If a permission denial prevents the required work, report the process limitation; do not turn it into an implementation verdict.",
    "Use your normal browser/UI tools when required. The application server must already be running — server startup belongs to trusted orchestration.",
    ...playwrightGuidanceLines(playwrightRuntime),
    scratchDir
      ? `The repository bind is read-only. All temporary output — Playwright specs, screenshots, traces, reports, browser profiles, and test artifacts — must be written only inside the sanctioned scratch directory: ${scratchDir}.`
      : "Scratch writing is not available for this review; report through stdout only.",
    "Return exactly one AUTOPILOT_REVIEW JSON sentinel with decision PASS or FAIL and concise findings.",
    "If a git diff shows whole-file churn, re-run it EOL-normalized (git diff --ignore-cr-at-eol or git -c core.autocrlf=input diff) and trust the normalized stat.",
    "",
    "TASK/VERIFICATION TARGET:",
    task
  ];
  return lines.join("\n");
}

// Mission 065 phase 1 task 1.1: red-gate verdict rule for the verifier.
// Pure render — never throws on odd input. Returns the red-gate rule text
// when the gate is red (any result failed), else "". Handles both gate
// shapes exactly like formatGateResult in scripts/standalone-handoff.mjs:
// a results array, or a single {ok, command} object. Empty/missing gates
// and all-PASS gates return "".
export function formatRedGateVerdictRule(gateResult) {
  let results;
  try {
    results = Array.isArray(gateResult?.results) && gateResult.results.length
      ? gateResult.results
      : (gateResult && typeof gateResult.command === "string"
        ? [{command: gateResult.command, ok: !!gateResult.ok}]
        : []);
  } catch {
    return "";
  }
  if (!results.length) return "";
  const failed = results.find((r) => !r?.ok);
  if (!failed) return "";
  return "On gate FAIL, return FAIL at once with the failing files and the first failing check as findings, mapped to tasks where possible; do not investigate the cause; run at most one confirmatory re-run per failing file and never re-run the whole suite.";
}

// Mission 025 phase 4 task 4.2: per-linked-test duration lines for every
// reviewer/verifier brief (standalone + SpecKit). Measured durations come
// from guarded-command durationMs recorded per linked verify command in
// gate history (resolveGateDurations in standalone-handoff.mjs merges the
// live gate result over the persisted s.gateDurations map). A linked test
// with no recorded sample is never silently omitted — it gets the explicit
// unmeasured fallback, which forbids imposing a shorter timeout than the
// role deadline (PLAN.md mitigation for the too-short-`timeout 30`
// failure). Pure render — never throws on odd input. Returns "" when there
// are no linked commands, so callers stay byte-identical in that case.
export const LINKED_TEST_UNMEASURED_FALLBACK = "unmeasured; run serially, do not impose a shorter timeout than the role deadline";

export function formatLinkedTestDurations(linkedCommands, durationsMap) {
  const linked = Array.isArray(linkedCommands)
    ? [...new Set(linkedCommands.filter((c) => typeof c === "string" && c.trim()))]
    : [];
  if (!linked.length) return "";
  const durations = (durationsMap && typeof durationsMap === "object" && !Array.isArray(durationsMap)) ? durationsMap : {};
  const lines = [
    "Linked test durations (measured per-test wall time; never impose a shorter timeout than the role deadline):",
  ];
  for (const command of linked) {
    const raw = durations[command];
    const d = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof d === "number" && Number.isFinite(d) && d >= 0) {
      lines.push(`- ${command} — ${d} ms (measured)`);
    } else {
      lines.push(`- ${command} — ${LINKED_TEST_UNMEASURED_FALLBACK}`);
    }
  }
  return lines.join("\n");
}

// Mission 025 phase 4 task 4.3: named heavy e2e suites that must never run
// in parallel. The list names the suites from the mission-023 backlog
// evidence explicitly (bare script names, no vague adjective) so the brief
// rule is checkable, and lives in this one named constant consumed by both
// loops' reviewer/verifier briefs. Pure data — never throws.
export const HEAVY_E2E_SUITES = [
  "test-review-feedback-persistence",
  "test-speckit-planning-review-resume",
  "test-cap-breach-rollover",
];

// Mission 025 phase 4 task 4.3: the no-parallel instruction for the heavy
// e2e suites above. Pure render with no inputs — always non-empty, so every
// reviewer/verifier brief carries it unconditionally (unlike the duration
// lines, which are empty when there are no linked commands). Names each
// heavy suite, forbids parallel runs, instructs serial runs, and cites the
// mission-023 failure mode (parallel runs under timeout 420 killed with
// exit 124). Kept out of verifierTask() by design: verifierTask() text is
// relayed inside composed verifier prompts, so including it there would
// duplicate it.
export function formatHeavySuiteNoParallelNote() {
  const lines = [
    "Heavy e2e suites — do not run in parallel; run serially, one at a time:",
    ...HEAVY_E2E_SUITES.map((suite) => `- ${suite}`),
    "These suites were killed with exit 124 when run in parallel under timeout 420; run each suite serially with its measured duration budget and never impose a shorter timeout than the role deadline.",
  ];
  return lines.join("\n");
}

// Remap every repository-root-qualified path in a complete Verifier prompt
// from the official repository root to the repository representation the
// Verifier can actually access:
//
//   - WSL/Linux bubblewrap: visible is "/workspace/repository".
//   - Native Windows SpecKit: visible is the disposable reviewRepository path.
//
// Requirements honored here:
//   - The relative file suffix (including tasks.md line references such as
//     ":3") is preserved: only the root portion is replaced.
//   - Matching is path-boundary-aware: a similar prefix such as C:\repo-other
//     is never rewritten when the repository is C:\repo.
//   - Windows matching is case-insensitive and accepts both slash and
//     backslash spellings of the official root.
//   - The canonical/real repository root (fs.realpathSync) is honored where
//     it differs from the supplied path; both spellings are remapped.
//   - Unrelated prose, URLs, and paths outside the repository are untouched.
//   - The caller passes the FINAL prompt; this function returns the remapped
//     prompt. When official and visible are identical (or either is missing)
//     the prompt is returned unchanged.
//   - Correction 3: a traversal path (e.g. "official/../secret") whose
//     normalized target escapes the official repository is never rendered as
//     a visible-repository descendant and never exposes the official host
//     path either — the whole escaping token is replaced with the stable
//     placeholder "<outside-repository-path>" instead (see
//     OUTSIDE_REPOSITORY_PLACEHOLDER below).
//   - Correction 3: file:// URL references to the official repository (both
//     POSIX and Windows drive-letter forms) are remapped to an equivalent
//     file:// URL for the visible repository — never a malformed
//     mixed-slash URL — or to the same placeholder when they traverse
//     outside the repository.
function stripTrailingSep(p) {
  if (typeof p !== "string" || !p) return p;
  if (p.length > 1 && (p.endsWith("/") || p.endsWith("\\") || p.endsWith(path.sep))) {
    return p.replace(/[/\\]+$/, "") || p;
  }
  // Windows drive root like "C:\" must keep its separator.
  if (/^[A-Za-z]:[/\\]+$/.test(p)) return p;
  return p.replace(/[/\\]+$/, "");
}

function collectOfficialVariants(officialRepository) {
  const variants = [];
  const seen = new Set();
  const push = (v) => {
    if (typeof v !== "string" || !v) return;
    const stripped = stripTrailingSep(v);
    if (!stripped) return;
    const key = process.platform === "win32" ? stripped.toLowerCase() : stripped;
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(stripped);
  };
  try { push(path.resolve(officialRepository)); } catch { push(String(officialRepository)); }
  push(String(officialRepository));
  try {
    const real = fs.realpathSync(path.resolve(officialRepository));
    push(real);
  } catch { /* official may not exist in unit tests */ }
  try {
    const realRaw = fs.realpathSync(String(officialRepository));
    push(realRaw);
  } catch { /* ignore */ }
  // Longest first so a canonical root that is longer still wins.
  variants.sort((a, b) => b.length - a.length);
  return variants;
}

// Explicit boundary rules (correction 2): a candidate occurrence of an
// official root is replaced only when BOTH hold:
//
// LEFT: the character before the match proves the root starts a genuine
// path token — start-of-string, or a delimiter. A preceding character in
// [A-Za-z0-9_.\-/\\~$+@] proves the root is embedded inside a longer parent
// path or token (e.g. "/var/tmp/repo" for root "/tmp/repo", or
// "XC:\repo" for root "C:\repo") and blocks the replacement.
//
// RIGHT: the character after the match must not continue a filename. Any
// of [A-Za-z0-9_-] continues unconditionally (covers "-other", "_other",
// "repo2"). "." continues when followed by a filename character (covers
// ".backup" but allows a trailing sentence period). "/" and "\" open a
// genuine child path. ":" opens a valid line reference only when followed
// by digits (covers "tasks.md:12"). End-of-string is a bare-root reference.
// Every other delimiter (space, quotes, parens, brackets, "=", ";", ...)
// is a bare-root reference.
function isLeftBoundaryOk(text, matchIndex) {
  if (matchIndex <= 0) return true;
  const prev = text[matchIndex - 1];
  if (/[A-Za-z0-9_.\-\/\\~$+@]/.test(prev)) return false;
  return true;
}

// Task 15.4C2 correction 3: given a genuine root-match's right boundary
// already confirmed by isRightBoundaryOk (so the occurrence is a real path
// token, not a sibling like "repo-other"), this consumes the ENTIRE
// contiguous path-token suffix that follows — every further path component,
// including a trailing "tasks.md:12" line reference — using the identical
// character class isLeftBoundaryOk already treats as "part of a path token".
// Stopping only at a genuine delimiter (whitespace, quote, paren, ...) keeps
// this in lockstep with the boundary rules above instead of inventing a
// second, potentially inconsistent notion of "where a path ends".
function pathTokenEnd(text, start) {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (/[A-Za-z0-9_.\-\/\\~$+@]/.test(c)) { i += 1; continue; }
    if (c === ":") {
      const digits = /^\d+/.exec(text.slice(i + 1));
      if (digits) { i += 1 + digits[0].length; continue; }
    }
    break;
  }
  return i;
}

// True when the path-token suffix that follows a matched root — collapsed
// left to right, "." a no-op and ".." popping one component — ever needs to
// pop past the root itself (depth goes negative). This is a pure token-level
// walk, not fs normalization: it must work for hypothetical/nonexistent
// paths, and it must not just glance at the character immediately after the
// root (that only proves a genuine child path STARTS here, not that it
// stays inside). A trailing ":digits" line reference is stripped first — it
// is prose, not a path segment.
function suffixEscapesRoot(suffix) {
  if (!suffix) return false;
  const withoutLineRef = suffix.replace(/:\d+$/, "");
  const segments = withoutLineRef.split(/[\\/]+/);
  let depth = 0;
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      depth -= 1;
      if (depth < 0) return true;
    } else {
      depth += 1;
    }
  }
  return false;
}

// A traversal path whose normalized target escapes the official repository
// must never be rendered as a visible-repository descendant (that would
// hand the Verifier a path that walks back OUT of its sandboxed view), and
// it must not expose the official host root either. The complete escaping
// token (root + the whole traversal suffix) is replaced with this stable,
// non-host placeholder instead — the smallest fix consistent with
// remapRepositoryPaths staying a total, non-throwing function (it is called
// inline while building the relay prompt in autopilot.mjs, with no
// try/catch at the call site).
const OUTSIDE_REPOSITORY_PLACEHOLDER = "<outside-repository-path>";

function isRightBoundaryOk(text, endIndex) {
  if (endIndex >= text.length) return true;
  const next = text[endIndex];
  if (/[A-Za-z0-9_\-]/.test(next)) return false;
  if (next === ".") {
    const after = text[endIndex + 1];
    if (after !== undefined && /[A-Za-z0-9_.\-]/.test(after)) return false;
    return true;
  }
  if (next === "/" || next === "\\") return true;
  if (next === ":") {
    const after = text.slice(endIndex + 1);
    if (/^\d+/.test(after)) return true;
    return false;
  }
  return true;
}

// Slash-insensitive, case-ruled comparison of one candidate occurrence:
// returns true when `text` starting at `index` spells `root`, where every
// "/" or "\" in the root accepts either separator, Windows compares
// case-insensitively, and POSIX compares case-sensitively.
function matchesRootAt(text, index, root) {
  if (index + root.length > text.length) return false;
  const win = process.platform === "win32";
  for (let j = 0; j < root.length; j += 1) {
    const rc = root[j];
    const pc = text[index + j];
    if (rc === "/" || rc === "\\") {
      if (pc !== "/" && pc !== "\\") return false;
    } else if (win) {
      if (pc.toLowerCase() !== rc.toLowerCase()) return false;
    } else if (pc !== rc) {
      return false;
    }
  }
  return true;
}

function remapOneVariant(text, root, visible) {
  if (!root || root.length === 0) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (matchesRootAt(text, i, root) && isLeftBoundaryOk(text, i) && isRightBoundaryOk(text, i + root.length)) {
      const matchEnd = i + root.length;
      const tokenEnd = pathTokenEnd(text, matchEnd);
      const suffix = text.slice(matchEnd, tokenEnd);
      if (suffixEscapesRoot(suffix)) {
        out += OUTSIDE_REPOSITORY_PLACEHOLDER;
        i = tokenEnd;
        continue;
      }
      out += visible;
      i = matchEnd;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

// Task 15.4C2 correction 3: file:// URL references to the official
// repository. These are NOT caught by remapOneVariant above — the character
// immediately before a triple-slash URL's path ("file://" + "/") is itself
// "/", which isLeftBoundaryOk (correctly, for plain filesystem text) treats
// as "this root is embedded inside a longer token" and refuses to touch.
// URL syntax needs its own left boundary — "the text right after a literal
// 'file://' scheme" — which is unambiguous by construction (there is no
// "embedded in a longer path" risk once the scheme itself has matched), so
// isLeftBoundaryOk's generic prefix rule does not apply here at all.
function isDriveLetterRoot(root) {
  return /^[A-Za-z]:/.test(root);
}

// The visible repository root's path portion of an equivalent file:// URL,
// always forward-slashed and with an uppercased drive letter where present
// ("D:\disposable\repository" -> "/D:/disposable/repository",
// "/workspace/repository" -> "/workspace/repository") so a remap can never
// produce a malformed mixed-slash Windows file URL.
function visibleFileUrlPath(visible) {
  const drive = /^([A-Za-z]):[\/\\]?(.*)$/.exec(visible);
  if (drive) {
    const rest = drive[2].replace(/\\/g, "/").replace(/^\/+/, "");
    return `/${drive[1].toUpperCase()}:${rest ? `/${rest}` : ""}`;
  }
  return visible.replace(/\\/g, "/");
}

function remapFileUrls(text, variants, visible) {
  if (!variants.length) return text;
  const visibleUrlPath = visibleFileUrlPath(visible);
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.slice(i, i + 7).toLowerCase() === "file://" && text[i + 7] === "/") {
      const pathStart = i + 7;
      let matched = false;
      for (const root of variants) {
        const candidateStart = isDriveLetterRoot(root) ? pathStart + 1 : pathStart;
        if (!matchesRootAt(text, candidateStart, root)) continue;
        const matchEnd = candidateStart + root.length;
        if (!isRightBoundaryOk(text, matchEnd)) continue;
        const tokenEnd = pathTokenEnd(text, matchEnd);
        const suffix = text.slice(matchEnd, tokenEnd);
        out += suffixEscapesRoot(suffix) ? OUTSIDE_REPOSITORY_PLACEHOLDER : `file://${visibleUrlPath}${suffix}`;
        i = tokenEnd;
        matched = true;
        break;
      }
      if (matched) continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

export function remapRepositoryPaths(prompt, officialRepository, visibleRepository) {
  if (typeof prompt !== "string" || !prompt) return prompt;
  if (!officialRepository || !visibleRepository) return prompt;
  const visible = stripTrailingSep(String(visibleRepository));
  if (!visible) return prompt;
  const variants = collectOfficialVariants(String(officialRepository));
  if (!variants.length) return prompt;
  // Skip no-op remaps (official already equals visible, modulo case/slashes).
  const normVisible = process.platform === "win32" ? visible.toLowerCase() : visible;
  const isNoop = variants.some((v) => {
    const normV = process.platform === "win32" ? v.toLowerCase() : v;
    const normVSlash = normV.replace(/\\/g, "/");
    return normV === normVisible || normVSlash === normVisible.replace(/\\/g, "/");
  });
  if (isNoop) return prompt;
  let result = prompt;
  result = remapFileUrls(result, variants, visible);
  for (const root of variants) {
    result = remapOneVariant(result, root, visible);
  }
  return result;
}
