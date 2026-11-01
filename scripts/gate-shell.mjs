// The execution shell for gate commands, shared by the pipeline gate and the
// setup/config probe. Keeping the environment/guard construction in one place
// is deliberate: the setup probe must run a test command exactly the way the
// phase gate will run it (same sandbox scratch, same env allowlist, same
// network-isolation decision), never through a second, subtly different path.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createGitMutationGuard, guardedCommandEnv } from "./relay-guards.mjs";
import { createShellGuard } from "./shell-guard.mjs";

// `scratchRepo` owns `.autopilot/runs/shell-*`; `cwd` is where the command
// runs (they differ for GSD worktrees). `networkIsolationEnabled` is threaded
// explicitly for the same reason as in autopilot.mjs: parallel callers must
// not share mutable state.
export function createGateShell(scratchRepo, cwd, networkIsolationEnabled = true, envAllowlist = []) {
  const dir = path.join(scratchRepo, ".autopilot", "runs", `shell-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const guard = createGitMutationGuard(dir, cwd);
  const shellGuard = createShellGuard(dir);
  shellGuard.networkIsolationEnabled = networkIsolationEnabled;
  return { guard, shellGuard, env: guardedCommandEnv(guard, {}, envAllowlist) };
}
