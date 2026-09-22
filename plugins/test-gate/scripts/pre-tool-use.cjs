'use strict';

const { classifyNonInteractiveTest } = require('./test-gate-core.cjs');
const { recordPendingGate } = require('./test-gate-gates.cjs');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(0);
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    if (event?.hook_event_name !== 'PreToolUse') return;
    if (event?.tool_name !== 'Bash') return;
    const command = event?.tool_input?.command ?? event?.tool_input?.cmd;
    const decision = classifyNonInteractiveTest(command, event.cwd);
    if (!decision.blocked) return;
    recordPendingGate({
      sessionId: event.session_id,
      cwd: event.cwd,
      turnId: event.turn_id,
      command,
      kind: decision.kind,
    });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Test Gate blocked ${decision.kind} and created a completion gate for this task. Do not retry, disguise, delegate, or poll. Call open_test_gate exactly once now so the conversation contains the expandable Test Gate component; that tool only attaches the embedded component and must not open a system browser. Never call open_test_gate_browser automatically. Browser interaction, Computer Use, screenshots, UI inspection, builds, linters, type checks, and development servers remain allowed. Tell the user that “运行待处理测试” starts it locally, “测试状态” checks it, “打开 Test Gate” reopens the embedded panel, “浏览器打开 Test Gate” explicitly opens a separate window, and “跳过待处理测试” explicitly skips it. New ordinary prompts are held before model invocation until the test passes or the user explicitly skips it.`,
      },
    }));
  } catch {
    // Hooks must fail open. Invalid input or configuration must never block Codex.
  }
});
