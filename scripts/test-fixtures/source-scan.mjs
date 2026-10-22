// Helpers for source-scanning tests: tolerant to extra options, option order,
// and extra import names. Pure string functions (no I/O).

// If a string literal / comment starts at src[i], return the index of its last
// char; otherwise -1. ' and " literals must close on the same line (so an
// apostrophe in a regex or odd text never swallows code); ` may span lines.
export function skipLiteral(src, i) {
  const ch = src[i];
  if (ch === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); return e === -1 ? src.length - 1 : e - 1; }
  if (ch === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); return e === -1 ? src.length - 1 : e + 1; }
  if (ch !== "'" && ch !== '"' && ch !== "`") return -1;
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === ch) return j;
    if (src[j] === "\n" && ch !== "`") return -1;
  }
  return -1;
}

// Index of the char closing the bracket opened at `openIdx` (one of ( { [),
// skipping '...', "...", `...` literals. -1 if unbalanced.
export function matchClose(src, openIdx) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const stack = [pairs[src[openIdx]]];
  if (!stack[0]) return -1;
  for (let i = openIdx + 1; i < src.length; i++) {
    const ch = src[i];
    const lit = skipLiteral(src, i);
    if (lit !== -1) { i = lit; continue; }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i; }
  }
  return -1;
}

// Argument text (between the call parens) of every call starting with
// `anchor` (e.g. 'relayAsync("plan_reviewer",'). The anchor's own text is
// included in the returned string.
export function callArgs(src, anchor) {
  const out = [];
  const open = anchor.indexOf("(");
  for (let at = src.indexOf(anchor); at !== -1; at = src.indexOf(anchor, at + 1)) {
    // Declarations (`function name(` / `async function name(`) are not call sites,
    // unless the anchor itself starts with "function".
    if (!anchor.startsWith("function") && src.slice(Math.max(0, at - 9), at) === "function ") continue;
    const openIdx = at + open;
    const end = matchClose(src, openIdx);
    if (end !== -1) out.push(src.slice(at, end + 1));
  }
  return out;
}

// Text of the options object ({...}, balanced) of a call: the last top-level
// `{` argument. Returns "" when the call has no object literal argument.
export function callOptions(callText) {
  const open = callText.indexOf("(");
  let depth = 0, last = "";
  for (let i = open + 1; i < callText.length - 1; i++) {
    const ch = callText[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      for (i++; i < callText.length && callText[i] !== ch; i++) if (callText[i] === "\\") i++;
      continue;
    }
    if (ch === "{" && depth === 0) {
      const end = matchClose(callText, i);
      if (end === -1) break;
      last = callText.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
  }
  return last;
}

// Every call to `anchor` whose options object contains every string in
// `required` (as substrings).
export function callsWithOptions(src, anchor, required) {
  return callArgs(src, anchor).filter((call) => {
    const opts = callOptions(call);
    return opts && required.every((r) => opts.includes(r));
  });
}

// Names imported from module specifier `from` by `import {...} from "<from>"`
// (aliases reported by their imported name). Aggregated over all matching imports.
export function importNames(src, from) {
  const names = [];
  const esc = from.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${esc}["']`, "g");
  for (const m of src.matchAll(re)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (n) names.push(n);
    }
  }
  return names;
}

// Body text (braces included) of the function/block whose header starts with
// `anchor`: the first `{` after the anchor, balanced. "" when not found.
export function bodyAfter(src, anchor, from = 0) {
  const at = src.indexOf(anchor, from);
  if (at === -1) return "";
  const open = src.indexOf("{", at + anchor.length - (anchor.endsWith("{") ? 1 : 0));
  if (open === -1) return "";
  const end = matchClose(src, open);
  return end === -1 ? "" : src.slice(open, end + 1);
}

// Top-level keys of an options-object text `{a:1,b,c=2,...}` (shorthand,
// `key:value` and `key=default` forms; spreads are reported as "...x").
export function optionKeys(optsText) {
  const inner = optsText.replace(/^\s*\{/, "").replace(/\}\s*$/, "");
  const parts = [];
  let depth = 0, cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      for (; j < inner.length && inner[j] !== ch; j++) if (inner[j] === "\\") j++;
      cur += inner.slice(i, j + 1); i = j; continue;
    }
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean).map((p) => p.startsWith("...") ? p : p.split(/[:=]/)[0].trim());
}

// Body (braces included) of the function declared as `<anchor>...(params){body}`,
// e.g. functionBody(src, "function runRelay("): skips the parameter list (which
// may itself contain `{}` destructuring/defaults) before taking the body block.
export function functionBody(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return "";
  const pOpen = src.indexOf("(", at + anchor.lastIndexOf("(") );
  const pEnd = pOpen === -1 ? -1 : matchClose(src, pOpen);
  if (pEnd === -1) return "";
  const open = src.indexOf("{", pEnd);
  if (open === -1) return "";
  const end = matchClose(src, open);
  return end === -1 ? "" : src.slice(open, end + 1);
}

// {start,end} (end exclusive, braces included) of the innermost `{...}` block
// that contains index `idx`; null when idx is at top level.
export function enclosingBlock(src, idx) {
  const stack = [];
  const pairs = { "(": ")", "{": "}", "[": "]" };
  let found = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const lit = skipLiteral(src, i);
    if (lit !== -1) { i = lit; continue; }
    if (pairs[ch]) stack.push({ ch, i });
    else if (ch === ")" || ch === "}" || ch === "]") {
      const top = stack.pop();
      if (top && top.ch === "{" && top.i < idx && i >= idx) found = { start: top.i, end: i + 1 }; // keep widening? innermost closes first
      if (top && top.ch === "{" && top.i < idx && i >= idx) return found;
    }
  }
  return found;
}
