import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectTestCommand, resolveGatesCommands } from './detect-test-command.mjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message} (expected: "${expected}", got: "${actual}")`);
    failed++;
  }
}

async function runTest(name, fn) {
  console.log(`\n${name}:`);
  const testDir = join(tmpdir(), `detect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  try {
    await fn(testDir);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('Running detection logic tests...\n');

  // Test 1: package.json with test script (highest priority)
  await runTest('Test 1: package.json with test script', async (dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'npm test' } }));
    assertEqual(detectTestCommand(dir), 'npm test', 'detects npm test from package.json');
  });

  // Test 2: package.json without test script (should fall through)
  await runTest('Test 2: package.json without test script', async (dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'npm run build' } }));
    writeFileSync(join(dir, 'pytest.ini'), '[pytest]\n');
    assertEqual(detectTestCommand(dir), 'pytest', 'falls through to pytest when package.json has no test script');
  });

  // Test 3: pytest.ini
  await runTest('Test 3: pytest.ini', async (dir) => {
    writeFileSync(join(dir, 'pytest.ini'), '[pytest]\n');
    assertEqual(detectTestCommand(dir), 'pytest', 'detects pytest from pytest.ini');
  });

  // Test 4: pyproject.toml with [tool.pytest]
  await runTest('Test 4: pyproject.toml with [tool.pytest]', async (dir) => {
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    assertEqual(detectTestCommand(dir), 'pytest', 'detects pytest from pyproject.toml');
  });

  // Test 5: pyproject.toml without [tool.pytest] (should fall through)
  await runTest('Test 5: pyproject.toml without [tool.pytest]', async (dir) => {
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.black]\n');
    writeFileSync(join(dir, 'go.mod'), 'module example\n');
    assertEqual(detectTestCommand(dir), 'go test ./...', 'falls through to go.mod when pyproject.toml has no pytest');
  });

  // Test 6: go.mod
  await runTest('Test 6: go.mod', async (dir) => {
    writeFileSync(join(dir, 'go.mod'), 'module example\n');
    assertEqual(detectTestCommand(dir), 'go test ./...', 'detects go test from go.mod');
  });

  // Test 7: Cargo.toml
  await runTest('Test 7: Cargo.toml', async (dir) => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "test"\nversion = "0.1.0"\n');
    assertEqual(detectTestCommand(dir), 'cargo test', 'detects cargo test from Cargo.toml');
  });

  // Test 8: Makefile with test target
  await runTest('Test 8: Makefile with test target', async (dir) => {
    writeFileSync(join(dir, 'Makefile'), 'test:\n\techo "running tests"\n');
    assertEqual(detectTestCommand(dir), 'make test', 'detects make test from Makefile');
  });

  // Test 9: Makefile without test target (should fall through)
  await runTest('Test 9: Makefile without test target', async (dir) => {
    writeFileSync(join(dir, 'Makefile'), 'build:\n\techo "building"\n');
    assertEqual(detectTestCommand(dir), null, 'returns null when Makefile has no test target');
  });

  // Test 10: Priority order - package.json wins over pytest
  await runTest('Test 10: Priority - package.json over pytest', async (dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'npm test' } }));
    writeFileSync(join(dir, 'pytest.ini'), '[pytest]\n');
    writeFileSync(join(dir, 'go.mod'), 'module example\n');
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "test"\n');
    writeFileSync(join(dir, 'Makefile'), 'test:\n\techo "test"\n');
    assertEqual(detectTestCommand(dir), 'npm test', 'package.json has highest priority');
  });

  // Test 11: Priority order - pytest wins over go.mod
  await runTest('Test 11: Priority - pytest over go.mod', async (dir) => {
    writeFileSync(join(dir, 'pytest.ini'), '[pytest]\n');
    writeFileSync(join(dir, 'go.mod'), 'module example\n');
    assertEqual(detectTestCommand(dir), 'pytest', 'pytest has priority over go.mod');
  });

  // Test 12: Priority order - go.mod wins over Cargo.toml
  await runTest('Test 12: Priority - go.mod over Cargo.toml', async (dir) => {
    writeFileSync(join(dir, 'go.mod'), 'module example\n');
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "test"\n');
    assertEqual(detectTestCommand(dir), 'go test ./...', 'go.mod has priority over Cargo.toml');
  });

  // Test 13: Priority order - Cargo.toml wins over Makefile
  await runTest('Test 13: Priority - Cargo.toml over Makefile', async (dir) => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "test"\n');
    writeFileSync(join(dir, 'Makefile'), 'test:\n\techo "test"\n');
    assertEqual(detectTestCommand(dir), 'cargo test', 'Cargo.toml has priority over Makefile');
  });

  // Test 14: No detection - empty directory
  await runTest('Test 14: No detection - empty directory', async (dir) => {
    assertEqual(detectTestCommand(dir), null, 'returns null for empty directory');
  });

  // Test 15: No detection - only unrelated files
  await runTest('Test 15: No detection - only unrelated files', async (dir) => {
    writeFileSync(join(dir, 'README.md'), '# Project\n');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/main.js'), 'console.log("hello");\n');
    assertEqual(detectTestCommand(dir), null, 'returns null when no test config files exist');
  });

  // Test 16: Malformed package.json (invalid JSON)
  await runTest('Test 16: Malformed package.json', async (dir) => {
    writeFileSync(join(dir, 'package.json'), '{ invalid json }');
    writeFileSync(join(dir, 'pytest.ini'), '[pytest]\n');
    assertEqual(detectTestCommand(dir), 'pytest', 'handles malformed package.json gracefully, falls to pytest');
  });

  // Test 17: Empty package.json
  await runTest('Test 17: Empty package.json', async (dir) => {
    writeFileSync(join(dir, 'package.json'), '');
    writeFileSync(join(dir, 'go.mod'), 'module example\n');
    assertEqual(detectTestCommand(dir), 'go test ./...', 'handles empty package.json gracefully, falls to go.mod');
  });

  // Test 18: Malformed pyproject.toml
  await runTest('Test 18: Malformed pyproject.toml', async (dir) => {
    writeFileSync(join(dir, 'pyproject.toml'), 'not valid toml [[[');
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "test"\n');
    assertEqual(detectTestCommand(dir), 'cargo test', 'handles malformed pyproject.toml gracefully, falls to Cargo.toml');
  });

  // Test 19: Empty pyproject.toml
  await runTest('Test 19: Empty pyproject.toml', async (dir) => {
    writeFileSync(join(dir, 'pyproject.toml'), '');
    writeFileSync(join(dir, 'Makefile'), 'test:\n\techo "test"\n');
    assertEqual(detectTestCommand(dir), 'make test', 'handles empty pyproject.toml gracefully, falls to Makefile');
  });

  // Test 20: Malformed Makefile
  await runTest('Test 20: Malformed Makefile', async (dir) => {
    writeFileSync(join(dir, 'Makefile'), 'not a valid makefile target');
    assertEqual(detectTestCommand(dir), null, 'handles malformed Makefile gracefully, returns null');
  });

  // Test 21: Empty Makefile
  await runTest('Test 21: Empty Makefile', async (dir) => {
    writeFileSync(join(dir, 'Makefile'), '');
    assertEqual(detectTestCommand(dir), null, 'handles empty Makefile gracefully, returns null');
  });

  // Test 22: package.json with empty test script
  await runTest('Test 22: package.json with empty test script', async (dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: '' } }));
    assertEqual(detectTestCommand(dir), 'npm test', 'detects npm test even with empty test script string');
  });

  // Test 23: Multiple pyproject.toml sections
  await runTest('Test 23: pyproject.toml with [tool.pytest] among other sections', async (dir) => {
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.black]\nline-length = 88\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    assertEqual(detectTestCommand(dir), 'pytest', 'detects pytest when [tool.pytest] is present among other sections');
  });

  // resolveGatesCommands: the pure gates.commands decision (backlog #37).
  console.log('\nresolveGatesCommands:');

  const resolve = resolveGatesCommands;

  // Existing non-empty value with no answer (not asked) is kept.
  {
    const r = resolve({ existing: ['node scripts/test-all.mjs --skip-live'], detected: 'npm test', answer: null, interactive: true });
    assertEqual(JSON.stringify(r.commands), '["node scripts/test-all.mjs --skip-live"]', 'existing non-empty kept verbatim');
    assertEqual(r.warn, false, 'existing non-empty does not warn (it did not become non-empty)');
    assertEqual(r.hint, false, 'existing non-empty interactive: no hand-edit hint');
  }
  {
    const r = resolve({ existing: ['pytest -q'], detected: null, answer: null, interactive: false });
    assertEqual(JSON.stringify(r.commands), '["pytest -q"]', 'non-interactive keeps the existing value');
    assertEqual(r.hint, true, 'non-interactive prints the hand-edit hint even when a value exists');
    assertEqual(r.warn, false, 'non-interactive keep does not warn');
  }

  // Non-interactive: never asks, keeps [] and returns the hint.
  {
    const r = resolve({ existing: [], detected: 'npm test', answer: null, interactive: false });
    assertEqual(JSON.stringify(r.commands), '[]', 'non-interactive with empty existing keeps []');
    assertEqual(r.hint, true, 'non-interactive with empty existing returns the hint');
    assertEqual(r.warn, false, 'non-interactive never warns (nothing was written)');
  }
  {
    const r = resolve({ detected: 'npm test', answer: null, interactive: false });
    assertEqual(JSON.stringify(r.commands), '[]', 'missing gates.commands treated as [] when non-interactive');
    assertEqual(r.hint, true, 'missing gates.commands non-interactive returns the hint');
  }

  // Interactive + empty existing: the operator's answer decides.
  {
    const r = resolve({ existing: [], detected: 'npm test', answer: '', interactive: true });
    assertEqual(JSON.stringify(r.commands), '["npm test"]', 'Enter accepts the detected command');
    assertEqual(r.warn, true, 'accepting the detected command warns');
    assertEqual(r.hint, false, 'interactive answer: no hint');
  }
  {
    const r = resolve({ existing: [], detected: 'npm test', answer: 'npm run test:ci', interactive: true });
    assertEqual(r.commands.length, 1, 'typed edit stored as ONE command');
    assertEqual(r.commands[0], 'npm run test:ci', 'typed edit stored verbatim');
    assertEqual(r.warn, true, 'typed edit warns');
  }
  {
    const r = resolve({ existing: [], detected: 'npm test', answer: 'npx vitest run --coverage', interactive: true });
    assertEqual(r.commands.length, 1, 'multi-word command is never split into words');
    assertEqual(r.commands[0], 'npx vitest run --coverage', 'multi-word command stored as one full shell string');
  }
  {
    const r = resolve({ existing: [], detected: 'npm test', answer: '-', interactive: true });
    assertEqual(JSON.stringify(r.commands), '[]', '"-" keeps []');
    assertEqual(r.warn, false, '"-" does not warn (commands stayed empty)');
  }
  {
    const r = resolve({ existing: [], detected: 'npm test', answer: '- ', interactive: true });
    assertEqual(JSON.stringify(r.commands), '[]', 'padded "-" keeps [] (answer is trimmed)');
  }
  {
    const r = resolve({ existing: [], detected: null, answer: '', interactive: true });
    assertEqual(JSON.stringify(r.commands), '[]', 'empty answer with nothing detected keeps []');
    assertEqual(r.warn, false, 'nothing detected + empty answer does not warn');
  }
  {
    const r = resolve({ existing: [], detected: null, answer: 'pytest -q -k unit', interactive: true });
    assertEqual(JSON.stringify(r.commands), '["pytest -q -k unit"]', 'nothing detected: typed command stored as one string');
    assertEqual(r.warn, true, 'typed command with nothing detected warns');
  }
  {
    const r = resolve({ existing: [], detected: 'npm test', answer: '   ', interactive: true });
    assertEqual(JSON.stringify(r.commands), '["npm test"]', 'whitespace-only answer behaves like Enter');
  }
  {
    const r = resolve({ existing: [], detected: 'npm test', answer: null, interactive: true });
    assertEqual(JSON.stringify(r.commands), '[]', 'no confirmation: detected command is never written');
    assertEqual(r.warn, false, 'no confirmation writes nothing, so no warning');
    assertEqual(r.hint, false, 'interactive run without an answer does not hint');
  }

  // Defensive input shapes.
  {
    const r = resolve({ existing: 'npm test', detected: 'pytest', answer: null, interactive: false });
    assertEqual(JSON.stringify(r.commands), '[]', 'non-array gates.commands treated as unset');
    assertEqual(r.hint, true, 'non-array gates.commands still returns the hint');
  }
  {
    const r = resolve({ existing: [], detected: '', answer: '', interactive: true });
    assertEqual(JSON.stringify(r.commands), '[]', 'empty detected string behaves like nothing detected');
    assertEqual(r.warn, false, 'empty detected string + empty answer does not warn');
  }
  {
    const r = resolve({ existing: ['keep-me'], detected: 'npm test', answer: 'npm test', interactive: true });
    assertEqual(JSON.stringify(r.commands), '["npm test"]', 'saved value is replaced by a typed answer');
    assertEqual(r.warn, false, 'replacing a saved command does not warn');
    assertEqual(r.hint, false, 'interactive replace: no hand-edit hint');
  }
  {
    const r = resolve({ existing: ['keep-me'], detected: 'npm test', answer: '', interactive: true });
    assertEqual(JSON.stringify(r.commands), '["keep-me"]', 'Enter keeps the saved command');
  }
  {
    const r = resolve({ existing: ['keep-me'], detected: 'npm test', answer: '-', interactive: true });
    assertEqual(JSON.stringify(r.commands), '[]', '"-" clears the saved command');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});