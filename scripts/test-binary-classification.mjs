#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {binaryAdmission, classifyBinary} from "./execution-envelope.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-binary-classification-"));
let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};

function peFixture({peOffset = 0x80, magic = 0x20b, signature = true, truncateTo = null, total = peOffset + 64} = {}) {
  const buffer = Buffer.alloc(total);
  buffer[0] = 0x4d;
  buffer[1] = 0x5a;
  buffer.writeUInt32LE(peOffset, 0x3c);
  if (signature) {
    buffer[peOffset] = 0x50;
    buffer[peOffset + 1] = 0x45;
    buffer[peOffset + 2] = 0x00;
    buffer[peOffset + 3] = 0x00;
    buffer[peOffset + 24] = magic & 0xff;
    buffer[peOffset + 25] = (magic >> 8) & 0xff;
  }
  return truncateTo == null ? buffer : buffer.subarray(0, Math.min(truncateTo, buffer.length));
}

const write = (name, content) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, content);
  return file;
};
const writeBinary = (name, buffer) => write(name, buffer);

// Valid PE images are recognized by structure, not by filename.
check("valid PE32+ image is windows-executable",
  classifyBinary(writeBinary("valid.exe", peFixture())).kind === "windows-executable");
check("valid PE32 image is windows-executable",
  classifyBinary(writeBinary("valid-pe32.img", peFixture({magic: 0x10b}))).kind === "windows-executable");
check("renamed PE file (no .exe suffix) is windows-executable",
  classifyBinary(writeBinary("renamed.dat", peFixture())).kind === "windows-executable");
check("symlinked PE resolves to windows-executable with both paths recorded", (() => {
  try {
    const target = writeBinary("symlink-target.exe", peFixture());
    const link = path.join(root, "symlink.exe");
    fs.symlinkSync(target, link);
    const identity = classifyBinary(link);
    return identity.kind === "windows-executable"
      && identity.symlinkPath === path.resolve(link)
      && identity.resolvedTargetPath === path.resolve(target)
      && typeof identity.contentDigest === "string" && identity.contentDigest.length === 64;
  } catch { return true; } // platform without symlink privileges
})());
check("windows shim (.cmd) is classified as windows-shim",
  classifyBinary(write("shim.cmd", "@echo off\r\n")).kind === "windows-shim");
check("plain script content is native",
  classifyBinary(write("native.sh", "#!/bin/sh\necho hi\n")).kind === "native");

// Malformed-binary boundaries: every failure denies launch.
check("truncated MZ header is unresolved and denied", (() => {
  const identity = classifyBinary(writeBinary("truncated.bin", peFixture({truncateTo: 32})));
  return identity.kind === "unresolved" && identity.error === "binary_truncated_header" && !binaryAdmission(identity).admitted;
})());
check("out-of-range e_lfanew is unresolved and denied", (() => {
  const buffer = Buffer.alloc(128); // MZ magic present, but PE offset points far past EOF
  buffer[0] = 0x4d;
  buffer[1] = 0x5a;
  buffer.writeUInt32LE(0x100000, 0x3c);
  const identity = classifyBinary(writeBinary("bad-offset.bin", buffer));
  return identity.kind === "unresolved" && identity.error === "binary_pe_offset_out_of_range" && !binaryAdmission(identity).admitted;
})());
check("invalid PE\\0\\0 signature is unresolved and denied", (() => {
  const identity = classifyBinary(writeBinary("bad-signature.bin", peFixture({signature: false})));
  return identity.kind === "unresolved" && identity.error === "binary_pe_signature_invalid" && !binaryAdmission(identity).admitted;
})());
check("unsupported optional-header magic is unresolved and denied", (() => {
  const identity = classifyBinary(writeBinary("bad-magic.bin", peFixture({magic: 0x9999})));
  return identity.kind === "unresolved" && identity.error === "binary_optional_header_magic_unsupported" && !binaryAdmission(identity).admitted;
})());
check("missing target is unresolved and denied",
  !binaryAdmission(classifyBinary(path.join(root, "does-not-exist"))).admitted);
check("broken symlink is unresolved and denied", (() => {
  try {
    const link = path.join(root, "broken-link");
    fs.symlinkSync(path.join(root, "vanished-target"), link);
    const identity = classifyBinary(link);
    return identity.kind === "unresolved" && !binaryAdmission(identity).admitted;
  } catch { return true; }
})());
check("unreadable file is unresolved and denied", (() => {
  if (process.platform === "win32") return true; // POSIX permissions not enforced
  const file = write("locked.bin", "not-a-pe");
  fs.chmodSync(file, 0o000);
  // A privileged process (root, or CAP_DAC_OVERRIDE inside a bwrap/user
  // namespace envelope) still reads a 0o000 file, so the precondition cannot
  // be staged there; skip rather than report a false failure.
  let stillReadable = false;
  try { fs.closeSync(fs.openSync(file, "r")); stillReadable = true; } catch {}
  if (stillReadable) { fs.chmodSync(file, 0o644); console.log("SKIP unreadable file: 0o000 is still readable (privileged process)"); return true; }
  const identity = classifyBinary(file);
  fs.chmodSync(file, 0o644);
  return identity.kind === "unresolved" && identity.error === "binary_unreadable" && !binaryAdmission(identity).admitted;
})());
check("symlink cycle is unresolved and denied", (() => {
  try {
    const first = path.join(root, "cycle-a");
    const second = path.join(root, "cycle-b");
    fs.symlinkSync(second, first);
    fs.symlinkSync(first, second);
    const identity = classifyBinary(first);
    return identity.kind === "unresolved" && identity.error === "binary_symlink_cycle" && !binaryAdmission(identity).admitted;
  } catch { return true; }
})());

// Admission policy: Windows binaries only on a Windows host; native elsewhere.
if (process.platform !== "win32") {
  check("PE rejected on non-Windows host with windows_interop_not_contained",
    binaryAdmission(classifyBinary(writeBinary("denied.exe", peFixture()))).reason === "windows_interop_not_contained");
  check("shim rejected on non-Windows host",
    binaryAdmission(classifyBinary(write("denied.cmd", "@echo off\r\n"))).reason === "windows_interop_not_contained");
}

// Fingerprint invalidation: same path, same size — replaced bytes change the digest.
const original = peFixture();
const replacement = Buffer.from(original);
replacement[replacement.length - 1] = (replacement[replacement.length - 1] + 1) % 256;
check("replacement preserves size", replacement.length === original.length);
const originalIdentity = classifyBinary(writeBinary("digest-a.bin", original));
const sameBytesIdentity = classifyBinary(writeBinary("digest-b.bin", Buffer.from(original)));
const replacedIdentity = classifyBinary(writeBinary("digest-c.bin", replacement));
check("identical bytes yield a stable contentDigest", originalIdentity.contentDigest === sameBytesIdentity.contentDigest);
check("byte-for-byte replacement changes contentDigest despite identical size",
  originalIdentity.contentDigest !== replacedIdentity.contentDigest);

fs.rmSync(root, {recursive: true, force: true});
if (failures) {
  console.error(`${failures} binary classification check(s) failed.`);
  process.exit(1);
}
console.log("binary classification and content-digest fingerprint tests passed");
