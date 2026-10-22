#!/usr/bin/env node
// Gate locality by imports (#20): a failing test that imports a file the
// phase changed (directly, or through one local module) must reach the
// implementer fix round instead of being escalated as "outside the phase".
// Fixtures live under $TMPDIR, never the project repo.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importsDeltaFile } from "./gate-locality-imports.mjs";
import { classifyGateFailures } from "./gate-failure-locality.mjs";

let ran = 0;
let failed = 0;
function check(name, fn) {
  ran++;
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name} :: ${error?.message || String(error)}`);
  }
}

function mapReader(sources) {
  return (filePath) => (Object.prototype.hasOwnProperty.call(sources, filePath) ? sources[filePath] : null);
}

try {
  check("direct static import of a delta file is inside", () => {
    const r = importsDeltaFile({
      testPath: "scripts/test-x.mjs",
      deltaPaths: ["scripts/config-layout.mjs"],
      readFile: mapReader({
        "scripts/test-x.mjs": 'import { x } from "./config-layout.mjs";\nconsole.log(x);\n',
      }),
    });
    assert.deepEqual(r, { inside: true, via: "scripts/config-layout.mjs" });
  });

  check("side-effect and export-from forms are inside", () => {
    const r = importsDeltaFile({
      testPath: "scripts/test-x.mjs",
      deltaPaths: ["scripts/config-layout.mjs"],
      readFile: mapReader({
        "scripts/test-x.mjs": 'import "./config-layout.mjs";\nexport { x } from "./config-layout.mjs";\n',
      }),
    });
    assert.deepEqual(r, { inside: true, via: "scripts/config-layout.mjs" });
  });

  check("two-level import (local module imports the delta file) is inside", () => {
    const r = importsDeltaFile({
      testPath: "scripts/test-x.mjs",
      deltaPaths: ["scripts/config-layout.mjs"],
      readFile: mapReader({
        "scripts/test-x.mjs": 'import { helper } from "./helper.mjs";\nhelper();\n',
        "scripts/helper.mjs": 'import { layout } from "./config-layout.mjs";\nexport const helper = () => layout;\n',
      }),
    });
    assert.deepEqual(r, { inside: true, via: "scripts/config-layout.mjs" });
  });

  check("three-level import is outside (maxDepth 2)", () => {
    const r = importsDeltaFile({
      testPath: "scripts/test-x.mjs",
      deltaPaths: ["scripts/config-layout.mjs"],
      readFile: mapReader({
        "scripts/test-x.mjs": 'import { a } from "./a.mjs";\na();\n',
        "scripts/a.mjs": 'import { b } from "./b.mjs";\nexport const a = b;\n',
        "scripts/b.mjs": 'import { layout } from "./config-layout.mjs";\nexport const b = layout;\n',
      }),
    });
    assert.deepEqual(r, { inside: false, via: null });
  });

  check("no import of a delta file is outside", () => {
    const r = importsDeltaFile({
      testPath: "scripts/test-x.mjs",
      deltaPaths: ["scripts/config-layout.mjs"],
      readFile: mapReader({
        "scripts/test-x.mjs": 'import { x } from "./unrelated.mjs";\nconsole.log(x);\n',
        "scripts/unrelated.mjs": "export const x = 1;\n",
      }),
    });
    assert.deepEqual(r, { inside: false, via: null });
  });

  check("bare package imports are ignored", () => {
    const r = importsDeltaFile({
      testPath: "scripts/test-x.mjs",
      deltaPaths: ["scripts/config-layout.mjs"],
      readFile: mapReader({
        "scripts/test-x.mjs": 'import fs from "node:fs";\nimport x from "config-layout";\nconst y = require("some-package");\n',
      }),
    });
    assert.deepEqual(r, { inside: false, via: null });
  });

  check("dynamic import form is inside", () => {
    const r = importsDeltaFile({
      testPath: "scripts/test-x.mjs",
      deltaPaths: ["scripts/config-layout.mjs"],
      readFile: mapReader({
        "scripts/test-x.mjs": 'const mod = await import("./config-layout.mjs");\n',
      }),
    });
    assert.deepEqual(r, { inside: true, via: "scripts/config-layout.mjs" });
  });

  check("require form resolves extensionless specifiers", () => {
    const r = importsDeltaFile({
      testPath: "scripts/test-x.mjs",
      deltaPaths: ["scripts/config-layout.mjs"],
      readFile: mapReader({
        "scripts/test-x.mjs": 'const mod = require("./config-layout");\n',
      }),
    });
    assert.deepEqual(r, { inside: true, via: "scripts/config-layout.mjs" });
  });

  check("relative specifiers resolve against the test's own directory", () => {
    const r = importsDeltaFile({
      testPath: "scripts/deep/test-x.mjs",
      deltaPaths: ["scripts/deep/config-layout.mjs"],
      readFile: mapReader({
        "scripts/deep/test-x.mjs": 'import { x } from "./config-layout.mjs";\n',
      }),
    });
    assert.deepEqual(r, { inside: true, via: "scripts/deep/config-layout.mjs" });
  });

  check("fixture: failing test importing a phase-changed module reaches the fix round", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-locality-imports-"));
    try {
      fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(root, "scripts", "config-layout.mjs"), "export const layout = 1;\n");
      fs.writeFileSync(
        path.join(root, "scripts", "test-p22-escalation-model.mjs"),
        'import { layout } from "./config-layout.mjs";\nif (layout !== 2) throw new Error("stale fixture failure");\n',
      );
      const locality = classifyGateFailures({
        failingFiles: ["scripts/test-p22-escalation-model.mjs"],
        phaseDeltaFiles: ["scripts/config-layout.mjs"],
      });
      assert.equal(locality.allOutsideDelta, true);
      const imported = importsDeltaFile({
        testPath: "scripts/test-p22-escalation-model.mjs",
        deltaPaths: ["scripts/config-layout.mjs"],
        readFile: (filePath) => {
          try { return fs.readFileSync(path.join(root, filePath), "utf8"); } catch { return null; }
        },
      });
      assert.deepEqual(imported, { inside: true, via: "scripts/config-layout.mjs" });
      const fixRound = !(locality.allOutsideDelta && !imported.inside);
      assert.equal(fixRound, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  check("wiring: autopilot uses importsDeltaFile in the locality decision", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
    assert.match(source, /from ["']\.\/gate-locality-imports\.mjs["']/);
    assert.match(source, /importsDeltaFile\(\{/);
    assert.match(source, /gate locality: .* imports .* → fix round/);
  });
} finally {
  // temp fixtures clean themselves up in the case above
}

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
