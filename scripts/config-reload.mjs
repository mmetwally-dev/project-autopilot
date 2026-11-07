// Pure diff helper and in-place reload applicator for live config reloads.

function formatValue(v, isTarget = false) {
  if (v === undefined) return isTarget ? "(removed)" : "(none)";
  if (v === null) return "null";
  if (typeof v === "object") {
    if (Array.isArray(v) && v.length === 0) return "[]";
    if (!Array.isArray(v) && Object.keys(v).length === 0) return "{}";
    return JSON.stringify(v);
  }
  return String(v);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function diffConfigPaths(oldObj, newObj, { maxLines = 20 } = {}) {
  const lines = [];

  function walk(oldVal, newVal, path) {
    if (oldVal === newVal) return;

    const oldIsArr = Array.isArray(oldVal);
    const newIsArr = Array.isArray(newVal);

    if (oldIsArr && newIsArr) {
      const maxLen = Math.max(oldVal.length, newVal.length);
      for (let i = 0; i < maxLen; i++) {
        const itemPath = `${path}[${i}]`;
        if (i >= oldVal.length) {
          if (isPlainObject(newVal[i])) {
            walk(undefined, newVal[i], itemPath);
          } else {
            lines.push(`${itemPath} (none) → ${formatValue(newVal[i], true)}`);
          }
        } else if (i >= newVal.length) {
          if (isPlainObject(oldVal[i])) {
            walk(oldVal[i], undefined, itemPath);
          } else {
            lines.push(`${itemPath} ${formatValue(oldVal[i])} → (removed)`);
          }
        } else {
          walk(oldVal[i], newVal[i], itemPath);
        }
      }
      return;
    }

    const oldIsObj = isPlainObject(oldVal);
    const newIsObj = isPlainObject(newVal);

    if (oldIsObj && newIsObj) {
      const allKeys = Array.from(new Set([...Object.keys(oldVal), ...Object.keys(newVal)]));
      allKeys.sort();
      for (const k of allKeys) {
        const subPath = path ? `${path}.${k}` : k;
        walk(oldVal[k], newVal[k], subPath);
      }
      return;
    }

    if (oldVal === undefined && newIsObj) {
      const keys = Object.keys(newVal);
      if (keys.length === 0) {
        lines.push(`${path} (none) → {}`);
      } else {
        keys.sort();
        for (const k of keys) {
          walk(undefined, newVal[k], path ? `${path}.${k}` : k);
        }
      }
      return;
    }

    if (newVal === undefined && oldIsObj) {
      const keys = Object.keys(oldVal);
      if (keys.length === 0) {
        lines.push(`${path} {} → (removed)`);
      } else {
        keys.sort();
        for (const k of keys) {
          walk(oldVal[k], undefined, path ? `${path}.${k}` : k);
        }
      }
      return;
    }

    // Leaf change
    lines.push(`${path} ${formatValue(oldVal)} → ${formatValue(newVal, true)}`);
  }

  walk(oldObj, newObj, "");

  if (lines.length > maxLines) {
    const remaining = lines.length - maxLines;
    return [...lines.slice(0, maxLines), `... and ${remaining} more`];
  }
  return lines;
}

export function applyConfigReload(c, nextConfig) {
  const diffLines = diffConfigPaths(c, nextConfig);
  for (const k of Object.keys(c)) {
    if (!Object.prototype.hasOwnProperty.call(nextConfig, k)) {
      delete c[k];
    }
  }
  Object.assign(c, nextConfig);
  return diffLines;
}
