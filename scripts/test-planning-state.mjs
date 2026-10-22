#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { specKitState, gsdState } from "../adapters/planning-state.mjs";
import * as speckit from "../adapters/speckit.mjs";
import * as gsd from "../adapters/gsd.mjs";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"autopilot-planning-state-"));
const mkdir=p=>fs.mkdirSync(p,{recursive:true});
const write=(p,s)=>{mkdir(path.dirname(p));fs.writeFileSync(p,s)};
const assert=(cond,msg)=>{if(!cond)throw new Error(msg)};
const wf=`- id: specify\n  type: command\n  command: specify\n- id: review-spec\n  type: gate\n- id: plan\n  type: command\n  command: plan\n- id: review-plan\n  type: gate\n- id: tasks\n  type: command\n  command: tasks\n`;

// SpecKit: missing.
{
  const r=path.join(root,"sk-missing"); write(path.join(r,".specify/workflows/speckit/workflow.yml"),wf);
  const state=specKitState(r,speckit.inspect(r),["specs/*/tasks.md"]);
  assert(state.status==="missing","SpecKit missing state failed");
  assert(state.entryIndex===0,"SpecKit missing should start at first step");
}
// SpecKit: partial existing spec+plan -> resume at tasks, not from the beginning.
{
  const r=path.join(root,"sk-partial"); write(path.join(r,".specify/workflows/speckit/workflow.yml"),wf);
  write(path.join(r,"specs/01/spec.md"),"# Spec\nrequirements\n");
  write(path.join(r,"specs/01/plan.md"),"# Plan\narchitecture\n");
  const state=specKitState(r,speckit.inspect(r),["specs/*/tasks.md"]);
  assert(state.status==="partial","SpecKit partial state failed");
  assert(state.entryIndex===4,"SpecKit partial should skip completed spec/review/plan/review and enter tasks");
}
// SpecKit: complete planning -> execution-ready.
{
  const r=path.join(root,"sk-complete"); write(path.join(r,".specify/workflows/speckit/workflow.yml"),wf);
  write(path.join(r,"specs/01/spec.md"),"# Spec\nrequirements\n");
  write(path.join(r,"specs/01/plan.md"),"# Plan\narchitecture\n");
  write(path.join(r,"specs/01/tasks.md"),"- [ ] Task A\n");
  const state=specKitState(r,speckit.inspect(r),["specs/*/tasks.md"]);
  assert(state.status==="complete","SpecKit complete state failed");
  assert(state.entryIndex===5,"SpecKit complete should enter execution");
}
// GSD: brand-new roadmap phase -> start planning from discuss.
{
  const r=path.join(root,"gsd-new");
  write(path.join(r,".planning/ROADMAP.md"),"# Roadmap\n## Phase 1: Foundation\n");
  write(path.join(r,".planning/STATE.md"),"# State\n");
  const state=gsdState(r,gsd.inspect(r,".planning/phases"));
  assert(state.status==="missing" && state.entryStage==="discuss","GSD new phase detection failed");
  assert(state.phase==="1","GSD roadmap phase extraction failed");
}
// GSD: existing research only -> continue at plan, not research.
{
  const r=path.join(root,"gsd-partial");
  write(path.join(r,".planning/ROADMAP.md"),"# Roadmap\n## Phase 1: Foundation\n");
  write(path.join(r,".planning/STATE.md"),"# State\n");
  write(path.join(r,".planning/phases/01-foundation/RESEARCH.md"),"# Research\n");
  const state=gsdState(r,gsd.inspect(r,".planning/phases"));
  assert(state.entryStage==="plan","GSD research checkpoint detection failed");
}
// GSD: PLAN exists -> planning is complete and execution is the entry point.
{
  const r=path.join(root,"gsd-ready");
  write(path.join(r,".planning/ROADMAP.md"),"# Roadmap\n## Phase 1: Foundation\n");
  write(path.join(r,".planning/STATE.md"),"# State\n");
  write(path.join(r,".planning/phases/01-foundation/01-01-PLAN.md"),`---\nphase: 01-foundation\nplan: 1\n---\n<objective>Do thing</objective>\n<task><name>Task A</name><action>do</action><verify>echo ok</verify></task>\n`);
  const state=gsdState(r,gsd.inspect(r,".planning/phases"));
  assert(state.status==="complete" && state.entryStage==="execute","GSD ready state failed");
  assert(state.phase==="01-foundation","GSD phase folder detection failed");
}
console.log("Planning state tests: 6/6 PASS");
console.log(`Fixture root: ${root}`);
