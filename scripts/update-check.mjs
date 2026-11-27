import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const {
  compareVersions,
  updateCheckDisabled,
  defaultCachePath,
  readCache,
  updateNotice,
  needsRefresh,
} = require('./update-check-core.cjs');

async function refreshCache({
  cachePath,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
} = {}) {
  let previousLatest = null;
  try {
    const prev = readCache(cachePath);
    if (prev && typeof prev.latest === 'string') {
      previousLatest = prev.latest;
    }
  } catch {
    // ignore
  }

  let latest = previousLatest;
  let timer;

  try {
    const controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
        reject(new Error('timeout'));
      }, timeoutMs);
    });

    const fetchAndParse = async () => {
      const res = await fetchImpl('https://registry.npmjs.org/project-autopilot/latest', {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res || !res.ok) {
        throw new Error(`Fetch failed: ${res ? res.status : 'no response'}`);
      }
      return await res.json();
    };

    const data = await Promise.race([fetchAndParse(), timeoutPromise]);
    if (!data || typeof data.version !== 'string' || !/^\d+\.\d+\.\d+/.test(data.version)) {
      throw new Error(`Invalid version: ${data && data.version}`);
    }
    latest = data.version;
  } catch {
    latest = previousLatest;
  } finally {
    if (timer) clearTimeout(timer);
  }

  try {
    if (cachePath) {
      const dir = path.dirname(cachePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpFile = path.join(
        dir,
        `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
      );
      try {
        fs.writeFileSync(
          tmpFile,
          JSON.stringify({ checkedAt: now, latest }, null, 2) + '\n',
          'utf8'
        );
        fs.renameSync(tmpFile, cachePath);
      } catch (err) {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          // ignore
        }
        throw err;
      }
    }
  } catch {
    // never throw
  }
}

const isDirectRun = Boolean(
  process.argv[1] &&
  (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href ||
    (fs.existsSync(process.argv[1]) &&
      import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href))
);

if (isDirectRun) {
  try {
    const refreshIndex = process.argv.indexOf('--refresh');
    if (refreshIndex !== -1) {
      const homedir = os.homedir();
      const cachePath = process.argv[refreshIndex + 1] || defaultCachePath(process.env, homedir);
      await refreshCache({ cachePath, now: Date.now(), fetchImpl: globalThis.fetch });
    }
  } catch {
    // exit 0 always
  }
  process.exit(0);
}

export {
  compareVersions,
  updateCheckDisabled,
  defaultCachePath,
  readCache,
  updateNotice,
  needsRefresh,
  refreshCache,
};
