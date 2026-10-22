// Backlog #96(a): source-scanning tests (scripts/test-*.mjs that read a source
// file as text and match exact call/import lines) break whenever an option is
// added to a call. This pure helper lists, from a unified diff, the test files
// whose text contains a distinctive piece of a REMOVED/changed source line, so
// the implementer can run them before finishing. No I/O: caller supplies texts.

export const ANCHORED_TESTS_MAX=15;
const MIN_ANCHOR_LEN=25;
const TEST_PATH_RE=/(^|\/)(test-[^/]*|[^/]*\.test\.[^/]*)$|(^|\/)tests?\//;

export function isTestPath(p){ return TEST_PATH_RE.test(String(p||"").replace(/\\/g,"/")); }

// Distinctive anchors for one removed line (trimmed text, call prefix, head).
export function anchorsForLine(line){
  const t=String(line).trim();
  if(t.length<MIN_ANCHOR_LEN) return [];
  if(/^(\/\/|\/\*|\*|#)/.test(t)) return [];
  if(!/[A-Za-z0-9_$]{3}/.test(t)) return [];
  const out=[t];
  const paren=t.indexOf("(");
  if(paren>0){
    const prefix=t.slice(0,paren+1);
    if(prefix.length>=MIN_ANCHOR_LEN) out.push(prefix);
  }
  if(t.length>40) out.push(t.slice(0,40));
  return [...new Set(out)];
}

const unescapeRegex=s=>s.replace(/\\([(){}.\[\]$^*+?|\\\/])/g,"$1");

// Removed lines from non-test files of a unified diff.
export function removedSourceLines(diffText){
  const res=[];
  let skip=false;
  for(const l of String(diffText||"").split(/\r?\n/)){
    if(l.startsWith("diff --git ")){
      const m=/ b\/(.+)$/.exec(l);
      skip=m?isTestPath(m[1]):false;
      continue;
    }
    if(l.startsWith("+++ ")){
      const p=l.slice(4).replace(/^b\//,"");
      if(p!=="/dev/null") skip=isTestPath(p);
      continue;
    }
    if(l.startsWith("--- ")||skip) continue;
    if(l.startsWith("-")) res.push(l.slice(1));
  }
  return res;
}

export function findAnchoredTests({diffText,testFiles,max=ANCHORED_TESTS_MAX}={}){
  const removed=removedSourceLines(diffText);
  if(!removed.length||!Array.isArray(testFiles)) return [];
  const anchors=[...new Set(removed.flatMap(anchorsForLine))];
  if(!anchors.length) return [];
  const found=[];
  for(const tf of testFiles){
    if(!tf||typeof tf.text!=="string") continue;
    const unesc=unescapeRegex(tf.text);
    const hits=anchors.filter(a=>tf.text.includes(a)||unesc.includes(a));
    if(hits.length) found.push({test:tf.path,lines:hits});
  }
  found.sort((a,b)=>b.lines.length-a.lines.length||String(a.test).localeCompare(String(b.test)));
  return found.slice(0,Math.max(0,max));
}

export function formatAnchoredTestsSection(found){
  if(!Array.isArray(found)||!found.length) return "";
  return `Tests that anchor on text you changed — run each and keep it passing before finishing: ${found.map(f=>`node ${f.test}`).join("; ")}`;
}
