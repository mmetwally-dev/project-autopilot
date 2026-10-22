@echo off
rem Project Autopilot - Native Windows convenience launcher.
rem
rem OPTIONAL CONVENIENCE ONLY. `node bin\ap.cjs <command>` remains the
rem authoritative entrypoint and is always supported. Nothing here duplicates
rem command dispatch: every argument is forwarded verbatim to the sibling
rem bin\ap.cjs, which owns all command handling.
rem
rem Design notes:
rem   * %~dp0 is this launcher's own physical directory and always ends with a
rem     backslash, so ap.cjs is resolved relative to the launcher, never
rem     relative to the caller's current directory.
rem   * The current directory is never changed, so ap.cjs observes the
rem     caller's original working directory.
rem   * %* forwards the original argument tail verbatim, preserving order,
rem     quoting, embedded spaces and empty arguments.
rem   * Delayed expansion is never enabled and no argument is rewritten, so
rem     `!` and `^` inside arguments reach Node unmodified.
rem   * Node is resolved from the Windows PATH only. This launcher never
rem     invokes wsl.exe and never redirects execution into a WSL distro.
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is required to run Project Autopilot, but 'node' was not found on PATH. 1>&2
  echo Install Node.js 18 or newer, ensure 'node' is on your PATH, then run this command again. 1>&2
  echo This launcher never downloads, installs or modifies anything on your system. 1>&2
  exit /b 127
)
node "%~dp0ap.cjs" %*
exit /b %errorlevel%
