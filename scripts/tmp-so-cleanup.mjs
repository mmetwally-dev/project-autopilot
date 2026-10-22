// Backlog #79: every opencode (bun) launch extracts native libraries to /tmp
// as /.<hash>-0000000N.so (5-13 MB each) and never deletes them; on a small
// tmpfs this fills the disk and the gate dies with ENOSPC. This module sweeps
// the stale leftovers once per opencode role launch (best-effort, never
// throws). Files currently mapped by a live process are kept: they are
// almost always an opencode instance running concurrently with this launch.
import path from "node:path";
import {readdirSync, readFileSync, statSync, unlinkSync} from "node:fs";

const NAME_PATTERN = /^\.[0-9a-f]+-\d{8}\.so$/;

function defaultListOpenFiles() {
  const open = new Set();
  let pids = [];
  try {
    pids = readdirSync("/proc", {withFileTypes: true})
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return open;
  }
  for (const pid of pids) {
    let text;
    try {
      text = readFileSync(`/proc/${pid}/maps`, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 6) continue;
      // A mapped-then-unlinked file shows as "<path> (deleted)"; strip the
      // suffix so a recycled same-name inode is still recognised as open.
      const pathname = fields.slice(5).join(" ").replace(/ \(deleted\)$/, "");
      if (pathname.startsWith("/")) open.add(pathname);
    }
  }
  return open;
}

export function cleanStaleOpencodeLibs({tmpDir="/tmp", listOpenFiles, unlink, readdir} = {}) {
  try {
    if (process.platform !== "linux") return {deleted: 0, kept: 0, bytes: 0};
    const doReaddir = readdir || ((dir) => readdirSync(dir));
    const doUnlink = unlink || ((p) => unlinkSync(p));
    const doListOpenFiles = listOpenFiles || defaultListOpenFiles;
    let names;
    try {
      names = doReaddir(tmpDir);
    } catch {
      return {deleted: 0, kept: 0, bytes: 0};
    }
    let openFiles;
    try {
      const listed = doListOpenFiles(tmpDir);
      openFiles = listed instanceof Set ? listed : new Set(listed);
    } catch {
      openFiles = new Set();
    }
    let deleted = 0;
    let kept = 0;
    let bytes = 0;
    for (const entry of names) {
      const name = typeof entry === "string" ? entry : entry?.name;
      if (typeof name !== "string" || !NAME_PATTERN.test(name)) continue;
      const fullPath = path.join(tmpDir, name);
      if (openFiles.has(fullPath)) {
        kept += 1;
        continue;
      }
      let size = 0;
      try {
        size = statSync(fullPath).size;
      } catch {
        kept += 1;
        continue;
      }
      try {
        doUnlink(fullPath);
      } catch {
        kept += 1;
        continue;
      }
      deleted += 1;
      bytes += size;
    }
    return {deleted, kept, bytes};
  } catch {
    return {deleted: 0, kept: 0, bytes: 0};
  }
}
