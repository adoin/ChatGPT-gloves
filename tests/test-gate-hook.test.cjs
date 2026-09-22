'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../plugins/test-gate');
const hookPath = path.join(pluginRoot, 'scripts', 'pre-tool-use.cjs');
const promptHookPath = path.join(pluginRoot, 'scripts', 'user-prompt-submit.cjs');
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

function runHook(root, data, command, sessionId = 'test-session') {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: sessionId,
      turn_id: 'test-turn',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    env: { ...process.env, TEST_GATE_DATA_DIR: data },
  });
}

function runPromptHook(root, data, prompt, sessionId = 'test-session') {
  return spawnSync(process.execPath, [promptHookPath], {
    input: JSON.stringify({
      session_id: sessionId,
      turn_id: 'next-turn',
      cwd: root,
      hook_event_name: 'UserPromptSubmit',
      prompt,
    }),
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    env: { ...process.env, TEST_GATE_DATA_DIR: data },
  });
}

function runOpenPanelHook(root, data, sessionId) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: sessionId,
      turn_id: 'panel-turn',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__test-gate__open_test_gate',
      tool_input: { projectPath: root, createCompletionGate: true },
    }),
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    env: { ...process.env, TEST_GATE_DATA_DIR: data },
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
  const data = path.join(root, 'gate-data');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const denied = runHook(root, data, 'pnpm test');
  assert.equal(denied.status, 0, denied.stderr);
  const output = JSON.parse(denied.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /Browser interaction.*screenshots.*remain allowed/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /Do not retry.*poll/);

  const allowed = runHook(root, data, 'pnpm run dev');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, '');

  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex', 'test-gate.json'), '{ invalid json');
  const failOpen = runHook(root, data, 'pnpm test');
  assert.equal(failOpen.status, 0, failOpen.stderr);
  assert.equal(failOpen.stdout, '');
});

test('pending completion gate blocks a new task before model invocation and supports local status and skip controls', (t) => {
  const root = fixture();
  const data = path.join(root, 'gate-data');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const denied = runHook(root, data, 'pnpm test', 'gate-session');
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const gateFile = fs.readdirSync(path.join(data, 'gates')).map((name) => path.join(data, 'gates', name))[0];
  assert.doesNotMatch(fs.readFileSync(gateFile, 'utf8'), /blockedCommands|pnpm test/);

  const nextFeature = runPromptHook(root, data, '现在开发完全无关的 B 功能', 'gate-session');
  assert.equal(nextFeature.status, 0, nextFeature.stderr);
  const blocked = JSON.parse(nextFeature.stdout);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /未发送给模型/);
  assert.match(blocked.reason, /运行待处理测试/);

  const status = JSON.parse(runPromptHook(root, data, '测试状态', 'gate-session').stdout);
  assert.equal(status.decision, 'block');
  assert.match(status.reason, /尚未完成/);

  const open = JSON.parse(runPromptHook(root, data, '打开 Test Gate', 'gate-session').stdout);
  assert.equal(open.decision, undefined);
  assert.match(open.hookSpecificOutput.additionalContext, /Call open_test_gate/);

  const skipped = JSON.parse(runPromptHook(root, data, '跳过待处理测试', 'gate-session').stdout);
  assert.equal(skipped.decision, 'block');
  assert.match(skipped.reason, /明确选择跳过/);

  const allowed = runPromptHook(root, data, '现在开发 B 功能', 'gate-session');
  assert.equal(allowed.stdout, '');
});

test('opening the panel cannot create a completion gate without an intercepted shell test', (t) => {
  const root = fixture();
  const data = path.join(root, 'gate-data');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const panelCall = runOpenPanelHook(root, data, 'inspection-session');
  assert.equal(panelCall.status, 0, panelCall.stderr);
  assert.equal(panelCall.stdout, '');
  assert.equal(runPromptHook(root, data, '开始 B', 'inspection-session').stdout, '');
  assert.deepEqual(fs.readdirSync(path.join(data, 'gates')), []);
});

test('run control starts the required suite locally and automatically releases the next prompt after it passes', async (t) => {
  const root = fixture();
  const data = path.join(root, 'gate-data');
  const sessionId = 'run-gate-session';
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.codex'));
  const marker = 'TEST_GATE_CONTROL_PASS';
  fs.writeFileSync(path.join(root, '.codex', 'test-gate.json'), JSON.stringify({
    version: 1,
    suites: [{
      id: 'control-smoke',
      label: 'Control smoke',
      executable: process.execPath,
      args: ['-e', `process.stdout.write('${marker}')`],
      cwd: '.',
      timeoutMinutes: 1,
    }],
    policy: { blockedPatterns: [marker] },
  }));
  const command = `${process.execPath} -e process.stdout.write('${marker}')`;
  const denied = runHook(root, data, command, sessionId);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const run = JSON.parse(runPromptHook(root, data, '运行待处理测试', sessionId).stdout);
  assert.equal(run.decision, 'block');
  assert.match(run.reason, /已在本地启动 1 个/);

  let released;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const probe = runPromptHook(root, data, '开始 B', sessionId);
    const parsed = probe.stdout ? JSON.parse(probe.stdout) : null;
    if (parsed?.systemMessage) {
      released = parsed;
      break;
    }
  }
  assert.match(released?.systemMessage || '', /测试已通过/);
  const later = runPromptHook(root, data, '继续 B', sessionId);
  assert.equal(later.stdout, '');
});
