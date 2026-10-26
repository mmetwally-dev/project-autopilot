---
name: project-autopilot
description: "Multi-agent delivery orchestrator: give a request and it plans, codes, reviews and tests it with your coding-agent CLIs (Planning -> Plan Review -> Implementation -> Code Review -> Gate -> Verification -> Final Review), then leaves the change for a human to commit. Works with standalone and SpecKit projects, checks browser tasks with Playwright, and uses the Claude Code, opencode, Codex and Antigravity CLIs. Runs directly with Node; no installer or certification."
---
# Project Autopilot

Project Autopilot (`ap`) carries one request — a **mission** — from plan to
tested code. Each step is done by a separate role, each role can be a different
agent CLI and model, and every result is checked before the next step:

**Planning → Plan Review → Implementation → Code Review → Gate (tests) → Verification → Final Review → Human Review/Commit**

**Works with SpecKit** (drives an existing SpecKit project's tasks) **and Playwright**
(built in; the verifier checks browser tasks in a real browser). Without SpecKit
it writes its own plan. It is standalone: no other skill is required. The human-facing guide with all
details is `README.md`; this file is the operating summary for an agent.

## Rules for an agent using this skill

1. **Never commit or push for the mission.** Autopilot never runs `git commit`
   or `git push`; the finished change waits in the working tree for the human.
2. **Never edit `.autopilot/state.json` by hand.** Use `ap reset`, `ap rebase`,
   `ap finding drop` or `ap cancel`; they keep the state consistent and record
   what changed.
3. **Long-running.** A mission takes tens of minutes to hours. Use
   `ap run --detach` on Linux/WSL2 to keep it running in the background, and read
   `.autopilot/missions/<mission>/WATCH-REPORT.md` for status.
4. **`ap stop` and `ap cancel` belong to the user.** Do not start them on your
   own; `/ap.stop` and `/ap.cancel` are user-only slash commands.
5. When a mission stops with `STOP — human intervention required`, report the
   reason and the resume command it prints; do not work around the guard.

## Getting started

Requires Node.js 18+, Git, one signed-in agent CLI, and `bubblewrap` on
Linux/WSL2 for the read-only reviewers.

```bash
npm install -g github:mmetwally-dev/project-autopilot   # once; or: node <skill>/bin/ap.cjs …
ap setup                                                # once per project (wizard)
ap run "Add a dark-mode toggle to the settings page"    # a full mission
```

`node bin/ap.cjs <command>` is the authoritative entry point and always works
by path; `bin/ap.cmd` (Native Windows) and `bin/ap` (Linux/WSL2) are thin
launchers that only forward the arguments and exit code. If Node.js is missing,
they exit `127`. Nothing is installed globally, no PATH or profile is changed,
and there is no certification step: each `ap run` does a quick, non-authoritative
**preflight** (CLI present, `--version`/`--help` works, configured flags exist,
paths usable).

## Command reference

All commands take `--repo <path>` (default: current folder). Exit codes: `0`
success, dry-run or nothing to do; `1` refusal or failure; `2` usage error
(`Unknown command`); `127` launcher without Node.js 18+.

| Command | Effect | Confirmation |
|---|---|---|
| `setup` | first-time wizard: roles, CLIs, models, gate commands, runtime mode; installs slash commands; adds `.autopilot/` to `.gitignore` | interactive |
| `run ["<request>"] [--stage <planning\|implement\|review\|verify>] [--detach]` | full mission; no request = resume the open mission; a different request abandons the open mission and starts a new one (loud takeover block, no prompt) | none |
| `stop [--yes] [--dry-run]` | stop the live run, keep the mission (`ap run` resumes) | y/N |
| `cancel ["<reason>"] [--yes] [--dry-run]` | end the mission; stops a live run first | one y/N for both |
| `reset [--scope <key>]` | clear spent retry counters (all, or one key) | none |
| `rebase [--note "<why>"] [--yes]` | accept operator edits made during a pause | y/N |
| `finding list` / `finding drop <n> [--note] [--yes]` | list / drop a current review finding | y/N for drop |
| `config [--role <role>]` | edit settings interactively | interactive |
| `config show [--path <key.path>] [--explain]` | print effective settings, marked `[default]` / `[from config.json]`; `--explain` adds a one-line explanation under each setting | none |
| `config fill [--dry-run]` | add missing settings at their defaults, repair `$schema` | none |
| `commands` | re-install the `/ap.*` slash-command files | none |
| `plan-review`, `code-review`, `verify-file` | adhoc reviews outside any mission (below) | none |
| `uninstall [--dry-run] [--yes] [--keep-missions]` | remove this project's `.autopilot/` and its `.gitignore` line only | y/N |
| `adapter <certify\|status> <adapter>` | compatibility no-ops (certification is not required) | none |
| `help` | command list | none |

`--yes` is required when there is no terminal; without it a state-changing
command refuses instead of acting silently. With a saved `wsl2-strong` mode,
`run`, `stop` and `cancel` typed on Native Windows hand over to WSL. `ap status`
and `ap watch` do not exist; the WATCH-REPORT is the status view.

## How a mission runs

- **Planning.** The planner writes `PLAN.md` and `TASKS.md` in
  `.autopilot/missions/<NNN>-<slug>/`. Each task is one concrete action on about
  one file, with exact paths, an `accept:` line and a `verify:` command; more than
  3 changes or 2 files means split it. The read-only plan reviewer APPROVES or
  DENIES with findings; the planner revises up to `retries.plan_revisions` times.
  Plan Review FAIL returns to Planning.
- **Implementation, per phase.** One implementer session per task. At a turn or
  token cap the implementer writes a hand-off note (`handoff/<task>.md`) and a
  fresh session continues it, up to `caps.implementer.extra_sessions`.
- **Code review, per phase.** Read-only. Code Review FAIL returns to
  Implementation for the tasks the findings name; the re-review covers its own
  findings plus the fix.
- **Gate.** Autopilot runs `tests.gate_commands` itself. Failing tests are re-run
  on the phase's starting code; failures that existed before are not blamed on
  the phase, new ones go back to the implementer.
- **Verification.** Read-only. The verifier checks each task's acceptance line
  with the gate evidence and ticks the task in `TASKS.md`. Verification never
  runs before Code Review has passed; a FAIL returns to Implementation, then Code
  Review and Verification repeat. A multi-finding status enumerates each finding
  against its own evidence, never a group summary.
- **Final review.** The code reviewer reads the whole mission change; up to
  `retries.final_review_fix_rounds` fix rounds. Success prints
  `ALL WORK COMPLETE — HUMAN COMMIT REQUIRED`.
- **Escalation.** When a budget is spent, a task stops progressing, or a guard
  trips, the mission saves state and stops with `STOP — human intervention
  required` (report status `ESCALATED`). Fix the cause, then `ap run`; use
  `ap reset` first when a budget ran out. Messages print the exact resume command,
  e.g. `Resume: ap reset --scope <key> then ap run`.
- **Smarter retries.** Planner/implementer may have an `escalation_model`, used
  for one fix round after a reviewer reports the same finding not fixed
  `retries.escalate_after_not_fixed` times (default 2). Continuation sessions
  that change no file stop after `retries.no_progress_sessions` (default 2). A
  session silent for `time_limits.silent_run_minutes` (default 10) is stopped as
  `IDLE_HANG`; an opencode rate-limit storm as `RATE_LIMITED`; both consume
  `infrastructureRetryBudget` like a timeout.
- **Resume.** `.autopilot/state.json` holds checkpoints; `ap run` re-runs only
  unfinished work.

### Agent slash commands (`/ap.…`)

`ap setup` / `ap commands` install one command set, with the same SpecKit-style
dot names in every supported agent, for agents found on PATH: Claude Code
`.claude/commands/ap.<cmd>.md`, opencode `.opencode/command/ap.<cmd>.md`,
Antigravity `.agents/skills/ap.<cmd>/SKILL.md` (a marked, generated dir per
command). Type them in the agent's chat; arguments are passed through.

- `/ap.run` — Do the whole job: plan, code, review, test until done. All phases, with fix rounds. Terminal: `ap run`
- `/ap.plan` — Step 1 only: write a reviewed plan + task list, then stop. Includes the plan review. Terminal: `ap run --stage planning`
- `/ap.implement` — Step 2 only: code the next part of the plan, then stop (no review). Current phase only; standalone missions only. Terminal: `ap run --stage implement`
- `/ap.review` — Step 3 only: review the code just written, then stop. Current phase only; standalone missions only. Terminal: `ap run --stage review`
- `/ap.verify` — Step 4 only: test the code just reviewed and tick its tasks done. Current phase only; standalone missions only. Terminal: `ap run --stage verify`
- `/ap.stop` — Pause the running mission (continue later with `/ap.run`). User-only. Terminal: `ap stop --yes`
- `/ap.cancel` — End the current mission for good; stops a live run first. User-only. Terminal: `ap cancel --yes`

`/ap.plan` and `/ap.run` can start a mission or resume the open one; the three
single-step commands need an already-planned standalone mission. User-only
means the model cannot invoke them (Claude Code `disable-model-invocation: true`;
opencode commands are user-typed); typing them is the confirmation, so they pass
`--yes`. They are not generated for Antigravity (its skills are model-invocable
with no opt-out) — use a terminal there. `ap stop` targets only the mission's
owner process, never the chat session. `reset`, `rebase`, `uninstall`, `setup`
and `config` are terminal-only. Codex (no custom-prompt loader) and Cursor (not
yet reviewed) get no slash commands. Antigravity commands are verified in the
`agy` CLI only, not in the Antigravity IDE over WSL. Older generated names
(`.claude/commands/ap/*.md`, `.opencode/command/ap-*.md`) are removed by setup,
commands and uninstall.

### Adhoc reviews (`plan-review`, `code-review`, `verify-file`)

One-shot reviews outside any mission: no mission state changes, never commit.

- `ap plan-review <plan-file>` — review a plan file (role `plan_reviewer`).
- `ap code-review (<range> | <commit> | <diff-file> | <path>) [--range <a..b> | --commit <sha> | --diff-file <file>]` — review a diff, commit, range or path (role `code_reviewer`).
- `ap verify-file <criteria-file> [--cmd "<test command>"]` — verify a criteria file, optionally running `--cmd` first and giving its output to the verifier as evidence (role `verifier`; `--cmd` runs outside role containment, never in the repo write path).

Slash forms: `/ap.plan-review`, `/ap.code-review`, `/ap.verify-file`.

Refusals (exit 2, nothing runs): missing or unreadable input, `verify-file` with
no checkable criteria, `code-review` with an invalid range/commit or an
unresolvable diff, and `--cmd` on anything but `verify-file`. Runtime failures
exit 1. Output: `.autopilot/adhoc/<timestamp>-<role>/summary.md` (verdict,
findings, `--cmd` evidence), plus `cmd-evidence.txt` with `--cmd`; the run's own
files sit in a nested `NN-<role>-<id8>/` folder named in the summary.

## Mission control

Five operator-only commands act on the active mission — `ap stop`, `ap cancel`,
`ap reset`, `ap rebase` and `ap finding`. All five record what they did in
`state.json` and the mission's WATCH-REPORT.

### `ap stop`

Kill + keep, never terminal: SIGTERM, 10 s grace so the run saves state, then
SIGKILL (`taskkill /T`, then `/T /F` on Windows); runs it stopped are marked
`INTERRUPTED`. State, checkpoints and counters are untouched; `ap run` resumes.
With no live run it says `No mission is running.` (or names the idle mission and
points at `ap cancel`) and changes nothing.

### `ap cancel [reason]`

Prints the plan (mission, phase/step, fields to clear, what is kept) and asks
one `y/N` that covers stopping a live run too; the process is confirmed dead
before any state is cleared. On `y`: phase/step become `cancelled`, every
mission-scoped field is cleared, and `lastCancelled{at, reason, previousPhase,
previousStep, mission}` is stamped. Files, the Git tree and the mission folder
are kept; failure counters are cleared when the next mission starts.

### `ap reset [--scope <scope-or-key>]`

- Bare: clears every spent failure budget, every task continuation allowance and
  its dead-ends, and the plan revision counter (review feedback, stage position
  and hand-off notes are kept). Nothing spent → exit 1.
- `--scope` clears one key: a failure budget (e.g.
  `infrastructureRetryBudget:mission`); a task continuation (full key
  `continuationAllowance:task:standalone:phase-1:<taskId>`, the scope, or the
  bare task id — the hand-off note is kept); `standalone-plan-revision`; or
  `fallback:<role>` (drop the sticky fallback, return to the primary model).
- Stopped mission: applies at once. Running mission: queued in
  `.autopilot/reset-request.json` and applied at the next failure or
  continuation decision, so the mission continues instead of escalating. It buys
  one more attempt; it does not fix the cause. It stamps `lastReset`.

### `ap rebase [--note "<why>"] [--yes]`

Accepts a phase-checkpoint drift (`PHASE_CHECKPOINT_DRIFT`, reason `delta
drift`) caused by operator edits during a pause: re-points the checkpoint digest
at the observed files and records `operatorPhaseEdits` (files, note, time, old
and new digests). It always also re-bases the current phase baseline onto
`HEAD`, so operator commits stop appearing as phase work. `--note` is shown in
the next implementer/reviewer briefs (`Operator note: … (from ap rebase)`).
Keeps the phase/step/task cursor; refuses while a run is live; prints `nothing
to rebase` when the baseline is already at `HEAD`.

### `ap finding list` / `ap finding drop <n>`

`list` numbers the current phase's open review findings. `drop <n>` removes
finding `n` from the saved feedback, the review round history and the
last-failure evidence, so the next fix round no longer asks for it; it is
recorded in `operatorDroppedFindings`. `--scope <key>` picks another feedback
scope. Refuses while a run is live.

### `ap uninstall [--dry-run] [--yes] [--keep-missions]`

Removes only this project's `.autopilot/` folder and the exact `.autopilot/`
line setup added to `.gitignore` (a similar line of the user's is kept; EOL style
kept; an emptied `.gitignore` stays as an empty file). `--keep-missions` first
archives `missions/` to `autopilot-missions-archive-<date>` at the repository
root. Refuses while a run is live. Not set up → prints `Autopilot is not set up
here.` and exits 0, without starting the setup wizard.

## Roles and containment

- **Planner** and **Implementer** write to the repository.
- **Plan Reviewer**, **Code Reviewer** and **Verifier** are read-only:
  - Strong mode (`linux-strong` / `wsl2-strong`): `bubblewrap` binds the
    repository read-only and a separate scratch folder writable; network access
    is normal. OS-enforced, and a hard requirement: without bubblewrap the role
    fails with `READ_ONLY_CONTAINMENT_UNAVAILABLE`.
  - `windows-compatibility` (Native Windows, SpecKit and standalone): the role
    works on a throwaway copy — disposable-copy isolation, not OS-enforced.
- A before/after Git snapshot and touched-files list are recorded for every
  role, whatever the containment. Read-only roles write temporary files in their
  `scratch/` folder under `.autopilot/`; a write anywhere else, or in the
  fingerprinted agent folders (`.agent/`, `.claude/`, `.opencode/`,
  `.commandcode/`, `.mimocode/`), stops the run with `Relay policy violation:
  read_only_violation`.
- Git commit/push and clearly destructive commands are blocked in every role
  (see `scripts/relay-guards.mjs`, `scripts/shell-guard.mjs`); harmless blocked
  Git calls only warn.
- Gate commands run without network (`unshare --net`) on Linux unless
  `tests.gate_network` is true.
- Keep reviewers independent: never the same model for `code_reviewer` as
  `implementer`, or for `plan_reviewer` as `planner`, as primary or fallback.
- Haiku on a read-only Claude role runs as Sonnet (plan mode); setup, config and
  run warn, and the report shows `haiku→sonnet !`.

### Known Git-guard limitation

The Git guard is defense in depth for normal PATH-resolved Git, not a hard
boundary: a child that runs an absolute Git path and overrides `GIT_CONFIG_*`
can bypass the hook layer. Read-only mounts and disposable copies protect the
local repository but cannot stop a remote push — do not expose push-capable
credentials. Writable roles are checked after the run (detection, not prevention).

## Models and fallbacks

Each role has `cli`, `model`, `reasoning`, `variant`, `resume_session` and
ordered `fallbacks`. Fallbacks trigger only on rate-limit/quota failures; the
chosen fallback stays sticky and the primary is retried after
`advanced.fallback_retry_primary_minutes` (default 60). When an opencode
`*-free` model has used its fallbacks on a rate limit, other discovered free
models are tried — never paid ones (`roles.free_models.auto_fallback: false`
turns this off); free-model roles get at least `roles.free_models.max_turns`
turns (default 45). Model lists come from the CLI itself where possible
(`opencode models`, Codex `model/list`), else a dated documented list (Claude
aliases) marked non-live, else manual entry.

## Setup and configuration

`ap setup` detects installed CLIs (`claude`, `codex`, `opencode`, `agy`,
`cursor-agent`), SpecKit, Playwright and bubblewrap, then configures each
role, fallbacks, escalation models, gate commands (it suggests `npm test`,
`pytest`, `go test ./...`, `cargo test` or `make test` when found) and the
runtime mode. `ap config` can later keep, change or clear the saved test
command. On Native Windows the only question is WSL2 Strong vs Windows
Compatibility, asked when both are usable; the gate network setting follows the
mode (isolated in WSL, network allowed in Compatibility).

`.autopilot/config.json` uses schema 4.0 (`schema_version: "4.0"`) with the
sections `project`, `roles`, `caps`, `retries`, `time_limits`, `workflow`,
`tests`, `safety`, `runtime`, `frameworks` and `advanced`. Its `$schema` points
at the skill's `config.schema.json`, so editors show descriptions and allowed
values; keys starting with `_` are allowed as comments. Older 2.x/3.x configs
migrate automatically with one timestamped backup.

- `ap config [--role <role>]` — interactive edit (roles: `planner`,
  `plan_reviewer`, `implementer`, `code_reviewer`, `verifier`).
- `ap config show [--path <key.path>] [--explain]` — effective values, marked `[default]` or
  `[from config.json]`; `--explain` adds a one-line explanation under each setting.
- `ap config fill [--dry-run]` — add every missing setting at its default, keep
  every existing value (including `null` and empty lists), rename old names in
  place (`time_limits.mission_timeout_minutes` → `call_backstop_minutes`), repair
  `$schema`; writes a `.bak-<timestamp>` backup first; never invents a `runtime`
  mode.

Every setting with its default is in [docs/configuration.md](docs/configuration.md)
→ Configuration reference (generated from `config.schema.json`).

## SpecKit, standalone and not-yet-reviewed integrations

- **Standalone** (default): each mission keeps `PLAN.md` and `TASKS.md` in
  `.autopilot/missions/<NNN>-<slug>/`. All features, including `--stage`, work here.
- **SpecKit**: `.specify/workflows/speckit/workflow.yml` is authoritative; command
  steps map to the planner, gate steps to the plan reviewer, and implementation is
  owned by Autopilot (same review, gate and verification).
- **Existing plans:** `ap run` classifies planning as missing, partial, complete or
  ambiguous, resumes from the right step, validates complete plans read-only
  before coding, and stops on ambiguous state instead of guessing.
- **GSD — not yet reviewed in this version; coming in a future version.** The
  adapter exists (`.planning/` phases, PLAN frontmatter for phase/plan/wave,
  planning-review stages, worktree waves; Strong mode only) but is not reviewed
  or tested end to end for this release; `ap setup` / `ap config` do not offer
  it.
- **Cursor — not yet reviewed in this version; coming in a future version.**
  `cursor-agent` is accepted as a role CLI but has not been reviewed or tested.

## Verification

Run `npm test` for the deterministic test suite (`scripts/test-all.mjs`), and
`node scripts/doctor.mjs` to check the environment. Successful completion ends
with a human-commit-required message; Project Autopilot itself never commits or
pushes.
