import {spawn, spawnSync} from 'node:child_process';
import {spawnAgent, spawnAgentSync} from './agent-process.mjs';
import {adapterDriver} from './adapter-drivers.mjs';
import {resolveAdapterTransport} from './adapter-transport.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  isOpenCodeAdapter,
  openCodeHelpArgs,
  cachedOpenCodeGeneration,
  rememberOpenCodeGeneration
} from './opencode-generation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCUMENTED_MODELS_DIR = path.join(__dirname, '..', 'adapters', 'documented-models');
const DOCUMENTED_EFFORT_DIR = path.join(__dirname, '..', 'adapters', 'documented-effort');

// Short probe limit for --help/--version capability detection. Model-list
// discovery is a different, slower call (a real `opencode models --verbose`
// can take >10 s on a busy machine and print thousands of lines), so it gets
// its own, more realistic limit below.
export const DISCOVERY_TIMEOUT_MS = 10_000;
export const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;

// Tests (and operators with unusually slow providers) can override the
// model-list limit. Read at call time so tests can set it after importing
// this module.
export function modelDiscoveryTimeoutMs(){
  const raw = Number(process.env.AP_MODEL_DISCOVERY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MODEL_DISCOVERY_TIMEOUT_MS;
}

export function modelDiscoveryTimeoutLabel(ms = modelDiscoveryTimeoutMs()){
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

// Backlog #5: a cold first start (opencode rebuilding its data for a new
// project) can exceed the normal model-list budget even though the CLI is
// working. Setup/config retry that timed-out probe ONCE with twice the
// effective budget; the env override still scales both attempts.
export function modelDiscoveryRetryTimeoutMs(){
  return modelDiscoveryTimeoutMs() * 2;
}

function cleanLines(text){
  return String(text||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
}
function unique(items){ return [...new Set(items)]; }

export function normalizeReasoning(items){
  if(!Array.isArray(items)) return [];
  return items
    .map(r => typeof r === 'string' ? r : (r?.level || r?.name || r?.effort || null))
    .filter(r => typeof r === 'string' && r.length > 0);
}

// Backlog #1(b): an operator types or picks a model id with the wrong case
// (or a provider's display casing) — setup must persist the CLI's canonical
// live id, never the display name or a case variant. Matches the given model
// against the catalog's ids and per-effort ids case-insensitively; returns
// the first canonical id, or the input unchanged when the catalog has no
// case-insensitive match (an unknown/modeless value is not invented).
export function canonicalModelId(model, catalog){
  if(!model || !Array.isArray(catalog)) return model;
  const wanted=String(model).toLowerCase();
  for(const item of catalog){
    if(item && typeof item.id === 'string' && item.id.toLowerCase()===wanted) return item.id;
  }
  for(const item of catalog){
    if(!item || !item.effortModelIds) continue;
    for(const value of Object.values(item.effortModelIds)){
      if(typeof value === 'string' && value.toLowerCase()===wanted) return value;
    }
  }
  return model;
}

function remaining(deadline){
  return Math.max(0, deadline - Date.now());
}

function killTree(child){
  if(!child || !child.pid) return;
  if(process.platform === 'win32'){
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio:'ignore'}); } catch {}
  } else {
    try { child.kill('SIGTERM'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  }
  try { child.stdin?.destroy(); } catch {}
  try { child.stdout?.destroy(); } catch {}
  try { child.stderr?.destroy(); } catch {}
}

function spawnWithDeadline(binary, args, opts, deadline){
  const ms = remaining(deadline);
  if(ms <= 0) return Promise.resolve({status:null, stdout:'', stderr:'', signal:'TIMEOUT', timedOut:true});
  return new Promise(resolve => {
    const child = spawnAgent(binary, args, opts);
    let done = false;
    const timer = setTimeout(() => {
      if(done) return;
      done = true;
      killTree(child);
      resolve({status: null, stdout: '', stderr: '', signal: 'TIMEOUT', timedOut: true});
    }, ms);
    let stdout = '';
    let stderr = '';
    const onStdout = d => { stdout += String(d); };
    const onStderr = d => { stderr += String(d); };
    if(child.stdout) child.stdout.on('data', onStdout);
    if(child.stderr) child.stderr.on('data', onStderr);
    const finish = (code, signal) => {
      if(done) return;
      done = true;
      clearTimeout(timer);
      if(child.stdout) child.stdout.removeListener('data', onStdout);
      if(child.stderr) child.stderr.removeListener('data', onStderr);
      resolve({status: code, stdout, stderr, signal, timedOut: false});
    };
    child.on('error', () => finish(null, null));
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

function newDeadline(ms = DISCOVERY_TIMEOUT_MS){
  return Date.now() + ms;
}

async function collectHelpText(meta, deadline){
  const attempts = [[meta.binary, ['--help']]];
  // Never launch the bare CLI (empty args): interactive CLIs (agy, codex)
  // start a TUI that queries/reconfigures the user's controlling terminal via
  // /dev/tty even with stdin ignored, leaving the TTY in raw mode.
  if (Array.isArray(meta.help_args) && meta.help_args.length) attempts.push([meta.binary, meta.help_args]);
  if (meta.help_subcommands) {
    // Must be a 2-element [binary, args[]] tuple matching the other
    // entries above — the consuming loop below destructures exactly two
    // elements, so a 3-element push here silently drops '--help' and
    // leaves `args` as the bare subcommand string, which then fails the
    // Array.isArray(args) check and is skipped without ever running.
    for (const sub of meta.help_subcommands) attempts.push([meta.binary, [sub, '--help']]);
  }
  const chunks=[];
  for (const [bin,args] of attempts){
    if(!Array.isArray(args)) continue;
    if(remaining(deadline) <= 0) break;
    const r = await spawnWithDeadline(bin, args, {encoding:'utf8',stdio:['ignore','pipe','pipe']}, deadline);
    if(r.status===0 || r.stdout || r.stderr) chunks.push(String(r.stdout||'')+'\n'+String(r.stderr||''));
  }
  return chunks.join('\n');
}

function flagFromHelp(text, aliases){
  const tokens=String(text||'').split(/\s+/).map(t=>t.replace(/^[\[({]+/,'').replace(/[,:;.)\]}]+$/,''));
  return aliases.find(flag => tokens.some(token => token===flag || token.startsWith(flag+'='))) || null;
}

/**
 * Discover command-line capabilities from the installed CLI itself.
 * This complements the static adapter contract; it never invents support.
 */
export async function discoverCapabilities(meta, deadline){
  if(!deadline) deadline = newDeadline();
  const help=await collectHelpText(meta, deadline);
  const openCodeGeneration = isOpenCodeAdapter(meta)
    ? rememberOpenCodeGeneration(meta, help)
    : null;
  // OpenCode 2.x has no reasoning/effort flag: the level is a model suffix.
  // Its help names --model's value as "provider/model#variant" instead.
  const openCodeModelSuffix = openCodeGeneration === "2";
  const modelFlag = flagFromHelp(help, ['--model','-m']);
  // Try the adapter's OWN declared effort_flag first (e.g. OpenCode's is
  // "--variant" — its reasoning/effort levels ARE its model variants, there
  // is no separate "--effort" flag), then the two generic literal names as
  // a fallback for adapters that don't declare one.
  const effortFlag = openCodeModelSuffix
    ? null
    : meta.effort_mode === 'config'
      ? flagFromHelp(help, ['--config'])
      : flagFromHelp(help, [meta.effort_flag, '--effort', '--reasoning-effort'].filter(Boolean));
  const variantFlagRaw = flagFromHelp(help, ['--variant']);
  // If the flag just detected for "variant" is the exact same literal flag
  // already claimed by "effort" above (OpenCode's case once help text from
  // its `run` subcommand is included), it is not a SEPARATE variant
  // capability — it is the same CLI flag serving effort's purpose. Every
  // adapter currently declares variant_flag: null for exactly this reason;
  // without this guard the wizard would offer two conflicting prompts
  // (effort and variant) for one underlying flag.
  const variantFlag = (variantFlagRaw && variantFlagRaw === effortFlag) ? null : variantFlagRaw;
  // "resume" here means EXACT-session resume (resume_session: --resume/--session
  // by captured id) — the only resume mechanism the relay path ever issues.
  // resume_last ("--continue"/"resume --last") is deliberately excluded: it
  // resumes whatever the CLI considers its own most-recent session in this
  // cwd, not necessarily this role's, and the relay never invokes it.
  const resumeSupported = !!(meta.resume_session?.length) && meta.resume_session.every(arg => {
    const flag = String(arg).replace(/^.*?--/, "--");
    return help.includes(flag);
  });
  const capabilities = {
    model: !!modelFlag,
    model_flag: modelFlag,
    effort: openCodeModelSuffix ? !!modelFlag : !!effortFlag,
    effort_flag: effortFlag,
    variant: openCodeModelSuffix ? false : !!variantFlag,
    variant_flag: openCodeModelSuffix ? null : variantFlag,
    resume: resumeSupported,
    discovery: meta.model_discovery || 'manual'
  };
  if (isOpenCodeAdapter(meta)) {
    capabilities.opencode_generation = openCodeGeneration;
    if (openCodeModelSuffix) {
      capabilities.effort_mode = 'model_suffix';
      capabilities.standalone = true;
    } else {
      capabilities.standalone = false;
    }
  }
  return capabilities;
}

export async function discoverAdapter(meta){
  const capabilities=await discoverCapabilities(meta);
  const models=await discoverModelCatalog(meta);
  return {
    binary: meta.binary,
    capabilities,
    models
  };
}

function jsonLines(text){
  return cleanLines(text).flatMap(line=>{
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function parseJsonc(text){
  try{
    const stripped=String(text||'')
      .replace(/\/\*[\s\S]*?\*\//g,'')
      .replace(/(^|\s)\/\/.*$/gm,'$1')
      .replace(/,\s*([}\]])/g,'$1');
    return JSON.parse(stripped);
  }catch{return null;}
}

function opencodeConfigCandidates(){
  const home=process.env.HOME || process.env.USERPROFILE || '';
  const appdata=process.env.APPDATA || '';
  const candidates=[];
  if(home){ candidates.push(path.join(home,'.config','opencode','opencode.json'),path.join(home,'.config','opencode','opencode.jsonc')); }
  if(appdata){ candidates.push(path.join(appdata,'opencode','opencode.json'),path.join(appdata,'opencode','opencode.jsonc')); }
  candidates.push(path.join(process.cwd(),'opencode.json'),path.join(process.cwd(),'opencode.jsonc'));
  return [...new Set(candidates)];
}

function discoverOpenCodeVariants(modelId){
  const split=modelId.indexOf('/');
  if(split<1) return [];
  const providerId=modelId.slice(0,split);
  const providerModelId=modelId.slice(split+1);
  for(const file of opencodeConfigCandidates()){
    if(!fs.existsSync(file)) continue;
    const cfg=parseJsonc(fs.readFileSync(file,'utf8'));
    if(!cfg) continue;
    const providers=cfg.provider || cfg.providers || {};
    const provider=providers[providerId];
    const model=provider?.models?.[providerModelId];
    const variants=model?.variants;
    if(Array.isArray(variants)) return variants.map(v=>typeof v==='string'?v:v?.id).filter(Boolean);
    if(variants && typeof variants==='object') return Object.keys(variants);
  }
  return [];
}

export function parseOpenCodeVerboseOutput(text){
  const lines=String(text||'').split(/\r?\n/);
  const out=[];
  const modelLine=/^([A-Za-z0-9._-]+\/[A-Za-z0-9._:@+-]+)\s*$/;
  let current=null;
  let jsonLines=[];
  const flush=()=>{
    if(!current) return;
    const block=jsonLines.join('\n').trim();
    let meta=null;
    if(block){
      try{meta=JSON.parse(block);}catch{}
    }
    const variants = meta?.variants
      ? (Array.isArray(meta.variants)
          ? meta.variants.map(v=>typeof v==='string'?v:v?.id).filter(Boolean)
          : Object.entries(meta.variants).filter(([,v])=>!(v&&v.disabled===true)).map(([id])=>id))
      : [];
    const reasoning = normalizeReasoning(meta?.supportedReasoningEfforts || meta?.supported_reasoning_efforts || []);
    out.push({id:current,label:meta?.name||current,reasoning,variants});
    current=null;
    jsonLines=[];
  };
  for(const line of lines){
    const m=line.match(modelLine);
    if(m){flush(); current=m[1]; continue;}
    if(current) jsonLines.push(line);
  }
  flush();
  return out;
}

// OpenCode 2.x's machine-readable catalog: `api GET /api/model` returns
// {location, data:[{providerID,id,name,variants:[{id,settings}],status,enabled}]}.
// The per-model variant ids are the reasoning/effort levels (the same
// dimension 1.x reports through `models --verbose`). A disabled or
// non-active entry is not selectable, mirroring the usable-only 1.x list.
export function parseOpenCodeApiModels(text){
  let parsed;
  try{ parsed=JSON.parse(String(text||'').trim()); }catch{ return []; }
  const data=Array.isArray(parsed) ? parsed : parsed?.data;
  if(!Array.isArray(data)) return [];
  const out=[];
  const seen=new Set();
  for(const model of data){
    if(!model || typeof model!=='object') continue;
    const provider=typeof model.providerID==='string' ? model.providerID : '';
    const modelId=typeof model.id==='string' ? model.id : (typeof model.modelID==='string' ? model.modelID : '');
    if(!provider || !modelId) continue;
    if(model.enabled === false) continue;
    if(typeof model.status === 'string' && model.status !== 'active') continue;
    const id=`${provider}/${modelId}`;
    if(seen.has(id)) continue;
    seen.add(id);
    const variants=Array.isArray(model.variants)
      ? model.variants.map(v=>typeof v==='string' ? v : v?.id).filter(Boolean)
      : [];
    out.push({id,label:model.name||model.modelID||modelId,reasoning:variants,variants});
  }
  return out;
}

async function resolveOpenCodeGeneration(meta, deadline){
  const cached=cachedOpenCodeGeneration(meta);
  if(cached !== undefined) return {generation:cached, timedOut:false};
  const r=await spawnWithDeadline(meta.binary,openCodeHelpArgs(meta),{encoding:'utf8',stdio:['ignore','pipe','pipe']}, deadline);
  if(r.timedOut) return {generation:null, timedOut:true};
  return {generation:rememberOpenCodeGeneration(meta, `${r.stdout||''}\n${r.stderr||''}`), timedOut:false};
}

async function discoverFromOpenCode(meta, deadline){
  if(!deadline) deadline = newDeadline(modelDiscoveryTimeoutMs());
  const generation=await resolveOpenCodeGeneration(meta, deadline);
  if(generation.timedOut) return {items:[], status:'timeout'};
  let timedOut=false;
  if(generation.generation === '2'){
    let r=await spawnWithDeadline(meta.binary,['api','GET','/api/model'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}, deadline);
    if(r.timedOut) timedOut=true;
    if(r.status===0 && r.stdout){
      const items=parseOpenCodeApiModels(r.stdout);
      if(items.length) return {items, status:'reported'};
    }
    if(remaining(deadline) <= 0) return {items:[], status:timedOut ? 'timeout' : 'unsupported'};
    // 2.x `models --verbose` no longer exists; the plain list still gives
    // ids, so it remains the last-resort fallback (levels unavailable).
    r=await spawnWithDeadline(meta.binary,['models'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}, deadline);
    if(r.timedOut) timedOut=true;
    if(r.status!==0 || !r.stdout) return {items:[], status:timedOut ? 'timeout' : 'unsupported'};
    const items=unique(cleanLines(r.stdout)
      .filter(line=>/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@+-]+(?:\s|$)/.test(line))
      .map(line=>line.split(/\s+/)[0]))
      .map(id=>({id,label:id,reasoning:[],variants:discoverOpenCodeVariants(id)}));
    return {items, status:items.length ? 'reported' : 'unsupported'};
  }
  let r=await spawnWithDeadline(meta.binary,['models','--verbose'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}, deadline);
  if(r.timedOut) timedOut=true;
  if(r.status===0 && r.stdout){
    const verbose=parseOpenCodeVerboseOutput(r.stdout);
    if(verbose.length) return {items:verbose, status:'reported'};
  }
  if(remaining(deadline) <= 0) return {items:[], status:timedOut ? 'timeout' : 'unsupported'};
  r=await spawnWithDeadline(meta.binary,['models'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}, deadline);
  if(r.timedOut) timedOut=true;
  if(r.status!==0 || !r.stdout) return {items:[], status:timedOut ? 'timeout' : 'unsupported'};
  const items=unique(cleanLines(r.stdout)
    .filter(line=>/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@+-]+(?:\s|$)/.test(line))
    .map(line=>line.split(/\s+/)[0]))
    .map(id=>({id,label:id,reasoning:[],variants:discoverOpenCodeVariants(id)}));
  return {items, status:items.length ? 'reported' : 'unsupported'};
}


export function parseAntigravityModels(text){
  return parseAntigravityOutput(text);
}

async function discoverAntigravityModels(binary, deadline){
  if(!deadline) deadline = newDeadline(modelDiscoveryTimeoutMs());
  const transport=resolveAdapterTransport({driver:adapterDriver('antigravity'),request:{binary,args:['models']}});
  if(!transport.available) return {items:[], status:'unsupported'};
  const r=await spawnWithDeadline(transport.invocation.binary,transport.invocation.args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}, deadline);
  if(r.timedOut) return {items:[], status:'timeout'};
  if(r.status!==0 || !r.stdout) return {items:[], status:'unsupported'};
  const items=parseAntigravityOutput(r.stdout);
  return {items, status:items.length ? 'reported' : 'unsupported'};
}

function parseAntigravityOutput(text){
  const grouped=new Map();
  for(const line of cleanLines(text)){
    const m=line.match(/^([A-Za-z0-9._-]+)\s+(.*)$/);
    if(!m) continue;
    const id=m[1];
    const label=m[2].trim();
    const effortMatch=id.match(/^(.*)-(low|medium|high)$/i);
    if(effortMatch){
      const baseId=effortMatch[1];
      const effort=effortMatch[2].toLowerCase();
      if(!grouped.has(baseId)){
        grouped.set(baseId,{id:baseId,label:label.replace(/\s*\((?:Low|Medium|High)\)\s*$/i,'').trim()||baseId,reasoning:[],variants:[],effortModelIds:{}});
      }
      const item=grouped.get(baseId);
      if(!item.reasoning.includes(effort)) item.reasoning.push(effort);
      item.effortModelIds[effort]=id;
    }else{
      grouped.set(id,{id,label,reasoning:[],variants:[],effortModelIds:{}});
    }
  }
  return [...grouped.values()].map(item=>({
    ...item,
    reasoning:item.reasoning.sort((a,b)=>['low','medium','high'].indexOf(a)-['low','medium','high'].indexOf(b))
  }));
}

async function discoverFromCursor(binary, deadline){
  if(!deadline) deadline = newDeadline(modelDiscoveryTimeoutMs());
  let timedOut=false;
  let r=await spawnWithDeadline(binary,['models'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}, deadline);
  if(r.timedOut) timedOut=true;
  if(r.status!==0 && remaining(deadline) > 0){
    r=await spawnWithDeadline(binary,['--list-models'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}, deadline);
    if(r.timedOut) timedOut=true;
  }
  if(r.status!==0 || !r.stdout) return {items:[], status:timedOut ? 'timeout' : 'unsupported'};
  const items=unique(cleanLines(r.stdout)
    .filter(line=>!/^(available|models|model|name|id|usage|help|press|cursor agent|available models|model list)\b/i.test(line))
    .map(line=>line.replace(/^[-*•]\s*/,'').split(/\s{2,}|\t/)[0].trim())
    .filter(line=>line && line.length<160));
  return {items, status:items.length ? 'reported' : 'unsupported'};
}

function normalizeCodexModels(result){
  const data = result?.result?.data || result?.result?.models || result?.data || result?.models || [];
  if(!Array.isArray(data)) return [];
  return data.map(m=>({
    id: m.slug || m.id || m.model || m.name,
    label: m.displayName || m.name || m.slug || m.id || m.model,
    reasoning: normalizeReasoning(m.supportedReasoningEfforts || m.supported_reasoning_efforts)
  })).filter(m=>m.id);
}

function discoverFromCodexAppServer(binary, deadline){
  if(!deadline) deadline = newDeadline(modelDiscoveryTimeoutMs());
  return new Promise(resolve => {
    const child = spawnAgent(binary,['app-server','--stdio'],{encoding:'utf8',stdio:['pipe','pipe','ignore']});
    let done = false;
    const timer = setTimeout(() => {
      if(done) return;
      done = true;
      killTree(child);
      resolve({items:[], status:'timeout'});
    }, remaining(deadline));
    const finish = (result) => {
      if(done) return;
      done = true;
      clearTimeout(timer);
      killTree(child);
      resolve(result);
    };
    child.stdin.on('error',()=>{});
    let buffer=''; const replies=[];
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString();
      let idx;
      while((idx=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,idx); buffer=buffer.slice(idx+1);
        try{ const msg=JSON.parse(line); replies.push(msg); }catch{}
      }
      const modelReply=replies.find(x=>x?.id===2 && x?.result);
      if(modelReply){
        const items=normalizeCodexModels(modelReply);
        finish({items, status:items.length ? 'reported' : 'unsupported'});
      }
    });
    child.on('error',()=>finish({items:[], status:'error'}));
    child.on('exit',()=>{ if(!replies.find(x=>x?.id===2)) finish({items:[], status:'unsupported'}); });
    try{
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'project-autopilot',version:'10.2.0'}}})+'\n');
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}})+'\n');
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'model/list',params:{includeHidden:false}})+'\n');
    }catch{ finish({items:[], status:'unsupported'}); }
  });
}

/**
 * Returns models explicitly exposed by the user's installed CLI/provider.
 * Empty means no supported machine-readable discovery is available.
 * Autopilot never invents a catalog.
 * The return value is Promise<array|string> because Codex discovery is async.
 * The array carries a non-enumerable `status` side field
 * ("reported"|"timeout"|"unsupported"|"error") so callers can tell a slow
 * model list from a CLI that genuinely has no machine-readable one.
 */
function catalogStatus(items, status){
  Object.defineProperty(items, 'status', {value:status, enumerable:false, configurable:true});
  return items;
}

export async function discoverModelCatalog(meta, {timeoutMs = modelDiscoveryTimeoutMs()} = {}){
  const binary=meta.binary; const kind=meta.model_discovery;
  const deadline = newDeadline(timeoutMs);
  try{
    let result;
    if(kind==='opencode_models') result=await discoverFromOpenCode(meta, deadline);
    else if(kind==='cursor_models'){
      const cursor=await discoverFromCursor(binary, deadline);
      result={items:cursor.items.map(id=>({id,label:id,reasoning:[],variants:[]})), status:cursor.status};
    }
    else if(kind==='codex_app_server') result=await discoverFromCodexAppServer(binary, deadline);
    else if(kind==='antigravity_models') result=await discoverAntigravityModels(binary, deadline);
    else result={items:[], status:'unsupported'};
    return catalogStatus(result.items, result.status);
  }catch{ return catalogStatus([], 'error'); }
}

export async function discoverModels(meta){
  const catalog=await discoverModelCatalog(meta);
  return catalog.map(x=>x.id).filter(Boolean);
}

/**
 * Loads a static, dated, sourced snapshot of an adapter's documented models
 * from adapters/documented-models/<adapterId>.json, if one ships for that
 * adapter. This is NOT live discovery and NOT a catalog Autopilot invented:
 * every entry traces to an official docs URL captured at a known date.
 * Used only as a second-tier fallback when discoverModelCatalog() returns
 * nothing (no supported machine-readable discovery for that CLI) — callers
 * must still label it as unverified/non-live and offer a manual-entry
 * escape hatch, never present it as equivalent to a live catalog.
 * Returns null when no snapshot ships for the adapter or the file is
 * malformed/incomplete (missing source, last_verified, or models).
 */
export function loadDocumentedCatalog(adapterId){
  try{
    const file=path.join(DOCUMENTED_MODELS_DIR, `${adapterId}.json`);
    if(!fs.existsSync(file)) return null;
    const raw=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!raw || typeof raw.source!=='string' || !/^https?:\/\//.test(raw.source)) return null;
    if(typeof raw.last_verified!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.last_verified)) return null;
    if(!Array.isArray(raw.models) || !raw.models.length) return null;
    if(!raw.models.every(m=>m && m.id && m.label)) return null;
    return raw;
  }catch{ return null; }
}

/**
 * Loads a static, dated, sourced snapshot of an adapter's documented
 * reasoning/effort levels from adapters/documented-effort/<adapterId>.json,
 * if one ships for that adapter.
 *
 * Distinct from loadDocumentedCatalog() above: that one is a second-tier
 * fallback used only when LIVE model discovery fails entirely. This one is
 * for the opposite situation — live discovery for the adapter SUCCEEDED (a
 * real model list came back from the CLI itself), but the specific model's
 * own entry did not report supportedReasoningEfforts, so there is nothing to
 * build a reasoning menu from. Every entry here still traces to an official
 * docs URL captured at a known date, and callers must still label it as
 * unverified/non-live for this specific model, exactly like the model
 * fallback above.
 * Returns null when no snapshot ships for the adapter or the file is
 * malformed/incomplete (missing source, last_verified, or levels).
 */
// `dir` is for tests only (malformed fixtures go to a temp dir, never into
// the shipped catalog, which is read-only inside an execution envelope).
export function loadDocumentedEffort(adapterId, {dir=DOCUMENTED_EFFORT_DIR}={}){
  try{
    const file=path.join(dir, `${adapterId}.json`);
    if(!fs.existsSync(file)) return null;
    const raw=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!raw || typeof raw.source!=='string' || !/^https?:\/\//.test(raw.source)) return null;
    if(typeof raw.last_verified!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.last_verified)) return null;
    if(!Array.isArray(raw.levels) || !raw.levels.length) return null;
    if(!raw.levels.every(level=>typeof level==='string' && level)) return null;
    return raw;
  }catch{ return null; }
}
