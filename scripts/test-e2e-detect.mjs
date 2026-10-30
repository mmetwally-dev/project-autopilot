#!/usr/bin/env node
// e2e-detect.mjs: UI project and e2e tool detection from package.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectUiProject, detectE2eTool } from "./e2e-detect.mjs";

let failed = 0;
function check(name, ok) {
  if (!ok) { failed++; console.error(`FAIL: ${name}`); } else console.log(`ok: ${name}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-detect-"));
function fixture(name, pkg) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (pkg !== undefined) fs.writeFileSync(path.join(dir, "package.json"), pkg);
  return dir;
}

try {
  const a = fixture("react-dep", JSON.stringify({ dependencies: { react: "1" } }));
  check("react dependency is ui", detectUiProject(a) === true);
  check("react alone has no tool", detectE2eTool(a) === null);

  const b = fixture("pw-dev", JSON.stringify({ devDependencies: { "@playwright/test": "1", vue: "3" } }));
  check("devDependencies ui", detectUiProject(b) === true);
  check("playwright only in devDependencies detected", detectE2eTool(b) === "playwright");

  const c = fixture("cy", JSON.stringify({ devDependencies: { cypress: "13" }, dependencies: { next: "14" } }));
  check("cypress detected", detectE2eTool(c) === "cypress");
  check("next is ui", detectUiProject(c) === true);

  const d = fixture("backend", JSON.stringify({ dependencies: { express: "4" } }));
  check("backend not ui", detectUiProject(d) === false && detectE2eTool(d) === null);

  const e = fixture("none");
  check("missing package.json", detectUiProject(e) === false && detectE2eTool(e) === null);

  const f = fixture("bad", "{not json");
  check("invalid json", detectUiProject(f) === false && detectE2eTool(f) === null);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
