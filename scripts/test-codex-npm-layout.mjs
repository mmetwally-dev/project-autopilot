import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexNativeBinary, __resolveCacheTestHooks } from "./agent-process.mjs";
import { resolveRuntimeFiles } from "./autopilot.mjs";

const IS_WIN = process.platform === "win32";
const binName = IS_WIN ? "codex.exe" : "codex";
const hostName = IS_WIN ? "codex-code-mode-host.exe" : "codex-code-mode-host";
const tripleByPlatform = {
  linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
  darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
};
const pkgByPlatform = {
  linux: { x64: "codex-linux-x64", arm64: "codex-linux-arm64" },
  darwin: { x64: "codex-darwin-x64", arm64: "codex-darwin-arm64" },
  win32: { x64: "codex-win32-x64", arm64: "codex-win32-arm64" },
};
const triple = tripleByPlatform[process.platform][process.arch];
const pkgName = pkgByPlatform[process.platform][process.arch];

const dirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ap-codex-npm-${prefix}-`));
  dirs.push(d);
  return d;
}

try {
  __resolveCacheTestHooks.resetForTests();

  // (a) + (b): npm layout resolves to vendor codex and siblings exist beside it.
  {
    const root = tmp("layout");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const codexJs = path.join(binDir, "codex.js");
    fs.writeFileSync(codexJs, "#!/usr/bin/env node\n");
    fs.chmodSync(codexJs, 0o755);

    const vendorBin = path.join(root, "node_modules", "@openai", pkgName, "vendor", triple, "bin");
    fs.mkdirSync(vendorBin, { recursive: true });
    const nativeCodex = path.join(vendorBin, binName);
    const nativeHost = path.join(vendorBin, hostName);
    fs.writeFileSync(nativeCodex, "#!/bin/sh\necho codex\n");
    fs.chmodSync(nativeCodex, 0o755);
    fs.writeFileSync(nativeHost, "host\n");

    const resolved = resolveCodexNativeBinary(codexJs);
    assert.equal(path.resolve(resolved), path.resolve(nativeCodex),
      `resolver must return vendor codex (got ${resolved})`);

    const runtimeFiles = resolveRuntimeFiles(resolved, ["codex-code-mode-host"]);
    assert.equal(runtimeFiles.length, 1, "one runtime file expected");
    assert.equal(path.resolve(runtimeFiles[0]), path.resolve(nativeHost),
      "runtime file must be next to native binary");
    for (const f of runtimeFiles) {
      assert.ok(fs.existsSync(f), `runtime file must exist: ${f}`);
    }
  }

  // (c): native install (binary with sibling beside it) is unchanged.
  {
    const root = tmp("native");
    const nativeCodex = path.join(root, binName);
    const nativeHost = path.join(root, hostName);
    fs.writeFileSync(nativeCodex, "#!/bin/sh\necho codex\n");
    fs.chmodSync(nativeCodex, 0o755);
    fs.writeFileSync(nativeHost, "host\n");

    const resolved = resolveCodexNativeBinary(nativeCodex);
    assert.equal(path.resolve(resolved), path.resolve(nativeCodex),
      `native install must be unchanged (got ${resolved})`);
  }

  // (d): launcher with no vendor dir -> original path returned, no crash.
  {
    const root = tmp("novendor");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const codexJs = path.join(binDir, "codex.js");
    fs.writeFileSync(codexJs, "#!/usr/bin/env node\n");
    fs.chmodSync(codexJs, 0o755);

    const resolved = resolveCodexNativeBinary(codexJs);
    assert.equal(path.resolve(resolved), path.resolve(codexJs),
      `missing vendor must return original path (got ${resolved})`);
  }

  // PATH-based npm layout also resolves.
  {
    const root = tmp("pathlayout");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const codexJs = path.join(binDir, "codex.js");
    fs.writeFileSync(codexJs, "#!/usr/bin/env node\n");
    fs.chmodSync(codexJs, 0o755);

    const vendorBin = path.join(root, "node_modules", "@openai", pkgName, "vendor", triple, "bin");
    fs.mkdirSync(vendorBin, { recursive: true });
    const nativeCodex = path.join(vendorBin, binName);
    fs.writeFileSync(nativeCodex, "#!/bin/sh\necho codex\n");
    fs.chmodSync(nativeCodex, 0o755);
    fs.writeFileSync(path.join(vendorBin, hostName), "host\n");

    // symlink codex -> codex.js on PATH
    const pathBin = tmp("pathbin");
    const codexLink = path.join(pathBin, "codex");
    try { fs.symlinkSync(codexJs, codexLink); } catch { fs.copyFileSync(codexJs, codexLink); }

    const savedPath = process.env.PATH;
    __resolveCacheTestHooks.resetForTests();
    process.env.PATH = [pathBin, savedPath].join(":");
    try {
      const resolved = resolveCodexNativeBinary("codex");
      assert.equal(path.resolve(resolved), path.resolve(nativeCodex),
        `PATH npm layout must resolve to vendor codex (got ${resolved})`);
    } finally {
      process.env.PATH = savedPath;
    }
  }

  console.log("test-codex-npm-layout: all assertions passed");
} finally {
  __resolveCacheTestHooks.resetForTests();
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}
