import path from "node:path";

export function eventReferencesPath(text, candidate, root = null) {
  if (!text || !candidate) return false;
  const windowsStyle = usesWindowsPaths(candidate, root);
  const searchable = normalizedEventText(text, windowsStyle);
  if (pathVariants(candidate, root).some(variant => searchable.includes(normalizedEventText(variant, windowsStyle)))) return true;
  return quotedEventPaths(text).some(observed => equivalentEventPath(observed, candidate, root));
}

export function equivalentEventPath(left, right, root = null) {
  if (!left || !right) return false;
  const windowsStyle = usesWindowsPaths(left, right, root);
  return canonicalPath(left, root, windowsStyle) === canonicalPath(right, root, windowsStyle);
}

function pathVariants(candidate, root) {
  const windowsStyle = usesWindowsPaths(candidate, root);
  const pathApi = windowsStyle ? path.win32 : path.posix;
  const raw = stripWrappingQuotes(String(candidate));
  const variants = new Set([raw, pathApi.normalize(raw), canonicalPath(raw, root, windowsStyle)]);
  if (root) {
    const resolvedRoot = canonicalPath(root, null, windowsStyle);
    const resolvedCandidate = canonicalPath(raw, root, windowsStyle);
    const relative = pathApi.relative(resolvedRoot, resolvedCandidate);
    if (relative && !relative.startsWith("..") && !pathApi.isAbsolute(relative)) {
      variants.add(relative);
      variants.add(`.${pathApi.sep}${relative}`);
    }
  }
  return [...variants].filter(variant => normalizedEventText(variant, windowsStyle).length >= 3);
}

function canonicalPath(candidate, root, windowsStyle) {
  const pathApi = windowsStyle ? path.win32 : path.posix;
  const raw = stripWrappingQuotes(String(candidate)).normalize("NFC");
  const resolved = pathApi.isAbsolute(raw) ? pathApi.normalize(raw) : root ? pathApi.resolve(root, raw) : pathApi.normalize(raw);
  const normalized = resolved.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return windowsStyle ? normalized.toLowerCase() : normalized;
}

function normalizedEventText(candidate, windowsStyle) {
  const normalized = String(candidate)
    .normalize("NFC")
    .replace(/\\{2,}/g, "\\")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  return windowsStyle ? normalized.toLowerCase() : normalized;
}

function quotedEventPaths(text) {
  const decoded = normalizedEventText(text, false);
  const candidates = [];
  for (const pattern of [/'([^'\r\n]+)'/g, /"([^"\r\n]+)"/g]) {
    let match;
    while ((match = pattern.exec(decoded))) {
      const candidate = match[1].trim();
      if (/^(?:[a-z]:[\\/]|[\\/]{2}|\.{1,2}[\\/])/i.test(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

function usesWindowsPaths(...candidates) {
  return candidates.filter(Boolean).some(candidate => /^[a-z]:[\\/]|^[\\/]{2}/i.test(stripWrappingQuotes(String(candidate))));
}

function stripWrappingQuotes(candidate) {
  return candidate.replace(/^["']|["']$/g, "");
}
