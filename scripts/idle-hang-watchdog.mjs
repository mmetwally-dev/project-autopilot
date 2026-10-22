// Backlog #41 (TASK-35): idle-hang watchdog + fast opencode rate-limit
// detection. Mission 024 runs 98/99 each waited the full 60-minute
// per-task timeout on an opencode session that had stopped answering:
// opencode retries a rate limit internally and prints nothing on stdout,
// so nothing ended the session until the outer deadline.
//
// A session counts as hung ONLY when ALL THREE hold for `idleHangMs`
// without a break (operator decision 2026-10-02):
//   1. no adapter stdout/stderr bytes,
//   2. no live descendant process (a running tool call, test, or suite is
//      work, not a hang — mission 024 run 118 printed nothing for ~33 min
//      while `node scripts/test-all.mjs` ran under it),
//   3. no file write under the repo working tree or the run's scratch dir.
// Any one of the three resets the clock.
//
// This module owns the three signals, the rate-limit log tail, and the
// message wording. The orchestrator (autopilot.mjs runRelay) owns time,
// the kill, and the failure object: it feeds every stdout/stderr chunk to
// noteIdleOutput(), evaluates once per second from the same 1s capTimer
// (same lifecycle: armed in onStart, cleared in finally), and kills + classifies.
//
// Design notes:
// - Steady-state cost is ~zero while a session is active: the expensive
//   checks (repo walk, process scan) run ONLY once output has already been
//   quiet for the full idleHangMs. An active session never pays for them.
// - Child scan direction is fail-SAFE (never fail-DEADLY): an unreadable
//   /proc, a missing pgrep/wmic, or a stale scan reads as "unknown", and
//   unknown never kills — the 60-minute per-task deadline still bounds the
//   session. A broken scanner can delay the watchdog, never kill a working
//   session by mistake.
// - Zombies are not work: a lingering `Z`-state descendant (or a vanished
//   /proc entry, or ESRCH) means the process is already dead; only a
//   genuinely live descendant resets the clock. Same posture as
//   autopilot.mjs's pidAlive().
// - Idle-process footprint (checked live 2026-10-02, WSL Ubuntu):
//   `opencode --help` runs as ONE multi-threaded process (13 threads, every
//   /proc/<pid>/task/*/children empty, pgrep -P empty); `claude --version`
//   is a single process that exits at once, no children. Neither CLI keeps
//   long-lived helper processes at idle — any live descendant mid-session
//   is an in-flight tool call (bash/node/rg/git/…), i.e. work.
// - Launcher-chain exclusion (checked live 2026-10-02, native Windows): an
//   adapter launched from a .cmd shim runs bounced through cmd.exe
//   (agent-process.mjs winShimInvocation), so the adapter pid ALWAYS has
//   descendants that are the adapter itself, not work. Observed tree:
//     cmd.exe /d /s /c ...tramp-probe.cmd tool          <- adapter pid
//     └── node "...tramp-probe-target.js" tool          <- the adapter
//         └── "C:\Program Files\nodejs\node.exe" -e …   <- the TOOL (work)
//   The rule is therefore command-line based, never pid- or timing-based:
//   a descendant whose command line contains the adapter marker (basename
//   of the launch binary, e.g. "cursor-agent" — matching cursor-agent.cmd,
//   cursor-agent.exe, and the shim's node script path alike) is the
//   launcher chain; anything else is a tool/command process, i.e. work.
//   Timing was considered and REJECTED: CIM CreationDate has 1-second
//   resolution and the adapter and its first tool shared the same second,
//   and a startup descendant snapshot races early-spawning tools (a slow
//   first scan swallows them). A wrong chain verdict only ever delays the
//   watchdog (missed hang), never kills a working session — and a marker
//   that matches a genuine tool is absurd (the tool would have to name the
//   adapter binary in its own command line).
// - Self-observation phantoms: the processes that enumerate the table
//   (powershell/cim, taskkill, and their conhost) are parented to the
//   OBSERVER (autopilot), never to the adapter, so they are invisible to
//   the adapter-descendant walk by construction.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

// Same grace as the relay deadline and cap kills (SIGTERM, SIGKILL after
// 5 s): the wiring kills "the same way the existing cap or deadline kill
// does", so the constant lives next to the rule, not at the call site.
export const IDLE_HANG_KILL_GRACE_MS = 5000;
// Rate-limit confirmation (operator decision): 1 match plus 60 s of
// silence, so a transient retry that recovers never kills a healthy run.
// Stop within ~1-2 min of the first match.
export const RATE_LIMIT_CONFIRM_MATCHES = 1;
export const RATE_LIMIT_CONFIRM_GAP_MS = 60_000;
// Bounded log reads: only appended bytes are ever scanned, capped.
export const RATE_LIMIT_LOG_TAIL_BYTES = 256 * 1024;

// opencode's OWN log (logfmt), not model prose: `AI_APICallError` and
// `AI_RetryError` are engine-level error values. Observed live in
// ~/.local/share/opencode/log/opencode.log (mission 024):
//   ... message="stream error" providerID=opencode modelID=<model>
//   ... error.error="AI_APICallError: ... [rate_limit_exceeded] Rate limit
//   exceeded. Please retry after a brief wait."
// Bare AI_RetryError ALSO fires for non-rate-limit errors ("Cannot connect
// to API"), so the rate-limit marker is required in both branches.
const RATE_LIMIT_MARKER = /rate[_\s]limit[_\s]exceeded|endpoint is unavailable|insufficient account funds|status_?code[=:"\s]+429\b/i;
const RATE_LIMIT_SOURCE = /AI_APICallError|AI_RetryError/;
const PROVIDER_ID_RE = /providerID=([^\s]+)/;
const MODEL_ID_RE = /modelID=([^\s]+)/;
const LOG_TIMESTAMP_RE = /timestamp=([0-9T:.\-+Z]+)/;
// opencode stamps its session id on its own stdout JSON events
// ({"type":"step_start","sessionID":"ses_…"}) and on its logfmt log lines
// (session.id=ses_…). The two spellings never collide: the stdout shape is
// quoted JSON, the log shape is a bare logfmt key.
const STDOUT_SESSION_ID_RE = /"sessionID"\s*:\s*"([^"]+)"/;
const LOG_SESSION_ID_RE = /session\.id=([^\s]+)/;

// This role's own session id from a live stdout chunk. Null when the chunk
// carries no session event yet.
export function extractSessionIdFromChunk(chunk) {
  const match = String(chunk ?? "").match(STDOUT_SESSION_ID_RE);
  return match ? match[1] : null;
}

// The session a log line belongs to. Null when the line is unattributed.
export function extractLogSessionId(line) {
  const match = String(line ?? "").match(LOG_SESSION_ID_RE);
  return match ? match[1] : null;
}

// opencode logfmt timestamps are UTC ISO ("timestamp=2026-09-07T06:16:03Z"
// style). A matched line carrying a timestamp OLDER than the session start
// is history, not this session: it can only surface when the log rotated
// (offset baseline lost) or the HOME log is shared with other sessions.
// Lines without a parseable timestamp are accepted — staleness unprovable
// must never suppress a genuine hit.
function lineNewerThanSessionStart(line, startedAtMs) {
  const match = String(line ?? "").match(LOG_TIMESTAMP_RE);
  if (!match) return true;
  const ts = Date.parse(match[1]);
  if (!Number.isFinite(ts)) return true;
  return ts >= startedAtMs;
}

// A log line is a rate-limit hit when an engine error value carries the
// rate-limit marker. Returns {provider, model} (best-effort extraction,
// nulls when the logfmt fields are absent) or null.
export function rateLimitLineInfo(line) {
  const text = String(line ?? "");
  // Backlog #107: the small title-generation model's stream errors (small=true
  // agent=title) say nothing about the role's own model.
  if (/\bsmall=true\b|\bagent=title\b/.test(text)) return null;
  if (!RATE_LIMIT_SOURCE.test(text) || !RATE_LIMIT_MARKER.test(text)) return null;
  const provider = text.match(PROVIDER_ID_RE)?.[1] ?? null;
  const model = text.match(MODEL_ID_RE)?.[1] ?? null;
  return {provider, model};
}

// Newest *.log under <baseDir>/log/ (opencode rotates there). Null when the
// dir is absent/unreadable — detection is best-effort and degrades to the
// stderr fast path + the idle watchdog.
export function findOpencodeLogFile(baseDir, {readdirSync = fs.readdirSync, statSync = fs.statSync} = {}) {
  if (!baseDir) return null;
  let entries;
  try {
    entries = readdirSync(path.join(baseDir, "log"), {withFileTypes: true});
  } catch {
    return null;
  }
  let newest = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const full = path.join(baseDir, "log", entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = {file: full, mtimeMs};
  }
  return newest?.file ?? null;
}

// Re-resolve/switch helper for the opencode log tail: the newest *.log by
// mtime can flip between ticks (rotation, a second session writing), so the
// caller re-resolves on every tick and switches through here before reading.
// Takes the currently-tailed path + offset, a per-path offset map (mutated
// in place so flip-flopping back never re-reads tailed lines), and either
// an already-resolved newest path or a baseDir to resolve via
// findOpencodeLogFile (injectable readdirSync/statSync for tests). No
// filesystem existence check here: a null lookup keeps the current file and
// offset, and the caller only switches while the current file still exists.
export function resolveOpencodeLogSwitch(currentFile, currentOffset, offsetsByFile, newestFile = null, {baseDir = null, readdirSync, statSync} = {}) {
  const offsets = offsetsByFile instanceof Map ? offsetsByFile : new Map();
  let newest = newestFile;
  if ((newest === undefined || newest === null) && baseDir) {
    const deps = {};
    if (readdirSync) deps.readdirSync = readdirSync;
    if (statSync) deps.statSync = statSync;
    try {
      newest = findOpencodeLogFile(baseDir, deps);
    } catch {
      newest = null;
    }
  }
  if (newest == null) return {file: currentFile, offset: currentOffset, offsetsByFile: offsets};
  if (newest === currentFile) return {file: currentFile, offset: currentOffset, offsetsByFile: offsets};
  if (currentFile != null) offsets.set(currentFile, currentOffset);
  const offset = offsets.has(newest) ? offsets.get(newest) : 0;
  return {file: newest, offset, offsetsByFile: offsets};
}

// Read bytes appended to the log since `fromOffset`, capped. Handles
// rotation/truncation (size < offset rescans the whole file, capped) and
// returns the offset for the next call. Never throws.
export function readLogAppend(logFile, fromOffset = 0, {statSync = fs.statSync, openSync = fs.openSync, readSync = fs.readSync, closeSync = fs.closeSync} = {}) {
  if (!logFile) return {text: "", nextOffset: fromOffset};
  try {
    const size = statSync(logFile).size;
    const start = size < fromOffset ? 0 : fromOffset;
    const end = Math.min(size, start + RATE_LIMIT_LOG_TAIL_BYTES);
    if (end <= start) return {text: "", nextOffset: size};
    const fd = openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      return {text: buf.toString("utf8"), nextOffset: end};
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* descriptor hygiene is best-effort */
      }
    }
  } catch {
    return {text: "", nextOffset: fromOffset};
  }
}

// --- Descendant (live child work) detection --------------------------------
//
// A descendant counts as WORK unless its command line marks it as the
// adapter's own launcher chain (see the docblock). Markers come from
// adapterMarkerFor() in production and are explicit in tests.

// Launchers that merely run a script: the marker must be the SCRIPT, not
// the runtime ("node" would match every node tool call). Compared
// case-insensitively; extensions kept for scripts (the cmdline carries the
// full path) but stripped for binaries (one marker covers .cmd/.exe and
// the extensionless binary alike).
const GENERIC_RUNTIMES = new Set([
  "node", "nodejs", "deno", "bun", "bunx",
  "python", "python3", "perl", "ruby", "php",
  "sh", "bash", "dash", "zsh", "fish",
  "cmd", "powershell", "pwsh",
]);

function pathBasename(p) {
  return String(p ?? "").replace(/\\/g, "/").split("/").pop() || "";
}

export function adapterMarkerFor(binary, args = []) {
  const binBase = pathBasename(binary).replace(/\.(exe|cmd|bat|com|ps1)$/i, "");
  if (!binBase) return null;
  if (!GENERIC_RUNTIMES.has(binBase.toLowerCase())) return binBase.toLowerCase();
  // Runtime launcher (node/cmd/…): the marker is the script it runs, not
  // the runtime. Skip flags (both -x and cmd-style /x spellings) and the
  // inline-code value after -e/--eval/-p/--print; the first remaining token
  // is the script path. Nothing usable (bare `node -e …`) falls back to
  // the runtime name — weak (it matches every same-runtime tool) but
  // fail-safe: over-matching only ever delays the watchdog.
  const inlineCode = new Set(["-e", "--eval", "-p", "--print"]);
  let skipNext = false;
  for (const raw of args || []) {
    const token = String(raw ?? "");
    if (skipNext) { skipNext = false; continue; }
    if (inlineCode.has(token)) { skipNext = true; continue; }
    if (token.startsWith("-") || (/^\/[A-Za-z?]+$/.test(token) && token.length <= 3)) continue;
    if (!token) continue;
    return pathBasename(token).toLowerCase() || binBase.toLowerCase();
  }
  return binBase.toLowerCase();
}

// Backlog #104: a marker matches the adapter's own launcher only: argv[0]
// basename, or (when argv[0] is a runtime/shell such as node/cmd/sh) the first
// non-flag argument's basename. A tool child that merely mentions an adapter
// name elsewhere in its command line (a test script, a path) is real work.
export function isChainCommand(cmdline, markers = []) {
  const tokens = [...String(cmdline ?? "").matchAll(/"+([^"]*)"+|'+([^']*)'+|\S+/g)].map(m => m[1] ?? m[2] ?? m[0]).filter(Boolean);
  if (!tokens.length) return false;
  const norm = t => pathBasename(t).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1|js|mjs|cjs)$/i, "");
  const wantedList = [...markers].filter(Boolean).map(norm);
  if (!wantedList.length) return false;
  // Exact basename, or the marker as a dash/underscore-delimited prefix (a shim's
  // target script such as <launcher>-target.js); never a substring elsewhere.
  const hit = t => wantedList.some(m => t === m || t.startsWith(`${m}-`) || t.startsWith(`${m}_`));
  const first = norm(tokens[0]);
  if (hit(first)) return true;
  if (!GENERIC_RUNTIMES.has(first)) return false;
  for (const token of tokens.slice(1)) {
    if (token.startsWith("-") || (/^\/[A-Za-z?]+$/.test(token) && token.length <= 3)) continue;
    return hit(norm(token));
  }
  return false;
}

function procStatState(pid, {readFileSync = fs.readFileSync} = {}) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null; // no /proc entry: dead (or no /proc at all — caller falls back)
  }
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0] || null;
}

function procTaskChildren(pids, {readdirSync = fs.readdirSync, readFileSync = fs.readFileSync} = {}) {
  const out = [];
  for (const pid of pids) {
    let tasks;
    try {
      tasks = readdirSync(`/proc/${pid}/task`);
    } catch {
      continue;
    }
    for (const task of tasks) {
      let raw = "";
      try {
        raw = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim();
      } catch {
        continue;
      }
      for (const piece of raw.split(/\s+/)) {
        const child = Number(piece);
        if (Number.isInteger(child) && child > 0) out.push(child);
      }
    }
  }
  return out;
}

function pgrepChildren(pid, {spawnSyncFn = spawnSync} = {}) {
  try {
    const result = spawnSyncFn("pgrep", ["-P", String(pid)], {encoding: "utf8", shell: false, timeout: 5000});
    const out = String(result.stdout || "").split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
    return result.error ? null : out;
  } catch {
    return null;
  }
}

// Recursive descendant listing on Linux/WSL: /proc walk first (no spawn,
// microsecond reads), pgrep -P recursion when /proc is unavailable.
// Returns {entries:[{pid, cmdline}]} or {unknown:true} when neither source
// works. Zombies (and vanished entries) are pruned: they are already dead,
// never work. The pgrep fallback carries no cmdlines (entries get ""), so
// every descendant conservatively counts as work there — a delay, never a
// wrong kill.
function linuxDescendants(pid, deps = {}) {
  const seen = new Set([pid]);
  const entries = [];
  let frontier = [pid];
  let procWorked = false;
  while (frontier.length) {
    const children = procTaskChildren(frontier, deps);
    if (children.length || procHasTasks(frontier[0], deps)) procWorked = true;
    const next = [];
    for (const child of children) {
      if (seen.has(child)) continue;
      seen.add(child);
      const state = procStatState(child, deps);
      if (state === null) continue; // entry vanished mid-walk: dead
      procWorked = true;
      if (state === "Z") continue; // zombie: already dead, never work
      entries.push({pid: child, cmdline: procCmdline(child, deps)});
      next.push(child);
    }
    frontier = next;
  }
  if (procWorked) return {entries};
  // No /proc visibility at all: pgrep recursion (child map per level).
  const pgrepSeen = new Set([pid]);
  const pgrepEntries = [];
  let level = [pid];
  while (level.length) {
    const next = [];
    for (const parent of level) {
      const kids = pgrepChildren(parent, deps);
      if (kids === null) return {unknown: true};
      for (const kid of kids) {
        if (pgrepSeen.has(kid)) continue;
        pgrepSeen.add(kid);
        pgrepEntries.push({pid: kid, cmdline: ""});
        next.push(kid);
      }
    }
    level = next;
  }
  return {entries: pgrepEntries};
}

function procCmdline(pid, {readFileSync = fs.readFileSync} = {}) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

function procHasTasks(pid, {readdirSync = fs.readdirSync} = {}) {
  try {
    readdirSync(`/proc/${pid}/task`);
    return true;
  } catch {
    return false;
  }
}

// Windows descendant listing: one snapshot of the process table (pid +
// ppid + command line), then a pure in-memory DFS from the adapter pid.
// wmic first, PowerShell CIM fallback (wmic is GONE on current Win11 —
// verified ENOENT 2026-10-02 — so CIM is the real path, ~2-3 s for ~360
// processes; that cost lands solely on suspiciously-silent ticks, never on
// active sessions, by the caller's gating). Both shippers print CSV; the
// parser is quote-aware because command lines contain commas and doubled
// quotes. Returns {entries:[{pid, cmdline}]} or {unknown:true}.
function windowsDescendants(pid, deps = {}) {
  const table = queryWindowsProcessTable(deps);
  if (!table) return {unknown: true};
  const cmdByPid = new Map();
  const byParent = new Map();
  for (const row of table) {
    cmdByPid.set(row.pid, row.cmdline || "");
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row.pid);
  }
  const seen = new Set([pid]);
  const entries = [];
  const stack = [...(byParent.get(pid) || [])];
  while (stack.length) {
    const child = stack.pop();
    if (seen.has(child)) continue;
    seen.add(child);
    entries.push({pid: child, cmdline: cmdByPid.get(child) || ""}); // Windows has no zombies: listed == alive
    stack.push(...(byParent.get(child) || []));
  }
  return {entries};
}

function queryWindowsProcessTable({spawnSyncFn = spawnSync} = {}) {
  const columns = "ProcessId,ParentProcessId,CommandLine";
  const attempts = [
    {cmd: "wmic", args: ["process", "get", columns, "/FORMAT:CSV"]},
    {cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"]},
  ];
  for (const {cmd, args} of attempts) {
    let out = "";
    try {
      const result = spawnSyncFn(cmd, args, {encoding: "utf8", shell: false, timeout: 15000, stdio: ["ignore", "pipe", "pipe"]});
      if (result.error) continue;
      out = String(result.stdout || "");
    } catch {
      continue;
    }
    const table = parseProcessCsv(out);
    if (table) return table;
  }
  return null;
}

// Quote-aware CSV parse for the process table: command lines contain commas
// AND doubled quotes (observed: node ""C:\…\tramp-probe-target.js"" tool),
// so naive comma-splitting corrupts exactly the column the chain rule
// reads. Columns matched by name, any order/casing (wmic and CIM order
// them differently; wmic adds a leading Node column). CommandLine may be
// absent (older queries) — those rows carry "". Returns
// [{pid, ppid, cmdline}] or null when unusable.
export function parseProcessCsv(text) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]).map(c => c.toLowerCase());
  const pidIdx = header.indexOf("processid");
  const ppidIdx = header.indexOf("parentprocessid");
  if (pidIdx < 0 || ppidIdx < 0) return null;
  const cmdIdx = header.indexOf("commandline");
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const pid = Number((cells[pidIdx] ?? "").trim());
    const ppid = Number((cells[ppidIdx] ?? "").trim());
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid) && ppid >= 0) {
      rows.push({pid, ppid, cmdline: cmdIdx >= 0 ? (cells[cmdIdx] ?? "") : ""});
    }
  }
  return rows.length ? rows : null;
}

function splitCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

// True when the adapter process has at least one LIVE descendant that is
// NOT its own launcher chain (chain = command line contains one of
// `markers`; see the docblock). Unknown (unreadable process table) reads
// as false — callers treat stale/unknown scans as "do not kill", never as
// a hang signal.
export function hasLiveWorkProcess(pid, {platform = process.platform, markers = [], ...deps} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const found = platform === "win32" ? windowsDescendants(pid, deps) : linuxDescendants(pid, deps);
    if (found.unknown) return false;
    return found.entries.some(entry => !isChainCommand(entry.cmdline, markers));
  } catch {
    return false;
  }
}

// --- File-write detection --------------------------------------------------

// Repo subtrees the write scan never enters: .git (not work output),
// node_modules (tooling churn, not session work), and .autopilot/ (the
// orchestrator's OWN run logs, state, and watch reports live there —
// scanning them would let the monitor's own writes reset the clock and a
// true hang would never trip). The run's scratch dir is scanned EXPLICITLY
// by the caller (it may live under .autopilot/), minus its git-guard/
// subdir (guard logs track adapter git calls, which always imply a live
// child anyway; the orchestrator's own before/after snapshots run outside
// the session window).
const SKIPPED_DIR_NAMES = new Set([".git", "node_modules", ".autopilot", "git-guard"]);

// Max file mtime (ms) under the watched roots. {unavailable:true} when a
// root cannot be read at all; partial reads still report what was seen
// (best-effort: an unreadable subtree is skipped, never fatal).
export function snapshotWorkWrites({repoRoot, scratchDir = null, skipNames = SKIPPED_DIR_NAMES, fs: fsDep = fs} = {}) {
  let maxMtimeMs = 0;
  let sawAny = false;
  const walk = (dir, skip) => {
    let entries;
    try {
      entries = fsDep.readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, skip);
      } else if (entry.isFile()) {
        try {
          const mtimeMs = fsDep.statSync(full).mtimeMs;
          sawAny = true;
          if (mtimeMs > maxMtimeMs) maxMtimeMs = mtimeMs;
        } catch {
          /* raced deletion: ignore */
        }
      }
    }
  };
  if (repoRoot) walk(repoRoot, skipNames);
  // The scratch dir is scanned WITHOUT the .autopilot exclusion (it may
  // live under the run dir) but still skips .git/node_modules/git-guard.
  if (scratchDir) {
    const scratchSkip = new Set([...skipNames].filter(name => name !== ".autopilot"));
    walk(scratchDir, scratchSkip);
  }
  if (!sawAny) return {unavailable: true, maxMtimeMs: 0};
  return {maxMtimeMs};
}

export function writesSince(snapshot, args) {
  if (!snapshot || snapshot.unavailable) return false;
  const current = snapshotWorkWrites(args);
  if (current.unavailable) return false;
  return current.maxMtimeMs > snapshot.maxMtimeMs;
}

// --- Watch state machine ----------------------------------------------------

export function formatIdleMinutes(ms) {
  const minutes = Math.round(ms / 60000);
  return `${minutes} min`;
}

export function formatIdleHangMessage({role, adapter, model, idleMs, maxSilence = false}) {
  const who = `${role} (${adapter}${model ? `, ${model}` : ""})`;
  if (maxSilence) return `IDLE_HANG (max silence): ${who} produced no stream output for ${formatIdleMinutes(idleMs)} while a tool ran`;
  return `IDLE_HANG: ${who} produced no output, ran no command and wrote no file for ${formatIdleMinutes(idleMs)}`;
}

export function formatRateLimitedMessage({role, adapter, model, provider}) {
  const modelLabel = model || adapter;
  const providerLabel = provider && provider !== adapter ? `${provider}/${modelLabel}` : modelLabel;
  return (
    `RATE_LIMITED: ${role} (${adapter}, ${model || "unknown model"}) hit a provider rate limit (${providerLabel}); ` +
    `opencode retried silently in its own log. The operator may need to wait or re-login ` +
    `(\`opencode auth login\` inside WSL — the WSL and Windows opencode accounts are separate).`
  );
}

export function createIdleWatch({
  idleHangMs,
  // Shorter limit while the run has produced no output at all (0 = none).
  firstOutputMs = 0,
  // Backlog #104: hard cap on total silence (no stream byte, no file write)
  // even while a tool child process is alive (0 = no cap).
  maxSilenceMs = 0,
  pid = null,
  adapter = "",
  repoRoot = null,
  scratchDir = null,
  opencodeLogBase = null,
  // Shared real-HOME base used when the primary (private session store)
  // base holds no log: an unsandboxed adapter logs in the real HOME, never
  // in the empty bound store (2026-10-13 incident A).
  opencodeLogFallbackBase = null,
  // Backlog #36: false-positive guard for the shared HOME log. The
  // implementer's bound session store is private to this session, so its
  // unattributed lines are this session's by construction; the real-HOME
  // fallback log is shared with every opencode session on the machine
  // (including one the operator runs by hand at the same time), so only
  // lines carrying THIS session's id may count there.
  logPrivate = false,
  sessionId = null,
  rateLimitGapMs = RATE_LIMIT_CONFIRM_GAP_MS,
  rateLimitMatches = RATE_LIMIT_CONFIRM_MATCHES,
  now = Date.now(),
  startedAtMs = now,
  platform = process.platform,
  adapterMarkers = [],
} = {}) {
  const primaryFile = opencodeLogBase ? findOpencodeLogFile(opencodeLogBase) : null;
  const logFile = primaryFile ?? (opencodeLogFallbackBase ? findOpencodeLogFile(opencodeLogFallbackBase) : null);
  const logOffsets = new Map();
  let logOffset = 0;
  if (logFile) {
    try {
      logOffset = fs.statSync(logFile).size;
    } catch {
      logOffset = 0;
    }
  }
  // Baseline the fallback log too so a later switch to it never rescans
  // history: only bytes appended after the watch armed count.
  if (opencodeLogFallbackBase) {
    const fb = findOpencodeLogFile(opencodeLogFallbackBase);
    if (fb) {
      try {
        logOffsets.set(fb, fb === logFile ? logOffset : fs.statSync(fb).size);
      } catch {
        /* baseline is best-effort */
      }
    }
  }
  return {
    idleHangMs,
    firstOutputMs: Number(firstOutputMs) > 0 ? Number(firstOutputMs) : 0,
    hasOutput: false,
    maxSilenceMs: Number(maxSilenceMs) > 0 ? Number(maxSilenceMs) : 0,
    lastSilenceResetAt: now,
    pid,
    adapter,
    repoRoot,
    scratchDir,
    opencodeLogBase,
    opencodeLogFallbackBase,
    rateLimitGapMs,
    rateLimitMatches,
    lastActivityAt: now,
    lastChildScan: {at: 0, alive: false},
    writes: repoRoot || scratchDir ? snapshotWorkWrites({repoRoot, scratchDir}) : {unavailable: true, maxMtimeMs: 0},
    opencodeLogFile: logFile,
    opencodeLogOffset: logOffset,
    opencodeLogOffsets: logOffsets,
    rateLimitFirstAt: null,
    rateLimitHits: 0,
    rateLimitDetail: null,
    startedAt: now,
    startedAtMs,
    platform,
    adapterMarkers: Array.isArray(adapterMarkers) ? adapterMarkers : [],
    logPrivate: Boolean(logPrivate),
    sessionId: sessionId || null,
  };
}

// This session's own id, captured live from its stdout events (the wiring
// feeds every stdout chunk through extractSessionIdFromChunk). First wins:
// the id is stable for the session. Until it is known, no log line counts
// (backlog #36) — the idle watchdog still applies throughout.
export function noteIdleSessionId(watch, id) {
  if (!watch || watch.sessionId) return watch?.sessionId ?? null;
  const sid = String(id ?? "").trim();
  if (!sid) return null;
  watch.sessionId = sid;
  return sid;
}

// Every adapter stdout/stderr chunk resets the activity clock AND clears a
// pending (unconfirmed) rate-limit suspicion: a session that still produces
// output is making progress, and test 8's "single matching line followed
// by normal output → not killed" is exactly this rule.
export function noteIdleOutput(watch, now = Date.now()) {
  watch.lastActivityAt = now;
  watch.lastSilenceResetAt = now;
  watch.hasOutput = true;
  watch.rateLimitFirstAt = null;
  watch.rateLimitHits = 0;
  watch.rateLimitDetail = null;
}

// Backlog #115: opencode retrying a hung provider call re-emits only
// {"type":"step_start", "part":{"messageID":"<same id>"}} every few minutes.
// A step_start repeating the previous step_start's messageID (nothing else in
// between) is NOT progress and must not reset the idle clock. Real progress:
// text, tool_use, step_finish, any other event, a step_start with a NEW
// messageID, or anything unparseable (conservative). Returns true when the
// chunk counted as progress. The first-ever chunk always counts.
export function noteIdleStdoutChunk(watch, chunk, now = Date.now()) {
  if (watch?.adapter !== "opencode") {
    noteIdleOutput(watch, now);
    return true;
  }
  let repeatOnly = false;
  let lastId = watch.lastStepStartId ?? null;
  const lines = String(chunk ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  let sawStep = false;
  let progress = lines.length === 0;
  for (const line of lines) {
    let ev = null;
    try {
      ev = JSON.parse(line);
    } catch {
      ev = null;
    }
    if (!ev || typeof ev !== "object" || ev.type !== "step_start") {
      progress = true;
      lastId = null;
      continue;
    }
    const id = ev.part?.messageID ?? ev.messageID ?? null;
    sawStep = true;
    if (id && id === lastId) continue;
    progress = true;
    lastId = id;
  }
  repeatOnly = sawStep && !progress;
  watch.lastStepStartId = lastId;
  if (repeatOnly && watch.hasOutput) {
    watch.repeatedStepStarts = (watch.repeatedStepStarts ?? 0) + 1;
    return false;
  }
  watch.repeatedStepStarts = 0;
  noteIdleOutput(watch, now);
  return true;
}

// opencode stderr fast path (any role): engine-level rate-limit text on
// the adapter's own stderr counts like a log hit. Model prose lives on
// stdout, never stderr, so these patterns cannot misfire on content. No
// session-id gate here (unlike the log tail): this stderr belongs to THIS
// adapter process, so it cannot come from a foreign session the way shared
// HOME log lines can (backlog #36 does not apply).
export function noteIdleStderrText(watch, text, now = Date.now()) {
  const info = rateLimitLineInfo(String(text ?? "").slice(-4000));
  if (info) registerRateLimitHit(watch, info, now);
}

function registerRateLimitHit(watch, info, now) {
  if (watch.rateLimitFirstAt == null) {
    watch.rateLimitFirstAt = now;
    watch.rateLimitHits = 1;
    watch.rateLimitDetail = info;
    return;
  }
  watch.rateLimitHits += 1;
  watch.rateLimitDetail = info;
}

function rateLimitConfirmed(watch, now) {
  return (
    watch.rateLimitFirstAt != null &&
    watch.rateLimitHits >= watch.rateLimitMatches &&
    now - watch.rateLimitFirstAt >= watch.rateLimitGapMs
  );
}

// Newest log: the primary (private store) base when it has one, else the
// shared real-HOME fallback.
function resolveWatchedLog(watch) {
  return (watch.opencodeLogBase ? findOpencodeLogFile(watch.opencodeLogBase) : null) ??
    (watch.opencodeLogFallbackBase ? findOpencodeLogFile(watch.opencodeLogFallbackBase) : null);
}

function pollOpencodeLog(watch, now) {
  if (!watch.opencodeLogBase && !watch.opencodeLogFallbackBase) return;
  if (!(watch.opencodeLogOffsets instanceof Map)) watch.opencodeLogOffsets = new Map();
  const newest = resolveWatchedLog(watch);
  if (!watch.opencodeLogFile || !fs.existsSync(watch.opencodeLogFile)) {
    watch.opencodeLogFile = newest;
    watch.opencodeLogOffset = newest && watch.opencodeLogOffsets.has(newest) ? watch.opencodeLogOffsets.get(newest) : 0;
    if (!watch.opencodeLogFile) return;
  } else {
    const switched = resolveOpencodeLogSwitch(
      watch.opencodeLogFile,
      watch.opencodeLogOffset,
      watch.opencodeLogOffsets,
      newest,
    );
    watch.opencodeLogFile = switched.file;
    watch.opencodeLogOffset = switched.offset;
    watch.opencodeLogOffsets = switched.offsetsByFile;
  }
  // Private only while tailing the private store itself; the fallback is the
  // shared HOME log and needs the session-id gate.
  const privateNow = Boolean(watch.logPrivate) && Boolean(watch.opencodeLogBase) &&
    String(watch.opencodeLogFile).startsWith(String(watch.opencodeLogBase));
  const {text, nextOffset} = readLogAppend(watch.opencodeLogFile, watch.opencodeLogOffset);
  watch.opencodeLogOffset = nextOffset;
  if (!text) return;
  for (const line of text.split("\n")) {
    const info = rateLimitLineInfo(line);
    if (!info) continue;
    if (!lineNewerThanSessionStart(line, watch.startedAtMs)) continue;
    // Backlog #36: session scoping. Until our own session id is known,
    // nothing counts (concurrent foreign sessions share the HOME log, so a
    // timestamp baseline cannot attribute). A line for another session is
    // ignored. An unattributed line counts only for the implementer's
    // bound store, which is private to this session by construction.
    if (watch.sessionId == null) continue;
    const lineSid = extractLogSessionId(line);
    if (lineSid == null) {
      if (!privateNow) continue;
    } else if (lineSid !== watch.sessionId) continue;
    registerRateLimitHit(watch, info, now);
  }
}

// One evaluation step. Call ONLY about once per second (the relay 1s
// capTimer): repo/process scans run only once output has already been
// quiet for the full idleHangMs, so an active session pays nothing here.
// Returns {status:"ok"} | {status:"hung", idleMs, noOutput} |
// {status:"rate_limited", provider, model}.
export function evaluateIdleWatch(watch, {now = Date.now(), platform = process.platform} = {}) {
  if (!watch || !(watch.idleHangMs > 0)) return {status: "ok"};
  // Rate-limit tail runs on every tick (stat + bounded append read only);
  // it fires independently of the idle signals.
  if (watch.adapter === "opencode") {
    try {
      pollOpencodeLog(watch, now);
    } catch {
      /* log tailing is best-effort; the idle watchdog still applies */
    }
    if (rateLimitConfirmed(watch, now)) {
      return {status: "rate_limited", provider: watch.rateLimitDetail?.provider ?? null, model: watch.rateLimitDetail?.model ?? null};
    }
  }
  const quietFor = now - watch.lastActivityAt;
  // First-output deadline: until the first stdout/stderr byte arrives the
  // shorter firstOutputMs applies (never longer than idleHangMs).
  const noOutput = !watch.hasOutput;
  const limitMs = noOutput && watch.firstOutputMs > 0 ? Math.min(watch.firstOutputMs, watch.idleHangMs) : watch.idleHangMs;
  // Backlog #104: absolute silence cap. Independent of the descendant scan:
  // a tool child that runs (or sleeps) for longer than maxSilenceMs without
  // any stream byte or file write no longer suspends the watchdog.
  const capped = watch.maxSilenceMs > 0 && now - (watch.lastSilenceResetAt ?? watch.lastActivityAt) >= watch.maxSilenceMs;
  if (quietFor < limitMs && !capped) return {status: "ok"};
  // Output has been quiet for the full window: check writes (cheap sync
  // walk, skipped-dir bounded). Any write resets the clock AND the
  // baseline, so a steadily-working-but-silent session never accumulates
  // quiet time across ticks.
  if (watch.repoRoot || watch.scratchDir) {
    let grew = false;
    try {
      grew = writesSince(watch.writes, {repoRoot: watch.repoRoot, scratchDir: watch.scratchDir});
    } catch {
      grew = false;
    }
    try {
      watch.writes = snapshotWorkWrites({repoRoot: watch.repoRoot, scratchDir: watch.scratchDir});
    } catch {
      /* baseline refresh is best-effort */
    }
    if (grew) {
      watch.lastActivityAt = now;
      watch.lastSilenceResetAt = now;
      return {status: "ok"};
    }
  }
  if (capped) return {status: "hung", idleMs: now - (watch.lastSilenceResetAt ?? watch.lastActivityAt), noOutput, maxSilence: true};
  // Backlog #104: a run that never produced a single byte is not kept alive
  // by a live descendant: whatever the process tree looks like (sandbox
  // wrapper, adapter launcher not matched by a marker), no output at all
  // inside the first-output window is a silent model.
  if (noOutput && watch.firstOutputMs > 0) return {status: "hung", idleMs: quietFor, noOutput};
  // No output, no writes: the descendant scan (the only potentially slow
  // check — a Windows process-table snapshot — and it runs solely during
  // suspicious silence, never during active work). A live descendant is
  // work: reset the clock. Unknown/stale never kills. Without a session
  // pid there is no session to judge (a spawn failure surfaces through the
  // normal start-error path), so never report hung.
  if (!Number.isInteger(watch.pid) || watch.pid <= 0) return {status: "ok"};
  const scanPlatform = watch.platform ?? platform;
  let alive = false;
  let known = true;
  try {
    const found = scanPlatform === "win32" ? windowsDescendants(watch.pid) : linuxDescendants(watch.pid);
    if (found.unknown) known = false;
    else alive = found.entries.some(entry => !isChainCommand(entry.cmdline, watch.adapterMarkers));
  } catch {
    known = false;
  }
  watch.lastChildScan = {at: now, alive: alive && known};
  if (!known) return {status: "ok"};
  if (alive) {
    watch.lastActivityAt = now;
    return {status: "ok"};
  }
  return {status: "hung", idleMs: quietFor, noOutput};
}

export const __testables = Object.freeze({
  linuxDescendants,
  windowsDescendants,
  queryWindowsProcessTable,
  parseProcessCsv,
  procStatState,
  isChainCommand,
});
