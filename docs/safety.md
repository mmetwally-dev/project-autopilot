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
- **Only one guarded way to run shell commands.** A static test
  (`scripts/test-no-unguarded-shell.mjs`) fails the build if code runs a shell
  command outside the single guarded executor.

The Git guard is defense in depth for normal Git commands, not a wall against a
hostile process: a child that calls an absolute Git path and overrides
`GIT_CONFIG_*` can get past the hook layer. Read-only mounts and disposable
copies protect your local repository but cannot stop a remote push, so do not
give agents push-capable credentials; use read-only tokens and server-side branch
protection. Writable roles are checked after the fact (detection, not prevention).
