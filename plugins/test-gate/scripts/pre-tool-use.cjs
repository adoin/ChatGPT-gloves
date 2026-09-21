'use strict';

const { classifyNonInteractiveTest } = require('./test-gate-core.cjs');
const { recordCompletionGate, recordPendingGate } = require('./test-gate-gates.cjs');

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
    if (/(?:^|__)open_test_gate$/.test(event?.tool_name || '')) {
      if (event?.tool_input?.createCompletionGate === true) {
        recordCompletionGate({
          sessionId: event.session_id,
          projectPath: event.tool_input.projectPath || event.cwd,
          turnId: event.turn_id,
        });
      }
      return;
    }
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
        permissionDecisionReason: `Test Gate blocked ${decision.kind} and created a completion gate for this task. Do not retry, disguise, delegate, or poll this non-interactive test. Browser interaction, Computer Use, screenshots, UI inspection, builds, linters, type checks, and development servers remain allowed. Open the Test Gate panel so the user can run the suite without model-token polling. New prompts will be held before model invocation until the test passes or the user explicitly skips it.`,
      },
    }));
  } catch {
    // Hooks must fail open. Invalid input or configuration must never block Codex.
  }
});
