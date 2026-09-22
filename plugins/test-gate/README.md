# Test Gate

Test Gate keeps non-interactive automated tests out of Codex turns. A `PreToolUse` hook blocks clearly identified test, E2E, acceptance, and benchmark commands before they start and creates a task-scoped completion gate. A local dashboard runs configured suites in detached worker processes, stores bounded local logs, refreshes status without model calls, and lets the user copy results when they are ready.

While that completion gate is pending, running, or failed, a synchronous `UserPromptSubmit` hook rejects ordinary follow-up prompts before model invocation. This prevents a user from accidentally moving from feature A to feature B while assuming A was fully validated. The gate resolves only after its required suites pass or the user explicitly skips it. The `open_test_gate` MCP call can also request gate creation when Codex proactively hands off validation without first attempting a shell test command.

Interactive verification is deliberately outside the gate. Codex can still use browser tools, Computer Use, screenshots, visual inspection, development servers, builds, linters, and type checkers.

## User experience

Ask Codex to open Test Gate, or let the `$test-gate` skill hand off automated validation after an implementation task. The MCP tool returns an MCP Apps UI resource for hosts that render embedded plugin UI and also opens a loopback-only browser panel as a portable fallback. From the panel you can:

- start a discovered or configured suite;
- follow status and a bounded log tail without model polling;
- cancel the exact worker process tree;
- copy a compact result or the visible log;
- see whether the current feature is pending, running, failed, passed, or explicitly skipped;
- explicitly skip the current completion gate after confirmation;
- close the Codex task while the detached worker continues.

Only asking Codex to analyze a completed result starts another model turn. Running and observing a suite in the panel does not.

## Prompt gate controls

If you forget that Test Gate is installed and send a new request while validation is unresolved, Codex displays the pending state and does not send that request to the model. Use one of these exact controls:

```text
运行待处理测试        # or /test-gate run
测试状态              # or /test-gate status
打开 Test Gate        # or /test-gate open
跳过待处理测试        # or /test-gate skip
```

Run, status, and skip are processed entirely by the local hook and the control prompt itself is blocked before model invocation. Opening the graphical panel permits one narrowly scoped model turn so Codex can call the `open_test_gate` MCP tool. After a pass or explicit skip, resend the next feature request.

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

## Local command resolution

The browser dashboard talks to the loopback MCP server, and the MCP server launches a detached local worker. Before enabling a Run button, the server resolves the suite executable from the project's `node_modules/.bin` directory and then from the local environment inherited by the plugin.

On Windows, package managers are commonly exposed as `npm.cmd`, `pnpm.cmd`, or `yarn.cmd`. Test Gate resolves those shims explicitly instead of asking `CreateProcess` to launch the extensionless Unix shim. Batch shims run through a fixed `cmd.exe` adapter with escaped argument-array values; project configuration still cannot provide an arbitrary shell command string. On macOS and Linux, resolved executables run directly.

If an executable cannot be resolved, the dashboard marks it as unavailable and disables that suite's Run button instead of creating a doomed background job.

## Platform support

Test Gate is designed for local Codex environments on Windows, macOS, Linux, and WSL2:

| Area | Windows | macOS | Linux / WSL2 |
|---|---|---|---|
| Command resolution | Project `.bin`, inherited `PATH`, `.exe/.com/.cmd/.bat` shims | Project `.bin`, inherited `PATH`, executable files | Project `.bin`, inherited `PATH`, executable files |
| Process cancellation | `taskkill /T /F` | POSIX process group, then `SIGKILL` fallback | POSIX process group, then `SIGKILL` fallback |
| Durable state | `%LOCALAPPDATA%\\OpenAI\\Codex\\test-gate` | `~/Library/Application Support/OpenAI/Codex/test-gate` | `${XDG_STATE_HOME:-~/.local/state}/openai-codex/test-gate` |
| Browser fallback | Edge app window or Explorer | `open` | `xdg-open`, `gio open`, or `sensible-browser`; WSL also tries `wslview` |

The MCP Apps UI remains the primary portable interface. Failure to launch a separate graphical browser is non-fatal, which keeps the embedded panel usable on headless Linux, remote shells, minimal containers, and WSL installations without a browser launcher.

## Command policy

The command hook listens only to the Codex `Bash`/unified-exec tool path. It blocks well-known non-interactive runners such as Jest, Vitest, Pytest, Playwright Test, Cypress Run, Cargo Test, Go Test, and package-manager test scripts. It explicitly permits browser-launch, Playwright screenshot/codegen/show-report, and Cypress open commands. The prompt hook is task-scoped by Codex session id, so a pending gate in one task does not block an unrelated task in the same project.

Hook coverage is a guardrail rather than an operating-system sandbox. A repository that needs stronger organizational enforcement should combine Test Gate with managed hooks or CI policy.

## Storage and security

Jobs are stored under the plugin data directory supplied by Codex, or the current user's local application-state directory as a fallback. The dashboard listens only on `127.0.0.1`, uses a random per-process URL token, rejects unexpected Host/Origin values, serves a restrictive content security policy, and exposes no arbitrary-command input.

Test output can contain secrets emitted by the project under test. Treat copied logs accordingly.

## Installation

Install `test-gate` from the `chatgpt-gloves` GitHub marketplace and start a new Codex task. Review and trust its bundled hook when prompted. Node.js 18 or newer must be available on `PATH`; there are no npm runtime dependencies.
