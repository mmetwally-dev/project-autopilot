// Pure formatter, no I/O: renders the Playwright module/browser status lines
// shown by `ap setup`/`ap config`, from an already-computed
// discoverPlaywrightRuntime() result (playwright-runtime.mjs). Kept in its
// own module (never defined inline in setup.mjs) so it can be imported for
// tests without pulling in setup.mjs's unconditional top-level wizard
// side effects (readline/stdin, config read/write) that run on any import.
export function formatPlaywrightStatusBlock(playwrightRuntime) {
  const dimensions = [
    { name: "module", detail: playwrightRuntime?.module, envVar: "PLAYWRIGHT_MODULE_DIR" },
    { name: "browser", detail: playwrightRuntime?.browser, envVar: "PLAYWRIGHT_BROWSERS_PATH" }
  ];
  const lines = dimensions.map(({ name, detail, envVar }) => {
    if (detail?.status === "discovered") {
      return `✓ Playwright ${name}: available (source: ${detail.source})`;
    }
    if (detail?.status === "invalid-explicit-override") {
      return `· Playwright ${name}: misconfigured (${envVar} is set but invalid)`;
    }
    return `· Playwright ${name}: not installed`;
  });
  if (playwrightRuntime?.module?.status !== "discovered") {
    lines.push("Install: npm install playwright");
  }
  if (playwrightRuntime?.browser?.status !== "discovered") {
    lines.push("Install: npx playwright install chromium");
  }
  if (
    playwrightRuntime?.module?.status !== "discovered" ||
    playwrightRuntime?.browser?.status !== "discovered"
  ) {
    lines.push(
      `Re-run "ap setup" (or "ap config") afterward to confirm the install — this does not re-check automatically.`
    );
  }
  return lines.join("\n");
}
