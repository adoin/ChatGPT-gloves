'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../plugins/test-gate');
const mcpConfigPath = path.join(pluginRoot, '.mcp.json');
const serverPath = path.join(pluginRoot, 'mcp', 'server.cjs');
const hookPath = path.join(pluginRoot, 'scripts', 'pre-tool-use.cjs');
const dashboardPath = path.join(pluginRoot, 'mcp', 'test-gate.html');
const dashboardUri = 'ui://test-gate/dashboard-v1.html';
const { prepareSpawn, resolveExecutable } = require(path.join(pluginRoot, 'scripts', 'spawn-command.cjs'));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gate-mcp-'));
  const project = path.join(root, 'project');
  const data = path.join(root, 'data');
  fs.mkdirSync(project);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
    scripts: {
      test: `"${process.execPath}" -e "process.stdout.write('TEST-GATE-PASS')"`,
      dev: 'vite',
    },
  }));
  fs.writeFileSync(path.join(project, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(project, '.codex'));
  fs.writeFileSync(path.join(project, '.codex', 'test-gate.json'), JSON.stringify({
    version: 1,
    suites: [{
      id: 'smoke',
      label: 'Smoke test',
      executable: process.execPath,
      args: ['-e', "process.stdout.write('TEST-GATE-PASS')"],
      cwd: '.',
      timeoutMinutes: 1,
    }],
  }));
  return { root, project, data };
}

function startServer(item) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TEST_GATE_DATA_DIR: item.data, TEST_GATE_SKIP_BROWSER_OPEN: '1' },
    windowsHide: true,
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return {
    child,
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
    async receive() {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP response. stderr: ${stderr}`)), 10_000);
      });
      try {
        const next = await Promise.race([iterator.next(), timeout]);
        assert.equal(next.done, false, `MCP server exited. stderr: ${stderr}`);
        return JSON.parse(next.value);
      } finally { clearTimeout(timer); }
    },
    stop() { child.stdin.end(); child.kill(); lines.close(); },
  };
}

function createPendingGate(item, sessionId = 'mcp-gate-session') {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: sessionId,
      turn_id: 'gate-turn',
      cwd: item.project,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'node --test' },
    }),
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    env: { ...process.env, TEST_GATE_DATA_DIR: item.data },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
}

async function initialize(client) {
  client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-gate-test', version: '1' } } });
  const response = await client.receive();
  assert.equal(response.result.serverInfo.name, 'test-gate');
  assert.match(response.result.instructions, /Never run or poll non-interactive/);
}

async function call(client, id, name, args = {}) {
  client.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const response = await client.receive();
  assert.equal(response.id, id);
  return response.result;
}

test('bundled MCP config launches Test Gate from the plugin root', () => {
  const config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')).mcpServers['test-gate'];
  assert.deepEqual(config, { command: 'node', args: ['mcp/server.cjs'], cwd: '.' });
  const result = spawnSync(config.command, config.args, {
    cwd: pluginRoot,
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'launch-test', version: '1' } } })}\n`,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).result.serverInfo.name, 'test-gate');
});

test('Windows command resolution prefers a runnable .cmd shim over an extensionless Unix shim', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gate-command-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(bin, 'pnpm.cmd'), '@echo off\r\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PATH: bin, ComSpec: 'C:\\Windows\\System32\\cmd.exe', SystemRoot: 'C:\\Windows' };
  const resolved = resolveExecutable('pnpm', { cwd: root, env, platform: 'win32' });
  assert.equal(resolved.toLowerCase(), path.join(bin, 'pnpm.cmd').toLowerCase());
  const invocation = prepareSpawn('pnpm', ['run', 'test:ssr'], { cwd: root, env, platform: 'win32' });
  assert.equal(invocation.via, 'cmd-shim');
  assert.equal(invocation.command, env.ComSpec);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.match(invocation.args.at(-1), /pnpm\.cmd/i);
  assert.match(invocation.args.at(-1), /test:ssr/i);
});

test('macOS and Linux command resolution prefers the project-local executable and stays shell-free', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gate-posix-command-'));
  const localBin = path.join(root, 'node_modules', '.bin');
  const pathBin = path.join(root, 'path-bin');
  fs.mkdirSync(localBin, { recursive: true });
  fs.mkdirSync(pathBin);
  const localTool = path.join(localBin, 'vitest');
  const pathTool = path.join(pathBin, 'vitest');
  fs.writeFileSync(localTool, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(pathTool, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(localTool, 0o755);
  fs.chmodSync(pathTool, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const platform of ['darwin', 'linux']) {
    const invocation = prepareSpawn('vitest', ['run'], { cwd: root, env: { PATH: pathBin }, platform });
    assert.equal(invocation.resolvedExecutable, fs.realpathSync(localTool));
    assert.equal(invocation.command, fs.realpathSync(localTool));
    assert.deepEqual(invocation.args, ['run']);
    assert.equal(invocation.via, 'direct');
    assert.equal(invocation.windowsVerbatimArguments, false);
  }
});

test('server exposes an embedded dashboard and app-only runner controls', async (t) => {
  const item = fixture();
  createPendingGate(item);
  const client = startServer(item);
  t.after(() => { client.stop(); fs.rmSync(item.root, { recursive: true, force: true }); });
  await initialize(client);
  client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await client.receive();
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    'open_test_gate',
    'get_test_gate_state',
    'start_test_suite',
    'cancel_test_job',
    'read_test_job_log',
    'skip_test_gate',
    'get_test_job_summary',
  ]);
  assert.equal(listed.result.tools[0]._meta.ui.resourceUri, dashboardUri);
  for (const tool of listed.result.tools.slice(1, 6)) assert.deepEqual(tool._meta.ui.visibility, ['app']);
  assert.equal(listed.result.tools.some((tool) => /command|shell|executable/i.test(tool.name)), false);

  const openTool = listed.result.tools[0];
  assert.deepEqual(openTool.inputSchema.required, ['projectPath', 'createCompletionGate']);
  const opened = await call(client, 3, 'open_test_gate', { projectPath: item.project, createCompletionGate: false });
  assert.equal(opened.structuredContent.suiteCount, 2);
  assert.equal(opened.structuredContent.browserOpened, false);
  assert.equal(opened.structuredContent.browserOpenError, null);
  assert.match(opened.structuredContent.runtimePlatform, /^(Windows|macOS|Linux|WSL|[a-z0-9_-]+)$/i);
  const response = await fetch(opened._meta.dashboardUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await response.text();
  assert.equal(html, fs.readFileSync(dashboardPath, 'utf8'));
  assert.match(html, /id="gate-banner"/);
  assert.doesNotMatch(html, /LOCAL TEST RUNNER|zero-token|Test Gate 范围|Codex 不直接执行|交互验证继续放行/);

  const state = await call(client, 4, 'get_test_gate_state', { projectPath: item.project });
  assert.equal(state.structuredContent.gates[0].status, 'pending');
  assert.equal(state.structuredContent.suites.every((suite) => suite.executableAvailable), true);
  assert.equal(state.structuredContent.suites.every((suite) => typeof suite.resolvedExecutable === 'string'), true);
  const refused = await call(client, 5, 'skip_test_gate', { projectPath: item.project, gateId: state.structuredContent.gates[0].gateId, confirmSkip: false });
  assert.equal(refused.isError, true);
  const skipped = await call(client, 6, 'skip_test_gate', { projectPath: item.project, gateId: state.structuredContent.gates[0].gateId, confirmSkip: true });
  assert.equal(skipped.structuredContent.gate.status, 'skipped');
});

test('a configured suite runs in a detached worker and produces a copyable result', async (t) => {
  const item = fixture();
  const client = startServer(item);
  t.after(() => { client.stop(); fs.rmSync(item.root, { recursive: true, force: true }); });
  await initialize(client);

  const initial = await call(client, 2, 'get_test_gate_state', { projectPath: item.project });
  assert.deepEqual(initial.structuredContent.suites.map((suite) => suite.label), ['Smoke test', 'test']);
  const started = await call(client, 3, 'start_test_suite', { projectPath: item.project, suiteId: 'smoke' });
  const jobId = started.structuredContent.job.jobId;

  let job;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const state = await call(client, 10 + attempt, 'get_test_gate_state', { projectPath: item.project });
    job = state.structuredContent.jobs.find((candidate) => candidate.jobId === jobId);
    if (job && !['queued', 'running'].includes(job.status)) break;
  }
  assert.equal(job?.status, 'passed');
  assert.equal(job.exitCode, 0);

  const log = await call(client, 100, 'read_test_job_log', { projectPath: item.project, jobId });
  assert.equal(log.structuredContent.stdout, 'TEST-GATE-PASS');
  const summary = await call(client, 101, 'get_test_job_summary', { projectPath: item.project, jobId });
  assert.match(summary.content[0].text, /Smoke test: passed/);
  assert.match(summary.content[0].text, /TEST-GATE-PASS/);
});
