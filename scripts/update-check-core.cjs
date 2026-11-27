'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const base = v.trim().split(/[-+]/)[0];
  if (!base) return null;
  const parts = base.split('.');
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
  }
  return parts.map(Number);
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  const maxLen = Math.max(pa.length, pb.length);
  for (let i = 0; i < maxLen; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function updateCheckDisabled({ env = process.env, isTTY = false } = {}) {
  if (!isTTY) return true;
  const noUpdate = env && env.AP_NO_UPDATE_CHECK;
  if (noUpdate !== undefined && noUpdate !== null && noUpdate !== '' && noUpdate !== '0') {
    return true;
  }
  const ci = env && env.CI;
  if (ci !== undefined && ci !== null && ci !== '') {
    return true;
  }
  if (env && env.NODE_ENV === 'test') {
    return true;
  }
  return false;
}

function defaultCachePath(env = process.env, homedir = require('node:os').homedir()) {
  const base = (env && env.XDG_CACHE_HOME) || path.join(homedir, '.cache');
  return path.join(base, 'project-autopilot', 'update-check.json');
}

function readCache(cachePath) {
  try {
    if (!cachePath || typeof cachePath !== 'string') return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.checkedAt !== 'number' || !Number.isFinite(parsed.checkedAt)) return null;
    if (parsed.latest !== null && typeof parsed.latest !== 'string') return null;
    return {
      checkedAt: parsed.checkedAt,
      latest: parsed.latest,
    };
  } catch {
    return null;
  }
}

function updateNotice({ current, cache } = {}) {
  if (!cache || typeof cache.latest !== 'string' || typeof current !== 'string') {
    return null;
  }
  if (compareVersions(cache.latest, current) > 0) {
    return `Project Autopilot ${cache.latest} is available (you have ${current}). Update: npm install -g project-autopilot`;
  }
  return null;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function needsRefresh({ cache, now = Date.now() } = {}) {
  if (!cache || typeof cache.checkedAt !== 'number') {
    return true;
  }
  return (now - cache.checkedAt) >= TWENTY_FOUR_HOURS_MS;
}

module.exports = {
  compareVersions,
  updateCheckDisabled,
  defaultCachePath,
  readCache,
  updateNotice,
  needsRefresh,
};
