#!/usr/bin/env node
// Unit tests for scripts/opencode-runtime-config.mjs — pure module, zero
// filesystem/process/network access. Import directly (unlike autopilot.mjs,
// importing this module never runs main()).
import {opencodeRuntimeConfigOverride} from "./opencode-runtime-config.mjs";

let failures=0;
const check=(name,condition,detail)=>{
  if(condition) console.log(`PASS ${name}`);
  else{ failures+=1; console.error(`FAIL ${name}${detail?` :: ${detail}`:""}`); }
};

const OPENCODE_SCRATCH_GLOB="/workspace/scratch/**";
const OPENCODE_READONLY_AGENT="autopilot_readonly";
const EXPECTED_OPENCODE_CONFIG_CONTENT=JSON.stringify({snapshot:false,agent:{[OPENCODE_READONLY_AGENT]:{
  mode:"primary",
  description:"Autopilot read-only relay role. Writes are expected only inside the sanctioned scratch directory; repository containment is enforced by the bubblewrap read-only bind mount, not by this agent's own permission block.",
  tools:{invalid:true,question:true,bash:true,read:true,glob:true,grep:true,edit:true,write:true,task:true,webfetch:true,todowrite:true,websearch:true,skill:true},
  permission:{edit:{[OPENCODE_SCRATCH_GLOB]:"allow"},external_directory:{[OPENCODE_SCRATCH_GLOB]:"allow"}}
}}});
const EXPECTED_WRITE_CONTENT=JSON.stringify({snapshot:false});
const envelope={available:true};

// roleAdapter!=="opencode" → {}.
check("non-opencode adapter returns {}", JSON.stringify(opencodeRuntimeConfigOverride("cursor",true,true,envelope))==="{}");
check("non-opencode write-mode returns {}", JSON.stringify(opencodeRuntimeConfigOverride("cursor",false,true,envelope))==="{}");
check("non-opencode read-only without envelope returns {}", JSON.stringify(opencodeRuntimeConfigOverride("claude",true,false,null))==="{}");

// opencode && readOnly && attemptEnvelope && available → original payload, byte-for-byte.
{
  const got=opencodeRuntimeConfigOverride("opencode",true,true,envelope);
  check("read-only with envelope returns OPENCODE_CONFIG_CONTENT", typeof got.OPENCODE_CONFIG_CONTENT==="string", JSON.stringify(got));
  check("read-only payload byte-identical to expected", got.OPENCODE_CONFIG_CONTENT===EXPECTED_OPENCODE_CONFIG_CONTENT,
    (got.OPENCODE_CONFIG_CONTENT||"").slice(0,300));
}

// opencode && readOnly && (!attemptEnvelope || !available) → {}.
check("read-only without attemptEnvelope returns {}",
  JSON.stringify(opencodeRuntimeConfigOverride("opencode",true,false,envelope))==="{}");
check("read-only with unavailable envelope returns {}",
  JSON.stringify(opencodeRuntimeConfigOverride("opencode",true,true,{available:false}))==="{}");
check("read-only with null envelope returns {}",
  JSON.stringify(opencodeRuntimeConfigOverride("opencode",true,true,null))==="{}");
check("read-only with undefined envelope returns {}",
  JSON.stringify(opencodeRuntimeConfigOverride("opencode",true,true,undefined))==="{}");

// opencode && !readOnly → snapshot:false, proven envelope-independent.
{
  const variants=[
    ["envelope+available",true,{available:true}],
    ["no-attempt",false,{available:true}],
    ["unavailable",true,{available:false}],
    ["null-envelope",true,null],
    ["undefined-envelope",false,undefined],
    ["attempt-no-envelope",true,undefined]
  ];
  for(const [label,attempt,env] of variants){
    const got=opencodeRuntimeConfigOverride("opencode",false,attempt,env);
    check(`write-mode (${label}) returns snapshot:false only`,
      got.OPENCODE_CONFIG_CONTENT===EXPECTED_WRITE_CONTENT, JSON.stringify(got));
    check(`write-mode (${label}) carries no agent payload`, !("agent" in JSON.parse(got.OPENCODE_CONFIG_CONTENT||"{}")));
  }
}

// Merge behaviour: a caller's own OPENCODE_CONFIG_CONTENT is preserved on the
// writable path (ours wins for the keys we own), but never on the read-only
// path, which deliberately replaces the whole document.
{
  const existing=JSON.stringify({model:"my/model",provider:{mine:{}},permission:{edit:{"*":"deny"}}});
  const got=opencodeRuntimeConfigOverride("opencode",false,false,null,existing);
  const parsed=JSON.parse(got.OPENCODE_CONFIG_CONTENT);
  check("write-mode preserves caller keys", parsed.model==="my/model"&&!!parsed.provider, got.OPENCODE_CONFIG_CONTENT);
  check("write-mode forces snapshot:false over a caller value", parsed.snapshot===false, got.OPENCODE_CONFIG_CONTENT);
  check("write-mode merge is byte-exact (ours last)",
    got.OPENCODE_CONFIG_CONTENT===JSON.stringify({model:"my/model",provider:{mine:{}},permission:{edit:{"*":"deny"}},snapshot:false}),
    got.OPENCODE_CONFIG_CONTENT);
}
{
  const existing=JSON.stringify({snapshot:true,model:"my/model"});
  const got=opencodeRuntimeConfigOverride("opencode",false,false,null,existing);
  check("write-mode overrides a caller snapshot:true", JSON.parse(got.OPENCODE_CONFIG_CONTENT).snapshot===false, got.OPENCODE_CONFIG_CONTENT);
}
for(const [label,existing] of [["absent",undefined],["empty",""],["blank","   "],["malformed","{not json"],["array","[1,2]"],["null-literal","null"],["string-literal",'"x"']]){
  const got=opencodeRuntimeConfigOverride("opencode",false,false,null,existing);
  check(`write-mode (${label} caller content) falls back to snapshot:false only`,
    got.OPENCODE_CONFIG_CONTENT===EXPECTED_WRITE_CONTENT, got.OPENCODE_CONFIG_CONTENT);
}
{
  const existing=JSON.stringify({snapshot:true,model:"my/model"});
  const got=opencodeRuntimeConfigOverride("opencode",true,true,envelope,existing);
  check("read-only ignores caller content (deliberate full replacement)",
    got.OPENCODE_CONFIG_CONTENT===EXPECTED_OPENCODE_CONFIG_CONTENT, (got.OPENCODE_CONFIG_CONTENT||"").slice(0,200));
}

if(failures){ console.error(`${failures} opencode-runtime-config check(s) failed.`); process.exit(1); }
console.log("test-opencode-runtime-config: ALL CHECKS PASSED");
