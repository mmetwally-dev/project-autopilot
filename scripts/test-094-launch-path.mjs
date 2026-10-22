#!/usr/bin/env node
import fs from "node:fs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
};

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const start = src.indexOf("onStart:({pid})=>{");
const end = src.indexOf("onChunk:", start);
const block = start >= 0 && end > start ? src.slice(start, end) : "";

check("launch path: onStart located", start >= 0 && end > start);
check("launch path: onStart no longer calls refreshWatchReport synchronously",
  !/refreshWatchReport\s*\(/.test(block));
check("launch path: onStart schedules cached refresh (throttledWatchRefresh)",
  /throttledWatchRefresh\s*\(/.test(block));

if (failures) { console.error(`${failures} launch-path check(s) failed.`); process.exit(1); }
console.log("launch-path tests passed");
