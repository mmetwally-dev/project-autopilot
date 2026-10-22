#!/usr/bin/env node
// Backlog #79: scripts/tmp-so-cleanup.mjs — stale opencode native-library
// sweep. Uses a real temp dir with injected fakes for listOpenFiles/unlink/
// readdir so the open-file detection and never-throw contract are testable
// without touching the real /tmp. The final check exercises the real
// /proc/*/maps scan against a file genuinely mapped by a live child.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {cleanStaleOpencodeLibs} from "./tmp-so-cleanup.mjs";

let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};

if (process.platform !== "linux") {
  console.log("test-tmp-so-cleanup: SKIP — requires Linux (the sweep is a no-op elsewhere).");
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-so-cleanup-test-"));
const write = (name, size) => {
  const p = path.join(scratch, name);
  fs.writeFileSync(p, Buffer.alloc(size));
  return p;
};
const noOpenFiles = () => new Set();

// ---- 1. stale matching files are deleted ----
write(".deadbeef-00000001.so", 1024);
write(".cafebabe-00000002.so", 2048);
const unlinked = [];
let r = cleanStaleOpencodeLibs({
  tmpDir: scratch,
  listOpenFiles: noOpenFiles,
  unlink: (p) => { unlinked.push(p); fs.unlinkSync(p); }
});
check("stale matching files deleted", !fs.existsSync(path.join(scratch, ".deadbeef-00000001.so")) && !fs.existsSync(path.join(scratch, ".cafebabe-00000002.so")));
check("deleted count", r.deleted === 2, `got ${r.deleted}`);
check("bytes counts the unlinked sizes", r.bytes === 3072, `got ${r.bytes}`);
check("kept count", r.kept === 0, `got ${r.kept}`);
check("unlink invoked once per stale file", unlinked.length === 2, `got ${unlinked.length}`);

// ---- 2. file mapped by a live process is kept ----
const openPath = write(".0a1b2c3d-00000001.so", 4096);
r = cleanStaleOpencodeLibs({tmpDir: scratch, listOpenFiles: () => new Set([openPath]), unlink: (p) => fs.unlinkSync(p)});
check("open file kept on disk", fs.existsSync(openPath));
check("open file counted as kept, nothing deleted", r.kept === 1 && r.deleted === 0 && r.bytes === 0, JSON.stringify(r));

// ---- 3. non-matching names untouched ----
const keepA = write("regular-file.so", 10);
const keepB = write(".nothex-00000003.so", 10);
const keepC = write(".abcdef-123.so", 10);
const keepD = write(".ABCDEF-00000004.so", 10);
const keepE = write("opencode-00000005.so", 10);
fs.mkdirSync(path.join(scratch, ".abcdef0-00000005.so"));
r = cleanStaleOpencodeLibs({tmpDir: scratch, listOpenFiles: noOpenFiles, unlink: (p) => fs.unlinkSync(p)});
check("non-matching names untouched", [keepA, keepB, keepC, keepD, keepE].every((p) => fs.existsSync(p)));
check("pattern-matching directory untouched", fs.statSync(path.join(scratch, ".abcdef0-00000005.so")).isDirectory());
fs.rmdirSync(path.join(scratch, ".abcdef0-00000005.so"));

// ---- 4. missing dir -> no throw, zero result ----
let threw = false;
try {
  r = cleanStaleOpencodeLibs({tmpDir: path.join(scratch, "does-not-exist"), listOpenFiles: noOpenFiles, unlink: (p) => fs.unlinkSync(p)});
} catch { threw = true; }
check("missing dir does not throw", !threw);
check("missing dir returns zero result", r.deleted === 0 && r.kept === 0 && r.bytes === 0, JSON.stringify(r));

// ---- 5. throwing listOpenFiles -> no throw, still cleans ----
write(".0a1b2c3d-00000009.so", 5);
r = cleanStaleOpencodeLibs({tmpDir: scratch, listOpenFiles: () => { throw new Error("boom"); }, unlink: (p) => fs.unlinkSync(p)});
check("throwing listOpenFiles does not throw and still cleans", !fs.existsSync(path.join(scratch, ".stillstale-00000009.so")) && r.deleted === 1, JSON.stringify(r));

// ---- 6. real /proc/*/maps scan keeps a file genuinely mapped by a live child ----
const realTarget = write(".0a1b2c3d-00000006.so", 600000);
const staleSibling = write(".deadbeef-00000007.so", 10);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn("python3", ["-c", `
import mmap, time, sys
with open(${JSON.stringify(realTarget)}, "rb") as f:
    m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    sys.stdout.write("MAPPED\\n")
    sys.stdout.flush()
    time.sleep(60)
`], {stdio: ["ignore", "pipe", "ignore"]});
let childSpawnError = null;
let childExited = false;
child.once("error", (e) => { childSpawnError = e; });
child.once("exit", () => { childExited = true; });
try {
  // Wait for the ready marker (python prints it only after mmap succeeded).
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const readyDeadline = Date.now() + 20000;
  while (!out.includes("MAPPED") && !childSpawnError && !childExited && Date.now() < readyDeadline) await sleepMs(25);
  if (childSpawnError && childSpawnError.code === "ENOENT") {
    console.log("test-tmp-so-cleanup: SKIP real /proc scan check (python3 not available).");
  } else {
    check("python child reported the file mapped", out.includes("MAPPED"), `out=${JSON.stringify(out)} exited=${childExited}`);
    // Belt and braces: wait until /proc/<pid>/maps really lists the path.
    let listed = false;
    const mapsDeadline = Date.now() + 10000;
    while (!listed && Date.now() < mapsDeadline) {
      try { listed = fs.readFileSync(`/proc/${child.pid}/maps`, "utf8").includes(realTarget); } catch { /* not yet */ }
      if (!listed) await sleepMs(25);
    }
    check("child /proc maps lists the mapped file", listed);
    r = cleanStaleOpencodeLibs({tmpDir: scratch, unlink: (p) => fs.unlinkSync(p)});
    check("real /proc scan keeps a mapped file", fs.existsSync(realTarget) && r.kept === 1, JSON.stringify(r));
    check("real /proc scan still deletes the unmapped sibling", !fs.existsSync(staleSibling) && r.deleted === 1, JSON.stringify(r));
  }
} finally {
  if (!childExited) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    if (child.pid) await exited;
  }
}

fs.rmSync(scratch, {recursive: true, force: true});

if (failures > 0) {
  console.error(`${failures} tmp-so-cleanup check(s) failed.`);
  process.exit(1);
}
console.log("test-tmp-so-cleanup: ALL CHECKS PASSED");
