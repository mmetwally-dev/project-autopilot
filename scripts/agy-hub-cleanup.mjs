import fs from "node:fs";
import path from "node:path";

function isLinuxLike(procRoot) {
  if (procRoot && procRoot !== "/proc") return true;
  return process.platform === "linux";
}

function parseCmdline(raw) {
  if (!raw || typeof raw !== "string") return [];
  const parts = raw.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

function isAgyBinary(args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const b0 = path.basename(args[0]);
  if (b0 === "agy") return true;
  if ((b0 === "node" || b0 === "nodejs") && args.length > 1 && path.basename(args[1]) === "agy") {
    return true;
  }
  return false;
}

function isAgyHubArgs(args) {
  if (!isAgyBinary(args)) return false;
  return args.includes("--hub") || args.some((a) => a === "--hub" || a.startsWith("--hub="));
}

function parseStat(statRaw) {
  if (!statRaw || typeof statRaw !== "string") return null;
  const rParen = statRaw.lastIndexOf(")");
  if (rParen === -1) return null;
  const lParen = statRaw.indexOf("(");
  if (lParen === -1 || lParen >= rParen) return null;

  const pid = parseInt(statRaw.slice(0, lParen).trim(), 10);
  const rest = statRaw.slice(rParen + 1).trim().split(/\s+/);

  if (rest.length >= 20) {
    const ppid = parseInt(rest[1], 10);
    const pgid = parseInt(rest[2], 10);
    const startTicks = parseInt(rest[19], 10);
    if (isNaN(pid) || isNaN(ppid) || isNaN(pgid) || isNaN(startTicks)) return null;
    return { pid, ppid, pgid, startTicks };
  } else if (rest.length >= 3) {
    const ppid = parseInt(rest[0], 10);
    const pgid = parseInt(rest[1], 10);
    const startTicks = parseInt(rest[2], 10);
    if (isNaN(pid) || isNaN(ppid) || isNaN(pgid) || isNaN(startTicks)) return null;
    return { pid, ppid, pgid, startTicks };
  }
  return null;
}

function getAncestorChain(startPid, procRoot) {
  const chain = [];
  const visited = new Set([startPid]);
  let cur = startPid;
  while (cur > 1) {
    let statRaw;
    try {
      statRaw = fs.readFileSync(path.join(procRoot, String(cur), "stat"), "utf8");
    } catch {
      break;
    }
    const parsed = parseStat(statRaw);
    if (!parsed || typeof parsed.ppid !== "number" || parsed.ppid <= 0) break;
    const ppid = parsed.ppid;
    if (visited.has(ppid)) break;
    visited.add(ppid);

    let cmdline = "";
    try {
      cmdline = fs.readFileSync(path.join(procRoot, String(ppid), "cmdline"), "utf8");
    } catch {}

    chain.push({ pid: ppid, cmdline });
    cur = ppid;
  }
  return chain;
}

function matchesAddDir(args, addDirs) {
  if (!Array.isArray(args) || !Array.isArray(addDirs)) return false;
  const validAddDirs = addDirs.filter((d) => typeof d === "string" && d.trim().length > 0);
  if (validAddDirs.length === 0) return false;

  const targetDirs = new Set(validAddDirs.map((d) => path.resolve(d).replace(/\/+$/, "")));
  const targetRaw = new Set(validAddDirs.map((d) => d.replace(/\/+$/, "")));

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let val = null;
    if (arg.startsWith("--add-dir=")) {
      val = arg.slice("--add-dir=".length);
    } else if (arg === "--add-dir" && i + 1 < args.length) {
      val = args[i + 1];
    }
    if (typeof val === "string") {
      const cleanVal = val.replace(/\/+$/, "");
      if (targetRaw.has(cleanVal) || targetDirs.has(path.resolve(cleanVal).replace(/\/+$/, ""))) {
        return true;
      }
    }
  }
  return false;
}

function sleepSyncMs(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

/**
 * List running agy hub processes via /proc (or injectable procRoot).
 *
 * @param {{procRoot?: string}} [opts]
 * @returns {Array<{pid: number, ppid: number, pgid: number, startTicks: number, args: string[]}>}
 */
export function listAgyHubs({ procRoot = "/proc" } = {}) {
  if (!isLinuxLike(procRoot)) return [];
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    const procDir = path.join(procRoot, entry);

    let cmdlineRaw;
    try {
      cmdlineRaw = fs.readFileSync(path.join(procDir, "cmdline"), "utf8");
    } catch {
      continue;
    }

    const args = parseCmdline(cmdlineRaw);
    if (!isAgyHubArgs(args)) continue;

    let statRaw;
    try {
      statRaw = fs.readFileSync(path.join(procDir, "stat"), "utf8");
    } catch {
      continue;
    }

    const parsedStat = parseStat(statRaw);
    if (!parsedStat) continue;

    results.push({
      pid: parsedStat.pid || pid,
      ppid: parsedStat.ppid,
      pgid: parsedStat.pgid,
      startTicks: parsedStat.startTicks,
      args,
    });
  }

  return results;
}

/**
 * Identify hubs from an `after` snapshot that belong to this run and should be stopped.
 *
 * @param {{before?: Array<any>, after?: Array<any>, relayPid?: number|null, addDirs?: string[], procRoot?: string}} opts
 * @returns {Array<{pid: number, ppid: number, pgid: number, startTicks: number, args: string[]}>}
 */
export function runHubsToStop({ before = [], after, relayPid = null, addDirs = [], procRoot = "/proc" } = {}) {
  if (!isLinuxLike(procRoot)) return [];
  const effectiveAfter = after !== undefined ? after : listAgyHubs({ procRoot });
  if (!Array.isArray(effectiveAfter) || effectiveAfter.length === 0) return [];

  const beforeKeys = new Set((before || []).map((h) => `${h.pid}:${h.startTicks}`));
  const candidates = effectiveAfter.filter((h) => !beforeKeys.has(`${h.pid}:${h.startTicks}`));

  const validRelayPid = typeof relayPid === "number" && relayPid > 1;
  const toStop = [];

  for (const candidate of candidates) {
    const chain = getAncestorChain(candidate.pid, procRoot);

    // NEVER return a hub whose parent process cmdline contains antigravity-ide-server
    // or whose ancestor chain contains it.
    if (chain.some((a) => a.cmdline && a.cmdline.includes("antigravity-ide-server"))) {
      continue;
    }

    let parentCmdlineRaw = "";
    let parentPid = candidate.ppid;
    if (chain.length > 0) {
      parentPid = chain[0].pid;
      parentCmdlineRaw = chain[0].cmdline;
    } else if (typeof parentPid === "number" && parentPid > 0) {
      try {
        parentCmdlineRaw = fs.readFileSync(path.join(procRoot, String(parentPid), "cmdline"), "utf8");
      } catch {}
    }
    const parentArgs = parseCmdline(parentCmdlineRaw);
    const parentIsOtherAgyCli =
      parentPid > 1 &&
      parentPid !== relayPid &&
      isAgyBinary(parentArgs) &&
      !isAgyHubArgs(parentArgs);

    const isPpid = validRelayPid && candidate.ppid === relayPid;
    const isPgid = validRelayPid && candidate.pgid === relayPid;
    const isAncestor = validRelayPid && chain.some((a) => a.pid === relayPid);
    const isOrphanWithAddDir = matchesAddDir(candidate.args, addDirs) && !parentIsOtherAgyCli;

    if (isPpid || isPgid || isAncestor || isOrphanWithAddDir) {
      toStop.push(candidate);
    }
  }

  return toStop;
}

/**
 * Stop run hubs: SIGTERM process group (if pgid === pid) or pid, wait up to 2 s, SIGKILL survivors.
 * Never throws.
 *
 * @param {Array<{pid: number, pgid?: number}>} hubs
 * @param {{killFn?: Function, waitMs?: number, pollIntervalMs?: number, isAliveFn?: Function}} [opts]
 * @returns {number[]} Stopped pids
 */
export function stopRunHubs(hubs, { killFn = process.kill, waitMs = 2000, pollIntervalMs = 50, isAliveFn } = {}) {
  try {
    if (!Array.isArray(hubs) || hubs.length === 0) return [];
    if (process.platform !== "linux" && killFn === process.kill) return [];

    const isAlive = isAliveFn || ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e?.code === "EPERM";
      }
    });

    for (const hub of hubs) {
      if (!hub || typeof hub.pid !== "number" || hub.pid <= 0) continue;
      const target = (hub.pgid === hub.pid) ? -hub.pid : hub.pid;
      try {
        killFn(target, "SIGTERM");
      } catch {
        if (target < 0) {
          try { killFn(hub.pid, "SIGTERM"); } catch {}
        }
      }
    }

    const deadline = Date.now() + Math.max(0, waitMs);
    while (Date.now() < deadline) {
      const anyAlive = hubs.some((h) => typeof h.pid === "number" && h.pid > 0 && isAlive(h.pid));
      if (!anyAlive) break;
      sleepSyncMs(pollIntervalMs);
    }

    for (const hub of hubs) {
      if (!hub || typeof hub.pid !== "number" || hub.pid <= 0) continue;
      if (isAlive(hub.pid)) {
        const target = (hub.pgid === hub.pid) ? -hub.pid : hub.pid;
        try {
          killFn(target, "SIGKILL");
        } catch {
          if (target < 0) {
            try { killFn(hub.pid, "SIGKILL"); } catch {}
          }
        }
      }
    }

    const killDeadline = Date.now() + 500;
    while (Date.now() < killDeadline) {
      const anyAlive = hubs.some((h) => typeof h.pid === "number" && h.pid > 0 && isAlive(h.pid));
      if (!anyAlive) break;
      sleepSyncMs(pollIntervalMs);
    }

    return hubs.map((h) => h.pid).filter((pid) => typeof pid === "number" && pid > 0);
  } catch {
    return [];
  }
}
