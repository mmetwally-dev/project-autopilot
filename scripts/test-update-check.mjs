#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  compareVersions,
  updateCheckDisabled,
  defaultCachePath,
  readCache,
  updateNotice,
  needsRefresh,
  refreshCache,
} from './update-check.mjs';

const require = createRequire(import.meta.url);
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-test-update-check-'));

// Record initial state of real ~/.cache/project-autopilot to verify nothing touches it
const realCachePath = path.join(os.homedir(), '.cache', 'project-autopilot', 'update-check.json');
const realCacheExistedBefore = fs.existsSync(realCachePath);
const realCacheMtimeBefore = realCacheExistedBefore ? fs.statSync(realCachePath).mtimeMs : null;
const realCacheContentBefore = realCacheExistedBefore ? fs.readFileSync(realCachePath, 'utf8') : null;

try {
  // ── 1. compareVersions ──
  check('compareVersions: 12.6.1 vs 12.7.0 is -1', compareVersions('12.6.1', '12.7.0') === -1);
  check('compareVersions: 12.6.1 vs 12.6.1 is 0', compareVersions('12.6.1', '12.6.1') === 0);
  check('compareVersions: 13.0.0 vs 12.99.99 is 1', compareVersions('13.0.0', '12.99.99') === 1);
  check('compareVersions: 12.10.0 vs 12.9.0 is 1', compareVersions('12.10.0', '12.9.0') === 1);

  // Suffix ignored
  check('compareVersions: suffix -pre ignored', compareVersions('12.6.1-pre', '12.6.1') === 0);
  check('compareVersions: suffix +build ignored', compareVersions('12.6.1+build.123', '12.6.1') === 0);
  check('compareVersions: suffix ignored when comparing newer', compareVersions('12.7.0-beta.1', '12.6.1') === 1);
  check('compareVersions: suffix ignored when comparing older', compareVersions('12.6.1-rc1', '12.7.0') === -1);

  // Garbage → 0
  check('compareVersions: garbage a returns 0', compareVersions('garbage', '12.6.1') === 0);
  check('compareVersions: garbage b returns 0', compareVersions('12.6.1', 'invalid') === 0);
  check('compareVersions: non-numeric part returns 0', compareVersions('12.x.1', '12.6.1') === 0);
  check('compareVersions: empty string returns 0', compareVersions('', '12.6.1') === 0);
  check('compareVersions: null returns 0', compareVersions(null, '12.6.1') === 0);
  check('compareVersions: undefined returns 0', compareVersions(undefined, '12.6.1') === 0);
  check('compareVersions: number returns 0', compareVersions(123, '12.6.1') === 0);

  // ── 2. updateCheckDisabled ──
  check(
    'updateCheckDisabled: false for clean env with isTTY true',
    updateCheckDisabled({ env: {}, isTTY: true }) === false
  );
  check(
    'updateCheckDisabled: true when AP_NO_UPDATE_CHECK="1"',
    updateCheckDisabled({ env: { AP_NO_UPDATE_CHECK: '1' }, isTTY: true }) === true
  );
  check(
    'updateCheckDisabled: true when AP_NO_UPDATE_CHECK="true"',
    updateCheckDisabled({ env: { AP_NO_UPDATE_CHECK: 'true' }, isTTY: true }) === true
  );
  check(
    'updateCheckDisabled: false when AP_NO_UPDATE_CHECK="0"',
    updateCheckDisabled({ env: { AP_NO_UPDATE_CHECK: '0' }, isTTY: true }) === false
  );
  check(
    'updateCheckDisabled: false when AP_NO_UPDATE_CHECK=""',
    updateCheckDisabled({ env: { AP_NO_UPDATE_CHECK: '' }, isTTY: true }) === false
  );
  check(
    'updateCheckDisabled: true when CI="true"',
    updateCheckDisabled({ env: { CI: 'true' }, isTTY: true }) === true
  );
  check(
    'updateCheckDisabled: true when CI="1"',
    updateCheckDisabled({ env: { CI: '1' }, isTTY: true }) === true
  );
  check(
    'updateCheckDisabled: false when CI=""',
    updateCheckDisabled({ env: { CI: '' }, isTTY: true }) === false
  );
  check(
    'updateCheckDisabled: true when NODE_ENV="test"',
    updateCheckDisabled({ env: { NODE_ENV: 'test' }, isTTY: true }) === true
  );
  check(
    'updateCheckDisabled: false when NODE_ENV="production"',
    updateCheckDisabled({ env: { NODE_ENV: 'production' }, isTTY: true }) === false
  );
  check(
    'updateCheckDisabled: true when isTTY is false',
    updateCheckDisabled({ env: {}, isTTY: false }) === true
  );

  // ── 3. defaultCachePath ──
  check(
    'defaultCachePath: honors XDG_CACHE_HOME',
    defaultCachePath({ XDG_CACHE_HOME: '/custom/cache' }, '/home/user') ===
      path.join('/custom/cache', 'project-autopilot', 'update-check.json')
  );
  check(
    'defaultCachePath: defaults to homedir/.cache',
    defaultCachePath({}, '/home/user') ===
      path.join('/home/user', '.cache', 'project-autopilot', 'update-check.json')
  );

  // ── 4. readCache ──
  const missingCache = path.join(tmpDir, 'missing.json');
  check('readCache: missing file returns null', readCache(missingCache) === null);

  const corruptedCache = path.join(tmpDir, 'corrupted.json');
  fs.writeFileSync(corruptedCache, '{bad json');
  check('readCache: corrupted JSON returns null', readCache(corruptedCache) === null);

  const badShapeCache1 = path.join(tmpDir, 'bad-shape1.json');
  fs.writeFileSync(badShapeCache1, JSON.stringify([1, 2, 3]));
  check('readCache: array returns null', readCache(badShapeCache1) === null);

  const badShapeCache2 = path.join(tmpDir, 'bad-shape2.json');
  fs.writeFileSync(badShapeCache2, JSON.stringify({ checkedAt: 'not-a-number', latest: '12.7.0' }));
  check('readCache: non-numeric checkedAt returns null', readCache(badShapeCache2) === null);

  const badShapeCache3 = path.join(tmpDir, 'bad-shape3.json');
  fs.writeFileSync(badShapeCache3, JSON.stringify({ checkedAt: 1000, latest: 123 }));
  check('readCache: non-string non-null latest returns null', readCache(badShapeCache3) === null);

  const validCacheFile = path.join(tmpDir, 'valid.json');
  fs.writeFileSync(validCacheFile, JSON.stringify({ checkedAt: 12345, latest: '12.7.0' }));
  const parsedValid = readCache(validCacheFile);
  check(
    'readCache: valid file parsed correctly',
    parsedValid && parsedValid.checkedAt === 12345 && parsedValid.latest === '12.7.0'
  );

  const validNullLatest = path.join(tmpDir, 'valid-null-latest.json');
  fs.writeFileSync(validNullLatest, JSON.stringify({ checkedAt: 12345, latest: null }));
  const parsedNullLatest = readCache(validNullLatest);
  check(
    'readCache: valid file with null latest parsed correctly',
    parsedNullLatest && parsedNullLatest.checkedAt === 12345 && parsedNullLatest.latest === null
  );

  // ── 5. updateNotice ──
  check(
    'updateNotice: newer returns exact string',
    updateNotice({ current: '12.6.1', cache: { checkedAt: 1000, latest: '12.7.0' } }) ===
      'Project Autopilot 12.7.0 is available (you have 12.6.1). Update: npm install -g project-autopilot'
  );
  check(
    'updateNotice: same returns null',
    updateNotice({ current: '12.6.1', cache: { checkedAt: 1000, latest: '12.6.1' } }) === null
  );
  check(
    'updateNotice: older returns null',
    updateNotice({ current: '12.6.1', cache: { checkedAt: 1000, latest: '12.5.0' } }) === null
  );
  check(
    'updateNotice: null cache returns null',
    updateNotice({ current: '12.6.1', cache: null }) === null
  );
  check(
    'updateNotice: cache with latest=null returns null',
    updateNotice({ current: '12.6.1', cache: { checkedAt: 1000, latest: null } }) === null
  );

  // ── 6. needsRefresh ──
  const nowFixed = 100000000;
  const HOUR_MS = 60 * 60 * 1000;
  check(
    'needsRefresh: null cache returns true',
    needsRefresh({ cache: null, now: nowFixed }) === true
  );
  check(
    'needsRefresh: 23 h old returns false',
    needsRefresh({
      cache: { checkedAt: nowFixed - 23 * HOUR_MS, latest: '12.6.1' },
      now: nowFixed,
    }) === false
  );
  check(
    'needsRefresh: 24 h old returns true',
    needsRefresh({
      cache: { checkedAt: nowFixed - 24 * HOUR_MS, latest: '12.6.1' },
      now: nowFixed,
    }) === true
  );
  check(
    'needsRefresh: 25 h old returns true',
    needsRefresh({
      cache: { checkedAt: nowFixed - 25 * HOUR_MS, latest: '12.6.1' },
      now: nowFixed,
    }) === true
  );

  // ── 7. refreshCache with fake fetchImpl ──
  const cachePath1 = path.join(tmpDir, 'cache1', 'update-check.json');

  // Success writes latest
  const now1 = 5000000;
  const fakeSuccessFetch = async () => ({
    ok: true,
    json: async () => ({ version: '12.8.0' }),
  });
  await refreshCache({ cachePath: cachePath1, now: now1, fetchImpl: fakeSuccessFetch });
  const c1 = readCache(cachePath1);
  check('refreshCache: success writes latest 12.8.0', c1 && c1.latest === '12.8.0');
  check('refreshCache: success writes checkedAt now1', c1 && c1.checkedAt === now1);

  // A fetch that rejects keeps previous latest and updates checkedAt
  const now2 = 6000000;
  const fakeRejectFetch = async () => {
    throw new Error('network down');
  };
  await refreshCache({ cachePath: cachePath1, now: now2, fetchImpl: fakeRejectFetch });
  const c2 = readCache(cachePath1);
  check('refreshCache: reject keeps previous latest 12.8.0', c2 && c2.latest === '12.8.0');
  check('refreshCache: reject updates checkedAt now2', c2 && c2.checkedAt === now2);

  // Bad version string keeps previous
  const now3 = 7000000;
  const fakeBadVersionFetch = async () => ({
    ok: true,
    json: async () => ({ version: 'bad-version' }),
  });
  await refreshCache({ cachePath: cachePath1, now: now3, fetchImpl: fakeBadVersionFetch });
  const c3 = readCache(cachePath1);
  check('refreshCache: bad version keeps previous latest 12.8.0', c3 && c3.latest === '12.8.0');
  check('refreshCache: bad version updates checkedAt now3', c3 && c3.checkedAt === now3);

  // A fetch that never resolves is aborted by timeoutMs (use timeoutMs: 50) and does not throw
  const now4 = 8000000;
  let aborted = false;
  const fakeHangingFetch = (url, opts) =>
    new Promise((resolve, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }
    });
  const startMs = Date.now();
  await refreshCache({
    cachePath: cachePath1,
    now: now4,
    fetchImpl: fakeHangingFetch,
    timeoutMs: 50,
  });
  const elapsedMs = Date.now() - startMs;
  const c4 = readCache(cachePath1);
  check('refreshCache: hanging fetch is aborted by timeoutMs', aborted === true);
  check('refreshCache: hanging fetch keeps previous latest 12.8.0', c4 && c4.latest === '12.8.0');
  check('refreshCache: hanging fetch updates checkedAt now4', c4 && c4.checkedAt === now4);
  check('refreshCache: hanging fetch completed without long delay', elapsedMs < 2000);

  // ── 8. ap.cjs integration ──
  const fakeXdg = path.join(tmpDir, 'xdg-test');
  const fakeApCache = path.join(fakeXdg, 'project-autopilot', 'update-check.json');
  fs.mkdirSync(path.dirname(fakeApCache), { recursive: true });
  fs.writeFileSync(fakeApCache, JSON.stringify({ checkedAt: Date.now(), latest: '999.0.0' }));

  const apBin = path.join(skillRoot, 'bin', 'ap.cjs');
  const apRes = spawnSync(process.execPath, [apBin, 'help'], {
    env: {
      ...process.env,
      XDG_CACHE_HOME: fakeXdg,
      NODE_ENV: 'development',
      AP_NO_UPDATE_CHECK: '',
      CI: '',
    },
    encoding: 'utf8',
  });
  check('ap.cjs help exited 0', apRes.status === 0);
  check(
    'ap.cjs non-TTY disables update notice on stderr',
    !apRes.stderr.includes('is available')
  );

  // The TTY path itself cannot be directly spawned in a test environment without
  // allocating a pseudo-terminal (pty); verified through updateNotice with the cache below.
  const core = require('./update-check-core.cjs');
  const testCache = core.readCache(fakeApCache);
  const noticeLine = core.updateNotice({ current: '12.6.1', cache: testCache });
  check(
    'updateNotice produces expected notice for 999.0.0 cache',
    noticeLine ===
      'Project Autopilot 999.0.0 is available (you have 12.6.1). Update: npm install -g project-autopilot'
  );

  // ── 9. Real ~/.cache verification ──
  const realCacheExistedAfter = fs.existsSync(realCachePath);
  const realCacheMtimeAfter = realCacheExistedAfter ? fs.statSync(realCachePath).mtimeMs : null;
  const realCacheContentAfter = realCacheExistedAfter ? fs.readFileSync(realCachePath, 'utf8') : null;

  check(
    'test did not touch real ~/.cache',
    realCacheExistedBefore === realCacheExistedAfter &&
      realCacheMtimeBefore === realCacheMtimeAfter &&
      realCacheContentBefore === realCacheContentAfter
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
