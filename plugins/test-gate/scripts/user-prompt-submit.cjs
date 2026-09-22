'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { projectState } = require('./test-gate-core.cjs');
const {
  evaluateGate,
  persistPassedGate,
  readSessionGate,
  skipSessionGate,
  unresolvedSuiteIds,
} = require('./test-gate-gates.cjs');

const OPEN_PATTERN = /^\s*(?:\/test-gate\s+open|打开\s*test\s*gate|打开测试门禁)\s*[。.!！]?\s*$/i;
const OPEN_BROWSER_PATTERN = /^\s*(?:\/test-gate\s+browser|浏览器打开\s*test\s*gate|在浏览器(?:中)?打开\s*test\s*gate|浏览器打开测试门禁|在浏览器(?:中)?打开测试门禁)\s*[。.!！]?\s*$/i;
const RUN_PATTERN = /^\s*(?:\/test-gate\s+run|开始(?:待处理)?测试|运行(?:待处理)?测试)\s*[。.!！]?\s*$/i;
const STATUS_PATTERN = /^\s*(?:\/test-gate\s+status|查看(?:待处理)?测试状态|测试状态)\s*[。.!！]?\s*$/i;
const SKIP_PATTERN = /^\s*(?:\/test-gate\s+skip|跳过(?:待处理)?测试|跳过测试门禁)\s*[。.!！]?\s*$/i;

function output(value) {
  process.stdout.write(JSON.stringify(value));
}

function blocked(reason) {
  output({ decision: 'block', reason });
}

function statusReason(gate, evaluation) {
  const kinds = gate.blockedKinds.join('、') || '非交互测试';
  if (evaluation.status === 'running') {
    return `Test Gate：A 的${kinds}仍在本地运行，当前提示未发送给模型，因此没有产生新的模型 token。等待完成后重新发送；也可输入“测试状态”查看，或输入“跳过待处理测试”明确跳过。`;
  }
  if (evaluation.status === 'failed') {
    return `Test Gate：A 的${kinds}未通过，不能开始新的 B 任务。输入“运行待处理测试”重新运行，输入“打开 Test Gate”查看日志，或输入“跳过待处理测试”明确跳过。当前提示未发送给模型。`;
  }
  return `Test Gate：A 的${kinds}尚未完成，已阻止进入新的任务领域，当前提示未发送给模型。输入“运行待处理测试”可直接在本地启动；输入“打开 Test Gate”打开面板；输入“跳过待处理测试”可明确跳过。`;
}

function startSuites(gate) {
  if (!projectState(gate.projectRoot).suites.length) {
    return { started: 0, errors: ['No test suites are configured or discoverable for this project.'] };
  }
  const suiteIds = unresolvedSuiteIds(gate);
  if (!suiteIds.length) return { started: 0, errors: [], message: '没有需要启动的套件；测试可能已在运行或已经通过。' };
  const serverPath = path.resolve(__dirname, '../mcp/server.cjs');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-gate-hook', version: '1' } } },
    ...suiteIds.map((suiteId, index) => ({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name: 'start_test_suite', arguments: { projectPath: gate.projectRoot, suiteId } } })),
  ];
  const result = spawnSync(process.execPath, [serverPath], {
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    env: process.env,
  });
  if (result.error) return { started: 0, errors: [result.error.message] };
  const responses = String(result.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const calls = responses.filter((response) => Number.isInteger(response.id) && response.id >= 2);
  const errors = calls.filter((response) => response.error || response.result?.isError).map((response) => response.error?.message || response.result.content?.[0]?.text || 'Unknown runner error');
  return { started: calls.length - errors.length, errors };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(0);
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    if (event?.hook_event_name !== 'UserPromptSubmit') return;
    const gate = readSessionGate(event.session_id);
    if (!gate) return;
    const evaluation = evaluateGate(gate);
    if (evaluation.status === 'passed') {
      if (gate.resolution?.status === 'passed') return;
      persistPassedGate(event.session_id, gate, evaluation);
      output({ systemMessage: `Test Gate：A 的测试已通过，现在开始处理新的请求。` });
      return;
    }
    if (evaluation.status === 'skipped') return;
    const prompt = typeof event.prompt === 'string' ? event.prompt : '';
    if (SKIP_PATTERN.test(prompt)) {
      skipSessionGate(event.session_id);
      blocked('Test Gate：已按你的明确选择跳过 A 的待处理测试。本控制命令未发送给模型；现在可以重新发送 B 的请求。');
      return;
    }
    if (STATUS_PATTERN.test(prompt)) {
      blocked(statusReason(gate, evaluation));
      return;
    }
    if (RUN_PATTERN.test(prompt)) {
      const started = startSuites(gate);
      if (started.errors.length) {
        blocked(`Test Gate：本地启动失败：${started.errors.join('; ')}。输入“打开 Test Gate”查看或配置套件，或输入“跳过待处理测试”。本控制命令未发送给模型。`);
      } else {
        blocked(started.started
          ? `Test Gate：已在本地启动 ${started.started} 个 A 的测试套件。本控制命令未发送给模型；稍后输入“测试状态”查看，测试通过后即可发送 B。`
          : 'Test Gate：所需测试已经在运行或已经通过，没有重复启动。本控制命令未发送给模型；输入“测试状态”查看。');
      }
      return;
    }
    if (OPEN_BROWSER_PATTERN.test(prompt)) {
      output({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: 'The user explicitly asked to open the pending Test Gate in a separate system-browser window. Call open_test_gate_browser for the current project. Do not perform code work or start a new task domain.',
        },
      });
      return;
    }
    if (OPEN_PATTERN.test(prompt)) {
      output({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: 'The user explicitly asked to reopen the pending Test Gate inside the conversation. Call open_test_gate for the current project and explain the panel controls. Do not call open_test_gate_browser, perform code work, or start a new task domain.',
        },
      });
      return;
    }
    blocked(statusReason(gate, evaluation));
  } catch {
    // Prompt guards must fail open when state cannot be read or evaluated.
  }
});
