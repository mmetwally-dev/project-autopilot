// Backlog #4 driver: runs the REAL gates(keepForVerifier) and
// relayVerifierWithApp() from autopilot.mjs in the throwaway repo (cwd).
// argv: <config.json> <mode>; modes: gate-only | verify-ok | verify-throw |
// verify-hang | verify-reused | verify-dead-holder | no-server. The "verifier" is a fake relay that
// records the brief it got and runs probes INSIDE the session's namespace.
// Prints one RESULT: JSON line.
import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {gatesForTests, relayVerifierWithAppForTests, phaseAppForTests} from "../autopilot.mjs";

const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const mode = process.argv[3];
const out = {mode};

const PROBE = `
const net=require("net"),http=require("http"),fs=require("fs");
const [base,decoy]=process.argv.slice(1);
const res={ns:fs.readlinkSync("/proc/self/ns/net")};
const tcp=(host,port)=>new Promise(r=>{const c=net.connect({host,port,timeout:2500});c.on("connect",()=>{c.destroy();r("connected")});c.on("timeout",()=>{c.destroy();r("timeout")});c.on("error",e=>r(e.code))});
(async()=>{
  res.server=await new Promise(r=>http.get(base+"/hello",x=>{x.resume();r(x.statusCode)}).on("error",e=>r(e.code)));
  res.decoy=await tcp("127.0.0.1",+decoy);
  res.outside=await tcp("1.1.1.1",80);
  console.log(JSON.stringify(res));
})();`;

function probeInNamespace(session) {
  const [bin, args] = session.spawnArgs([process.execPath, "-e", PROBE, session.baseUrl, process.env.DECOY_PORT || "1"]);
  const r = spawnSync(bin, args, {encoding: "utf8", timeout: 30000});
  try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch { return {error: (r.stderr || r.stdout || "no output").slice(-300)}; }
}

const state = {phaseIndex: 0};
if (mode === "gate-only") {
  const g = await gatesForTests(cfg, state);
  out.gateOk = g.ok;
  out.gateTail = g.tail;
  out.sessionAfterGate = !!phaseAppForTests();
} else {
  if (mode !== "verify-reused" && mode !== "no-server") {
    const g = await gatesForTests(cfg, state, {keepForVerifier: true});
    out.gateOk = g.ok;
    out.gateTail = g.tail;
    const kept = phaseAppForTests();
    out.sessionAfterGate = !!kept;
    if (kept) {
      out.holderPid = kept.holderPid;
      out.afterGate = probeInNamespace(kept);
      if (mode === "verify-dead-holder") {
        try { process.kill(-kept.holderPid, "SIGKILL"); } catch { try { process.kill(kept.holderPid, "SIGKILL"); } catch {} }
        const until = Date.now() + 3000;
        while (kept.alive() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
        out.staleSessionDetected = kept.alive() === false;
      }
    }
  }
  const fakeRelay = async (role, task) => {
    const session = phaseAppForTests();
    out.role = role;
    out.brief = task;
    if (session) {
      out.holderPidRelay = session.holderPid;
      out.holderPid = out.holderPid ?? session.holderPid;
      out.port = session.port;
      out.inRelay = probeInNamespace(session);
    }
    if (mode === "verify-throw") throw new Error("verifier crashed on purpose");
    if (mode === "verify-hang") { console.log(`HANG-READY ${session?.holderPid}`); await new Promise(() => {}); }
    return {ok: true};
  };
  try {
    await relayVerifierWithAppForTests("verify the phase", cfg, state, {}, fakeRelay);
  } catch (e) { out.thrown = e.message; }
  out.sessionAfterVerifier = !!phaseAppForTests();
}
console.log("RESULT:" + JSON.stringify(out));
process.exit(0);
