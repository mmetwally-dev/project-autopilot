// Tiny app server for the app_server gate tests (backlog #3). Listens on
// $PORT (127.0.0.1) and answers 200 on every path once FIXTURE_DELAY_MS has
// passed (503 before), after writing FIXTURE_STATE_FILE with its pid and a
// sha256 of $APP_SECRET (never the value). Every request path is appended to
// FIXTURE_REQUEST_LOG. FIXTURE_MODE: "exit" = exit 3 at once, "never-ready" =
// always 503, FIXTURE_ECHO_SECRET=1 = print $APP_SECRET to stdout (to test masking).
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";

const mode = process.env.FIXTURE_MODE || "";
if (process.env.FIXTURE_ECHO_SECRET) console.log(`booting with secret ${process.env.APP_SECRET}`);
if (mode === "exit") { console.error("fixture: failing on purpose"); process.exit(3); }
const delay = Number(process.env.FIXTURE_DELAY_MS || 0);
const startedAt = Date.now();
const log = process.env.FIXTURE_REQUEST_LOG;
const secret = process.env.APP_SECRET;
if (process.env.FIXTURE_STATE_FILE) {
  fs.writeFileSync(process.env.FIXTURE_STATE_FILE, JSON.stringify({
    pid: process.pid,
    port: process.env.PORT,
    secretSha: secret === undefined ? null : crypto.createHash("sha256").update(secret).digest("hex"),
  }));
}
http.createServer((req, res) => {
  if (log) fs.appendFileSync(log, `${req.url}\n`);
  const ready = mode !== "never-ready" && Date.now() - startedAt >= delay;
  res.statusCode = ready ? 200 : 503;
  res.end(ready ? "ok" : "starting");
}).listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`fixture listening on ${process.env.PORT}`));
