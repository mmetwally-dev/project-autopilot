import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { priceWeightedUsage } from "./adapter-drivers.mjs";

export function resolveCodexHomes({ launchEnv, effectiveScratchDir, dir, defaultCodexHome } = {}) {
  const homes = [];
  const add = (h) => {
    if (typeof h === "string" && h.trim()) {
      const trimmed = h.trim();
      if (!homes.includes(trimmed)) homes.push(trimmed);
    }
  };

  if (launchEnv && typeof launchEnv === "object") {
    if (launchEnv.CODEX_HOME) add(launchEnv.CODEX_HOME);
    if (launchEnv.HOME) add(path.join(launchEnv.HOME, ".codex"));
    if (launchEnv.USERPROFILE) add(path.join(launchEnv.USERPROFILE, ".codex"));
  }
  if (effectiveScratchDir) {
    add(path.join(effectiveScratchDir, ".autopilot-home", ".codex"));
  }
  if (dir) {
    add(path.join(dir, "scratch", ".autopilot-home", ".codex"));
  }
  if (defaultCodexHome) {
    add(defaultCodexHome);
  }
  const defaultHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  add(defaultHome);
  add(path.join(os.homedir(), ".codex"));

  return homes;
}

export function findCodexRollout({ threadId, codexHome, codexHomes, scratchDir, startedAt } = {}) {
  try {
    if (!threadId || typeof threadId !== "string") return null;
    const scratchHome = scratchDir ? path.join(scratchDir, ".autopilot-home", ".codex") : null;
    const defaultHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

    const homes = [];
    if (scratchHome) homes.push(scratchHome);

    const inputHomes = codexHomes ?? codexHome;
    if (Array.isArray(inputHomes)) {
      for (const h of inputHomes) {
        if (typeof h === "string" && h.trim() && !homes.includes(h.trim())) {
          homes.push(h.trim());
        }
      }
    } else if (typeof inputHomes === "string" && inputHomes.trim()) {
      if (!homes.includes(inputHomes.trim())) {
        homes.push(inputHomes.trim());
      }
    }
    if (homes.length === 0) {
      homes.push(defaultHome);
    }

    const start = startedAt ? new Date(startedAt) : new Date();
    const startDate = Number.isNaN(start.getTime()) ? new Date() : start;
    const nextDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);

    for (const home of homes) {
      if (!fs.existsSync(home)) continue;

      const dateCandidates = [startDate, nextDate];
      const candidateDirs = new Set();

      for (const d of dateCandidates) {
        // Local date format YYYY/MM/DD
        const ly = d.getFullYear();
        const lm = String(d.getMonth() + 1).padStart(2, "0");
        const ld = String(d.getDate()).padStart(2, "0");
        candidateDirs.add(path.join(home, "sessions", String(ly), lm, ld));
        candidateDirs.add(path.join(home, "sessions", String(ly), String(d.getMonth() + 1), String(d.getDate())));

        // UTC date format YYYY/MM/DD
        const uy = d.getUTCFullYear();
        const um = String(d.getUTCMonth() + 1).padStart(2, "0");
        const ud = String(d.getUTCDate()).padStart(2, "0");
        candidateDirs.add(path.join(home, "sessions", String(uy), um, ud));
        candidateDirs.add(path.join(home, "sessions", String(uy), String(d.getUTCMonth() + 1), String(d.getUTCDate())));
      }

      for (const dir of candidateDirs) {
        if (!fs.existsSync(dir)) continue;
        let entries;
        try { entries = fs.readdirSync(dir); } catch { continue; }
        const matches = entries.filter((name) =>
          name.startsWith("rollout-") &&
          name.endsWith(".jsonl") &&
          name.includes(threadId)
        );
        if (matches.length > 0) {
          matches.sort((a, b) => {
            const aSuffix = a.endsWith(`-${threadId}.jsonl`) || a.endsWith(`_${threadId}.jsonl`);
            const bSuffix = b.endsWith(`-${threadId}.jsonl`) || b.endsWith(`_${threadId}.jsonl`);
            if (aSuffix && !bSuffix) return -1;
            if (!aSuffix && bSuffix) return 1;
            try {
              const statA = fs.statSync(path.join(dir, a)).mtimeMs;
              const statB = fs.statSync(path.join(dir, b)).mtimeMs;
              return statB - statA;
            } catch {
              return b.localeCompare(a);
            }
          });
          return path.join(dir, matches[0]);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function codexUsageFromRollout(file) {
  try {
    if (!file || typeof file !== "string" || !fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    let lastTot = null;
    let maxSingleTurnContext = null;
    let contextWindow = null;
    let turns = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event !== "object") continue;

      const payload = event.payload;
      let info = null;
      if (payload && typeof payload === "object" && payload.type === "token_count") {
        info = payload.info || payload;
      } else if (event.type === "token_count") {
        info = event.info || event;
      }

      if (info && typeof info === "object") {
        const tot = info.total_token_usage;
        if (tot && typeof tot === "object") {
          lastTot = tot;
        }
        const lastUsage = info.last_token_usage;
        if (lastUsage && typeof lastUsage === "object") {
          const inp = Number(lastUsage.input_tokens);
          if (Number.isFinite(inp) && inp >= 0) {
            maxSingleTurnContext = maxSingleTurnContext === null ? inp : Math.max(maxSingleTurnContext, inp);
          }
        }
        const win = Number(info.model_context_window ?? payload?.model_context_window ?? event.model_context_window);
        if (Number.isFinite(win) && win > 0) {
          contextWindow = win;
        }
      }

      if (event.type === "item.completed") {
        const item = event.item || event;
        const itemType = String(item?.type || "");
        if (/^(?:command_execution|file_change|mcp_tool_call)$/i.test(itemType)) {
          turns += 1;
        }
      }
    }

    if (!lastTot) return null;

    const rawInput = Number(lastTot.input_tokens) || 0;
    const cached = Number(lastTot.cached_input_tokens) || 0;
    const input = Math.max(0, rawInput - cached);
    const cacheRead = cached;
    const cacheCreation = 0;
    const output = Number(lastTot.output_tokens) || 0;

    const usage = {
      input,
      cacheRead,
      cacheCreation: 0,
      output,
      ...(turns > 0 ? { turns } : {}),
      maxSingleTurnContext,
      ...(contextWindow != null ? { contextWindow } : {}),
    };

    return {
      ...usage,
      priceWeighted: priceWeightedUsage(usage)
    };
  } catch {
    return null;
  }
}

export function deleteCodexRollout(file) {
  try {
    if (file && typeof file === "string" && fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {}
}

export function reconcileCodexRolloutUsage({ threadId, codexHome, codexHomes, scratchDir, startedAt, usage } = {}) {
  try {
    if (!threadId) return usage;
    const rolloutFile = findCodexRollout({ threadId, codexHome, codexHomes, scratchDir, startedAt });
    if (!rolloutFile) return usage;
    let resultUsage = usage;
    const rUsage = codexUsageFromRollout(rolloutFile);
    if (!usage || usage.usagePartial === true) {
      if (rUsage) {
        resultUsage = {
          ...(usage || {}),
          ...rUsage,
          usagePartial: false,
          turns: usage?.turns ?? rUsage.turns ?? 0,
          maxSingleTurnContext: rUsage.maxSingleTurnContext ?? usage?.maxSingleTurnContext ?? null,
          ...(rUsage.contextWindow ? { contextWindow: rUsage.contextWindow } : {})
        };
      }
    } else if (rUsage) {
      resultUsage = {
        ...usage,
        maxSingleTurnContext: rUsage.maxSingleTurnContext ?? usage.maxSingleTurnContext ?? null,
        ...(rUsage.contextWindow ? { contextWindow: rUsage.contextWindow } : {})
      };
    }
    deleteCodexRollout(rolloutFile);
    return resultUsage;
  } catch {
    return usage;
  }
}

export function reconcileLiveCodexRolloutUsage(arg1, arg2) {
  try {
    let usage;
    let rolloutSource;
    if (arg1 && typeof arg1 === "object" && ("usage" in arg1 || "rolloutFile" in arg1 || "rolloutSource" in arg1)) {
      usage = arg1.usage;
      rolloutSource = arg1.rolloutFile ?? arg1.rolloutSource;
      if (!rolloutSource && arg1.threadId) {
        rolloutSource = findCodexRollout({
          threadId: arg1.threadId,
          codexHome: arg1.codexHome ?? arg1.codexHomes,
          scratchDir: arg1.scratchDir,
          startedAt: arg1.startedAt
        });
      }
    } else {
      usage = arg1;
      rolloutSource = arg2;
    }

    if (!usage || typeof usage !== "object") return usage;

    let rUsage = null;
    if (typeof rolloutSource === "string") {
      rUsage = codexUsageFromRollout(rolloutSource);
    } else if (rolloutSource && typeof rolloutSource === "object") {
      rUsage = rolloutSource;
    }

    if (!rUsage) return usage;

    const input = Number(rUsage.input) || 0;
    const cacheRead = Number(rUsage.cacheRead) || 0;
    const cacheCreation = Number(rUsage.cacheCreation) || 0;
    const output = Number(rUsage.output) || 0;
    const maxSingleTurnContext = rUsage.maxSingleTurnContext !== undefined
      ? rUsage.maxSingleTurnContext
      : (usage.maxSingleTurnContext ?? null);

    const merged = {
      ...usage,
      input,
      cacheRead,
      cacheCreation,
      output,
      maxSingleTurnContext,
      ...(rUsage.contextWindow != null ? { contextWindow: rUsage.contextWindow } : {}),
      turns: usage.turns ?? 0,
      usagePartial: true
    };
    merged.priceWeighted = priceWeightedUsage(merged);
    return merged;
  } catch {
    return usage;
  }
}

