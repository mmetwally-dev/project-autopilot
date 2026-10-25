#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverCapabilities} from './model-discovery.mjs';

const tempDirs = new Set();
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
});

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ap-caps-'));
tempDirs.add(tmp);
const bin=path.join(tmp, process.platform==='win32' ? 'fake-cli.cmd' : 'fake-cli');
const script=process.platform==='win32'
  ? '@echo off\r\necho Usage: fake-cli [--model MODEL] [--effort LEVEL] [--variant NAME]\r\n'
  : '#!/bin/sh\nprintf "%s\\n" "Usage: fake-cli [--model MODEL] [--effort LEVEL] [--variant NAME]"\n';
fs.writeFileSync(bin,script);
if(process.platform!=='win32') fs.chmodSync(bin,0o755);
const caps=await discoverCapabilities({
  binary:bin,
  model_discovery:'manual',
  resume_last:['--resume-last']
});
if(!caps.model || caps.model_flag!=='--model') throw new Error(`model capability failed: ${JSON.stringify(caps)}`);
if(!caps.effort || caps.effort_flag!=='--effort') throw new Error(`effort capability failed: ${JSON.stringify(caps)}`);
if(!caps.variant || caps.variant_flag!=='--variant') throw new Error(`variant capability failed: ${JSON.stringify(caps)}`);
console.log('model capability discovery test passed');
