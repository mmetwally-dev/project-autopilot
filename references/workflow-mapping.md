# Workflow mapping

## SpecKit
The project-local `.specify/workflows/speckit/workflow.yml` is read and mapped:
- command step -> planner work
- gate step -> plan reviewer gate
- `implement` command is owned by Autopilot's implementation engine

Example:
specify -> review-spec -> plan -> review-plan -> tasks -> Autopilot implement.

## GSD
The project-local `.planning` artifacts are read.
The normalized phase model is Discuss -> Plan -> Execute -> Verify -> Ship.
Autopilot keeps code execution/review under its own no-commit policy.


## Planning State Detection
Autopilot does not assume every project starts at the first planning step. On entry to `spec`, `implement`, `resume`, or `full`, it inspects the current project state.

Possible states:
- `missing`: no recognizable planning artifacts; start the planning workflow from the beginning.
- `partial`: planning artifacts exist but later artifacts are missing; validate the completed portion, then continue from the first unresolved planning stage.
- `complete`: SpecKit spec/plan/tasks or a GSD phase PLAN is present; run an independent read-only planning validation, then skip directly to execution.
- `ambiguous`: insufficient or conflicting evidence; stop instead of guessing.

Autopilot checkpoints take precedence over artifact heuristics for work that it previously started. External/pre-existing projects are resolved from filesystem artifacts and framework-native state where possible.
