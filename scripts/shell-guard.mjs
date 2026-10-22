// Shell-Security-Policy for arbitrary commands originating from LLM-authored
// content (GSD PLAN <verify> tags, task.verify) and human-configured
// c.gates.commands.
//
// SCOPE AND HONEST LIMITS (read before trusting this module):
// This is a pattern-based denylist plus network isolation. LLM-authored
// verification commands are additionally required to run inside the real
// filesystem sandbox assembled by sandboxCommandPrefix() in autopilot.mjs.
// Human-configured gates.commands remain defense-in-depth only. The denylist specifically
// is bypassable by construction: obfuscated invocations, uncommon
// binaries, base64/hex-encoded payloads decoded at runtime, or
// living-off-the-land binaries we haven't enumerated will all slip
// through. Anyone relying on this for untrusted/adversarial input (vs.
// "LLM might do something dumb, not malicious") needs real sandboxing
// (container with no network, gVisor, firejail/bubblewrap, a VM) — not
// this file. This module exists to catch the common, high-blast-radius
// cases (rm -rf /, curl|sh, format C:, destructive registry edits) cheaply,
// to fail closed rather than silently degrade when isolation is
// unavailable, and to make every command's execution auditable via a log —
// matching the same "defense in depth, not a full boundary" posture that
// relay-guards.mjs documents for git.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function stripPosixBackslashEscapes(command) {
  const text = String(command || "");
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'" && i + 1 < text.length) {
      out += text[++i];
      continue;
    }
    if ((ch === "\"" || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? null : ch;
    }
    out += ch;
  }
  return out;
}

// Structurally valid Windows LOCAL drive-rooted path tokens ONLY
// (C:\segment\segment...). Segment characters are an intentionally tight
// allowlist (letters, digits, `_`, `.`, `-`) — no shell metacharacters, no
// bare drive-relative forms like `C:temp\x` (colon must be followed
// immediately by the separator), no fake multi-letter/digit drive prefixes.
// This is deliberately stricter than what Windows itself accepts in a real
// path, so a lookalike token that smuggles in `$()`, backticks, pipes, etc.
// still fails to match and falls through to the suspicious-escape check
// below.
//
// Deliberately NOT recognized as safe here: UNC paths (\\server\share\...),
// device namespaces (\\.\PhysicalDrive0, \\.\pipe\name), and the extended-
// length prefix (\\?\...). All of these begin with `\\`, which this
// namespace exists precisely to keep in the "suspicious" bucket. Windows
// Compatibility mode has no network isolation (see sandboxCommandPrefix()
// and networkIsolationPrefix() above, both Linux-only), so a remote share or
// a raw device/pipe handle must fail closed the same as any other untrusted
// backslash sequence — accepting them would open a local-exfiltration and
// device-access path with no isolation backstop. Do not add a
// WINDOWS_UNC_PATH_TOKEN (or similar) without also solving that isolation
// gap; see TASK 16.3C1 CORRECTION for the incident this comment documents.
const WINDOWS_DRIVE_PATH_TOKEN = /^[A-Za-z]:(?:\\[A-Za-z0-9_.-]+)+\\?$/;

function isWindowsPathToken(token) {
  return WINDOWS_DRIVE_PATH_TOKEN.test(token);
}

// Is the backslash at text[i] part of a whitespace-delimited, unquoted token
// that is (as a WHOLE) a structurally valid Windows path? Token boundaries
// stop at whitespace or quote characters, matching how an unquoted shell
// argument is actually delimited — this is what prevents a valid path
// elsewhere in the command from laundering an unrelated suspicious escape
// (the two can never share a token boundary).
//
// TASK 16.3C1 CORRECTION 4/6: a local path's real start boundary is not
// always whitespace or a quote — `--output=C:\temp\out.txt` and
// `/OUT:C:\temp\out.txt` are each one whitespace-delimited token, but the
// path itself only actually starts after the `=`/`:`. This reuses the exact
// same option/assignment-boundary detection findNamespaceAnchorPositions()
// already needs for the namespace check below (a plain backward scan
// stopping at any `:` would wrongly cut the drive letter itself off of
// "C:\temp\..." — it has to know a drive-colon isn't an option separator,
// which is precisely what that function's grammar already determines), so
// the start boundary here is "the closest anchor at or before i" rather
// than a fresh, potentially-inconsistent heuristic. The character allowlist
// inside WINDOWS_DRIVE_PATH_TOKEN's segments (no `$`, `(`, backticks, etc.)
// is what still blocks a metacharacter smuggled in after `=`/`:` (e.g.
// `FOO=C:\temp\$(whoami)` still fails to match and falls through to the
// suspicious-escape check), so reusing a looser boundary is not a new
// bypass — it is the same structural check, just anchored correctly.
function isWithinWindowsPathToken(text, i) {
  const anchorsAtOrBefore = findNamespaceAnchorPositions(text).filter(pos => pos <= i);
  const start = anchorsAtOrBefore.length ? Math.max(...anchorsAtOrBefore) : i;
  let end = i;
  while (end < text.length && !/[\s"']/.test(text[end])) end++;
  return isWindowsPathToken(text.slice(start, end));
}

function hasSuspiciousShellEscapes(command) {
  const text = String(command || "");
  let quote = null;
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i];
    if ((ch === "\"" || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? null : ch;
      continue;
    }
    if (!quote && ch === "\\" && /[A-Za-z0-9_$\\|&;<>`(){}[\]]/.test(text[i + 1])) {
      if (isWithinWindowsPathToken(text, i)) continue;
      return true;
    }
  }
  return false;
}

// TASK 16.3C1 CORRECTION 2: UNC paths (\\server\share\...), device
// namespaces (\\.\PhysicalDrive0, \\.\pipe\name), and the extended-length
// prefix (\\?\...) must be rejected REGARDLESS of quoting. Quoting a path is
// exactly what makes hasSuspiciousShellEscapes() skip its backslashes (by
// design — a quoted local path's `\t`/`\f`-lookalike sequences must not be
// flagged), so a quoted remote/device path sailed straight through: quoting
// never changes what the target actually is. This is a separate,
// quote-AWARE scan, not a relaxation of that check: it recovers the
// shell's own whitespace/quote-delimited token boundaries (stripping quote
// characters, but doing no escape processing — we want the literal path
// text as typed) and rejects any token whose path, once `\` and `/` are
// treated interchangeably, begins with two consecutive separators. That one
// shape is exactly what all of the following have in common, quoted or not:
// UNC (\\server\share), device namespaces (\\.\...), the extended-length
// prefix (\\?\...), forward-slash spellings (//server/share, //./pipe/x),
// and any mixed-slash variant of the above. Fail closed on all of them —
// Windows Compatibility mode has no network isolation to fall back on.
const FORBIDDEN_WINDOWS_NAMESPACE_PREFIX = /^[\\/]{2}/;

// TASK 16.3C1 CORRECTION 4: earlier versions of this scan checked either a
// whole whitespace-delimited (quote-stripped) token, or a completed quoted
// segment's own content, for the forbidden prefix. Both miss the same root
// case: a namespace VALUE that starts partway through a token, immediately
// after a redirection operator (`>`, `>>`, `2>`, `<`, ...) or an option
// assignment (`--output=`) glued on with no whitespace — real, valid shell
// syntax, not an edge case. `>//attacker/share/out.txt` and
// `--output=//attacker/share/out.txt` are fully UNQUOTED, so there is no
// quoted segment to extract; and the merged token starts with `>` or
// `--output=`, not `//`, so the old whole-token check missed it too. The
// same two functions also failed an UNTERMINATED quoted value (no closing
// quote to complete a segment) and a value assembled through EMPTY quoted
// pieces (`""//attacker/...`), because both required a segment to fully
// close before it was ever inspected.
//
// The fix does not need a general shell parser: it needs to find every
// position where a VALUE could begin (findNamespaceAnchorPositions), then
// independently re-derive that value's own literal content from exactly
// that position (effectiveValueAt) — dequoting transparently, including an
// unterminated quote (which just runs to end-of-string, satisfying "fail
// closed on ambiguous namespace forms"), and stopping only at real,
// unquoted whitespace. Because each anchor is checked in total isolation,
// an inner `=` or `//` that occurs INSIDE a quoted value (e.g. the query
// string in `--url="https://example.com/?next=//cdn.example/path"`) is
// never itself treated as an anchor — the main scan below only ever
// recognizes an anchor while OUTSIDE quotes, so a value's own interior is
// opaque to it. This is what keeps normal URLs (`//` inside `https://...`)
// from ever being mistaken for a Windows namespace prefix.
// TASK 16.3C1 CORRECTION 6: an `=` or `:` only starts a NEW value when it is
// the FIRST such separator in a given whitespace-delimited token, AND the
// text between the token's start and that separator matches one of the
// bounded key/option grammars this task explicitly supports:
//   - env/key assignment (`=` only):      ^[A-Za-z_][A-Za-z0-9_.-]*$
//   - dash option (`=` or `:`):           ^-{1,2}[A-Za-z0-9_.-]*$
//   - Windows option (`=` or `:`):        ^\/[A-Za-z0-9_.-]*$
// Correction 5 used a broad "still looks key-shaped" flag that only
// tolerated `[A-Za-z0-9_.-]` from the very first character, so any prefix
// starting with `/` (a common Windows option marker, e.g. `/OUT=...`) was
// disqualified immediately and its value was never anchored at all. This
// replaces that flag with an explicit decision, made once at the first
// candidate separator, against the exact grammar above. It also adds `:`
// as a second value-separator character (Windows `/OPTION:value` and
// `--option:value` forms) -- but ONLY for the dash/Windows-option prefixes,
// never for a bare identifier, which is what keeps a drive letter's own
// colon (`C:\...`, `C:/...`) and a URL scheme's colon (`https://...`) from
// ever being treated as an option separator: "C" and "https" don't start
// with `-` or `/`, so neither prefix pattern matches, and the colon is
// skipped entirely -- no substring search for a scheme, no drive-letter
// special case, just the same bounded grammar check used everywhere else.
// Once the first valid separator is found, sawSeparator suppresses every
// later `=` or `:` in that same token (a value's own interior, e.g. a query
// string's `?next=...` or its own `https://` colon, is never re-examined).
// Redirection anchors are unaffected -- `>`/`<` still anchor on EVERY
// occurrence, which is what correctly finds the true value start after a
// repeated operator like `>>`.
const ENV_KEY_PREFIX = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const DASH_OPTION_PREFIX = /^-{1,2}[A-Za-z0-9_.-]*$/;
const WINDOWS_OPTION_PREFIX = /^\/[A-Za-z0-9_.-]*$/;

function findNamespaceAnchorPositions(text) {
  const positions = [];
  let quote = null;
  let atTokenStart = true;
  let tokenStart = 0;
  let sawSeparator = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      if (atTokenStart) { positions.push(i); tokenStart = i; atTokenStart = false; sawSeparator = false; }
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      atTokenStart = true;
      sawSeparator = false;
      continue;
    }
    if (atTokenStart) {
      positions.push(i);
      tokenStart = i;
      atTokenStart = false;
      sawSeparator = false;
    }
    if (ch === ">" || ch === "<") {
      positions.push(i + 1);
      continue;
    }
    if (!sawSeparator && (ch === "=" || ch === ":")) {
      const prefix = text.slice(tokenStart, i);
      const isValidSeparator = ch === "="
        ? ENV_KEY_PREFIX.test(prefix) || DASH_OPTION_PREFIX.test(prefix) || WINDOWS_OPTION_PREFIX.test(prefix)
        : DASH_OPTION_PREFIX.test(prefix) || WINDOWS_OPTION_PREFIX.test(prefix);
      if (isValidSeparator) {
        positions.push(i + 1);
        sawSeparator = true;
      }
    }
  }
  return positions;
}

// Re-derives the literal value starting at `start`, transparently skipping
// quote characters (open, close, or an empty "" pair) without treating them
// as content, and folding an unterminated quote into "runs to end of
// string" rather than an error -- both by construction, not special-cased.
// Stops only at real, unquoted whitespace (the actual end of this value).
function effectiveValueAt(text, start) {
  let out = "";
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      out += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) break;
    out += ch;
  }
  return out;
}

function hasForbiddenWindowsNamespacePath(command) {
  const text = String(command || "");
  return findNamespaceAnchorPositions(text).some(pos => FORBIDDEN_WINDOWS_NAMESPACE_PREFIX.test(effectiveValueAt(text, pos)));
}

function tokenizeCommand(command) {
  const text = stripPosixBackslashEscapes(command);
  const tokens = [];
  let cur = "";
  let quote = null;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === "\\") { escaped = true; cur += ch; continue; }
    if (quote) {
      if (ch === quote) { quote = null; }
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ""; }
    } else cur += ch;
  }
  if (escaped) cur += "\\";
  if (cur) tokens.push(cur);
  return tokens;
}

function isDangerousDeleteTarget(token) {
  const t = String(token || "");
  return (
    t === "." ||
    t === ".." ||
    t === "./" ||
    t === "../" ||
    /^\//.test(t) ||
    /^~(?:\/|$)/.test(t) ||
    /^\$\{?HOME\}?$/.test(t) ||
    /^\*/.test(t)
  );
}

function checkRmDestruction(command) {
  const tokens = tokenizeCommand(command);
  const rmIndex = tokens.findIndex(t => t === "rm" || /(?:^|\/)rm$/.test(t));
  if (rmIndex < 0) return null;
  let recursive = false;
  let force = false;
  const targets = [];
  for (let i = rmIndex + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") { targets.push(...tokens.slice(i + 1)); break; }
    if (/^--recursive$/.test(t)) { recursive = true; continue; }
    if (/^--force$/.test(t)) { force = true; continue; }
    if (/^-[A-Za-z]+$/.test(t)) {
      if (/r/.test(t)) recursive = true;
      if (/f/.test(t)) force = true;
      continue;
    }
    targets.push(t);
  }
  if (!(recursive && force)) return null;
  if (targets.some(isDangerousDeleteTarget)) {
    return {
      why: "recursive force-delete of root/home/wildcard/current-or-parent path",
      pattern: "tokenized-rm-policy"
    };
  }
  return null;
}

const DENY_PATTERNS = [
  // --- destructive filesystem operations ---
  { re: /\bmkfs(\.\w+)?\b/i, why: "filesystem format utility" },
  { re: /\bdd\s+if=/i, why: "raw disk write (dd if=...)" },
  { re: /\bformat\s+[a-zA-Z]:/i, why: "Windows volume format" },
  { re: /\bdel\s+(\/[a-zA-Z]\s+){2,}/i, why: "Windows recursive/forced delete (del /f /s /q ...)" },
  { re: /\brd\s+\/s\s+\/q\b/i, why: "Windows recursive directory removal" },
  { re: /\bShell\.Application\b.*\bNameSpace\b.*\bMoveHere\b/i, why: "Windows Recycle Bin bypass delete" },
  // --- remote-code-execution / download-and-run ---
  { re: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(sh|bash|zsh|ksh|python\d?|node|powershell(\.exe)?|pwsh)\b/i, why: "download piped directly into an interpreter" },
  { re: /\b(iwr|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*iex\b/i, why: "PowerShell download-cradle (iwr | iex)" },
  { re: /\bInvoke-Expression\b/i, why: "PowerShell dynamic code execution" },
  { re: /\bpowershell(\.exe)?\s+[^\n]*-(e|enc|encodedcommand)\b/i, why: "PowerShell base64-encoded command (common obfuscation)" },
  { re: /\bcertutil\b[^\n]*-decode\b/i, why: "certutil abused as a file decoder (LOLBIN)" },
  { re: /\bbase64\s+(-d|--decode)\b[^\n]*\|\s*(sh|bash)\b/i, why: "base64-decoded payload piped into a shell" },
  // --- privilege / persistence / system state ---
  { re: /\bsudo\b/i, why: "privilege escalation" },
  { re: /\bsu\s+-/i, why: "privilege escalation (su -)" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: "system power-state change" },
  { re: /\bchmod\s+(-R\s+)?777\s+\/(?!\S)/i, why: "world-writable permissions on root" },
  { re: /\biptables\b|\bnetsh\b|\bufw\b/i, why: "firewall/network-stack modification" },
  { re: /\breg(\.exe)?\s+(add|delete)\b/i, why: "Windows registry persistence/tampering" },
  { re: /\bcrontab\s+-/i, why: "cron persistence" },
  { re: /\bnc\b[^\n]*-e\b/i, why: "netcat reverse-shell pattern (-e)" },
  // --- data exfiltration ---
  { re: /\b(curl|wget)\b[^\n]*(?:https?:\/\/|ftp:\/\/)[^\n]*\$\{|\b(curl|wget)\b[^\n]*(?:https?:\/\/|ftp:\/\/)[^\n]*\$[A-Za-z_][A-Za-z0-9_]*/i, why: "network request contains shell-expanded variable data (potential secret exfiltration)" },
  { re: /\b(curl|wget)\b[^\n]*\$\([^\n)]*\)/i, why: "network request contains command-substitution data (potential secret exfiltration)" },
  { re: /\b(curl|wget)\b[^\n]*(?:--post-data|--data(?:-binary|-raw|-urlencode)?|--header|-H)\b[^\n]*\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/i, why: "network request sends shell-expanded environment data (potential secret exfiltration)" },
  { re: /\b(curl|wget)\b[^\n]*(?:--post-data|--data(?:-binary|-raw|-urlencode)?)[^\n]*\$\([^\n)]*\)/i, why: "network request sends command-substitution output (potential secret exfiltration)" },
  { re: /\b(curl|wget)\b[^\n]*(-d\s+@|--data(?:-binary|-raw|-urlencode)?[ =]@|-F\s+\S*=@|--form[ =]\S*=@|(-T|--upload-file|--post-file)[ =]\S)/i, why: "network request uploads local file contents (potential data exfiltration)" },
  { re: /\b(cat|type|more|less)\b[^\n]*(\.ssh\/(id_rsa|id_ed25519|id_ecdsa)\b|\.aws\/credentials\b|\.env\b|\.npmrc\b|\.netrc\b|\.pem\b|\.pgpass\b|service[-_]?account[^\n]*\.json\b)[^\n]*\|\s*(curl|wget|nc|ncat|ssh|scp|rsync)\b/i, why: "piping a likely credential/secret file into a network command (potential data exfiltration)" },
  { re: /\bnc(?:at)?\b[^\n]*<\s*\S/i, why: "netcat sending local file contents to a remote host (potential data exfiltration)" },
  // --- worktree/tree-wide destruction not shaped like rm ---
  { re: /\bgit\s+clean\b(?=[^\n]*(-[a-zA-Z]*f[a-zA-Z]*\b|--force\b))(?=[^\n]*-[a-zA-Z]*x[a-zA-Z]*\b)/i, why: "git clean with force+ignored-files flags can wipe the entire worktree, including uncommitted work" },
  { re: /\bRemove-Item\b(?=[^\n]*-Recurse\b)(?=[^\n]*-Force\b)/i, why: "PowerShell recursive force delete" },
];


// Evaluate a raw shell command string against the denylist. Returns
// {allowed:true} or {allowed:false, why, pattern}. Cheap, synchronous,
// intentionally simple — do not add "smarter" parsing here without also
// widening the security section above; complexity is where bypasses hide.
export function evaluateCommand(command) {
  const text = String(command || "");
  if (hasSuspiciousShellEscapes(text)) {
    return { allowed: false, why: "shell backslash escape is not permitted in untrusted commands", pattern: "shell-backslash-escape" };
  }
  if (hasForbiddenWindowsNamespacePath(text)) {
    return { allowed: false, why: "UNC, device, or extended-length Windows path namespaces (\\\\server\\share, \\\\.\\..., \\\\?\\...) are not permitted in untrusted commands, quoted or not", pattern: "windows-namespace-path" };
  }
  const normalized = stripPosixBackslashEscapes(text);
  if (/(?:\$IFS|\$\{IFS\})/i.test(text)) {
    return { allowed: false, why: "IFS shell expansion is not permitted in untrusted commands", pattern: "shell-ifs-expansion" };
  }
  const rmCheck = checkRmDestruction(normalized);
  if (rmCheck) return { allowed: false, why: rmCheck.why, pattern: rmCheck.pattern };
  for (const { re, why } of DENY_PATTERNS) {
    if (re.test(text) || re.test(normalized)) return { allowed: false, why, pattern: re.source };
  }
  return { allowed: true };
}

export function createShellGuard(runDir) {
  const dir = path.join(runDir, "shell-guard");
  fs.mkdirSync(dir, { recursive: true });
  return { dir, logFile: path.join(dir, "blocked.log") };
}

export function logShellDecision(guard, entry) {
  fs.appendFileSync(guard.logFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
}

// Best-effort network isolation for the command's process tree, Linux-only.
// Uses `unshare --net` (util-linux, present on essentially every mainstream
// distro) to run the command in a new network namespace with no interfaces
// configured except loopback. INSIDE that namespace, outbound connections
// do fail closed (no route to anywhere but loopback) — but this function
// only *offers* that; it does not enforce anything by itself.
// Returns the argv prefix to prepend, or null if isolation could not be
// applied (non-Linux, unshare missing, or unprivileged unshare disabled by
// the kernel).
//
// Unprivileged fallback: on some Linux setups (e.g. WSL2 kernels) creating
// a network namespace alone requires privileges, but creating it together
// with a user namespace (`unshare -Urn`) is permitted. In that case we
// return `["unshare","-Urn","--"]`, which maps the current user to root
// inside the namespace and still gives no route to anything but loopback.
//
// CRITICAL FOR CALLERS: a null return means isolation is NOT available on
// this system. Whether the command still runs (unisolated) or is refused
// is a POLICY decision made by decideExecution() below, not by this
// function. Do not spawnSync the command directly off a null check here —
// route every command through decideExecution first. (v9 shipped exactly
// that mistake: null fell through to an unconditional spawnSync, so
// "network isolation unavailable" silently became "run without isolation"
// — the opposite of fail-closed, despite comments in this codebase
// claiming fail-closed behavior. Fixed in v10: see decideExecution.)
export function networkIsolationPrefix() {
  if (process.platform !== "linux") return null;
  const probe = spawnSync("sh", ["-lc", "command -v unshare"], { encoding: "utf8" });
  if (probe.status !== 0 || !(probe.stdout || "").trim()) return null;
  const test = spawnSync("unshare", ["--net", "--", "true"], { encoding: "utf8" });
  let flags = null;
  if (test.status === 0) flags = ["--net"];
  // Privileged net-namespace creation blocked (e.g. WSL2 unprivileged user).
  // Fall back to a combined user + network namespace, which is permitted.
  if (!flags) {
    const fallback = spawnSync("unshare", ["-Urn", "--", "true"], { encoding: "utf8" });
    if (fallback.status !== 0) return null;
    flags = ["-Urn"];
  }
  // Inside the isolated namespace every interface is DOWN, including
  // loopback — so local fixtures (127.0.0.1 DNS relays, loopback test
  // servers) fail even though the namespace is otherwise correct. Bring
  // loopback up inside the namespace before the command runs. Probe the
  // capability once (same style as the unshare probe above): when `ip` is
  // missing or the call fails, keep today's prefix and let the command run
  // (the runtime command also tolerates failure with `|| true`). Only
  // loopback is brought up — no other interface, no route out.
  const loUp = spawnSync("unshare", [...flags, "--", "sh", "-c", "command -v ip >/dev/null && ip link set lo up"], { encoding: "utf8" });
  if (loUp.status !== 0) return ["unshare", ...flags, "--"];
  return ["unshare", ...flags, "--", "sh", "-c", "ip link set lo up 2>/dev/null || true; exec \"$@\"", "-"];
}

// Pure policy decision, deliberately separated from spawnSync so it's unit
// testable without touching the filesystem or a real shell (see
// test-shell-guard.mjs). Combines the denylist with the network-isolation
// requirement into one decision:
//
//   denylist match                              -> execute:false, reason:"denylist"
//   isolation required (default) + available     -> execute:true,  isolate:true
//   isolation required (default) + UNAVAILABLE    -> execute:false, reason:"isolation-unavailable"  <-- FAIL CLOSED
//   isolation explicitly disabled (opt-out)       -> execute:true,  isolate:false, regardless of availability
//
// "Required" is the default (networkIsolationEnabled defaults to true).
// This means: on a platform/environment where isolation can never be
// applied (macOS, Windows, Linux without unshare), verify/gates commands
// are refused by default until the user explicitly sets
// gates.network_isolation=false and accepts the tradeoff. That is an
// intentional, documented behavior change from "best-effort, silently
// degrade" — see SKILL.md Safety section.
export function sandboxCommandPrefix(cwd, { required = true } = {}) {
  if (process.platform !== "linux") return required ? null : [];
  const probe = spawnSync("sh", ["-lc", "command -v bwrap"], { encoding: "utf8" });
  if (probe.status !== 0 || !(probe.stdout || "").trim()) return required ? null : [];
  const root = path.resolve(cwd);
  const capabilityProbe = spawnSync("bwrap", [
    "--die-with-parent", "--new-session", "--unshare-all",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    ...(fs.existsSync("/lib") ? ["--ro-bind", "/lib", "/lib"] : []),
    ...(fs.existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
    "--ro-bind", "/etc", "/etc",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", "/home",
    "--tmpfs", "/root",
    "--tmpfs", "/run",
    "--bind", root, "/workspace",
    "--chdir", "/workspace",
    "--", "true"
  ], { cwd: root, encoding: "utf8", stdio: "ignore", shell: false });
  if (capabilityProbe.status !== 0) return required ? null : [];
  return [
    "bwrap", "--die-with-parent", "--new-session", "--unshare-all",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    ...(fs.existsSync("/lib") ? ["--ro-bind", "/lib", "/lib"] : []),
    ...(fs.existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
    "--ro-bind", "/etc", "/etc",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", "/home",
    "--tmpfs", "/root",
    "--tmpfs", "/run",
    "--bind", root, "/workspace",
    "--chdir", "/workspace",
    "--", "sh", "-lc"
  ];
}

export function decideExecution({ command, networkIsolationEnabled = true, isolationAvailable }) {
  const cmdCheck = evaluateCommand(command);
  if (!cmdCheck.allowed) {
    return { execute: false, isolate: false, reason: "denylist", why: cmdCheck.why, pattern: cmdCheck.pattern };
  }
  if (networkIsolationEnabled) {
    if (isolationAvailable) return { execute: true, isolate: true, reason: "isolated" };
    return {
      execute: false,
      isolate: false,
      reason: "isolation-unavailable",
      why: "network isolation is required by default (gates.network_isolation !== false) but is unavailable on this system — refusing to run the command unisolated. Set gates.network_isolation=false to accept running without network isolation, or run this on Linux with `unshare` available."
    };
  }
  return { execute: true, isolate: false, reason: "isolation-disabled-by-config" };
}
