# Configuration reference

<!-- config-reference:start -->
## Configuration reference

Generated from `config.schema.json` by `node scripts/gen-config-schema.mjs`; do not edit by hand.

### $schema

Path to the JSON schema that gives editor help for this file.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `$schema` | `"./config.schema.json"` | — | Path to the JSON schema that gives editor help for this file. |

### schema_version

On-disk config format version; always 4.0 for this layout.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `schema_version` | `"4.0"` | `"4.0"` | On-disk config format version; always 4.0 for this layout. |

### project

Project identity and how its work is planned.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `project.repo` | `"."` | — | Intended repository root the mission runs in. Fixed in this version; changing it has no effect. Autopilot uses the folder you run it in, or --repo. |
| `project.planning_framework` | `"standalone"` | `"auto"`, `"standalone"`, `"speckit"`, `"gsd"` | How work is planned: standalone, speckit or gsd; auto detects the framework from the repository. |

### roles

The agent CLI, model and session settings for each role.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `roles.planner.cli` | `""` | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter that runs this role (for example claude, opencode or codex); empty leaves it unset. |
| `roles.planner.model` | `""` | — | Model id this role uses (for example provider/model); empty means the adapter default. |
| `roles.planner.reasoning` | `""` | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort sent to the model (low, medium, high, ...); empty means the adapter default. |
| `roles.planner.variant` | `""` | — | Extra model variant for adapters that support it; empty means no variant. |
| `roles.planner.resume_session` | `true` | — | Start from this role's previous session (true) or fresh (false); the implementer defaults to false so a capped run continues fresh with the hand-off note. |
| `roles.planner.fallbacks[].cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | CLI adapter for this fallback entry. |
| `roles.planner.fallbacks[].model` | — | — | Model id for this fallback entry. |
| `roles.planner.fallbacks[].reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for this fallback entry; empty uses the role's value. |
| `roles.planner.fallbacks[].variant` | — | — | Model variant for this fallback entry; empty uses the role's value. |
| `roles.planner.escalation_model.cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | CLI adapter for the escalation model; required for escalation. |
| `roles.planner.escalation_model.model` | — | — | Model id for the escalation model; required for escalation. |
| `roles.planner.escalation_model.reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for the escalation model; empty uses no explicit effort. |
| `roles.planner.escalation_model.variant` | — | — | Model variant for the escalation model; empty means no variant. |
| `roles.plan_reviewer.cli` | `""` | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter that runs this role (for example claude, opencode or codex); empty leaves it unset. |
| `roles.plan_reviewer.model` | `""` | — | Model id this role uses (for example provider/model); empty means the adapter default. |
| `roles.plan_reviewer.reasoning` | `""` | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort sent to the model (low, medium, high, ...); empty means the adapter default. |
| `roles.plan_reviewer.variant` | `""` | — | Extra model variant for adapters that support it; empty means no variant. |
| `roles.plan_reviewer.resume_session` | `true` | — | Start from this role's previous session (true) or fresh (false); the implementer defaults to false so a capped run continues fresh with the hand-off note. |
| `roles.plan_reviewer.fallbacks[].cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | CLI adapter for this fallback entry. |
| `roles.plan_reviewer.fallbacks[].model` | — | — | Model id for this fallback entry. |
| `roles.plan_reviewer.fallbacks[].reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for this fallback entry; empty uses the role's value. |
| `roles.plan_reviewer.fallbacks[].variant` | — | — | Model variant for this fallback entry; empty uses the role's value. |
| `roles.implementer.cli` | `""` | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter that runs this role (for example claude, opencode or codex); empty leaves it unset. |
| `roles.implementer.model` | `""` | — | Model id this role uses (for example provider/model); empty means the adapter default. |
| `roles.implementer.reasoning` | `""` | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort sent to the model (low, medium, high, ...); empty means the adapter default. |
| `roles.implementer.variant` | `""` | — | Extra model variant for adapters that support it; empty means no variant. |
| `roles.implementer.resume_session` | `false` | — | Start from this role's previous session (true) or fresh (false); the implementer defaults to false so a capped run continues fresh with the hand-off note. |
| `roles.implementer.fallbacks[].cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | CLI adapter for this fallback entry. |
| `roles.implementer.fallbacks[].model` | — | — | Model id for this fallback entry. |
| `roles.implementer.fallbacks[].reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for this fallback entry; empty uses the role's value. |
| `roles.implementer.fallbacks[].variant` | — | — | Model variant for this fallback entry; empty uses the role's value. |
| `roles.implementer.escalation_model.cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | CLI adapter for the escalation model; required for escalation. |
| `roles.implementer.escalation_model.model` | — | — | Model id for the escalation model; required for escalation. |
| `roles.implementer.escalation_model.reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for the escalation model; empty uses no explicit effort. |
| `roles.implementer.escalation_model.variant` | — | — | Model variant for the escalation model; empty means no variant. |
| `roles.code_reviewer.cli` | `""` | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter that runs this role (for example claude, opencode or codex); empty leaves it unset. |
| `roles.code_reviewer.model` | `""` | — | Model id this role uses (for example provider/model); empty means the adapter default. |
| `roles.code_reviewer.reasoning` | `""` | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort sent to the model (low, medium, high, ...); empty means the adapter default. |
| `roles.code_reviewer.variant` | `""` | — | Extra model variant for adapters that support it; empty means no variant. |
| `roles.code_reviewer.resume_session` | `true` | — | Start from this role's previous session (true) or fresh (false); the implementer defaults to false so a capped run continues fresh with the hand-off note. |
| `roles.code_reviewer.fallbacks[].cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | CLI adapter for this fallback entry. |
| `roles.code_reviewer.fallbacks[].model` | — | — | Model id for this fallback entry. |
| `roles.code_reviewer.fallbacks[].reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for this fallback entry; empty uses the role's value. |
| `roles.code_reviewer.fallbacks[].variant` | — | — | Model variant for this fallback entry; empty uses the role's value. |
| `roles.verifier.cli` | `""` | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | Agent CLI adapter that runs this role (for example claude, opencode or codex); empty leaves it unset. |
| `roles.verifier.model` | `""` | — | Model id this role uses (for example provider/model); empty means the adapter default. |
| `roles.verifier.reasoning` | `""` | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort sent to the model (low, medium, high, ...); empty means the adapter default. |
| `roles.verifier.variant` | `""` | — | Extra model variant for adapters that support it; empty means no variant. |
| `roles.verifier.resume_session` | `true` | — | Start from this role's previous session (true) or fresh (false); the implementer defaults to false so a capped run continues fresh with the hand-off note. |
| `roles.verifier.fallbacks[].cli` | — | `""`, `"claude"`, `"codex"`, `"opencode"`, `"cursor"`, `"antigravity"` | CLI adapter for this fallback entry. |
| `roles.verifier.fallbacks[].model` | — | — | Model id for this fallback entry. |
| `roles.verifier.fallbacks[].reasoning` | — | `""`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Reasoning effort for this fallback entry; empty uses the role's value. |
| `roles.verifier.fallbacks[].variant` | — | — | Model variant for this fallback entry; empty uses the role's value. |
| `roles.free_models.auto_fallback` | `true` | — | When the effective model is free and the configured fallbacks are used up, try another free model from the same CLI (true) or not (false). |
| `roles.free_models.max_turns` | `45` | >= 0 | Most turns a role running a free model may use; 0 turns this extra cap off, and at the limit the run is cut and may continue in a new session. |

### caps

Per-role turn, token and session caps plus the mission token backstop.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `caps.task_size_target_turns` | `30` | >= 1 | Implementer turns the planner should aim for per task when splitting work; this is guidance, not a hard limit. |
| `caps.planner.max_turns` | `30` | >= 1 | Most model turns this role may use in one session; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue. |
| `caps.planner.max_tokens` | `200000` | >= 1 | Largest single-turn context (input plus cached input) this role may use; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue. |
| `caps.planner.extra_sessions` | `2` | >= 0 | Extra sessions this role may start after hitting its turn or token cap; at the limit no further session starts and the mission stops or reports the cap. |
| `caps.planner.wrap_up_at_tokens` | `180000` | >= 1 | Token count at which this role is told to wrap up and hand off before max_tokens; at the limit the role writes its hand-off and stops. |
| `caps.plan_reviewer.max_turns` | `30` | >= 1 | Most model turns this role may use in one session; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue. |
| `caps.plan_reviewer.max_tokens` | `150000` | >= 1 | Largest single-turn context (input plus cached input) this role may use; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue. |
| `caps.plan_reviewer.extra_sessions` | `2` | >= 0 | Extra sessions this role may start after hitting its turn or token cap; at the limit no further session starts and the mission stops or reports the cap. |
| `caps.plan_reviewer.wrap_up_at_tokens` | `135000` | >= 1 | Token count at which this role is told to wrap up and hand off before max_tokens; at the limit the role writes its hand-off and stops. |
| `caps.implementer.max_turns` | `40` | >= 1 | Most model turns this role may use in one session; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue. |
| `caps.implementer.max_tokens` | `180000` | >= 1 | Largest single-turn context (input plus cached input) this role may use; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue. |
| `caps.implementer.extra_sessions` | `5` | >= 0 | Extra sessions this role may start after hitting its turn or token cap; at the limit no further session starts and the mission stops or reports the cap. |
| `caps.implementer.wrap_up_at_tokens` | `160000` | >= 1 | Token count at which this role is told to wrap up and hand off before max_tokens; at the limit the role writes its hand-off and stops. |
| `caps.code_reviewer.max_turns` | `22` | >= 1 | Most model turns this role may use in one session; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue. |
| `caps.code_reviewer.max_tokens` | `150000` | >= 1 | Largest single-turn context (input plus cached input) this role may use; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue. |
| `caps.code_reviewer.extra_sessions` | `2` | >= 0 | Extra sessions this role may start after hitting its turn or token cap; at the limit no further session starts and the mission stops or reports the cap. |
| `caps.code_reviewer.wrap_up_at_tokens` | `135000` | >= 1 | Token count at which this role is told to wrap up and hand off before max_tokens; at the limit the role writes its hand-off and stops. |
| `caps.verifier.max_turns` | `30` | >= 1 | Most model turns this role may use in one session; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue. |
| `caps.verifier.max_tokens` | `150000` | >= 1 | Largest single-turn context (input plus cached input) this role may use; at the limit the role stops and hands off, then extra_sessions decides whether a new session may continue. |
| `caps.verifier.extra_sessions` | `2` | >= 0 | Extra sessions this role may start after hitting its turn or token cap; at the limit no further session starts and the mission stops or reports the cap. |
| `caps.verifier.wrap_up_at_tokens` | `135000` | >= 1 | Token count at which this role is told to wrap up and hand off before max_tokens; at the limit the role writes its hand-off and stops. |
| `caps.mission_token_backstop` | `6000000` | >= 1 | Cumulative raw tokens (input, cached input and output) allowed across one task; when exceeded the role wraps up and continues in a new backstop session, and two firings in a row stop the task with BACKSTOP_CONSECUTIVE_FIRINGS. |

### retries

How many times each stage may retry or revise before it stops and asks you.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `retries.plan_revisions` | `8` | >= 0 | Plan-review escalation point, not a revision count. In standalone, 0 escalates at the first plan-review FAIL without a Planner revision and it runs one fewer revision than the number (the number is one higher than the revisions run), so 1 behaves like 0; SpecKit runs at most one revision per gate for any value above 0; GSD planning still treats 0 or an absent value as 8; an absent value uses the built-in default of 8. |
| `retries.implementation` | `4` | >= 0 | Implementer fix rounds per phase before the phase stops; 0 stops the phase on the first fix-requiring review with no fix round, at the limit the mission stops and asks you, and an absent value uses the built-in default of 4. |
| `retries.verification` | `4` | >= 0 | Verifier FAIL rounds per phase before the phase stops; 0 stops the phase on the first verifier FAIL with no retry, at the limit the mission stops and asks you, and an absent value uses the built-in default of 4. |
| `retries.final_review_fix_rounds` | `2` | >= 1 | Final-review fix rounds per mission before it stops; 1 allows one round, and at the limit the mission stops. |
| `retries.cli_errors` | `3` | >= 0 | Same-model retries after a CLI error before the run gives up; 0 skips same-model retries and fails over or stops on the first CLI error, at the limit the run fails over or stops, and an absent value uses the built-in default of 3. |
| `retries.infrastructure` | `3` | >= 0 | Retries after an infrastructure error such as a snapshot, sandbox or gate failure; 0 stops on the first infrastructure error, at the limit the mission stops, and an absent value uses the built-in default of 3. |
| `retries.no_progress_sessions` | `2` | >= 1 | Sessions in a row that change no file before the task stops; 1 stops on the first session that changes nothing. |
| `retries.extra_sessions_per_task` | `5` | >= 0 | Extra sessions the implementer may start per task after a cap; 0 starts no extra session and an absent value uses the built-in default of 5. The caps.implementer.extra_sessions value wins when both are set. |
| `retries.escalate_after_not_fixed` | `2` | >= 1 | Reviews in a row that must report the same finding not fixed before the stronger escalation model is used; 1 escalates on the first not-fixed report. |

### time_limits

Wall-clock limits and waits, with the unit in each name.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `time_limits.role_timeout_minutes.default` | `60` | >= 0 | Time limit in minutes for one implementer task; past the limit the implementer call is stopped. |
| `time_limits.role_timeout_minutes.verifier` | `180` | >= 0 | Session time limit for the verifier role, in minutes; past the limit the verifier call is stopped. |
| `time_limits.call_backstop_minutes` | `200` | >= 0 | Hard wall-clock backstop for one role call, in minutes (not a mission limit); a call that runs past it is stopped. The old name mission_timeout_minutes is still read and migrated. |
| `time_limits.role_timeout_floor_minutes` | `null` | >= 0 | Lowest session limit that measured run times may produce, in minutes; null or 0 uses the built-in 10-minute floor. |
| `time_limits.silent_run_minutes` | `10` | >= 0 | Minutes without any output before an active run is treated as hung and stopped; 0 turns this watchdog off. |
| `time_limits.no_first_output_minutes` | `3` | >= 0 | Minutes a new session may run without producing any output before it is stopped; 0 turns this check off. |
| `time_limits.read_only_max_silence_minutes` | `15` | >= 0 | Maximum minutes a read-only role may stay silent even while a tool runs before it is stopped; 0 turns this cap off. |
| `time_limits.retry_wait_seconds` | `60` | >= 0 | Seconds to wait before retrying after a provider or network error; 0 retries immediately. |

### workflow

Which review and approval stages run, and how work is committed.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `workflow.plan_review` | `true` | — | Run the GSD plan-review stage before implementation (true) or skip it (false); only GSD reads this setting. (GSD is not yet reviewed in this version). |
| `workflow.plan_review_rounds_converge` | `true` | — | Make the first plan-review round review the whole plan and later rounds check only the requested fixes (true), or re-review the whole plan every round (false); default true. Applies to standalone and SpecKit planning; GSD uses its own plan-review settings. The legacy name plan_review_convergence is still read and migrated. |
| `workflow.gsd_planning_review` | `false` | — | Use the GSD planning-review stages (true) or skip them (false). (GSD is not yet reviewed in this version). |
| `workflow.spec_review` | `true` | — | Intended to run a spec review stage before planning. Controlled by your SpecKit workflow.yml — add or remove the step there; this setting has no effect. |
| `workflow.code_review_per_phase` | `true` | — | Run a code review after each implementation phase (true), or skip the per-phase review and rely on the end-of-mission review (false); default true. The legacy name implementationReview is still read and migrated. |
| `workflow.final_review` | `true` | — | Run a final review over the whole mission at the end, including its fix rounds (true), or skip it and complete the mission after implementation (false); default true. The legacy name finalReview is still read and migrated. |
| `workflow.analysis_after_tasks` | `true` | — | Intended to run an analysis pass after all tasks complete. Controlled by your SpecKit workflow.yml — add or remove the step there; this setting has no effect. |
| `workflow.approve_spec_myself` | `false` | — | Intended to approve the spec automatically without asking you. Controlled by your SpecKit workflow.yml — add or remove the step there; this setting has no effect. |
| `workflow.pause_for_plan_approval` | `false` | — | Approve the plan automatically without asking you (true) or pause after planning and wait for you to approve it (false); default false. Applies to standalone and SpecKit planning. When paused, a following `ap run` continues as the approval. |
| `workflow.parallel_independent_tasks` | `false` | — | Intended to run independent tasks in parallel. Not used by this version; changing it has no effect. |
| `workflow.use_worktrees` | `true` | — | Intended to run parallel tasks in separate git worktrees. Not used by this version; changing it has no effect. |
| `workflow.commit_by_human` | `true` | — | Stop at "ready to commit" and let you commit; false is not supported because Autopilot never commits. |

### tests

Gate commands, reviewer requirement and verification policy.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `tests.gate_commands` | `[]` | — | Commands run after each phase and at the end as the gate; a failing command fails the phase, and an empty list runs no gate. |
| `tests.gate_network` | `false` | — | Allow the gate commands to use the network (true); false keeps them network-isolated. |
| `tests.gate_env_allowlist` | `[]` | — | Environment variable names allowed through to gate commands; empty passes no extra variables. |
| `tests.require_reviewer` | `true` | — | Intended to require a reviewer verdict before a phase passes. Fixed in this version; changing it has no effect. |
| `tests.browser` | `"native"` | `"native"`, `"playwright"`, `"both"` | Browser capability used for verification: native (the agent's own browser), playwright or both. |
| `tests.require_browser` | `"when-task-requires"` | `"always"`, `"when-task-requires"`, `"never"` | How browser capabilities are required for the verifier: always adds them to every call; when-task-requires and never add them only when the task itself needs a browser. |
| `tests.verify_denylist` | `[]` | — | Commands or paths that a task or verification step may never run; empty adds no bans beyond the built-in full-suite ban. |

### safety

What roles may do and which safety checks are enforced.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `safety.allow_git_commit` | `false` | — | Setting this true is rejected; Autopilot never commits, so keep it false. |
| `safety.allow_git_push` | `false` | — | Setting this true is rejected; Autopilot never pushes, so keep it false. |
| `safety.allow_destructive_operations` | `false` | — | Setting this true is rejected; destructive operations stay blocked, so keep it false. |
| `safety.stop_on_sandbox_violation` | `true` | — | Setting this false is rejected; a sandbox or relay violation always stops the mission, so keep it true. |
| `safety.block_git_in_roles` | `true` | — | Blocks git commit and push inside role sessions. Always on — cannot be turned off; changing it has no effect. |
| `safety.check_read_only_roles` | `true` | — | Checks that read-only roles changed no file by comparing before and after snapshots. Always on — cannot be turned off; changing it has no effect. |
| `safety.record_touched_files` | `true` | — | Records the files each role touches. Always on — cannot be turned off; changing it has no effect. |
| `safety.keep_role_sessions` | `true` | — | Keeps role sessions on disk so a later run can resume them. Always on — cannot be turned off; changing it has no effect. |

### runtime

Containment mode and, for WSL2, the distribution to use.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `runtime.mode` | `"linux-strong"` | `"auto"`, `"linux-strong"`, `"wsl2-strong"`, `"windows-compatibility"` | How roles are contained: auto, linux-strong, wsl2-strong or windows-compatibility. |
| `runtime.wsl_distro` | `null` | — | WSL2 distribution used for wsl2-strong mode; null detects it automatically. |

### frameworks

Per-framework planning settings for SpecKit and GSD.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `frameworks.speckit.workflow_file` | `".specify/workflows/speckit/workflow.yml"` | — | Intended path to the SpecKit workflow definition. Fixed in this version; changing it has no effect. Autopilot always reads .specify/workflows/speckit/workflow.yml. |
| `frameworks.speckit.task_files` | `[".specify/tasks.md","specs/*/tasks.md","specs/*/tasks/*.md"]` | — | Glob patterns that identify SpecKit task files; empty means no task files are found. |
| `frameworks.gsd.phase_root` | `".planning/phases"` | — | Directory holding GSD phase folders. (GSD is not yet reviewed in this version). |
| `frameworks.gsd.run_plan_verify` | `true` | — | Run the gsd-tools plan check (references and state validation) after planning (true) or skip it (false). (GSD is not yet reviewed in this version). |
| `frameworks.gsd.run_state_validate` | `true` | — | Intended to run GSD state validation. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version). |
| `frameworks.gsd.write_summary_artifacts` | `true` | — | Intended to write GSD summary artifacts. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version). |
| `frameworks.gsd.write_verification_artifacts` | `true` | — | Intended to write GSD verification artifacts. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version). |
| `frameworks.gsd.write_uat_artifact` | `true` | — | Intended to write the GSD UAT artifact. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version). |
| `frameworks.gsd.use_gsd_tools_when_available` | `true` | — | Use GSD helper tools when they are available (true) or skip them (false). (GSD is not yet reviewed in this version). |
| `frameworks.gsd.planning_review.enabled` | `false` | — | Enable the GSD planning-review stages (true) or skip them (false). (GSD is not yet reviewed in this version). |
| `frameworks.gsd.planning_review.review_after_each_stage` | `true` | — | Intended to review after every GSD planning stage. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version). |
| `frameworks.gsd.planning_review.stages` | `["discuss","research","plan","plan-check"]` | — | GSD planning stages to review: discuss, research and plan. (GSD is not yet reviewed in this version). |
| `frameworks.gsd.planning_review.max_revisions` | `3` | >= 0 | Revisions allowed per GSD planning stage; at the limit the stage fails and the mission stops. (GSD is not yet reviewed in this version). |
| `frameworks.gsd.planning_review.read_only_reviewer` | `true` | — | Intended to use a read-only reviewer for GSD planning review. Not used by this version; changing it has no effect. (GSD is not yet reviewed in this version). |
| `frameworks.gsd.parallel.enabled` | `false` | — | Allow GSD work to run in parallel (true) or one at a time (false). (GSD is not yet reviewed in this version). |
| `frameworks.gsd.parallel.plan_level` | `false` | — | Allow different GSD plans to run in parallel (true) or one plan at a time (false). (GSD is not yet reviewed in this version). |
| `frameworks.gsd.parallel.task_level` | `false` | — | Tasks inside one GSD plan always run one at a time; this setting has no effect. (GSD is not yet reviewed in this version). |
| `frameworks.gsd.parallel.max_concurrent_agents` | `3` | >= 1 | Most GSD agents that may run at once; at the limit new work waits for a free slot. (GSD is not yet reviewed in this version). |
| `frameworks.gsd.parallel.min_plans_for_parallel` | `2` | >= 1 | Smallest number of plans that starts GSD parallel execution; below it plans run one at a time. (GSD is not yet reviewed in this version). |

### advanced

Paths, hand-off limits and capability defaults.

| Setting | Default | Allowed values | Description |
| --- | --- | --- | --- |
| `advanced.state_file` | `".autopilot/state.json"` | — | Intended path to the mission state file. Fixed in this version; changing it has no effect. |
| `advanced.runs_dir` | `".autopilot/runs"` | — | Intended directory holding run records. Fixed in this version; changing it has no effect. |
| `advanced.handoff_max_chars` | `2000` | >= 500 | Maximum characters in a role hand-off document; longer text is cut, and values below 500 are rejected. |
| `advanced.handoff_note_max_chars` | `4000` | >= 1000 | Maximum characters in a hand-off note; longer text is cut, and values below 1000 are rejected. |
| `advanced.handoff_wrapup_tokens` | `160000` | >= 1 | Token count at which a role is told to wrap up its hand-off; it must be below the implementer token cap. |
| `advanced.fallback_retry_primary_minutes` | `60` | >= 0 | Minutes to wait before retrying the primary model after a fallback took over; 0 uses the built-in 60-minute wait. |
| `advanced.checkpoint_after_task` | `true` | — | Intended to write a checkpoint after each task. Fixed in this version; changing it has no effect. |
| `advanced.checkpoint_after_phase` | `true` | — | Intended to write a checkpoint after each phase. Fixed in this version; changing it has no effect. |
| `advanced.capabilities.project_defaults` | `[]` | — | Capabilities assumed present for every role in this project; empty adds none. |
| `advanced.capabilities.safety_denied` | `[]` | — | Intended to deny capabilities for safety. Fixed in this version; changing it has no effect. |
| `advanced.capabilities.legacy_text_inference` | `false` | — | Infer browser capabilities from task text for the verifier (legacy); false keeps inference off. |
<!-- config-reference:end -->
