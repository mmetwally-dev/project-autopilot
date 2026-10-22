// Scheduling constraints for scripts/test-all.mjs's parallel runner.
//
// Kept out of test-all.mjs on purpose: every quoted test file name in that
// file is read as an exclusion by test-playwright-package-contract.mjs, and
// nothing listed here is excluded — it only changes WHEN a test runs.

// Run alone, after every other test has finished: snapshots the whole skill
// root and requires that nothing under it changed while it ran.
export const runAlone = new Set([
  "test-cross-platform-ap-launcher.mjs",
]);

// Backlog #27: spawn-heavy tests whose result depends on the host having
// spare process/file-descriptor headroom. They scale their own timeouts with
// AP_TEST_TIMEOUT_FACTOR, but under a fully loaded pool the wizard's model
// discovery can still come back empty (EAGAIN) rather than slow. Run them
// sequentially after the parallel pool.
export const serialAtEnd = new Set([
  "test-planning-review-resume.mjs",
  "test-opencode-variants.mjs",
  // Backlog #214: the live-usage watch assertion depends on the first usage
  // sample landing while the run is held open; under a loaded pool the watch
  // snapshot can still lag, so run it alone after the pool too.
  "test-live-usage.mjs",
]);

// Tests sharing a group never run at the same time as each other (they may
// still overlap with tests outside the group).

// The "real-cli" group: drives the real installed CLIs with the operator's
// real credentials and their shared on-disk state (rate limits,
// ~/.local/share/opencode, ~/.gemini/antigravity-cli). Defined once here and
// reused by both exclusiveGroups and liveTests so the list lives in one place.
const realCliTests = [
  "test-opencode-scratch-permission.mjs",
  "test-model-discovery-live.mjs",
  "test-agy-live-probe.mjs",
];
export const exclusiveGroups = {
  "real-cli": realCliTests,
};

// Tests that need real CLIs, credentials, or the network. test-all.mjs
// skips these with --skip-live (or AP_TEST_SKIP_LIVE=1).
export const liveTests = new Set(realCliTests);

// Split into this many parts that run in parallel: part k of n gets
// AP_TEST_SHARD="k/n" and runs every n-th end-to-end case of the file. One
// part per case lets the longest-first scheduler balance them. The file must
// read AP_TEST_SHARD; run directly without it, it still runs every case.
export const shards = {
  // 20 end-to-end cases on Linux (12 on Windows), ~31 min when run serially.
  "test-finding-task-locality.mjs": 20,
};
