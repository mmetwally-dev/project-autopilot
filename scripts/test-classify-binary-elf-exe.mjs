#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {binaryAdmission, classifyBinary} from "./execution-envelope.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-elf-exe-"));
let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};
const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 1)]);
const write = (name, content) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, content);
  return file;
};

const elfExe = classifyBinary(write("x.exe", elf));
check("ELF content named x.exe is native", elfExe.kind === "native");
check("ELF x.exe is admitted", binaryAdmission(elfExe).admitted === true);

const textExe = classifyBinary(write("y.exe", "just plain text\n"));
check("plain-text y.exe stays windows-executable", textExe.kind === "windows-executable");
if (process.platform !== "win32") {
  const admission = binaryAdmission(textExe);
  check("plain-text y.exe denied with windows_interop_not_contained",
    admission.admitted === false && admission.reason === "windows_interop_not_contained");
}

check("ELF content without extension is native", classifyBinary(write("z", elf)).kind === "native");

const real = path.join(os.homedir(), ".opencode2", "lib", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
if (fs.existsSync(real)) check("real opencode.exe classifies as native", classifyBinary(real).kind === "native");
else console.log("SKIP real opencode.exe not present");

fs.rmSync(root, {recursive: true, force: true});
if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
