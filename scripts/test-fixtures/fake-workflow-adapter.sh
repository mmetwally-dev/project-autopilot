#!/bin/sh
# Fake adapter CLI used by the workflow-order behavioral tests
# (test-workflow-order-*.mjs). Configured as the "cursor" adapter, which has
# no registered driver (scripts/adapter-drivers.mjs) — the orchestrator sends
# the raw prompt on stdin and reads raw stdout back, with no protocol
# encoding to fake. This must be a single, self-contained POSIX shell script
# with no sibling-file dependencies: read-only roles run it inside a
# bubblewrap sandbox where only this one file is bind-mounted in
# (execution-envelope.mjs's "externalBinary" path), so it cannot exec a
# helper script or Node module that lives outside the sandbox.
#
# Behavior is controlled entirely by:
#   - A ".autopilot-test-scenario" file committed under ".autopilot/" (read
#     relative to CWD, never an env var — the real relay launch filters the
#     child environment down to a fixed safe allowlist via
#     scripts/relay-guards.mjs's guardedEnv()/filteredProcessEnv(), so a
#     custom env var never reaches this process; a committed repo file is
#     readable everywhere this script runs: the plain repo, a GSD worktree
#     checked out from the same commit, or the read-only bubblewrap bind).
#     It lives under ".autopilot/" (already excluded from every scoped
#     delta) rather than the repository root so switching the scenario
#     between two runs of the same mission never perturbs the recorded
#     delta digest: a harness-only rewrite must not read as approval drift.
#     A legacy root-level file is still honored as a fallback when no
#     ".autopilot/" copy exists (some tests manage the file directly).
#     The spec-review scenarios are fully deterministic per subprocess run:
#     the HARNESS switches the committed scenario between runs (FAIL first,
#     PASS second) instead of any reviewer writing mutable state.
#   - The presence of a retry/feedback marker in the received prompt, which
#     autopilot.mjs includes when most roles are re-invoked after a prior
#     failure. This lets plan_reviewer/code_reviewer "fail once, then pass"
#     with no external mutable state at all.
#   - For the verifier specifically: its prompt never carries a feedback
#     marker at all (pre-existing product behavior, unrelated to this
#     fixture — verifier is asked to independently verify, not to react to
#     review feedback text), so instead the implementer (a writable role,
#     always invoked once per attempt before verifier) writes a plain
#     ".autopilot-test-attempt" counter file under ".autopilot/" (already
#     excluded from every scoped delta, so counter bumps never perturb a
#     recorded digest); verifier reads it (read-only) to know which
#     attempt it is.
set -eu

if [ "${1:-}" = "--version" ]; then
  echo "fake-cursor-agent 1.0.0"
  exit 0
fi

PROMPT="$(cat)"
ROLE=$(printf '%s\n' "$PROMPT" | sed -n '1s/^ROLE=//p')
SCENARIO="success"
if [ -f "./.autopilot/.autopilot-test-scenario" ]; then
  SCENARIO="$(cat "./.autopilot/.autopilot-test-scenario")"
elif [ -f "./.autopilot-test-scenario" ]; then
  SCENARIO="$(cat "./.autopilot-test-scenario")"
fi

# TASK 13 correction / dirty-worktree-isolation requirement E: reviewer
# behavior must be provable via OBSERVABLE decisions (PASS/FAIL), never by
# depending on exact human-readable prompt prose from out of band. Every
# reviewer/verifier call extracts ONLY the text between the stable prompt
# contract delimiters scripts/implementation-baseline.mjs defines
# (<<<AUTOPILOT_SCOPED_DELTA_BEGIN:*>>> / <<<AUTOPILOT_SCOPED_DELTA_END>>>)
# and fails if it contains the literal marker "FORBIDDEN_BASELINE_MARKER".
# A test seeds pre-existing dirty/baseline file content with that marker and
# relies on this decision alone — never on inspecting prompt text.
scoped_delta_contains_forbidden_marker() {
  printf '%s\n' "$PROMPT" | awk '
    /<<<AUTOPILOT_SCOPED_DELTA_BEGIN:/ { inside = 1; next }
    /<<<AUTOPILOT_SCOPED_DELTA_END>>>/ { inside = 0; next }
    inside { print }
  ' | grep -q "FORBIDDEN_BASELINE_MARKER"
}

has_feedback() {
  printf '%s\n' "$PROMPT" | grep -qiE 'FEEDBACK TO ADDRESS|Prior findings to re-check|Previous failure|previous failure'
}

# A plan-review confirmation full review (run after a scoped re-review PASS)
# deliberately carries no previous findings; a scenario that FAILs only the
# first, feedback-less review must not FAIL it as if it were round 1.
is_confirmation_review() {
  printf '%s\n' "$PROMPT" | grep -q 'confirmation full review after a scoped'
}

# TASK-19 Phase 4: the per-task Implementer result contract. The final
# non-empty line must be exactly one AUTOPILOT_TASK_RESULT sentinel; the
# orchestrator derives changed files from the tree, so this fixture reports
# only the summary and task-local check it alone knows.
emit_task_result() {
  printf 'implementer ok\n'
  printf 'AUTOPILOT_TASK_RESULT={"summary":"implementer ok","taskLocalCheck":{"command":"true","status":"passed","exitCode":0,"summary":"fixture"}}\n'
}

phase_review_call() {
  # A per-phase Implementer/Reviewer/Verifier call, as opposed to the single
  # whole-mission final review: autopilot.mjs's phase handoffs always carry
  # a "Phase: " line, the MISSION_FINAL handoff never does.
  printf '%s\n' "$PROMPT" | grep -q '^Phase: '
}

# TASK-11 Phase 4: true when a persisted relay result already names $1
# (completed OR failed relays — result.json is written unconditionally at
# completion). Read-only compatible. Lets an infrastructure failure happen
# exactly once: the retry observes the first failure's result and PASSes.
prior_role_result() {
  find ./.autopilot -name result.json -exec grep -l "\"role\": *\"$1\"" {} + 2>/dev/null | grep -q .
}

# TASK-14 Phase 3: number of persisted relay results naming $1 (completed
# OR failed relays — result.json is written unconditionally at completion).
# Read-only compatible. Lets a position-specific failure happen exactly
# once at a call site where a persisted result from an EARLIER position
# already exists (so prior_role_result is already true when the targeted
# call runs): the SpecKit post-revision re-review observes the initial
# review's persisted result (count 1) and fails, then the retry observes
# both results (count 2) and PASSes.
role_result_count() {
  find ./.autopilot -name result.json -exec grep -l "\"role\": *\"$1\"" {} + 2>/dev/null | wc -l
}

# TASK-14 Phase 3: true when this plan_reviewer call is SpecKit's
# post-revision re-review (autopilot.mjs's runSpecKitPlanning sends
# "Re-review the SpecKit gate ..." after the between-reviews planner
# revision), as opposed to the initial gate review ("Review the current
# artifact state at the SpecKit gate ...").
is_rereview_prompt() {
  printf '%s\n' "$PROMPT" | grep -q 'Re-review the SpecKit gate'
}

# TASK-14 Phase 3: true when this plan_reviewer call is
# reviewExistingPlanning()'s validation of already-present planning
# artifacts (autopilot.mjs's reviewExistingPlanning sends "Validate the
# existing ..." for standalone/speckit/gsd alike).
is_existing_planning_prompt() {
  printf '%s\n' "$PROMPT" | grep -q 'Validate the existing'
}

# TASK-11 Phase 4: number of relay run dirs naming $1 whose status.json
# exists but which have no result.json yet — i.e. interrupted runs plus
# this very call's own dir (created at spawn; result.json is written
# unconditionally at completion, even for failed relays). A killed role's
# dir persists with no result, so a post-kill invocation observes a higher
# count than the killed one did. Read-only compatible (reads only, under
# .autopilot/, invisible to scoped deltas). A hang gated on "count <= 1"
# therefore hangs exactly once per role per mission: the resume PASSes.
unfinished_role_runs() {
  role="$1"
  status_count=$(find ./.autopilot -name status.json -exec grep -l "\"role\": *\"$role\"" {} + 2>/dev/null | wc -l)
  result_count=$(find ./.autopilot -name result.json -exec grep -l "\"role\": *\"$role\"" {} + 2>/dev/null | wc -l)
  printf '%s' "$((status_count - result_count))"
}

review_output() {
  decision="$1"
  finding="$2"
  if [ -n "$finding" ]; then
    printf 'AUTOPILOT_REVIEW={"decision":"%s","findings":["%s"]}\n' "$decision" "$finding"
  else
    printf 'AUTOPILOT_REVIEW={"decision":"%s","findings":[]}\n' "$decision"
  fi
}

case "$ROLE" in
  planner)
    # SpecKit new-request-isolation scenarios (test-speckit-new-request-
    # isolation.mjs). Identify which SpecKit planning step this call is for
    # from "Planning phase: <step>." (autopilot.mjs's runPlanningPhase), and
    # emulate the REAL speckit-specify/speckit-plan/speckit-tasks artifact
    # contracts (scripts/planning-boundary.mjs) for a single NEW feature
    # directory — specs/999-smoke-test — never any pre-existing feature:
    #   specify: .specify/feature.json (exactly {"feature_directory":
    #            "specs/999-smoke-test"} -- the real speckit-specify
    #            schema, no other fields), specs/999-smoke-test/spec.md,
    #            specs/999-smoke-test/checklists/**
    #   plan:    specs/999-smoke-test/{plan,research,data-model,
    #            quickstart}.md, contracts/**, and ONLY the content between
    #            CLAUDE.md's <!-- SPECKIT START/END --> markers
    #   tasks:   specs/999-smoke-test/tasks.md
    STEP=$(printf '%s\n' "$PROMPT" | sed -n 's/^Planning phase: \(.*\)\.$/\1/p' | head -n 1)
    FEATURE_DIR="specs/999-smoke-test"

    write_feature_json() {
      # The real speckit-specify schema is exactly one field.
      mkdir -p .specify
      printf '{"feature_directory":"specs/999-smoke-test"}' > .specify/feature.json
    }
    write_bad_feature_json() {
      # An extra, invented field ("branch") -- must fail feature.json's
      # exact single-field schema validation even though the path itself
      # is allowed, and even though feature_directory alone is correct.
      mkdir -p .specify
      printf '{"feature_directory":"specs/999-smoke-test","branch":"999-smoke-test"}' > .specify/feature.json
    }
    write_invented_feature_json() {
      # TASK 15.6C correction: the EXACT real observed Native Windows
      # incident shape -- a confused Planner invents its own 7-field
      # feature.json (branch/feature_name/feature_number/created_at/author/
      # status alongside the one real field) instead of the real
      # speckit-specify schema. Extra fields beyond feature_directory alone
      # are what trips validateFeatureJson's exact-shape check either way
      # (see write_bad_feature_json above), but this matches the incident's
      # field count precisely for narrative fidelity in the dedicated
      # regression below.
      mkdir -p .specify
      printf '{"feature_directory":"specs/999-smoke-test","feature_name":"smoke-test","feature_number":"999","branch":"999-smoke-test","created_at":"2026-01-01T00:00:00Z","author":"claude","status":"draft"}' > .specify/feature.json
    }
    # TASK 15.6C correction: the exact sentinel line autopilot.mjs's
    # correctionNoteFor() emits (scripts/autopilot.mjs) when retrying the
    # specify stage after EITHER a recoverable write-boundary content
    # violation or a postcondition failure whose feature.json resolved to
    # this exact reason. A full-line, byte-exact match (grep -qF) is used
    # instead of the generic has_feedback() prose check so the scenarios
    # below only self-correct once they have independently verified the
    # exact stage, artifact, expected path, AND reason code -- never on
    # vague "some feedback was present" prose.
    FEATURE_JSON_SCHEMA_CORRECTION_MARKER='AUTOPILOT_PLANNING_CORRECTION={"stage":"specify","artifact":".specify/feature.json","expected":".specify/feature.json","reason":"feature_json_unexpected_shape","detail":null}'
    has_feature_json_schema_correction() {
      printf '%s\n' "$PROMPT" | grep -qF "$FEATURE_JSON_SCHEMA_CORRECTION_MARKER"
    }
    write_spec() {
      mkdir -p "$FEATURE_DIR/checklists"
      printf '# Spec\n\nSmoke test feature.\n' > "$FEATURE_DIR/spec.md"
      printf '# Requirements checklist\n\n- [ ] Requirement A\n' > "$FEATURE_DIR/checklists/requirements.md"
    }
    write_plan_artifacts() {
      mkdir -p "$FEATURE_DIR/contracts"
      printf '# Plan\n\nSmoke test plan.\n' > "$FEATURE_DIR/plan.md"
      printf '# Research\n\nFindings.\n' > "$FEATURE_DIR/research.md"
      printf '# Data Model\n\nEntities.\n' > "$FEATURE_DIR/data-model.md"
      printf '# Quickstart\n\nSteps.\n' > "$FEATURE_DIR/quickstart.md"
      printf '# Health contract\n\nGET /health\n' > "$FEATURE_DIR/contracts/health.md"
    }
    write_tasks() {
      printf '## Phase 1: Do the smoke test task\n\n- [ ] Do the smoke test task\n' > "$FEATURE_DIR/tasks.md"
    }
    # TASK 15.6E: the exact structured sentinel autopilot.mjs's
    # correctionNoteFor() emits when retrying the tasks stage after a
    # tasks_no_executable_phases postcondition failure. Prefix match
    # (stage/artifact/expected/reason — the stable validator-produced
    # identifiers) rather than full-line: the trailing "detail" string
    # carries counts that legitimately vary. Never generic feedback prose.
    TASKS_PHASE_CORRECTION_PREFIX='AUTOPILOT_PLANNING_CORRECTION={"stage":"tasks","artifact":"tasks.md","expected":"specs/999-smoke-test/tasks.md","reason":"tasks_no_executable_phases"'
    has_tasks_phase_correction() {
      printf '%s\n' "$PROMPT" | grep -qF "$TASKS_PHASE_CORRECTION_PREFIX"
    }
    write_orphan_tasks() {
      # The real empty-phase-list incident shape: unchecked task lines with
      # no recognized '## Phase N' heading — production phases() finds zero
      # executable phases here.
      printf '# Tasks: smoke test tasks\n\n## Tasks\n\n- [ ] Do the first orphan task\n\n- [ ] Do the second orphan task\n' > "$FEATURE_DIR/tasks.md"
    }
    write_incident_tasks() {
      # TASK 15.6F: the real git-invisible-phase incident shape — VALID
      # recognized phases (so the tasks postcondition passes), but Phase 1
      # holds ONLY an empty-directory creation task (git-invisible: Git
      # cannot represent empty directories) while the real file deliverable
      # waits in Phase 2.
      printf '## Phase 1: Setup\n\n- [ ] T001 Create the docs/ directory at the repository root\n\n## Phase 2: Documentation Authoring\n\n- [ ] T002 Write docs/FINAL-SMOKE.md with the required sections\n' > "$FEATURE_DIR/tasks.md"
    }
    # TASK 15.6B: default valid Speckit planning for scenarios without
    # explicit planning support. A fresh `ap run` is always a NEW planning
    # request, so the planner must create a NEW feature with valid
    # per-stage artifacts — an exit-zero planner that writes nothing now
    # fails the stage postcondition (scripts/
    # speckit-planning-postconditions.mjs) before any reviewer launches.
    # Content matches the historic harness fixtures byte-for-byte:
    # "multi-task" requests get the 003 multi-phase CRLF shape, all others
    # the 001 single-task shape. Repeats within one repo count down fresh
    # 999/998/... dirs so a second independent mission never reuses (or
    # rewrites) the first mission's feature.
    plan_new_feature() {
      # The orchestrator locks the session feature after specify and tells
      # later stages explicitly ("Feature '<dir>'. ..."): plan/tasks must
      # continue THAT feature, never re-pick. Only the specify stage (no
      # Feature line — "This is a NEW feature") chooses a fresh directory.
      FEATURE_LOCKED=$(printf '%s\n' "$PROMPT" | sed -n "s/^Feature '\([^']*\)'.*/\1/p" | head -n 1)
      if [ -n "$FEATURE_LOCKED" ] && [ "$FEATURE_LOCKED" != "<new-feature>" ]; then
        WANT_DIR="$FEATURE_LOCKED"
        case "$WANT_DIR" in
          003-multi-task-feature) WANT_STYLE="multi" ;;
          *) WANT_STYLE="single" ;;
        esac
      else
        case "$PROMPT" in
          *multi-task*) WANT_DIR="003-multi-task-feature"; WANT_STYLE="multi" ;;
          *) WANT_DIR="001-fixture-feature"; WANT_STYLE="single" ;;
        esac
        if [ -e "specs/$WANT_DIR" ]; then
          N=999
          while [ -e "specs/$N-smoke-test" ]; do N=$((N - 1)); done
          WANT_DIR="$N-smoke-test"; WANT_STYLE="single"
        fi
      fi
      case "$STEP" in
        specify)
          mkdir -p .specify "specs/$WANT_DIR"
          printf '{"feature_directory":"specs/%s"}' "$WANT_DIR" > .specify/feature.json
          if [ "$WANT_STYLE" = "multi" ]; then
            printf '# Spec\n\nMulti-task fixture feature.\n' > "specs/$WANT_DIR/spec.md"
          else
            printf '# Spec\n\nFixture feature.\n' > "specs/$WANT_DIR/spec.md"
          fi
          ;;
        plan)
          if [ "$WANT_STYLE" = "multi" ]; then
            printf '# Plan\n\nMulti-task fixture plan.\n' > "specs/$WANT_DIR/plan.md"
          else
            printf '# Plan\n\nFixture plan.\n' > "specs/$WANT_DIR/plan.md"
          fi
          ;;
        tasks)
          if [ "$WANT_STYLE" = "multi" ]; then
            printf '%s\r\n' \
              "## Phase 1: Already complete phase" \
              "" \
              "- [x] Pre-existing already completed task" \
              "" \
              "## Phase 2: Build the widgets" \
              "" \
              "- [ ] Build the first widget" \
              "- [ ] Build the wídget with ünïcödé ✅" \
              "" \
              "## Phase 3: Ship the widgets" \
              "" \
              "- [ ] Ship the widgets" \
              "" > "specs/$WANT_DIR/tasks.md"
          else
            # TASK-20: two tasks in the reviewed phase, otherwise "affected is
            # exactly one task" is vacuous (one candidate always wins). Every
            # other scenario keeps the original single-task byte shape.
            if [ "$SCENARIO" = "finding_task_locality" ]; then
              printf '## Phase 1: Do the fixture task\n\n- [ ] Do the fixture task\n- [ ] Do the second fixture task\n' > "specs/$WANT_DIR/tasks.md"
            # TASK-21: three tasks in the reviewed phase, so a FAIL naming
            # one task leaves two carry candidates (one of which the
            # overlap scenario re-touches).
            # TASK-22: the phasewide scenario needs the same three tasks.
            # TASK-23: the scoped-rereview scenarios need the same three tasks.
            # TASK-24: the findings_per_task* scenarios need the same three tasks.
            elif [ "$SCENARIO" = "carry_forward_tagged" ] || [ "$SCENARIO" = "carry_forward_untagged" ] || [ "$SCENARIO" = "carry_forward_overlap" ] || [ "$SCENARIO" = "carry_forward_gate" ] || [ "$SCENARIO" = "carry_forward_phasewide" ] || [ "$SCENARIO" = "scoped_rereview" ] || [ "$SCENARIO" = "scoped_rereview_fallback" ] || [ "$SCENARIO" = "findings_per_task" ] || [ "$SCENARIO" = "findings_per_task_phasewide" ]; then
              printf '## Phase 1: Do the fixture task\n\n- [ ] Do the first carry-forward task\n- [ ] Do the second carry-forward task\n- [ ] Do the third carry-forward task\n' > "specs/$WANT_DIR/tasks.md"
            # TASK-25: the sentinel scenarios need a TWO-task phase (the
            # recover case asserts exactly 3 launches: T1, T1 again, T2).
            elif [ "$SCENARIO" = "impl_missing_sentinel_once" ] || [ "$SCENARIO" = "impl_missing_sentinel_always" ] || [ "$SCENARIO" = "impl_malformed_sentinel_once" ]; then
              printf '## Phase 1: Do the fixture task\n\n- [ ] Do the first sentinel task\n- [ ] Do the second sentinel task\n' > "specs/$WANT_DIR/tasks.md"
            # Mission 038 task 1.4: round 1 ships a tasks.md line running the
            # full suite via the gates.commands entry "npm test"; the revision
            # round (prompt quotes the REJECTED findings) ships a clean line.
            elif [ "$SCENARIO" = "speckit_full_suite_task_text" ]; then
              if printf '%s\n' "$PROMPT" | grep -q 'The plan reviewer REJECTED'; then
                printf '## Phase 1: Do the fixture task\n\n- [ ] T001 Run the linked test with node scripts/test-config-validation.mjs\n' > "specs/$WANT_DIR/tasks.md"
              else
                printf '## Phase 1: Do the fixture task\n\n- [ ] T001 Run the full test suite with npm test\n' > "specs/$WANT_DIR/tasks.md"
              fi
            else
              printf '## Phase 1: Do the fixture task\n\n- [ ] Do the fixture task\n' > "specs/$WANT_DIR/tasks.md"
            fi
          fi
          ;;
      esac
    }
    # Legitimate CLAUDE.md update: rewrite ONLY the line(s) between the
    # controlled markers (requires the awk portable form -- planner is a
    # writable role and never runs inside the bubblewrap sandbox, so awk/mv
    # are always available here).
    update_claude_md_in_marker() {
      if [ -f CLAUDE.md ]; then
        awk '
          /^<!-- SPECKIT START -->$/ { print; print "Active feature: 999-smoke-test"; skip=1; next }
          /^<!-- SPECKIT END -->$/ { skip=0; print; next }
          skip==1 { next }
          { print }
        ' CLAUDE.md > CLAUDE.md.tmp && mv CLAUDE.md.tmp CLAUDE.md
      fi
    }
    # Violation: edits content OUTSIDE the controlled marker section.
    update_claude_md_outside_marker() {
      printf '\nTAMPERED LINE OUTSIDE THE MARKER SECTION\n' >> CLAUDE.md
    }

    case "$SCENARIO" in
      speckit_full_contract|speckit_resume|speckit_spec_review_fail|speckit_spec_review_pass)
        case "$STEP" in
          specify)
            write_feature_json; write_spec
            ;;
          plan)
            if [ "$SCENARIO" = "speckit_resume" ]; then
              # Deterministic interruption point for the resume test: create
              # the marker FIRST, then block, so the harness has a wide,
              # guaranteed window to kill the process before plan.md exists.
              : > "./.autopilot-test-plan-started"
              sleep 3
            fi
            write_plan_artifacts; update_claude_md_in_marker
            ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_boundary_violation)
        # The real observed bug: the Planner also creates the
        # implementation deliverable itself, outside specs/ entirely,
        # during the Spec stage.
        case "$STEP" in
          specify)
            write_feature_json; write_spec
            mkdir -p docs
            printf '# Smoke test results\n\nran ok\n' > docs/AUTOPILOT-SMOKE-TEST.md
            ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_wrong_stage_specify)
        # Wrong-stage file INSIDE the correct feature directory: plan.md
        # written during specify.
        case "$STEP" in
          specify)
            write_feature_json; write_spec
            printf '# Plan (written too early)\n' > "$FEATURE_DIR/plan.md"
            ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_wrong_stage_plan)
        # Wrong-stage file INSIDE the correct feature directory: tasks.md
        # written during plan.
        case "$STEP" in
          specify) write_feature_json; write_spec ;;
          plan)
            write_plan_artifacts
            printf '## Phase 1: written too early\n\n- [ ] written too early\n' > "$FEATURE_DIR/tasks.md"
            ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_arbitrary_file)
        # An arbitrary file INSIDE the correct feature directory that is
        # never part of any stage's contract.
        case "$STEP" in
          specify)
            write_feature_json; write_spec
            printf 'console.log("not a planning artifact");\n' > "$FEATURE_DIR/implementation.js"
            ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_bad_feature_json)
        case "$STEP" in
          specify) write_bad_feature_json; write_spec ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_claude_md_violation)
        case "$STEP" in
          specify) write_feature_json; write_spec ;;
          plan) write_plan_artifacts; update_claude_md_outside_marker ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_plan_claude_md_line_ending_normalization)
        # TASK 15.6D: the real Native Windows incident — the Planner edits
        # ONLY the controlled marker section of CLAUDE.md, but its editor
        # normalizes Windows/mixed line endings to LF across the whole
        # file (the observed baseline suffix "\n\r\n" becomes "\n"). This
        # is a legitimate plan-stage write: the boundary must accept it,
        # Plan must succeed, and the Plan Reviewer must launch afterward.
        case "$STEP" in
          specify) write_feature_json; write_spec ;;
          plan)
            write_plan_artifacts; update_claude_md_in_marker
            if [ -f CLAUDE.md ]; then
              tr -d '\r' < CLAUDE.md > CLAUDE.md.tmp && mv CLAUDE.md.tmp CLAUDE.md
            fi
            ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_postcondition_no_output)
        # TASK 15.6B: the real Native Windows failure — an exit-zero planner
        # that writes nothing at any planning stage (blocked internally).
        # Boundary passes vacuously (no touches); the stage postcondition
        # must fail before any reviewer launches.
        : ;;
      speckit_postcondition_empty_spec)
        case "$STEP" in
          specify)
            write_feature_json
            mkdir -p "$FEATURE_DIR"
            : > "$FEATURE_DIR/spec.md"
            ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_postcondition_empty_plan)
        case "$STEP" in
          specify) write_feature_json; write_spec ;;
          plan)
            mkdir -p "$FEATURE_DIR/contracts"
            : > "$FEATURE_DIR/plan.md"
            printf '# Research\n\nFindings.\n' > "$FEATURE_DIR/research.md"
            update_claude_md_in_marker
            ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_postcondition_checked_tasks)
        case "$STEP" in
          specify) write_feature_json; write_spec ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks)
            printf '## Phase 1: Already done\n\n- [x] Finished task\n- [X] Another finished task\n' > "$FEATURE_DIR/tasks.md"
            ;;
        esac
        ;;
      speckit_postcondition_missing_tasks)
        case "$STEP" in
          specify) write_feature_json; write_spec ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) : ;;
        esac
        ;;
      speckit_git_invisible_phase)
        # TASK 15.6F: valid spec/plan plus the incident phased tasks above.
        # The tasks postcondition passes (executable phases exist); the
        # runtime guard must stop the mkdir-only attempt instead.
        case "$STEP" in
          specify) write_feature_json; write_spec ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_incident_tasks ;;
        esac
        ;;
      speckit_review_tasks_reject_invisible)
        # TASK 15.6F: same incident tasks, but the review-tasks gate itself
        # identifies the unobservable phase and FAILs (see the plan_reviewer
        # branch below) — proving the strengthened gate contract blocks
        # implementation before it starts.
        case "$STEP" in
          specify) write_feature_json; write_spec ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_incident_tasks ;;
        esac
        ;;
      speckit_postcondition_orphan_tasks)
        # TASK 15.6E: valid specify+plan, but tasks are loose unchecked
        # checkboxes with no recognized '## Phase N' heading. The tasks
        # postcondition must reject them before any reviewer launches.
        # Self-corrects to valid phased tasks ONLY on the exact structured
        # tasks_no_executable_phases correction sentinel (never generic
        # feedback prose), so the retry proves the correction contract.
        case "$STEP" in
          specify) write_feature_json; write_spec ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks)
            if has_tasks_phase_correction; then
              write_tasks
            else
              write_orphan_tasks
            fi
            ;;
        esac
        ;;
      speckit_postcondition_spec_without_feature_json)
        # Exit-zero planner that writes ONLY spec.md, never feature.json:
        # the specify postcondition must fail naming feature.json (a locked
        # session never excuses a missing file).
        case "$STEP" in
          specify)
            mkdir -p "$FEATURE_DIR"
            printf '# Spec\n\nOrphan spec without feature.json.\n' > "$FEATURE_DIR/spec.md"
            ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_postcondition_invented_feature_json_schema)
        # NOTE: this is the POSTCONDITION-ONLY regression, kept deliberately
        # separate from speckit_write_boundary_invented_feature_json below
        # (the TASK 15.6C correction's faithful reproduction of the real
        # incident). Here, the specify relay call writes a valid spec.md but
        # never touches .specify/feature.json at all, leaving in place a
        # pre-existing INVALID multi-field feature.json (from the harness's
        # makeInventedFeatureJsonFixture — a stale, confused PRIOR attempt
        # this call does not repeat). Because feature.json is never touched
        # THIS call, evaluatePlanningWriteBoundary's content check —
        # which only inspects TOUCHED paths — cannot see it; only the
        # specify postcondition (which always reads feature.json straight
        # off disk, regardless of what was touched) can catch it. This
        # proves the postcondition path independently of the write-boundary
        # path proven below. On a same-request retry, this call
        # self-corrects only once it observes the exact structured
        # correction sentinel (never generic feedback prose).
        case "$STEP" in
          specify)
            write_spec
            if has_feature_json_schema_correction; then
              write_feature_json
            fi
            ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_write_boundary_invented_feature_json)
        # TASK 15.6C correction: the FAITHFUL reproduction of the real
        # Native Windows incident. Unlike the postcondition-only regression
        # above, THIS scenario's specify relay call touches BOTH a valid
        # spec.md AND the invented, invalid multi-field feature.json in the
        # SAME call — exactly what the real Planner did. Both files appear
        # in this relay's touched-file set, so evaluatePlanningWriteBoundary
        # (planning-boundary.mjs), which content-validates every touched
        # .specify/feature.json, is what actually rejects this — BEFORE the
        # postcondition module ever runs, and before any reviewer launches.
        # On a same-request retry, this call only overwrites the invalid
        # JSON with the exact one-field schema once it observes the exact
        # structured correction sentinel naming this precise stage,
        # artifact, expected path, and reason — never on generic feedback
        # prose.
        case "$STEP" in
          specify)
            write_spec
            if has_feature_json_schema_correction; then
              write_feature_json
            else
              write_invented_feature_json
            fi
            ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_write_boundary_invented_feature_json_mixed)
        # TASK 15.6C correction / negative control: the SAME invented,
        # invalid feature.json as above, but ALONGSIDE a second, unrelated
        # violation (an implementation deliverable outside specs/ entirely,
        # the same real observed shape as speckit_boundary_violation) in the
        # SAME relay call. classifyRecoverableBoundaryViolation() in
        # autopilot.mjs only ever treats a SOLE feature.json content
        # violation as recoverable — mixing it with any other violation must
        # stay exactly as hard-escalated and non-recoverable as before, with
        # NO checkpoint at all. This scenario never self-corrects (no
        # feedback check): a real retry must never be able to auto-resume
        # this shape in the first place.
        case "$STEP" in
          specify)
            write_spec
            write_invented_feature_json
            mkdir -p docs
            printf '# Smoke test results\n\nran ok\n' > docs/AUTOPILOT-SMOKE-TEST.md
            ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_postcondition_symlink_escape)
        # Exit-zero planner that smuggles a symlink in place of spec.md
        # (targeting an existing file OUTSIDE the repository, so no extra
        # repo touch trips the write boundary first): the specify
        # postcondition must reject it before any reviewer launches, even
        # though the touched path itself looks allowed.
        case "$STEP" in
          specify)
            write_feature_json
            mkdir -p "$FEATURE_DIR"
            ln -s /etc/hostname "$FEATURE_DIR/spec.md"
            ;;
          plan) write_plan_artifacts; update_claude_md_in_marker ;;
          tasks) write_tasks ;;
        esac
        ;;
      speckit_rereview_*)
        # TASK-14 Phase 3: idempotent single-feature planning for the
        # post-revision re-review scenarios. Unlike the generic
        # plan_new_feature fallback below (which mints a FRESH feature
        # directory when specs/001-fixture-feature already exists), a
        # specify-stage REVISION must rewrite the SAME feature the initial
        # specify created — otherwise the revision planner trips the stage
        # write boundary and the mission never reaches the re-review call
        # these scenarios target. Content matches plan_new_feature's
        # single-task 001 shape byte-for-byte.
        case "$STEP" in
          specify)
            mkdir -p .specify "specs/001-fixture-feature"
            printf '{"feature_directory":"specs/001-fixture-feature"}' > .specify/feature.json
            printf '# Spec\n\nFixture feature.\n' > "specs/001-fixture-feature/spec.md"
            ;;
          plan)
            printf '# Plan\n\nFixture plan.\n' > "specs/001-fixture-feature/plan.md"
            ;;
          tasks)
            printf '## Phase 1: Do the fixture task\n\n- [ ] Do the fixture task\n' > "specs/001-fixture-feature/tasks.md"
            ;;
        esac
        ;;
      *)
        if [ -n "$STEP" ]; then
          # A Speckit "Planning phase: <step>." prompt for a scenario
          # without explicit planning support: create the session feature
          # NEW with valid per-stage artifacts (see plan_new_feature).
          plan_new_feature
        else
          PLAN_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^Write the narrative plan to exactly: //p' | head -n 1)
          if [ -z "$PLAN_FILE" ]; then PLAN_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^Write the plan to exactly: //p' | head -n 1); fi
          TASKS_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^Write the phased checklist to exactly: //p' | head -n 1)
          if [ -n "$PLAN_FILE" ]; then
            mkdir -p "$(dirname "$PLAN_FILE")"
            if [ -n "$TASKS_FILE" ]; then
              mkdir -p "$(dirname "$TASKS_FILE")"
              printf '# Plan\n\nObjective: fixture task.\n' > "$PLAN_FILE"
              # TASK-38: round 1 ships a TASKS.md whose task verify names a
              # denylisted test; the revision round (prompt carries the
              # reviewer-style feedback block) ships the clean file.
              if [ "$SCENARIO" = "verify_denylist" ]; then
                if printf '%s\n' "$PROMPT" | grep -qi 'Plan reviewer feedback that MUST be addressed'; then
                  printf '## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: node scripts/test-config-validation.mjs\n' > "$TASKS_FILE"
                else
                  printf '## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: node scripts/test-execution-plane-safety.mjs\n' > "$TASKS_FILE"
                fi
              # Mission 038 task 1.2: round 1 ships tasks whose verify runs
              # the full suite (test-all.mjs, plus the gates.commands entry
              # "npm test" the harness configures via writeConfig
              # gatesCommands ['npm test']) even though
              # planning.verify_denylist is empty; the revision round (prompt
              # carries the reviewer-style feedback block) ships clean
              # per-task verifies. Numeric **1.1**/**1.2** IDs so the gate
              # finding cites the task ID.
              elif [ "$SCENARIO" = "standalone_full_suite_verify" ]; then
                if printf '%s\n' "$PROMPT" | grep -qi 'Plan reviewer feedback that MUST be addressed'; then
                  printf '## Phase 1: General\n\n- [ ] **1.1** Do the fixture task — accept: done ; verify: node scripts/test-config-validation.mjs\n\n- [ ] **1.2** Do the second fixture task — accept: done ; verify: node scripts/test-config-validation.mjs\n' > "$TASKS_FILE"
                else
                  printf '## Phase 1: General\n\n- [ ] **1.1** Do the fixture task — accept: done ; verify: node scripts/test-all.mjs\n\n- [ ] **1.2** Do the second fixture task — accept: done ; verify: npm test\n' > "$TASKS_FILE"
                fi
              # TASK-20: two tasks in the reviewed phase — see the twin note in
              # plan_new_feature's single-task branch.
              elif [ "$SCENARIO" = "finding_task_locality" ]; then
                printf '## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n- [ ] Do the second fixture task — accept: done ; verify: none\n' > "$TASKS_FILE"
              # TASK-21: three tasks in the reviewed phase — see the twin
              # note in plan_new_feature's single-task branch.
              # TASK-22: the phasewide scenario needs the same three tasks.
              # TASK-23: the scoped-rereview scenarios need the same three tasks.
              # TASK-24: the findings_per_task* scenarios need the same three tasks.
              elif [ "$SCENARIO" = "carry_forward_tagged" ] || [ "$SCENARIO" = "carry_forward_untagged" ] || [ "$SCENARIO" = "carry_forward_overlap" ] || [ "$SCENARIO" = "carry_forward_gate" ] || [ "$SCENARIO" = "carry_forward_phasewide" ] || [ "$SCENARIO" = "scoped_rereview" ] || [ "$SCENARIO" = "scoped_rereview_fallback" ] || [ "$SCENARIO" = "findings_per_task" ] || [ "$SCENARIO" = "findings_per_task_phasewide" ]; then
                printf '## Phase 1: General\n\n- [ ] Do the first carry-forward task — accept: done ; verify: none\n- [ ] Do the second carry-forward task — accept: done ; verify: none\n- [ ] Do the third carry-forward task — accept: done ; verify: none\n' > "$TASKS_FILE"
              # TASK-25: the sentinel scenarios need a TWO-task phase (see the
              # twin note in plan_new_feature's single-task branch).
              elif [ "$SCENARIO" = "impl_missing_sentinel_once" ] || [ "$SCENARIO" = "impl_missing_sentinel_always" ] || [ "$SCENARIO" = "impl_malformed_sentinel_once" ]; then
                printf '## Phase 1: General\n\n- [ ] Do the first sentinel task — accept: done ; verify: none\n- [ ] Do the second sentinel task — accept: done ; verify: none\n' > "$TASKS_FILE"
              else
                printf '## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n' > "$TASKS_FILE"
              fi
            else
              printf '# Plan\n\nObjective: fixture task.\n\n- [ ] Do the fixture task\n\nVerification notes: none required.\n' > "$PLAN_FILE"
            fi
          fi
        fi
        ;;
    esac
    if [ "$SCENARIO" = "pwd_authority_probe" ]; then
      # TASK 15.6K: OpenCode-style write — resolve a relative output path
      # from $PWD (not the process cwd), then record the observable triple
      # in a cwd-relative probe file. With correct PWD authority both land
      # in the official repository; a launcher-inherited PWD would redirect
      # the deliverable into the decoy directory instead.
      printf 'pwd-authority-planner-ok\n' > "$PWD/pwd-authority-planner.txt"
      printf 'role=planner\ncwd=%s\npwd_env=%s\ninit_cwd=%s\n' "$(pwd)" "$PWD" "${INIT_CWD:-}" > ./pwd-authority-probe-planner.txt
    fi
    echo "planner ok"
    ;;
  plan_reviewer)
    if [ "$SCENARIO" = "pwd_authority_probe" ]; then
      # TASK 15.6K: read-only envelope probe — report the sandbox-visible
      # working-directory triple as separate single-line findings (no
      # quoting hazards inside the AUTOPILOT_REVIEW JSON string; values are
      # sanitized of JSON metacharacters so the contract always parses and
      # any deviation fails the comparison in the test instead).
      _RCWD="$(pwd | tr -d '"\\')"; _RPWD="$(printf '%s' "$PWD" | tr -d '"\\')"; _RINIT="$(printf '%s' "${INIT_CWD:-}" | tr -d '"\\')"
      _RSCEN="no"; if [ -f "./.autopilot/.autopilot-test-scenario" ] || [ -f "./.autopilot-test-scenario" ]; then _RSCEN="yes"; fi
      printf 'AUTOPILOT_REVIEW={"decision":"PASS","findings":["role=plan_reviewer","cwd=%s","pwd_env=%s","init_cwd=%s","scenario_present=%s"]}\n' "$_RCWD" "$_RPWD" "$_RINIT" "$_RSCEN"
    elif [ "$SCENARIO" = "speckit_review_tasks_reject_invisible" ] && printf '%s\n' "$PROMPT" | grep -q 'SpecKit gate "review-tasks"'; then
      # TASK 15.6F: the strengthened review-tasks contract applied — the
      # incident Phase 1 has no Git-observable deliverable. Gated to the
      # review-tasks gate only; spec/plan gates PASS normally.
      review_output FAIL "Phase 1 has no Git-observable deliverable: creating an empty directory is git-invisible, so this phase could never be verified"
    elif scoped_delta_contains_forbidden_marker; then
      review_output FAIL "forbidden baseline marker present in scoped delta"
    elif [ "$SCENARIO" = "speckit_rereview_gate_fail_twice" ] && [ "$(role_result_count plan_reviewer)" -lt 2 ]; then
      # Item 5: the FIRST TWO plan_reviewer results FAIL (the initial gate
      # review and the first post-revision re-review), then the third PASSes.
      # With max_plan_revisions=3 the gate must run two revisions and re-review
      # each, never escalate on the first re-review FAIL.
      review_output FAIL "gate still needs revision"
    elif [ "$SCENARIO" = "speckit_rereview_gate_fail_always" ]; then
      # Item 5 exhaustion: every gate review FAILs, including every re-review,
      # so the loop spends the whole revision budget before escalating.
      review_output FAIL "gate still needs revision"
    elif [ "$SCENARIO" = "gsd_plan_check_fail_twice" ] && printf '%s\n' "$PROMPT" | grep -q 'Review the GSD planning stage "plan-check"'; then
      # Item 5/GSD: the first two FINAL plan-check reviews FAIL (the current
      # brief is already on disk, so the brief count includes this call), the
      # third PASSes. Earlier discuss/research/plan stage reviews PASS.
      _PC_COUNT=$(find ./.autopilot -name brief.txt -exec grep -l 'Review the GSD planning stage "plan-check"' {} + 2>/dev/null | wc -l)
      if [ "$_PC_COUNT" -le 2 ]; then
        review_output FAIL "plan-check still needs a revision"
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "plan_review_fail" ] && ! has_feedback && ! is_confirmation_review; then
      review_output FAIL "needs more detail"
    elif [ "$SCENARIO" = "speckit_spec_review_fail" ]; then
      # Deterministic per-run scenario control: the harness sets this
      # scenario for the FIRST subprocess run, so the initial review AND
      # the bounded retry both FAIL. The gate handler then exits nonzero
      # and persists speckitPlanningCheckpoint. This branch performs zero
      # repository writes — plan_reviewer always runs inside the read-only
      # containment envelope, so a write-based mechanism cannot work here.
      review_output FAIL "spec needs improvement"
    elif [ "$SCENARIO" = "speckit_spec_review_pass" ]; then
      # The harness switches the committed scenario to this for the SECOND
      # subprocess run, which resumes the same mission and feature. PASS
      # with no repository write.
      review_output PASS ""
    elif [ "$SCENARIO" = "plan_review_missing_sentinel_with_path_error" ]; then
      # TASK 13 / Problem A regression: an incidental, already-recovered
      # path error (the exact real-world text) mixed into otherwise-normal
      # output must NOT rescue a genuinely missing/malformed review
      # sentinel. This proves the recovered-path-error fix in
      # failure-contract.mjs did not weaken reviewer-contract enforcement.
      echo "cat: docs/does-not-exist-yet.md: No such file or directory"
      echo "I looked at everything and it looks fine."
    elif [ "$SCENARIO" = "plan_review_infra_retryable" ] && ! prior_role_result plan_reviewer; then
      # TASK-14 planning-review attempt-failure regression: a retryable
      # infrastructure failure (nonzero exit, no sentinel), exactly once —
      # the retry observes the first failure's persisted result.json and
      # PASSes below, so only the reviewer is retried with no planner
      # relaunch. The stderr text matches failure-contract.mjs's
      # serverPattern ("server unavailable"), classifying as
      # SERVER_UNAVAILABLE/infrastructure (retryable). Stdout carries no
      # sentinel; the observed failure outranks the contract failure.
      echo "plan_review_infra_retryable: simulated infrastructure failure" >&2
      echo "server unavailable: upstream model endpoint refused the connection" >&2
      exit 1
    elif [ "$SCENARIO" = "plan_review_infra_non_retryable" ]; then
      # TASK-14 planning-review attempt-failure regression: a non-retryable
      # infrastructure failure (nonzero exit, no sentinel), every time. The
      # stderr text matches failure-contract.mjs's pathPattern ("No such
      # file or directory"), classifying as PATH_UNSUPPORTED/infrastructure
      # (never retried — escalates immediately, naming class and domain).
      echo "plan_review_infra_non_retryable: simulated path failure" >&2
      echo "cat: docs/plan-draft.md: No such file or directory" >&2
      exit 1
    elif [ "$SCENARIO" = "plan_review_infra_retryable_always" ]; then
      # TASK-14 Phase 3 cross-mission regression: a retryable
      # infrastructure failure (nonzero exit, no sentinel), every time —
      # same classification as plan_review_infra_retryable
      # (SERVER_UNAVAILABLE/infrastructure, retryable), but never passing,
      # so a mission run under it records budget uses until the budget is
      # exhausted and escalates.
      echo "plan_review_infra_retryable_always: simulated infrastructure failure" >&2
      echo "server unavailable: upstream model endpoint refused the connection" >&2
      exit 1
    elif [ "$SCENARIO" = "plan_review_adapter_retryable_always" ]; then
      # TASK-14 Phase 3 cross-mission regression: a retryable ADAPTER
      # failure (nonzero exit, no sentinel), every time. The stderr text
      # deliberately matches none of failure-contract.mjs's fallback
      # patterns (no permission/path/server wording), classifying as
      # generic PROCESS_EXIT_NONZERO/adapter (retryable) scoped to
      # adapter:<adapter>:plan_reviewer.
      echo "plan_review_adapter_retryable_always: simulated adapter failure" >&2
      echo "adapter transport exploded: unexpected EOF from backend" >&2
      exit 1
    elif [ "$SCENARIO" = "plan_review_adapter_retryable_second" ]; then
      # TASK-14 Phase 3 (XB2 mission 2): the same adapter-domain retryable
      # failure, but only while fewer than two plan_reviewer results exist
      # repo-wide — the prior mission left exactly one passing review, so
      # the new mission's first validation fails and its retry (observing
      # both results) passes. A repo-wide prior_role_result gate cannot
      # express this: the prior mission's result already exists when the
      # new mission starts. Precondition (asserted by the test): exactly
      # one persisted plan_reviewer result before this mission runs.
      if [ "$(role_result_count plan_reviewer)" -lt 2 ]; then
        echo "plan_review_adapter_retryable_second: simulated adapter failure" >&2
        echo "adapter transport exploded: unexpected EOF from backend" >&2
        exit 1
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "plan_review_policy_violation" ]; then
      # TASK-14 Phase 3 policy-violation regression: the reviewer attempts
      # a git commit (blocked and logged by the relay git guard — the same
      # detection the implementer_policy_violation scenario relies on), so
      # the relay records policyViolation=git_mutation_blocked even though
      # a PASS sentinel follows. The orchestrator must die immediately: no
      # retry attempted, no infra/adapter budget touched.
      git commit -q --allow-empty -m "policy-violation-attempt" >/dev/null 2>&1 || true
      review_output PASS ""
    elif [ "$SCENARIO" = "speckit_rereview_infra_retryable" ]; then
      # TASK-14 Phase 3 call site 3 (post_revision_review): the initial
      # gate review FAILs once functionally (no feedback marker yet), and
      # the post-revision re-review fails once with a retryable
      # infrastructure failure (one persisted plan_reviewer result — the
      # initial FAIL — is visible), then PASSes (two results visible, so
      # this is the retry). The reviewer only is retried; the planner is
      # never re-invoked for the retry and no additional revision is
      # granted.
      if is_rereview_prompt; then
        if [ "$(role_result_count plan_reviewer)" -lt 2 ]; then
          echo "speckit_rereview_infra_retryable: simulated infrastructure failure" >&2
          echo "server unavailable: upstream model endpoint refused the connection" >&2
          exit 1
        else
          review_output PASS ""
        fi
      elif ! has_feedback; then
        review_output FAIL "spec needs revision"
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "speckit_rereview_infra_non_retryable" ]; then
      # TASK-14 Phase 3 call site 3: initial FAIL once functionally, then
      # the re-review fails every time with PATH_UNSUPPORTED — escalates
      # unchanged (no revision left at this position), naming class/domain.
      if is_rereview_prompt; then
        echo "speckit_rereview_infra_non_retryable: simulated path failure" >&2
        echo "cat: docs/plan-draft.md: No such file or directory" >&2
        exit 1
      elif ! has_feedback; then
        review_output FAIL "spec needs revision"
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "speckit_rereview_output_contract" ]; then
      # TASK-14 Phase 3 call site 3: initial FAIL once functionally, then
      # the re-review returns no sentinel at all (output-contract failure)
      # — passes through unrecorded and escalates unchanged, exactly like
      # the functional-FAIL shape at this position.
      if is_rereview_prompt; then
        echo "cat: docs/does-not-exist-yet.md: No such file or directory"
        echo "I looked at everything and it looks fine."
      elif ! has_feedback; then
        review_output FAIL "spec needs revision"
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "speckit_rereview_policy_violation" ]; then
      # TASK-14 Phase 3 policy-violation regression at call site 3: initial
      # FAIL once functionally, then the re-review attempts a git commit
      # (policyViolation=git_mutation_blocked wins over the PASS sentinel)
      # — must die immediately with no retry and no budget recorded.
      if is_rereview_prompt; then
        git commit -q --allow-empty -m "policy-violation-attempt" >/dev/null 2>&1 || true
        review_output PASS ""
      elif ! has_feedback; then
        review_output FAIL "spec needs revision"
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "existing_planning_infra_retryable" ]; then
      # TASK-14 Phase 3 call site 4 (reviewExistingPlanning): the
      # existing-planning validation fails once with a retryable
      # infrastructure failure, then PASSes; every other prompt PASSes
      # untouched (this scenario never drives the planning loops — the
      # fixture repo is already complete/partial before the run starts).
      if is_existing_planning_prompt && ! prior_role_result plan_reviewer; then
        echo "existing_planning_infra_retryable: simulated infrastructure failure" >&2
        echo "server unavailable: upstream model endpoint refused the connection" >&2
        exit 1
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "existing_planning_infra_retryable_always" ]; then
      # TASK-14 Phase 3 GSD regression: the existing-planning validation
      # fails every time with a RETRYABLE infrastructure failure — the
      # shape that must still hard-escalate with zero retry (and zero
      # budget recorded) when the framework is GSD.
      if is_existing_planning_prompt; then
        echo "existing_planning_infra_retryable_always: simulated infrastructure failure" >&2
        echo "server unavailable: upstream model endpoint refused the connection" >&2
        exit 1
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "existing_planning_output_contract" ]; then
      # TASK-14 Phase 3 call site 4: the existing-planning validation
      # returns no sentinel (output-contract failure) — escalates
      # immediately exactly like the functional-FAIL case, unrecorded.
      # Asserted as its own case; never inferred from the re-review
      # output-contract case.
      if is_existing_planning_prompt; then
        echo "cat: docs/does-not-exist-yet.md: No such file or directory"
        echo "I looked at everything and it looks fine."
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "existing_planning_policy_violation" ]; then
      # TASK-14 Phase 3 policy-violation regression at call site 4: the
      # existing-planning validation attempts a git commit — must die
      # immediately with no retry and no budget recorded.
      if is_existing_planning_prompt; then
        git commit -q --allow-empty -m "policy-violation-attempt" >/dev/null 2>&1 || true
        review_output PASS ""
      else
        review_output PASS ""
      fi
    else
      review_output PASS ""
    fi
    ;;
  implementer)
    if [ "$SCENARIO" = "implementer_adapter_retryable_always" ]; then
      # TASK-14 Phase 3 cross-mission regression (adapter budget,
      # different-role key): the Implementer fails every time with a
      # retryable ADAPTER failure (nonzero exit, pattern-free stderr —
      # generic PROCESS_EXIT_NONZERO/adapter scoped to
      # adapter:<adapter>:implementer), so the mission escalates having
      # exhausted that key while plan_reviewer's own adapter key stays
      # untouched.
      echo "implementer_adapter_retryable_always: simulated adapter failure" >&2
      echo "adapter transport exploded: unexpected EOF from backend" >&2
      exit 1
    fi
    if [ "$SCENARIO" = "speckit_unchecked_task_left" ] && printf '%s\n' "$PROMPT" | grep -q 'phase 2/3' && ! grep -q 'Injected unchecked task' specs/*/tasks.md 2>/dev/null; then
      # Mission 098 task 1.6: append a NEW phase to the feature's tasks.md
      # while the per-phase loop is already running. The loop's phaseList
      # was parsed before this write, so the injected phase is never
      # executed; the mission-final unchecked-task guard re-reads disk and
      # must refuse to complete. The append happens once, on Phase 2's
      # Implementer, and leaves the real Phase 2/3 work untouched.
      for f in specs/*/tasks.md; do
        [ -f "$f" ] || continue
        printf '\n## Phase 4: Injected after planning\n\n- [ ] Injected unchecked task\n' >> "$f"
      done
    fi
    if [ "$SCENARIO" = "speckit_git_invisible_phase" ]; then
      # TASK 15.6F: the real incident replay — creates ONLY the empty docs/
      # directory (a filesystem change Git cannot represent: no counter
      # file, no file output of any kind), then exits 0.
      mkdir -p docs
      emit_task_result
      exit 0
    fi
    if [ "$SCENARIO" = "dirty_worktree_zero_change" ]; then
      # TASK 13 / Problem B: a phase where the Implementer makes NO
      # repository changes at all (not even the attempt-counter bookkeeping
      # file other scenarios use) — the real observed "Implementer made no
      # changes for T001" shape. The scoped delta for this phase must come
      # out completely empty.
      emit_task_result
      exit 0
    fi
    if [ "$SCENARIO" = "finding_task_locality" ]; then
      # TASK-20: the first Implementer call finishes normally. The RETRY that
      # the code-review FAIL sends back drops a marker and sleeps, so the
      # harness can kill the whole tree at exactly "after the FAIL, before the
      # retry does any work" — that is the only moment at which the persisted
      # finding→task record, the wiped roleProgress, and the retry brief that
      # carries every finding are all on disk at once.
      if printf '%s\n' "$PROMPT" | grep -q 'Reviewer feedback from the previous attempt'; then
        : > "./.autopilot-test-finding-task-locality-retry"
        sleep 45
      fi
      emit_task_result
      exit 0
    fi
    if [ "$SCENARIO" = "scoped_rereview" ] || [ "$SCENARIO" = "scoped_rereview_fallback" ]; then
      # TASK-23: per-task Implementer like the carry branch (one
      # ordinal-derived file per task), but the retry writes CHANGED content
      # — an identical rewrite would be invisible to tree attribution and
      # the re-review's fix diff would be empty. The fallback scenario's
      # retry additionally deletes the previous review's baseline manifest,
      # so the re-review falls back to the whole-phase handoff.
      TID=$(printf '%s\n' "$PROMPT" | sed -n 's/^currentTaskId: //p' | head -n 1)
      ORD=$(printf '%s' "$TID" | sed -n 's/.*:T\([0-9][0-9]*\):.*/\1/p')
      if [ -z "$ORD" ]; then ORD="x"; fi
      mkdir -p output
      if printf '%s\n' "$PROMPT" | grep -q 'Reviewer feedback from the previous attempt'; then
        printf 'task output retry\n' > "output/carry-T$ORD.txt"
        if [ "$SCENARIO" = "scoped_rereview_fallback" ]; then
          rm -f .autopilot/baseline/*-review-r1/manifest.json
        fi
      else
        printf 'task output\n' > "output/carry-T$ORD.txt"
      fi
      ATTEMPT_FILE="./.autopilot/.autopilot-test-attempt"
      ATTEMPT=0
      if [ -f "$ATTEMPT_FILE" ]; then ATTEMPT="$(cat "$ATTEMPT_FILE")"; fi
      ATTEMPT=$((ATTEMPT + 1))
      mkdir -p "./.autopilot"
      printf '%s' "$ATTEMPT" > "$ATTEMPT_FILE"
      emit_task_result
      exit 0
    fi
    if [ "$SCENARIO" = "impl_missing_sentinel_once" ] || [ "$SCENARIO" = "impl_missing_sentinel_always" ] || [ "$SCENARIO" = "impl_malformed_sentinel_once" ]; then
      # TASK-25: per-task Implementer that ALWAYS edits its ordinal-derived
      # file, but skips or corrupts the AUTOPILOT_TASK_RESULT sentinel line
      # per scenario. The `once` variants skip/corrupt only the first T1
      # launch (a flag file under .autopilot/ tracks it, invisible to every
      # scoped delta); the relaunch prints a valid line. The `always`
      # variant never prints one, so the mission must escalate on the
      # adapter budget. Mirrors the fake-workflow-adapter-win.mjs branch.
      TID=$(printf '%s\n' "$PROMPT" | sed -n 's/^currentTaskId: //p' | head -n 1)
      ORD=$(printf '%s' "$TID" | sed -n 's/.*:T\([0-9][0-9]*\):.*/\1/p')
      if [ -z "$ORD" ]; then ORD="x"; fi
      mkdir -p output
      printf 'task output\n' > "output/sentinel-T$ORD.txt"
      FLAG="./.autopilot/.autopilot-test-sentinel-skipped"
      if [ "$SCENARIO" = "impl_missing_sentinel_always" ] || { [ ! -f "$FLAG" ] && case "$TID" in *:T0:*) true;; *) false;; esac; }; then
        if [ "$SCENARIO" != "impl_missing_sentinel_always" ]; then
          mkdir -p "./.autopilot"
          : > "$FLAG"
        fi
        if [ "$SCENARIO" = "impl_malformed_sentinel_once" ]; then
          echo "implementer ok"
          echo "AUTOPILOT_TASK_RESULT={not json}"
        else
          echo "implementer ok without a result line"
        fi
        exit 0
      fi
      emit_task_result
      exit 0
    fi
    if [ "$SCENARIO" = "carry_forward_tagged" ] || [ "$SCENARIO" = "carry_forward_untagged" ] || [ "$SCENARIO" = "carry_forward_overlap" ] || [ "$SCENARIO" = "carry_forward_gate" ] || [ "$SCENARIO" = "carry_forward_phasewide" ] || [ "$SCENARIO" = "findings_per_task" ] || [ "$SCENARIO" = "findings_per_task_phasewide" ]; then
      # TASK-21: per-task Implementer writing one ordinal-derived file per
      # task (the intra_role_ten mechanism: the path derives from the
      # prompt's currentTaskId, so the orchestrator's tree attribution gives
      # every task a known owned file). The overlap scenario's T1 retry
      # additionally rewrites T3's file (output/carry-T2.txt), so the
      # overlap rule must re-run T3 instead of carrying it. The generic
      # attempt counter is maintained too, exactly like the branch below.
      TID=$(printf '%s\n' "$PROMPT" | sed -n 's/^currentTaskId: //p' | head -n 1)
      ORD=$(printf '%s' "$TID" | sed -n 's/.*:T\([0-9][0-9]*\):.*/\1/p')
      if [ -z "$ORD" ]; then ORD="x"; fi
      mkdir -p output
      printf 'task output\n' > "output/carry-T$ORD.txt"
      if [ "$SCENARIO" = "carry_forward_overlap" ] && printf '%s\n' "$PROMPT" | grep -q 'Reviewer feedback from the previous attempt'; then
        # Changed content (not an identical rewrite): the orchestrator's
        # tree attribution only reports CHANGED paths, so an identical
        # rewrite would be invisible and the overlap rule would have
        # nothing to fire on.
        case "$TID" in *:T0:*) printf 'task output retry\n' > output/carry-T2.txt ;; esac
      fi
      ATTEMPT_FILE="./.autopilot/.autopilot-test-attempt"
      ATTEMPT=0
      if [ -f "$ATTEMPT_FILE" ]; then ATTEMPT="$(cat "$ATTEMPT_FILE")"; fi
      ATTEMPT=$((ATTEMPT + 1))
      mkdir -p "./.autopilot"
      printf '%s' "$ATTEMPT" > "$ATTEMPT_FILE"
      emit_task_result
      exit 0
    fi
    if [ "$SCENARIO" = "intra_role_ten" ] || [ "$SCENARIO" = "intra_role_work_ahead" ] || [ "$SCENARIO" = "intra_role_crash_after_role" ]; then
      # TASK-19 Phase 4: per-task Implementer. Writes one file per task (its
      # path is derived from the prompt's currentTaskId, so the orchestrator's
      # tree attribution has something to observe), increments a per-repo
      # counter, and on the 8th call drops a marker and sleeps so the harness
      # can kill mid-T8 deterministically. The work-ahead variant also creates
      # a file named by a LATER task's text on the FIRST call, exercising the
      # evidence-only work-ahead signal.
      TID=$(printf '%s\n' "$PROMPT" | sed -n 's/^currentTaskId: //p' | head -n 1)
      SAFE=$(printf '%s' "$TID" | tr ': |' '____')
      mkdir -p output
      printf 'task output\n' > "output/$SAFE.txt"
      if [ "$SCENARIO" = "intra_role_work_ahead" ]; then
        case "$TID" in
          *:T0:*) printf 'work ahead output\n' > output/ahead.txt ;;
        esac
      fi
      CF="./.autopilot/.autopilot-test-intra-count"
      C=0; [ -f "$CF" ] && C="$(cat "$CF")"
      C=$((C + 1)); mkdir -p .autopilot; printf '%s' "$C" > "$CF"
      if [ "$SCENARIO" = "intra_role_ten" ] && [ "$C" -eq 8 ]; then
        : > "./.autopilot-test-intra-t8-marker"
        sleep 5
      fi
      if [ "$SCENARIO" = "intra_role_crash_after_role" ] && [ "$C" -eq 3 ]; then
        # TASK-19 Phase 4: the orchestrator, not the adapter, performs the
        # crash — the child exits 0 normally, and autopilot.mjs's
        # maybeInjectPostRoleCrash() exits after the role returns but before
        # the completion checkpoint is persisted.
        : > "./.autopilot/.autopilot-test-crash-after-role"
      fi
      emit_task_result
      exit 0
    fi
      case "$SCENARIO" in
        standalone_*|speckit_*)
        # TASK-11 Phases 4-5: resume scenarios keep their own attempt
        # counter (separate from the generic one below) under .autopilot/
        # (invisible to scoped phase deltas), so a retried Implementer
        # cannot perturb the recorded delta digest and trip the
        # approval-reuse drift check on resume. Shared by the
        # standalone_* and speckit_* scenario families (per-repo files, so
        # the two families never observe each other's bookkeeping).
        SATTEMPT_FILE="./.autopilot/.autopilot-test-standalone-attempt"
        SATTEMPT=0
        if [ -f "$SATTEMPT_FILE" ]; then SATTEMPT="$(cat "$SATTEMPT_FILE")"; fi
        SATTEMPT=$((SATTEMPT + 1))
        printf '%s' "$SATTEMPT" > "$SATTEMPT_FILE"
        if { [ "$SCENARIO" = "standalone_impl_interrupted" ] || [ "$SCENARIO" = "speckit_impl_interrupted" ]; } && [ "$SATTEMPT" -le 1 ]; then          # Interrupted Implementer: leave partial work in the tree, drop a
          # crash marker, and sleep so the harness kills the tree
          # mid-Implementer. Later invocations return immediately — the
          # resume continues the partial work instead of starting over.
          # partial-work.txt is written once, before any delta is recorded
          # for the phase, so later digest comparisons stay stable.
          printf 'partial implementation output\n' > partial-work.txt
          : > "./.autopilot/.autopilot-test-impl-crash-marker"
          sleep 5
        fi
        if [ "$SCENARIO" = "standalone_verifier_delta_change" ] || [ "$SCENARIO" = "speckit_verifier_delta_change" ]; then
          # Mission 040 tasks 2.2/3.2: simulate an implementer fix between
          # verifier runs — deterministic per-attempt content in an
          # in-scope file, so the retry's scoped delta differs (new
          # cacheKey, no cache hit). Under .autopilot/ would be invisible.
          mkdir -p output
          printf 'delta-change attempt %s\n' "$SATTEMPT" > output/delta-change.txt
        fi
        if [ "$SCENARIO" = "standalone_silent" ]; then
          # Test 094 Phase 4 task 1: run for 7+ seconds so the ~5s refresh
          # interval fires before finalize, allowing behavioral tests to
          # verify mtime advances mid-run (not just at finalization).
          sleep 7
        fi
        if [ "$SCENARIO" = "standalone_refresh_fast" ]; then
          # Test 094 Phase 4 task 2: quick successful run to verify finalize refresh hook fires
          sleep 1
        fi
        emit_task_result
        exit 0
        ;;
    esac
    ATTEMPT_FILE="./.autopilot/.autopilot-test-attempt"
    ATTEMPT=0
    if [ -f "$ATTEMPT_FILE" ]; then ATTEMPT="$(cat "$ATTEMPT_FILE")"; fi
    ATTEMPT=$((ATTEMPT + 1))
    mkdir -p "./.autopilot"
    printf '%s' "$ATTEMPT" > "$ATTEMPT_FILE"
    case "$SCENARIO" in
      dirty_worktree_changes)
        # TASK 13 / Problem B: a genuine implementation change made on top
        # of a repository that already had unrelated dirty/staged/untracked
        # state before the mission started. Creates a brand-new file AND
        # appends to a file that was ALREADY modified before the mission
        # (existing-modified.txt) — the scoped delta must show only this
        # addition, never the pre-existing modification already in that
        # file, and must never mention the OTHER unrelated pre-existing
        # dirty files at all.
        mkdir -p output
        printf 'implementation output\n' > output/notes.md
        printf 'mission-change\n' >> existing-modified.txt
        emit_task_result
        ;;
      implementer_recovered_path_error)
        # TASK 13 / Problem A: the real observed bug. The Implementer
        # attempts to read a file that legitimately does not exist yet
        # (expected before a later task), recovers, and still completes
        # successfully (exit 0). This incidental path-error text must not
        # override the genuinely successful completion.
        echo "cat: docs/AUTOPILOT-SMOKE-TEST-NEW.md: No such file or directory"
        emit_task_result
        ;;
      implementer_unrecovered_path_error)
        # A GENUINE, unrecovered path failure: the same incidental text,
        # but the process actually fails (nonzero exit) instead of
        # recovering. Must still classify as PATH_UNSUPPORTED.
        #
        # On stderr, not stdout: classifyObservedFailure()'s driverless text
        # fallback only ever scans a nonzero-exit process's own STDERR (never
        # stdout, which is the model's own output channel and indistinguishable
        # from genuinely successful tool output) — see failure-contract.mjs.
        echo "cat: docs/AUTOPILOT-SMOKE-TEST-NEW.md: No such file or directory" >&2
        exit 2
        ;;
      implementer_genuine_failure)
        # A genuine failure unrelated to any path text at all. Must still
        # classify as a process failure regardless of the path-error fix.
        echo "internal-error: unexpected implementer failure"
        exit 1
        ;;
      implementer_policy_violation)
        # A genuine Git mutation attempt that still reports success (exit
        # 0, no path-error text at all). Must still fail via policy
        # violation despite the path-error/exit-0 leniency fix.
        git commit -q --allow-empty -m "policy-violation-attempt" >/dev/null 2>&1 || true
        emit_task_result
        ;;
      implementer_safe_symref_query)
        # 15.6J CORRECTION case 1: the exact OpenCode startup probes must
        # pass through the production guard (Layer-1 structural exemption
        # for the read-only HEAD query). Both the plain and the fully
        # qualified argv must exit 0 here; any regression fails the relay.
        git symbolic-ref --quiet --short HEAD >/dev/null || exit 3
        git --no-optional-locks -c core.abbrev=auto symbolic-ref --quiet --short HEAD >/dev/null || exit 4
        emit_task_result
        ;;
      implementer_external_snapshot_init)
        # 15.6J CORRECTION case 2 (CORRECTION-2 fixture A): an external
        # snapshot `git init` (the OpenCode per-session snapshot mechanism,
        # TASK 15.6I) must succeed silently: HEAD created outside the
        # repository, zero official-scope violations.
        #
        # The snapshot directory travels EXCLUSIVELY via the committed
        # `.autopilot-test-snapdir` override file the parent test writes
        # (a custom environment variable could never reach this process:
        # the production relay launch filters the child environment to a
        # fixed safe allowlist). This script must never invent, derive, or
        # clean up any snapshot path of its own — no fixed paths, no rm -rf
        # here. A missing/empty override fails closed and deterministically.
        # The directory is echoed so the test can prove the adapter used
        # exactly the supplied directory and nothing else.
        SNAPDIR=""
        if [ -f "./.autopilot-test-snapdir" ]; then SNAPDIR="$(cat ./.autopilot-test-snapdir)"; fi
        if [ -z "$SNAPDIR" ]; then
          echo "implementer_external_snapshot_init: no snapshot directory supplied (.autopilot-test-snapdir missing or empty)" >&2
          exit 6
        fi
        GIT_DIR="$SNAPDIR" git init -q || exit 5
        echo "SNAPDIR=$SNAPDIR"
        emit_task_result
        ;;
      implementer_exit_zero_after_denial)
        # 15.6J CORRECTION case 3: an official ref mutation is denied by the
        # Layer-2 reference-transaction hook (reached via a config alias so
        # the PATH shim sees only the alias name — the exact
        # swallowed-denial shape); the child then deliberately exits 0. The
        # relay verdict must still FAIL with GIT_MUTATION_BLOCKED. The
        # denial text is echoed so result.json preserves child diagnostics.
        git -c alias.evil156j="update-ref refs/heads/evil-156j-correction HEAD" evil156j 2>&1 || true
        emit_task_result
        ;;
      implementer_checkout_foreign_restore)
        # 024 Phase 4 task 4.3: a worktree path-restore of a file the role
        # did not modify in this run (README.md is committed by the fixture
        # and untouched by the role — foreign by definition). The Layer-1
        # wrapper must deny it (exit 97 + worktree-restore guard event) and
        # the relay verdict must surface it as git_mutation_blocked even
        # though the child swallows the denial and exits 0. Denial text is
        # echoed so result.json preserves child diagnostics.
        git checkout -- README.md 2>&1 || true
        emit_task_result
        ;;
      implementer_checkout_readonly_queries)
        # 024 Phase 4 task 4.3: read-only git queries must pass through the
        # Layer-1 guard with zero guard events and a completed relay — the
        # twin of the foreign-restore denial above. None of these mutates
        # the worktree, so none may trip the worktree-restore guard.
        git status --porcelain=v1 >/dev/null || exit 10
        git log --oneline -5 >/dev/null || exit 11
        git diff --name-only >/dev/null || exit 12
        git symbolic-ref --quiet --short HEAD >/dev/null || exit 13
        emit_task_result
        ;;
      pwd_authority_probe)
        # TASK 15.6K: OpenCode-style write — resolve the relative
        # deliverable from $PWD (not the process cwd), and record the
        # observable triple in a cwd-relative probe file. With correct PWD
        # authority the deliverable lands in the official repository; a
        # launcher-inherited PWD would redirect it into the decoy instead.
        printf 'pwd-authority-ok\n' > "$PWD/pwd-authority-deliverable.txt"
        printf 'role=implementer\ncwd=%s\npwd_env=%s\ninit_cwd=%s\n' "$(pwd)" "$PWD" "${INIT_CWD:-}" > ./pwd-authority-probe-implementer.txt
        emit_task_result
        ;;
      task14_premature_checkbox_fail)
        # TASK 14: a disobedient Implementer that marks every unchecked
        # task in every tasks.md complete on EVERY attempt, despite the
        # orchestrator's explicit instruction not to touch checkboxes.
        # Paired with the code_reviewer branch below (always FAIL for this
        # scenario) to prove Autopilot neutralizes this premature edit
        # before Code Review runs, so tasks.md stays unchecked no matter
        # how many times this runs. Marks EVERY unchecked box in EVERY
        # tasks.md (not just the current phase's own tasks) — against a
        # multi-phase fixture this also poisons FUTURE phases, proving the
        # TASK 14 CORRECTION's feature-wide snapshot/reconcile (not just a
        # current-phase-scoped one) is what actually neutralizes it.
        for f in specs/*/tasks.md; do
          [ -f "$f" ] || continue
          awk '{ gsub(/- \[ \]/, "- [x]"); print }' "$f" > "$f.task14tmp" && mv "$f.task14tmp" "$f"
        done
        emit_task_result
        ;;
      task14_policy_violation_with_marking)
        # TASK 14 CORRECTION: a disobedient Implementer that BOTH marks
        # every unchecked task in every tasks.md complete (current AND
        # future phases) AND makes a real Git mutation that
        # relay-guards.mjs detects as a policy violation (the same
        # detection the pre-existing implementer_policy_violation scenario
        # above relies on). Proves reconciliation runs, and clears the
        # pending snapshot, BEFORE the policy-violation check acts — so a
        # poisoned checkbox can never survive a policy-violation exit.
        for f in specs/*/tasks.md; do
          [ -f "$f" ] || continue
          awk '{ gsub(/- \[ \]/, "- [x]"); print }' "$f" > "$f.task14tmp" && mv "$f.task14tmp" "$f"
        done
        git commit -q --allow-empty -m "policy-violation-attempt" >/dev/null 2>&1 || true
        emit_task_result
        ;;
      task14_crash_before_reconcile)
        # TASK 14 CORRECTION: writes a premature checkbox edit to every
        # tasks.md (current AND future phases), THEN creates a marker file
        # and sleeps. The test harness kills the real `node
        # scripts/autopilot.mjs run` process (SIGKILL) as soon as the
        # marker appears (see runAutopilotUntilMarker in
        # workflow-order-harness.mjs), simulating a crash strictly between
        # this write and Autopilot's own post-relay reconciliation code —
        # which therefore never gets to run in this same process. On
        # resume, only the snapshot Autopilot itself persisted to
        # state.json BEFORE this relay call started (never a fresh read of
        # this scenario's premature edit) may be used to recover.
        for f in specs/*/tasks.md; do
          [ -f "$f" ] || continue
          awk '{ gsub(/- \[ \]/, "- [x]"); print }' "$f" > "$f.task14tmp" && mv "$f.task14tmp" "$f"
        done
        : > "./.autopilot-test-crash-marker"
        sleep 5
        emit_task_result
        ;;
      *)
        emit_task_result
        ;;
    esac
    ;;
  code_reviewer)
    # Attempt-counter based (like verifier below), not feedback-marker
    # based: a separate, unrelated "final repository review" code_reviewer
    # call happens once per mission with no feedback text at all, so a
    # feedback-marker check cannot tell it apart from a genuine first
    # attempt at the task-level review.
    ATTEMPT=0
    if [ -f "./.autopilot/.autopilot-test-attempt" ]; then ATTEMPT="$(cat "./.autopilot/.autopilot-test-attempt")"; fi
    if [ -f "./.autopilot/.autopilot-test-reviewer-hold" ]; then
      # Backlog #83: opt-in (the hold file is written only by
      # test-intra-role-progress-resume) -- block so the test can kill the
      # tree while the Code Reviewer runs and read the still-live phase
      # checkpoint. A read-only role cannot drop a marker file, so the test
      # watches for this role's run directory instead.
      sleep 7301
      review_output PASS ""
    elif [ "$SCENARIO" = "pwd_authority_probe" ]; then
      # TASK 15.6K: read-only envelope probe (same shape as plan_reviewer).
      _RCWD="$(pwd | tr -d '"\\')"; _RPWD="$(printf '%s' "$PWD" | tr -d '"\\')"; _RINIT="$(printf '%s' "${INIT_CWD:-}" | tr -d '"\\')"
      _RSCEN="no"; if [ -f "./.autopilot/.autopilot-test-scenario" ] || [ -f "./.autopilot-test-scenario" ]; then _RSCEN="yes"; fi
      printf 'AUTOPILOT_REVIEW={"decision":"PASS","findings":["role=code_reviewer","cwd=%s","pwd_env=%s","init_cwd=%s","scenario_present=%s"]}\n' "$_RCWD" "$_RPWD" "$_RINIT" "$_RSCEN"
    elif scoped_delta_contains_forbidden_marker; then
      review_output FAIL "forbidden baseline marker present in scoped delta"
    elif [ "$SCENARIO" = "finding_task_locality" ] && phase_review_call; then
      # TASK-20: a STRUCTURED finding that names its task by the reviewer
      # label the phase handoff now shows (`[T1]`). review_output() only
      # emits plain-string findings, so the tagged shape is written out here
      # verbatim. Gated to a per-phase review call: the separate whole-mission
      # final review never runs in this scenario, but it must never be
      # scripted to fail either.
      printf 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"tasks":["T1"],"location":"docs/finding-task-locality.md","problem":"Task T1 ships a stub with no implementation.","correction":"Replace the stub with the real implementation."}]}\n'
    elif [ "$SCENARIO" = "carry_forward_tagged" ] && phase_review_call; then
      # TASK-21: FAIL once with a finding tagged ["T2"], hang once (the
      # harness kills the tree on deadline mid-review to observe the
      # post-retry state), then PASS. The hang keys off unfinished runs
      # exactly like the standalone_reviewer_hang case.
      if ! prior_role_result code_reviewer; then
        printf 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"tasks":["T2"],"location":"docs/carry-forward.md","problem":"Task T2 ships a stub with no implementation.","correction":"Replace the stub with the real implementation."}]}\n'
      elif [ "$(unfinished_role_runs code_reviewer)" -le 1 ]; then
        sleep 300
        echo "carry_forward_tagged: hang window elapsed without interruption" >&2
        exit 124
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "carry_forward_untagged" ] && phase_review_call; then
      # TASK-21: FAIL once with a PLAIN-STRING finding (no task tag, no
      # location — unmappable), hang once, then PASS. The retry must
      # re-launch every task.
      if ! prior_role_result code_reviewer; then
        review_output FAIL "carry forward untagged finding with nowhere in particular"
      elif [ "$(unfinished_role_runs code_reviewer)" -le 1 ]; then
        sleep 300
        echo "carry_forward_untagged: hang window elapsed without interruption" >&2
        exit 124
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "carry_forward_overlap" ] && phase_review_call; then
      # TASK-21: FAIL once tagged ["T1"], hang once, then PASS. T1's retry
      # rewrites T3's file (see the implementer branch), so T3 must be
      # re-launched too while T2 is carried.
      if ! prior_role_result code_reviewer; then
        printf 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"tasks":["T1"],"location":"docs/carry-forward.md","problem":"Task T1 ships a stub with no implementation.","correction":"Replace the stub with the real implementation."}]}\n'
      elif [ "$(unfinished_role_runs code_reviewer)" -le 1 ]; then
        sleep 300
        echo "carry_forward_overlap: hang window elapsed without interruption" >&2
        exit 124
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "carry_forward_phasewide" ] && phase_review_call; then
      # TASK-22: FAIL once with one finding tagged ["T2"] and one explicitly
      # phase-wide (`tasks: []`), hang once, then PASS. The phase-wide
      # finding forces allMapped false, so the retry must re-launch all 3
      # tasks despite the T2 tag.
      if ! prior_role_result code_reviewer; then
        printf 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"tasks":["T2"],"location":"docs/carry-forward.md","problem":"Task T2 ships a stub with no implementation.","correction":"Replace the stub with the real implementation."},{"tasks":[],"location":"docs/carry-forward.md","problem":"The cross-task wiring is inconsistent.","correction":"Make the wiring consistent across tasks."}]}\n'
      elif [ "$(unfinished_role_runs code_reviewer)" -le 1 ]; then
        sleep 300
        echo "carry_forward_phasewide: hang window elapsed without interruption" >&2
        exit 124
      else
        review_output PASS ""
      fi
    elif { [ "$SCENARIO" = "scoped_rereview" ] || [ "$SCENARIO" = "scoped_rereview_fallback" ]; } && phase_review_call; then
      # TASK-23: FAIL once with a finding tagged ["T2"], then PASS (no hang
      # needed — the whole mission completes in one run). The retry re-runs
      # T2 only with a new change; the second review must be the scoped
      # re-review (FIX marker, fix-only delta, FEEDBACK TO ADDRESS).
      if ! prior_role_result code_reviewer; then
        printf 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"tasks":["T2"],"location":"docs/scoped-rereview.md","problem":"Task T2 ships a stub with no implementation.","correction":"Replace the stub with the real implementation."}]}\n'
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "findings_per_task" ] && phase_review_call; then
      # TASK-24: FAIL once with T1 + T3 findings, then PASS (no hang — the
      # mission completes in one run; the retry re-runs T1+T3, carries T2).
      if ! prior_role_result code_reviewer; then
        printf 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"tasks":["T1"],"location":"docs/findings-per-task.md","problem":"FINDING-ONE","correction":"Fix the first task."},{"tasks":["T3"],"location":"docs/findings-per-task.md","problem":"FINDING-THREE","correction":"Fix the third task."}]}\n'
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "findings_per_task_phasewide" ] && phase_review_call; then
      # TASK-24: FAIL once with one phase-wide ([]) plus one ["T2"]
      # finding, then PASS. allMapped is false so all 3 re-run.
      if ! prior_role_result code_reviewer; then
        printf 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"tasks":[],"location":"docs/findings-per-task.md","problem":"FINDING-PHASEWIDE","correction":"Rewire the phase."},{"tasks":["T2"],"location":"docs/findings-per-task.md","problem":"FINDING-TWO","correction":"Fix the second task."}]}\n'
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "standalone_reviewer_hang" ] && phase_review_call && [ "$(unfinished_role_runs code_reviewer)" -le 1 ]; then
      # TASK-11 Phase 4 case 1: hang exactly once — the harness kills the
      # tree on deadline mid-review. The killed run's dir persists without
      # result.json, so the resume observes count 2 and PASSes below.
      # A read-only role cannot drop a crash marker; the long sleep plus the
      # harness deadline is the deterministic kill window instead.
      sleep 45
      echo "standalone_reviewer_hang: hang window elapsed without interruption" >&2
      exit 124
    elif [ "$SCENARIO" = "standalone_reviewer_infra_once" ] && phase_review_call && ! prior_role_result code_reviewer; then
      # TASK-11 Phase 4 case 4: infrastructure failure (nonzero exit, no
      # review sentinel), exactly once — the prior result exists on retry,
      # so the retry PASSes. Must retry only the Reviewer.
      echo "standalone_reviewer_infra_once: simulated infrastructure failure" >&2
      exit 1
    elif [ "$SCENARIO" = "standalone_reviewer_fail_once" ] && phase_review_call && ! has_feedback; then
      # TASK-11 Phase 4 case 5: functional FAIL with exact findings once;
      # the retry carries FEEDBACK TO ADDRESS and PASSes. Must return to
      # the Implementer with the findings.
      review_output FAIL "fix the widget alignment"
    elif [ "$SCENARIO" = "standalone_attempts_survive" ] && phase_review_call; then
      # TASK-11 Phase 4 case 10: exit 1 (infra) on the first invocation,
      # hang on the retry (killed on deadline), PASS on the post-kill
      # resume — proving attempt counters survive the restart. Pure
      # function of monotonic run history, in this order: no result yet
      # means first invocation; one unfinished run (self) with a result on
      # file means the retry; anything else means a prior hang was killed.
      if ! prior_role_result code_reviewer && [ "$(unfinished_role_runs code_reviewer)" -le 1 ]; then
        echo "standalone_attempts_survive: simulated infrastructure failure" >&2
        exit 1
      elif [ "$(unfinished_role_runs code_reviewer)" -le 1 ]; then
        sleep 45
        echo "standalone_attempts_survive: hang window elapsed without interruption" >&2
        exit 124
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "speckit_reviewer_hang" ] && phase_review_call && [ "$(unfinished_role_runs code_reviewer)" -le 1 ]; then
      # TASK-11 Phase 5: hang exactly once — the harness kills the
      # tree on deadline mid-review. The killed run's dir persists without
      # result.json, so the resume observes count 2 and PASSes below.
      # A read-only role cannot drop a crash marker (the bubblewrap bind
      # is read-only — the write itself fails), so like the standalone
      # hangs this uses the long sleep plus the harness deadline instead.
      # The sleep is deliberately long (120s): SpecKit planning precedes
      # implementation, so the hang starts later than a standalone one;
      # the 60s harness deadline lands inside [start, start+120] for any
      # plausible planning duration while the mission cannot complete
      # before the deadline (the hang blocks it).
      sleep 120
      echo "speckit_reviewer_hang: hang window elapsed without interruption" >&2
      exit 124
    elif [ "$SCENARIO" = "speckit_reviewer_infra_once" ] && phase_review_call && ! prior_role_result code_reviewer; then
      # TASK-11 Phase 5: infrastructure failure (nonzero exit, no
      # review sentinel), exactly once — the prior result exists on retry,
      # so the retry PASSes. Must retry only the Reviewer.
      echo "speckit_reviewer_infra_once: simulated infrastructure failure" >&2
      exit 1
    elif [ "$SCENARIO" = "speckit_reviewer_fail_once" ] && phase_review_call && ! has_feedback; then
      # TASK-11 Phase 5: functional FAIL with exact findings once;
      # the retry carries FEEDBACK TO ADDRESS and PASSes. Must return to
      # the Implementer with the findings.
      review_output FAIL "realign the widget grid"
    elif [ "$SCENARIO" = "task14_observe_unchecked" ] && printf '%s\n' "$PROMPT" | grep -q '^Phase: ' && grep -q '^- \[x\] Do the fixture task' specs/001-fixture-feature/tasks.md 2>/dev/null; then
      # TASK 14 CORRECTION / ordering proof: this reviewer independently
      # reads the REAL tasks.md content (never prompt text) at the moment
      # it runs. If the fixture task is already "[x]" here, marking
      # happened too early — before Code Review — and this call FAILs on
      # that observed fact alone. In correct behavior this branch is never
      # taken (marking only ever happens after Verifier PASS), so a PASS
      # decision for this scenario is itself proof Code Review observed
      # the task genuinely unchecked. Gated to a PER-PHASE review call
      # (identified the same observable way autopilot.mjs's own prompt
      # always includes it: a "Phase: " line) — the SEPARATE final
      # whole-mission review that runs once all phases are done and the
      # task IS legitimately "[x]" by then must never be flagged by this.
      review_output FAIL "task14 fixture: code reviewer observed the task already checked before verification"
    elif [ "$SCENARIO" = "task14_review_always_fail" ] || [ "$SCENARIO" = "task14_premature_checkbox_fail" ]; then
      # TASK 14: Code Review that NEVER passes for this scenario (not just
      # once) — a deterministic, non-racy way to prove tasks.md is left
      # unchecked after a Code Review failure: since marking only ever
      # happens after a Verifier PASS (which can never be reached here),
      # observing tasks.md after this scenario runs to budget exhaustion
      # is a reliable, un-timed proof, not a best-effort snapshot.
      review_output FAIL "task14 fixture: code review always fails"
    elif [ "$ATTEMPT" -le 1 ] && { [ "$SCENARIO" = "code_review_fail" ] || [ "$SCENARIO" = "dirty_worktree_changes" ]; }; then
      # dirty_worktree_changes also fails once then passes (TASK 13 /
      # Problem B retry/resume regression): proves the implementation
      # baseline is captured exactly once and survives the retry, never
      # re-capturing (which would silently absorb attempt 1's changes as
      # "pre-existing" and hide them from the attempt-2 review).
      review_output FAIL "fix the bug"
    else
      review_output PASS ""
    fi
    ;;
  verifier)
    ATTEMPT=0
    if [ -f "./.autopilot/.autopilot-test-attempt" ]; then ATTEMPT="$(cat "./.autopilot/.autopilot-test-attempt")"; fi
    if [ "$SCENARIO" = "pwd_authority_probe" ]; then
      # TASK 15.6K: read-only envelope probe (same shape as plan_reviewer).
      _RCWD="$(pwd | tr -d '"\\')"; _RPWD="$(printf '%s' "$PWD" | tr -d '"\\')"; _RINIT="$(printf '%s' "${INIT_CWD:-}" | tr -d '"\\')"
      _RSCEN="no"; if [ -f "./.autopilot/.autopilot-test-scenario" ] || [ -f "./.autopilot-test-scenario" ]; then _RSCEN="yes"; fi
      printf 'AUTOPILOT_REVIEW={"decision":"PASS","findings":["role=verifier","cwd=%s","pwd_env=%s","init_cwd=%s","scenario_present=%s"]}\n' "$_RCWD" "$_RPWD" "$_RINIT" "$_RSCEN"
    elif [ "$SCENARIO" = "role_deadline_breach" ] && phase_review_call; then
      # TASK-26: sleep past the tiny seeded derived deadline (the test sets
      # a 4s deadline via seeded samples + role_deadline_floor_ms), then
      # PASS. The first attempt times out (breach flag set); the retry runs
      # under the relay ceiling and completes. Mirrors the win adapter branch.
      sleep 20
      review_output PASS ""
    elif scoped_delta_contains_forbidden_marker; then
      review_output FAIL "forbidden baseline marker present in scoped delta"
    elif [ "$SCENARIO" = "standalone_verifier_hang" ] && phase_review_call && [ "$(unfinished_role_runs verifier)" -le 1 ]; then
      # TASK-11 Phase 4 case 2: hang exactly once — the harness kills the
      # tree on deadline mid-verification. The killed run's dir persists
      # without result.json, so the resume observes count 2 and PASSes.
      sleep 45
      echo "standalone_verifier_hang: hang window elapsed without interruption" >&2
      exit 124
    elif [ "$SCENARIO" = "standalone_verifier_infra_once" ] && phase_review_call && ! prior_role_result verifier; then
      # TASK-11 Phase 4 case 3: infrastructure failure (nonzero exit, no
      # review sentinel), exactly once. Must retry only the Verifier. The
      # second stderr line matches failure-contract.mjs's serverPattern, so
      # this is a real SERVER_UNAVAILABLE/infrastructure failure (retryable),
      # not the generic adapter-domain nonzero exit.
      echo "standalone_verifier_infra_once: simulated infrastructure failure" >&2
      echo "server unavailable: upstream model endpoint refused the connection" >&2
      exit 1
    elif [ "$SCENARIO" = "standalone_verifier_fail_once" ] && phase_review_call; then
      # TASK-11 Phase 4 case 6: functional FAIL once, keyed off the
      # Implementer-maintained standalone counter under .autopilot/ (a
      # read-only role cannot keep its own). Must run Implementer, then
      # Reviewer, then Verifier again.
      SATTEMPT=0
      if [ -f "./.autopilot/.autopilot-test-standalone-attempt" ]; then SATTEMPT="$(cat "./.autopilot/.autopilot-test-standalone-attempt")"; fi
      if [ "$SATTEMPT" -le 1 ]; then
        review_output FAIL "coverage gap"
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "standalone_verifier_delta_change" ] && phase_review_call; then
      # Mission 040 task 2.2: functional FAIL once (same shape as
      # fail_once) — the retry's Implementer rewrites
      # output/delta-change.txt (see standalone_* branch above), so the
      # retry's scoped delta differs (new cacheKey, no cache hit).
      SATTEMPT=0
      if [ -f "./.autopilot/.autopilot-test-standalone-attempt" ]; then SATTEMPT="$(cat "./.autopilot/.autopilot-test-standalone-attempt")"; fi
      if [ "$SATTEMPT" -le 1 ]; then
        review_output FAIL "coverage gap"
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "speckit_verifier_delta_change" ] && phase_review_call; then
      # Mission 040 task 3.2: SpecKit twin of standalone_verifier_delta_change
      # — functional FAIL once ("coverage shortfall" per the speckit family
      # convention); the retry's Implementer rewrites
      # output/delta-change.txt (see standalone_*|speckit_* branch above),
      # so the retry's scoped delta differs (new cacheKey, no cache hit).
      SATTEMPT=0
      if [ -f "./.autopilot/.autopilot-test-standalone-attempt" ]; then SATTEMPT="$(cat "./.autopilot/.autopilot-test-standalone-attempt")"; fi
      if [ "$SATTEMPT" -le 1 ]; then
        review_output FAIL "coverage shortfall"
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "standalone_attempts_survive" ] && phase_review_call && [ "$(unfinished_role_runs verifier)" -le 1 ]; then
      # TASK-11 Phase 4 case 10 (verifier half): hang exactly once — the
      # harness kills the tree on deadline mid-verification. The resume
      # observes count 2 and PASSes below.
      sleep 45
      echo "standalone_attempts_survive: hang window elapsed without interruption" >&2
      exit 124
    elif [ "$SCENARIO" = "speckit_verifier_hang" ] && phase_review_call && [ "$(unfinished_role_runs verifier)" -le 1 ]; then
      # TASK-11 Phase 5: hang exactly once — the killed run's dir persists
      # without result.json, so a resume observes count 2 and PASSes.
      # No crash marker: a read-only role cannot write under the
      # read-only bubblewrap bind (kept marker-free even though no
      # current case kills mid-verifier, so the scenario stays safe).
      sleep 45
      echo "speckit_verifier_hang: hang window elapsed without interruption" >&2
      exit 124
    elif [ "$SCENARIO" = "speckit_verifier_infra_once" ] && phase_review_call && ! prior_role_result verifier; then
      # TASK-11 Phase 5: infrastructure failure (nonzero exit, no
      # review sentinel), exactly once. Must retry only the Verifier. The
      # second stderr line matches failure-contract.mjs's serverPattern, so
      # this is a real SERVER_UNAVAILABLE/infrastructure failure (retryable),
      # not the generic adapter-domain nonzero exit.
      echo "speckit_verifier_infra_once: simulated infrastructure failure" >&2
      echo "server unavailable: upstream model endpoint refused the connection" >&2
      exit 1
    elif [ "$SCENARIO" = "speckit_verifier_fail_once" ] && phase_review_call; then
      # TASK-11 Phase 5: functional FAIL once, keyed off the
      # Implementer-maintained hidden counter under .autopilot/ (a
      # read-only role cannot keep its own). Must run Implementer, then
      # Reviewer, then Verifier again.
      SATTEMPT=0
      if [ -f "./.autopilot/.autopilot-test-standalone-attempt" ]; then SATTEMPT="$(cat "./.autopilot/.autopilot-test-standalone-attempt")"; fi
      if [ "$SATTEMPT" -le 1 ]; then
        review_output FAIL "coverage shortfall"
      else
        review_output PASS ""
      fi
    elif [ "$SCENARIO" = "task14_observe_unchecked" ] && grep -q '^- \[x\] Do the fixture task' specs/001-fixture-feature/tasks.md 2>/dev/null; then
      # TASK 14 CORRECTION / ordering proof: same independent real-file
      # observation as the code_reviewer branch above, for the Verifier.
      review_output FAIL "task14 fixture: verifier observed the task already checked before its own PASS"
    elif [ "$SCENARIO" = "task14_verify_always_fail" ]; then
      # TASK 14: Verifier that NEVER passes for this scenario — the same
      # deterministic non-racy proof as task14_review_always_fail above,
      # but for a permanently-failing Verifier instead of Code Reviewer.
      review_output FAIL "task14 fixture: verifier always fails"
    elif [ "$SCENARIO" = "task14_phase_verify_fail" ] && printf '%s\n' "$PROMPT" | grep -q "^Phase: Phase 3"; then
      # TASK 14: phase-targeted permanent Verifier failure — only Phase 3's
      # verification always fails, so earlier phases (Phase 2) can
      # genuinely complete and get marked while Phase 3's task is left
      # pending forever, proving a later phase's unchecked task blocks
      # mission completion without preventing earlier phases from being
      # marked.
      review_output FAIL "task14 fixture: phase 3 verification always fails"
    elif [ "$SCENARIO" = "gate_result_report" ]; then
      # TASK-40: the Verifier echoes back what its prompt carried so the
      # fixture test can prove the orchestrator-run gate's recorded result —
      # including the failing tail and the log path — actually reached the
      # brief. Always PASS: the phase outcome is driven by the gate itself.
      _GS="no"; _MARK="no"; _LOG="no"
      printf '%s\n' "$PROMPT" | grep -q 'Gate result' && _GS="yes"
      printf '%s\n' "$PROMPT" | grep -qx 'FAILING-TAIL-MARKER' && _MARK="yes"
      printf '%s\n' "$PROMPT" | grep -q 'phase-.*\.log' && _LOG="yes"
      printf 'AUTOPILOT_REVIEW={"decision":"PASS","findings":["gate_section=%s","tail_marker=%s","log_path=%s"]}\n' "$_GS" "$_MARK" "$_LOG"
    elif [ "$SCENARIO" = "verification_fail" ] && [ "$ATTEMPT" -le 1 ]; then
      review_output FAIL "tests are red"
    elif [ "$SCENARIO" = "carry_forward_gate" ] && phase_review_call; then
      # TASK-21: the code reviewer always PASSes for this scenario; the
      # Verifier FAILs once with a finding tagged ["T1"] while the gate
      # command also fails (see the test's gates.commands), hang once (the
      # harness kills the tree on deadline mid-verification to observe the
      # post-retry state), then PASS. A failed gate is whole-phase
      # evidence, so the retry must re-launch every task despite the tag.
      if ! prior_role_result verifier; then
        printf 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":[{"tasks":["T1"],"location":"docs/carry-forward.md","problem":"Task T1 fails the gate check.","correction":"Make the gate check pass."}]}\n'
      elif [ "$(unfinished_role_runs verifier)" -le 1 ]; then
        sleep 300
        echo "carry_forward_gate: hang window elapsed without interruption" >&2
        exit 124
      else
        review_output PASS ""
      fi
    else
      review_output PASS ""
    fi
    ;;
  *)
    echo "fake-workflow-adapter: unknown ROLE '$ROLE'" 1>&2
    exit 1
    ;;
esac
exit 0
