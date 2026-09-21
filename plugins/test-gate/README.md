# Test Gate

Test Gate keeps non-interactive automated tests out of Codex turns. A `PreToolUse` hook blocks clearly identified test, E2E, acceptance, and benchmark commands before they start. A local dashboard runs configured suites in detached worker processes, stores bounded local logs, refreshes status without model calls, and lets the user copy results when they are ready.

Interactive verification is deliberately outside the gate. Codex can still use browser tools, Computer Use, screenshots, visual inspection, development servers, builds, linters, and type checkers.

## User experience

Ask Codex to open Test Gate, or let the `$test-gate` skill hand off automated validation after an implementation task. The MCP tool returns an MCP Apps UI resource for hosts that render embedded plugin UI and also opens a loopback-only browser panel as a portable fallback. From the panel you can:

- start a discovered or configured suite;
- follow status and a bounded log tail without model polling;
- cancel the exact worker process tree;
- copy a compact result or the visible log;
- close the Codex task while the detached worker continues.

Only asking Codex to analyze a completed result starts another model turn. Running and observing a suite in the panel does not.

## Suite discovery

Test Gate discovers these project-root suites automatically:

- `package.json` scripts beginning with `test`, `e2e`, `acceptance`, `integration`, `bench`, or `benchmark`;
- Cargo tests and benchmarks;
- Go tests;
- Pytest when a Python test configuration and `tests/` directory are present.

For other commands, add `.codex/test-gate.json`:

```json
{
  "version": 1,
  "suites": [
    {
      "id": "acceptance",
      "label": "Acceptance tests",
      "executable": "pnpm",
      "args": ["run", "acceptance"],
      "cwd": ".",
      "timeoutMinutes": 90
    }
  ],
  "policy": {
    "blockedPatterns": ["my-custom-test-runner\\s+run"],
    "allowedPatterns": ["npm\\s+run\\s+test-data-generator"]
  }
}
```

Suite commands use an executable plus argument array and run with `shell: false`. A configured working directory must remain inside the project. Invalid configuration fails open in the hook so a monitoring error cannot block unrelated Codex work; the dashboard reports configuration errors directly.

## Command policy

The hook listens only to the Codex `Bash`/unified-exec tool path. It blocks well-known non-interactive runners such as Jest, Vitest, Pytest, Playwright Test, Cypress Run, Cargo Test, Go Test, and package-manager test scripts. It explicitly permits browser-launch, Playwright screenshot/codegen/show-report, and Cypress open commands.

Hook coverage is a guardrail rather than an operating-system sandbox. A repository that needs stronger organizational enforcement should combine Test Gate with managed hooks or CI policy.

## Storage and security

Jobs are stored under the plugin data directory supplied by Codex, or the current user's local application-state directory as a fallback. The dashboard listens only on `127.0.0.1`, uses a random per-process URL token, rejects unexpected Host/Origin values, serves a restrictive content security policy, and exposes no arbitrary-command input.

Test output can contain secrets emitted by the project under test. Treat copied logs accordingly.

## Installation

Install `test-gate` from the `chatgpt-gloves` GitHub marketplace and start a new Codex task. Review and trust its bundled hook when prompted. Node.js 18 or newer must be available on `PATH`; there are no npm runtime dependencies.
