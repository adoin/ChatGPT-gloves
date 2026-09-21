'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../plugins/test-gate');
const hookPath = path.join(pluginRoot, 'scripts', 'pre-tool-use.cjs');
const { classifyNonInteractiveTest, projectState } = require(path.join(pluginRoot, 'scripts', 'test-gate-core.cjs'));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gate-hook-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node --test',
      'test:unit': 'vitest run',
      e2e: 'playwright test',
      benchmark: 'node bench.cjs',
      dev: 'vite',
      build: 'vite build',
      lint: 'eslint .',
    },
  }));
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  return root;
}

function runHook(root, command) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: 'test-session',
      turn_id: 'test-turn',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
}

test('classifies common non-interactive test commands and leaves interactive verification alone', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const command of [
    'pnpm test',
    'npm run test:unit',
    'npx vitest run',
    'python -m pytest -q',
    'cargo test --workspace',
    'go test ./...',
    'npx playwright test',
    'npx cypress run',
    'node --test tests/*.test.cjs',
  ]) {
    assert.equal(classifyNonInteractiveTest(command, root).blocked, true, command);
  }

  for (const command of [
    'pnpm run dev',
    'pnpm run build',
    'pnpm run lint',
    'pnpm run typecheck',
    'npx playwright screenshot https://example.com shot.png',
    'npx playwright codegen http://localhost:3000',
    'npx playwright show-report',
    'npx cypress open',
    'start http://localhost:3000',
  ]) {
    assert.equal(classifyNonInteractiveTest(command, root).blocked, false, command);
  }
});

test('discovers package suites without treating normal scripts as tests', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = projectState(root);
  assert.deepEqual(state.suites.map((suite) => suite.label), ['benchmark', 'e2e', 'test', 'test:unit']);
  assert.equal(state.suites.every((suite) => suite.executable === 'pnpm'), true);
  assert.equal(state.suites.some((suite) => suite.label === 'dev' || suite.label === 'build'), false);
});

test('project policy can explicitly allow or block commands', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex', 'test-gate.json'), JSON.stringify({
    version: 1,
    suites: [],
    policy: {
      allowedPatterns: ['npm\\s+run\\s+test-data-generator'],
      blockedPatterns: ['custom-check\\s+--acceptance'],
    },
  }));
  assert.equal(classifyNonInteractiveTest('npm run test-data-generator', root).blocked, false);
  assert.equal(classifyNonInteractiveTest('custom-check --acceptance', root).blocked, true);
});

test('PreToolUse hook denies tests with scoped guidance and fails open otherwise', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const denied = runHook(root, 'pnpm test');
  assert.equal(denied.status, 0, denied.stderr);
  const output = JSON.parse(denied.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /Browser interaction.*screenshots.*remain allowed/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /Do not retry.*poll/);

  const allowed = runHook(root, 'pnpm run dev');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, '');

  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex', 'test-gate.json'), '{ invalid json');
  const failOpen = runHook(root, 'pnpm test');
  assert.equal(failOpen.status, 0, failOpen.stderr);
  assert.equal(failOpen.stdout, '');
});
