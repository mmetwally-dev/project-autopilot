# GSD Core integration contract

Autopilot treats the current GSD Core planning model as authoritative. GSD's documented flow is Discuss -> Plan -> Execute -> Verify -> Ship. During Execute, independent PLANs are grouped into waves and can run in parallel with worktree isolation; the default parallel settings are plan-level parallelism, task-level parallelism disabled, maximum 3 concurrent agents, and a minimum of 2 plans to trigger parallel execution.

Autopilot intentionally diverges from native GSD in one policy: it never creates project Git commits or pushes. Instead, each PLAN produces an uncommitted patch. All patches in a wave are validated together before any patch is applied to the main working tree. A conflict stops the wave and leaves the isolated worktrees available for human inspection.

The adapter reads GSD PLAN frontmatter (`phase`, `plan`, `wave`, `depends_on`, `files_modified`) and the `<task>` contract including `<name>`, `<files>`, `<action>`, `<verify>`, and `<done>`. GSD Core documents the `<task>` structure and wave execution behavior.

GSD `workflow.use_worktrees` is respected for deciding whether Autopilot may run a parallel wave. Autopilot's own worktree isolation remains the safety boundary for concurrent execution.

When the installed GSD tooling is available, Autopilot can run read-only validation and `state sync`. GSD documents `state validate`, `state sync`, and related state management commands.

Resume semantics:
- successful wave checkpoints are persisted in `.autopilot/state.json`
- completed waves are skipped on resume
- a failed/interrupted wave is retried from its isolated worktrees
- already verified phases are skipped
- once no pending phases remain, resume still performs the final repository review

Autopilot does not call native `/gsd-execute-phase` or `/gsd-ship` because those native flows own Git commits and shipping. This is a deliberate compatibility boundary, not an accidental bypass.


## Planning review gates

Autopilot adds a read-only `plan_reviewer` gate around the GSD planning pipeline. This is intentionally stricter than treating `/gsd-plan-phase` as one opaque planner call.

When planning review is enabled, the pipeline is:

`Discuss/Context -> Review -> (revise if needed) -> Research -> Review -> (revise) -> Plan -> Review -> (revise) -> Native plan/state checks -> Final Plan Review -> Execute`

The exact stages depend on the current GSD project state: a fresh project receives the Discuss/Context stage; an existing phase receives Research and Plan. GSD's native plan-checker remains authoritative and Autopilot adds an independent read-only reviewer after the saved plan artifacts exist.

Reviewer behavior:
- `plan_reviewer` never edits `.planning` artifacts and never commits/pushes.
- A `FAIL` blocks the transition to the next planning stage.
- The planner is rerun with the reviewer findings attached.
- Revisions are bounded by `policy.max_plan_revisions`.
- Each passed stage is checkpointed in `.autopilot/state.json`, so `resume` does not repeat successful planning gates.
- The final `plan-check` reviewer gate must pass before implementation can start.

This mirrors the current GSD Core planning quality model: `/gsd-plan-phase` performs research, produces atomic PLAN files, and runs a plan-checker before saving them; GSD also supports explicit plan-review/replan convergence.

### The three plan-quality layers are not interchangeable

"Native plan/state checks" above is not one thing. Three independent layers run, and none substitutes for another:

1. **GSD native plan-checker** — runs *inside* the planner relay call, as part of `/gsd-plan-phase`, before Autopilot ever inspects the saved artifacts. This is the planner reviewing its own output.
2. **gsd-tools deterministic validation** — external, non-LLM checks (`verify references`, `state validate`) run by Autopilot against what GSD wrote to disk. Deterministic and scriptable, but only as thorough as what gsd-tools implements, and **only runs if the `gsd-tools` binary is installed**. If it isn't, Autopilot logs an explicit warning and records `gsdPlanCheckLayers.<phase>.deterministicGsdTools = "skipped-not-installed"` in `.autopilot/state.json` — it does not silently skip. Check `.autopilot/state.json` or the run logs if you need to confirm this layer actually ran for a given phase.
3. **Autopilot `plan_reviewer`** — a separate, read-only LLM review over the same saved artifacts. Independent process/context from layer 1, but still an LLM, so it can share blind spots with layer 1 on genuinely ambiguous plans.

Do not configure Autopilot assuming any one of these covers for a missing other. In particular: `planning.gsd.run_plan_verify: false` disables layer 2 only — layers 1 and 3 still run. `workflow.gsdPlanningReview: false` (or `planReview: false`) disables layer 3 only — layers 1 and 2 still run. There is no single flag that disables all three at once; that's intentional.
