# Parallel Waves

## Execution unit

GSD Core's default parallelization unit is the PLAN. A PLAN may contain multiple
`<task>` blocks; those tasks are executed in order inside the same worktree.

Autopilot therefore does not fan out individual task blocks by default.

## Wave lifecycle

1. Read GSD PLAN files and group plans by their declared wave.
2. Create one Git worktree per plan from the current repository HEAD.
3. Seed each worktree with the current uncommitted project state.
4. Run each plan concurrently, bounded by `max_concurrent_agents`.
5. Run plan-local verification and read-only code review in the same worktree.
6. Produce a patch containing only that plan's new delta.
7. Validate the complete wave patch set together in a disposable validation worktree.
8. If validation fails: stop; leave the plan worktrees available for human inspection.
9. If validation succeeds: apply the complete wave patch set to the main working tree.
10. Remove only successfully merged worktrees and write the wave checkpoint.
11. Continue to the next wave.

No Git commit or push is performed by Autopilot.

## Safety properties

- Main tree must be clean of unrelated changes before starting a parallel phase.
- A wave is all-or-nothing from the orchestrator's perspective.
- A later wave is based on all previous uncommitted wave changes.
- Resume skips completed wave checkpoints.
- Task-level parallelism is intentionally disabled unless explicitly implemented later.
