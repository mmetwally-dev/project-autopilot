#!/usr/bin/env node
// A standalone project that still carries a `specs/` folder must name its
// mission from the request, never from the newest spec directory (that split
// one mission across two folders: runs under the spec name, plan + watch
// report under the request name). SpecKit keeps spec-derived naming.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {missionFor} from "./mission-naming.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failed++;
};

function repoWith(framework) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-naming-"));
  fs.mkdirSync(path.join(repo, "specs", "009-receipt-uat-go-live"), {recursive: true});
  fs.writeFileSync(path.join(repo, "specs", "009-receipt-uat-go-live", "spec.md"), "# spec\n");
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "config.json"),
    JSON.stringify({project: {planning_framework: framework}}));
  return repo;
}

const state = {phase: "planning", step: "standalone-plan", planningRequest: "write new file at the root"};

const standaloneRepo = repoWith("standalone");
const standaloneName = missionFor(standaloneRepo, state);
check("standalone: mission named from the request", standaloneName === "001-write-new-file-root", standaloneName);
check("standalone: newest spec name never used", !String(standaloneName).includes("receipt"), standaloneName);

const speckitRepo = repoWith("speckit");
const speckitName = missionFor(speckitRepo, state);
check("speckit: planning names the mission from the request, not the previous spec",
  speckitName === "001-write-new-file-root", speckitName);
const noRequest = {phase: "planning", step: "planning"};
const speckitFallback = missionFor(speckitRepo, noRequest);
check("speckit: no request at all → newest spec is the fallback", speckitFallback === "001-receipt-uat-go-live", speckitFallback);
check("standalone: no request → never the spec name", !String(missionFor(standaloneRepo, noRequest)).includes("receipt"),
  missionFor(standaloneRepo, noRequest));

for (const r of [standaloneRepo, speckitRepo]) fs.rmSync(r, {recursive: true, force: true});
console.log(failed ? `${failed} check(s) failed.` : "mission-naming framework tests passed");
process.exit(failed ? 1 : 0);
