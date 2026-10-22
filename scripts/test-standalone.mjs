import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import * as standalone from "../adapters/standalone.mjs";

const MISSION="001-demo";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"autopilot-standalone-"));
try{
  let s=standalone.state(root,MISSION);
  assert.equal(s.status,"missing");
  const planFile=standalone.planPath(root,MISSION);
  const tasksFile=standalone.tasksPath(root,MISSION);
  fs.mkdirSync(path.dirname(planFile),{recursive:true});
  fs.writeFileSync(planFile,"# Plan\n\nObjective: demo\n");
  fs.writeFileSync(tasksFile,"## Phase 1: General\n\n- [ ] Add login\n- [ ] Verify login\n");
  s=standalone.state(root,MISSION);
  assert.equal(s.status,"partial");
  assert.equal(s.entryIndex,0);
  assert.equal(standalone.tasks(root,MISSION).length,2);
  // 1-indexed lines: TASKS.md lines are 1:##,2:blank,3:- [ ] Add login,4:- [ ] Verify login
  standalone.markDone(root,MISSION,3);
  s=standalone.state(root,MISSION);
  assert.equal(s.status,"partial");
  assert.equal(s.entryIndex,1);
  standalone.markDone(root,MISSION,4);
  s=standalone.state(root,MISSION);
  assert.equal(s.status,"complete");
  assert.equal(s.entryIndex,2);
  // phases() shape: single phase, 2 tasks, 1-indexed lines
  const ph=standalone.phases(root,MISSION);
  assert.equal(ph.length,1);
  assert.equal(ph[0].tasks.length,2);
  assert.equal(ph[0].tasks[0].line,3);
  console.log("standalone planning state tests passed");
}finally{
  fs.rmSync(root,{recursive:true,force:true});
}
