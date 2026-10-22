// Backlog #110: result.json carries taskRef/phase/attempt; readRunMeta prefers it, falls back to status.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readRunMeta } from "./run-history.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "t110-"));
const mk = (name, status, result) => {
  const d = path.join(root, name);
  fs.mkdirSync(d);
  if (status) fs.writeFileSync(path.join(d, "status.json"), JSON.stringify(status));
  if (result) fs.writeFileSync(path.join(d, "result.json"), JSON.stringify(result));
  return d;
};
const id = "01-implementer-abcdef12";
assert.equal(readRunMeta(mk("a", { role: "implementer", taskRef: "T1.1" }, { taskRef: "T1.2" }), id).taskRef, "T1.2");
assert.equal(readRunMeta(mk("b", { role: "implementer", taskRef: "T1.1" }, { status: "completed" }), id).taskRef, "T1.1");
assert.equal(readRunMeta(mk("c", { role: "implementer" }, { taskRef: "T2.1" }), id).taskRef, "T2.1");
assert.equal(readRunMeta(mk("d", { role: "implementer" }, null), id).taskRef, null);

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "autopilot.mjs"), "utf8");
assert.match(src, /result\.taskRef=meta\.taskRef\?\?null;/, "runRelay writes taskRef into result");
assert.match(src, /result\.attempt=meta\.attempt/, "runRelay writes attempt into result");
fs.rmSync(root, { recursive: true, force: true });
console.log("test-110-result-taskref: ok");
