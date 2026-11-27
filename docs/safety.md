## Safety model

- **Autopilot never runs `git commit` or `git push`.** Roles are blocked from
  committing, pushing and clearly destructive Git or shell commands
  (`safety.block_git_in_roles`, `safety.allow_git_commit/push: false`). A
  harmless Git call that is blocked only warns; a blocked history or tree change
  stops the run. You own every commit.
- **Read-only reviewers.** `plan_reviewer`, `code_reviewer` and `verifier`
  cannot change your repository:
  - **Strong mode** (Linux / WSL2): `bubblewrap` mounts the repository
    read-only and gives the role a separate writable scratch folder. This is
    OS-enforced. If bubblewrap is missing, the role fails with
    `READ_ONLY_CONTAINMENT_UNAVAILABLE` rather than running unprotected.
  - **Windows Compatibility mode** (Native Windows, SpecKit and standalone): the
    role works on a throwaway copy of the repository (disposable-copy isolation).
    This protects your files but is **not** OS-enforced containment.
- **Every run is checked.** A Git snapshot before and after each role and a list
  of touched files are recorded for every role, whatever the containment. A
  read-only role that changed something stops the mission
  (`Relay policy violation: read_only_violation`).
- **Scratch zone.** Read-only roles write temporary files (Playwright specs,
  screenshots, traces) in their own `scratch/` folder under `.autopilot/`;
  anything written elsewhere in the repository still counts as a violation.
- **Agent config folders are protected.** `.agent/`, `.claude/`, `.opencode/`,
  `.commandcode/` and `.mimocode/` are always fingerprinted, even when
  git-ignored. A write there during a read-only stage stops the run.
- **Gates without network.** Gate commands run without network
  (`unshare --net`) on Linux unless `tests.gate_network: true`; only the
  environment variables in `tests.gate_env_allowlist` are passed. On Windows,
  setup decides this from the runtime mode (no network inside WSL; with network
  in Windows Compatibility, which cannot isolate it) and prints its choice; on
  macOS it asks once whether gates may run without this isolation.
- **App server for the gate.** With `tests.app_server` set, the gate starts the
  configured server (its own process group, free port) before the gate commands
  and always stops it afterwards, also on SIGTERM / `ap stop`. Values from its
  `env_file` and `env` are passed to the server process only: they are not given
  to gate commands and are masked by variable name in any server output the gate
  records. The server starts inside a fresh network namespace (`unshare -Urn`
  with loopback up and no other interface); the gate commands join that same
  namespace (`nsenter`), so network isolation stays on and they reach
  `127.0.0.1:<port>` but not the host loopback, the LAN or the internet. A
  passing gate leaves the server running for the verifier run of the same phase
  (the verifier brief carries `APP_BASE_URL`); the server and the namespace are
  stopped when that run ends, on failure, on SIGTERM / `ap stop` and when
  the orchestrator dies. The verifier agent process itself keeps the host network
  (its provider calls need it); only the namespace-joined commands reach the
  server. `tests.app_server.allow_hosts` (for example the project's Supabase and
  PowerSync domains, so sign-in and browser-side calls can work) cannot be
  enforced per host on the server process without root, so with it set the
  server runs on the host network (it can reach the whole outside network),
  while the gate commands and the browser stay in the closed namespace and reach
  the server only through a unix-socket bridge. For the verifier's browser,
  `allow_hosts` IS strictly enforced per host: an allowlisting HTTP CONNECT
  proxy runs on the host (only `allow_hosts` on port 443; any other host, port
  or method is refused with `403` and logged) and is exposed inside the
  namespace through a second unix-socket bridge, and `ap-browser-check` launches
  Chromium with `--proxy-server=http://127.0.0.1:<proxyPort>` and
  `--proxy-bypass-list=127.0.0.1;localhost` (when `allow_hosts` is empty, no
  proxy is started and the browser is completely closed). Flows that need an
  email inbox (invitation / password-reset links) stay manual checks. Leave
  `allow_hosts` empty unless sign-in or browser calls need it; keep `env` to
  test values. When the server is up and Playwright +
  Chromium are installed, the verifier's only approved browser command is
  `ap-browser-check <script.mjs>` (placed in the run's PATH guard directory): it
  runs the verifier's Playwright script inside the read-only envelope, joined to
  the server's network namespace, with headless Chromium (`--no-sandbox`).
  The verifier brief and the wrapper environment see only login variable names
  and values (by default names starting with `E2E_` or `TEST_` and ending with
  `EMAIL`, `USER`, `USERNAME` or `PASSWORD`, or `tests.app_server.credential_vars`
  when set); other `env_file` secrets stay server-only, while all secret values
  remain masked in all wrapper output and logs. It saves the script, screenshots (`.png`), a
  Playwright trace (`trace.zip`, viewable with `npx playwright show-trace
  <trace.zip>`) and a video (`.webm`) in `<runDir>/browser-check/`. The
  orchestrator accepts a browser PASS only when `ap-browser-check` actually ran
  and recorded exit code 0, output, the script and at least one screenshot;
  otherwise the browser check counts as not done (`MANUAL-CHECKS.md`).
  Screenshots are always kept; videos and traces are kept for the last verifier
  run of each phase and for failed runs, and deleted automatically 3 days after
  recording.
- **Only one guarded way to run shell commands.** A static test
  (`scripts/test-no-unguarded-shell.mjs`) fails the build if code runs a shell
  command outside the single guarded executor.

The Git guard is defense in depth for normal Git commands, not a wall against a
hostile process: a child that calls an absolute Git path and overrides
`GIT_CONFIG_*` can get past the hook layer. Read-only mounts and disposable
copies protect your local repository but cannot stop a remote push, so do not
give agents push-capable credentials; use read-only tokens and server-side branch
protection. Writable roles are checked after the fact (detection, not prevention).
