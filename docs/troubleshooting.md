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

**A spec or plan review circles on a design you already rejected.**
`ap note "<your decision>"` (works while the run is live). Planner and
reviewers then treat it as binding; `ap note --clear` removes it.

**A role is rate-limited.** Add fallbacks with `ap config --role <role>`. With
opencode free models, other free models are tried by themselves.

**The network went down during a run.** Autopilot waits with backoff up to
`advanced.network_wait_minutes` (default 60) without spending retries, then
escalates; run `ap run` once the network is back.

**A run stopped with `AUTH_REQUIRED`.** The CLI is logged out. Log in as the
message says (for example run `agy` and sign in, or `codex login`), then `ap run`.

**A session was stopped as `IDLE_HANG`.** It was silent for
`time_limits.silent_run_minutes`. It is retried automatically; raise the
setting if your tools are slow to print.

**The gate fails on tests the mission did not touch.** Tests that also fail
on the code before the phase are not blamed on the phase. Fix them separately,
or change the test command with `ap config` (Enter keeps it, type a new command,
or `-` for no tests).

**I edited `state.json` and now it is confused.** Do not edit it by hand. Use
`ap reset`, `ap rebase`, `ap note`, `ap finding drop` or `ap cancel`; they keep the state
consistent and record what changed.

**Does it commit for me?** No, never. The finished work waits in your working tree.

**Does it need an API key?** No. Each CLI uses its own sign-in.

**Can I use only one CLI?** Yes, but use a different model for each reviewer
than for the role it reviews.
