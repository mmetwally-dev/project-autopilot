#!/usr/bin/env node
// Backlog #119: planning-state review is skipped on resume when PLAN.md +
// TASKS.md are unchanged (checkbox state normalised) since the last PASS.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {planningArtifactDigest,canSkipPlanningStateReview} from "./planning-artifact-digest.mjs";

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"t119-"));
const plan=path.join(dir,"PLAN.md"), tasks=path.join(dir,"TASKS.md");
const TASKS="## Phase 1: a\n- [ ] **1.1** do x — accept: a ; verify: b\n- [ ] **1.2** do y — accept: a ; verify: b\n";
fs.writeFileSync(plan,"# Plan\nobjective\n");
fs.writeFileSync(tasks,TASKS);
const d0=planningArtifactDigest(plan,tasks);
assert.ok(d0);
const stored={status:"passed",framework:"standalone",at:"2026-10-16T07:07:00Z",artifactDigest:d0};

// 1. only checkboxes flipped -> skipped
fs.writeFileSync(tasks,TASKS.replace("- [ ] **1.1**","- [x] **1.1**").replace("- [ ] **1.2**","- [X] **1.2**"));
assert.equal(planningArtifactDigest(plan,tasks),d0);
assert.equal(canSkipPlanningStateReview(stored,planningArtifactDigest(plan,tasks)),true);

// 2. real edit in TASKS.md or PLAN.md -> runs
fs.writeFileSync(tasks,TASKS.replace("do x","do z"));
assert.equal(canSkipPlanningStateReview(stored,planningArtifactDigest(plan,tasks)),false);
fs.writeFileSync(tasks,TASKS);
fs.writeFileSync(plan,"# Plan\nobjective changed\n");
assert.equal(canSkipPlanningStateReview(stored,planningArtifactDigest(plan,tasks)),false);
fs.writeFileSync(plan,"# Plan\nobjective\n");

// 3. no stored digest / failed status / missing file -> runs
const {artifactDigest:_,...noDigest}=stored;
assert.equal(canSkipPlanningStateReview(noDigest,d0),false);
assert.equal(canSkipPlanningStateReview(null,d0),false);
assert.equal(canSkipPlanningStateReview({...stored,status:"failed"},d0),false);
assert.equal(canSkipPlanningStateReview(stored,planningArtifactDigest(plan,path.join(dir,"nope"))),false);

// 4. wiring: skip only on resume call sites, digest recorded on both PASS paths
const src=fs.readFileSync(new URL("./autopilot.mjs",import.meta.url),"utf8");
assert.equal((src.match(/reviewExistingPlanning\(c,s,state,effectiveRequest,\{allowSkip:true\}\)/g)||[]).length,2);
assert.match(src,/planning-state review skipped: plan unchanged since/);
assert.equal((src.match(/artifactDigest/g)||[]).length>=2,true);
fs.rmSync(dir,{recursive:true,force:true});
console.log("test-119 OK");
