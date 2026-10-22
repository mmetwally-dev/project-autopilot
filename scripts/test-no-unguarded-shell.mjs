#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const childProcessNames=new Set(['spawn','spawnSync','exec','execSync','execFile','execFileSync']);
const wrapperInvocationNames=new Set(['run','runCommand']);
const shellBins=new Set(['sh','bash','zsh','dash','powershell','pwsh','cmd']);
const shellFlags=new Set(['-c','-lc','/c','-command','-Command']);

function decodeString(raw){
  const q=raw[0];
  let body=raw.slice(1,-1);
  if(q==='"'){
    try{return JSON.parse(raw);}catch{}
  }
  body=body.replace(/\\([\\'"`])/g,'$1');
  return body;
}

function lexJs(source){
  const tokens=[];
  let i=0;
  const push=(type,start,end,value)=>tokens.push({type,start,end,value});
  while(i<source.length){
    const c=source[i], n=source[i+1];
    if(/\s/.test(c)){i++;continue;}
    if(c==='/'&&n==='/'){i+=2;while(i<source.length&&source[i]!=='\n')i++;continue;}
    if(c==='/'&&n==='*'){i+=2;while(i<source.length&&!(source[i]==='*'&&source[i+1]==='/'))i++;i=Math.min(source.length,i+2);continue;}
    if(c==='"'||c==="'"||c==='`'){
      const start=i, q=c; i++;
      while(i<source.length){
        if(source[i]==='\\'){i+=2;continue;}
        if(source[i]===q){i++;break;}
        i++;
      }
      push('string',start,i,decodeString(source.slice(start,i)));
      continue;
    }
    if(/[A-Za-z_$]/.test(c)){
      const start=i; i++;
      while(i<source.length&&/[A-Za-z0-9_$]/.test(source[i]))i++;
      push('identifier',start,i,source.slice(start,i));
      continue;
    }
    if(/[0-9]/.test(c)){
      const start=i; i++;
      while(i<source.length&&/[0-9._]/.test(source[i]))i++;
      push('number',start,i,source.slice(start,i));
      continue;
    }
    push('punct',i,i+1,c); i++;
  }
  return tokens;
}

function findMatchingParen(tokens,openIndex){
  let depth=0;
  for(let i=openIndex;i<tokens.length;i++){
    const v=tokens[i].value;
    if(v==='(')depth++;
    else if(v===')'){
      depth--;
      if(depth===0)return i;
    }
  }
  return -1;
}

function splitTopLevelArgs(tokens,start,end){
  const args=[]; let argStart=start, p=0,b=0,c=0;
  for(let i=start;i<end;i++){
    const v=tokens[i].value;
    if(v==='(')p++; else if(v===')')p--;
    else if(v==='[')b++; else if(v===']')b--;
    else if(v==='{')c++; else if(v==='}')c--;
    else if(v===','&&p===0&&b===0&&c===0){args.push(tokens.slice(argStart,i));argStart=i+1;}
  }
  args.push(tokens.slice(argStart,end));
  return args;
}

function isDynamicExpr(tokens){
  return tokens.some(t=>t.type==='identifier' || t.value==='+' || t.value==='`' || t.value==='$');
}

function isStringLiteral(tokens,valueSet=null){
  if(tokens.length!==1||tokens[0].type!=='string')return false;
  return valueSet?valueSet.has(tokens[0].value):true;
}

function arrayLooksLikeShell(tokens){
  if(tokens.length<3||tokens[0]?.value!=='[')return false;
  // Find first argument inside the array.
  const end=tokens.findIndex((t,i)=>i>0&&t.value===']');
  if(end<0)return false;
  const inner=tokens.slice(1,end);
  const args=splitTopLevelArgs(inner,0,inner.length);
  if(!args[0]||args[0].length!==1||args[0][0].type!=='string')return false;
  return shellFlags.has(args[0][0].value);
}

function allowedRunGuardedRange(tokens){
  for(let i=0;i<tokens.length-1;i++){
    if(tokens[i].type==='identifier'&&tokens[i].value==='function'&&tokens[i+1].type==='identifier'&&tokens[i+1].value==='runGuardedCommand'){
      const open=tokens.findIndex((t,j)=>j>i&&t.value==='{');
      if(open<0) return null;
      let depth=0;
      for(let j=open;j<tokens.length;j++){
        if(tokens[j].value==='{')depth++;
        else if(tokens[j].value==='}'&&--depth===0)return [tokens[i].start,tokens[j].end];
      }
      return null;
    }
  }
  return null;
}

function inRange(pos,range){return !!range&&pos>=range[0]&&pos<range[1];}

function collectLocalAliases(tokens){
  const names=new Set([...wrapperInvocationNames]);
  const importedKinds=new Map();
  const literals=new Map();
  const childProcessObjects=new Set();
  for(let i=0;i<tokens.length-1;i++){
    // import { exec as cpExec, spawnSync } from "node:child_process"
    if(tokens[i].value==='import' && tokens[i+1]?.value==='{'){
      let j=i+2, close=-1, from=-1;
      while(j<tokens.length&&tokens[j].value!=='}')j++;
      close=j;
      for(let k=close+1;k<Math.min(tokens.length,close+6);k++){
        if(tokens[k].value==='from'){from=k;break;}
      }
      if(from>0&&tokens[from+1]?.type==='string'&&/^node:child_process$|^child_process$/.test(tokens[from+1].value)){
        for(let k=i+2;k<close;k++){
          if(tokens[k].type==='identifier'&&childProcessNames.has(tokens[k].value)){
            if(tokens[k+1]?.value==='as'&&tokens[k+2]?.type==='identifier'){names.add(tokens[k+2].value);importedKinds.set(tokens[k+2].value,tokens[k].value);}
            else {names.add(tokens[k].value);importedKinds.set(tokens[k].value,tokens[k].value);}
          }
        }
      }
    }
    // const cp=require("node:child_process")
    if((tokens[i].value==='const'||tokens[i].value==='let'||tokens[i].value==='var')&&tokens[i+1]?.type==='identifier'&&tokens[i+2]?.value==='='&&tokens[i+3]?.type==='identifier'&&tokens[i+3].value==='require'&&tokens[i+4]?.value==='('&&tokens[i+5]?.type==='string'&&/^(node:)?child_process$/.test(tokens[i+5].value)){
      childProcessObjects.add(tokens[i+1].value);
    }
    if((tokens[i].value==='const'||tokens[i].value==='let'||tokens[i].value==='var')&&tokens[i+1]?.type==='identifier'&&tokens[i+2]?.value==='='&&tokens[i+3]?.type==='string'){
      literals.set(tokens[i+1].value,tokens[i+3].value);
    }
  }
  return {names,importedKinds,literals,childProcessObjects};
}
function scanSource(file){
  const source=fs.readFileSync(file,'utf8');
  const tokens=lexJs(source);
  const allowed=allowedRunGuardedRange(tokens);
  const {names,importedKinds,literals,childProcessObjects}=collectLocalAliases(tokens);
  const offenders=[];

  for(let i=0;i<tokens.length;i++){
    const t=tokens[i];
    if(t.type==='identifier'&&t.value==='shell'&&tokens[i+1]?.value===':'&&tokens[i+2]?.type==='identifier'&&tokens[i+2]?.value==='true'&&!inRange(t.start,allowed)){
      offenders.push(`${file}:${t.start}: shell:true outside guarded executor`);
    }
  }

  for(let i=0;i<tokens.length-1;i++){
    const nameTok=tokens[i];
    if(nameTok.type!=='identifier')continue;
    if(tokens[i+1]?.value!=='(')continue;
    const importedKind=importedKinds.get(nameTok.value);
    const directImported=!!importedKind;
    const wrapperCall=wrapperInvocationNames.has(nameTok.value);
    const memberCall=tokens[i-1]?.value==='.' && tokens[i-2]?.type==='identifier' && childProcessObjects.has(tokens[i-2].value);
    if(!directImported&&!wrapperCall&&!memberCall)continue;
    if(inRange(nameTok.start,allowed))continue;
    const close=findMatchingParen(tokens,i+1);
    if(close<0)continue;
    const args=splitTopLevelArgs(tokens,i+2,close);
    const first=args[0]||[], second=args[1]||[];
    const firstValue=first.length===1&&first[0].type==='string'?first[0].value:(first.length===1&&first[0].type==='identifier'?literals.get(first[0].value):null);

    const canonical=importedKind||nameTok.value;
    if((directImported||memberCall)&&(canonical==='exec'||canonical==='execSync')){
      if(first.length && !isStringLiteral(first)) offenders.push(`${file}:${nameTok.start}: ${nameTok.value} dynamic command`);
      continue;
    }

    if((directImported||memberCall)&&(canonical==='execFile'||canonical==='execFileSync')){
      const callTokens=tokens.slice(i+2,close);
      const hasShellTrue=callTokens.some((x,j)=>x.type==='identifier'&&x.value==='shell'&&callTokens[j+1]?.value===':'&&callTokens[j+2]?.type==='identifier'&&callTokens[j+2].value==='true');
      if(hasShellTrue){offenders.push(`${file}:${nameTok.start}: ${nameTok.value} shell:true`);continue;}
      const execFileArgs=splitTopLevelArgs(tokens,i+2,close);
      const execFileBin=execFileArgs[0]?.length===1&&execFileArgs[0][0].type==='string'?execFileArgs[0][0].value:(execFileArgs[0]?.length===1&&execFileArgs[0][0].type==='identifier'?literals.get(execFileArgs[0][0].value):null);
      if(execFileBin&&shellBins.has(execFileBin)&&arrayLooksLikeShell(execFileArgs[1]||[])&&(execFileArgs[1]||[]).some(x=>x.type==='identifier')){
        offenders.push(`${file}:${nameTok.start}: ${nameTok.value} dynamic shell command`);
      }
      continue;
    }

    if(!firstValue||!shellBins.has(firstValue))continue;
    if(!arrayLooksLikeShell(second))continue;
    if(second.some(x=>x.type==='identifier'&&x.value!=='undefined')||second.some(x=>x.value==='`'||x.value==='$')){
      offenders.push(`${file}:${nameTok.start}: ${nameTok.value} dynamic shell command`);
    } else if(nameTok.value==='run'||nameTok.value==='runCommand'){
      // For wrappers, the command itself is usually an identifier in the array, but may be nested.
      const flat=second.map(x=>x.value).join(' ');
      if(!/\b(command|cmd|commandText|userCommand|input|script)\b/.test(flat)){
        // Still flag shell wrapper invocations conservatively outside the guarded executor.
        offenders.push(`${file}:${nameTok.start}: ${nameTok.value} shell invocation outside guarded executor`);
      } else {
        offenders.push(`${file}:${nameTok.start}: ${nameTok.value} dynamic shell command`);
      }
    } else if(second.some(x=>x.type==='identifier')){
      offenders.push(`${file}:${nameTok.start}: ${nameTok.value} dynamic shell command`);
    }
  }
  return offenders;
}

function walk(dir,skipFile){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='node_modules'||entry.name.startsWith('.'))continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...walk(full,skipFile));
    else if(/\.(mjs|cjs)$/.test(entry.name)&&full!==skipFile&&!full.endsWith(path.join('scripts','shell-guard.mjs')))out.push(...scanSource(full));
  }
  return out;
}

function analyzeFixture(source){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autopilot-shell-static-'));
  const file=path.join(dir,'fixture.mjs');
  try{fs.writeFileSync(file,source);return scanSource(file);}finally{fs.rmSync(dir,{recursive:true,force:true});}
}

function analyzeLargeRealisticFixture(snippet){
  const real=fs.readFileSync(path.join(root,'scripts','autopilot.mjs'),'utf8');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autopilot-shell-real-'));
  const file=path.join(dir,'autopilot.mjs');
  try{fs.writeFileSync(file,`${real}\n\n${snippet}\n`);return scanSource(file);}finally{fs.rmSync(dir,{recursive:true,force:true});}
}

const self=path.join(root,'scripts','test-no-unguarded-shell.mjs');
const offenders=walk(root,self);
if(offenders.length){console.error('Unguarded dynamic shell execution detected:');for(const item of offenders)console.error(`  ${item}`);process.exit(1);}

const negativeFixtures=[
  ['original runCommand wrapper verbatim',`function runCommand(command){\n  return run("cmd",["/c",command],{capture:true});\n}`],
  ['variable named differently',`import { spawnSync } from "node:child_process"; function bad(){ return spawnSync("cmd", ["/c", cmdText]); }`],
  ['short shell flag',`import { spawnSync } from "node:child_process"; function bad(){ return spawnSync("sh", ["-c", userCommand]); }`],
  ['bash variant',`import { spawnSync } from "node:child_process"; function bad(){ return spawnSync("bash", ["-lc", userCommand]); }`],
  ['shell true',`import { spawnSync } from "node:child_process"; function bad(){ return spawnSync("node", ["x"], {shell:true}); }`],
  ['exec dynamic',`import { exec } from "node:child_process"; function bad(){ return exec(userCommand); }`],
  ['exec alias',`import { exec as cpExec } from "node:child_process"; function bad(){ return cpExec(userCommand); }`],
  ['property-chain exec',`const cp=require("child_process"); function bad(){ return cp.exec(userCommand); }`],
  ['execFile shell flag',`import { execFileSync } from "node:child_process"; function bad(){ return execFileSync("sh", ["-c", userCommand]); }`],
  ['const shell binary',`import { spawnSync } from "node:child_process"; const bin="sh"; function bad(){ return spawnSync(bin, ["-c", command]); }`],
];
for(const [label,fixture] of negativeFixtures){
  const found=analyzeFixture(fixture);
  if(!found.length){console.error(`NEGATIVE TEST FAILED: ${label}`);process.exit(1);}
}

const realisticBypasses=[
  `function runCommand(command){\n  return run("cmd",["/c",command],{capture:true});\n}`,
  `import { spawnSync } from "node:child_process"; const cmdText="x"; function bad(){ return spawnSync("cmd", ["/c", cmdText]); }`,
  `import { spawnSync } from "node:child_process"; function bad(){ return spawnSync("bash", ["-lc", userCommand]); }`,
  `import { exec as cpExec } from "node:child_process"; function bad(){ return cpExec(userCommand); }`,
  `const cp=require("child_process"); function bad(){ return cp.exec(userCommand); }`,
  `import { execFileSync } from "node:child_process"; function bad(){ return execFileSync("sh", ["-c", userCommand]); }`,
  `import { spawnSync } from "node:child_process"; const bin="sh"; function bad(){ return spawnSync(bin, ["-c", command]); }`,
];
for(const [index,snippet] of realisticBypasses.entries()){
  if(!analyzeLargeRealisticFixture(snippet).length){
    console.error(`REALISTIC REGRESSION FAILED: bypass ${index+1} escaped detection inside a real-sized source file`);
    process.exit(1);
  }
}

const guardedFixture=`\nfunction runGuardedCommand(cwd,command){\n  return spawnSync("sh", ["-lc", command], {cwd, shell:false});\n}\n`;
if(analyzeFixture(guardedFixture).length){console.error('POSITIVE TEST FAILED: guarded shell execution was flagged');process.exit(1);}

console.log(`no-unguarded-shell static analysis passed; ${negativeFixtures.length} negative cases + realistic regression covered`);
