---
name: test-gate
description: Keep non-interactive automated tests, benchmarks, E2E suites, and acceptance suites out of Codex turns, require them to pass or be explicitly skipped before a new task begins, and hand execution to the local Test Gate panel. Use after code changes need automated validation. Do not use this restriction for interactive browser or UI inspection, Computer Use, screenshots, development servers, builds, linting, or type checking.
---

# Test Gate

Defer non-interactive automated tests to the local Test Gate runner so Codex never waits for or polls them.

When the shell hook blocks a test, Test Gate creates a completion gate for the current Codex task. Until the required suite passes or the user explicitly skips it, `UserPromptSubmit` rejects ordinary follow-up prompts before they reach the model. Do not attempt to work around that gate.

## Boundary

- When automated validation is relevant, issue the intended non-interactive test command exactly once through the normal shell tool. The PreToolUse hook blocks it before execution and creates the gate. This single intercepted attempt is the only supported gate-creation path.
- Do not retry, disguise, delegate, or split a command after the Test Gate hook blocks it.
- Do not poll a Test Gate job from the model.
- Do not begin a separate feature or task domain while the current completion gate is pending, running, or failed.
- Continue interactive verification normally. Browser tools, Computer Use, clicking through a page, inspecting rendered UI, screenshots, visual comparisons, and accessibility inspection are explicitly allowed.
- Builds, development servers, linters, formatters, and type checks are outside Test Gate unless a project explicitly classifies one as a test in `.codex/test-gate.json`.

## Workflow

After implementation, perform useful interactive UI verification directly. Do not create a completion gate merely because code changed, implementation finished, a Skill was loaded, or validation might be useful. If a concrete non-interactive test command is appropriate, attempt that exact command once; the hook will block it before execution and record only the suites represented by that command.

After the hook blocks a command, do not automatically call `open_test_gate`. Tell the user about the pending gate and the local control phrases below. Call `open_test_gate` only after the user explicitly asks to open the panel. Calling `open_test_gate` never creates a gate.

If the user sends a new request while a gate is unresolved, the prompt hook handles it before model invocation. The user-facing local control phrases are:

- `运行待处理测试` or `/test-gate run`: start the required suites locally without a model call;
- `测试状态` or `/test-gate status`: read the gate state without a model call;
- `跳过待处理测试` or `/test-gate skip`: explicitly resolve the gate as skipped without a model call;
- `打开 Test Gate` or `/test-gate open`: allow a narrowly scoped model turn that only opens the panel.

Do not reinterpret a skip: only the explicit control phrase or the dashboard's confirmed skip action resolves a gate without passing tests.

When the user later asks Codex to analyze a completed Test Gate job, call `get_test_job_summary` once for the exact job id. Never call it repeatedly to wait for completion.

If Test Gate has no discovered suites, explain that it discovers common package scripts and project types, and that the project can define explicit suites in `.codex/test-gate.json`. Do not fall back to running the tests yourself.

If the dashboard reports an unavailable executor, explain that Test Gate resolves project-local `node_modules/.bin` entries and inherited local PATH entries, including Windows `.cmd` shims. Ask the user to install or expose the missing runner locally; do not bypass the gate by running the suite through a different shell tool.

On macOS and Linux/WSL, executors run directly and cancellation targets the detached POSIX process group. A missing graphical browser launcher is not a runner failure: use the embedded MCP panel when available, or tell the user which local launcher dependency (`open`, `xdg-open`, `gio`, `sensible-browser`, or `wslview`) is missing.
