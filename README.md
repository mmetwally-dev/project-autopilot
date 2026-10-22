<div align="center">
  <h1>Project Autopilot</h1>
  <h3><em>Give it a request. It plans, codes, reviews and tests the work with your coding agents, until it passes.</em></h3>
</div>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"/></a>
  <img src="https://img.shields.io/badge/version-12.0.0-informational" alt="Version 12.0.0"/>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node 18 or newer"/>
</p>

Project Autopilot (`ap`) runs a team of AI coding agents on your repository.
You write what you want in one sentence. Autopilot gives each step to a
different agent and checks every result before it moves on:

```text
Planning → Plan Review → Implementation → Code Review → Gate (your tests) → Verification → Final Review → you commit
```

- A **planner** writes the plan and a task list.
- A **plan reviewer** checks the plan. The planner fixes it until the reviewer approves.
- An **implementer** codes the tasks, one task per session.
- A **code reviewer** checks each phase. The implementer fixes what it finds.
- Your **test suite** (the gate) runs after each phase.
- A **verifier** checks the phase against the plan and the test results.
- A **final review** checks the whole change once at the end.

Each role can be a different CLI and model, for example Claude Code for
planning and review and a free opencode model for coding. The reviewers run
read-only, and **Autopilot never commits or pushes**: when the mission is done,
the changes wait in your working tree for you to review and commit.

## Install

Needs Node.js 18+, Git and at least one signed-in agent CLI
([details](#get-started)).

```bash
npm install -g github:mmetwally-dev/project-autopilot
cd your-project && ap setup
ap run "your request"
```

`ap` is installed **once per machine**; each project is set up **once with
`ap setup`** (its own settings, slash commands and missions in `.autopilot/`).
If you forget, the first `ap run` in a project starts the setup by itself.
To update to a new version, run the same `npm install -g` command again; your
projects keep their settings.

## Contents

- [Install](#install)
- [Choose how to use it](#choose-how-to-use-it)
- [Get started](#get-started)
- [How a mission works](#how-a-mission-works)
- [What runs where: support status](#what-runs-where-support-status)
- [Commands](#commands)
- [Slash commands in your agent](#slash-commands-in-your-agent)
- [Adhoc reviews (plan-review, code-review, verify-file)](#adhoc-reviews-plan-review-code-review-verify-file)
- [Mission control: stop, cancel, reset, rebase, finding](#mission-control-stop-cancel-reset-rebase-finding)
- [Watching a mission: the WATCH-REPORT](#watching-a-mission-the-watch-report)
- [Roles, models and fallbacks](#roles-models-and-fallbacks)
- [Limits: caps, retries and timeouts](#limits-caps-retries-and-timeouts)
- [Safety model](#safety-model)
- [Platforms and runtime modes](#platforms-and-runtime-modes)
- [Planning frameworks: standalone, SpecKit, GSD](#planning-frameworks-standalone-speckit-gsd)
- [Configuration](#configuration)
- [Files Autopilot creates](#files-autopilot-creates)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)
- [Known limitations](#known-limitations)
- [Development and tests](#development-and-tests)
- [Configuration reference](#configuration-reference)

## Choose how to use it

| What you need | Run | Outcome |
| --- | --- | --- |
| Build a feature or fix a bug from start to finish | `ap run "<request>"` | A reviewed plan, coded and tested phase by phase, waiting in your working tree |
| Only a reviewed plan, to read before any code is written | `ap run --stage planning "<request>"` | `PLAN.md` + `TASKS.md` approved by the plan reviewer |
| Run one step of an open mission yourself | `ap run --stage implement \| review \| verify` | That one step for the current phase, then it stops |
| A second opinion on a plan you already have | `ap plan-review <plan-file>` | A verdict and findings; nothing is changed |
| A review of a commit, a range, a diff or a folder | `ap code-review <target>` | A verdict and findings; nothing is changed |
| Check code against a list of requirements | `ap verify-file <criteria-file> [--cmd "<tests>"]` | A verdict per requirement, with the test output as evidence |

The same commands are available as `/ap.*` slash commands inside Claude Code,
opencode and Antigravity (see [Slash commands](#slash-commands-in-your-agent)).

## Get started

**You need:** Node.js 18 or newer, Git, and at least one supported coding-agent
CLI that is installed and signed in (Claude Code, opencode, Codex or Antigravity).
On Linux and WSL2 you also need `bubblewrap` for the read-only reviewers
(`sudo apt install bubblewrap` on Debian/Ubuntu).

**1. Install** — one command, then `ap` works in every terminal:

```bash
npm install -g github:mmetwally-dev/project-autopilot
```

**2. Set up a project** — from the project folder (a Git repository):

```bash
cd my-project
ap setup
```

The setup wizard finds the installed CLIs and planning frameworks, asks which
CLI and model each role uses, suggests a test command for the gate, saves
`.autopilot/config.json`, adds `.autopilot/` to `.gitignore`, and installs the
`/ap.*` slash commands for the agents it found. If you skip this step,
`ap run` starts the wizard by itself the first time.

**3. Run a mission:**

```bash
ap run "Add a dark-mode toggle to the settings page"
```

**4. Watch it** — open `.autopilot/missions/<NNN-name>/WATCH-REPORT.md`. It
refreshes as the mission runs (see [WATCH-REPORT](#watching-a-mission-the-watch-report)).

**5. Review and commit** — the mission ends with
`ALL WORK COMPLETE — HUMAN COMMIT REQUIRED`. Read the diff (`git diff`) and
commit it yourself.

A mission can take a long time (tens of minutes to hours). To keep it running
after you close the terminal, use `ap run --detach "<request>"` on Linux/WSL2;
it runs under `systemd-run` when available (otherwise `setsid`) and writes
its output to the mission's `orchestrator.log`.

### Other ways to install

- **Update:** run the same `npm install -g …` command again.
- **Remove the CLI:** `npm uninstall -g project-autopilot`. To remove Autopilot from
  one project instead, run `ap uninstall` there (see [Commands](#commands)).
- **From a local folder:** `npm install -g <path-to-project-autopilot>`.
- **Developing the skill itself:** run `npm link` once inside the checkout; `ap`
  then runs that folder, so every edit is live. `npm unlink -g project-autopilot` undoes it.
- **No global install:** `node <path>/bin/ap.cjs <command>` always works.
  Two thin launchers ship beside it: `bin/ap.cmd` for Native Windows (uses the
  Windows `node`) and `bin/ap` for Linux/WSL2 (uses the distro's `node`). They
  only forward the arguments and the exit code. On WSL2, `bin/ap` refuses a
  Windows `node.exe` reached through interop instead of running the wrong runtime.
- **WSL2:** a Windows `ap` hands WSL2 missions over to WSL by itself. To type
  `ap` inside a WSL shell too, run the same `npm install -g` there with the Linux `npm`.
- **Coding-agent skill discovery (optional):** to let an agent find the skill
  through its `SKILL.md`, place the folder in your agent's skills directory
  (for example `npx skills add <path>`). Typing `ap` yourself does not need this.
- **Browser checks:** the verifier can use Playwright when a task needs a
  browser. Install the browser once with `npm run playwright:install` from the
  package folder.

If Node.js is missing, the launchers say that Node.js 18 or newer is required
and exit with code `127`; nothing is downloaded or changed.

There is no signing, certification or admin install. Each `ap run` does a quick
**preflight** instead: it checks that each configured CLI exists and answers
`--version`/`--help`, that the configured model/effort/variant flags exist for
that CLI, and that the repository and scratch paths are usable. A failed
preflight is a plain error message. (`ap adapter certify` and `ap adapter status`
still exist for old scripts; they only print that certification is no longer needed.)

## How a mission works

A **mission** is one request carried from plan to finished code. Each mission
has its own folder, `.autopilot/missions/<NNN>-<slug>/`, which keeps the plan,
the task list, the logs and the report after the mission ends.

### 1. Planning and plan review

The planner reads the repository and writes `PLAN.md` (goal, scope, design)
and `TASKS.md` (phases of small tasks). Every task is one concrete action on
about one file, names the exact paths, and says how it is accepted and how to
verify it, for example:

```text
- [ ] **1.2** Add `fillConfigFile()` to `scripts/config-fill.mjs` with a timestamped backup
      — accept: the file gains the defaults and the backup matches the original
      ; verify: node scripts/test-config-fill-file.mjs
```

The read-only plan reviewer then reads the plan against the request and the
code. If it finds problems (verdict **DENIED**), the planner revises and the
reviewer looks again, up to `retries.plan_revisions` rounds (default 8). An
**APPROVED** plan moves on to coding. With `ap run --stage planning` the mission
stops here so you can read the plan first.

### 2. Implementation, phase by phase

For each phase:

1. **Implementer** — each task runs in its own fresh session. If a task hits
   its turn or token cap, the implementer writes a hand-off note
   (`handoff/<task>.md`: what is done, what is next) and a new session continues
   from it, up to `caps.implementer.extra_sessions` more sessions (default 5).
2. **Code review** — the read-only code reviewer checks the phase's changes. On
   DENIED, only the tasks named by the findings are re-run with the findings
   attached, and the reviewer then checks just its earlier findings plus the fix.
3. **Gate** — Autopilot itself runs your test commands (`tests.gate_commands`,
   for example `npm test`). If tests fail, it re-runs them against the code as it
   was before the phase: tests that also failed before are not blamed on this
   phase; new failures go back to the implementer as a fix round.
4. **Verifier** — the read-only verifier checks every task of the phase against
   its acceptance line, using the gate's results as evidence, and only then
   ticks the tasks done in `TASKS.md`. Browser tasks can be checked with Playwright.

A failed review or verification sends the work back to the implementer. Each
kind of failure has its own budget (`retries.implementation`,
`retries.verification`, default 4). When a budget runs out the mission
**escalates** (see below) instead of looping forever.

### 3. Final review

When every phase has passed, the code reviewer reads the whole mission's
change once more. Findings get up to `retries.final_review_fix_rounds` fix
rounds (default 2). When it approves, the mission is **COMPLETED** and prints
`ALL WORK COMPLETE — HUMAN COMMIT REQUIRED`.

### When a mission stops: escalation

If Autopilot cannot finish safely — a budget is spent, a task stops making
progress, a CLI keeps failing, or something unexpected touched the repository —
it **escalates**: it saves its state, prints the reason and
`STOP — human intervention required`, and the report shows `ESCALATED`. Nothing
is reverted. Read the reason (the last lines of the run, or the WATCH-REPORT),
fix the cause, then:

- `ap run` (no request) resumes the same mission where it stopped;
- `ap reset` first, if the stop was a spent budget, gives it fresh attempts;
- `ap cancel` ends the mission if you want to give up on it.

The messages name the exact command when one is needed, for example
`Resume: ap reset --scope <key> then ap run`.

### Resuming and starting over

- `ap run` with **no request** resumes the open mission from its last checkpoint
  and re-runs only unfinished work. The same happens with the **same** request.
- `ap run "<a different request>"` while a mission is open **abandons** that
  mission and starts a new one. It does not ask (a question would break
  unattended runs); it prints a clear takeover block instead: which mission is
  abandoned, at which step, what survives (the mission folder, your files, your
  Git tree — nothing is reverted) and which spent failure counters are cleared
  for the new mission. Use `ap cancel` to end a mission without starting another.

### Smarter retries

- **Escalation model.** The planner and implementer can have a stronger
  `escalation_model`. If a reviewer reports the same finding as *not fixed*
  `retries.escalate_after_not_fixed` times in a row (default 2), the next fix
  round runs on the escalation model, once per scope, then the role returns to
  its normal model.
- **No-progress stop.** A continuation session that changes no project file is
  "no progress". After `retries.no_progress_sessions` of them in a row
  (default 2) the task stops early instead of using up all its sessions. The next
  session's brief quotes the code lines the hand-off note points at, so it can
  edit right away.
- **Hung sessions.** A session that prints nothing, runs nothing and writes
  nothing for `time_limits.silent_run_minutes` (default 10) is stopped as
  `IDLE_HANG`; a provider rate-limit storm is caught as `RATE_LIMITED`. Both count
  as retryable infrastructure failures, not as the agent's fault.

## What runs where: support status

**Fully supported and tested in this version** — standalone and SpecKit
projects; the Claude Code, opencode, Codex and Antigravity CLIs as roles; Linux,
WSL2 and Native Windows.

**Not yet reviewed in this version — coming in a future version:**

- **GSD** projects. The GSD adapter is in the code (phase PLANs, waves,
  planning-review stages), but it has not been reviewed and tested end to end
  for this release. Its documentation and support will be completed in a future
  version; use standalone or SpecKit for now.
- **Cursor** (`cursor-agent`). It is accepted as a role CLI and appears in the
  setup list, but it has not been reviewed or tested yet. Full support and
  documentation are planned for a future version.

| | Role CLI (runs planner/implementer/reviewers) | `/ap.*` slash commands | Model list in `ap config` |
| --- | --- | --- | --- |
| Claude Code (`claude`) | Yes | Yes — `.claude/commands/ap.<cmd>.md` | Documented aliases (no live list command) |
| opencode (`opencode`) | Yes, incl. free `*-free` models | Yes — `.opencode/command/ap.<cmd>.md` | Live (`opencode models`) |
| Codex (`codex`) | Yes | No (see below) | Live (app-server `model/list`) |
| Antigravity (`agy`) | Yes | Yes, in the `agy` CLI — `.agents/skills/ap.<cmd>/SKILL.md` | Manual entry |
| Cursor (`cursor-agent`) | Not yet reviewed — future version | No (see below) | Not yet reviewed |

| Framework | Status |
| --- | --- |
| Standalone (no framework) | Supported — the default; plans live in the mission folder |
| SpecKit | Supported |
| GSD | Not yet reviewed — future version (needs Strong mode) |

| Platform | Mode | Read-only reviewers |
| --- | --- | --- |
| Linux | `linux-strong` | OS-enforced with bubblewrap |
| WSL2 (Windows) | `wsl2-strong` (recommended on Windows) | OS-enforced with bubblewrap |
| Native Windows | `windows-compatibility` | Disposable-copy isolation (not OS-enforced) |
| macOS | not tested | — |

## Commands

Every command takes `--repo <path>`; the default is the current folder.

| Command | What it does |
| --- | --- |
| `ap setup` | First-time setup wizard for this project (roles, models, gate, runtime mode); also installs the slash commands |
| `ap run ["<request>"]` | Run a mission from start to finish; with no request, resume the open one |
| `ap run --stage <planning\|implement\|review\|verify>` | Run one stage only, then stop |
| `ap run --detach ["<request>"]` | Run in the background (Linux/WSL2) |
| `ap stop [--yes] [--dry-run]` | Stop the running mission but keep it; `ap run` continues it |
| `ap cancel ["<reason>"] [--yes] [--dry-run]` | End the mission for good (stops a live run first) |
| `ap reset [--scope <key>]` | Give spent retry counters a fresh start |
| `ap rebase [--note "<why>"] [--yes]` | Accept your own edits made while a mission was paused |
| `ap finding list` / `ap finding drop <n> [--note "<why>"] [--yes]` | List the current review findings / drop one you disagree with |
| `ap config [--role <role>]` | Change roles, models and options interactively |
| `ap config show [--path <key.path>]` | Print the effective settings, each marked `[default]` or `[from config.json]` |
| `ap config fill [--dry-run]` | Add every missing setting at its default (after an upgrade) |
| `ap commands` | Re-install the `/ap.*` slash-command files |
| `ap plan-review <plan-file>` | Review a plan file, outside any mission |
| `ap code-review <target>` | Review a commit, range, diff file or folder, outside any mission |
| `ap verify-file <criteria-file> [--cmd "<tests>"]` | Check the code against a list of requirements, outside any mission |
| `ap uninstall [--dry-run] [--yes] [--keep-missions]` | Remove Autopilot from this project only |
| `ap help` | Print the command list |

**Exit codes:** `0` success, a dry-run preview, or nothing to do; `1` a refusal or
failure (prompt answered `N`, `--yes` missing without a terminal, kill failed,
several live runs, reset with nothing to clear); `2` usage errors such as
`Unknown command`; `127` a launcher found no Node.js 18+.

**Confirmations.** `stop`, `cancel`, `rebase`, `finding drop` and `uninstall`
print exactly what they will do and ask `y/N`. `--dry-run` shows the plan and
changes nothing; `--yes` skips the question and is required when there is no
terminal (a script never changes state silently). `run` and `reset` never ask.

**Windows + WSL2.** With a saved `wsl2-strong` mode, `run`, `stop` and `cancel`
typed on Windows hand over to WSL, so they act where the mission really runs.

**From a batch file,** call any `.cmd` shim as `call ap ...`, otherwise CMD does
not return to your script.

`ap status` and `ap watch` are not commands; the WATCH-REPORT is the status view.

## Slash commands in your agent

`ap setup` (or `ap commands`) installs one set of `/ap.*` commands, with the
same SpecKit-style dot names in every supported agent, for the agents it finds
on your PATH. Open a new session in that agent afterwards. Type them in the
agent's **chat**; each one runs the matching terminal command, and anything you
type after the command is passed on as its arguments.

| Slash command | Does | Same as |
| --- | --- | --- |
| `/ap.run` | The whole job: plan, code, review, test until done. All phases, with fix rounds | `ap run` |
| `/ap.plan` | Step 1 only: write a reviewed plan + task list, then stop (includes the plan review) | `ap run --stage planning` |
| `/ap.implement` | Step 2 only: code the current phase, then stop (no review) | `ap run --stage implement` |
| `/ap.review` | Step 3 only: review the code just written, then stop | `ap run --stage review` |
| `/ap.verify` | Step 4 only: test the code just reviewed and tick its tasks done | `ap run --stage verify` |
| `/ap.plan-review` | Review a plan file you give (outside any mission) | `ap plan-review <plan-file>` |
| `/ap.code-review` | Review a commit, range, diff or folder (outside any mission) | `ap code-review <target>` |
| `/ap.verify-file` | Check the code against your requirements list (outside any mission) | `ap verify-file <criteria-file> [--cmd "..."]` |
| `/ap.stop` | Pause the running mission (continue later with `/ap.run`) — user-only | `ap stop --yes` |
| `/ap.cancel` | End the current mission for good — user-only | `ap cancel --yes` |

- `/ap.plan` and `/ap.run` can start a new mission from a request or resume the
  open one. `/ap.implement`, `/ap.review` and `/ap.verify` need an already-planned
  mission, act on its current phase only, and work with standalone missions only.
- **User-only:** `/ap.stop` and `/ap.cancel` can only be typed by you, never
  started by the model (Claude Code: `disable-model-invocation: true`; opencode
  commands are user-typed by design). Typing them is the confirmation, so they
  pass `--yes`. `ap stop` stops only the mission's own process, never your chat session.
- `reset`, `rebase`, `uninstall`, `setup` and `config` are terminal-only.

Where the files go: Claude Code `.claude/commands/ap.<cmd>.md`, opencode
`.opencode/command/ap.<cmd>.md`, Antigravity `.agents/skills/ap.<cmd>/SKILL.md`.
Generated files carry a marker; your own files are never touched, and older
generated names (`.claude/commands/ap/*.md`, `.opencode/command/ap-*.md`) are
cleaned up by `ap setup`, `ap commands` and `ap uninstall`.

**Agents without slash commands:**

- **Codex** — no verifiable custom-prompt loader in codex 0.150.1 (no
  `~/.codex/prompts` support found in the binary). Codex still works as a role
  CLI; use the terminal commands.
- **Cursor** — the `.cursor/commands` format is not verifiable offline (no Cursor
  CLI installed when this was built). Planned for a future version together with
  Cursor role support.

**Antigravity notes.** `/ap.*` commands are verified in the `agy` CLI (1.3.4+).
The Antigravity IDE (2.5.x) shows no slash commands at all when the workspace
is in WSL, so IDE-over-WSL is not supported yet. `/ap.stop` and `/ap.cancel` are
not generated for Antigravity, because its skills can be started by the model
with no way to turn that off; use `ap stop --yes` / `ap cancel --yes` in a terminal.
Headless `agy` runs use `--mode accept-edits` for writing roles and
`--mode plan` for read-only roles, never `--dangerously-skip-permissions`; a
write run that needs a command permission fails clearly with `PERMISSION_DENIED`.

## Adhoc reviews (plan-review, code-review, verify-file)

One-shot reviews that run **outside any mission**: they change no mission
state and never commit. They use the same role configuration as missions.

```bash
ap plan-review docs/PLAN.md                     # role plan_reviewer
ap code-review HEAD~3..HEAD                     # a range
ap code-review --commit 1a2b3c4                 # one commit
ap code-review --diff-file my-change.diff       # a diff file
ap code-review src/payments                     # a folder
ap verify-file requirements.md --cmd "npm test" # role verifier, with test evidence
```

- `ap code-review` takes `<range> | <commit> | <diff-file> | <path>`, or the
  explicit `--range <a..b>`, `--commit <sha>`, `--diff-file <file>`.
- `ap verify-file` reads a criteria file (one requirement per line or bullet).
  With `--cmd`, Autopilot runs that command first, outside the reviewer's
  sandbox and never in a way that can write to your repository, and gives its
  output to the verifier as evidence.

**Refusals** (exit 2, nothing runs): missing or unreadable input, `verify-file`
with no checkable criteria, `code-review` with an invalid range/commit or a diff
it cannot resolve, and `--cmd` on anything but `verify-file`. Agent/runtime
failures exit 1.

**Output** goes to `.autopilot/adhoc/<timestamp>-<role>/summary.md` (verdict,
findings and the `--cmd` evidence), plus `cmd-evidence.txt` when `--cmd` was used.
The agent run's own files are in a `NN-<role>-<id8>/` subfolder named in the summary.

## Mission control: stop, cancel, reset, rebase, finding

Five operator-only commands act on the **active** mission. Every one records
what it did in `state.json` and in the WATCH-REPORT, so the history stays readable.

| You want to… | Use |
| --- | --- |
| pause now and continue later | `ap stop` |
| give up on this mission | `ap cancel` |
| retry after a budget ran out | `ap reset`, then `ap run` |
| keep your own edits made during a pause | `ap rebase --note "<why>"`, then `ap run` |
| reject a review finding you disagree with | `ap finding list`, `ap finding drop <n>` |

```bash
ap stop --dry-run                          # show the live process; kill nothing
ap stop --yes                              # stop now, keep the mission
ap cancel "superseded by a new request"    # shows the plan, asks y/N
ap cancel --dry-run
ap reset                                   # clear every spent counter
ap reset --scope infrastructureRetryBudget:mission
ap reset --scope standalone:P2:T1:7d1f10325a73   # one task's session allowance (bare task id)
ap rebase --note "fixed the import path by hand" --yes
ap finding list
ap finding drop 4 --note "operator code, not phase work" --yes
```

### `ap stop` — pause, keep the mission

Stops the live run and keeps everything: state, checkpoints, counters. It sends
SIGTERM, waits 10 seconds so the run can save its state, and only then SIGKILL
(`taskkill /T`, then `/T /F` on Windows). The runs it stopped are marked
`INTERRUPTED`. `ap run` with no request resumes. With nothing running it says
`No mission is running.` (or names the idle mission and points at `ap cancel`)
and changes nothing.

### `ap cancel [reason]` — end the mission

Prints the plan first — the mission, its phase/step, the fields it will clear,
what it keeps — then asks `y/N`. If a run is alive, the same single prompt covers
stopping it, and the process is confirmed dead before any state is cleared (a
failed kill leaves the mission untouched). Answering `N` prints
`aborted — nothing was changed.` and exits 1.

After `y`: the mission's phase/step become `cancelled`, its mission-scoped state
is cleared (checkpoints, current phase/task, feedback, last failure and the like),
and the reason is saved in `lastCancelled`. It does **not** revert any file or
Git change and does **not** delete the mission folder, which stays as the record.
Failure counters are left alone and cleared when the next mission starts.
The next `ap run "<request>"` starts a new mission.

### `ap reset [--scope <key>]` — fresh attempts

When a retry budget runs out, the mission escalates. `ap reset` gives it one
more chance without starting over:

- **No `--scope`:** clears every spent counter — all failure budgets, all task
  session allowances and their dead-ends, and the plan revision counter. Review
  feedback, the stage position and hand-off notes are kept.
- **`--scope <key>`:** clears one thing only:
  - a failure budget, e.g. `infrastructureRetryBudget:mission`;
  - a task's session allowance — the full key, the scope
    (`task:standalone:phase-1:<taskId>`) or just the task id. It keeps the task's
    hand-off note, which is the useful context for the next session. After a
    "did not converge" stop, a bare `ap reset` targets that task automatically;
  - `standalone-plan-revision`, the plan review round counter;
  - `fallback:<role>`, to drop a role's sticky fallback model and go back to its primary.

While a mission is **stopped**, the reset applies at once. While a mission is
**running**, it is queued (`.autopilot/reset-request.json`) and the running
mission applies it at its next failure decision, so it continues instead of
escalating — no stop or restart. A reset buys more attempts; it does not fix the
cause, so a revoked login, a denied path or a real test failure will come back.
With nothing to clear it exits 1 and lists the kinds of target it accepts.

### `ap rebase [--note "<why>"] [--yes]` — accept your own edits

Autopilot fingerprints the files of the current phase. If you edit or commit
something while the mission is paused, the next `ap run` stops with a
checkpoint drift (`PHASE_CHECKPOINT_DRIFT`) instead of mixing your change into
the agents' work unnoticed. `ap rebase` accepts your change: it re-points the
checkpoint at the current files, moves the phase's baseline onto `HEAD` (so your
commits stop showing up as phase work), and records your edit. The `--note` text
is shown to the next implementer and reviewer as
`Operator note: … (from ap rebase)`. The stage position does not change. It
refuses while a run is live; with no drift it still re-bases the baseline, or
prints `nothing to rebase`.

### `ap finding list` / `ap finding drop <n>` — reject a finding

`ap finding list` numbers the open review findings of the current phase.
`ap finding drop <n>` removes finding *n* from the saved feedback and the
review history, so the next fix round no longer asks the implementer to change
it. The dropped finding, your note and the time are recorded. `--scope <key>`
targets another feedback scope. Refuses while a run is live.

## Watching a mission: the WATCH-REPORT

`.autopilot/missions/<mission>/WATCH-REPORT.md` is the live status page. It
opens with the pipeline state:

```text
=== PIPELINE STATE ===
Mission: 097-implement-backlog-item
Status:  COMPLETED
Stage:   done
Budgets: implementation=0/4 (2 in earlier phases)  verification=0/4  adapter=0/3  infrastructure=0/3
Total:   9.27M · elapsed 04:57:30 wall (planning 1.32M · phase 1 2.17M · …)
```

**Status** is one of `RUNNING`, `STOPPED`, `ESCALATED`, `COMPLETED`, `CANCELLED`.
Then one section per stage (planning, each phase with its attempts, final
review), and one row per agent run:

```text
ROLE                       MODEL                     TASK         STATUS     DURATION  PRICE   CONTEXT  TURNS  NOTE
07-implementer-eac2b56a    deepseek-v4.1-flash-free  T1.1         COMPLETED  00:01:04  92.1K   31.2K    15     session 1 of 6
14-code_reviewer-f0061b9e  opus-5.5                  T1.1 > T1.7  DENIED     00:01:53  182.2K  66.4K    15     phase review · 3 findings
GATE (orchestrator)        -                         T1.1 > T1.7  PASS       00:27:07  -       -        -      full test suite
```

- **STATUS** — `COMPLETED` (a writing role finished), `APPROVED`/`DENIED` (a
  reviewer's verdict), `PASS`/`FAIL` (the gate), `INTERRUPTED` (stopped by `ap stop`).
- **PRICE** — tokens used; it starts with `~` while the run is still going.
  **CONTEXT** — the largest context the session reached. **TURNS** — model turns.
  `-` means the CLI reports no usage.
- **NOTE** — the session number, the number of findings, and warnings such as
  `⚠ high usage` (over the role's cap) or `haiku→sonnet !` (see below).

The same folder has `orchestrator.log` (the full log), `gates/` (each gate's
output), `handoff/` (hand-off notes), `phase-briefs/` and `runs/` (each agent
run's brief, output and result).

## Roles, models and fallbacks

| Role | Writes to the repo? | Job |
| --- | --- | --- |
| `planner` | Yes (the plan files) | Writes `PLAN.md` and `TASKS.md`, revises them after review |
| `plan_reviewer` | No — read-only | Approves or denies the plan with findings |
| `implementer` | Yes | Codes one task per session; fixes findings |
| `code_reviewer` | No — read-only | Reviews each phase, and the whole change in the final review |
| `verifier` | No — read-only | Checks each task's acceptance line with the gate results; ticks tasks done |

Each role has a `cli`, `model`, `reasoning` (effort), `variant`, and optional
`fallbacks`; the planner and implementer can also have an `escalation_model`.
Set them with `ap setup`, or later with `ap config` (all roles, or one with
`ap config --role implementer`).

**Keep the reviewers independent.** Never use the same model for
`code_reviewer` as for `implementer`, or for `plan_reviewer` as for `planner` —
not as primary and not as fallback. A model reviewing its own work misses its
own mistakes. `ap setup` and `ap config` warn about it.

**Fallbacks.** Each role can list fallback models, tried in order **only** when
the current model is rate-limited or out of quota — never for other failures.
The chosen fallback stays in use (sticky); the primary model is tried again
after `advanced.fallback_retry_primary_minutes` (default 60). A model that one
role found rate-limited is skipped by the other roles for the same window.
`ap reset --scope fallback:<role>` returns a role to its primary at once.

**Free models (opencode `*-free`).** When a free model has used up its
configured fallbacks on a rate limit, Autopilot tries the other free models it
discovers — never paid ones (turn this off with
`roles.free_models.auto_fallback: false`). Roles on a free model get at least
`roles.free_models.max_turns` turns (default 45), because free models often need
more turns; token caps and paid models are unchanged.

**How `ap config` finds models.** It asks the installed CLI first: opencode
`opencode models`, Codex its app-server `model/list`. These are your real,
live lists. When a CLI has no machine-readable list, Autopilot does not invent
one: it offers a dated, sourced list of documented options where one ships (for
Claude Code, its published aliases such as `opus`, `sonnet`, `haiku`, `fable`,
`opusplan`; see [anthropics/claude-code#12612](https://github.com/anthropics/claude-code/issues/12612)),
marked as **non-live**, and always lets you type a model name or leave it blank
for the CLI default. Effort levels come from the same sources (Codex has a
documented fallback list). Before saving, each role is checked: a live model must
be in the live list and unsupported flags are refused. `node scripts/doctor.mjs`
flags a documented list older than 180 days.

**Haiku on read-only Claude roles runs as Sonnet.** The read-only roles start
Claude with `--permission-mode plan`, and Claude Code runs plan mode on Sonnet
when Haiku is selected. A reviewer set to `haiku` therefore really runs (and
bills) Sonnet. Setup, `ap config` and `ap run` warn about it, and the report
marks it `haiku→sonnet !`. Haiku as implementer runs as Haiku.

**What really ran.** For every run Autopilot records the exact CLI command and
checks before launch that the configured model, effort and variant are really in
it. Each run writes a result file (`autopilot-relay.result.v3`) with the
requested model, the final arguments, the exit, the session id, the touched files
and the policy status. Autopilot does not claim the provider used the model
unless the provider reports it. No separate API key is needed; Autopilot uses
each CLI's own sign-in.

## Limits: caps, retries and timeouts

Every limit is a setting; see the [Configuration reference](#configuration-reference)
for all of them with their defaults.

- **Caps (per session):** `caps.<role>.max_turns`, `max_tokens` and
  `wrap_up_at_tokens`. Near the token cap the role is told to wrap up and write
  its hand-off; at the cap the session ends and `extra_sessions` decides whether
  a fresh session continues. `caps.mission_token_backstop` (default 6M tokens)
  stops a runaway mission. `caps.task_size_target_turns` (default 30) tells the
  planner how big one task may be.
- **Retries:** plan revisions (8), implementation failures (4), verification
  failures (4), final-review fix rounds (2), CLI errors (3), infrastructure
  failures (3), no-progress sessions (2).
- **Timeouts:** `time_limits.role_timeout_minutes` (60 per session, 180 for the
  verifier, which waits for the full test suite), `time_limits.call_backstop_minutes`
  (200, a hard stop for one call; the old name `mission_timeout_minutes` is still
  read and renamed by `ap config fill`), `silent_run_minutes` (10),
  `no_first_output_minutes` (3), `read_only_max_silence_minutes` (15) and
  `retry_wait_seconds` (60).

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
  environment variables in `tests.gate_env_allowlist` are passed. On Windows and
  macOS setup asks once whether gates may run without this isolation.
- **Only one guarded way to run shell commands.** A static test
  (`scripts/test-no-unguarded-shell.mjs`) fails the build if code runs a shell
  command outside the single guarded executor.

The Git guard is defense in depth for normal Git commands, not a wall against a
hostile process: a child that calls an absolute Git path and overrides
`GIT_CONFIG_*` can get past the hook layer. Read-only mounts and disposable
copies protect your local repository but cannot stop a remote push, so do not
give agents push-capable credentials; use read-only tokens and server-side branch
protection. Writable roles are checked after the fact (detection, not prevention).

## Platforms and runtime modes

`runtime.mode` decides how the read-only roles are contained. `ap setup` picks it:

| Mode | Where | Reviewers |
| --- | --- | --- |
| `linux-strong` | Native Linux | bubblewrap, OS-enforced |
| `wsl2-strong` | Windows with WSL2 (recommended) | bubblewrap inside the WSL distro (`runtime.wsl_distro`) |
| `windows-compatibility` | Native Windows, SpecKit and standalone only | disposable-copy isolation, not OS-enforced |

With `wsl2-strong`, you can type `ap` in Windows (PowerShell or CMD); `run`,
`stop` and `cancel` are handed to WSL automatically, and the mission runs there.
The planner and implementer write to the repository in every mode.

## Planning frameworks: standalone, SpecKit, GSD

`project.planning_framework` is `standalone`, `speckit`, `gsd` or `auto`
(detect). `ap setup` detects what the project uses.

**Standalone** (the default — nothing else to install). Each mission keeps its
plan in `.autopilot/missions/<NNN>-<slug>/PLAN.md` and `TASKS.md`. All
features, including `--stage`, work here.

**SpecKit.** `.specify/workflows/speckit/workflow.yml` is the source of truth.
Its command steps (`specify`, `plan`, `tasks`) go to the planner, its gate
steps (`review-spec`, `review-plan`) to the plan reviewer, and implementation
is run by Autopilot's own engine, with the same code review, gate and
verification as standalone. Task files are found with
`frameworks.speckit.task_files` (default `specs/*/tasks.md` and friends).

**Entering a project that is already planned.** `ap run` first looks at the
existing SpecKit, GSD or Autopilot state and decides where to start:

- **missing** — no plan yet: start planning from the beginning;
- **partial** — some planning done: check it, then continue from the first
  unfinished planning step;
- **complete** — spec/plan/tasks are there: run an independent read-only check of
  the plan, then go straight to coding;
- **ambiguous** — conflicting evidence: stop and ask rather than guess.

Existing planning files are kept. Autopilot's own checkpoints take precedence
for work it started itself.

**GSD — not yet reviewed in this version, coming in a future version.** The
code contains a GSD adapter: it reads `.planning/` (PLAN frontmatter for
phase/plan/wave/dependencies), runs PLAN tasks through the same engine, can review
each planning stage (`frameworks.gsd.planning_review`), and can run independent
PLANs of one wave in separate worktrees. It requires Strong mode. It has not been
reviewed and tested end to end for this release, so it is not documented as
supported yet; full documentation will follow in a future version.

## Configuration

Settings live in `.autopilot/config.json`, in the v4 layout
(`schema_version: "4.0"`) with these sections: `project`, `roles`, `caps`,
`retries`, `time_limits`, `workflow`, `tests`, `safety`, `runtime`,
`frameworks`, `advanced`. Every setting, its default and its allowed values are
listed in the [Configuration reference](#configuration-reference) at the end
of this page, generated from `config.schema.json`.

- **`ap config`** edits the file interactively: it shows the current roles,
  then lets you change all of them or one (`ap config --role <role>`). It edits
  the existing file and never reinstalls anything.
- **`ap config show [--path <key.path>]`** prints the effective configuration:
  your values plus the code defaults, each marked `[default]` or `[from config.json]`.
- **`ap config fill [--dry-run]`** adds every missing setting at its default
  (useful after an upgrade or a hand edit). It keeps every existing value
  (including `null` and empty lists), renames old setting names in place (for
  example `mission_timeout_minutes` → `call_backstop_minutes`, value kept), and
  repairs the `$schema` path so editors find `config.schema.json`. `--dry-run`
  only prints what would change. A timestamped `config.json.bak-<time>` backup is
  written before any change. It never invents a `runtime` mode you did not choose.
- **Editor help.** The `$schema` line points at the installed
  `config.schema.json`, so editors such as VS Code show descriptions,
  defaults and allowed values while you edit, and flag typos. Keys starting with
  `_` are allowed for your own comments.
- **Upgrades.** Older 2.x/3.x configs are migrated automatically on first use,
  with one timestamped backup. Removed fields (for example the old certification
  settings) are dropped; this never blocks the migration.
- **Full example:** [`config.example.json`](config.example.json) shows every setting.

Most-changed settings:

| Setting | Why you would change it |
| --- | --- |
| `roles.<role>.cli` / `.model` / `.reasoning` | Which agent and model does each job |
| `tests.gate_commands` | The test commands the gate runs, e.g. `["npm test"]` |
| `workflow.plan_review`, `workflow.code_review_per_phase`, `workflow.final_review` | Turn a review stage off (all on by default) |
| `retries.*` | More or fewer attempts before a mission escalates |
| `time_limits.role_timeout_minutes` | Longer sessions for a slow test suite |
| `tests.require_browser`, `tests.browser` | When and how the verifier uses a browser |

## Files Autopilot creates

Everything lives in `.autopilot/` (git-ignored by setup):

```text
.autopilot/
  config.json                 your settings
  state.json                  mission state and checkpoints (do not edit by hand)
  missions/<NNN>-<slug>/      one folder per mission, kept after it ends
    PLAN.md, TASKS.md         the plan and the task list (ticked as tasks pass)
    WATCH-REPORT.md           live status
    orchestrator.log          full log
    gates/  handoff/  phase-briefs/  runs/
  adhoc/<time>-<role>/        adhoc review results
  runs/                       shared run records
```

Outside `.autopilot/` it only writes the slash-command files and one
`.autopilot/` line in `.gitignore`. **`ap uninstall`** removes exactly those:
the `.autopilot/` folder and that one `.gitignore` line (matched exactly; a
similar line of yours is kept). Your code and Git tree are untouched.
`--keep-missions` first copies `missions/` to `autopilot-missions-archive-<date>`
at the repository root. It refuses while a run is live, and on a project that is
not set up it prints `Autopilot is not set up here.` and exits 0.

## Troubleshooting and FAQ

**The mission stopped with `STOP — human intervention required`.** Read the
reason above that line, or the end of `WATCH-REPORT.md`. Fix the cause, then
`ap run`. If a budget ran out, `ap reset` first. The message names the exact
command when one is needed.

**`READ_ONLY_CONTAINMENT_UNAVAILABLE`.** bubblewrap is missing or blocked.
Install it (`sudo apt install bubblewrap`). On Native Windows, choose
`windows-compatibility` in `ap setup`, or use WSL2.

**`PHASE_CHECKPOINT_DRIFT`.** Files of the current phase changed while the
mission was paused (usually your own edit). Keep them with
`ap rebase --note "<why>"`, then `ap run`.

**A reviewer keeps raising a finding you disagree with.** `ap finding list`,
then `ap finding drop <n> --note "<why>"`.

**A role is rate-limited.** Add fallbacks with `ap config --role <role>`. With
opencode free models, other free models are tried by themselves.

**A session was stopped as `IDLE_HANG`.** It was silent for
`time_limits.silent_run_minutes`. It is retried automatically; raise the
setting if your tools are slow to print.

**The gate fails on tests the mission did not touch.** Tests that also fail
on the code before the phase are not blamed on the phase. Fix them separately,
or narrow `tests.gate_commands`.

**I edited `state.json` and now it is confused.** Do not edit it by hand. Use
`ap reset`, `ap rebase`, `ap finding drop` or `ap cancel`; they keep the state
consistent and record what changed.

**Does it commit for me?** No, never. The finished work waits in your working tree.

**Does it need an API key?** No. Each CLI uses its own sign-in.

**Can I use only one CLI?** Yes, but use a different model for each reviewer
than for the role it reviews.

## Known limitations

- **OS-enforced read-only containment is Linux/WSL2 only.** Native Windows uses
  disposable-copy isolation, which is not OS-enforced; GSD needs Strong mode.
- **Containment covers the filesystem, not the network.** Agents keep their
  normal network access. For network-restricted unattended runs, run the whole
  process in a container or VM.
- **The preflight is a quick check, not a security boundary.** It confirms that
  each CLI runs and that the flags exist; it proves nothing about containment.
- **GSD and Cursor** are not yet reviewed — planned for a future version.
- **Antigravity IDE over WSL** shows no slash commands; use the `agy` CLI.
- **macOS** has not been tested.

## Development and tests

```bash
npm test                        # the full deterministic suite (scripts/test-all.mjs)
node scripts/doctor.mjs         # check Node, Git, CLIs, bubblewrap, network isolation
node scripts/gen-config-schema.mjs   # regenerate config.schema.json and the reference below
```

The suite covers the shell guard, planning, configuration and migration,
static safety checks, the capability schema, the failure taxonomy and more.
It includes `scripts/test-no-unguarded-shell.mjs`, a structural check that no
code runs `spawn`/`exec`/`execFile` (or `shell: true`) outside the guarded executor.

Project Autopilot is MIT licensed. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

<!-- config-reference:start -->
## Configuration reference

Generated from `config.schema.json` by `node scripts/gen-config-schema.mjs`; do not edit by hand.

### $schema

Relative path to this schema file.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `$schema` | `"./config.schema.json"` | — | Relative path to this schema file. |

### schema_version

On-disk config format version; always 4.0 for this layout.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `schema_version` | `"4.0"` | `"4.0"` | On-disk config format version; always 4.0 for this layout. |

### project

Project identity and which planning framework drives it.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `project.repo` | `"."` | — | Repository root the mission runs in. |
| `project.planning_framework` | `"standalone"` | `"auto"`, `"standalone"`, `"speckit"`, `"gsd"` | Which planning framework to drive (auto, standalone, speckit or gsd). |

### roles

The agent CLI, model and session settings for each role.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `roles.planner.cli` | `""` | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter for this role (claude, opencode, codex, ...). |
| `roles.planner.model` | `""` | — | Model id for this role; empty means the adapter default. |
| `roles.planner.reasoning` | `""` | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for this role; empty means the adapter default. |
| `roles.planner.variant` | `""` | — | Adapter-specific model variant; empty means none. |
| `roles.planner.resume_session` | `true` | — | Resume the previous session for this role instead of starting fresh. Defaults to false for the implementer: a capped implementer continues in a fresh session with the hand-off note (the wrap-up turn still resumes); every other role defaults to true. |
| `roles.planner.fallbacks[].cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Fallback adapter CLI. |
| `roles.planner.fallbacks[].model` | — | — | Fallback model id. |
| `roles.planner.fallbacks[].reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Fallback reasoning effort. |
| `roles.planner.fallbacks[].variant` | — | — | Fallback model variant. |
| `roles.planner.escalation_model.cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter for the escalation model; empty means the role's adapter. |
| `roles.planner.escalation_model.model` | — | — | Model id for the escalation model; empty means the role's model. |
| `roles.planner.escalation_model.reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for the escalation model; empty means the role's effort. |
| `roles.planner.escalation_model.variant` | — | — | Adapter-specific model variant for the escalation model; empty means none. |
| `roles.plan_reviewer.cli` | `""` | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter for this role (claude, opencode, codex, ...). |
| `roles.plan_reviewer.model` | `""` | — | Model id for this role; empty means the adapter default. |
| `roles.plan_reviewer.reasoning` | `""` | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for this role; empty means the adapter default. |
| `roles.plan_reviewer.variant` | `""` | — | Adapter-specific model variant; empty means none. |
| `roles.plan_reviewer.resume_session` | `true` | — | Resume the previous session for this role instead of starting fresh. Defaults to false for the implementer: a capped implementer continues in a fresh session with the hand-off note (the wrap-up turn still resumes); every other role defaults to true. |
| `roles.plan_reviewer.fallbacks[].cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Fallback adapter CLI. |
| `roles.plan_reviewer.fallbacks[].model` | — | — | Fallback model id. |
| `roles.plan_reviewer.fallbacks[].reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Fallback reasoning effort. |
| `roles.plan_reviewer.fallbacks[].variant` | — | — | Fallback model variant. |
| `roles.implementer.cli` | `""` | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter for this role (claude, opencode, codex, ...). |
| `roles.implementer.model` | `""` | — | Model id for this role; empty means the adapter default. |
| `roles.implementer.reasoning` | `""` | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for this role; empty means the adapter default. |
| `roles.implementer.variant` | `""` | — | Adapter-specific model variant; empty means none. |
| `roles.implementer.resume_session` | `false` | — | Resume the previous session for this role instead of starting fresh. Defaults to false for the implementer: a capped implementer continues in a fresh session with the hand-off note (the wrap-up turn still resumes); every other role defaults to true. |
| `roles.implementer.fallbacks[].cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Fallback adapter CLI. |
| `roles.implementer.fallbacks[].model` | — | — | Fallback model id. |
| `roles.implementer.fallbacks[].reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Fallback reasoning effort. |
| `roles.implementer.fallbacks[].variant` | — | — | Fallback model variant. |
| `roles.implementer.escalation_model.cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter for the escalation model; empty means the role's adapter. |
| `roles.implementer.escalation_model.model` | — | — | Model id for the escalation model; empty means the role's model. |
| `roles.implementer.escalation_model.reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for the escalation model; empty means the role's effort. |
| `roles.implementer.escalation_model.variant` | — | — | Adapter-specific model variant for the escalation model; empty means none. |
| `roles.code_reviewer.cli` | `""` | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter for this role (claude, opencode, codex, ...). |
| `roles.code_reviewer.model` | `""` | — | Model id for this role; empty means the adapter default. |
| `roles.code_reviewer.reasoning` | `""` | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for this role; empty means the adapter default. |
| `roles.code_reviewer.variant` | `""` | — | Adapter-specific model variant; empty means none. |
| `roles.code_reviewer.resume_session` | `true` | — | Resume the previous session for this role instead of starting fresh. Defaults to false for the implementer: a capped implementer continues in a fresh session with the hand-off note (the wrap-up turn still resumes); every other role defaults to true. |
| `roles.code_reviewer.fallbacks[].cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Fallback adapter CLI. |
| `roles.code_reviewer.fallbacks[].model` | — | — | Fallback model id. |
| `roles.code_reviewer.fallbacks[].reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Fallback reasoning effort. |
| `roles.code_reviewer.fallbacks[].variant` | — | — | Fallback model variant. |
| `roles.verifier.cli` | `""` | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter for this role (claude, opencode, codex, ...). |
| `roles.verifier.model` | `""` | — | Model id for this role; empty means the adapter default. |
| `roles.verifier.reasoning` | `""` | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for this role; empty means the adapter default. |
| `roles.verifier.variant` | `""` | — | Adapter-specific model variant; empty means none. |
| `roles.verifier.resume_session` | `true` | — | Resume the previous session for this role instead of starting fresh. Defaults to false for the implementer: a capped implementer continues in a fresh session with the hand-off note (the wrap-up turn still resumes); every other role defaults to true. |
| `roles.verifier.fallbacks[].cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Fallback adapter CLI. |
| `roles.verifier.fallbacks[].model` | — | — | Fallback model id. |
| `roles.verifier.fallbacks[].reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Fallback reasoning effort. |
| `roles.verifier.fallbacks[].variant` | — | — | Fallback model variant. |
| `roles.free_models.auto_fallback` | `true` | — | Automatically fall back to a free model when the primary is unavailable. |
| `roles.free_models.max_turns` | `45` | >= 0 | Maximum turns allowed on a free-model fallback before giving up. |

### caps

Per-role turn, token and session caps plus the mission token backstop.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `caps.task_size_target_turns` | `30` | >= 1 | Target turns per task used when splitting oversized work. |
| `caps.planner.max_turns` | `30` | >= 1 | Maximum model turns for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue. |
| `caps.planner.max_tokens` | `200000` | >= 1 | Maximum tokens for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue. |
| `caps.planner.extra_sessions` | `2` | >= 0 | Extra sessions this role may start after hitting its turn or token cap; at the limit no further session is started and the mission stops or reports the cap. |
| `caps.planner.wrap_up_at_tokens` | `180000` | >= 1 | Token count at which this role is told to wrap up and hand off before reaching max_tokens; at the limit the role writes its hand-off and stops. |
| `caps.plan_reviewer.max_turns` | `30` | >= 1 | Maximum model turns for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue. |
| `caps.plan_reviewer.max_tokens` | `150000` | >= 1 | Maximum tokens for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue. |
| `caps.plan_reviewer.extra_sessions` | `2` | >= 0 | Extra sessions this role may start after hitting its turn or token cap; at the limit no further session is started and the mission stops or reports the cap. |
| `caps.plan_reviewer.wrap_up_at_tokens` | `135000` | >= 1 | Token count at which this role is told to wrap up and hand off before reaching max_tokens; at the limit the role writes its hand-off and stops. |
| `caps.implementer.max_turns` | `40` | >= 1 | Maximum model turns for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue. |
| `caps.implementer.max_tokens` | `180000` | >= 1 | Maximum tokens for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue. |
| `caps.implementer.extra_sessions` | `5` | >= 0 | Extra sessions this role may start after hitting its turn or token cap; at the limit no further session is started and the mission stops or reports the cap. |
| `caps.implementer.wrap_up_at_tokens` | `160000` | >= 1 | Token count at which this role is told to wrap up and hand off before reaching max_tokens; at the limit the role writes its hand-off and stops. |
| `caps.code_reviewer.max_turns` | `22` | >= 1 | Maximum model turns for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue. |
| `caps.code_reviewer.max_tokens` | `150000` | >= 1 | Maximum tokens for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue. |
| `caps.code_reviewer.extra_sessions` | `2` | >= 0 | Extra sessions this role may start after hitting its turn or token cap; at the limit no further session is started and the mission stops or reports the cap. |
| `caps.code_reviewer.wrap_up_at_tokens` | `135000` | >= 1 | Token count at which this role is told to wrap up and hand off before reaching max_tokens; at the limit the role writes its hand-off and stops. |
| `caps.verifier.max_turns` | `30` | >= 1 | Maximum model turns for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue. |
| `caps.verifier.max_tokens` | `150000` | >= 1 | Maximum tokens for this role in one session; at the limit the role stops and hands off, and extra_sessions decides whether it may continue. |
| `caps.verifier.extra_sessions` | `2` | >= 0 | Extra sessions this role may start after hitting its turn or token cap; at the limit no further session is started and the mission stops or reports the cap. |
| `caps.verifier.wrap_up_at_tokens` | `135000` | >= 1 | Token count at which this role is told to wrap up and hand off before reaching max_tokens; at the limit the role writes its hand-off and stops. |
| `caps.mission_token_backstop` | `6000000` | >= 1 | Raw-token backstop for a whole mission before it is stopped. |

### retries

Retry and revision budgets for each stage.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `retries.plan_revisions` | `8` | >= 0 | Maximum plan revision rounds before plan review gives up. |
| `retries.implementation` | `4` | >= 0 | Failure budget for the implementation phase. |
| `retries.verification` | `4` | >= 0 | Failure budget for the verification phase. |
| `retries.final_review_fix_rounds` | `2` | >= 1 | Maximum final-review fix rounds before stopping. |
| `retries.cli_errors` | `3` | >= 0 | Adapter retry budget for transient CLI errors. |
| `retries.infrastructure` | `3` | >= 0 | Retry budget for infrastructure failures. |
| `retries.no_progress_sessions` | `2` | >= 1 | Consecutive no-progress generations before a mission is stopped. |
| `retries.extra_sessions_per_task` | `5` | >= 0 | Continuation sessions allowed per task (mirrors caps.implementer.extra_sessions). |
| `retries.escalate_after_not_fixed` | `2` | >= 1 | Consecutive reviews that must report the same finding not fixed before the escalation model is used (1 = escalate on the first not-fixed report). |

### time_limits

Wall-clock limits and waits, with the unit in each name.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `time_limits.role_timeout_minutes.default` | `60` | >= 0 | Default wall-clock limit per role session, in minutes. |
| `time_limits.role_timeout_minutes.verifier` | `180` | >= 0 | Wall-clock limit for the verifier role session, in minutes. |
| `time_limits.call_backstop_minutes` | `200` | >= 0 | Hard wall-clock backstop for ONE role call, in minutes (not a mission limit): a call that runs past it is stopped. The old name mission_timeout_minutes is still read and migrated. |
| `time_limits.role_timeout_floor_minutes` | `null` | >= 0 | Minimum per-role timeout floor in minutes; null disables the floor. |
| `time_limits.silent_run_minutes` | `10` | >= 0 | Minutes of silence before an active run is treated as hung. |
| `time_limits.no_first_output_minutes` | `3` | >= 0 | Minutes allowed before a session must produce its first output. |
| `time_limits.read_only_max_silence_minutes` | `15` | >= 0 | Maximum silence for read-only roles, in minutes. |
| `time_limits.retry_wait_seconds` | `60` | >= 0 | Seconds to wait between retries. |

### workflow

Which review and approval stages run, and how work is committed.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `workflow.plan_review` | `true` | — | Run a plan review stage before implementation. |
| `workflow.plan_review_rounds_converge` | `true` | — | Iterate plan review rounds until the plan converges. |
| `workflow.gsd_planning_review` | `false` | — | Use the GSD planning-review stages. |
| `workflow.spec_review` | `true` | — | Run a spec review stage. |
| `workflow.code_review_per_phase` | `true` | — | Run code review after each implementation phase. |
| `workflow.final_review` | `true` | — | Run a final review at the end of the mission. |
| `workflow.analysis_after_tasks` | `true` | — | Run an analysis pass after all tasks complete. |
| `workflow.approve_spec_myself` | `false` | — | Auto-approve the spec without asking the operator. |
| `workflow.approve_plan_myself` | `false` | — | Auto-approve the plan without asking the operator. |
| `workflow.parallel_independent_tasks` | `false` | — | Run independent tasks in parallel. |
| `workflow.use_worktrees` | `true` | — | Use git worktrees to isolate parallel work. |
| `workflow.commit_by_human` | `true` | — | Only a human may commit; roles never run git commit. |

### tests

Gate commands, reviewer requirement and verification policy.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `tests.gate_commands` | `[]` | — | Commands run as the phase/mission gate. |
| `tests.gate_network` | `false` | — | Allow the gate commands to use the network (false keeps them network-isolated). |
| `tests.gate_env_allowlist` | `[]` | — | Environment variables allowed through to gate commands. |
| `tests.require_reviewer` | `true` | — | Require a reviewer role to sign off before completion. |
| `tests.browser` | `"native"` | `"native"`, `"playwright"`, `"both"` | Browser capability mode used for verification (native, playwright or both). |
| `tests.require_browser` | `"when-task-requires"` | `"always"`, `"when-task-requires"`, `"never"` | When browser verification is required (always, when-task-requires or never). |
| `tests.verify_denylist` | `[]` | — | Commands or paths never allowed in verification. |

### safety

What roles may do and which safety checks are enforced.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `safety.allow_git_commit` | `false` | — | Permit roles to run git commit. |
| `safety.allow_git_push` | `false` | — | Permit roles to run git push. |
| `safety.allow_destructive_operations` | `false` | — | Permit destructive filesystem or git operations. |
| `safety.stop_on_sandbox_violation` | `true` | — | Stop the mission when a sandbox/relay violation is detected. |
| `safety.block_git_in_roles` | `true` | — | Block git commit/push inside role sessions. |
| `safety.check_read_only_roles` | `true` | — | Verify read-only roles by comparing snapshots. |
| `safety.record_touched_files` | `true` | — | Capture the files each role touches. |
| `safety.keep_role_sessions` | `true` | — | Persist role sessions so they can be resumed. |

### runtime

Containment mode and, for WSL2, the distribution to use.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `runtime.mode` | `"linux-strong"` | `"auto"`, `"linux-strong"`, `"wsl2-strong"`, `"windows-compatibility"` | Runtime containment mode (auto, linux-strong, wsl2-strong or windows-compatibility). |
| `runtime.wsl_distro` | `null` | — | WSL2 distribution to use for wsl2-strong mode; null means auto-detect. |

### frameworks

Per-framework planning settings for SpecKit and GSD.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `frameworks.speckit.workflow_file` | `".specify/workflows/speckit/workflow.yml"` | — | Path to the SpecKit workflow definition. |
| `frameworks.speckit.task_files` | `[".specify/tasks.md","specs/*/tasks.md","specs/*/tasks/*.md"]` | — | Glob patterns that identify SpecKit task files. |
| `frameworks.gsd.phase_root` | `".planning/phases"` | — | Root directory holding GSD phase folders. |
| `frameworks.gsd.run_plan_verify` | `true` | — | Run GSD plan verification. |
| `frameworks.gsd.run_state_validate` | `true` | — | Run GSD state validation. |
| `frameworks.gsd.write_summary_artifacts` | `true` | — | Write GSD summary artifacts. |
| `frameworks.gsd.write_verification_artifacts` | `true` | — | Write GSD verification artifacts. |
| `frameworks.gsd.write_uat_artifact` | `true` | — | Write the GSD UAT artifact. |
| `frameworks.gsd.use_gsd_tools_when_available` | `true` | — | Use GSD helper tools when they are available. |
| `frameworks.gsd.planning_review.enabled` | `false` | — | Enable the GSD planning-review stages. |
| `frameworks.gsd.planning_review.review_after_each_stage` | `true` | — | Review after every GSD planning stage. |
| `frameworks.gsd.planning_review.stages` | `["discuss","research","plan","plan-check"]` | — | GSD planning stages to review. |
| `frameworks.gsd.planning_review.max_revisions` | `3` | >= 0 | Maximum GSD planning-review revisions. |
| `frameworks.gsd.planning_review.read_only_reviewer` | `true` | — | Use a read-only reviewer for GSD planning review. |
| `frameworks.gsd.parallel.enabled` | `false` | — | Enable parallel GSD execution. |
| `frameworks.gsd.parallel.plan_level` | `false` | — | Allow plan-level GSD parallelism. |
| `frameworks.gsd.parallel.task_level` | `false` | — | Allow task-level GSD parallelism. |
| `frameworks.gsd.parallel.max_concurrent_agents` | `3` | >= 1 | Maximum concurrent GSD agents. |
| `frameworks.gsd.parallel.min_plans_for_parallel` | `2` | >= 1 | Minimum plans before parallel GSD execution starts. |

### advanced

Paths, hand-off limits and capability defaults.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `advanced.state_file` | `".autopilot/state.json"` | — | Path to the mission state file. |
| `advanced.runs_dir` | `".autopilot/runs"` | — | Directory holding run records. |
| `advanced.handoff_max_chars` | `2000` | >= 500 | Maximum characters in a role hand-off document. |
| `advanced.handoff_note_max_chars` | `4000` | >= 1000 | Maximum characters in a hand-off note. |
| `advanced.handoff_wrapup_tokens` | `160000` | >= 1 | Token count at which a role is told to wrap up its hand-off. |
| `advanced.fallback_retry_primary_minutes` | `60` | >= 0 | Minutes to wait before retrying the primary model after a fallback took over. |
| `advanced.checkpoint_after_task` | `true` | — | Write a checkpoint after each task. |
| `advanced.checkpoint_after_phase` | `true` | — | Write a checkpoint after each phase. |
| `advanced.capabilities.project_defaults` | `[]` | — | Capabilities assumed present for this project. |
| `advanced.capabilities.safety_denied` | `[]` | — | Capabilities explicitly denied for safety. |
| `advanced.capabilities.legacy_text_inference` | `false` | — | Infer capabilities from task text (legacy behaviour). |
<!-- config-reference:end -->
