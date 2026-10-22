#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {spawnAgentSync} from "./agent-process.mjs";
import {adapterDriver} from "./adapter-drivers.mjs";
import {resolveAdapterTransport} from "./adapter-transport.mjs";
import {loadDocumentedCatalog} from "./model-discovery.mjs";
import {fileURLToPath} from "node:url";
import {loadAndMigrateConfig} from "./config-migration.mjs";
const skillRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const a=process.argv,i=a.indexOf("--repo"),repo=path.resolve(i>=0?(a[i+1]||"."):process.cwd());
const agents=JSON.parse(fs.readFileSync(path.join(skillRoot,"adapters","agents.json"),"utf8")).adapters;
const has=p=>fs.existsSync(path.join(repo,p));
const probe=id=>{
  const t=resolveAdapterTransport({driver:adapterDriver(id),profile:agents[id]?.provider_egress?.default_profile||null,request:{binary:agents[id].binary,args:[...(agents[id].probe||["--version"])]}});
  if(!t.available) return false;
  return spawnAgentSync(t.invocation.binary,t.invocation.args,{cwd:repo,stdio:"ignore"}).status===0;
};
console.log(`Project Autopilot doctor\nRepo: ${repo}\n`);
console.log("Planning:");
console.log(`${has(".specify/workflows/speckit/workflow.yml")?"✓":"·"} SpecKit`);
console.log(`${has(".planning/ROADMAP.md")&&has(".planning/STATE.md")?"✓":"·"} GSD`);
console.log("\nAgents:");
for(const id of Object.keys(agents)){
  const ok=probe(id);
  console.log(`${ok?"✓":"·"} ${id} (${agents[id].binary})`);
}
console.log("\nDocumented (non-live) model fallbacks:");
const STALE_DAYS=180;
let anyDocumented=false;
for(const id of Object.keys(agents)){
  if(agents[id].model_discovery!=="manual") continue;
  const doc=loadDocumentedCatalog(id);
  if(!doc) continue;
  anyDocumented=true;
  const ageDays=Math.floor((Date.now()-Date.parse(doc.last_verified))/86400000);
  const stale=ageDays>STALE_DAYS;
  console.log(`${stale?"⚠":"✓"} ${id}: ${doc.models.length} documented option(s), verified ${doc.last_verified}${stale?` (${ageDays}d ago — consider refreshing against ${doc.source})`:""}`);
}
if(!anyDocumented) console.log("· none shipped for the CLIs without live discovery");
console.log("\nShell command policy (gates.commands / <verify> / task.verify):");
console.log("✓ Pattern denylist active (unconditional, cannot be disabled by config)");

const cfgFile=path.join(repo,".autopilot","config.json");
let networkIsolationRequired=true; // matches the code default (gates.network_isolation !== false)
if(fs.existsSync(cfgFile)){
  try{
    const result=loadAndMigrateConfig(cfgFile,{persist:false});
    const cfg=result?.config??null;
    networkIsolationRequired=cfg?.gates?.network_isolation!==false;
  }catch{ /* leave default; cfg() itself will surface parse errors when the run actually starts */ }
}

let nsOk=false;
if(process.platform==="linux"){
  const unshareOk=spawnSync("sh",["-lc","command -v unshare"],{encoding:"utf8"}).status===0;
  nsOk=unshareOk && spawnSync("unshare",["--net","--","true"],{stdio:"ignore",shell:false}).status===0;
}
console.log(`${nsOk?"✓":"·"} unshare --net isolation ${nsOk?"available":`NOT available on ${process.platform}${process.platform==="linux"?" (unshare missing or user namespaces disabled)":" (Linux-only mechanism, not implemented for this platform)"}`}`);

if(networkIsolationRequired && !nsOk){
  console.log(`⚠ gates.network_isolation is ${fs.existsSync(cfgFile)?"":"(default) "}true (required) and isolation is unavailable here.`);
  console.log(`  Every gates.commands / <verify> / task.verify command WILL BE REFUSED (fail-closed) until either:`);
  console.log(`    - you run this on Linux with unshare available, or`);
  console.log(`    - you set gates.network_isolation=false in .autopilot/config.json (accepts running verify/gate commands without network isolation)`);
} else if(!networkIsolationRequired){
  console.log(`· gates.network_isolation=false — commands will run without network isolation regardless of availability (explicit accepted risk).`);
} else {
  console.log(`✓ gates.network_isolation is required (default) and available — commands will run isolated.`);
}
console.log("\nNo installation performed.");
